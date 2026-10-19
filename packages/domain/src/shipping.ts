import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { orders, sellerLocations, sellerOrders, shipmentEvents, shipments } from '@workspace/db/schema';
import { audit } from './audit';
import { InvalidShipmentError, SellerOrderNotFoundError, SellerOrderStateError } from './errors';
import type { Db } from './types';

export interface RecordShipmentInput {
  sellerOrderId: string;
  pickupLocationId: string;
  trackingNumber?: string | null;
  courier?: string;
  feeCents?: number;
  /** false = more parcels will follow: the seller order becomes 'partially_shipped' instead of 'shipped'. */
  complete?: boolean;
  actorId?: string | null;
  now?: Date;
}

/**
 * Seller hands a parcel to the courier. Guarded processing|partially_shipped -> shipped|partially_shipped.
 * The pickup location must belong to the seller of the seller order.
 */
export async function recordShipment(db: Db, input: RecordShipmentInput) {
  const now = input.now ?? new Date();
  const fee = input.feeCents ?? 0;
  if (!Number.isSafeInteger(fee) || fee < 0) throw new InvalidShipmentError('fee must be a non-negative safe integer');
  return db.transaction(async (tx) => {
    const [head] = await tx.select({ orderId: sellerOrders.orderId }).from(sellerOrders).where(eq(sellerOrders.id, input.sellerOrderId));
    if (!head) throw new SellerOrderNotFoundError(input.sellerOrderId);
    await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, head.orderId)).for('update'); // order row first
    const [so] = await tx.select().from(sellerOrders).where(eq(sellerOrders.id, input.sellerOrderId)).for('update');

    const [loc] = await tx.select({ sellerId: sellerLocations.sellerId }).from(sellerLocations).where(eq(sellerLocations.id, input.pickupLocationId));
    if (!loc || loc.sellerId !== so.sellerId) throw new InvalidShipmentError('pickup location does not belong to this seller order\'s seller');

    const next = input.complete === false ? 'partially_shipped' : 'shipped';
    const won = await tx
      .update(sellerOrders)
      .set({ status: next })
      .where(and(eq(sellerOrders.id, input.sellerOrderId), inArray(sellerOrders.status, ['processing', 'partially_shipped'])))
      .returning({ id: sellerOrders.id });
    if (won.length !== 1) throw new SellerOrderStateError(input.sellerOrderId, 'processing|partially_shipped', so.status);

    const [sh] = await tx
      .insert(shipments)
      .values({
        sellerOrderId: so.id,
        pickupLocationId: input.pickupLocationId,
        courier: input.courier ?? 'promptxpress',
        trackingNumber: input.trackingNumber ?? null,
        status: 'booked',
        feeCents: fee,
        shippedAt: now,
      })
      .onConflictDoNothing() // (courier, tracking_number) is unique: never let two parcels share a number
      .returning({ id: shipments.id });
    if (!sh) throw new InvalidShipmentError(`tracking number ${input.trackingNumber} is already used for this courier`);
    await tx.insert(shipmentEvents).values({ shipmentId: sh.id, status: 'booked', occurredAt: now });
    await audit(tx, { actorId: input.actorId, action: 'shipment.recorded', entityType: 'shipment', entityId: sh.id, metadata: { sellerOrderId: so.id, sellerOrderStatus: next } });
    return { shipmentId: sh.id, sellerOrderStatus: next };
  });
}

export interface CourierEvent {
  /** Tracking numbers are only unique per carrier. Defaults to 'promptxpress'. */
  courier?: string;
  trackingNumber: string;
  status: 'booked' | 'in_transit' | 'delivered' | 'failed' | 'returned' | 'cancelled';
  occurredAt: Date;
  description?: string | null;
}

/**
 * A courier status update (webhook or poll). Idempotent: the same event twice changes nothing.
 * The shipment status follows the NEWEST event by occurredAt, so a late, out-of-order delivery of an
 * older event cannot move it backwards. A delivered/cancelled shipment is never changed.
 * This does NOT verify delivery or touch the ledger: verifyDelivery is a separate, explicit step.
 */
export async function applyCourierEvent(db: Db, ev: CourierEvent) {
  return db.transaction(async (tx) => {
    const [found] = await tx
      .select({ id: shipments.id })
      .from(shipments)
      .where(and(eq(shipments.courier, ev.courier ?? 'promptxpress'), eq(shipments.trackingNumber, ev.trackingNumber)))
      .limit(1);
    if (!found) return { matched: false as const };
    const [sh] = await tx.select().from(shipments).where(eq(shipments.id, found.id)).for('update');

    const dup = await tx
      .select({ id: shipmentEvents.id })
      .from(shipmentEvents)
      .where(and(eq(shipmentEvents.shipmentId, sh.id), eq(shipmentEvents.status, ev.status), eq(shipmentEvents.occurredAt, ev.occurredAt)))
      .limit(1);
    if (dup.length > 0) return { matched: true as const, shipmentId: sh.id, sellerOrderId: sh.sellerOrderId, applied: false, duplicate: true };

    const [latest] = await tx
      .select({ at: shipmentEvents.occurredAt })
      .from(shipmentEvents)
      .where(eq(shipmentEvents.shipmentId, sh.id))
      .orderBy(desc(shipmentEvents.occurredAt))
      .limit(1);
    await tx.insert(shipmentEvents).values({ shipmentId: sh.id, status: ev.status, description: ev.description ?? null, occurredAt: ev.occurredAt });

    const terminal = sh.status === 'delivered' || sh.status === 'cancelled';
    const isNewest = !latest || ev.occurredAt.getTime() >= latest.at.getTime();
    if (terminal || !isNewest) return { matched: true as const, shipmentId: sh.id, sellerOrderId: sh.sellerOrderId, applied: false, duplicate: false };

    await tx
      .update(shipments)
      .set({ status: ev.status, ...(ev.status === 'delivered' ? { deliveredAt: ev.occurredAt } : {}) })
      .where(eq(shipments.id, sh.id));
    return { matched: true as const, shipmentId: sh.id, sellerOrderId: sh.sellerOrderId, applied: true, duplicate: false, delivered: ev.status === 'delivered' };
  });
}
