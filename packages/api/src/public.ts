import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { orders, sellerOrders, users } from '@workspace/db/schema';
import { cancelSellerOrder, createPaymentAttempt, placeOrder, recordShipment, type Db } from '@workspace/domain';
import { principalOf, requireRole, requireUser, type Authenticate, type Env } from './auth';
import type { PublicConfig } from './config';
import { HttpError, jsonBody, onError } from './http';
import { requireTrustedOrigin } from './origin';
import { checkoutFields, type CheckoutCustomer } from './payhere';
import { money, placeOrderBody, uuid } from './shared';

export interface PublicAppDeps {
  db: Db;
  authenticate: Authenticate;
  config: PublicConfig;
}

/** Customers and sellers. Contains no staff, webhook or cron routes. */
export function createPublicApp(deps: PublicAppDeps) {
  const { db, config } = deps;
  const app = new Hono<Env>();
  app.onError(onError);
  if (config.trustedOrigins?.length) app.use('*', requireTrustedOrigin(config.trustedOrigins));
  const user = requireUser(deps.authenticate);

  async function emailOf(userId: string) {
    const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
    if (!u?.email) throw new HttpError(422, 'email_required', 'An email address is required for card payments');
    return u.email;
  }

  app.get('/health', (c) => c.json({ ok: true }));

  const payhereCheckout = (p: { paymentId: string; amountCents: number; currency: string; orderNumber: string; customer: CheckoutCustomer }) =>
    checkoutFields({
      merchantId: config.payhere.merchantId,
      merchantSecret: config.payhere.merchantSecret,
      paymentId: p.paymentId,
      amountCents: p.amountCents,
      currency: p.currency,
      itemsLabel: `Order ${p.orderNumber}`,
      returnUrl: `${config.publicBaseUrl}/orders/${p.orderNumber}`,
      cancelUrl: `${config.publicBaseUrl}/orders/${p.orderNumber}?payment=cancelled`,
      notifyUrl: `${config.publicBaseUrl}/api/webhooks/payhere`,
      sandbox: config.payhere.sandbox,
      customer: p.customer,
    });

  // ---------- buyer ----------
  app.post('/orders', user, requireRole('customer'), async (c) => {
    const body = await jsonBody(c, placeOrderBody);
    const buyerId = principalOf(c).userId;
    const placed = await placeOrder(db, { buyerId, ...body });
    const sh = body.shipping;
    const customer: CheckoutCustomer | undefined =
      body.paymentMethod === 'payhere'
        ? { fullName: sh.fullName, email: await emailOf(buyerId), phone: sh.phone, address: [sh.line1, sh.line2].filter(Boolean).join(', '), city: sh.city }
        : undefined;
    return c.json(
      {
        ...placed,
        payhere: customer ? payhereCheckout({ paymentId: placed.paymentId, amountCents: placed.totalCents, currency: 'LKR', orderNumber: placed.orderNumber, customer }) : undefined,
      },
      201,
    );
  });

  app.post('/orders/:orderId/payments', user, requireRole('customer'), async (c) => {
    const orderId = uuid.parse(c.req.param('orderId'));
    const { method } = await jsonBody(c, z.object({ method: z.enum(['bank_transfer', 'payhere']) }));
    const [o] = await db.select().from(orders).where(and(eq(orders.id, orderId), eq(orders.buyerId, principalOf(c).userId)));
    if (!o) throw new HttpError(404, 'order_not_found', 'Order not found'); // also hides other people's orders
    const { paymentId } = await createPaymentAttempt(db, orderId, method);
    const customer: CheckoutCustomer | undefined =
      method === 'payhere'
        ? { fullName: o.shipFullName, email: await emailOf(o.buyerId), phone: o.shipPhone, address: [o.shipLine1, o.shipLine2].filter(Boolean).join(', '), city: o.shipCity }
        : undefined;
    return c.json({ paymentId, payhere: customer ? payhereCheckout({ paymentId, amountCents: o.totalCents, currency: o.currency, orderNumber: o.orderNumber, customer }) : undefined }, 201);
  });

  // ---------- seller ----------
  const seller = [user, requireRole('seller')] as const;
  async function ownSellerOrder(c: Parameters<typeof principalOf>[0], id: string) {
    const p = principalOf(c);
    const [so] = await db.select({ sellerId: sellerOrders.sellerId }).from(sellerOrders).where(eq(sellerOrders.id, id));
    if (!so || !p.sellerId || so.sellerId !== p.sellerId) throw new HttpError(404, 'seller_order_not_found', 'Seller order not found');
  }
  app.post('/seller/orders/:id/ship', ...seller, async (c) => {
    const id = uuid.parse(c.req.param('id'));
    await ownSellerOrder(c, id);
    const b = await jsonBody(c, z.object({ pickupLocationId: uuid, trackingNumber: z.string().min(1).max(80).nullish(), feeCents: money.optional(), complete: z.boolean().optional() }));
    return c.json(await recordShipment(db, { sellerOrderId: id, actorId: principalOf(c).userId, ...b }));
  });
  app.post('/seller/orders/:id/cancel', ...seller, async (c) => {
    const id = uuid.parse(c.req.param('id'));
    await ownSellerOrder(c, id);
    return c.json(await cancelSellerOrder(db, id, { cancelledBy: principalOf(c).userId }));
  });

  return app;
}
