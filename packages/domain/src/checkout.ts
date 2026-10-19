import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  inventory,
  orderItems,
  orders,
  payments,
  platformSettings,
  productVariants,
  products,
  sellerOrders,
  sellerProfiles,
} from '@workspace/db/schema';
import { InvalidOrderError, OutOfStockError, VariantUnavailableError } from './errors';
import { lockInventoryRows } from './stock';
import type { Db } from './types';

export interface ShippingAddress {
  fullName: string;
  phone: string;
  line1: string;
  line2?: string | null;
  city: string;
  district: string;
  postalCode?: string | null;
}

export interface SellerGroup {
  sellerId: string;
  subtotalCents: number;
  items: { variantId: string; quantity: number; weightGrams: number | null }[];
}

export interface PlaceOrderInput {
  buyerId: string;
  items: { variantId: string; quantity: number }[];
  shipping: ShippingAddress;
  paymentMethod: 'bank_transfer' | 'payhere';
  /** Delivery fee for one seller's parcel group. Defaults to 0 (delivery pricing is not modelled yet). */
  calculateDeliveryFeeCents?: (group: SellerGroup) => number;
  now?: Date;
}

export interface PlacedOrder {
  orderId: string;
  orderNumber: string;
  paymentId: string;
  subtotalCents: number;
  deliveryFeeCents: number;
  totalCents: number;
  paymentDueAt: Date;
}

const CURRENCY = 'LKR';
/** Largest value of the integer columns (order_items.quantity, inventory.*_qty). */
export const MAX_QUANTITY = 2_147_483_647;

/** Exact integer arithmetic that refuses to leave the safe-integer range (money columns are bigint read as JS numbers). */
function safeMul(a: number, b: number, what: string): number {
  const r = BigInt(a) * BigInt(b);
  if (r > BigInt(Number.MAX_SAFE_INTEGER)) throw new InvalidOrderError(`${what} is too large`);
  return Number(r);
}
function safeAdd(a: number, b: number, what: string): number {
  const r = a + b;
  if (!Number.isSafeInteger(r)) throw new InvalidOrderError(`${what} is too large`);
  return r;
}
const DEFAULT_COMMISSION_BPS = 1000;
const DEFAULT_PAYMENT_WINDOW_HOURS = 48;
const PAYHERE_WINDOW_HOURS = 1;

/** commission = round_half_up(subtotal * bps / 10000), exact for any safe integer subtotal. */
export function commissionFor(subtotalCents: number, bps: number): number {
  return Number((BigInt(subtotalCents) * BigInt(bps) + 5000n) / 10000n);
}

function orderNumber(now: Date) {
  const rand = Math.floor(Math.random() * 36 ** 6).toString(36).toUpperCase().padStart(6, '0');
  return `ORD-${now.getTime().toString(36).toUpperCase()}-${rand}`;
}

async function readNumberSetting(tx: Db, key: string, fallback: number) {
  const [row] = await tx.select().from(platformSettings).where(eq(platformSettings.key, key));
  return typeof row?.value === 'number' && Number.isFinite(row.value) ? row.value : fallback;
}

/**
 * Checkout. One transaction:
 *  1. validate items, load variants (active product, approved seller, LKR)
 *  2. lock the candidate stock rows in id order
 *  3. reserve with the atomic guard  UPDATE ... WHERE on_hand - reserved >= :n
 *  4. write orders -> seller_orders (one per seller) -> order_items + a pending payment
 * Any failure (including out of stock) rolls everything back, so nothing stays reserved.
 */
export async function placeOrder(db: Db, input: PlaceOrderInput): Promise<PlacedOrder> {
  const now = input.now ?? new Date();

  // 1. normalise: merge duplicate variants, validate quantities
  const wanted = new Map<string, number>();
  for (const it of input.items) {
    if (!Number.isInteger(it.quantity) || it.quantity <= 0 || it.quantity > MAX_QUANTITY) {
      throw new InvalidOrderError(`quantity must be an integer between 1 and ${MAX_QUANTITY}`, { variantId: it.variantId });
    }
    const merged = (wanted.get(it.variantId) ?? 0) + it.quantity;
    if (merged > MAX_QUANTITY) throw new InvalidOrderError('combined quantity of a variant is too large', { variantId: it.variantId });
    wanted.set(it.variantId, merged);
  }
  if (wanted.size === 0) throw new InvalidOrderError('order has no items');
  const variantIds = [...wanted.keys()].sort();

  return db.transaction(async (tx) => {
    const variants = await tx
      .select({
        variantId: productVariants.id,
        variantName: productVariants.name,
        sku: productVariants.sku,
        priceCents: productVariants.priceCents,
        currency: productVariants.currency,
        weightGrams: productVariants.weightGrams,
        variantActive: productVariants.isActive,
        productTitle: products.title,
        productStatus: products.status,
        productDeletedAt: products.deletedAt,
        sellerId: sellerProfiles.id,
        sellerName: sellerProfiles.shopName,
        sellerStatus: sellerProfiles.status,
        commissionBps: sellerProfiles.commissionBps,
      })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .innerJoin(sellerProfiles, eq(sellerProfiles.id, products.sellerId))
      .where(inArray(productVariants.id, variantIds));
    const byId = new Map(variants.map((v) => [v.variantId, v]));
    for (const id of variantIds) {
      const v = byId.get(id);
      if (!v) throw new VariantUnavailableError(id, 'not found');
      if (!v.variantActive) throw new VariantUnavailableError(id, 'variant is inactive');
      if (v.productStatus !== 'active' || v.productDeletedAt) throw new VariantUnavailableError(id, 'product is not on sale');
      if (v.sellerStatus !== 'approved') throw new VariantUnavailableError(id, 'seller is not approved');
      if (v.currency !== CURRENCY) throw new VariantUnavailableError(id, `currency ${v.currency} is not supported`);
    }

    // 2. lock candidate stock rows (id order)
    const locked = await lockInventoryRows(tx, variantIds);
    const rowsByVariant = new Map<string, typeof inventory.$inferSelect[]>();
    for (const row of locked.values()) {
      rowsByVariant.set(row.variantId, [...(rowsByVariant.get(row.variantId) ?? []), row]);
    }

    // 3. choose one location per variant and reserve atomically
    const chosen = new Map<string, string>(); // variantId -> locationId
    for (const variantId of variantIds) {
      const qty = wanted.get(variantId)!;
      const rows = rowsByVariant.get(variantId) ?? [];
      const best = rows
        .filter((r) => r.onHandQty - r.reservedQty >= qty)
        .sort((a, b) => b.onHandQty - b.reservedQty - (a.onHandQty - a.reservedQty) || (a.id < b.id ? -1 : 1))[0];
      if (!best) throw new OutOfStockError(variantId, qty, Math.max(0, ...rows.map((r) => r.onHandQty - r.reservedQty)));
      const done = await tx
        .update(inventory)
        .set({ reservedQty: sql`${inventory.reservedQty} + ${qty}`, updatedAt: now })
        .where(and(eq(inventory.id, best.id), sql`${inventory.onHandQty} - ${inventory.reservedQty} >= ${qty}`))
        .returning({ id: inventory.id });
      if (done.length !== 1) throw new OutOfStockError(variantId, qty, 0);
      chosen.set(variantId, best.locationId);
    }

    // 4. group by seller, price, write
    const defaultBps = await readNumberSetting(tx, 'default_commission_bps', DEFAULT_COMMISSION_BPS);
    const windowHours =
      input.paymentMethod === 'payhere'
        ? PAYHERE_WINDOW_HOURS
        : await readNumberSetting(tx, 'payment_window_hours', DEFAULT_PAYMENT_WINDOW_HOURS);
    const paymentDueAt = new Date(now.getTime() + windowHours * 3600_000);

    const groups = new Map<string, { sellerName: string; bps: number; lines: { v: (typeof variants)[number]; qty: number }[] }>();
    for (const variantId of variantIds) {
      const v = byId.get(variantId)!;
      const g = groups.get(v.sellerId) ?? { sellerName: v.sellerName, bps: v.commissionBps ?? defaultBps, lines: [] };
      g.lines.push({ v, qty: wanted.get(variantId)! });
      groups.set(v.sellerId, g);
    }

    const calc = input.calculateDeliveryFeeCents ?? (() => 0);
    const priced = [...groups.entries()].map(([sellerId, g]) => {
      const subtotal = g.lines.reduce((s, l) => safeAdd(s, safeMul(l.v.priceCents, l.qty, 'line total'), 'seller subtotal'), 0);
      const delivery = calc({
        sellerId,
        subtotalCents: subtotal,
        items: g.lines.map((l) => ({ variantId: l.v.variantId, quantity: l.qty, weightGrams: l.v.weightGrams })),
      });
      if (!Number.isSafeInteger(delivery) || delivery < 0) throw new InvalidOrderError('delivery fee must be a non-negative safe integer');
      safeAdd(subtotal, delivery, 'seller order total');
      return { sellerId, g, subtotal, delivery, commission: commissionFor(subtotal, g.bps) };
    });
    const subtotalCents = priced.reduce((s, p) => safeAdd(s, p.subtotal, 'order subtotal'), 0);
    const deliveryFeeCents = priced.reduce((s, p) => safeAdd(s, p.delivery, 'order delivery fee'), 0);
    const totalCents = safeAdd(subtotalCents, deliveryFeeCents, 'order total');

    const number = orderNumber(now);
    const [order] = await tx
      .insert(orders)
      .values({
        orderNumber: number,
        buyerId: input.buyerId,
        shipFullName: input.shipping.fullName,
        shipPhone: input.shipping.phone,
        shipLine1: input.shipping.line1,
        shipLine2: input.shipping.line2 ?? null,
        shipCity: input.shipping.city,
        shipDistrict: input.shipping.district,
        shipPostalCode: input.shipping.postalCode ?? null,
        subtotalCents,
        deliveryFeeCents,
        totalCents,
        currency: CURRENCY,
        paymentDueAt,
      })
      .returning({ id: orders.id });

    for (const p of priced) {
      const [so] = await tx
        .insert(sellerOrders)
        .values({
          orderId: order.id,
          sellerId: p.sellerId,
          sellerNameSnapshot: p.g.sellerName,
          subtotalCents: p.subtotal,
          deliveryFeeCents: p.delivery,
          commissionCents: p.commission,
          sellerEarningCents: p.subtotal - p.commission,
        })
        .returning({ id: sellerOrders.id });
      await tx.insert(orderItems).values(
        p.g.lines.map((l) => ({
          sellerOrderId: so.id,
          variantId: l.v.variantId,
          locationId: chosen.get(l.v.variantId)!,
          productTitle: l.v.productTitle,
          variantName: l.v.variantName,
          skuSnapshot: l.v.sku,
          unitPriceCents: l.v.priceCents,
          quantity: l.qty,
          lineTotalCents: safeMul(l.v.priceCents, l.qty, 'line total'),
        })),
      );
    }

    const [payment] = await tx
      .insert(payments)
      .values({ orderId: order.id, method: input.paymentMethod, amountCents: totalCents, currency: CURRENCY })
      .returning({ id: payments.id });

    return { orderId: order.id, orderNumber: number, paymentId: payment.id, subtotalCents, deliveryFeeCents, totalCents, paymentDueAt };
  });
}
