import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { inventory, inventoryMovements, orders, payments, sellerOrders } from '@workspace/db/schema';
import {
  DomainError,
  OrderNotAwaitingPaymentError,
  PaymentAmountMismatchError,
  PaymentNotPayableError,
  cancelUnpaidOrder,
  confirmPayment,
  expireOverdueOrders,
  placeOrder,
} from '../src';
import { createPgTestDb, seed, shipping, type PgTest } from './pg';

let pg: PgTest;
beforeAll(async () => { pg = await createPgTestDb(); });
afterAll(async () => { await pg.close(); });

const stock = async (id: string) => (await pg.db.select().from(inventory).where(eq(inventory.id, id)))[0];
const orderStatus = async (id: string) => (await pg.db.select().from(orders).where(eq(orders.id, id)))[0].status;

async function newOrder(qty = 1, opts: { now?: Date; stockQty?: number } = {}) {
  const s = await seed(pg.db, { stock: opts.stockQty ?? 10, sellers: 2 });
  const placed = await placeOrder(pg.db, {
    buyerId: s.buyerId, paymentMethod: 'bank_transfer', shipping, now: opts.now,
    items: s.sellers.map((x) => ({ variantId: x.variantId, quantity: qty })),
  });
  return { ...s, placed };
}

describe('confirmPayment', () => {
  test('moves order to processing and turns reservations into sales', async () => {
    const { sellers, placed } = await newOrder(2);
    const r = await confirmPayment(pg.db, { paymentId: placed.paymentId });
    expect(r.alreadyConfirmed).toBe(false);
    expect(await orderStatus(placed.orderId)).toBe('processing');
    for (const s of sellers) {
      const row = await stock(s.inventoryId);
      expect(row.onHandQty).toBe(8);
      expect(row.reservedQty).toBe(0);
    }
    const sos = await pg.db.select().from(sellerOrders).where(eq(sellerOrders.orderId, placed.orderId));
    expect(sos.every((s) => s.status === 'processing')).toBe(true);
    const moves = await pg.db.select().from(inventoryMovements).where(eq(inventoryMovements.movementType, 'sale'));
    expect(moves.filter((m) => sos.some((s) => s.id === m.referenceId))).toHaveLength(2);
  });

  test('rejects a payment whose amount does not match the order', async () => {
    const { placed } = await newOrder();
    await pg.db.update(payments).set({ amountCents: 1 }).where(eq(payments.id, placed.paymentId));
    await expect(confirmPayment(pg.db, { paymentId: placed.paymentId })).rejects.toBeInstanceOf(PaymentAmountMismatchError);
    expect(await orderStatus(placed.orderId)).toBe('pending_payment');
  });

  test('10 duplicate callbacks at once: one wins, stock is consumed once', async () => {
    const { sellers, placed } = await newOrder(3);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => confirmPayment(pg.db, { paymentId: placed.paymentId })),
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const fresh = results.filter((r) => r.status === 'fulfilled' && !(r as any).value.alreadyConfirmed);
    expect(fresh).toHaveLength(1);
    for (const s of sellers) {
      const row = await stock(s.inventoryId);
      expect(row.onHandQty).toBe(7);
      expect(row.reservedQty).toBe(0);
    }
    const sos = await pg.db.select().from(sellerOrders).where(eq(sellerOrders.orderId, placed.orderId));
    const moves = await pg.db.select().from(inventoryMovements).where(eq(inventoryMovements.movementType, 'sale'));
    expect(moves.filter((m) => sos.some((s) => s.id === m.referenceId))).toHaveLength(2);
  });
});

describe('cancelUnpaidOrder / expiry', () => {
  test('cancels, cancels the pending payment and releases stock', async () => {
    const { sellers, placed } = await newOrder(4);
    expect((await cancelUnpaidOrder(pg.db, placed.orderId)).cancelled).toBe(true);
    expect(await orderStatus(placed.orderId)).toBe('cancelled');
    for (const s of sellers) expect((await stock(s.inventoryId)).reservedQty).toBe(0);
    const [p] = await pg.db.select().from(payments).where(eq(payments.id, placed.paymentId));
    expect(p.status).toBe('cancelled');
    await expect(confirmPayment(pg.db, { paymentId: placed.paymentId })).rejects.toBeInstanceOf(PaymentNotPayableError);
  });

  test('20 parallel cancels release stock exactly once', async () => {
    const { sellers, placed } = await newOrder(2);
    const results = await Promise.all(Array.from({ length: 20 }, () => cancelUnpaidOrder(pg.db, placed.orderId)));
    expect(results.filter((r) => r.cancelled)).toHaveLength(1);
    for (const s of sellers) {
      const row = await stock(s.inventoryId);
      expect(row.reservedQty).toBe(0);
      expect(row.onHandQty).toBe(10);
    }
  });

  test('a paid order cannot be cancelled by the expiry job', async () => {
    const { placed } = await newOrder();
    await confirmPayment(pg.db, { paymentId: placed.paymentId });
    expect((await cancelUnpaidOrder(pg.db, placed.orderId)).cancelled).toBe(false);
    expect(await orderStatus(placed.orderId)).toBe('processing');
  });

  test('expireOverdueOrders only touches overdue unpaid orders, and parallel runs do not double-release', async () => {
    const old = await newOrder(1, { now: new Date(Date.now() - 100 * 3600_000) });
    const fresh = await newOrder(1);
    const runs = await Promise.all(Array.from({ length: 5 }, () => expireOverdueOrders(pg.db, { limit: 1000 })));
    expect(runs.reduce((s, r) => s + r.cancelled, 0)).toBeGreaterThanOrEqual(1);
    expect(await orderStatus(old.placed.orderId)).toBe('cancelled');
    expect(await orderStatus(fresh.placed.orderId)).toBe('pending_payment');
    for (const s of old.sellers) expect((await stock(s.inventoryId)).reservedQty).toBe(0);
    for (const s of fresh.sellers) expect((await stock(s.inventoryId)).reservedQty).toBe(1);
  });
});

describe('payment vs expiry race', () => {
  test('30 orders: confirm and cancel fire together; each ends in exactly one consistent state', async () => {
    const orders30 = await Promise.all(Array.from({ length: 30 }, () => newOrder(2)));
    const outcomes = await Promise.all(
      orders30.map(async (o) => {
        const [c, x] = await Promise.allSettled([
          confirmPayment(pg.db, { paymentId: o.placed.paymentId }),
          cancelUnpaidOrder(pg.db, o.placed.orderId),
        ]);
        return { o, c, x };
      }),
    );
    let paid = 0, cancelled = 0;
    for (const { o, c, x } of outcomes) {
      const status = await orderStatus(o.placed.orderId);
      // no deadlocks / unexpected errors: a losing confirm must be a typed domain error
      if (c.status === 'rejected') expect(c.reason).toBeInstanceOf(DomainError);
      if (x.status === 'rejected') throw x.reason;
      for (const s of o.sellers) {
        const row = await stock(s.inventoryId);
        expect(row.reservedQty).toBe(0);
        if (status === 'processing') expect(row.onHandQty).toBe(8);
        else expect(row.onHandQty).toBe(10);
      }
      if (status === 'processing') {
        paid++;
        expect(c.status).toBe('fulfilled');
        expect((x as any).value.cancelled).toBe(false);
      } else {
        cancelled++;
        expect(status).toBe('cancelled');
        expect(c.status).toBe('rejected');
        expect([PaymentNotPayableError, OrderNotAwaitingPaymentError].some((E) => (c as any).reason instanceof E)).toBe(true);
        expect((x as any).value.cancelled).toBe(true);
      }
    }
    console.log('race outcomes paid=' + paid + ' cancelled=' + cancelled);
    expect(paid + cancelled).toBe(30);
  });
});
