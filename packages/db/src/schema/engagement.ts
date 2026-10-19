import { sql } from "drizzle-orm"
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"

import { createdAt, pk, tstz, updatedAt } from "./_helpers"
import { products } from "./catalog"
import { messageType } from "./enums"
import { badges, sellerProfiles, users } from "./identity"
import { orderItems } from "./orders"

export const reviews = pgTable(
  "reviews",
  {
    id: pk(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    buyerId: uuid("buyer_id")
      .notNull()
      .references(() => users.id),
    // Verified purchase. App must check the item belongs to the reviewer and is delivered.
    orderItemId: uuid("order_item_id")
      .notNull()
      .unique()
      .references(() => orderItems.id),
    rating: smallint("rating").notNull(),
    comment: text("comment"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("reviews_product_created_idx").on(t.productId, t.createdAt),
    index("reviews_buyer_idx").on(t.buyerId),
    check("reviews_rating_range", sql`${t.rating} BETWEEN 1 AND 5`),
  ]
)

// One chat thread per buyer + seller pair
export const conversations = pgTable(
  "conversations",
  {
    id: pk(),
    buyerId: uuid("buyer_id")
      .notNull()
      .references(() => users.id),
    sellerId: uuid("seller_id")
      .notNull()
      .references(() => sellerProfiles.id),
    lastMessageAt: tstz("last_message_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("conversations_buyer_seller_uq").on(t.buyerId, t.sellerId),
    index("conversations_seller_idx").on(t.sellerId),
  ]
)

export const messages = pgTable(
  "messages",
  {
    id: pk(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    // App must check the sender is a participant of the conversation
    senderId: uuid("sender_id")
      .notNull()
      .references(() => users.id),
    productId: uuid("product_id").references(() => products.id), // optional product card
    type: messageType("type").notNull().default("text"),
    body: text("body"),
    readAt: tstz("read_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("messages_conversation_created_idx").on(
      t.conversationId,
      t.createdAt
    ),
  ]
)

export const userBadges = pgTable(
  "user_badges",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    badgeId: uuid("badge_id")
      .notNull()
      .references(() => badges.id),
    awardedAt: tstz("awarded_at").notNull().defaultNow(),
    awardedBy: uuid("awarded_by").references(() => users.id), // NULL = awarded automatically
  },
  (t) => [
    uniqueIndex("user_badges_user_badge_uq").on(t.userId, t.badgeId),
    index("user_badges_user_idx").on(t.userId),
  ]
)

// Derived counters (cache). Source of truth = transactional tables.
export const userStats = pgTable("user_stats", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  ordersCompleted: integer("orders_completed").notNull().default(0),
  reviewsWritten: integer("reviews_written").notNull().default(0),
  sellerOrdersDelivered: integer("seller_orders_delivered")
    .notNull()
    .default(0),
  sellerReviewsReceived: integer("seller_reviews_received")
    .notNull()
    .default(0),
  sellerRatingX100: integer("seller_rating_x100"), // avg rating * 100, e.g. 475
  updatedAt: updatedAt(),
})

export const notifications = pgTable(
  "notifications",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 60 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    readAt: tstz("read_at"),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_user_created_idx").on(t.userId, t.createdAt)]
)

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: pk(),
    actorId: uuid("actor_id").references(() => users.id), // NULL = system
    // String like order.created, payment.confirmed (no enum: new actions need no migration)
    action: varchar("action", { length: 80 }).notNull(),
    entityType: varchar("entity_type", { length: 60 }).notNull(),
    entityId: uuid("entity_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_logs_entity_idx").on(t.entityType, t.entityId),
    index("audit_logs_actor_idx").on(t.actorId),
    index("audit_logs_created_idx").on(t.createdAt),
  ]
)

// Global operational settings only (default_commission_bps, payment_window_hours).
export const platformSettings = pgTable("platform_settings", {
  key: varchar("key", { length: 100 }).primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedBy: uuid("updated_by").references(() => users.id),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
})
