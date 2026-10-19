import { Pool } from "pg"
import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import * as schema from "@workspace/db/schema"
import {
  categories,
  inventory,
  productVariants,
  products,
  sellerLocations,
  sellerProfiles,
  users,
} from "@workspace/db/schema"
import { resolve } from "node:path"

/**
 * Real PostgreSQL (not PGlite): concurrency tests need genuine row locks and
 * parallel connections. Point DATABASE_URL_TEST at a server (CI: a postgres
 * service container). Each test file gets its own freshly migrated database.
 */
const ADMIN_URL =
  process.env.DATABASE_URL_TEST ??
  "postgres://postgres:abcd1234@localhost:5433/postgres"

export async function createPgTestDb(maxConnections = 60) {
  const name = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const admin = new Pool({ connectionString: ADMIN_URL, max: 1 })
  try {
    await admin.query(`CREATE DATABASE ${name}`)
  } catch (e) {
    await admin.end()
    throw new Error(
      `Cannot reach test PostgreSQL at ${ADMIN_URL}. Set DATABASE_URL_TEST. (${(e as Error).message})`
    )
  }
  const url = new URL(ADMIN_URL)
  url.pathname = `/${name}`
  const pool = new Pool({
    connectionString: url.toString(),
    max: maxConnections,
  })
  const db = drizzle(pool, { schema })
  await migrate(db, {
    migrationsFolder: resolve(import.meta.dir, "../../db/drizzle"),
  })
  return {
    db,
    pool,
    async close() {
      await pool.end()
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      await admin.end()
    },
  }
}
export type PgTest = Awaited<ReturnType<typeof createPgTestDb>>
export type TestDb = PgTest["db"]

let n = 0
export async function seed(
  db: TestDb,
  opts: { stock?: number; sellers?: number } = {}
) {
  const i = ++n
  const [cat] = await db
    .insert(categories)
    .values({
      name: `Cat ${i}`,
      slug: `cat-${i}-${Math.random().toString(36).slice(2, 6)}`,
    })
    .returning()
  const mkUser = async (tag: string) =>
    (
      await db
        .insert(users)
        .values({
          email: `${tag}-${i}-${Math.random().toString(36).slice(2, 8)}@t.test`,
          name: tag,
        })
        .returning({ id: users.id })
    )[0].id
  const buyerId = await mkUser("buyer")
  const sellers = []
  for (let s = 0; s < (opts.sellers ?? 2); s++) {
    const userId = await mkUser("seller")
    const [sp] = await db
      .insert(sellerProfiles)
      .values({
        userId,
        shopName: `Shop ${i}-${s}`,
        slug: `shop-${i}-${s}-${Math.random().toString(36).slice(2, 6)}`,
        status: "approved",
      })
      .returning()
    const [loc] = await db
      .insert(sellerLocations)
      .values({
        sellerId: sp.id,
        name: "Main",
        line1: "1 Road",
        city: "Colombo",
        district: "Colombo",
        isDefault: true,
      })
      .returning()
    const [prod] = await db
      .insert(products)
      .values({
        sellerId: sp.id,
        categoryId: cat.id,
        title: `Plant ${i}-${s}`,
        slug: `plant-${i}-${s}-${Math.random().toString(36).slice(2, 6)}`,
        status: "active",
      })
      .returning()
    const [variant] = await db
      .insert(productVariants)
      .values({
        productId: prod.id,
        sellerId: sp.id,
        name: "Pot",
        priceCents: 100000,
      })
      .returning()
    const [inv] = await db
      .insert(inventory)
      .values({
        variantId: variant.id,
        locationId: loc.id,
        onHandQty: opts.stock ?? 10,
      })
      .returning()
    sellers.push({
      sellerId: sp.id,
      variantId: variant.id,
      locationId: loc.id,
      inventoryId: inv.id,
    })
  }
  return { buyerId, sellers }
}

export const shipping = {
  fullName: "A Buyer",
  phone: "0771234567",
  line1: "1 Lane",
  city: "Kandy",
  district: "Kandy",
}

import { eq } from "drizzle-orm"
import { confirmPayment, placeOrder } from "../src"
import {
  sellerOrders,
  sellerPayoutAccounts,
  shipments,
} from "@workspace/db/schema"

/** Paid order. Seller A: 3 x 100000 = 300000 (commission 30000), delivery 20000. Seller B: 1 x 100000, delivery 20000. */
export async function paidOrder(db: TestDb) {
  const s = await seed(db, { stock: 50, sellers: 2 })
  const placed = await placeOrder(db, {
    buyerId: s.buyerId,
    paymentMethod: "bank_transfer",
    shipping,
    items: [
      { variantId: s.sellers[0].variantId, quantity: 3 },
      { variantId: s.sellers[1].variantId, quantity: 1 },
    ],
    calculateDeliveryFeeCents: () => 20000,
  })
  await confirmPayment(db, { paymentId: placed.paymentId })
  const sos = await db
    .select()
    .from(sellerOrders)
    .where(eq(sellerOrders.orderId, placed.orderId))
  const A = sos.find((x) => x.sellerId === s.sellers[0].sellerId)!
  const B = sos.find((x) => x.sellerId === s.sellers[1].sellerId)!
  return {
    orderId: placed.orderId,
    A,
    B,
    total: placed.totalCents,
    sellers: s.sellers,
  }
}

/** Put a seller order into 'shipped' with one delivered (not yet verified) shipment. */
export async function markShipped(
  db: TestDb,
  sellerOrderId: string,
  pickupLocationId: string
) {
  await db
    .insert(shipments)
    .values({ sellerOrderId, pickupLocationId, status: "delivered" })
  await db
    .update(sellerOrders)
    .set({ status: "shipped" })
    .where(eq(sellerOrders.id, sellerOrderId))
}

export async function addPayoutAccount(db: TestDb, sellerId: string) {
  await db.insert(sellerPayoutAccounts).values({
    sellerId,
    bankName: "Test Bank",
    accountName: "Seller",
    accountNumberEncrypted: "enc:xxxx",
    isDefault: true,
  })
}
