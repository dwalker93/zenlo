import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { inventory, inventoryMovements } from '@workspace/db/schema';
import type { Db } from './types';

export interface StockLine {
  variantId: string;
  locationId: string;
  quantity: number;
  sellerOrderId?: string;
}

/** Sum quantities per inventory row (variant + location). */
function perRow(lines: StockLine[]) {
  const m = new Map<string, { variantId: string; locationId: string; qty: number; sellerOrderId?: string }>();
  for (const l of lines) {
    const k = `${l.variantId}|${l.locationId}`;
    const cur = m.get(k);
    if (cur) cur.qty += l.quantity;
    else m.set(k, { variantId: l.variantId, locationId: l.locationId, qty: l.quantity, sellerOrderId: l.sellerOrderId });
  }
  return [...m.values()];
}

/**
 * Lock the inventory rows for these lines in id order (deadlock-free: every
 * transaction that touches several stock rows takes the locks in the same order).
 * Returns the rows keyed by "variantId|locationId".
 */
export async function lockInventoryRows(tx: Db, variantIdList: string[]) {
  const variantIds = [...new Set(variantIdList)];
  const rows = await tx
    .select()
    .from(inventory)
    .where(inArray(inventory.variantId, variantIds))
    .orderBy(asc(inventory.id))
    .for('update');
  return new Map(rows.map((r) => [`${r.variantId}|${r.locationId}`, r]));
}

/** Give reserved stock back. Call ONLY from the transaction that won a guarded status change. */
export async function releaseReserved(tx: Db, lines: StockLine[]) {
  const rows = perRow(lines);
  const locked = await lockInventoryRows(tx, rows.map((r) => r.variantId));
  for (const r of rows) {
    const inv = locked.get(`${r.variantId}|${r.locationId}`);
    if (!inv) throw new Error(`inventory row missing for ${r.variantId}@${r.locationId}`);
    const done = await tx
      .update(inventory)
      .set({ reservedQty: sql`${inventory.reservedQty} - ${r.qty}`, updatedAt: new Date() })
      .where(and(eq(inventory.id, inv.id), sql`${inventory.reservedQty} >= ${r.qty}`))
      .returning({ id: inventory.id });
    if (done.length !== 1) throw new Error(`reserved_qty underflow releasing ${r.qty} on inventory ${inv.id}`);
  }
}

/** Turn reservations into sales: on_hand and reserved both drop; one 'sale' movement per seller order and row. */
export async function consumeReserved(tx: Db, lines: StockLine[]) {
  const bySo = new Map<string, StockLine[]>();
  for (const l of lines) {
    const k = l.sellerOrderId ?? '';
    bySo.set(k, [...(bySo.get(k) ?? []), l]);
  }
  const all = perRow(lines);
  const locked = await lockInventoryRows(tx, all.map((r) => r.variantId));
  // All rows are already locked (in id order) above, so the update order is irrelevant.
  const ordered = [...bySo.entries()].flatMap(([so, ls]) =>
    perRow(ls).map((r) => ({ ...r, so, inv: locked.get(`${r.variantId}|${r.locationId}`)! })),
  );
  for (const r of ordered) {
    if (!r.inv) throw new Error(`inventory row missing for ${r.variantId}@${r.locationId}`);
    const done = await tx
      .update(inventory)
      .set({
        onHandQty: sql`${inventory.onHandQty} - ${r.qty}`,
        reservedQty: sql`${inventory.reservedQty} - ${r.qty}`,
        updatedAt: new Date(),
      })
      .where(and(eq(inventory.id, r.inv.id), sql`${inventory.reservedQty} >= ${r.qty}`))
      .returning({ id: inventory.id });
    if (done.length !== 1) throw new Error(`reserved_qty underflow consuming ${r.qty} on inventory ${r.inv.id}`);
    await tx.insert(inventoryMovements).values({
      inventoryId: r.inv.id,
      movementType: 'sale',
      quantityDelta: -r.qty,
      referenceType: r.so ? 'seller_order' : null,
      referenceId: r.so || null,
    });
  }
}

/** Put sold stock back on the shelf (seller order cancelled after payment): on_hand += q, one 'return' movement per row. */
export async function restockOnHand(tx: Db, lines: StockLine[]) {
  const rows = perRow(lines);
  const locked = await lockInventoryRows(tx, rows.map((r) => r.variantId));
  for (const r of rows) {
    const inv = locked.get(`${r.variantId}|${r.locationId}`);
    if (!inv) throw new Error(`inventory row missing for ${r.variantId}@${r.locationId}`);
    await tx
      .update(inventory)
      .set({ onHandQty: sql`${inventory.onHandQty} + ${r.qty}`, updatedAt: new Date() })
      .where(eq(inventory.id, inv.id));
    await tx.insert(inventoryMovements).values({
      inventoryId: inv.id,
      movementType: 'return',
      quantityDelta: r.qty,
      referenceType: r.sellerOrderId ? 'seller_order' : null,
      referenceId: r.sellerOrderId ?? null,
    });
  }
}
