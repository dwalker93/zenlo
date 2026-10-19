import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { createdAt, money, pk, tstz } from './_helpers';
import { payoutEntryType, payoutStatus } from './enums';
import { sellerPayoutAccounts, sellerProfiles, users } from './identity';
import { sellerOrders } from './orders';
import { refundAllocations } from './refunds';

// The ledger is the source of truth for what a seller is owed. Append-only:
// never UPDATE/DELETE rows; correct with adjustment entries.
// Credits positive (sale), debits negative (commission, refund).
// A refund entry (one per refund ALLOCATION) = -(item_amount - commission_returned);
// the delivery part never touches the seller ledger. An allocation whose entry
// would be 0 gets no entry. Sale + commission are posted once, when delivery
// is verified.
export const sellerLedgerEntries = pgTable(
  'seller_ledger_entries',
  {
    id: pk(),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => sellerProfiles.id),
    // The composite FKs below enforce the ownership rules (the single-column
    // links are implied by them).
    sellerOrderId: uuid('seller_order_id'),
    refundAllocationId: uuid('refund_allocation_id'),
    type: payoutEntryType('type').notNull(),
    amountCents: money('amount_cents').notNull(),
    description: text('description'),
    createdAt: createdAt(),
  },
  (t) => [
    index('ledger_seller_created_idx').on(t.sellerId, t.createdAt),
    index('ledger_seller_order_idx').on(t.sellerOrderId),
    // An allocation is posted at most once
    uniqueIndex('ledger_refund_allocation_uq').on(t.refundAllocationId),
    // Sale and commission are posted once per seller order
    uniqueIndex('ledger_once_per_seller_order_uq')
      .on(t.sellerOrderId, t.type)
      .where(sql`${t.type} IN ('sale', 'commission')`),
    // 1. the entry's seller must be the seller of its seller order
    foreignKey({
      name: 'ledger_seller_order_seller_fk',
      columns: [t.sellerOrderId, t.sellerId],
      foreignColumns: [sellerOrders.id, sellerOrders.sellerId],
    }),
    // 2. a refund entry's seller order must be its allocation's seller order
    foreignKey({
      name: 'ledger_allocation_seller_order_fk',
      columns: [t.refundAllocationId, t.sellerOrderId],
      foreignColumns: [refundAllocations.id, refundAllocations.sellerOrderId],
    }),
    // Target of payout_items' composite FK (an entry can only be paid to its own seller)
    unique('ledger_id_seller_uq').on(t.id, t.sellerId),
    check('ledger_amount_non_zero', sql`${t.amountCents} <> 0`),
    // Sale = credit, commission/refund = debit; adjustments may go either way.
    check(
      'ledger_amount_sign',
      sql`(${t.type} = 'sale' AND ${t.amountCents} > 0)
        OR (${t.type} IN ('commission', 'refund') AND ${t.amountCents} < 0)
        OR ${t.type} = 'adjustment'`,
    ),
    check(
      'ledger_seller_order_required',
      sql`${t.type} NOT IN ('sale', 'commission', 'refund') OR ${t.sellerOrderId} IS NOT NULL`,
    ),
    check(
      'ledger_refund_allocation_link',
      sql`(${t.type} = 'refund') = (${t.refundAllocationId} IS NOT NULL)`,
    ),
  ],
);

export const payouts = pgTable(
  'payouts',
  {
    id: pk(),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => sellerProfiles.id),
    payoutAccountId: uuid('payout_account_id').references(() => sellerPayoutAccounts.id),
    // Snapshot = SUM of its ledger entries; must be > 0
    amountCents: money('amount_cents').notNull(),
    status: payoutStatus('status').notNull().default('pending'),
    bankReference: varchar('bank_reference', { length: 120 }),
    failureReason: text('failure_reason'),
    paidAt: tstz('paid_at'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('payouts_seller_status_idx').on(t.sellerId, t.status),
    index('payouts_created_idx').on(t.createdAt),
    // Target of payout_items' composite FK
    unique('payouts_id_seller_uq').on(t.id, t.sellerId),
    check('payouts_amount_positive', sql`${t.amountCents} > 0`),
  ],
);

// A ledger entry is paid out whole, exactly once. released_at is set when a
// payout fails for good or is cancelled; the entry then becomes payable again.
export const payoutItems = pgTable(
  'payout_items',
  {
    payoutId: uuid('payout_id')
      .notNull()
      .references(() => payouts.id),
    ledgerEntryId: uuid('ledger_entry_id')
      .notNull()
      .references(() => sellerLedgerEntries.id),
    // Must be the seller of BOTH the payout and the entry (composite FKs below)
    sellerId: uuid('seller_id').notNull(),
    releasedAt: tstz('released_at'),
  },
  (t) => [
    primaryKey({ columns: [t.payoutId, t.ledgerEntryId] }),
    foreignKey({
      name: 'payout_items_payout_seller_fk',
      columns: [t.payoutId, t.sellerId],
      foreignColumns: [payouts.id, payouts.sellerId],
    }),
    foreignKey({
      name: 'payout_items_entry_seller_fk',
      columns: [t.ledgerEntryId, t.sellerId],
      foreignColumns: [sellerLedgerEntries.id, sellerLedgerEntries.sellerId],
    }),
    index('payout_items_ledger_entry_idx').on(t.ledgerEntryId),
    // An entry belongs to at most one LIVE payout; released rows stay as history
    uniqueIndex('payout_items_live_entry_uq')
      .on(t.ledgerEntryId)
      .where(sql`${t.releasedAt} IS NULL`),
  ],
);
