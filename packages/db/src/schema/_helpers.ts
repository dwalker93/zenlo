import { bigint, timestamp, uuid } from "drizzle-orm/pg-core"

export const pk = () => uuid("id").primaryKey().defaultRandom()

export const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow()

// Nullable, like the ERD: NULL = never updated. $onUpdate only runs through Drizzle.
export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).$onUpdate(() => new Date())

export const tstz = (name: string) => timestamp(name, { withTimezone: true })

// NOT NULL variant for tables where the ERD says so (inventory).
export const updatedAtNow = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date())

// Money = bigint minor units (LKR cents). LKR amounts stay far below
// Number.MAX_SAFE_INTEGER, so mode "number" is safe. Use BigInt for
// intermediate products (see money.ts).
export const money = (name: string) => bigint(name, { mode: "number" })
