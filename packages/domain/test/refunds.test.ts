import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { orders, payments, refundAllocations, refunds, sellerLedgerEntries, sellerOrders, sellerProfiles } from '@workspace/db/schema';
import {
  InvalidRefundError,
  RefundCapacityExceededError,
  RefundPaymentError,
  RefundStateError,
  approveRefund,
  completeRefund,
  confirmPayment,
  failRefund,
  placeOrder,
  reconcileRefunds,
  requestRefund,
  reserveRefund,
  startRefundProcessing,
  verifyDelivery,
} from '../src';
import { createPgTestDb, markShipped, seed, shipping, type PgTest } from './pg';

let pg: PgTest;
beforeAll(async () => { pg = await createPgTestDb(); });
afterAll(async () => { await pg.close(); });

/** Paid order. Seller A: 3 x 100000 = 300000 (commission 30000), delivery 20000. Seller B: 1 x 100000, delivery 20000. */
async function paidOrder() {
  const s = await seed(pg.db, { stock: 50, sellers: 2 });
  const placed = await placeOrder(pg.db, {
    buyerId: s.buyerId, paymentMethod: 'bank_transfer', shipping,
    items: [{ variantId: s.sellers[0].variantId, quantity: 3 }, { variantId: s.sellers[1].variantId, quantity: 1 }],
    calculateDeliveryFeeCents: () => 20000,
  });
  await confirmPayment(pg.db, { paymentId: placed.paymentId });
  const sos = await pg.db.select().from(sellerOrders).where(eq(sellerOrders.orderId, placed.orderId));
  const A = sos.find((x) => x.sellerId === s.sellers[0].sellerId)!;
  const B = sos.find((x) => x.sellerId === s.sellers[1].sellerId)!;
  // Delivered: refund ledger debits are posted immediately only once the sale entry exists
  // (before delivery they are caught up by verifyDelivery; see ledger.test.ts).
  await markShipped(pg.db, A.id, s.sellers[0].locationId);
  await markShipped(pg.db, B.id, s.sellers[1].locationId);
  await verifyDelivery(pg.db, A.id);
  await verifyDelivery(pg.db, B.id);
  return { orderId: placed.orderId, A, B, total: placed.totalCents };
}

/** Tiny order for rounding tests: 3 items of 1 cent, commission 3333 bps -> subtotal 3, commission 1. */
async function tinyOrder() {
  const s = await seed(pg.db, { stock: 50, sellers: 1 });
  await pg.db.update(sellerProfiles).set({ commissionBps: 3333 }).where(eq(sellerProfiles.id, s.sellers[0].sellerId));
  const { productVariants } = await import('@workspace/db/schema');
  await pg.db.update(productVariants).set({ priceCents: 1 }).where(eq(productVariants.id, s.sellers[0].variantId));
  const placed = await placeOrder(pg.db, {
    buyerId: s.buyerId, paymentMethod: 'bank_transfer', shipping,
    items: [{ variantId: s.sellers[0].variantId, quantity: 3 }],
  });
  await confirmPayment(pg.db, { paymentId: placed.paymentId });
  const [so] = await pg.db.select().from(sellerOrders).where(eq(sellerOrders.orderId, placed.orderId));
  expect(so.subtotalCents).toBe(3);
  expect(so.commissionCents).toBe(1);
  await markShipped(pg.db, so.id, s.sellers[0].locationId);
  await verifyDelivery(pg.db, so.id);
  return { orderId: placed.orderId, so };
}

const send = async (id: string) => {
  const r = await startRefundProcessing(pg.db, id);
  expect(r.started).toBe(true);
};
const line = (sellerOrderId: string, item: number, delivery = 0) => ({ sellerOrderId, itemAmountCents: item, deliveryAmountCents: delivery });
const ledgerFor = async (sellerOrderId: string) =>
  (await pg.db.select().from(sellerLedgerEntries).where(eq(sellerLedgerEntries.sellerOrderId, sellerOrderId))).filter((l) => l.type === 'refund');
const soRow = async (id: string) => (await pg.db.select().from(sellerOrders).where(eq(sellerOrders.id, id)))[0];
const ordRow = async (id: string) => (await pg.db.select().from(orders).where(eq(orders.id, id)))[0];
const status = async (id: string) => (await pg.db.select().from(refunds).where(eq(refunds.id, id)))[0].status;

describe('refund happy paths', () => {
  test('partial item refund: commission share returned, ledger debit, caches', async () => {
    const o = await paidOrder();
    const { refundId } = await reserveRefund(pg.db, { orderId: o.orderId, lines: [line(o.A.id, 100000)] });
    await send(refundId);
    expect((await completeRefund(pg.db, refundId, { providerReference: 'BANK-1' })).alreadyCompleted).toBe(false);

    const [alloc] = await pg.db.select().from(refundAllocations).where(eq(refundAllocations.refundId, refundId));
    expect(alloc.commissionReturnedCents).toBe(10000);
    const ledger = await ledgerFor(o.A.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].amountCents).toBe(-90000);
    expect((await soRow(o.A.id)).refundedCents).toBe(100000);
    expect((await ordRow(o.orderId)).refundedCents).toBe(100000);
    expect(await reconcileRefunds(pg.db)).toEqual([]);
  });

  test('delivery-only refund posts no ledger entry', async () => {
    const o = await paidOrder();
    const { refundId } = await reserveRefund(pg.db, { orderId: o.orderId, lines: [line(o.A.id, 0, 20000)] });
    await send(refundId);
    await completeRefund(pg.db, refundId);
    expect(await ledgerFor(o.A.id)).toHaveLength(0);
    expect((await soRow(o.A.id)).refundedCents).toBe(20000);
    expect(await reconcileRefunds(pg.db)).toEqual([]);
  });

  test('whole-order refund: one header, two allocations, full commission returned', async () => {
    const o = await paidOrder();
    const { refundId } = await reserveRefund(pg.db, {
      orderId: o.orderId,
      lines: [line(o.A.id, 300000, 20000), line(o.B.id, 100000, 20000)],
    });
    expect((await pg.db.select().from(refunds).where(eq(refunds.id, refundId)))[0].amountCents).toBe(o.total);
    await send(refundId);
    await completeRefund(pg.db, refundId);
    const allocs = await pg.db.select().from(refundAllocations).where(eq(refundAllocations.refundId, refundId));
    expect(allocs).toHaveLength(2);
    expect(allocs.find((a) => a.sellerOrderId === o.A.id)!.commissionReturnedCents).toBe(30000);
    expect(allocs.find((a) => a.sellerOrderId === o.B.id)!.commissionReturnedCents).toBe(10000);
    expect((await ordRow(o.orderId)).refundedCents).toBe(o.total);
    expect(await reconcileRefunds(pg.db)).toEqual([]);
  });

  test('requested refunds hold no capacity until approved', async () => {
    const o = await paidOrder();
    const a = await requestRefund(pg.db, { orderId: o.orderId, lines: [line(o.A.id, 300000)] });
    const b = await requestRefund(pg.db, { orderId: o.orderId, lines: [line(o.A.id, 300000)] });
    await approveRefund(pg.db, a.refundId);
    await expect(approveRefund(pg.db, b.refundId)).rejects.toBeInstanceOf(RefundCapacityExceededError);
    expect(await status(b.refundId)).toBe('requested');
  });
});

describe('refund validation', () => {
  test('cannot exceed item or delivery caps', async () => {
    const o = await paidOrder();
    await expect(reserveRefund(pg.db, { orderId: o.orderId, lines: [line(o.A.id, 300001)] })).rejects.toBeInstanceOf(RefundCapacityExceededError);
    await expect(reserveRefund(pg.db, { orderId: o.orderId, lines: [line(o.A.id, 0, 20001)] })).rejects.toBeInstanceOf(RefundCapacityExceededError);
  });

  test('rejects a payment whose amount no longer matches the order', async () => {
    const o = await paidOrder();
    await pg.db.update(payments).set({ amountCents: 5 }).where(eq(payments.orderId, o.orderId));
    await expect(reserveRefund(pg.db, { orderId: o.orderId, lines: [line(o.A.id, 1000)] })).rejects.toBeInstanceOf(RefundPaymentError);
  });

  test('state guards: cannot complete before processing, cannot fail an approved refund', async () => {
    const o = await paidOrder();
    const { refundId } = await reserveRefund(pg.db, { orderId: o.orderId, lines: [line(o.A.id, 1000)] });
    await expect(completeRefund(pg.db, refundId)).rejects.toBeInstanceOf(RefundStateError);
    await expect(failRefund(pg.db, refundId)).rejects.toBeInstanceOf(RefundStateError);
  });
});

describe('refund amount bounds', () => {
  test('rejects line and header totals that are not safe integers, before inserting anything', async () => {
    const o = await paidOrder();
    const MAX = Number.MAX_SAFE_INTEGER;
    await expect(requestRefund(pg.db, { orderId: o.orderId, lines: [line(o.A.id, MAX, 1)] })).rejects.toBeInstanceOf(InvalidRefundError);
    const half = 2 ** 52;
    await expect(
      requestRefund(pg.db, { orderId: o.orderId, lines: [line(o.A.id, half), line(o.B.id, half, half)] }),
    ).rejects.toThrow('too large');
    expect((await pg.db.select().from(refunds).where(eq(refunds.orderId, o.orderId)))).toHaveLength(0);
  });

  test('approveRefund refuses a tampered refund whose allocations sum past the safe-integer range', async () => {
    const o = await paidOrder();
    const [pay] = await pg.db.select().from(payments).where(eq(payments.orderId, o.orderId));
    const [r] = await pg.db.insert(refunds).values({ orderId: o.orderId, paymentId: pay.id, amountCents: 1 }).returning({ id: refunds.id });
    const big = Number.MAX_SAFE_INTEGER - 10;
    await pg.db.insert(refundAllocations).values([o.A.id, o.B.id].map((so) => ({
      refundId: r.id, orderId: o.orderId, sellerOrderId: so, itemAmountCents: big, deliveryAmountCents: 0, amountCents: big,
    })));
    try {
      await expect(approveRefund(pg.db, r.id)).rejects.toThrow('too large');
      expect(await status(r.id)).toBe('requested');
    } finally {
      // remove the deliberately inconsistent rows so reconcileRefunds in later tests stays clean
      await pg.db.delete(refundAllocations).where(eq(refundAllocations.refundId, r.id));
      await pg.db.delete(refunds).where(eq(refunds.id, r.id));
    }
  });
});

describe('refund capacity under concurrency (real Postgres)', () => {
  test('20 racing 100000 refunds on a 300000 seller order: exactly 3 reserve', async () => {
    const o = await paidOrder();
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => reserveRefund(pg.db, { orderId: o.orderId, lines: [line(o.A.id, 100000)] })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    const lost = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(lost.every((r) => r.reason instanceof RefundCapacityExceededError)).toBe(true);
    expect(await reconcileRefunds(pg.db)).toEqual([]);
  });

  test('processing refunds keep their capacity; a failed one releases it', async () => {
    const o = await paidOrder();
    const first = await reserveRefund(pg.db, { orderId: o.orderId, lines: [line(o.A.id, 300000)] });
    await send(first.refundId);
    await expect(reserveRefund(pg.db, { orderId: o.orderId, lines: [line(o.A.id, 1)] })).rejects.toBeInstanceOf(RefundCapacityExceededError);
    await failRefund(pg.db, first.refundId);
    await reserveRefund(pg.db, { orderId: o.orderId, lines: [line(o.A.id, 300000)] });
  });

  test('two whole-order refunds racing: only one fits', async () => {
    const o = await paidOrder();
    const lines = [line(o.A.id, 300000, 20000), line(o.B.id, 100000, 20000)];
    const results = await Promise.allSettled([
      reserveRefund(pg.db, { orderId: o.orderId, lines }),
      reserveRefund(pg.db, { orderId: o.orderId, lines }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await reconcileRefunds(pg.db)).toEqual([]);
  });

  test('starting processing is exclusive: 10 parallel starts, one sender', async () => {
    const o = await paidOrder();
    const { refundId } = await reserveRefund(pg.db, { orderId: o.orderId, lines: [line(o.A.id, 1000)] });
    const results = await Promise.all(Array.from({ length: 10 }, () => startRefundProcessing(pg.db, refundId)));
    expect(results.filter((r) => r.started)).toHaveLength(1);
  });
});

describe('completion under concurrency', () => {
  test('10 duplicate success callbacks apply the refund once', async () => {
    const o = await paidOrder();
    const { refundId } = await reserveRefund(pg.db, { orderId: o.orderId, lines: [line(o.A.id, 100000, 5000)] });
    await send(refundId);
    const results = await Promise.all(Array.from({ length: 10 }, () => completeRefund(pg.db, refundId)));
    expect(results.filter((r) => !r.alreadyCompleted)).toHaveLength(1);
    expect(await ledgerFor(o.A.id)).toHaveLength(1);
    expect((await soRow(o.A.id)).refundedCents).toBe(105000);
    expect((await ordRow(o.orderId)).refundedCents).toBe(105000);
    expect(await reconcileRefunds(pg.db)).toEqual([]);
  });

  test('success racing failure: exactly one wins and the books stay consistent', async () => {
    let succeeded = 0, failed = 0;
    for (let i = 0; i < 40; i++) {
      const o = await paidOrder();
      const { refundId } = await reserveRefund(pg.db, { orderId: o.orderId, lines: [line(o.A.id, 100000)] });
      await send(refundId);
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      // jitter so each side sometimes arrives first (complete needs several lock steps, fail is one UPDATE)
      const [c, f] = await Promise.allSettled([
        completeRefund(pg.db, refundId),
        wait(Math.random() * 12).then(() => failRefund(pg.db, refundId)),
      ]);
      const st = await status(refundId);
      if (st === 'succeeded') {
        succeeded++;
        expect(c.status).toBe('fulfilled');
        expect(f.status).toBe('rejected');
        expect((f as PromiseRejectedResult).reason).toBeInstanceOf(RefundStateError);
        expect(await ledgerFor(o.A.id)).toHaveLength(1);
        expect((await ordRow(o.orderId)).refundedCents).toBe(100000);
      } else {
        failed++;
        expect(st).toBe('failed');
        expect(c.status).toBe('rejected');
        expect((c as PromiseRejectedResult).reason).toBeInstanceOf(RefundStateError);
        expect(await ledgerFor(o.A.id)).toHaveLength(0);
        expect((await ordRow(o.orderId)).refundedCents).toBe(0);
      }
      expect(await reconcileRefunds(pg.db)).toEqual([]);
    }
    console.log(`success-vs-failure race: succeeded=${succeeded} failed=${failed}`);
    expect(succeeded).toBeGreaterThan(0);
    expect(failed).toBeGreaterThan(0);
  });
});

describe('commission rounding across refunds', () => {
  test('three 1-cent item refunds on subtotal 3 / commission 1 return 0, 1, 0', async () => {
    const { orderId, so } = await tinyOrder();
    const returned: number[] = [];
    for (let i = 0; i < 3; i++) {
      const { refundId } = await reserveRefund(pg.db, { orderId, lines: [line(so.id, 1)] });
      await send(refundId);
      await completeRefund(pg.db, refundId);
      returned.push((await pg.db.select().from(refundAllocations).where(eq(refundAllocations.refundId, refundId)))[0].commissionReturnedCents);
    }
    expect(returned).toEqual([0, 1, 0]);
    expect((await ledgerFor(so.id)).map((l) => l.amountCents)).toEqual([-1, -1]); // the middle one nets to 0 and is skipped
    expect(await reconcileRefunds(pg.db)).toEqual([]);
  });

  test('a failed refund between two successes leaves no rounding drift', async () => {
    const { orderId, so } = await tinyOrder();
    const run = async (ok: boolean) => {
      const { refundId } = await reserveRefund(pg.db, { orderId, lines: [line(so.id, 1)] });
      await send(refundId);
      if (ok) await completeRefund(pg.db, refundId); else await failRefund(pg.db, refundId);
      return refundId;
    };
    const r1 = await run(true);
    await run(false);
    const r3 = await run(true);
    const r4 = await run(true);
    const rc = async (id: string) => (await pg.db.select().from(refundAllocations).where(eq(refundAllocations.refundId, id)))[0].commissionReturnedCents;
    expect([await rc(r1), await rc(r3), await rc(r4)]).toEqual([0, 1, 0]);
    expect(await reconcileRefunds(pg.db)).toEqual([]);
  });

  test('three refunds completing at the same time return exactly the commission in total', async () => {
    const { orderId, so } = await tinyOrder();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { refundId } = await reserveRefund(pg.db, { orderId, lines: [line(so.id, 1)] });
      await send(refundId);
      ids.push(refundId);
    }
    await Promise.all(ids.map((id) => completeRefund(pg.db, id)));
    const allocs = await pg.db.select().from(refundAllocations).where(eq(refundAllocations.orderId, orderId));
    expect(allocs.reduce((s, a) => s + a.commissionReturnedCents, 0)).toBe(1);
    expect(await reconcileRefunds(pg.db)).toEqual([]);
  });
});
