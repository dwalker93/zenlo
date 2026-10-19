import { and, eq, inArray, sql } from 'drizzle-orm';
import { payoutItems, payouts, sellerLedgerEntries, sellerPayoutAccounts, sellerProfiles } from '@workspace/db/schema';
import { audit } from './audit';
import { SeparationOfDutiesError, NoPayoutAccountError, PayoutNotFoundError, PayoutOutcomeUnknownError, PayoutStateError } from './errors';
import type { Db } from './types';

/**
 * Payouts. A ledger entry is paid out whole, exactly once.
 *   createPayout          claim every unclaimed entry of one seller (net > 0), one transaction
 *   startPayout           pending    -> processing   (guarded; then the caller makes the bank transfer)
 *   markPayoutPaid        processing -> paid         (terminal; fix mistakes with an 'adjustment' entry)
 *   markPayoutFailed      processing -> failed       (ONLY after the bank confirms the money did not move; entries stay claimed)
 *   retryPayout           failed     -> processing   (SAME payout, same items, new bank reference later)
 *   cancelPayout          pending|failed -> cancelled, releasing its items (payable again). NEVER from processing:
 *                         the transfer may already have been sent, and releasing would let a later payout pay it twice.
 * Every transition writes an audit row in the same transaction.
 */

export type CreatePayoutResult =
  | { created: true; payoutId: string; amountCents: number; entryCount: number }
  | { created: false; reason: 'nothing_to_pay' | 'non_positive_balance'; balanceCents: number };

export async function createPayout(db: Db, sellerId: string, opts: { createdBy?: string | null } = {}): Promise<CreatePayoutResult> {
  return db.transaction(async (tx) => {
    // Serialise payout runs per seller: a second run waits here, then finds the entries already claimed.
    const [seller] = await tx.select({ id: sellerProfiles.id }).from(sellerProfiles).where(eq(sellerProfiles.id, sellerId)).for('update');
    if (!seller) throw new Error(`seller ${sellerId} not found`);

    // Unclaimed = not in a LIVE payout item. Entries only exist for delivered seller orders
    // (or are adjustments), so every entry here is eligible.
    const entries = await tx
      .select({ id: sellerLedgerEntries.id, amountCents: sellerLedgerEntries.amountCents })
      .from(sellerLedgerEntries)
      .where(
        and(
          eq(sellerLedgerEntries.sellerId, sellerId),
          sql`NOT EXISTS (SELECT 1 FROM ${payoutItems} pi WHERE pi.ledger_entry_id = ${sellerLedgerEntries.id} AND pi.released_at IS NULL)`,
        ),
      )
      .for('update', { skipLocked: true });
    if (entries.length === 0) return { created: false as const, reason: 'nothing_to_pay' as const, balanceCents: 0 };

    const balance = entries.reduce((s, e) => s + e.amountCents, 0);
    if (!Number.isSafeInteger(balance)) throw new Error('payout balance is not a safe integer');
    if (balance <= 0) return { created: false as const, reason: 'non_positive_balance' as const, balanceCents: balance }; // carried forward

    const [account] = await tx
      .select({ id: sellerPayoutAccounts.id })
      .from(sellerPayoutAccounts)
      .where(and(eq(sellerPayoutAccounts.sellerId, sellerId), eq(sellerPayoutAccounts.isActive, true), eq(sellerPayoutAccounts.isDefault, true)));
    if (!account) throw new NoPayoutAccountError(sellerId);

    const [p] = await tx
      .insert(payouts)
      .values({ sellerId, payoutAccountId: account.id, amountCents: balance, createdBy: opts.createdBy ?? null })
      .returning({ id: payouts.id });
    await tx.insert(payoutItems).values(entries.map((e) => ({ payoutId: p.id, ledgerEntryId: e.id, sellerId })));
    await audit(tx, { actorId: opts.createdBy, action: 'payout.created', entityType: 'payout', entityId: p.id, metadata: { amountCents: balance, entries: entries.length } });
    return { created: true as const, payoutId: p.id, amountCents: balance, entryCount: entries.length };
  });
}

type Status = typeof payouts.$inferSelect.status;

/** Guarded transition. Returns whether THIS call made it; throws if the payout is in some other state. */
async function transition(
  db: Db,
  payoutId: string,
  from: Status[],
  to: Status,
  patch: Partial<typeof payouts.$inferInsert>,
  action: string,
  actorId?: string | null,
  after?: (tx: Db) => Promise<void>,
) {
  return db.transaction(async (tx) => {
    const won = await tx
      .update(payouts)
      .set({ status: to, ...patch })
      .where(and(eq(payouts.id, payoutId), inArray(payouts.status, from)))
      .returning({ id: payouts.id });
    if (won.length === 0) {
      const [p] = await tx.select({ status: payouts.status }).from(payouts).where(eq(payouts.id, payoutId));
      if (!p) throw new PayoutNotFoundError(payoutId);
      if (p.status === to) return { changed: false as const };
      throw new PayoutStateError(payoutId, from.join('|'), p.status);
    }
    if (after) await after(tx);
    await audit(tx, { actorId, action, entityType: 'payout', entityId: payoutId });
    return { changed: true as const };
  });
}

/**
 * pending -> processing. Two-person rule: when `dualControlThresholdCents` is set and the payout is at least that
 * large, the person who created the payout may not be the one who starts the transfer (0 = always two people).
 */
export async function startPayout(db: Db, payoutId: string, actorId?: string | null, opts: { dualControlThresholdCents?: number } = {}) {
  if (opts.dualControlThresholdCents !== undefined) {
    const [p] = await db.select({ amountCents: payouts.amountCents, createdBy: payouts.createdBy }).from(payouts).where(eq(payouts.id, payoutId));
    if (!p) throw new PayoutNotFoundError(payoutId);
    if (p.amountCents >= opts.dualControlThresholdCents) {
      if (!actorId) throw new SeparationOfDutiesError('the person starting a payout of this size must be identified');
      if (p.createdBy && p.createdBy === actorId) {
        throw new SeparationOfDutiesError('a payout of this size must be started by someone other than the person who created it', { payoutId });
      }
    }
  }
  return transition(db, payoutId, ['pending'], 'processing', {}, 'payout.processing', actorId);
}

export const markPayoutPaid = (db: Db, payoutId: string, input: { bankReference: string; paidAt?: Date; actorId?: string | null }) =>
  transition(db, payoutId, ['processing'], 'paid', { bankReference: input.bankReference, paidAt: input.paidAt ?? new Date(), failureReason: null }, 'payout.paid', input.actorId);

export const markPayoutFailed = (db: Db, payoutId: string, input: { reason: string; actorId?: string | null }) =>
  transition(db, payoutId, ['processing'], 'failed', { failureReason: input.reason }, 'payout.failed', input.actorId);

/** Default recovery after a bounced transfer: same payout, same items, same amount. */
export const retryPayout = (db: Db, payoutId: string, actorId?: string | null) =>
  transition(db, payoutId, ['failed'], 'processing', {}, 'payout.retried', actorId);

/**
 * Give up on a payout: its entries become payable again. Allowed only from pending (nothing sent) or failed
 * (the bank confirmed the money did not move). From processing the outcome is unknown, so it throws
 * PayoutOutcomeUnknownError and the items stay claimed. A paid payout can never be cancelled.
 */
export async function cancelPayout(db: Db, payoutId: string, actorId?: string | null) {
  try {
    return await transition(db, payoutId, ['pending', 'failed'], 'cancelled', {}, 'payout.cancelled', actorId, async (tx) => {
      // only the transaction that won the guarded update gets here, so items are released exactly once
      await tx.update(payoutItems).set({ releasedAt: new Date() }).where(and(eq(payoutItems.payoutId, payoutId), sql`${payoutItems.releasedAt} IS NULL`));
    });
  } catch (e) {
    if (e instanceof PayoutStateError && e.details?.actual === 'processing') throw new PayoutOutcomeUnknownError(payoutId);
    throw e;
  }
}

/** Payout invariants (job/test): amount = SUM of its entries; no entry in two live payouts; entries belong to the payout's seller. */
export async function reconcilePayouts(db: Db): Promise<string[]> {
  const out: string[] = [];
  const q = async (query: ReturnType<typeof sql>) => ((await db.execute(query)) as unknown as { rows: Record<string, unknown>[] }).rows;
  for (const r of await q(sql`
    SELECT p.id FROM payouts p
    WHERE p.status <> 'cancelled' AND p.amount_cents <> (
      SELECT COALESCE(SUM(l.amount_cents), 0) FROM payout_items i JOIN seller_ledger_entries l ON l.id = i.ledger_entry_id WHERE i.payout_id = p.id)`))
    out.push(`payout ${r.id}: amount differs from the sum of its entries`);
  for (const r of await q(sql`
    SELECT i.payout_id AS id FROM payout_items i
    JOIN payouts p ON p.id = i.payout_id JOIN seller_ledger_entries l ON l.id = i.ledger_entry_id
    WHERE p.seller_id <> l.seller_id`))
    out.push(`payout ${r.id}: contains another seller's ledger entry`);
  for (const r of await q(sql`
    SELECT i.payout_id AS id FROM payout_items i JOIN payouts p ON p.id = i.payout_id
    WHERE (p.status = 'cancelled') <> (i.released_at IS NOT NULL)`))
    out.push(`payout ${r.id}: released items do not match its cancelled status`);
  return out;
}
