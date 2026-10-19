import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { auditLogs, orders, payments, refundAllocations, refunds, sellerLedgerEntries, sellerOrders } from '@workspace/db/schema';
import { REFUND_HOLDING_STATUSES } from '@workspace/db/schema';
import { commissionReturnedForAllocation, refundLedgerAmount } from '@workspace/db/money';
import { audit } from './audit';
import {
  InvalidRefundError,
  SeparationOfDutiesError,
  RefundCapacityExceededError,
  RefundNotFoundError,
  RefundPaymentError,
  RefundStateError,
} from './errors';
import type { Db } from './types';

/**
 * Refund lifecycle (see the ERD rules block):
 *   requestRefund -> approveRefund (A: reserve capacity) -> startRefundProcessing (B: guarded,
 *   then the caller sends ONE external refund keyed by the refund id) -> completeRefund (C)
 *   or failRefund (D, only when the gateway/bank confirms no money moved).
 *
 * Lock order for A and C: order row, then ALL affected seller orders in one statement ordered by id.
 * No DB transaction is ever held across the external call.
 */

export interface RefundLine {
  sellerOrderId: string;
  itemAmountCents: number;
  deliveryAmountCents: number;
}
export interface RequestRefundInput {
  orderId: string;
  lines: RefundLine[];
  reason?: string | null;
  processedBy?: string | null;
  /** Who is asking for the refund (recorded in the audit log; used by the two-person rule at approval). */
  requestedBy?: string | null;
}

const isMoney = (n: number) => Number.isSafeInteger(n) && n >= 0;
function safeAdd(a: number, b: number, what: string): number {
  const r = a + b;
  if (!Number.isSafeInteger(r)) throw new InvalidRefundError(`${what} is too large`);
  return r;
}
/** Numbers read back from SQL sums must also be safe integers. */
function safeNum(v: string | number, what: string): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new InvalidRefundError(`${what} is too large`);
  return n;
}
type Tx = Db;

async function lockOrderAndSellerOrders(tx: Tx, orderId: string, sellerOrderIds: string[]) {
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
  if (!order) throw new InvalidRefundError('order not found', { orderId });
  const ids = [...new Set(sellerOrderIds)];
  const sos = ids.length
    ? await tx.select().from(sellerOrders).where(inArray(sellerOrders.id, ids)).orderBy(asc(sellerOrders.id)).for('update')
    : [];
  return { order, sos: new Map(sos.map((s) => [s.id, s])) };
}

/** Create a refund in `requested` (holds no capacity). Header amount = sum of its allocations. */
export async function requestRefund(db: Db, input: RequestRefundInput): Promise<{ refundId: string }> {
  if (input.lines.length === 0) throw new InvalidRefundError('refund has no lines');
  const seen = new Set<string>();
  let amount = 0;
  for (const l of input.lines) {
    if (seen.has(l.sellerOrderId)) throw new InvalidRefundError('one line per seller order', { sellerOrderId: l.sellerOrderId });
    seen.add(l.sellerOrderId);
    if (!isMoney(l.itemAmountCents) || !isMoney(l.deliveryAmountCents)) throw new InvalidRefundError('amounts must be non-negative integers');
    const lineTotal = safeAdd(l.itemAmountCents, l.deliveryAmountCents, 'line total');
    if (lineTotal <= 0) throw new InvalidRefundError('each line must refund something', { sellerOrderId: l.sellerOrderId });
    amount = safeAdd(amount, lineTotal, 'refund total');
  }
  return db.transaction(async (tx) => {
    const sos = await tx.select({ id: sellerOrders.id }).from(sellerOrders).where(eq(sellerOrders.orderId, input.orderId));
    const own = new Set(sos.map((s) => s.id));
    for (const l of input.lines) {
      if (!own.has(l.sellerOrderId)) throw new InvalidRefundError('seller order does not belong to this order', { sellerOrderId: l.sellerOrderId });
    }
    const [pay] = await tx
      .select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.orderId, input.orderId), eq(payments.status, 'succeeded')));
    if (!pay) throw new InvalidRefundError('order has no succeeded payment to refund', { orderId: input.orderId });
    const [r] = await tx
      .insert(refunds)
      .values({ orderId: input.orderId, paymentId: pay.id, amountCents: amount, reason: input.reason ?? null, processedBy: input.processedBy ?? null })
      .returning({ id: refunds.id });
    await tx.insert(refundAllocations).values(
      input.lines.map((l) => ({
        refundId: r.id,
        orderId: input.orderId,
        sellerOrderId: l.sellerOrderId,
        itemAmountCents: l.itemAmountCents,
        deliveryAmountCents: l.deliveryAmountCents,
        amountCents: l.itemAmountCents + l.deliveryAmountCents,
      })),
    );
    await audit(tx, { actorId: input.requestedBy ?? input.processedBy, action: 'refund.requested', entityType: 'refund', entityId: r.id, metadata: { amountCents: amount, orderId: input.orderId } });
    return { refundId: r.id };
  });
}

/** Step A. Reserve capacity under the locks, then requested -> approved (guarded). */
export async function approveRefund(
  db: Db,
  refundId: string,
  opts: {
    approvedBy?: string | null;
    /**
     * Two-person rule: a refund of at least this many cents cannot be approved by the person who requested it.
     * 0 = always two people. Omit to disable. When set, `approvedBy` is required.
     */
    dualControlThresholdCents?: number;
  } = {},
) {
  return db.transaction(async (tx) => {
    const [head] = await tx.select().from(refunds).where(eq(refunds.id, refundId));
    if (!head) throw new RefundNotFoundError(refundId);
    const allocs = await tx.select().from(refundAllocations).where(eq(refundAllocations.refundId, refundId));
    const { order, sos } = await lockOrderAndSellerOrders(tx, head.orderId, allocs.map((a) => a.sellerOrderId));

    // re-read the status under the lock: another transaction may have moved it
    const [cur] = await tx.select({ status: refunds.status }).from(refunds).where(eq(refunds.id, refundId));
    if (cur.status !== 'requested') throw new RefundStateError(refundId, 'requested', cur.status);

    if (opts.dualControlThresholdCents !== undefined && head.amountCents >= opts.dualControlThresholdCents) {
      if (!opts.approvedBy) throw new SeparationOfDutiesError('the approver must be identified for a refund of this size');
      const [req] = await tx
        .select({ actorId: auditLogs.actorId })
        .from(auditLogs)
        .where(and(eq(auditLogs.action, 'refund.requested'), eq(auditLogs.entityId, refundId)))
        .limit(1);
      if (req?.actorId && req.actorId === opts.approvedBy) {
        throw new SeparationOfDutiesError('a refund of this size must be approved by someone other than the person who requested it', { refundId });
      }
    }

    // payment must be the order's succeeded payment and match the order's amount/currency
    const [pay] = await tx.select().from(payments).where(eq(payments.id, head.paymentId));
    if (!pay || pay.orderId !== order.id || pay.status !== 'succeeded') throw new RefundPaymentError(refundId, 'payment is not the order\'s succeeded payment');
    if (pay.amountCents !== order.totalCents || pay.currency !== order.currency) throw new RefundPaymentError(refundId, 'payment amount/currency differ from the order');

    const sum = allocs.reduce((t, a) => safeAdd(t, a.amountCents, 'sum of allocations'), 0);
    if (sum !== head.amountCents) throw new InvalidRefundError('refund amount differs from the sum of its allocations', { refundId });

    // holding refunds (other than this one): order total and per-seller-order item/delivery
    const holding = [...REFUND_HOLDING_STATUSES];
    const [orderHeld] = await tx
      .select({ held: sql<string>`coalesce(sum(${refunds.amountCents}), 0)` })
      .from(refunds)
      .where(and(eq(refunds.orderId, order.id), inArray(refunds.status, holding), ne(refunds.id, refundId)));
    const heldTotal = safeNum(orderHeld.held, 'held refund total');
    if (safeAdd(heldTotal, head.amountCents, 'refund total') > order.totalCents) {
      throw new RefundCapacityExceededError('refund exceeds what is left of the order total', { refundId, held: heldTotal, total: order.totalCents });
    }
    const heldRows = await tx
      .select({
        sellerOrderId: refundAllocations.sellerOrderId,
        item: sql<string>`coalesce(sum(${refundAllocations.itemAmountCents}), 0)`,
        delivery: sql<string>`coalesce(sum(${refundAllocations.deliveryAmountCents}), 0)`,
      })
      .from(refundAllocations)
      .innerJoin(refunds, eq(refunds.id, refundAllocations.refundId))
      .where(and(inArray(refundAllocations.sellerOrderId, allocs.map((a) => a.sellerOrderId)), inArray(refunds.status, holding), ne(refunds.id, refundId)))
      .groupBy(refundAllocations.sellerOrderId);
    const held = new Map(heldRows.map((h) => [h.sellerOrderId, { item: safeNum(h.item, 'held item total'), delivery: safeNum(h.delivery, 'held delivery total') }]));
    for (const a of allocs) {
      const so = sos.get(a.sellerOrderId)!;
      const h = held.get(a.sellerOrderId) ?? { item: 0, delivery: 0 };
      if (safeAdd(h.item, a.itemAmountCents, 'item total') > so.subtotalCents) {
        throw new RefundCapacityExceededError('item refund exceeds what is left of the seller order subtotal', { sellerOrderId: so.id });
      }
      if (safeAdd(h.delivery, a.deliveryAmountCents, 'delivery total') > so.deliveryFeeCents) {
        throw new RefundCapacityExceededError('delivery refund exceeds what is left of the seller order delivery fee', { sellerOrderId: so.id });
      }
    }

    const won = await tx
      .update(refunds)
      .set({ status: 'approved', processedBy: opts.approvedBy ?? head.processedBy })
      .where(and(eq(refunds.id, refundId), eq(refunds.status, 'requested')))
      .returning({ id: refunds.id });
    if (won.length !== 1) throw new RefundStateError(refundId, 'requested', 'changed concurrently');
    await audit(tx, { actorId: opts.approvedBy, action: 'refund.approved', entityType: 'refund', entityId: refundId, metadata: { amountCents: head.amountCents } });
    return { refundId, amountCents: head.amountCents };
  });
}

/** Create and reserve in one step (admin-initiated refund). */
export async function reserveRefund(db: Db, input: RequestRefundInput & { approvedBy?: string | null }) {
  const { refundId } = await requestRefund(db, input);
  try {
    return await approveRefund(db, refundId, { approvedBy: input.approvedBy });
  } catch (e) {
    await db.update(refunds).set({ status: 'rejected' }).where(and(eq(refunds.id, refundId), eq(refunds.status, 'requested')));
    throw e;
  }
}

/**
 * Step B. Guarded approved -> processing. Only when `started` is true may the caller send
 * ONE external refund for `amountCents`, using `refundId` as the idempotency key.
 * `started: false` with status 'processing' means a previous attempt may already have sent it:
 * go to reconciliation, never resend with a different key.
 */
export async function startRefundProcessing(db: Db, refundId: string) {
  const won = await db
    .update(refunds)
    .set({ status: 'processing' })
    .where(and(eq(refunds.id, refundId), eq(refunds.status, 'approved')))
    .returning({ id: refunds.id, amountCents: refunds.amountCents, paymentId: refunds.paymentId });
  if (won.length === 1) return { started: true as const, ...won[0] };
  const [r] = await db.select({ status: refunds.status }).from(refunds).where(eq(refunds.id, refundId));
  if (!r) throw new RefundNotFoundError(refundId);
  return { started: false as const, status: r.status };
}

export interface CompleteRefundInput {
  providerReference?: string | null;
  processedBy?: string | null;
  now?: Date;
}

/** Step C. Money moved. Guarded processing -> succeeded, then commission, caches and ledger, atomically. */
export async function completeRefund(db: Db, refundId: string, input: CompleteRefundInput = {}) {
  return db.transaction(async (tx) => {
    const [head] = await tx.select().from(refunds).where(eq(refunds.id, refundId));
    if (!head) throw new RefundNotFoundError(refundId);
    const allocs = await tx.select().from(refundAllocations).where(eq(refundAllocations.refundId, refundId)).orderBy(asc(refundAllocations.sellerOrderId));
    const { sos } = await lockOrderAndSellerOrders(tx, head.orderId, allocs.map((a) => a.sellerOrderId));

    const won = await tx
      .update(refunds)
      .set({
        status: 'succeeded',
        processedAt: input.now ?? new Date(),
        ...(input.providerReference != null ? { providerReference: input.providerReference } : {}),
        ...(input.processedBy != null ? { processedBy: input.processedBy } : {}),
      })
      .where(and(eq(refunds.id, refundId), eq(refunds.status, 'processing')))
      .returning({ id: refunds.id });
    if (won.length === 0) {
      const [r] = await tx.select({ status: refunds.status }).from(refunds).where(eq(refunds.id, refundId));
      if (r.status === 'succeeded') return { alreadyCompleted: true as const };
      throw new RefundStateError(refundId, 'processing', r.status);
    }

    // earlier SUCCEEDED allocations only (never reservations): no drift from failed refunds
    const priorRows = await tx
      .select({
        sellerOrderId: refundAllocations.sellerOrderId,
        item: sql<string>`coalesce(sum(${refundAllocations.itemAmountCents}), 0)`,
        commission: sql<string>`coalesce(sum(${refundAllocations.commissionReturnedCents}), 0)`,
      })
      .from(refundAllocations)
      .innerJoin(refunds, eq(refunds.id, refundAllocations.refundId))
      .where(and(inArray(refundAllocations.sellerOrderId, allocs.map((a) => a.sellerOrderId)), eq(refunds.status, 'succeeded'), ne(refunds.id, refundId)))
      .groupBy(refundAllocations.sellerOrderId);
    const prior = new Map(priorRows.map((p) => [p.sellerOrderId, { item: safeNum(p.item, 'prior item total'), commission: safeNum(p.commission, 'prior commission total') }]));

    for (const a of allocs) {
      const so = sos.get(a.sellerOrderId)!;
      const p = prior.get(a.sellerOrderId) ?? { item: 0, commission: 0 };
      const commissionReturned = commissionReturnedForAllocation({
        priorItemRefunded: p.item,
        priorCommissionReturned: p.commission,
        itemAmount: a.itemAmountCents,
        commissionCents: so.commissionCents,
        subtotalCents: so.subtotalCents,
      });
      await tx.update(refundAllocations).set({ commissionReturnedCents: commissionReturned }).where(eq(refundAllocations.id, a.id));
      await tx
        .update(sellerOrders)
        .set({ refundedCents: sql`${sellerOrders.refundedCents} + ${a.amountCents}` })
        .where(eq(sellerOrders.id, a.sellerOrderId));
      // LEDGER POLICY: a refund debit reverses a sale credit, so it is posted only once the
      // seller order is delivered (sale + commission entries exist). Before that nothing is posted;
      // verifyDelivery posts the debits of already-succeeded refunds in the same transaction as the
      // sale entry. A seller order that is cancelled and never delivered never touches the ledger.
      // `so` was read under the seller-order lock, so its status cannot change under us.
      const ledger = refundLedgerAmount(a.itemAmountCents, commissionReturned);
      if (ledger !== 0 && so.status === 'delivered') {
        await tx.insert(sellerLedgerEntries).values({
          sellerId: so.sellerId,
          sellerOrderId: so.id,
          refundAllocationId: a.id,
          type: 'refund',
          amountCents: ledger,
          description: `Refund ${refundId}`,
        });
      }
    }
    await tx.update(orders).set({ refundedCents: sql`${orders.refundedCents} + ${head.amountCents}` }).where(eq(orders.id, head.orderId));
    return { alreadyCompleted: false as const };
  });
}

/** Step D. ONLY when the gateway/bank confirms no money moved. Frees the capacity of every allocation. */
export async function failRefund(db: Db, refundId: string) {
  const won = await db
    .update(refunds)
    .set({ status: 'failed' })
    .where(and(eq(refunds.id, refundId), eq(refunds.status, 'processing')))
    .returning({ id: refunds.id });
  if (won.length === 1) return { alreadyFailed: false as const };
  const [r] = await db.select({ status: refunds.status }).from(refunds).where(eq(refunds.id, refundId));
  if (!r) throw new RefundNotFoundError(refundId);
  if (r.status === 'failed') return { alreadyFailed: true as const };
  throw new RefundStateError(refundId, 'processing', r.status);
}

/** Drop a refund that was never sent (requested or approved only). Frees reserved capacity. */
export async function rejectRefund(db: Db, refundId: string) {
  const won = await db
    .update(refunds)
    .set({ status: 'rejected' })
    .where(and(eq(refunds.id, refundId), inArray(refunds.status, ['requested', 'approved'])))
    .returning({ id: refunds.id });
  if (won.length === 1) return { alreadyRejected: false as const };
  const [r] = await db.select({ status: refunds.status }).from(refunds).where(eq(refunds.id, refundId));
  if (!r) throw new RefundNotFoundError(refundId);
  if (r.status === 'rejected') return { alreadyRejected: true as const };
  throw new RefundStateError(refundId, 'requested|approved', r.status);
}
