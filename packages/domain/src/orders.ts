import { and, asc, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import { orderItems, orders, payments, sellerOrders } from '@workspace/db/schema';
import { releaseReserved } from './stock';
import type { Db } from './types';

/**
 * Cancel an order that is still awaiting payment and give its reserved stock back.
 *
 * Idempotent: only the transaction whose guarded UPDATE returns a row releases
 * stock. A repeated job, a double click, or a race with payment confirmation
 * (which uses the same guard on the same row) can never release it twice.
 */
export async function cancelUnpaidOrder(db: Db, orderId: string): Promise<{ cancelled: boolean }> {
  return db.transaction(async (tx) => {
    const won = await tx
      .update(orders)
      .set({ status: 'cancelled' })
      .where(and(eq(orders.id, orderId), eq(orders.status, 'pending_payment')))
      .returning({ id: orders.id });
    if (won.length === 0) return { cancelled: false };

    const sos = await tx
      .update(sellerOrders)
      .set({ status: 'cancelled' })
      .where(and(eq(sellerOrders.orderId, orderId), eq(sellerOrders.status, 'pending')))
      .returning({ id: sellerOrders.id });
    await tx
      .update(payments)
      .set({ status: 'cancelled' })
      .where(and(eq(payments.orderId, orderId), inArray(payments.status, ['pending', 'processing'])));

    const items = await tx
      .select({ variantId: orderItems.variantId, locationId: orderItems.locationId, quantity: orderItems.quantity })
      .from(orderItems)
      .where(inArray(orderItems.sellerOrderId, sos.map((s) => s.id)));
    await releaseReserved(tx, items);
    return { cancelled: true };
  });
}

/** Cancel every unpaid order whose payment window has passed. Safe to run concurrently / repeatedly. */
export async function expireOverdueOrders(db: Db, opts: { now?: Date; limit?: number } = {}) {
  const now = opts.now ?? new Date();
  const due = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.status, 'pending_payment'), isNotNull(orders.paymentDueAt), lte(orders.paymentDueAt, now)))
    .orderBy(asc(orders.paymentDueAt))
    .limit(opts.limit ?? 100);
  let cancelled = 0;
  for (const { id } of due) {
    if ((await cancelUnpaidOrder(db, id)).cancelled) cancelled++;
  }
  return { cancelled, scanned: due.length };
}
