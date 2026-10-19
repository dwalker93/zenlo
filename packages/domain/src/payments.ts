import { and, eq, inArray, sql } from 'drizzle-orm';
import { orderItems, orders, payments, sellerOrders } from '@workspace/db/schema';
import {
  OpenPaymentExistsError,
  OrderAlreadyPaidError,
  OrderNotAwaitingPaymentError,
  PaymentAmountMismatchError,
  PaymentNotFoundError,
  PaymentNotPayableError,
} from './errors';
import { consumeReserved } from './stock';
import type { Db } from './types';

export interface ConfirmPaymentInput {
  paymentId: string;
  confirmedBy?: string | null; // admin who verified a bank transfer
  providerReference?: string | null;
  gatewayPayload?: Record<string, unknown> | null;
  now?: Date;
}

function constraintOf(e: unknown): string {
  const c = (e as any)?.cause ?? e;
  return String(c?.constraint ?? c?.constraint_name ?? '');
}

/**
 * Mark a payment succeeded, move the order to processing and turn its stock
 * reservations into sales — all in one transaction.
 *
 *  - amount and currency must equal the order's (checked inside the guarded UPDATE)
 *  - guarded: payments pending|processing -> succeeded, orders pending_payment -> processing
 *  - a duplicate callback finds the payment already succeeded and does nothing
 *  - if the order was cancelled/expired meanwhile, the payment update rolls back and
 *    OrderNotAwaitingPaymentError is raised so a human can refund/handle the money
 */
export async function confirmPayment(db: Db, input: ConfirmPaymentInput): Promise<{ alreadyConfirmed: boolean; orderId: string }> {
  const now = input.now ?? new Date();
  try {
    return await db.transaction(async (tx) => {
      // Lock the order row FIRST. cancelUnpaidOrder also starts by updating the
      // order row, so the two always take locks in the same order (order, then
      // payment, then inventory) and can neither deadlock nor interleave.
      await tx.execute(
        sql`SELECT id FROM ${orders} WHERE id = (SELECT order_id FROM ${payments} WHERE id = ${input.paymentId}) FOR UPDATE`,
      );
      const won = await tx
        .update(payments)
        .set({
          status: 'succeeded',
          confirmedAt: now,
          confirmedBy: input.confirmedBy ?? null,
          ...(input.providerReference != null ? { providerReference: input.providerReference } : {}),
          ...(input.gatewayPayload != null ? { gatewayPayload: input.gatewayPayload } : {}),
        })
        .where(
          and(
            eq(payments.id, input.paymentId),
            inArray(payments.status, ['pending', 'processing']),
            sql`EXISTS (SELECT 1 FROM ${orders} o WHERE o.id = ${payments.orderId}
                         AND o.total_cents = ${payments.amountCents} AND o.currency = ${payments.currency})`,
          ),
        )
        .returning({ orderId: payments.orderId });

      if (won.length === 0) {
        const [p] = await tx.select().from(payments).where(eq(payments.id, input.paymentId));
        if (!p) throw new PaymentNotFoundError(input.paymentId);
        if (p.status === 'succeeded') return { alreadyConfirmed: true, orderId: p.orderId };
        if (p.status === 'pending' || p.status === 'processing') throw new PaymentAmountMismatchError(p.id);
        throw new PaymentNotPayableError(p.id, p.status);
      }
      const orderId = won[0].orderId;

      const advanced = await tx
        .update(orders)
        .set({ status: 'processing' })
        .where(and(eq(orders.id, orderId), eq(orders.status, 'pending_payment')))
        .returning({ id: orders.id });
      if (advanced.length === 0) throw new OrderNotAwaitingPaymentError(orderId);

      const sos = await tx
        .update(sellerOrders)
        .set({ status: 'processing' })
        .where(and(eq(sellerOrders.orderId, orderId), eq(sellerOrders.status, 'pending')))
        .returning({ id: sellerOrders.id });

      const items = await tx
        .select({
          sellerOrderId: orderItems.sellerOrderId,
          variantId: orderItems.variantId,
          locationId: orderItems.locationId,
          quantity: orderItems.quantity,
        })
        .from(orderItems)
        .where(inArray(orderItems.sellerOrderId, sos.map((s) => s.id)));
      await consumeReserved(tx, items);
      return { alreadyConfirmed: false, orderId };
    });
  } catch (e) {
    if (constraintOf(e) === 'payments_one_succeeded_per_order_uq') {
      const [p] = await db.select({ orderId: payments.orderId }).from(payments).where(eq(payments.id, input.paymentId));
      throw new OrderAlreadyPaidError(p?.orderId ?? '');
    }
    throw e;
  }
}

/** The payment attempt failed or was cancelled at the gateway. Guarded; a succeeded payment is never touched. */
export async function markPaymentFailed(db: Db, paymentId: string, gatewayPayload?: Record<string, unknown> | null) {
  const won = await db
    .update(payments)
    .set({ status: 'failed', ...(gatewayPayload ? { gatewayPayload } : {}) })
    .where(and(eq(payments.id, paymentId), inArray(payments.status, ['pending', 'processing'])))
    .returning({ id: payments.id });
  return { changed: won.length === 1 };
}

/**
 * The gateway/bank reports that an attempt did not succeed. Guarded pending|processing -> failed|cancelled.
 * Never touches an already-succeeded payment or the order (the order simply stays awaiting payment until it
 * is paid by another attempt or expires).
 */
export async function recordPaymentFailure(db: Db, paymentId: string, outcome: 'failed' | 'cancelled') {
  const won = await db
    .update(payments)
    .set({ status: outcome })
    .where(and(eq(payments.id, paymentId), inArray(payments.status, ['pending', 'processing'])))
    .returning({ id: payments.id });
  if (won.length === 1) return { changed: true as const };
  const [p] = await db.select({ status: payments.status }).from(payments).where(eq(payments.id, paymentId));
  if (!p) throw new PaymentNotFoundError(paymentId);
  return { changed: false as const, status: p.status };
}

/** A new payment attempt (e.g. after a failed card payment). Only while the order still awaits payment and has no open attempt. */
export async function createPaymentAttempt(db: Db, orderId: string, method: 'bank_transfer' | 'payhere', now = new Date()) {
  return db.transaction(async (tx) => {
    const [o] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
    if (!o || o.status !== 'pending_payment' || (o.paymentDueAt && o.paymentDueAt.getTime() <= now.getTime())) {
      throw new OrderNotAwaitingPaymentError(orderId);
    }
    const open = await tx
      .select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.orderId, orderId), inArray(payments.status, ['pending', 'processing'])))
      .limit(1);
    if (open.length > 0) throw new OpenPaymentExistsError(orderId);
    const [p] = await tx
      .insert(payments)
      .values({ orderId, method, amountCents: o.totalCents, currency: o.currency })
      .returning({ id: payments.id });
    return { paymentId: p.id };
  });
}
