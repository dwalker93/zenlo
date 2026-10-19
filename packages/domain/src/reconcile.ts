import { sql } from 'drizzle-orm';
import type { Db } from './types';

/**
 * Refund reconciliation (run as a scheduled job and in tests). Returns human-readable
 * violations; an empty array means every invariant holds.
 */
export async function reconcileRefunds(db: Db, opts: { stuckProcessingMinutes?: number } = {}): Promise<string[]> {
  const out: string[] = [];
  const q = async (query: ReturnType<typeof sql>) => ((await db.execute(query)) as unknown as { rows: Record<string, unknown>[] }).rows;

  for (const r of await q(sql`
    SELECT r.id FROM refunds r
    WHERE r.amount_cents <> (SELECT COALESCE(SUM(a.amount_cents), 0) FROM refund_allocations a WHERE a.refund_id = r.id)`))
    out.push(`refund ${r.id}: amount differs from the sum of its allocations`);

  for (const r of await q(sql`
    SELECT o.id FROM orders o
    WHERE o.refunded_cents <> (SELECT COALESCE(SUM(r.amount_cents), 0) FROM refunds r WHERE r.order_id = o.id AND r.status = 'succeeded')`))
    out.push(`order ${r.id}: refunded_cents differs from succeeded refunds`);

  for (const r of await q(sql`
    SELECT s.id FROM seller_orders s
    WHERE s.refunded_cents <> (
      SELECT COALESCE(SUM(a.amount_cents), 0) FROM refund_allocations a
      JOIN refunds r ON r.id = a.refund_id WHERE a.seller_order_id = s.id AND r.status = 'succeeded')`))
    out.push(`seller order ${r.id}: refunded_cents differs from succeeded allocations`);

  for (const r of await q(sql`
    SELECT s.id FROM seller_orders s
    WHERE (SELECT COALESCE(SUM(a.commission_returned_cents), 0) FROM refund_allocations a
           JOIN refunds r ON r.id = a.refund_id WHERE a.seller_order_id = s.id AND r.status = 'succeeded') > s.commission_cents`))
    out.push(`seller order ${r.id}: commission returned exceeds commission`);

  for (const r of await q(sql`
    SELECT s.id FROM seller_orders s
    WHERE s.subtotal_cents > 0
      AND (SELECT COALESCE(SUM(a.item_amount_cents), 0) FROM refund_allocations a
           JOIN refunds r ON r.id = a.refund_id WHERE a.seller_order_id = s.id AND r.status = 'succeeded') = s.subtotal_cents
      AND (SELECT COALESCE(SUM(a.commission_returned_cents), 0) FROM refund_allocations a
           JOIN refunds r ON r.id = a.refund_id WHERE a.seller_order_id = s.id AND r.status = 'succeeded') <> s.commission_cents`))
    out.push(`seller order ${r.id}: fully item-refunded but commission not fully returned`);

  for (const r of await q(sql`
    SELECT s.id FROM seller_orders s
    WHERE (SELECT COALESCE(SUM(a.item_amount_cents), 0) FROM refund_allocations a
           JOIN refunds r ON r.id = a.refund_id WHERE a.seller_order_id = s.id AND r.status IN ('approved','processing','succeeded')) > s.subtotal_cents
       OR (SELECT COALESCE(SUM(a.delivery_amount_cents), 0) FROM refund_allocations a
           JOIN refunds r ON r.id = a.refund_id WHERE a.seller_order_id = s.id AND r.status IN ('approved','processing','succeeded')) > s.delivery_fee_cents`))
    out.push(`seller order ${r.id}: holding refunds exceed item/delivery caps`);

  for (const r of await q(sql`
    SELECT o.id FROM orders o
    WHERE (SELECT COALESCE(SUM(r.amount_cents), 0) FROM refunds r WHERE r.order_id = o.id AND r.status IN ('approved','processing','succeeded')) > o.total_cents`))
    out.push(`order ${r.id}: holding refunds exceed the order total`);

  for (const r of await q(sql`
    SELECT a.id FROM refund_allocations a JOIN refunds r ON r.id = a.refund_id
    WHERE r.status = 'succeeded'
      AND NOT EXISTS (SELECT 1 FROM seller_ledger_entries l WHERE l.refund_allocation_id = a.id)
      AND a.item_amount_cents - a.commission_returned_cents <> 0
      AND EXISTS (SELECT 1 FROM seller_orders s WHERE s.id = a.seller_order_id AND s.status = 'delivered')`))
    out.push(`allocation ${r.id}: succeeded refund on a delivered seller order without its ledger entry`);

  for (const r of await q(sql`
    SELECT l.id FROM seller_ledger_entries l
    JOIN seller_orders s ON s.id = l.seller_order_id
    WHERE l.type IN ('sale','commission','refund') AND s.status <> 'delivered'`))
    out.push(`ledger entry ${r.id}: posted for a seller order that is not delivered`);

  for (const r of await q(sql`
    SELECT s.id FROM seller_orders s
    WHERE s.status = 'delivered' AND s.subtotal_cents > 0
      AND (SELECT COUNT(*) FROM seller_ledger_entries l WHERE l.seller_order_id = s.id AND l.type = 'sale') <> 1`))
    out.push(`seller order ${r.id}: delivered without exactly one sale entry`);

  const minutes = opts.stuckProcessingMinutes;
  if (minutes != null) {
    for (const r of await q(sql`SELECT id FROM refunds WHERE status = 'processing' AND updated_at < now() - make_interval(mins => ${minutes})`))
      out.push(`refund ${r.id}: stuck in processing (reconcile with the gateway/bank)`);
  }
  return out;
}
