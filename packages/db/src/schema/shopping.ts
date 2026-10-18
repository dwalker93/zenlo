import { sql } from "drizzle-orm"
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

import { createdAt, pk, updatedAt } from "./_helpers"
import { productVariants, products } from "./catalog"
import { users } from "./identity"

export const carts = pgTable("carts", {
  id: pk(),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const cartItems = pgTable(
  "cart_items",
  {
    id: pk(),
    cartId: uuid("cart_id")
      .notNull()
      .references(() => carts.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id),
    quantity: integer("quantity").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("cart_items_cart_variant_uq").on(t.cartId, t.variantId),
    check("cart_items_qty_positive", sql`${t.quantity} > 0`),
  ]
)

export const favorites = pgTable(
  "favorites",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.productId] }),
    index("favorites_product_idx").on(t.productId),
  ]
)
