import { sql } from "drizzle-orm"
import {
  char,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  uniqueIndex,
  uuid,
  varchar,
  unique,
} from "drizzle-orm/pg-core"

import { createdAt, money, pk, tstz, updatedAt } from "./_helpers"
import { orderStatus, sellerOrderStatus } from "./enums"
import { sellerProfiles, users } from "./identity"
import { inventory } from "./inventory"

// orders.status and seller_orders.status describe FULFILMENT only.
// Refund label is derived from refunded_cents (0 / < total / = total).
// Refundable amount = total_cents INCLUDING delivery.
export const orders = pgTable(
  "orders",
  {
    id: pk(),
    orderNumber: varchar("order_number", { length: 32 }).notNull().unique(),
    buyerId: uuid("buyer_id")
      .notNull()
      .references(() => users.id),
    status: orderStatus("status").notNull().default("pending_payment"),

    // Shipping address snapshot (never join to live addresses for past orders)
    shipFullName: varchar("ship_full_name", { length: 150 }).notNull(),
    shipPhone: varchar("ship_phone", { length: 32 }).notNull(),
    shipLine1: varchar("ship_line1", { length: 255 }).notNull(),
    shipLine2: varchar("ship_line2", { length: 255 }),
    shipCity: varchar("ship_city", { length: 100 }).notNull(),
    shipDistrict: varchar("ship_district", { length: 80 }).notNull(),
    shipPostalCode: varchar("ship_postal_code", { length: 16 }),
    shipLatitude: numeric("ship_latitude", { precision: 9, scale: 6 }),
    shipLongitude: numeric("ship_longitude", { precision: 9, scale: 6 }),

    // Financial snapshot
    subtotalCents: money("subtotal_cents").notNull(),
    deliveryFeeCents: money("delivery_fee_cents").notNull().default(0), // passed through to the courier
    totalCents: money("total_cents").notNull(), // subtotal + delivery fee
    refundedCents: money("refunded_cents").notNull().default(0), // cache of succeeded refunds
    currency: char("currency", { length: 3 }).notNull().default("LKR"),

    // Unpaid bank-transfer orders past this are cancelled and stock released
    paymentDueAt: tstz("payment_due_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("orders_buyer_created_idx").on(t.buyerId, t.createdAt),
    index("orders_status_due_idx").on(t.status, t.paymentDueAt),
    check(
      "orders_amounts_non_negative",
      sql`${t.subtotalCents} >= 0 AND ${t.deliveryFeeCents} >= 0`
    ),
    check(
      "orders_total_matches",
      sql`${t.totalCents} = ${t.subtotalCents} + ${t.deliveryFeeCents}`
    ),
    check(
      "orders_refunded_range",
      sql`${t.refundedCents} BETWEEN 0 AND ${t.totalCents}`
    ),
  ]
)

export const sellerOrders = pgTable(
  "seller_orders",
  {
    id: pk(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    sellerId: uuid("seller_id")
      .notNull()
      .references(() => sellerProfiles.id),
    sellerNameSnapshot: varchar("seller_name_snapshot", {
      length: 150,
    }).notNull(),
    status: sellerOrderStatus("status").notNull().default("pending"),

    subtotalCents: money("subtotal_cents").notNull(),
    deliveryFeeCents: money("delivery_fee_cents").notNull().default(0), // pass-through, not seller income
    commissionCents: money("commission_cents").notNull().default(0), // calculated on subtotal_cents
    sellerEarningCents: money("seller_earning_cents").notNull().default(0), // subtotal - commission (snapshot)
    refundedCents: money("refunded_cents").notNull().default(0),

    deliveredAt: tstz("delivered_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("seller_orders_order_seller_uq").on(t.orderId, t.sellerId),
    // Targets of the refund_allocations / seller_ledger_entries composite FKs
    // (UNIQUE constraints: see inventory.ts for why)
    unique("seller_orders_id_order_uq").on(t.id, t.orderId),
    unique("seller_orders_id_seller_uq").on(t.id, t.sellerId),
    index("seller_orders_seller_status_idx").on(t.sellerId, t.status),
    index("seller_orders_order_idx").on(t.orderId),
    check(
      "seller_orders_amounts_non_negative",
      sql`${t.subtotalCents} >= 0 AND ${t.deliveryFeeCents} >= 0`
    ),
    check(
      "seller_orders_commission_range",
      sql`${t.commissionCents} BETWEEN 0 AND ${t.subtotalCents}`
    ),
    check(
      "seller_orders_earning_matches",
      sql`${t.sellerEarningCents} = ${t.subtotalCents} - ${t.commissionCents}`
    ),
    check(
      "seller_orders_refunded_range",
      sql`${t.refundedCents} BETWEEN 0 AND ${t.subtotalCents} + ${t.deliveryFeeCents}`
    ),
  ]
)

export const orderItems = pgTable(
  "order_items",
  {
    id: pk(),
    sellerOrderId: uuid("seller_order_id")
      .notNull()
      .references(() => sellerOrders.id),
    // Variants are never hard-deleted, so history stays valid.
    variantId: uuid("variant_id").notNull(),
    // Stock location reserved from
    locationId: uuid("location_id").notNull(),

    // Historical snapshots
    productTitle: varchar("product_title", { length: 200 }).notNull(),
    variantName: varchar("variant_name", { length: 150 }).notNull(),
    skuSnapshot: varchar("sku_snapshot", { length: 80 }),

    unitPriceCents: money("unit_price_cents").notNull(),
    quantity: integer("quantity").notNull(),
    lineTotalCents: money("line_total_cents").notNull(), // unit_price_cents * quantity
    createdAt: createdAt(),
  },
  (t) => [
    index("order_items_seller_order_idx").on(t.sellerOrderId),
    index("order_items_variant_location_idx").on(t.variantId, t.locationId),
    // The item must point at a real stock row: this is what lets the
    // cancel/expiry job know exactly which inventory row to release.
    foreignKey({
      name: "order_items_inventory_fk",
      columns: [t.variantId, t.locationId],
      foreignColumns: [inventory.variantId, inventory.locationId],
    }).onDelete("restrict"),
    check("order_items_qty_positive", sql`${t.quantity} > 0`),
    check("order_items_price_non_negative", sql`${t.unitPriceCents} >= 0`),
    check(
      "order_items_line_total_matches",
      sql`${t.lineTotalCents} = ${t.unitPriceCents} * ${t.quantity}`
    ),
  ]
)
