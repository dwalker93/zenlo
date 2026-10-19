import { relations } from "drizzle-orm"

import {
  productImages,
  productVariants,
  products,
  categories,
  attributeDefinitions,
} from "./catalog"
import {
  conversations,
  messages,
  reviews,
  userBadges,
  userStats,
} from "./engagement"
import {
  addresses,
  badges,
  sellerLocations,
  sellerPayoutAccounts,
  sellerProfiles,
  userRoles,
  users,
} from "./identity"
import { inventory, inventoryMovements } from "./inventory"
import { orderItems, orders, sellerOrders } from "./orders"
import { payments, shipmentEvents, shipments } from "./payments"
import { refundAllocations, refunds } from "./refunds"
import { payoutItems, payouts, sellerLedgerEntries } from "./settlement"
import { cartItems, carts } from "./shopping"

export const usersRelations = relations(users, ({ one, many }) => ({
  roles: many(userRoles),
  sellerProfile: one(sellerProfiles),
  stats: one(userStats),
  equippedBadge: one(badges, {
    fields: [users.equippedBadgeId],
    references: [badges.id],
  }),
  addresses: many(addresses),
  orders: many(orders),
  badges: many(userBadges),
}))

export const userRolesRelations = relations(userRoles, ({ one }) => ({
  user: one(users, { fields: [userRoles.userId], references: [users.id] }),
}))

export const sellerProfilesRelations = relations(
  sellerProfiles,
  ({ one, many }) => ({
    user: one(users, {
      fields: [sellerProfiles.userId],
      references: [users.id],
    }),
    payoutAccounts: many(sellerPayoutAccounts),
    locations: many(sellerLocations),
    products: many(products),
    sellerOrders: many(sellerOrders),
    ledgerEntries: many(sellerLedgerEntries),
    payouts: many(payouts),
  })
)

export const sellerPayoutAccountsRelations = relations(
  sellerPayoutAccounts,
  ({ one }) => ({
    seller: one(sellerProfiles, {
      fields: [sellerPayoutAccounts.sellerId],
      references: [sellerProfiles.id],
    }),
  })
)

export const sellerLocationsRelations = relations(
  sellerLocations,
  ({ one, many }) => ({
    seller: one(sellerProfiles, {
      fields: [sellerLocations.sellerId],
      references: [sellerProfiles.id],
    }),
    inventory: many(inventory),
  })
)

export const addressesRelations = relations(addresses, ({ one }) => ({
  user: one(users, { fields: [addresses.userId], references: [users.id] }),
}))

export const categoriesRelations = relations(categories, ({ one, many }) => ({
  parent: one(categories, {
    fields: [categories.parentId],
    references: [categories.id],
    relationName: "category_tree",
  }),
  children: many(categories, { relationName: "category_tree" }),
  products: many(products),
  attributeDefinitions: many(attributeDefinitions),
}))

export const attributeDefinitionsRelations = relations(
  attributeDefinitions,
  ({ one }) => ({
    category: one(categories, {
      fields: [attributeDefinitions.categoryId],
      references: [categories.id],
    }),
  })
)

export const productsRelations = relations(products, ({ one, many }) => ({
  seller: one(sellerProfiles, {
    fields: [products.sellerId],
    references: [sellerProfiles.id],
  }),
  category: one(categories, {
    fields: [products.categoryId],
    references: [categories.id],
  }),
  variants: many(productVariants),
  images: many(productImages),
  reviews: many(reviews),
}))

export const productVariantsRelations = relations(
  productVariants,
  ({ one, many }) => ({
    product: one(products, {
      fields: [productVariants.productId],
      references: [products.id],
    }),
    inventory: many(inventory),
  })
)

export const productImagesRelations = relations(productImages, ({ one }) => ({
  product: one(products, {
    fields: [productImages.productId],
    references: [products.id],
  }),
}))

export const inventoryRelations = relations(inventory, ({ one, many }) => ({
  variant: one(productVariants, {
    fields: [inventory.variantId],
    references: [productVariants.id],
  }),
  location: one(sellerLocations, {
    fields: [inventory.locationId],
    references: [sellerLocations.id],
  }),
  movements: many(inventoryMovements),
}))

export const inventoryMovementsRelations = relations(
  inventoryMovements,
  ({ one }) => ({
    inventory: one(inventory, {
      fields: [inventoryMovements.inventoryId],
      references: [inventory.id],
    }),
  })
)

export const cartsRelations = relations(carts, ({ one, many }) => ({
  user: one(users, { fields: [carts.userId], references: [users.id] }),
  items: many(cartItems),
}))

export const cartItemsRelations = relations(cartItems, ({ one }) => ({
  cart: one(carts, { fields: [cartItems.cartId], references: [carts.id] }),
  variant: one(productVariants, {
    fields: [cartItems.variantId],
    references: [productVariants.id],
  }),
}))

export const ordersRelations = relations(orders, ({ one, many }) => ({
  buyer: one(users, { fields: [orders.buyerId], references: [users.id] }),
  sellerOrders: many(sellerOrders),
  payments: many(payments),
  refunds: many(refunds),
}))

export const sellerOrdersRelations = relations(
  sellerOrders,
  ({ one, many }) => ({
    order: one(orders, {
      fields: [sellerOrders.orderId],
      references: [orders.id],
    }),
    seller: one(sellerProfiles, {
      fields: [sellerOrders.sellerId],
      references: [sellerProfiles.id],
    }),
    items: many(orderItems),
    shipments: many(shipments),
    refundAllocations: many(refundAllocations),
    ledgerEntries: many(sellerLedgerEntries),
  })
)

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  sellerOrder: one(sellerOrders, {
    fields: [orderItems.sellerOrderId],
    references: [sellerOrders.id],
  }),
  variant: one(productVariants, {
    fields: [orderItems.variantId],
    references: [productVariants.id],
  }),
}))

export const paymentsRelations = relations(payments, ({ one, many }) => ({
  order: one(orders, { fields: [payments.orderId], references: [orders.id] }),
  refunds: many(refunds),
}))

export const shipmentsRelations = relations(shipments, ({ one, many }) => ({
  sellerOrder: one(sellerOrders, {
    fields: [shipments.sellerOrderId],
    references: [sellerOrders.id],
  }),
  pickupLocation: one(sellerLocations, {
    fields: [shipments.pickupLocationId],
    references: [sellerLocations.id],
  }),
  events: many(shipmentEvents),
}))

export const shipmentEventsRelations = relations(shipmentEvents, ({ one }) => ({
  shipment: one(shipments, {
    fields: [shipmentEvents.shipmentId],
    references: [shipments.id],
  }),
}))

export const refundsRelations = relations(refunds, ({ one, many }) => ({
  order: one(orders, { fields: [refunds.orderId], references: [orders.id] }),
  payment: one(payments, {
    fields: [refunds.paymentId],
    references: [payments.id],
  }),
  allocations: many(refundAllocations),
}))

export const refundAllocationsRelations = relations(
  refundAllocations,
  ({ one }) => ({
    refund: one(refunds, {
      fields: [refundAllocations.refundId],
      references: [refunds.id],
    }),
    sellerOrder: one(sellerOrders, {
      fields: [refundAllocations.sellerOrderId],
      references: [sellerOrders.id],
    }),
    ledgerEntry: one(sellerLedgerEntries),
  })
)

export const sellerLedgerEntriesRelations = relations(
  sellerLedgerEntries,
  ({ one, many }) => ({
    seller: one(sellerProfiles, {
      fields: [sellerLedgerEntries.sellerId],
      references: [sellerProfiles.id],
    }),
    sellerOrder: one(sellerOrders, {
      fields: [sellerLedgerEntries.sellerOrderId],
      references: [sellerOrders.id],
    }),
    refundAllocation: one(refundAllocations, {
      fields: [sellerLedgerEntries.refundAllocationId],
      references: [refundAllocations.id],
    }),
    payoutItems: many(payoutItems),
  })
)

export const payoutsRelations = relations(payouts, ({ one, many }) => ({
  seller: one(sellerProfiles, {
    fields: [payouts.sellerId],
    references: [sellerProfiles.id],
  }),
  items: many(payoutItems),
}))

export const payoutItemsRelations = relations(payoutItems, ({ one }) => ({
  payout: one(payouts, {
    fields: [payoutItems.payoutId],
    references: [payouts.id],
  }),
  ledgerEntry: one(sellerLedgerEntries, {
    fields: [payoutItems.ledgerEntryId],
    references: [sellerLedgerEntries.id],
  }),
}))

export const reviewsRelations = relations(reviews, ({ one }) => ({
  product: one(products, {
    fields: [reviews.productId],
    references: [products.id],
  }),
  buyer: one(users, { fields: [reviews.buyerId], references: [users.id] }),
  orderItem: one(orderItems, {
    fields: [reviews.orderItemId],
    references: [orderItems.id],
  }),
}))

export const conversationsRelations = relations(
  conversations,
  ({ one, many }) => ({
    buyer: one(users, {
      fields: [conversations.buyerId],
      references: [users.id],
    }),
    seller: one(sellerProfiles, {
      fields: [conversations.sellerId],
      references: [sellerProfiles.id],
    }),
    messages: many(messages),
  })
)

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
  sender: one(users, { fields: [messages.senderId], references: [users.id] }),
  product: one(products, {
    fields: [messages.productId],
    references: [products.id],
  }),
}))

export const userBadgesRelations = relations(userBadges, ({ one }) => ({
  user: one(users, { fields: [userBadges.userId], references: [users.id] }),
  badge: one(badges, { fields: [userBadges.badgeId], references: [badges.id] }),
}))

export const userStatsRelations = relations(userStats, ({ one }) => ({
  user: one(users, { fields: [userStats.userId], references: [users.id] }),
}))
