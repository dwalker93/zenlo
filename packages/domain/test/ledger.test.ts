import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { and, eq, inArray } from 'drizzle-orm';
import { inventory, inventoryMovements, orders, sellerLedgerEntries, shipments } from '@workspace/db/schema';
import {
  DeliveryNotVerifiableError,
  SellerOrderStateError,
  cancelSellerOrder,
  completeRefund,
  reconcileRefunds,
  reserveRefund,
  startRefundProcessing,
  verifyDelivery,
} from '../src';
import { createPgTestDb, markShipped, paidOrder, type PgTest } from './pg';

let pg: PgTest;
beforeAll(async () => { pg = await createPgTestDb(); });
afterAll(async () => { await pg.close(); });

const line = (sellerOrderId: string, item: number, delivery = 0) => ({ sellerOrderId, itemAmountCents: item, deliveryAmountCents: delivery });
const entries = async (sellerOrderId: string) =>
  pg.db.select().from(sellerLedgerEntries).where(eq(sellerLedgerEntries.sellerOrderId, sellerOrderId));
const byType = (es: Awaited<ReturnType<typeof entries>>, t: string) => es.filter((e) => e.type === t);
const net = (es: { amountCents: number }[]) => es.reduce((s, e) => s + e.amountCents, 0);
const ordStatus = async (id: string) => (await pg.db.select().from(orders).where(eq(orders.id, id)))[0].status;

async function refund(orderId: string, lines: ReturnType<typeof line>[]) {
  const { refundId } = await reserveRefund(pg.db, { orderId, lines });
  expect((await startRefundProcessing(pg.db, refundId)).started).toBe(true);
  await completeRefund(pg.db, refundId);
  return refundId;
}
const reconcile = async () => expect(await reconcileRefunds(pg.db)).toEqual([]);

describe('verifyDelivery', () => {
  test('posts sale and commission once and derives the order status', async () => {
    const o = await paidOrder(pg.db);
    await markShipped(pg.db, o.A.id, o.sellers[0].locationId);
    await markShipped(pg.db, o.B.id, o.sellers[1].locationId);
    expect((await verifyDelivery(pg.db, o.A.id)).alreadyDelivered).toBe(false);
    const es = await entries(o.A.id);
    expect(byType(es, 'sale').map((e) => e.amountCents)).toEqual([300000]);
    expect(byType(es, 'commission').map((e) => e.amountCents)).toEqual([-30000]);
    expect(await ordStatus(o.orderId)).toBe('partially_fulfilled');
    await verifyDelivery(pg.db, o.B.id);
    expect(await ordStatus(o.orderId)).toBe('completed');
    expect((await verifyDelivery(pg.db, o.B.id)).alreadyDelivered).toBe(true);
    expect(await entries(o.B.id)).toHaveLength(2);
    await reconcile();
  });

  test('refuses unshipped or undelivered parcels', async () => {
    const o = await paidOrder(pg.db);
    await expect(verifyDelivery(pg.db, o.A.id)).rejects.toBeInstanceOf(SellerOrderStateError);
    await markShipped(pg.db, o.A.id, o.sellers[0].locationId);
    await pg.db.update(shipments).set({ status: 'in_transit' }).where(eq(shipments.sellerOrderId, o.A.id));
    await expect(verifyDelivery(pg.db, o.A.id)).rejects.toBeInstanceOf(DeliveryNotVerifiableError);
    expect(await entries(o.A.id)).toHaveLength(0);
  });

  test('10 parallel verifications post the ledger exactly once', async () => {
    const o = await paidOrder(pg.db);
    await markShipped(pg.db, o.A.id, o.sellers[0].locationId);
    const results = await Promise.all(Array.from({ length: 10 }, () => verifyDelivery(pg.db, o.A.id)));
    expect(results.filter((r) => !r.alreadyDelivered)).toHaveLength(1);
    expect(await entries(o.A.id)).toHaveLength(2);
  });
});

describe('ledger policy for refunds around delivery', () => {
  test('refund AFTER delivery posts its debit immediately', async () => {
    const o = await paidOrder(pg.db);
    await markShipped(pg.db, o.A.id, o.sellers[0].locationId);
    await verifyDelivery(pg.db, o.A.id);
    await refund(o.orderId, [line(o.A.id, 100000, 5000)]);
    const es = await entries(o.A.id);
    expect(byType(es, 'refund').map((e) => e.amountCents)).toEqual([-90000]); // 100000 - 10000 commission returned
    expect(net(es)).toBe(300000 - 30000 - 90000);
    await reconcile();
  });

  test('refund BEFORE delivery posts nothing; delivery then posts sale, commission and the catch-up debit', async () => {
    const o = await paidOrder(pg.db);
    await refund(o.orderId, [line(o.A.id, 100000, 5000)]);
    expect(await entries(o.A.id)).toHaveLength(0); // no sale yet, so nothing to reverse
    await markShipped(pg.db, o.A.id, o.sellers[0].locationId);
    await verifyDelivery(pg.db, o.A.id);
    const es = await entries(o.A.id);
    expect(es).toHaveLength(3);
    expect(byType(es, 'refund').map((e) => e.amountCents)).toEqual([-90000]);
    expect(net(es)).toBe(180000);
    await reconcile();
  });

  test('refunded then cancelled seller order never touches the ledger, and its stock returns', async () => {
    const o = await paidOrder(pg.db);
    await refund(o.orderId, [line(o.A.id, 300000, 20000)]);
    const [invBefore] = await pg.db.select().from(inventory).where(eq(inventory.id, o.sellers[0].inventoryId));
    expect(invBefore.onHandQty).toBe(47);
    const r = await cancelSellerOrder(pg.db, o.A.id);
    expect(r.alreadyCancelled).toBe(false);
    expect(r.orderStatus).toBe('processing'); // seller B is still open
    expect(await entries(o.A.id)).toHaveLength(0);
    const [invAfter] = await pg.db.select().from(inventory).where(eq(inventory.id, o.sellers[0].inventoryId));
    expect(invAfter.onHandQty).toBe(50);
    const moves = await pg.db.select().from(inventoryMovements).where(and(eq(inventoryMovements.referenceId, o.A.id), eq(inventoryMovements.movementType, 'return')));
    expect(moves).toHaveLength(1);
    await expect(verifyDelivery(pg.db, o.A.id)).rejects.toBeInstanceOf(SellerOrderStateError);
    await reconcile();
  });

  test('cancelled then refunded gives the same result', async () => {
    const o = await paidOrder(pg.db);
    await cancelSellerOrder(pg.db, o.A.id);
    await refund(o.orderId, [line(o.A.id, 300000, 20000)]);
    expect(await entries(o.A.id)).toHaveLength(0);
    await reconcile();
  });

  test('cancelling both seller orders cancels the order; 10 parallel cancels restock once', async () => {
    const o = await paidOrder(pg.db);
    const res = await Promise.all(Array.from({ length: 10 }, () => cancelSellerOrder(pg.db, o.A.id)));
    expect(res.filter((r) => !r.alreadyCancelled)).toHaveLength(1);
    const [inv] = await pg.db.select().from(inventory).where(eq(inventory.id, o.sellers[0].inventoryId));
    expect(inv.onHandQty).toBe(50);
    await cancelSellerOrder(pg.db, o.B.id);
    expect(await ordStatus(o.orderId)).toBe('cancelled');
  });

  test('a shipped seller order cannot be cancelled', async () => {
    const o = await paidOrder(pg.db);
    await markShipped(pg.db, o.A.id, o.sellers[0].locationId);
    await expect(cancelSellerOrder(pg.db, o.A.id)).rejects.toBeInstanceOf(SellerOrderStateError);
  });

  test('refund racing delivery verification: the debit is posted exactly once either way', async () => {
    let byDelivery = 0, byRefund = 0;
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 40; i++) {
      const o = await paidOrder(pg.db);
      await markShipped(pg.db, o.A.id, o.sellers[0].locationId);
      const { refundId } = await reserveRefund(pg.db, { orderId: o.orderId, lines: [line(o.A.id, 100000)] });
      await startRefundProcessing(pg.db, refundId);
      const results = await Promise.allSettled([
        wait(Math.random() * 10).then(() => completeRefund(pg.db, refundId)),
        wait(Math.random() * 10).then(() => verifyDelivery(pg.db, o.A.id)),
      ]);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      const es = await entries(o.A.id);
      expect(byType(es, 'sale')).toHaveLength(1);
      expect(byType(es, 'commission')).toHaveLength(1);
      const refunds = byType(es, 'refund');
      expect(refunds).toHaveLength(1);
      expect(net(es)).toBe(300000 - 30000 - 90000);
      // same transaction as the sale entry (same now()) = posted by delivery as a catch-up
      if (refunds[0].createdAt.getTime() === byType(es, 'sale')[0].createdAt.getTime()) byDelivery++; else byRefund++;
      await reconcile();
    }
    // Which side wins is timing; the invariants above are what matter. Counts are informational only.
    console.log(`refund-vs-delivery race: debit posted by delivery=${byDelivery}, by refund=${byRefund}`);
    expect(byDelivery + byRefund).toBe(40);
  });

  // The two orderings, run one after the other so neither depends on timing.
  const ordered = async (first: 'refund' | 'delivery') => {
    const o = await paidOrder(pg.db);
    await markShipped(pg.db, o.A.id, o.sellers[0].locationId);
    const { refundId } = await reserveRefund(pg.db, { orderId: o.orderId, lines: [line(o.A.id, 100000)] });
    await startRefundProcessing(pg.db, refundId);
    if (first === 'refund') {
      await completeRefund(pg.db, refundId);
      expect(await entries(o.A.id)).toHaveLength(0); // not delivered yet: nothing to reverse
      await verifyDelivery(pg.db, o.A.id);
    } else {
      await verifyDelivery(pg.db, o.A.id);
      await completeRefund(pg.db, refundId);
    }
    const es = await entries(o.A.id);
    expect(byType(es, 'sale')).toHaveLength(1);
    expect(byType(es, 'commission')).toHaveLength(1);
    expect(byType(es, 'refund')).toHaveLength(1);
    expect(net(es)).toBe(300000 - 30000 - 90000);
    await reconcile();
  };
  test('refund completes before delivery is verified: delivery posts the debit', () => ordered('refund'));
  test('delivery is verified before the refund completes: the refund posts the debit', () => ordered('delivery'));
});
