import { pgEnum } from 'drizzle-orm/pg-core';

// Staff roles: admin = everything; finance = money operations; support = customer service. Permissions live in code (@workspace/api permissions.ts).
export const userRole = pgEnum('user_role', ['customer', 'seller', 'admin', 'finance', 'support']);
export const sellerStatus = pgEnum('seller_status', [
  'pending',
  'approved',
  'suspended',
  'rejected',
]);
export const productStatus = pgEnum('product_status', ['draft', 'active', 'archived']);
export const attributeDataType = pgEnum('attribute_data_type', [
  'text',
  'number',
  'select',
  'boolean',
]);
// Movements record changes to on_hand_qty only.
export const inventoryMovementType = pgEnum('inventory_movement_type', [
  'restock',
  'sale',
  'adjustment',
  'return',
  'damaged',
  'transfer',
]);

// Fulfilment lifecycle ONLY. Refund state is derived from refunded_cents.
export const orderStatus = pgEnum('order_status', [
  'pending_payment',
  'processing',
  'partially_fulfilled',
  'completed',
  'cancelled',
]);
export const sellerOrderStatus = pgEnum('seller_order_status', [
  'pending',
  'processing',
  'partially_shipped',
  'shipped',
  'delivered',
  'cancelled',
]);
export const paymentMethod = pgEnum('payment_method', ['bank_transfer', 'payhere']);
export const paymentStatus = pgEnum('payment_status', [
  'pending',
  'processing',
  'succeeded',
  'failed',
  'cancelled',
]);
// Capacity-holding statuses (count against refund caps): approved, processing, succeeded.
// requested / failed / rejected hold no capacity.
export const refundStatus = pgEnum('refund_status', [
  'requested',
  'approved',
  'processing',
  'succeeded',
  'failed',
  'rejected',
]);
export const shipmentStatus = pgEnum('shipment_status', [
  'pending',
  'booked',
  'in_transit',
  'delivered',
  'failed',
  'returned',
  'cancelled',
]);
export const payoutStatus = pgEnum('payout_status', [
  'pending',
  'processing',
  'paid',
  'failed',
  'cancelled',
]);
export const payoutEntryType = pgEnum('payout_entry_type', [
  'sale',
  'commission',
  'refund',
  'adjustment',
]);
export const badgeAudience = pgEnum('badge_audience', ['customer', 'seller']);
export const messageType = pgEnum('message_type', ['text', 'system']);

// Statuses that hold refund capacity (use in cap queries).
export const REFUND_HOLDING_STATUSES = ['approved', 'processing', 'succeeded'] as const;
