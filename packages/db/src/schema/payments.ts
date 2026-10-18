import { sql } from "drizzle-orm"
import {
  char,
  check,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
  unique,
} from "drizzle-orm/pg-core"

import { createdAt, money, pk, tstz, updatedAt } from "./_helpers"
import { paymentMethod, paymentStatus, shipmentStatus } from "./enums"
import { sellerLocations, users } from "./identity"
import { orders, sellerOrders } from "./orders"

// One row per payment ATTEMPT. An order can have many attempts but only ONE
// succeeded payment. PayHere references are unique; bank slip references are
// typed by people, so duplicates are flagged for admin review, not blocked.
export const payments = pgTable(
  "payments",
  {
    id: pk(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    method: paymentMethod("method").notNull(),
    status: paymentStatus("status").notNull().default("pending"),
    amountCents: money("amount_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull().default("LKR"),
    providerReference: varchar("provider_reference", { length: 120 }), // PayHere id or bank slip ref
    idempotencyKey: varchar("idempotency_key", { length: 120 }).unique(),
    proofStorageKey: varchar("proof_storage_key", { length: 500 }), // uploaded bank slip
    gatewayPayload: jsonb("gateway_payload").$type<Record<string, unknown>>(), // raw PayHere callback
    confirmedBy: uuid("confirmed_by").references(() => users.id), // admin who verified a bank transfer
    confirmedAt: tstz("confirmed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("payments_order_status_idx").on(t.orderId, t.status),
    index("payments_method_reference_idx").on(t.method, t.providerReference),
    // Target of the refunds composite FK (UNIQUE constraint: see inventory.ts)
    unique("payments_id_order_uq").on(t.id, t.orderId),
    // An order can be paid only once (duplicate callbacks, bank transfer + gateway)
    uniqueIndex("payments_one_succeeded_per_order_uq")
      .on(t.orderId)
      .where(sql`${t.status} = 'succeeded'`),
    // PayHere guarantees unique references
    uniqueIndex("payments_payhere_reference_uq")
      .on(t.providerReference)
      .where(
        sql`${t.method} = 'payhere' AND ${t.providerReference} IS NOT NULL`
      ),
    check("payments_amount_positive", sql`${t.amountCents} > 0`),
  ]
)

// A seller order can have several shipments (e.g. two parcels, or items from
// different locations). It counts as delivered only when ALL are delivered and
// verified. pickup_location_id must belong to the seller of the seller order.
export const shipments = pgTable(
  "shipments",
  {
    id: pk(),
    sellerOrderId: uuid("seller_order_id")
      .notNull()
      .references(() => sellerOrders.id),
    pickupLocationId: uuid("pickup_location_id")
      .notNull()
      .references(() => sellerLocations.id),
    courier: varchar("courier", { length: 60 })
      .notNull()
      .default("promptxpress"),
    trackingNumber: varchar("tracking_number", { length: 80 }),
    status: shipmentStatus("status").notNull().default("pending"),
    feeCents: money("fee_cents").notNull().default(0),
    shippedAt: tstz("shipped_at"),
    deliveredAt: tstz("delivered_at"),
    // Seller payout is released only after this is set
    deliveryVerifiedAt: tstz("delivery_verified_at"),
    verifiedBy: uuid("verified_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("shipments_seller_order_status_idx").on(t.sellerOrderId, t.status),
    // a tracking number is only unique per carrier; NULLs (not yet booked) are distinct
    uniqueIndex("shipments_courier_tracking_uq").on(
      t.courier,
      t.trackingNumber
    ),
    index("shipments_pickup_location_idx").on(t.pickupLocationId),
    check("shipments_fee_non_negative", sql`${t.feeCents} >= 0`),
  ]
)

// Optional: keep only if the courier provides tracking events / webhooks.
export const shipmentEvents = pgTable(
  "shipment_events",
  {
    id: pk(),
    shipmentId: uuid("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "cascade" }),
    status: shipmentStatus("status").notNull(),
    description: text("description"),
    occurredAt: tstz("occurred_at").notNull().defaultNow(),
  },
  (t) => [
    index("shipment_events_shipment_occurred_idx").on(
      t.shipmentId,
      t.occurredAt
    ),
  ]
)
