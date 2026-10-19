import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { inventory, inventoryMovements, orderItems, orders, payments, productVariants, sellerOrders } from '@workspace/db/schema';
import { InvalidOrderError, MAX_QUANTITY, OutOfStockError, VariantUnavailableError, placeOrder } from '../src';
import { createPgTestDb, seed, shipping, type PgTest } from './pg';

let pg: PgTest;
beforeAll(async () => { pg = await createPgTestDb(); });
afterAll(async () => { await pg.close(); });

const stockOf = async (id: string) => {
  const [r] = await pg.db.select().from(inventory).where(eq(inventory.id, id));
  return r;
};
const count = async (table: any) => Number((await pg.db.select({ n: sql<number>`count(*)` }).from(table))[0].n);

describe('placeOrder', () => {
  test('splits by seller, prices, reserves stock and creates a pending payment', async () => {
    const { buyerId, sellers } = await seed(pg.db, { stock: 10 });
    const [a, b] = sellers;
    const placed = await placeOrder(pg.db, {
      buyerId,
      paymentMethod: 'bank_transfer',
      shipping,
      items: [{ variantId: a.variantId, quantity: 2 }, { variantId: b.variantId, quantity: 1 }],
      calculateDeliveryFeeCents: () => 25000,
    });
    expect(placed.subtotalCents).toBe(300000);
    expect(placed.deliveryFeeCents).toBe(50000);
    expect(placed.totalCents).toBe(350000);

    const sos = await pg.db.select().from(sellerOrders).where(eq(sellerOrders.orderId, placed.orderId));
    expect(sos).toHaveLength(2);
    const so = sos.find((s) => s.sellerId === a.sellerId)!;
    expect(so.subtotalCents).toBe(200000);
    expect(so.commissionCents).toBe(20000); // 10% default
    expect(so.sellerEarningCents).toBe(180000);

    expect((await stockOf(a.inventoryId)).reservedQty).toBe(2);
    expect((await stockOf(b.inventoryId)).reservedQty).toBe(1);
    expect((await stockOf(a.inventoryId)).onHandQty).toBe(10); // not sold yet

    const [pay] = await pg.db.select().from(payments).where(eq(payments.orderId, placed.orderId));
    expect(pay.status).toBe('pending');
    expect(pay.amountCents).toBe(350000);
    const [ord] = await pg.db.select().from(orders).where(eq(orders.id, placed.orderId));
    expect(ord.status).toBe('pending_payment');
    expect(ord.paymentDueAt!.getTime()).toBeGreaterThan(Date.now());
  });

  test('merges duplicate lines for the same variant', async () => {
    const { buyerId, sellers } = await seed(pg.db, { sellers: 1 });
    const v = sellers[0].variantId;
    const placed = await placeOrder(pg.db, {
      buyerId, paymentMethod: 'payhere', shipping,
      items: [{ variantId: v, quantity: 1 }, { variantId: v, quantity: 2 }],
    });
    expect(placed.subtotalCents).toBe(300000);
    const items = await pg.db.select().from(orderItems);
    expect(items.filter((i) => i.variantId === v)).toHaveLength(1);
    expect((await stockOf(sellers[0].inventoryId)).reservedQty).toBe(3);
  });

  test('a failure on a later line rolls back every reservation and row', async () => {
    const { buyerId, sellers } = await seed(pg.db, { stock: 5 });
    const before = { orders: await count(orders), items: await count(orderItems) };
    await expect(
      placeOrder(pg.db, {
        buyerId, paymentMethod: 'bank_transfer', shipping,
        items: [{ variantId: sellers[0].variantId, quantity: 3 }, { variantId: sellers[1].variantId, quantity: 6 }],
      }),
    ).rejects.toBeInstanceOf(OutOfStockError);
    expect((await stockOf(sellers[0].inventoryId)).reservedQty).toBe(0);
    expect((await stockOf(sellers[1].inventoryId)).reservedQty).toBe(0);
    expect(await count(orders)).toBe(before.orders);
    expect(await count(orderItems)).toBe(before.items);
  });

  test('rejects missing variants and bad quantities', async () => {
    const { buyerId } = await seed(pg.db, { sellers: 1 });
    await expect(
      placeOrder(pg.db, { buyerId, paymentMethod: 'bank_transfer', shipping, items: [{ variantId: '00000000-0000-0000-0000-000000000000', quantity: 1 }] }),
    ).rejects.toBeInstanceOf(VariantUnavailableError);
    await expect(
      placeOrder(pg.db, { buyerId, paymentMethod: 'bank_transfer', shipping, items: [] }),
    ).rejects.toThrow('no items');
  });
});

describe('checkout under concurrency (real Postgres row locks)', () => {
  test('50 buyers race for 10 units: exactly 10 win, none oversold', async () => {
    const { buyerId, sellers } = await seed(pg.db, { stock: 10, sellers: 1 });
    const v = sellers[0].variantId;
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () =>
        placeOrder(pg.db, { buyerId, paymentMethod: 'bank_transfer', shipping, items: [{ variantId: v, quantity: 1 }] }),
      ),
    );
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(won).toHaveLength(10);
    expect(lost).toHaveLength(40);
    expect(lost.every((r) => r.reason instanceof OutOfStockError)).toBe(true);
    const s = await stockOf(sellers[0].inventoryId);
    expect(s.reservedQty).toBe(10);
    expect(s.onHandQty).toBe(10);
  });

  test('mixed quantities never exceed stock', async () => {
    const { buyerId, sellers } = await seed(pg.db, { stock: 20, sellers: 1 });
    const v = sellers[0].variantId;
    const qtys = Array.from({ length: 40 }, (_, i) => (i % 3) + 1);
    const results = await Promise.allSettled(
      qtys.map((q) => placeOrder(pg.db, { buyerId, paymentMethod: 'bank_transfer', shipping, items: [{ variantId: v, quantity: q }] })),
    );
    const sold = results.reduce((sum, r, i) => sum + (r.status === 'fulfilled' ? qtys[i] : 0), 0);
    const s = await stockOf(sellers[0].inventoryId);
    expect(s.reservedQty).toBe(sold);
    expect(sold).toBeLessThanOrEqual(20);
    expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason instanceof OutOfStockError)).toBe(true);
  });

  test('multi-seller carts in opposite item order do not deadlock', async () => {
    const { buyerId, sellers } = await seed(pg.db, { stock: 6, sellers: 2 });
    const [a, b] = sellers;
    const jobs = Array.from({ length: 24 }, (_, i) =>
      placeOrder(pg.db, {
        buyerId, paymentMethod: 'bank_transfer', shipping,
        items: i % 2 === 0
          ? [{ variantId: a.variantId, quantity: 1 }, { variantId: b.variantId, quantity: 1 }]
          : [{ variantId: b.variantId, quantity: 1 }, { variantId: a.variantId, quantity: 1 }],
      }),
    );
    const results = await Promise.allSettled(jobs);
    const failures = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    // only out-of-stock is acceptable; a deadlock error would fail this
    expect(failures.every((r) => r.reason instanceof OutOfStockError)).toBe(true);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(6);
    expect((await stockOf(a.inventoryId)).reservedQty).toBe(6);
    expect((await stockOf(b.inventoryId)).reservedQty).toBe(6);
  });
});



describe('checkout bounds', () => {
  const base = { paymentMethod: 'bank_transfer' as const, shipping };

  test('quantities outside the integer column range or not integers are rejected before any write', async () => {
    const { buyerId, sellers } = await seed(pg.db, { sellers: 1 });
    const v = sellers[0].variantId;
    for (const quantity of [0, -1, 1.5, Number.NaN, MAX_QUANTITY + 1, 2 ** 40]) {
      await expect(placeOrder(pg.db, { buyerId, ...base, items: [{ variantId: v, quantity }] })).rejects.toBeInstanceOf(InvalidOrderError);
    }
    // merged duplicate lines may not overflow either
    await expect(
      placeOrder(pg.db, { buyerId, ...base, items: [{ variantId: v, quantity: MAX_QUANTITY }, { variantId: v, quantity: 1 }] }),
    ).rejects.toBeInstanceOf(InvalidOrderError);
    expect((await stockOf(sellers[0].inventoryId)).reservedQty).toBe(0);
  });

  test('the largest legal quantity is a normal out-of-stock, not a database error', async () => {
    const { buyerId, sellers } = await seed(pg.db, { sellers: 1 });
    await expect(
      placeOrder(pg.db, { buyerId, ...base, items: [{ variantId: sellers[0].variantId, quantity: MAX_QUANTITY }] }),
    ).rejects.toBeInstanceOf(OutOfStockError);
  });

  test('line totals and subtotals beyond the safe-integer range are rejected and nothing stays reserved', async () => {
    const { buyerId, sellers } = await seed(pg.db, { sellers: 1, stock: 100_000 });
    const [s] = sellers;
    await pg.db.update(productVariants).set({ priceCents: 10_000_000_000_000 }).where(eq(productVariants.id, s.variantId)); // 1e13
    const before = await count(orders);
    await expect(
      placeOrder(pg.db, { buyerId, ...base, items: [{ variantId: s.variantId, quantity: 10_000 }] }), // 1e17 > 2^53
    ).rejects.toBeInstanceOf(InvalidOrderError);
    expect((await stockOf(s.inventoryId)).reservedQty).toBe(0);
    expect(await count(orders)).toBe(before);
    // a legal line is fine, but a huge delivery fee pushes the total over the limit
    await expect(
      placeOrder(pg.db, { buyerId, ...base, items: [{ variantId: s.variantId, quantity: 1 }], calculateDeliveryFeeCents: () => Number.MAX_SAFE_INTEGER }),
    ).rejects.toBeInstanceOf(InvalidOrderError);
    for (const fee of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      await expect(
        placeOrder(pg.db, { buyerId, ...base, items: [{ variantId: s.variantId, quantity: 1 }], calculateDeliveryFeeCents: () => fee }),
      ).rejects.toBeInstanceOf(InvalidOrderError);
    }
    expect((await stockOf(s.inventoryId)).reservedQty).toBe(0);
  });
});
