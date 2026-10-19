import { beforeAll, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import {
  inventory,
  orderItems,
  orders,
  payments,
  payoutItems,
  payouts,
  products,
  productVariants,
  reviews,
  sellerLedgerEntries,
  sellerLocations,
  sellerOrders,
  sellerPayoutAccounts,
  sellerProfiles,
  shipments,
} from '../src/schema';
import { type Base, makeOrder, makeRefund, makeUser, rejects, seedBase } from './factories';
import { createTestDb, type TestDb } from './setup';

let db: TestDb;
let base: Base;

beforeAll(async () => {
  ({ db } = await createTestDb());
  base = await seedBase(db);
});

const orderValues = (over: Record<string, unknown> = {}) => ({
  orderNumber: `T-${Math.random().toString(36).slice(2)}`,
  buyerId: base.buyerId,
  shipFullName: 'B',
  shipPhone: '1',
  shipLine1: 'x',
  shipCity: 'c',
  shipDistrict: 'd',
  subtotalCents: 1000,
  deliveryFeeCents: 100,
  totalCents: 1100,
  ...over,
});

describe('money checks', () => {
  test('order total must equal subtotal + delivery', async () => {
    await rejects(db.insert(orders).values(orderValues({ totalCents: 1000 })), 'orders_total_matches');
  });
  test('order amounts cannot be negative', async () => {
    await rejects(
      db.insert(orders).values(orderValues({ subtotalCents: -100, deliveryFeeCents: 100, totalCents: 0 })),
      'orders_amounts_non_negative',
    );
  });
  test('order refunded_cents cannot exceed the total', async () => {
    await rejects(db.insert(orders).values(orderValues({ refundedCents: 1101 })), 'orders_refunded_range');
  });

  test('seller order commission cannot exceed the subtotal', async () => {
    const o = await makeOrder(db, base);
    await rejects(
      db.update(sellerOrders).set({ commissionCents: 450001, sellerEarningCents: -1 }).where(eq(sellerOrders.id, o.soA)),
      'seller_orders_commission_range',
    );
  });
  test('seller earning must equal subtotal - commission', async () => {
    const o = await makeOrder(db, base);
    await rejects(
      db.update(sellerOrders).set({ sellerEarningCents: 1 }).where(eq(sellerOrders.id, o.soA)),
      'seller_orders_earning_matches',
    );
  });
  test('seller order refunded_cents cannot exceed subtotal + delivery', async () => {
    const o = await makeOrder(db, base);
    await rejects(
      db.update(sellerOrders).set({ refundedCents: 495001 }).where(eq(sellerOrders.id, o.soA)),
      'seller_orders_refunded_range',
    );
  });
  test('commission_bps must be within 0..10000', async () => {
    await rejects(
      db.update(sellerProfiles).set({ commissionBps: 10001 }).where(eq(sellerProfiles.id, base.a.sellerId)),
      'seller_profiles_commission_bps_range',
    );
  });
  test('order item line total must equal unit price x quantity, quantity must be positive', async () => {
    const o = await makeOrder(db, base);
    const item = {
      sellerOrderId: o.soA,
      variantId: base.a.variantId,
      locationId: base.a.locationId,
      productTitle: 'p',
      variantName: 'v',
      unitPriceCents: 100,
    };
    await rejects(db.insert(orderItems).values({ ...item, quantity: 2, lineTotalCents: 100 }), 'order_items_line_total_matches');
    await rejects(db.insert(orderItems).values({ ...item, quantity: 0, lineTotalCents: 0 }), 'order_items_qty_positive');
  });
  test('inventory: reserved cannot exceed on-hand, neither can be negative', async () => {
    await rejects(
      db.update(inventory).set({ reservedQty: 1001 }).where(eq(inventory.id, base.a.inventoryId)),
      'inventory_qty_bounds',
    );
    await rejects(
      db.update(inventory).set({ onHandQty: -1 }).where(eq(inventory.id, base.a.inventoryId)),
      'inventory_qty_bounds',
    );
  });
  test('inventory: an atomic reserve cannot oversell (0 rows updated = out of stock)', async () => {
    const stock = 3;
    await db.update(inventory).set({ onHandQty: stock, reservedQty: 0 }).where(eq(inventory.id, base.b.inventoryId));
    const reserve = (n: number) =>
      db.execute(sql`UPDATE inventory SET reserved_qty = reserved_qty + ${n}
                     WHERE id = ${base.b.inventoryId} AND on_hand_qty - reserved_qty >= ${n} RETURNING id`);
    expect((await reserve(2)).rows.length).toBe(1);
    expect((await reserve(2)).rows.length).toBe(0); // only 1 left
    expect((await reserve(1)).rows.length).toBe(1);
    await db.update(inventory).set({ onHandQty: 1000, reservedQty: 0 }).where(eq(inventory.id, base.b.inventoryId));
  });
  test('payment amount must be positive; shipment fee cannot be negative; payout amount must be positive', async () => {
    const o = await makeOrder(db, base);
    await rejects(
      db.insert(payments).values({ orderId: o.orderId, method: 'payhere', amountCents: 0 }),
      'payments_amount_positive',
    );
    await rejects(
      db.insert(shipments).values({ sellerOrderId: o.soA, pickupLocationId: base.a.locationId, feeCents: -1 }),
      'shipments_fee_non_negative',
    );
    await rejects(
      db.insert(payouts).values({ sellerId: base.a.sellerId, amountCents: 0 }),
      'payouts_amount_positive',
    );
  });
  test('review rating must be 1..5', async () => {
    const o = await makeOrder(db, base);
    await rejects(
      db.insert(reviews).values({ productId: base.a.productId, buyerId: base.buyerId, orderItemId: o.itemA, rating: 6 }),
      'reviews_rating_range',
    );
  });
});

describe('order item -> inventory', () => {
  test('an item must point at a real (variant, location) stock row', async () => {
    const o = await makeOrder(db, base);
    await rejects(
      db.insert(orderItems).values({
        sellerOrderId: o.soA,
        variantId: base.a.variantId,
        locationId: base.b.locationId, // seller B's location: no stock row for variant A there
        productTitle: 'p',
        variantName: 'v',
        unitPriceCents: 100,
        quantity: 1,
        lineTotalCents: 100,
      }),
      'order_items_inventory_fk',
    );
  });
  test('an inventory row referenced by an order item cannot be deleted', async () => {
    await makeOrder(db, base);
    await rejects(db.delete(inventory).where(eq(inventory.id, base.a.inventoryId)), 'order_items_inventory_fk');
  });
});

describe('payments', () => {
  test('an order can have only one succeeded payment', async () => {
    const o = await makeOrder(db, base); // already has one succeeded payment
    await rejects(
      db.insert(payments).values({ orderId: o.orderId, method: 'payhere', status: 'succeeded', amountCents: 820000 }),
      'payments_one_succeeded_per_order_uq',
    );
  });
  test('failed attempts do not block a later success', async () => {
    const o = await makeOrder(db, base, { paymentStatus: 'pending' });
    await db.insert(payments).values({ orderId: o.orderId, method: 'payhere', status: 'failed', amountCents: 820000 });
    await db.insert(payments).values({ orderId: o.orderId, method: 'payhere', status: 'succeeded', amountCents: 820000 });
    const rows = await db.select().from(payments).where(eq(payments.orderId, o.orderId));
    expect(rows.length).toBe(3);
  });
  test('PayHere references are unique; bank slip references are not', async () => {
    const o1 = await makeOrder(db, base, { paymentStatus: 'pending' });
    const o2 = await makeOrder(db, base, { paymentStatus: 'pending' });
    const ref = `PH-${Math.random()}`;
    await db.insert(payments).values({ orderId: o1.orderId, method: 'payhere', amountCents: 1, providerReference: ref });
    await rejects(
      db.insert(payments).values({ orderId: o2.orderId, method: 'payhere', amountCents: 1, providerReference: ref }),
      'payments_payhere_reference_uq',
    );
    const slip = `SLIP-${Math.random()}`;
    await db.insert(payments).values({ orderId: o1.orderId, method: 'bank_transfer', amountCents: 1, providerReference: slip });
    await db.insert(payments).values({ orderId: o2.orderId, method: 'bank_transfer', amountCents: 1, providerReference: slip });
  });
});

describe('one active default per seller', () => {
  test('locations', async () => {
    const loc = { sellerId: base.a.sellerId, name: 'L', line1: 'x', city: 'c', district: 'd' };
    // base.a already has an active default
    await rejects(
      db.insert(sellerLocations).values({ ...loc, isDefault: true }),
      'seller_locations_one_default_uq',
    );
    await db.insert(sellerLocations).values({ ...loc, isDefault: true, isActive: false }); // inactive: fine
    await db.insert(sellerLocations).values({ ...loc, isDefault: false }); // non-default: fine
  });
  test('payout accounts', async () => {
    const acct = { sellerId: base.a.sellerId, bankName: 'B', accountName: 'N', accountNumberEncrypted: 'x' };
    await db.insert(sellerPayoutAccounts).values({ ...acct, isDefault: true });
    await rejects(db.insert(sellerPayoutAccounts).values({ ...acct, isDefault: true }), 'payout_accounts_one_default_uq');
    await db.insert(sellerPayoutAccounts).values({ ...acct, isDefault: true, isActive: false });
    await db.insert(sellerPayoutAccounts).values({ ...acct, sellerId: base.b.sellerId, isDefault: true }); // other seller
  });
});

describe('refund ownership (composite foreign keys)', () => {
  test('happy path: a whole-order refund is one header + one allocation per seller order', async () => {
    const o = await makeOrder(db, base);
    const r = await makeRefund(db, o, [
      { sellerOrderId: o.soA, item: 450000, delivery: 45000 },
      { sellerOrderId: o.soB, item: 240000, delivery: 85000 },
    ]);
    expect(r.allocationIds.length).toBe(2);
  });
  test('a refund cannot use another order\'s payment', async () => {
    const o1 = await makeOrder(db, base);
    const o2 = await makeOrder(db, base);
    await rejects(
      makeRefund(db, { ...o1, paymentId: o2.paymentId }, [{ sellerOrderId: o1.soA, item: 1000 }]),
      'refunds_payment_order_fk',
    );
  });
  test('an allocation cannot use another order\'s seller order', async () => {
    const o1 = await makeOrder(db, base);
    const o2 = await makeOrder(db, base);
    await rejects(
      makeRefund(db, o1, [{ sellerOrderId: o2.soA, item: 1000 }]),
      'refund_allocations_seller_order_fk',
    );
  });
  test('an allocation cannot claim a different order than its refund', async () => {
    const o1 = await makeOrder(db, base);
    const o2 = await makeOrder(db, base);
    const r = await makeRefund(db, o1, [{ sellerOrderId: o1.soA, item: 1000 }]);
    await rejects(
      db.execute(sql`INSERT INTO refund_allocations (refund_id, order_id, seller_order_id, item_amount_cents, delivery_amount_cents, amount_cents)
                     VALUES (${r.refundId}, ${o2.orderId}, ${o2.soB}, 5, 0, 5)`),
      'refund_allocations_refund_order_fk',
    );
  });
  test('one allocation per seller order per refund', async () => {
    const o = await makeOrder(db, base);
    await rejects(
      makeRefund(db, o, [
        { sellerOrderId: o.soA, item: 1000 },
        { sellerOrderId: o.soA, item: 2000 },
      ]),
      'refund_allocations_refund_seller_order_uq',
    );
  });
  test('allocation arithmetic: amount = item + delivery, commission returned <= item', async () => {
    const o = await makeOrder(db, base);
    const r = await makeRefund(db, o, [{ sellerOrderId: o.soA, item: 1000 }]);
    await rejects(
      db.execute(sql`INSERT INTO refund_allocations (refund_id, order_id, seller_order_id, item_amount_cents, delivery_amount_cents, amount_cents)
                     VALUES (${r.refundId}, ${o.orderId}, ${o.soB}, 100, 50, 100)`),
      'refund_allocations_amount_matches',
    );
    await rejects(makeRefund(db, o, [{ sellerOrderId: o.soB, item: 100, commissionReturned: 101 }]), 'refund_allocations_commission_returned_range');
  });
});

describe('seller ledger ownership', () => {
  const entry = (v: Record<string, unknown>) => db.insert(sellerLedgerEntries).values(v as any);

  test('a sale entry cannot credit a seller who does not own the seller order', async () => {
    const o = await makeOrder(db, base);
    await rejects(
      entry({ sellerId: base.b.sellerId, sellerOrderId: o.soA, type: 'sale', amountCents: 450000 }),
      'ledger_seller_order_seller_fk',
    );
    await entry({ sellerId: base.a.sellerId, sellerOrderId: o.soA, type: 'sale', amountCents: 450000 }); // correct owner
  });
  test('sale / commission / refund entries must name a seller order; adjustments need not', async () => {
    await rejects(entry({ sellerId: base.a.sellerId, type: 'sale', amountCents: 1 }), 'ledger_seller_order_required');
    await entry({ sellerId: base.a.sellerId, type: 'adjustment', amountCents: -500, description: 'manual correction' });
  });
  test('only refund entries carry a refund allocation, and refund entries must carry one', async () => {
    const o = await makeOrder(db, base);
    const r = await makeRefund(db, o, [{ sellerOrderId: o.soA, item: 1000 }]);
    await rejects(
      entry({ sellerId: base.a.sellerId, sellerOrderId: o.soA, type: 'refund', amountCents: -900 }),
      'ledger_refund_allocation_link',
    );
    await rejects(
      entry({ sellerId: base.a.sellerId, sellerOrderId: o.soA, refundAllocationId: r.allocationIds[0], type: 'commission', amountCents: -1 }),
      'ledger_refund_allocation_link',
    );
  });
  test('a refund entry\'s seller order must be its allocation\'s seller order', async () => {
    const o = await makeOrder(db, base);
    const r = await makeRefund(db, o, [{ sellerOrderId: o.soA, item: 1000 }]);
    await rejects(
      entry({ sellerId: base.b.sellerId, sellerOrderId: o.soB, refundAllocationId: r.allocationIds[0], type: 'refund', amountCents: -900 }),
      'ledger_allocation_seller_order_fk',
    );
    // a refund must be a debit
    await rejects(
      entry({ sellerId: base.a.sellerId, sellerOrderId: o.soA, refundAllocationId: r.allocationIds[0], type: 'refund', amountCents: 900 }),
      'ledger_amount_sign',
    );
    await entry({ sellerId: base.a.sellerId, sellerOrderId: o.soA, refundAllocationId: r.allocationIds[0], type: 'refund', amountCents: -900 });
  });
  test('an allocation is posted at most once', async () => {
    const o = await makeOrder(db, base);
    const r = await makeRefund(db, o, [{ sellerOrderId: o.soA, item: 1000 }]);
    const v = { sellerId: base.a.sellerId, sellerOrderId: o.soA, refundAllocationId: r.allocationIds[0], type: 'refund', amountCents: -900 };
    await entry(v);
    await rejects(entry(v), 'ledger_refund_allocation_uq');
  });
  test('sale and commission are posted once per seller order', async () => {
    const o = await makeOrder(db, base);
    const v = (type: string, amountCents: number) => ({ sellerId: base.a.sellerId, sellerOrderId: o.soA, type, amountCents });
    await entry(v('sale', 450000));
    await entry(v('commission', -45000)); // different type: fine
    await rejects(entry(v('sale', 450000)), 'ledger_once_per_seller_order_uq');
    await rejects(entry(v('commission', -45000)), 'ledger_once_per_seller_order_uq');
  });
  test('a zero amount is rejected (zero-value refund allocations get no entry)', async () => {
    const o = await makeOrder(db, base);
    await rejects(entry({ sellerId: base.a.sellerId, sellerOrderId: o.soA, type: 'sale', amountCents: 0 }), 'ledger_amount_non_zero');
    // sign rules: sale credit, commission/refund debit, adjustment either way
    await rejects(entry({ sellerId: base.a.sellerId, sellerOrderId: o.soA, type: 'sale', amountCents: -1 }), 'ledger_amount_sign');
    await rejects(entry({ sellerId: base.a.sellerId, sellerOrderId: o.soA, type: 'commission', amountCents: 1 }), 'ledger_amount_sign');
    await entry({ sellerId: base.a.sellerId, type: 'adjustment', amountCents: 500 });
  });
});

describe('payout claiming and recovery', () => {
  async function ledgerEntry() {
    const o = await makeOrder(db, base);
    const [e] = await db
      .insert(sellerLedgerEntries)
      .values({ sellerId: base.a.sellerId, sellerOrderId: o.soA, type: 'sale', amountCents: 450000 })
      .returning({ id: sellerLedgerEntries.id });
    return e.id;
  }
  const payout = async () =>
    (await db.insert(payouts).values({ sellerId: base.a.sellerId, amountCents: 450000 }).returning({ id: payouts.id }))[0].id;

  test('a ledger entry cannot be claimed by two live payouts', async () => {
    const entryId = await ledgerEntry();
    const p1 = await payout();
    const p2 = await payout();
    await db.insert(payoutItems).values({ payoutId: p1, ledgerEntryId: entryId, sellerId: base.a.sellerId });
    await rejects(db.insert(payoutItems).values({ payoutId: p2, ledgerEntryId: entryId, sellerId: base.a.sellerId }), 'payout_items_live_entry_uq');
  });
  test('a payout cannot claim another seller\'s ledger entry', async () => {
    const entryId = await ledgerEntry(); // seller A's entry
    const pB = (await db.insert(payouts).values({ sellerId: base.b.sellerId, amountCents: 450000 }).returning({ id: payouts.id }))[0].id;
    // claimed as B's: entry belongs to A
    await rejects(db.insert(payoutItems).values({ payoutId: pB, ledgerEntryId: entryId, sellerId: base.b.sellerId }), 'payout_items_entry_seller_fk');
    // claimed as A's: payout belongs to B
    await rejects(db.insert(payoutItems).values({ payoutId: pB, ledgerEntryId: entryId, sellerId: base.a.sellerId }), 'payout_items_payout_seller_fk');
  });
  test('after a cancelled payout releases its items, the entry can be re-claimed and history is kept', async () => {
    const entryId = await ledgerEntry();
    const p1 = await payout();
    const p2 = await payout();
    await db.insert(payoutItems).values({ payoutId: p1, ledgerEntryId: entryId, sellerId: base.a.sellerId });
    await db.update(payoutItems).set({ releasedAt: new Date() }).where(eq(payoutItems.payoutId, p1));
    await db.insert(payoutItems).values({ payoutId: p2, ledgerEntryId: entryId, sellerId: base.a.sellerId });
    const rows = await db.select().from(payoutItems).where(eq(payoutItems.ledgerEntryId, entryId));
    expect(rows.length).toBe(2);
    expect(rows.filter((r) => r.releasedAt === null).length).toBe(1);
  });
});

describe('users', () => {
  test('a user can hold several roles (customer + seller)', async () => {
    const id = await makeUser(db, 'dual');
    await db.execute(sql`INSERT INTO user_roles (user_id, role) VALUES (${id}, 'customer'), (${id}, 'seller')`);
    await rejects(db.execute(sql`INSERT INTO user_roles (user_id, role) VALUES (${id}, 'seller')`), 'user_roles_user_id_role_pk');
  });

  test('staff roles finance and support exist; unknown roles are rejected', async () => {
    const id = await makeUser(db, 'staff');
    await db.execute(sql`INSERT INTO user_roles (user_id, role) VALUES (${id}, 'finance'), (${id}, 'support')`);
    await rejects(db.execute(sql`INSERT INTO user_roles (user_id, role) VALUES (${id}, 'superadmin')`), 'user_role');
  });
});

describe('product variants: SKUs are unique per seller', () => {
  const variant = (productId: string, sellerId: string, sku: string | null) => ({ productId, sellerId, sku, name: 'v', priceCents: 100 });

  test('two sellers may use the same SKU', async () => {
    await db.insert(productVariants).values(variant(base.a.productId, base.a.sellerId, 'POT-6'));
    await db.insert(productVariants).values(variant(base.b.productId, base.b.sellerId, 'POT-6'));
  });

  test('one seller cannot reuse a SKU, even across different products', async () => {
    await db.insert(productVariants).values(variant(base.a.productId, base.a.sellerId, 'DUP-1'));
    await rejects(db.insert(productVariants).values(variant(base.a.productId, base.a.sellerId, 'DUP-1')), 'variants_seller_sku_uq');
    const [other] = await db
      .insert(products)
      .values({ sellerId: base.a.sellerId, categoryId: base.categoryId, title: 'Second', slug: `second-${Math.random().toString(36).slice(2)}`, status: 'active' })
      .returning({ id: products.id });
    await rejects(db.insert(productVariants).values(variant(other.id, base.a.sellerId, 'DUP-1')), 'variants_seller_sku_uq');
  });

  test('SKU is optional: many variants may have none', async () => {
    await db.insert(productVariants).values([variant(base.a.productId, base.a.sellerId, null), variant(base.a.productId, base.a.sellerId, null)]);
  });

  test('a variant cannot claim a different seller than its product has', async () => {
    await rejects(db.insert(productVariants).values(variant(base.a.productId, base.b.sellerId, 'LIE-1')), 'variants_product_seller_fk');
  });
});
