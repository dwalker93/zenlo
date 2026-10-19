import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { orders, payments, sellerLedgerEntries, sellerOrders, shipmentEvents, shipments } from '@workspace/db/schema';
import {
  InvalidShipmentError,
  OpenPaymentExistsError,
  OrderNotAwaitingPaymentError,
  SellerOrderStateError,
  applyCourierEvent,
  confirmPayment,
  createPaymentAttempt,
  placeOrder,
  recordPaymentFailure,
  recordShipment,
  verifyDelivery,
} from '../src';
import { createPgTestDb, paidOrder, seed, shipping, type PgTest } from './pg';

let pg: PgTest;
beforeAll(async () => { pg = await createPgTestDb(); });
afterAll(async () => { await pg.close(); });

const soStatus = async (id: string) => (await pg.db.select().from(sellerOrders).where(eq(sellerOrders.id, id)))[0].status;
const t0 = new Date('2026-10-01T10:00:00Z');
const at = (min: number) => new Date(t0.getTime() + min * 60_000);

describe('recordShipment', () => {
  test('processing -> shipped, with a booked shipment and event', async () => {
    const o = await paidOrder(pg.db);
    const r = await recordShipment(pg.db, { sellerOrderId: o.A.id, pickupLocationId: o.sellers[0].locationId, trackingNumber: 'TRK-1', feeCents: 25000 });
    expect(r.sellerOrderStatus).toBe('shipped');
    expect(await soStatus(o.A.id)).toBe('shipped');
    const [sh] = await pg.db.select().from(shipments).where(eq(shipments.id, r.shipmentId));
    expect(sh.status).toBe('booked');
    expect(sh.trackingNumber).toBe('TRK-1');
    expect(await pg.db.select().from(shipmentEvents).where(eq(shipmentEvents.shipmentId, r.shipmentId))).toHaveLength(1);
  });

  test('pickup location must belong to the seller; shipped orders cannot be shipped again; partial parcels', async () => {
    const o = await paidOrder(pg.db);
    await expect(
      recordShipment(pg.db, { sellerOrderId: o.A.id, pickupLocationId: o.sellers[1].locationId }),
    ).rejects.toBeInstanceOf(InvalidShipmentError);
    expect(await soStatus(o.A.id)).toBe('processing');
    await recordShipment(pg.db, { sellerOrderId: o.A.id, pickupLocationId: o.sellers[0].locationId, complete: false });
    expect(await soStatus(o.A.id)).toBe('partially_shipped');
    await recordShipment(pg.db, { sellerOrderId: o.A.id, pickupLocationId: o.sellers[0].locationId });
    expect(await soStatus(o.A.id)).toBe('shipped');
    await expect(
      recordShipment(pg.db, { sellerOrderId: o.A.id, pickupLocationId: o.sellers[0].locationId }),
    ).rejects.toBeInstanceOf(SellerOrderStateError);
  });

  test('10 parallel shipments of one seller order: exactly one wins the guarded transition', async () => {
    const o = await paidOrder(pg.db);
    const res = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => recordShipment(pg.db, { sellerOrderId: o.A.id, pickupLocationId: o.sellers[0].locationId, trackingNumber: `P-${i}` })),
    );
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await pg.db.select().from(shipments).where(eq(shipments.sellerOrderId, o.A.id))).toHaveLength(1);
  });
});

describe('applyCourierEvent', () => {
  async function shipped(track: string) {
    const o = await paidOrder(pg.db);
    const r = await recordShipment(pg.db, { sellerOrderId: o.A.id, pickupLocationId: o.sellers[0].locationId, trackingNumber: track, now: t0 });
    return { o, shipmentId: r.shipmentId };
  }

  test('follows the courier, ignores duplicates, and never moves backwards on late events', async () => {
    const { shipmentId } = await shipped('C-1');
    expect((await applyCourierEvent(pg.db, { trackingNumber: 'C-1', status: 'in_transit', occurredAt: at(10) })).applied).toBe(true);
    expect((await applyCourierEvent(pg.db, { trackingNumber: 'C-1', status: 'in_transit', occurredAt: at(10) })) as any).toMatchObject({ applied: false, duplicate: true });
    // an OLDER event arriving late must not change the status
    expect((await applyCourierEvent(pg.db, { trackingNumber: 'C-1', status: 'booked', occurredAt: at(5) })).applied).toBe(false);
    const [mid] = await pg.db.select().from(shipments).where(eq(shipments.id, shipmentId));
    expect(mid.status).toBe('in_transit');
    expect((await applyCourierEvent(pg.db, { trackingNumber: 'C-1', status: 'delivered', occurredAt: at(60) })).applied).toBe(true);
    const [done] = await pg.db.select().from(shipments).where(eq(shipments.id, shipmentId));
    expect(done.status).toBe('delivered');
    expect(done.deliveredAt!.getTime()).toBe(at(60).getTime());
    // delivered is final
    expect((await applyCourierEvent(pg.db, { trackingNumber: 'C-1', status: 'failed', occurredAt: at(90) })).applied).toBe(false);
    expect((await pg.db.select().from(shipments).where(eq(shipments.id, shipmentId)))[0].status).toBe('delivered');
  });

  test('unknown tracking numbers are reported, not an error', async () => {
    expect(await applyCourierEvent(pg.db, { trackingNumber: 'NOPE', status: 'delivered', occurredAt: at(1) })).toEqual({ matched: false });
  });

  test('10 parallel identical delivered events: one applied, rest duplicates, one event row', async () => {
    const { shipmentId } = await shipped('C-2');
    const res = await Promise.all(Array.from({ length: 10 }, () => applyCourierEvent(pg.db, { trackingNumber: 'C-2', status: 'delivered', occurredAt: at(30) })));
    expect(res.filter((r) => (r as any).applied)).toHaveLength(1);
    const evs = await pg.db.select().from(shipmentEvents).where(eq(shipmentEvents.shipmentId, shipmentId));
    expect(evs.filter((e) => e.status === 'delivered')).toHaveLength(1);
  });

  test('courier delivery alone does not post the ledger; verifyDelivery then does', async () => {
    const { o } = await shipped('C-3');
    await applyCourierEvent(pg.db, { trackingNumber: 'C-3', status: 'delivered', occurredAt: at(30) });
    expect(await pg.db.select().from(sellerLedgerEntries).where(eq(sellerLedgerEntries.sellerOrderId, o.A.id))).toHaveLength(0);
    await verifyDelivery(pg.db, o.A.id);
    expect(await pg.db.select().from(sellerLedgerEntries).where(eq(sellerLedgerEntries.sellerOrderId, o.A.id))).toHaveLength(2);
  });
});

describe('payment attempts', () => {
  async function unpaid() {
    const s = await seed(pg.db, { stock: 10, sellers: 1 });
    const placed = await placeOrder(pg.db, { buyerId: s.buyerId, paymentMethod: 'payhere', shipping, items: [{ variantId: s.sellers[0].variantId, quantity: 1 }] });
    return placed;
  }

  test('failure is recorded once; a new attempt is allowed only without an open one; the new attempt can pay', async () => {
    const placed = await unpaid();
    await expect(createPaymentAttempt(pg.db, placed.orderId, 'bank_transfer')).rejects.toBeInstanceOf(OpenPaymentExistsError);
    expect((await recordPaymentFailure(pg.db, placed.paymentId, 'failed')).changed).toBe(true);
    expect((await recordPaymentFailure(pg.db, placed.paymentId, 'failed')).changed).toBe(false);
    const { paymentId } = await createPaymentAttempt(pg.db, placed.orderId, 'bank_transfer');
    expect(paymentId).not.toBe(placed.paymentId);
    await confirmPayment(pg.db, { paymentId });
    expect((await pg.db.select().from(orders).where(eq(orders.id, placed.orderId)))[0].status).toBe('processing');
    // a succeeded payment is never downgraded by a late failure callback
    expect(await recordPaymentFailure(pg.db, paymentId, 'failed')).toMatchObject({ changed: false, status: 'succeeded' });
  });

  test('no new attempt once the payment window has passed or the order is paid', async () => {
    const placed = await unpaid();
    await recordPaymentFailure(pg.db, placed.paymentId, 'failed');
    await expect(
      createPaymentAttempt(pg.db, placed.orderId, 'payhere', new Date(placed.paymentDueAt.getTime() + 1000)),
    ).rejects.toBeInstanceOf(OrderNotAwaitingPaymentError);
    const paid = await paidOrder(pg.db);
    await expect(createPaymentAttempt(pg.db, paid.orderId, 'payhere')).rejects.toBeInstanceOf(OrderNotAwaitingPaymentError);
  });

  test('two racing attempts: exactly one opens', async () => {
    const placed = await unpaid();
    await recordPaymentFailure(pg.db, placed.paymentId, 'failed');
    const res = await Promise.allSettled(Array.from({ length: 8 }, () => createPaymentAttempt(pg.db, placed.orderId, 'payhere')));
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await pg.db.select().from(payments).where(eq(payments.orderId, placed.orderId))).filter((p) => p.status === 'pending')).toHaveLength(1);
  });
});

describe('tracking numbers are unique per courier', () => {
  test('a duplicate number for the same courier is refused and changes nothing; another courier may reuse it', async () => {
    const a = await paidOrder(pg.db);
    const b = await paidOrder(pg.db);
    await recordShipment(pg.db, { sellerOrderId: a.A.id, pickupLocationId: a.sellers[0].locationId, trackingNumber: 'DUP-1' });
    await expect(recordShipment(pg.db, { sellerOrderId: b.A.id, pickupLocationId: b.sellers[0].locationId, trackingNumber: 'DUP-1' })).rejects.toBeInstanceOf(InvalidShipmentError);
    expect((await pg.db.select().from(sellerOrders).where(eq(sellerOrders.id, b.A.id)))[0].status).toBe('processing'); // rolled back
    await recordShipment(pg.db, { sellerOrderId: b.A.id, pickupLocationId: b.sellers[0].locationId, trackingNumber: 'DUP-1', courier: 'other-courier' });
  });

  test('a courier event only matches that courier\'s shipment', async () => {
    const a = await paidOrder(pg.db);
    await recordShipment(pg.db, { sellerOrderId: a.A.id, pickupLocationId: a.sellers[0].locationId, trackingNumber: 'X-9', courier: 'other-courier' });
    const t = new Date(Date.now() + 3_600_000);
    expect(await applyCourierEvent(pg.db, { trackingNumber: 'X-9', status: 'delivered', occurredAt: t })).toEqual({ matched: false }); // default courier: no such shipment
    expect((await applyCourierEvent(pg.db, { courier: 'other-courier', trackingNumber: 'X-9', status: 'in_transit', occurredAt: t })).matched).toBe(true);
  });
});
