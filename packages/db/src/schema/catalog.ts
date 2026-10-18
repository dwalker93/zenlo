import { sql } from "drizzle-orm"
import {
  type AnyPgColumn,
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"

import { createdAt, money, pk, tstz, updatedAt } from "./_helpers"
import { attributeDataType, productStatus } from "./enums"
import { sellerProfiles } from "./identity"

export const categories = pgTable("categories", {
  id: pk(),
  parentId: uuid("parent_id").references((): AnyPgColumn => categories.id),
  name: varchar("name", { length: 120 }).notNull(),
  slug: varchar("slug", { length: 140 }).notNull().unique(),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
})

export const attributeDefinitions = pgTable(
  "attribute_definitions",
  {
    id: pk(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id),
    key: varchar("key", { length: 80 }).notNull(),
    label: varchar("label", { length: 120 }).notNull(),
    dataType: attributeDataType("data_type").notNull(),
    unit: varchar("unit", { length: 40 }),
    options: jsonb("options").$type<string[]>(), // allowed values for select types
    isFilterable: boolean("is_filterable").notNull().default(false),
    isRequired: boolean("is_required").notNull().default(false),
  },
  (t) => [uniqueIndex("attr_def_category_key_uq").on(t.categoryId, t.key)]
)

// Each seller's product is their own listing (no shared catalog in v1).
// Slug is unique per seller: /shop/{seller_slug}/{product_slug} or /p/{id}-{slug}
export const products = pgTable(
  "products",
  {
    id: pk(),
    sellerId: uuid("seller_id")
      .notNull()
      .references(() => sellerProfiles.id),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id),
    title: varchar("title", { length: 200 }).notNull(),
    slug: varchar("slug", { length: 220 }).notNull(),
    description: text("description"),
    // product-level: botanical_name, light, watering, material...
    attributes: jsonb("attributes").$type<Record<string, unknown>>(),
    status: productStatus("status").notNull().default("draft"),
    deletedAt: tstz("deleted_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("products_seller_slug_uq").on(t.sellerId, t.slug),
    index("products_category_status_idx").on(t.categoryId, t.status),
    index("products_seller_idx").on(t.sellerId),
    index("products_created_idx").on(t.createdAt),
  ]
)

// Variants are never hard-deleted (use is_active) so order history stays valid.
export const productVariants = pgTable(
  "product_variants",
  {
    id: pk(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    sku: varchar("sku", { length: 80 }).unique(),
    name: varchar("name", { length: 150 }).notNull(), // 6-inch pot, 5 kg bag, 40W
    priceCents: money("price_cents").notNull(),
    compareAtPriceCents: money("compare_at_price_cents"),
    currency: char("currency", { length: 3 }).notNull().default("LKR"),
    weightGrams: integer("weight_grams"), // for courier fee calculation
    // variant-level: pot_size, weight, color, wattage...
    attributes: jsonb("attributes").$type<Record<string, unknown>>(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("variants_product_idx").on(t.productId),
    check("variants_price_non_negative", sql`${t.priceCents} >= 0`),
  ]
)

export const productImages = pgTable(
  "product_images",
  {
    id: pk(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id").references(() => productVariants.id),
    // Object key in R2/S3; build the CDN URL at read time
    storageKey: varchar("storage_key", { length: 500 }).notNull(),
    altText: varchar("alt_text", { length: 255 }),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index("product_images_product_sort_idx").on(t.productId, t.sortOrder),
    index("product_images_variant_idx").on(t.variantId),
  ]
)
