import { sql } from "drizzle-orm"
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
  unique,
} from "drizzle-orm/pg-core"

import { createdAt, money, pk, tstz, updatedAt } from "./_helpers"
import { refundStatus } from "./enums"
import { users } from "./identity"
import { orders, sellerOrders } from "./orders"
import { payments } from "./payments"

// A refund = ONE money movement to the buyer against the order's succeeded
// payment (one gateway call, or one manual bank transfer) with ONE status.
// refund_allocations split it across seller orders for accounting.
// Whole-order refund = one header + N allocations.
export const refunds = pgTable(
  "refunds",
  {
    id: pk(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    // Must be the order's succeeded payment (checked in code)
    paymentId: uuid("payment_id").notNull(),
    // Amount sent to the buyer = SUM of its allocations (checked in the reserve
    // transaction and by reconciliation)
    amountCents: money("amount_cents").notNull(),
    reason: text("reason"),
    status: refundStatus("status").notNull().default("requested"),
    // Gateway refund id or bank transfer reference; shared by all allocations
    providerReference: varchar("provider_reference", { length: 120 }),
    processedBy: uuid("processed_by").references(() => users.id),
    processedAt: tstz("processed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("refunds_order_status_idx").on(t.orderId, t.status),
    // Target of the refund_allocations composite FK (UNIQUE constraint: see inventory.ts)
    unique("refunds_id_order_uq").on(t.id, t.orderId),
    index("refunds_payment_idx").on(t.paymentId),
    index("refunds_payment_status_idx").on(t.paymentId, t.status),
    // The payment must belong to the SAME order as the refund
    foreignKey({
      name: "refunds_payment_order_fk",
      columns: [t.paymentId, t.orderId],
      foreignColumns: [payments.id, payments.orderId],
    }),
    check("refunds_amount_positive", sql`${t.amountCents} > 0`),
  ]
)

export const refundAllocations = pgTable(
  "refund_allocations",
  {
    id: pk(),
    refundId: uuid("refund_id").notNull(),
    orderId: uuid("order_id").notNull(),
    sellerOrderId: uuid("seller_order_id").notNull(),
    itemAmountCents: money("item_amount_cents").notNull().default(0), // merchandise: hits the seller ledger
    deliveryAmountCents: money("delivery_amount_cents").notNull().default(0), // platform cost, never the ledger
    amountCents: money("amount_cents").notNull(), // item + delivery
    // Set in the success transaction (0 before that); cumulative-rounding share
    commissionReturnedCents: money("commission_returned_cents")
      .notNull()
      .default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("refund_allocations_refund_seller_order_uq").on(
      t.refundId,
      t.sellerOrderId
    ),
    // Target of the seller_ledger_entries composite FK (UNIQUE constraint: see inventory.ts)
    unique("refund_allocations_id_seller_order_uq").on(t.id, t.sellerOrderId),
    index("refund_allocations_seller_order_idx").on(t.sellerOrderId),
    // The refund and the seller order must both belong to the SAME order
    foreignKey({
      name: "refund_allocations_refund_order_fk",
      columns: [t.refundId, t.orderId],
      foreignColumns: [refunds.id, refunds.orderId],
    }),
    foreignKey({
      name: "refund_allocations_seller_order_fk",
      columns: [t.sellerOrderId, t.orderId],
      foreignColumns: [sellerOrders.id, sellerOrders.orderId],
    }),
    check(
      "refund_allocations_parts_non_negative",
      sql`${t.itemAmountCents} >= 0 AND ${t.deliveryAmountCents} >= 0`
    ),
    check("refund_allocations_amount_positive", sql`${t.amountCents} > 0`),
    check(
      "refund_allocations_amount_matches",
      sql`${t.amountCents} = ${t.itemAmountCents} + ${t.deliveryAmountCents}`
    ),
    check(
      "refund_allocations_commission_returned_range",
      sql`${t.commissionReturnedCents} BETWEEN 0 AND ${t.itemAmountCents}`
    ),
  ]
)
