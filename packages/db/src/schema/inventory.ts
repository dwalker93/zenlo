import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
  unique,
} from 'drizzle-orm/pg-core';
import { createdAt, pk, updatedAtNow } from './_helpers';
import { productVariants } from './catalog';
import { inventoryMovementType } from './enums';
import { sellerLocations, users } from './identity';

// Reserve stock atomically at checkout:
//   UPDATE inventory SET reserved_qty = reserved_qty + :n
//   WHERE id = :id AND on_hand_qty - reserved_qty >= :n
// 0 rows updated = out of stock. Release/consume ONLY inside a guarded state
// transition. Lock inventory rows in id order to avoid deadlocks.
export const inventory = pgTable(
  'inventory',
  {
    id: pk(),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id),
    locationId: uuid('location_id')
      .notNull()
      .references(() => sellerLocations.id),
    onHandQty: integer('on_hand_qty').notNull().default(0),
    reservedQty: integer('reserved_qty').notNull().default(0),
    updatedAt: updatedAtNow(),
  },
  (t) => [
    // Also the target of the order_items composite FK. A UNIQUE CONSTRAINT (not
    // a unique index): drizzle-kit creates foreign keys before indexes, so FK
    // targets must be constraints created inside CREATE TABLE.
    unique('inventory_variant_location_uq').on(t.variantId, t.locationId),
    index('inventory_location_idx').on(t.locationId),
    check(
      'inventory_qty_bounds',
      sql`${t.onHandQty} >= 0 AND ${t.reservedQty} >= 0 AND ${t.reservedQty} <= ${t.onHandQty}`,
    ),
  ],
);

// Append-only log of on_hand_qty changes.
export const inventoryMovements = pgTable(
  'inventory_movements',
  {
    id: pk(),
    inventoryId: uuid('inventory_id')
      .notNull()
      .references(() => inventory.id),
    movementType: inventoryMovementType('movement_type').notNull(),
    quantityDelta: integer('quantity_delta').notNull(),
    referenceType: varchar('reference_type', { length: 60 }), // seller_order, return, ...
    referenceId: uuid('reference_id'),
    note: text('note'),
    createdBy: uuid('created_by').references(() => users.id), // NULL = system
    createdAt: createdAt(),
  },
  (t) => [
    index('inventory_movements_inventory_created_idx').on(t.inventoryId, t.createdAt),
    index('inventory_movements_reference_idx').on(t.referenceType, t.referenceId),
  ],
);
