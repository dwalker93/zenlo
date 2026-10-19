import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  orderItems,
  orders,
  refundAllocations,
  refunds,
  sellerLedgerEntries,
  sellerOrders,
  shipments,
} from '@workspace/db/schema';
import { refundLedgerAmount } from '@workspace/db/money';
import { audit } from './audit';
import { DeliveryNotVerifiableError, SellerOrderNotFoundError, SellerOrderStateError } from './errors';
import { restockOnHand } from './stock';
import type { Db } from './types';

/**
 * orders.status derivation (refunds never change it):
 *   all seller orders cancelled                    -> cancelled
 *   none delivered                                 -> processing
 *   some delivered, some non-cancelled still open  -> partially_fulfilled
 *   every non-cancelled delivered, at least one    -> completed
 * Call inside a transaction that holds the order row lock.
 */
export async function recomputeOrderStatus(tx: Db, orderId: string) {
  const sos = await tx.select({ status: sellerOrders.status }).from(sellerOrders).where(eq(sellerOrders.orderId, orderId));
  const live = sos.filter((s) => s.status !== 'cancelled');
  const delivered = live.filter((s) => s.status === 'delivered');
  const next =
    live.length === 0 ? 'cancelled' : delivered.length === 0 ? 'processing' : delivered.length === live.length ? 'completed' : 'partially_fulfilled';
  // never touch an order that is still awaiting payment
  await tx.update(orders).set({ status: next }).where(and(eq(orders.id, orderId), sql`${orders.status} <> 'pending_payment'`));
  return next;
}

async function lockOrderThenSellerOrder(tx: Db, sellerOrderId: string) {
  // Same lock order as refunds: order row first, then the seller order.
  const [head] = await tx.select({ orderId: sellerOrders.orderId }).from(sellerOrders).where(eq(sellerOrders.id, sellerOrderId));
  if (!head) throw new SellerOrderNotFoundError(sellerOrderId);
  await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, head.orderId)).for('update');
  const [so] = await tx.select().from(sellerOrders).where(eq(sellerOrders.id, sellerOrderId)).for('update');
  return so;
}

/**
 * Delivery verified (admin/courier confirmation) -> seller order delivered, and in the SAME transaction:
 *   sale entry (+subtotal) and commission entry (-commission), each once;
 *   debits for refunds that already succeeded before delivery (see the ledger policy in refunds.ts);
 *   parent order status re-derived.
 * Idempotent: only the transaction that wins the guarded shipped -> delivered update posts anything.
 */
export async function verifyDelivery(db: Db, sellerOrderId: string, opts: { verifiedBy?: string | null; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const so = await lockOrderThenSellerOrder(tx, sellerOrderId);
    if (so.status === 'delivered') return { alreadyDelivered: true as const };
    if (so.status !== 'shipped') throw new SellerOrderStateError(sellerOrderId, 'shipped', so.status);

    const parcels = (await tx.select().from(shipments).where(eq(shipments.sellerOrderId, sellerOrderId))).filter(
      (p) => p.status !== 'cancelled',
    );
    if (parcels.length === 0) throw new DeliveryNotVerifiableError(sellerOrderId, 'no shipments');
    if (parcels.some((p) => p.status !== 'delivered')) throw new DeliveryNotVerifiableError(sellerOrderId, 'not every shipment is delivered');
    await tx
      .update(shipments)
      .set({ deliveryVerifiedAt: now, verifiedBy: opts.verifiedBy ?? null })
      .where(and(eq(shipments.sellerOrderId, sellerOrderId), isNull(shipments.deliveryVerifiedAt), eq(shipments.status, 'delivered')));

    const won = await tx
      .update(sellerOrders)
      .set({ status: 'delivered', deliveredAt: now })
      .where(and(eq(sellerOrders.id, sellerOrderId), eq(sellerOrders.status, 'shipped')))
      .returning({ id: sellerOrders.id });
    if (won.length !== 1) throw new SellerOrderStateError(sellerOrderId, 'shipped', 'changed concurrently');

    if (so.subtotalCents > 0) {
      await tx.insert(sellerLedgerEntries).values({
        sellerId: so.sellerId, sellerOrderId: so.id, type: 'sale', amountCents: so.subtotalCents, description: 'Sale',
      });
    }
    if (so.commissionCents > 0) {
      await tx.insert(sellerLedgerEntries).values({
        sellerId: so.sellerId, sellerOrderId: so.id, type: 'commission', amountCents: -so.commissionCents, description: 'Commission',
      });
    }

    // catch-up: refunds that succeeded before delivery had no sale to reverse yet
    const pending = await tx
      .select({ a: refundAllocations })
      .from(refundAllocations)
      .innerJoin(refunds, eq(refunds.id, refundAllocations.refundId))
      .where(and(eq(refundAllocations.sellerOrderId, sellerOrderId), eq(refunds.status, 'succeeded')))
      .orderBy(asc(refundAllocations.id));
    for (const { a } of pending) {
      const amount = refundLedgerAmount(a.itemAmountCents, a.commissionReturnedCents);
      if (amount === 0) continue;
      await tx.insert(sellerLedgerEntries).values({
        sellerId: so.sellerId, sellerOrderId: so.id, refundAllocationId: a.id, type: 'refund', amountCents: amount, description: `Refund ${a.refundId}`,
      });
    }

    const orderStatus = await recomputeOrderStatus(tx, so.orderId);
    await audit(tx, { actorId: opts.verifiedBy, action: 'seller_order.delivery_verified', entityType: 'seller_order', entityId: so.id, metadata: { orderStatus } });
    return { alreadyDelivered: false as const, orderStatus };
  });
}

/**
 * Cancel a PAID seller order that has not shipped. Guarded processing -> cancelled; the winner puts the
 * stock back on the shelf and re-derives the order status. No ledger entries exist for it (it was never
 * delivered), so nothing is posted. Any money to give back is a separate refund.
 */
export async function cancelSellerOrder(db: Db, sellerOrderId: string, opts: { cancelledBy?: string | null } = {}) {
  return db.transaction(async (tx) => {
    const so = await lockOrderThenSellerOrder(tx, sellerOrderId);
    if (so.status === 'cancelled') return { alreadyCancelled: true as const };
    const won = await tx
      .update(sellerOrders)
      .set({ status: 'cancelled' })
      .where(and(eq(sellerOrders.id, sellerOrderId), eq(sellerOrders.status, 'processing')))
      .returning({ id: sellerOrders.id });
    if (won.length !== 1) throw new SellerOrderStateError(sellerOrderId, 'processing', so.status);

    const items = await tx
      .select({ variantId: orderItems.variantId, locationId: orderItems.locationId, quantity: orderItems.quantity })
      .from(orderItems)
      .where(eq(orderItems.sellerOrderId, sellerOrderId));
    await restockOnHand(tx, items.map((i) => ({ ...i, sellerOrderId })));
    const orderStatus = await recomputeOrderStatus(tx, so.orderId);
    await audit(tx, { actorId: opts.cancelledBy, action: 'seller_order.cancelled', entityType: 'seller_order', entityId: so.id, metadata: { orderStatus } });
    return { alreadyCancelled: false as const, orderStatus };
  });
}
