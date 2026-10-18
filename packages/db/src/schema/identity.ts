import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"

import { createdAt, pk, tstz, updatedAt } from "./_helpers"
import { badgeAudience, sellerStatus, userRole } from "./enums"

// Defined before users because users.equipped_badge_id points at it.
export const badges = pgTable("badges", {
  id: pk(),
  code: varchar("code", { length: 100 }).notNull().unique(),
  audience: badgeAudience("audience").notNull(),
  name: varchar("name", { length: 100 }).notNull(),
  title: varchar("title", { length: 100 }),
  description: text("description"),
  iconUrl: varchar("icon_url", { length: 500 }),
  tier: smallint("tier").notNull().default(1),
  metric: varchar("metric", { length: 100 }).notNull(),
  threshold: integer("threshold").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
})

// Better Auth's user model: emailVerified, image and twoFactorEnabled are managed by the auth library.
// Roles are NOT columns here: they live in user_roles and are never writable from a client.
export const users = pgTable("users", {
  id: pk(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  phone: varchar("phone", { length: 32 }).unique(),
  name: varchar("name", { length: 150 }).notNull(),
  isActive: boolean("is_active").notNull().default(true),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
  equippedBadgeId: uuid("equipped_badge_id").references(() => badges.id, {
    onDelete: "set null",
  }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

// A user can hold several roles (customer + seller, admin + customer).
export const userRoles = pgTable(
  "user_roles",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: userRole("role").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.role] })]
)

export const sellerProfiles = pgTable(
  "seller_profiles",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .unique()
      .references(() => users.id),
    shopName: varchar("shop_name", { length: 150 }).notNull(),
    slug: varchar("slug", { length: 160 }).notNull().unique(),
    description: text("description"),
    status: sellerStatus("status").notNull().default("pending"),
    // NULL = use platform_settings default_commission_bps
    commissionBps: integer("commission_bps"),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: tstz("approved_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "seller_profiles_commission_bps_range",
      sql`${t.commissionBps} IS NULL OR ${t.commissionBps} BETWEEN 0 AND 10000`
    ),
  ]
)

export const sellerPayoutAccounts = pgTable(
  "seller_payout_accounts",
  {
    id: pk(),
    sellerId: uuid("seller_id")
      .notNull()
      .references(() => sellerProfiles.id),
    bankName: varchar("bank_name", { length: 120 }).notNull(),
    accountName: varchar("account_name", { length: 150 }).notNull(),
    // Encrypt in application code before saving; never store plain text.
    accountNumberEncrypted: text("account_number_encrypted").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    index("payout_accounts_seller_idx").on(t.sellerId),
    // At most one active default account per seller
    uniqueIndex("payout_accounts_one_default_uq")
      .on(t.sellerId)
      .where(sql`${t.isDefault} AND ${t.isActive}`),
  ]
)

export const addresses = pgTable(
  "addresses",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    fullName: varchar("full_name", { length: 150 }).notNull(),
    phone: varchar("phone", { length: 32 }).notNull(),
    line1: varchar("line1", { length: 255 }).notNull(),
    line2: varchar("line2", { length: 255 }),
    city: varchar("city", { length: 100 }).notNull(),
    district: varchar("district", { length: 80 }).notNull(),
    postalCode: varchar("postal_code", { length: 16 }),
    latitude: numeric("latitude", { precision: 9, scale: 6 }),
    longitude: numeric("longitude", { precision: 9, scale: 6 }),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("addresses_user_idx").on(t.userId)]
)

// Seller stock locations = courier pickup addresses.
// Deactivate (is_active = false), never delete.
export const sellerLocations = pgTable(
  "seller_locations",
  {
    id: pk(),
    sellerId: uuid("seller_id")
      .notNull()
      .references(() => sellerProfiles.id),
    name: varchar("name", { length: 150 }).notNull(),
    line1: varchar("line1", { length: 255 }).notNull(),
    line2: varchar("line2", { length: 255 }),
    city: varchar("city", { length: 100 }).notNull(),
    district: varchar("district", { length: 80 }).notNull(),
    postalCode: varchar("postal_code", { length: 16 }),
    latitude: numeric("latitude", { precision: 9, scale: 6 }),
    longitude: numeric("longitude", { precision: 9, scale: 6 }),
    phone: varchar("phone", { length: 32 }),
    isActive: boolean("is_active").notNull().default(true),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index("seller_locations_seller_idx").on(t.sellerId),
    // At most one active default location per seller
    uniqueIndex("seller_locations_one_default_uq")
      .on(t.sellerId)
      .where(sql`${t.isDefault} AND ${t.isActive}`),
  ]
)
