import { expect } from "bun:test"

import type { TestDb } from "./setup"

import {
  inventory,
  orderItems,
  orders,
  payments,
  products,
  productVariants,
  categories,
  refundAllocations,
  refunds,
  sellerLocations,
  sellerOrders,
  sellerProfiles,
  users,
} from "../src/schema"

let n = 0
const next = () => ++n

/** Assert that a statement is rejected by the named constraint / index. */
export async function rejects(promise: Promise<unknown>, constraint: string) {
  try {
    await promise
  } catch (e: any) {
    const c = e?.cause ?? e
    const text = `${c?.constraint ?? ""} | ${c?.message ?? ""} | ${e?.message ?? ""}`
    expect(text).toContain(constraint)
    return
  }
  throw new Error(
    `expected the database to reject this with "${constraint}", but it succeeded`
  )
}

export async function makeUser(db: TestDb, name = "user") {
  const i = next()
  const [u] = await db
    .insert(users)
    .values({ email: `${name}${i}@example.test`, name: `${name} ${i}` })
    .returning({ id: users.id })
  return u.id
}

/** Seller with a location, a product, a variant and 1000 units of stock. */
export async function makeSeller(db: TestDb, categoryId: string) {
  const i = next()
  const userId = await makeUser(db, "seller")
  const [sp] = await db
    .insert(sellerProfiles)
    .values({
      userId,
      shopName: `Shop ${i}`,
      slug: `shop-${i}`,
      status: "approved",
    })
    .returning({ id: sellerProfiles.id })
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
    .returning({ id: sellerLocations.id })
  const [prod] = await db
    .insert(products)
    .values({
      sellerId: sp.id,
      categoryId,
      title: `Plant ${i}`,
      slug: `plant-${i}`,
      status: "active",
    })
    .returning({ id: products.id })
  const [variant] = await db
    .insert(productVariants)
    .values({ productId: prod.id, name: "6-inch pot", priceCents: 450000 })
    .returning({ id: productVariants.id })
  const [inv] = await db
    .insert(inventory)
    .values({ variantId: variant.id, locationId: loc.id, onHandQty: 1000 })
    .returning({ id: inventory.id })
  return {
    userId,
    sellerId: sp.id,
    locationId: loc.id,
    productId: prod.id,
    variantId: variant.id,
    inventoryId: inv.id,
  }
}
export type Seller = Awaited<ReturnType<typeof makeSeller>>

export async function seedBase(db: TestDb) {
  const [cat] = await db
    .insert(categories)
    .values({ name: "Indoor plants", slug: `indoor-${next()}` })
    .returning({ id: categories.id })
  const buyerId = await makeUser(db, "buyer")
  const adminId = await makeUser(db, "admin")
  const a = await makeSeller(db, cat.id)
  const b = await makeSeller(db, cat.id)
  return { categoryId: cat.id, buyerId, adminId, a, b }
}
export type Base = Awaited<ReturnType<typeof seedBase>>

/**
 * An independent order (LKR cents) with two seller orders and one succeeded
 * bank-transfer payment:
 *   seller A: subtotal 4500.00, delivery 450.00, commission 450.00, earning 4050.00
 *   seller B: subtotal 2400.00, delivery 850.00, commission 240.00, earning 2160.00
 *   order:    subtotal 6900.00, delivery 1300.00, total 8200.00
 */
export async function makeOrder(
  db: TestDb,
  base: Base,
  opts: { paymentStatus?: "succeeded" | "pending" } = {}
) {
  const i = next()
  const [o] = await db
    .insert(orders)
    .values({
      orderNumber: `ORD-${i}`,
      buyerId: base.buyerId,
      shipFullName: "Buyer",
      shipPhone: "0770000000",
      shipLine1: "2 Lane",
      shipCity: "Galle",
      shipDistrict: "Galle",
      subtotalCents: 690000,
      deliveryFeeCents: 130000,
      totalCents: 820000,
    })
    .returning({ id: orders.id })
  const [soA] = await db
    .insert(sellerOrders)
    .values({
      orderId: o.id,
      sellerId: base.a.sellerId,
      sellerNameSnapshot: "Shop A",
      subtotalCents: 450000,
      deliveryFeeCents: 45000,
      commissionCents: 45000,
      sellerEarningCents: 405000,
    })
    .returning({ id: sellerOrders.id })
  const [soB] = await db
    .insert(sellerOrders)
    .values({
      orderId: o.id,
      sellerId: base.b.sellerId,
      sellerNameSnapshot: "Shop B",
      subtotalCents: 240000,
      deliveryFeeCents: 85000,
      commissionCents: 24000,
      sellerEarningCents: 216000,
    })
    .returning({ id: sellerOrders.id })
  const [itemA] = await db
    .insert(orderItems)
    .values({
      sellerOrderId: soA.id,
      variantId: base.a.variantId,
      locationId: base.a.locationId,
      productTitle: "Plant A",
      variantName: "6-inch pot",
      unitPriceCents: 450000,
      quantity: 1,
      lineTotalCents: 450000,
    })
    .returning({ id: orderItems.id })
  const [itemB] = await db
    .insert(orderItems)
    .values({
      sellerOrderId: soB.id,
      variantId: base.b.variantId,
      locationId: base.b.locationId,
      productTitle: "Plant B",
      variantName: "6-inch pot",
      unitPriceCents: 120000,
      quantity: 2,
      lineTotalCents: 240000,
    })
    .returning({ id: orderItems.id })
  const [pay] = await db
    .insert(payments)
    .values({
      orderId: o.id,
      method: "bank_transfer",
      status: opts.paymentStatus ?? "succeeded",
      amountCents: 820000,
    })
    .returning({ id: payments.id })
  return {
    orderId: o.id,
    soA: soA.id,
    soB: soB.id,
    itemA: itemA.id,
    itemB: itemB.id,
    paymentId: pay.id,
  }
}
export type OrderGraph = Awaited<ReturnType<typeof makeOrder>>

/** A refund header with its allocations (amounts in cents). */
export async function makeRefund(
  db: TestDb,
  order: OrderGraph,
  allocs: {
    sellerOrderId: string
    item: number
    delivery?: number
    commissionReturned?: number
  }[],
  status:
    | "requested"
    | "approved"
    | "processing"
    | "succeeded"
    | "failed"
    | "rejected" = "approved"
) {
  const total = allocs.reduce((s, a) => s + a.item + (a.delivery ?? 0), 0)
  const [r] = await db
    .insert(refunds)
    .values({
      orderId: order.orderId,
      paymentId: order.paymentId,
      amountCents: total,
      status,
    })
    .returning({ id: refunds.id })
  const allocationIds: string[] = []
  for (const a of allocs) {
    const [row] = await db
      .insert(refundAllocations)
      .values({
        refundId: r.id,
        orderId: order.orderId,
        sellerOrderId: a.sellerOrderId,
        itemAmountCents: a.item,
        deliveryAmountCents: a.delivery ?? 0,
        amountCents: a.item + (a.delivery ?? 0),
        commissionReturnedCents: a.commissionReturned ?? 0,
      })
      .returning({ id: refundAllocations.id })
    allocationIds.push(row.id)
  }
  return { refundId: r.id, allocationIds }
}
