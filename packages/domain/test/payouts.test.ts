import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { auditLogs, payoutItems, payouts, sellerLedgerEntries, sellerOrders } from '@workspace/db/schema';
import {
  NoPayoutAccountError,
  PayoutOutcomeUnknownError,
  PayoutStateError,
  cancelPayout,
  completeRefund,
  confirmPayment,
  createPayout,
  markPayoutFailed,
  markPayoutPaid,
  placeOrder,
  reconcilePayouts,
  reconcileRefunds,
  reserveRefund,
  retryPayout,
  startPayout,
  startRefundProcessing,
  verifyDelivery,
} from '../src';
import { addPayoutAccount, createPgTestDb, markShipped, seed, shipping, type PgTest } from './pg';

let pg: PgTest;
beforeAll(async () => { pg = await createPgTestDb(); });
afterAll(async () => { await pg.close(); });

/** One seller, `n` delivered orders of 3 x 100000 (each: sale 300000, commission -30000 = 270000 net). */
async function sellerWithDeliveries(n: number, opts: { account?: boolean } = {}) {
  const s = await seed(pg.db, { stock: 100, sellers: 1 });
  const seller = s.sellers[0];
  if (opts.account !== false) await addPayoutAccount(pg.db, seller.sellerId);
  const sellerOrderIds: string[] = [];
  const orderIds: string[] = [];
  for (let i = 0; i < n; i++) {
    const placed = await placeOrder(pg.db, {
      buyerId: s.buyerId, paymentMethod: 'bank_transfer', shipping,
      items: [{ variantId: seller.variantId, quantity: 3 }], calculateDeliveryFeeCents: () => 20000,
    });
    await confirmPayment(pg.db, { paymentId: placed.paymentId });
    const [so] = await pg.db.select().from(sellerOrders).where(eq(sellerOrders.orderId, placed.orderId));
    await markShipped(pg.db, so.id, seller.locationId);
    await verifyDelivery(pg.db, so.id);
    sellerOrderIds.push(so.id);
    orderIds.push(placed.orderId);
  }
  return { sellerId: seller.sellerId, sellerOrderIds, orderIds };
}
const live = async (payoutId: string) =>
  (await pg.db.select().from(payoutItems).where(eq(payoutItems.payoutId, payoutId))).filter((i) => i.releasedAt === null);
const payoutRow = async (id: string) => (await pg.db.select().from(payouts).where(eq(payouts.id, id)))[0];
const clean = async () => {
  expect(await reconcilePayouts(pg.db)).toEqual([]);
  expect(await reconcileRefunds(pg.db)).toEqual([]);
};
async function create(sellerId: string) {
  const r = await createPayout(pg.db, sellerId);
  if (!r.created) throw new Error(`payout not created: ${r.reason}`);
  return r;
}

describe('createPayout', () => {
  test('claims every entry, nets debits against credits, writes an audit row', async () => {
    const s = await sellerWithDeliveries(1);
    const { refundId } = await reserveRefund(pg.db, { orderId: s.orderIds[0], lines: [{ sellerOrderId: s.sellerOrderIds[0], itemAmountCents: 100000, deliveryAmountCents: 0 }] });
    await startRefundProcessing(pg.db, refundId);
    await completeRefund(pg.db, refundId);
    const r = await create(s.sellerId);
    expect(r.amountCents).toBe(270000 - 90000);
    expect(r.entryCount).toBe(3);
    expect(await live(r.payoutId)).toHaveLength(3);
    const logs = await pg.db.select().from(auditLogs).where(eq(auditLogs.entityId, r.payoutId));
    expect(logs.map((l) => l.action)).toContain('payout.created');
    expect((await createPayout(pg.db, s.sellerId)).created).toBe(false); // everything is claimed now
    await clean();
  });

  test('nothing to pay, and no payout account, create nothing', async () => {
    const empty = await seed(pg.db, { sellers: 1 });
    expect(await createPayout(pg.db, empty.sellers[0].sellerId)).toMatchObject({ created: false, reason: 'nothing_to_pay' });
    const s = await sellerWithDeliveries(1, { account: false });
    await expect(createPayout(pg.db, s.sellerId)).rejects.toBeInstanceOf(NoPayoutAccountError);
    expect(await pg.db.select().from(payouts).where(eq(payouts.sellerId, s.sellerId))).toHaveLength(0);
    // the failed attempt claimed nothing
    await addPayoutAccount(pg.db, s.sellerId);
    expect((await create(s.sellerId)).entryCount).toBe(2);
  });

  test('a net balance <= 0 creates no payout and carries forward into the next one', async () => {
    const s = await seed(pg.db, { sellers: 1 });
    await addPayoutAccount(pg.db, s.sellers[0].sellerId);
    await pg.db.insert(sellerLedgerEntries).values({ sellerId: s.sellers[0].sellerId, type: 'adjustment', amountCents: -100, description: 'chargeback' });
    expect(await createPayout(pg.db, s.sellers[0].sellerId)).toMatchObject({ created: false, reason: 'non_positive_balance', balanceCents: -100 });

    const d = await sellerWithDeliveries(1);
    // move the adjustment onto the seller that now has a delivery
    await pg.db.insert(sellerLedgerEntries).values({ sellerId: d.sellerId, type: 'adjustment', amountCents: -100 });
    const r = await create(d.sellerId);
    expect(r.amountCents).toBe(270000 - 100);
    expect(r.entryCount).toBe(3);
  });

  test('concurrent payout runs for one seller: exactly one payout, no entry claimed twice (25 rounds)', async () => {
    for (let round = 0; round < 25; round++) {
      const s = await sellerWithDeliveries(3);
      const results = await Promise.allSettled(Array.from({ length: 8 }, () => createPayout(pg.db, s.sellerId)));
      // a raw unique-violation from a double claim would show up as a rejection here
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      const made = results.map((r) => (r as PromiseFulfilledResult<any>).value).filter((r) => r.created);
      expect(made).toHaveLength(1);
      expect(made[0].entryCount).toBe(6);
      expect(made[0].amountCents).toBe(3 * 270000);
      expect(await live(made[0].payoutId)).toHaveLength(6);
    }
    await clean();
  });
});

describe('payout lifecycle', () => {
  test('failed payout keeps its entries claimed; retry uses the SAME payout; paid is terminal', async () => {
    const s = await sellerWithDeliveries(1);
    const { payoutId, amountCents } = await create(s.sellerId);
    expect((await startPayout(pg.db, payoutId)).changed).toBe(true);
    await markPayoutFailed(pg.db, payoutId, { reason: 'account closed' });
    expect((await payoutRow(payoutId)).failureReason).toBe('account closed');
    expect(await createPayout(pg.db, s.sellerId)).toMatchObject({ created: false, reason: 'nothing_to_pay' }); // still claimed
    expect((await retryPayout(pg.db, payoutId)).changed).toBe(true);
    await markPayoutPaid(pg.db, payoutId, { bankReference: 'BANK-123' });
    const p = await payoutRow(payoutId);
    expect(p.status).toBe('paid');
    expect(p.amountCents).toBe(amountCents);
    expect(p.bankReference).toBe('BANK-123');
    expect(p.paidAt).not.toBeNull();
    await expect(cancelPayout(pg.db, payoutId)).rejects.toBeInstanceOf(PayoutStateError);
    await expect(retryPayout(pg.db, payoutId)).rejects.toBeInstanceOf(PayoutStateError);
    expect((await markPayoutPaid(pg.db, payoutId, { bankReference: 'BANK-123' })).changed).toBe(false); // idempotent
    expect(await live(payoutId)).toHaveLength(2);
    await clean();
  });

  test('cancel releases the entries (history kept) and the next payout claims them again', async () => {
    const s = await sellerWithDeliveries(1);
    const first = await create(s.sellerId);
    await startPayout(pg.db, first.payoutId);
    await markPayoutFailed(pg.db, first.payoutId, { reason: 'bad account' });
    expect((await cancelPayout(pg.db, first.payoutId)).changed).toBe(true);
    expect((await cancelPayout(pg.db, first.payoutId)).changed).toBe(false);
    const history = await pg.db.select().from(payoutItems).where(eq(payoutItems.payoutId, first.payoutId));
    expect(history).toHaveLength(2);
    expect(history.every((h) => h.releasedAt !== null)).toBe(true);
    const second = await create(s.sellerId);
    expect(second.payoutId).not.toBe(first.payoutId);
    expect(second.amountCents).toBe(first.amountCents);
    await clean();
  });

  test('a refund debit arriving after payment carries forward instead of reopening the paid payout', async () => {
    const s = await sellerWithDeliveries(1);
    const first = await create(s.sellerId);
    await startPayout(pg.db, first.payoutId);
    await markPayoutPaid(pg.db, first.payoutId, { bankReference: 'B1' });
    const { refundId } = await reserveRefund(pg.db, { orderId: s.orderIds[0], lines: [{ sellerOrderId: s.sellerOrderIds[0], itemAmountCents: 300000, deliveryAmountCents: 0 }] });
    await startRefundProcessing(pg.db, refundId);
    await completeRefund(pg.db, refundId);
    expect(await createPayout(pg.db, s.sellerId)).toMatchObject({ created: false, reason: 'non_positive_balance', balanceCents: -270000 });
    expect(await live(first.payoutId)).toHaveLength(2); // untouched
    await clean();
  });

  test('10 parallel cancels of a pending payout release once', async () => {
    const s = await sellerWithDeliveries(1);
    const { payoutId } = await create(s.sellerId);
    const res = await Promise.all(Array.from({ length: 10 }, () => cancelPayout(pg.db, payoutId)));
    expect(res.filter((r) => r.changed)).toHaveLength(1);
    expect(await live(payoutId)).toHaveLength(0);
    await clean();
  });

  test('a processing payout cannot be cancelled: the transfer may have been sent, so entries stay claimed', async () => {
    const s = await sellerWithDeliveries(1);
    const first = await create(s.sellerId);
    if (!first.created) throw new Error('expected a payout');
    await startPayout(pg.db, first.payoutId);
    await expect(cancelPayout(pg.db, first.payoutId)).rejects.toBeInstanceOf(PayoutOutcomeUnknownError);
    expect((await payoutRow(first.payoutId)).status).toBe('processing');
    expect(await live(first.payoutId)).toHaveLength(2);
    // nothing can claim the entries again while the outcome is unknown
    expect(await createPayout(pg.db, s.sellerId)).toMatchObject({ created: false, reason: 'nothing_to_pay' });
    // recovery rule: bank confirms it did NOT happen -> failed -> cancel releases -> next payout claims them
    await markPayoutFailed(pg.db, first.payoutId, { reason: 'bank confirmed: not sent' });
    expect(await live(first.payoutId)).toHaveLength(2);
    await cancelPayout(pg.db, first.payoutId);
    expect(await live(first.payoutId)).toHaveLength(0);
    const second = await create(s.sellerId);
    expect(second.created).toBe(true);
    // and if the bank says it DID happen, the payout is marked paid and its entries stay claimed forever
    const t = await sellerWithDeliveries(1);
    const p = await create(t.sellerId);
    if (!p.created) throw new Error('expected a payout');
    await startPayout(pg.db, p.payoutId);
    await markPayoutPaid(pg.db, p.payoutId, { bankReference: 'CONFIRMED' });
    await expect(cancelPayout(pg.db, p.payoutId)).rejects.toBeInstanceOf(PayoutStateError);
    expect(await live(p.payoutId)).toHaveLength(2);
    await clean();
  });

  test('cancel racing start: cancel wins (released) or start wins (cancel refused, entries stay claimed)', async () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let cancelled = 0, started = 0;
    for (let i = 0; i < 30; i++) {
      const d = await sellerWithDeliveries(1);
      const p = await create(d.sellerId);
      if (!p.created) throw new Error('expected a payout');
      const [c, st] = await Promise.allSettled([
        wait(Math.random() * 8).then(() => cancelPayout(pg.db, p.payoutId)),
        wait(Math.random() * 8).then(() => startPayout(pg.db, p.payoutId)),
      ]);
      const row = await payoutRow(p.payoutId);
      if (row.status === 'cancelled') {
        cancelled++;
        expect(c.status).toBe('fulfilled');
        expect(st.status).toBe('rejected');
        expect(await live(p.payoutId)).toHaveLength(0);
      } else {
        started++;
        expect(row.status).toBe('processing');
        expect(st.status).toBe('fulfilled');
        expect(c.status).toBe('rejected');
        expect((c as PromiseRejectedResult).reason).toBeInstanceOf(PayoutOutcomeUnknownError);
        expect(await live(p.payoutId)).toHaveLength(2); // still claimed: never double-paid
      }
    }
    console.log(`cancel-vs-start race: cancelled=${cancelled} started=${started}`);
    expect(cancelled).toBeGreaterThan(0);
    expect(started).toBeGreaterThan(0);
    await clean();
  });

  test('paid racing failed on a processing payout: exactly one wins, entries stay claimed either way', async () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 20; i++) {
      const d = await sellerWithDeliveries(1);
      const p = await create(d.sellerId);
      if (!p.created) throw new Error('expected a payout');
      await startPayout(pg.db, p.payoutId);
      const [a, b] = await Promise.allSettled([
        wait(Math.random() * 8).then(() => markPayoutPaid(pg.db, p.payoutId, { bankReference: 'R' })),
        wait(Math.random() * 8).then(() => markPayoutFailed(pg.db, p.payoutId, { reason: 'x' })),
      ]);
      expect([a.status, b.status].filter((x) => x === 'fulfilled')).toHaveLength(1);
      expect(['paid', 'failed']).toContain((await payoutRow(p.payoutId)).status);
      expect(await live(p.payoutId)).toHaveLength(2);
    }
    await clean();
  });
});
