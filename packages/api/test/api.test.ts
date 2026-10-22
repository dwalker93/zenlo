import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { auditLogs, inventory, orders, payments, refunds, payouts, sellerLedgerEntries, sellerOrders, sellerProfiles, shipments, users } from '@workspace/db/schema';
import { cancelUnpaidOrder, ensureSystemActor, placeOrder } from '@workspace/domain';
import { createApp, signCourierBody, type ApiConfig, type Principal } from '../src';
import { addPayoutAccount, createPgTestDb, markShipped, paidOrder, seed, shipping, type PgTest } from '../../domain/test/pg';

const config: ApiConfig = {
  payhere: { merchantId: '121XXXX', merchantSecret: 'test-secret', sandbox: true },
  courierWebhookSecret: 'courier-secret',
  cronSecret: 'cron-secret',
  autoVerifyDelivery: false,
  publicBaseUrl: 'https://shop.example.test',
  publicTrustedOrigins: ['https://shop.example.test'],
  adminTrustedOrigins: ['https://admin.example.test'],
  requireMfa: true,
  dualControlThresholdCents: 5_000_000,
};
let pg: PgTest;
let app: ReturnType<typeof createApp>;
let autoApp: ReturnType<typeof createApp>;
let staffId: string; // a real users row: audit/verified_by/confirmed_by columns are foreign keys
const authenticate = async (req: Request): Promise<Principal | null> => {
  const h = req.headers.get('x-principal');
  return h ? (JSON.parse(h) as Principal) : null;
};
beforeAll(async () => {
  pg = await createPgTestDb();
  [{ id: staffId }] = await pg.db.insert(users).values({ email: 'staff@example.test', name: 'Staff' }).returning({ id: users.id });
  adminP = { userId: staffId, roles: ['admin'], mfaVerified: true };
  app = createApp({ db: pg.db, authenticate, config });
  autoApp = createApp({ db: pg.db, authenticate, config: { ...config, autoVerifyDelivery: true } });
});
afterAll(async () => { await pg.close(); });

const customer = (userId: string): Principal => ({ userId, roles: ['customer'] });
let adminP: Principal;
type Opt = { as?: Principal; json?: unknown; form?: Record<string, string>; headers?: Record<string, string>; raw?: string; a?: typeof app };
async function call(method: string, path: string, o: Opt = {}) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.as) headers['x-principal'] = JSON.stringify(o.as);
  let body: string | undefined;
  if (o.json !== undefined) { body = JSON.stringify(o.json); headers['content-type'] = 'application/json'; }
  if (o.form) { body = new URLSearchParams(o.form).toString(); headers['content-type'] = 'application/x-www-form-urlencoded'; }
  if (o.raw !== undefined) body = o.raw;
  const res = await (o.a ?? app).request(path, { method, headers, body });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const md5 = (s: string) => createHash('md5').update(s).digest('hex');
/** Independent implementation of PayHere's documented md5sig, to cross-check src/payhere.ts. */
const notify = (p: { orderId: string; amount: string; currency?: string; status: string; merchantId?: string; extra?: Record<string, string> }) => {
  const merchantId = p.merchantId ?? config.payhere.merchantId;
  const currency = p.currency ?? 'LKR';
  const md5sig = md5(`${merchantId}${p.orderId}${p.amount}${currency}${p.status}${md5(config.payhere.merchantSecret).toUpperCase()}`).toUpperCase();
  return { merchant_id: merchantId, order_id: p.orderId, payment_id: 'PH-1', payhere_amount: p.amount, payhere_currency: currency, status_code: p.status, md5sig, method: 'VISA', status_message: 'x', ...(p.extra ?? {}) };
};
const orderBody = (variantId: string, quantity = 1, paymentMethod = 'payhere') => ({
  items: [{ variantId, quantity }],
  shipping: { fullName: 'A Buyer', phone: '0771234567', line1: '1 Lane', city: 'Kandy', district: 'Kandy' },
  paymentMethod,
});
const status = async (id: string) => (await pg.db.select().from(orders).where(eq(orders.id, id)))[0].status;
const lastAudit = async (action: string) => (await pg.db.select().from(auditLogs).where(eq(auditLogs.action, action)).orderBy(desc(auditLogs.createdAt)).limit(1))[0];

describe('auth and validation', () => {
  test('health is public; protected routes need a session and the right role', async () => {
    expect((await call('GET', '/health')).status).toBe(200);
    const s = await seed(pg.db, { sellers: 1 });
    expect((await call('POST', '/orders', { json: orderBody(s.sellers[0].variantId) })).status).toBe(401);
    expect((await call('POST', '/orders', { as: { userId: s.buyerId, roles: ['seller'] }, json: orderBody(s.sellers[0].variantId) })).status).toBe(403);
    expect((await call('POST', '/admin/payouts', { as: customer(s.buyerId), json: { sellerId: s.sellers[0].sellerId } })).status).toBe(403);
    expect((await call('POST', '/admin/payouts', { json: { sellerId: s.sellers[0].sellerId } })).status).toBe(401);
  });

  test('bad input is a 400 with details; domain errors map to meaningful statuses', async () => {
    const s = await seed(pg.db, { sellers: 1, stock: 2 });
    const as = customer(s.buyerId);
    expect((await call('POST', '/orders', { as, json: orderBody(s.sellers[0].variantId, 0) })).status).toBe(400);
    expect((await call('POST', '/orders', { as, json: { nope: true } })).status).toBe(400);
    expect((await call('POST', '/orders', { as, raw: '{not json', headers: { 'content-type': 'application/json' } })).body.error.code).toBe('invalid_json');
    expect((await call('POST', '/orders', { as, json: orderBody('00000000-0000-4000-8000-0000000000aa') })).status).toBe(422);
    const out = await call('POST', '/orders', { as, json: orderBody(s.sellers[0].variantId, 3) });
    expect(out.status).toBe(409);
    expect(out.body.error.code).toBe('out_of_stock');
  });
});

describe('checkout and payments', () => {
  test('placing an order returns the PayHere checkout form with a correct hash', async () => {
    const s = await seed(pg.db, { sellers: 1 });
    const r = await call('POST', '/orders', { as: customer(s.buyerId), json: orderBody(s.sellers[0].variantId, 2) });
    expect(r.status).toBe(201);
    expect(r.body.totalCents).toBe(200000);
    const f = r.body.payhere.fields;
    expect(r.body.payhere.action).toBe('https://sandbox.payhere.lk/pay/checkout');
    expect(f.amount).toBe('2000.00');
    expect(f.order_id).toBe(r.body.paymentId);
    const expected = md5(`${config.payhere.merchantId}${f.order_id}2000.00LKR${md5(config.payhere.merchantSecret).toUpperCase()}`).toUpperCase();
    expect(f.hash).toBe(expected);
    expect(f.notify_url).toBe('https://shop.example.test/api/webhooks/payhere');
    // PayHere's required customer parameters are all present and non-empty
    for (const k of ['first_name', 'last_name', 'email', 'phone', 'address', 'city', 'country']) expect(String(f[k] ?? '')).not.toBe('');
    expect(f).toMatchObject({ first_name: 'A', last_name: 'Buyer', phone: '0771234567', address: '1 Lane', city: 'Kandy', country: 'Sri Lanka' });
    expect(f.email).toContain('@');
  });

  test('a retry payment attempt carries the same customer fields, taken from the saved order', async () => {
    const s = await seed(pg.db, { sellers: 1 });
    const r = await call('POST', '/orders', { as: customer(s.buyerId), json: orderBody(s.sellers[0].variantId) });
    await call('POST', '/webhooks/payhere', { form: notify({ orderId: r.body.paymentId, amount: '1000.00', status: '-2' }) });
    const again = await call('POST', `/orders/${r.body.orderId}/payments`, { as: customer(s.buyerId), json: { method: 'payhere' } });
    expect(again.status).toBe(201);
    expect(again.body.payhere.fields).toMatchObject({ first_name: 'A', last_name: 'Buyer', city: 'Kandy', country: 'Sri Lanka' });
    expect(again.body.payhere.fields.email).toContain('@');
  });

  test('a buyer cannot open a payment attempt on someone else\'s order; the owner can after a failure', async () => {
    const s = await seed(pg.db, { sellers: 1 });
    const r = await call('POST', '/orders', { as: customer(s.buyerId), json: orderBody(s.sellers[0].variantId) });
    const other = await seed(pg.db, { sellers: 1 });
    await call('POST', '/webhooks/payhere', { form: notify({ orderId: r.body.paymentId, amount: '1000.00', status: '-2' }) });
    expect((await call('POST', `/orders/${r.body.orderId}/payments`, { as: customer(other.buyerId), json: { method: 'payhere' } })).status).toBe(404);
    const again = await call('POST', `/orders/${r.body.orderId}/payments`, { as: customer(s.buyerId), json: { method: 'payhere' } });
    expect(again.status).toBe(201);
    expect(again.body.paymentId).not.toBe(r.body.paymentId);
  });
});

describe('PayHere notification', () => {
  async function pending() {
    const s = await seed(pg.db, { sellers: 1, stock: 5 });
    const r = await call('POST', '/orders', { as: customer(s.buyerId), json: orderBody(s.sellers[0].variantId) });
    return { s, ...r.body } as { s: typeof s; orderId: string; paymentId: string; totalCents: number };
  }

  test('a valid success notification pays the order; duplicates are harmless; card data is never stored', async () => {
    const o = await pending();
    const n = notify({ orderId: o.paymentId, amount: '1000.00', status: '2', extra: { card_no: '************1234', card_holder_name: 'X' } });
    const first = await call('POST', '/webhooks/payhere', { form: n });
    expect(first.body.status).toBe('confirmed');
    expect(await status(o.orderId)).toBe('processing');
    const dups = await Promise.all(Array.from({ length: 10 }, () => call('POST', '/webhooks/payhere', { form: n })));
    expect(dups.every((d) => d.status === 200 && d.body.status === 'already_confirmed')).toBe(true);
    const [inv] = await pg.db.select().from(inventory).where(eq(inventory.id, o.s.sellers[0].inventoryId));
    expect(inv.onHandQty).toBe(4); // consumed once
    const [p] = await pg.db.select().from(payments).where(eq(payments.id, o.paymentId));
    expect(p.providerReference).toBe('PH-1');
    expect(JSON.stringify(p.gatewayPayload)).not.toContain('card');
  });

  test('forged or foreign notifications are rejected with 403 and change nothing', async () => {
    const o = await pending();
    const n = notify({ orderId: o.paymentId, amount: '1000.00', status: '2' });
    expect((await call('POST', '/webhooks/payhere', { form: { ...n, md5sig: 'A'.repeat(32) } })).status).toBe(403);
    expect((await call('POST', '/webhooks/payhere', { form: { ...n, payhere_amount: '1.00' } })).status).toBe(403); // amount tampered after signing
    expect((await call('POST', '/webhooks/payhere', { form: notify({ orderId: o.paymentId, amount: '1000.00', status: '2', merchantId: 'OTHER' }) })).status).toBe(403);
    expect(await status(o.orderId)).toBe('pending_payment');
  });

  test('a genuine notification with the wrong amount is NOT applied; it is flagged for a human and answered 200', async () => {
    const o = await pending();
    const r = await call('POST', '/webhooks/payhere', { form: notify({ orderId: o.paymentId, amount: '999.99', status: '2' }) });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('needs_manual_review');
    expect(await status(o.orderId)).toBe('pending_payment');
    expect((await lastAudit('payment.payhere_amount_mismatch')).entityId).toBe(o.paymentId);
    const wrongCur = await call('POST', '/webhooks/payhere', { form: notify({ orderId: o.paymentId, amount: '1000.00', currency: 'USD', status: '2' }) });
    expect(wrongCur.body.status).toBe('needs_manual_review');
  });

  test('unknown payment id and malformed amounts are flagged, never confirmed', async () => {
    const unknown = await call('POST', '/webhooks/payhere', { form: notify({ orderId: '11111111-1111-4111-8111-111111111111', amount: '1.00', status: '2' }) });
    expect(unknown.body.status).toBe('needs_manual_review');
    const o = await pending();
    const bad = await call('POST', '/webhooks/payhere', { form: notify({ orderId: o.paymentId, amount: '1e3', status: '2' }) });
    expect(bad.body.status).toBe('needs_manual_review');
    expect(await status(o.orderId)).toBe('pending_payment');
  });

  test('failed and cancelled are recorded; chargebacks are flagged; pending is ignored', async () => {
    const a = await pending();
    expect((await call('POST', '/webhooks/payhere', { form: notify({ orderId: a.paymentId, amount: '1000.00', status: '-2' }) })).body.status).toBe('recorded');
    expect((await pg.db.select().from(payments).where(eq(payments.id, a.paymentId)))[0].status).toBe('failed');
    const b = await pending();
    expect((await call('POST', '/webhooks/payhere', { form: notify({ orderId: b.paymentId, amount: '1000.00', status: '0' }) })).body.status).toBe('ignored');
    expect((await call('POST', '/webhooks/payhere', { form: notify({ orderId: b.paymentId, amount: '1000.00', status: '-3' }) })).body.status).toBe('chargeback_flagged');
    expect(await status(b.orderId)).toBe('pending_payment');
  });

  test('money arriving after the order expired is acknowledged and flagged for a manual refund', async () => {
    const o = await pending();
    expect((await cancelUnpaidOrder(pg.db, o.orderId)).cancelled).toBe(true);
    const r = await call('POST', '/webhooks/payhere', { form: notify({ orderId: o.paymentId, amount: '1000.00', status: '2' }) });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('needs_manual_review');
    expect(await status(o.orderId)).toBe('cancelled');
    expect((await lastAudit('payment.needs_manual_review')).entityId).toBe(o.paymentId);
  });
});

describe('seller and courier', () => {
  const sellerP = (o: Awaited<ReturnType<typeof paidOrder>>, i: number): Principal => ({ userId: staffId, roles: ['seller'], sellerId: o.sellers[i].sellerId });

  test('only the owning seller can ship; unknown or foreign seller orders look like 404', async () => {
    const o = await paidOrder(pg.db);
    const body = { pickupLocationId: o.sellers[0].locationId, trackingNumber: 'T-100' };
    expect((await call('POST', `/seller/orders/${o.A.id}/ship`, { as: sellerP(o, 1), json: body })).status).toBe(404);
    const ok = await call('POST', `/seller/orders/${o.A.id}/ship`, { as: sellerP(o, 0), json: body });
    expect(ok.status).toBe(200);
    expect(ok.body.sellerOrderStatus).toBe('shipped');
    expect((await call('POST', `/seller/orders/${o.A.id}/ship`, { as: sellerP(o, 0), json: body })).status).toBe(409);
    expect((await call('POST', `/seller/orders/${o.B.id}/cancel`, { as: sellerP(o, 0) })).status).toBe(404);
    expect((await call('POST', `/seller/orders/${o.B.id}/cancel`, { as: sellerP(o, 1) })).status).toBe(200);
  });

  // courier events must be NEWER than the shipment's booking event to be applied
  const inAnHour = () => new Date(Date.now() + 3600_000).toISOString();
  const courierEvent = (tracking: string, st: string, at: string) => {
    const raw = JSON.stringify({ tracking_number: tracking, status: st, occurred_at: at });
    return { raw, headers: { 'x-signature': signCourierBody(raw, config.courierWebhookSecret), 'content-type': 'application/json' } };
  };

  test('courier webhooks need a valid signature; delivered updates the shipment but does not pay the seller by itself', async () => {
    const o = await paidOrder(pg.db);
    await call('POST', `/seller/orders/${o.A.id}/ship`, { as: sellerP(o, 0), json: { pickupLocationId: o.sellers[0].locationId, trackingNumber: 'T-200' } });
    const ev = courierEvent('T-200', 'delivered', inAnHour());
    expect((await call('POST', '/webhooks/courier', { raw: ev.raw, headers: { ...ev.headers, 'x-signature': 'bad' } })).status).toBe(401);
    const ok = await call('POST', '/webhooks/courier', ev);
    expect(ok.body).toEqual({ matched: true, applied: true });
    expect((await call('POST', '/webhooks/courier', ev)).body).toEqual({ matched: true, applied: false });
    expect((await pg.db.select().from(shipments).where(eq(shipments.sellerOrderId, o.A.id)))[0].status).toBe('delivered');
    expect(await pg.db.select().from(sellerLedgerEntries).where(eq(sellerLedgerEntries.sellerOrderId, o.A.id))).toHaveLength(0);
    // an admin verifies, which posts the ledger
    expect((await call('POST', `/admin/seller-orders/${o.A.id}/verify-delivery`, { as: adminP })).status).toBe(200);
    expect(await pg.db.select().from(sellerLedgerEntries).where(eq(sellerLedgerEntries.sellerOrderId, o.A.id))).toHaveLength(2);
    expect((await call('POST', '/webhooks/courier', { ...courierEvent('UNKNOWN', 'delivered', inAnHour()) })).body.matched).toBe(false);
  });

  test('with auto-verify on, the courier\'s delivered event verifies delivery by itself (and 10 duplicates post once)', async () => {
    const o = await paidOrder(pg.db);
    await call('POST', `/seller/orders/${o.A.id}/ship`, { as: sellerP(o, 0), json: { pickupLocationId: o.sellers[0].locationId, trackingNumber: 'T-300' } });
    const ev = courierEvent('T-300', 'delivered', inAnHour());
    await Promise.all(Array.from({ length: 10 }, () => call('POST', '/webhooks/courier', { ...ev, a: autoApp })));
    expect((await pg.db.select().from(sellerOrders).where(eq(sellerOrders.id, o.A.id)))[0].status).toBe('delivered');
    expect(await pg.db.select().from(sellerLedgerEntries).where(eq(sellerLedgerEntries.sellerOrderId, o.A.id))).toHaveLength(2);
  });
});

describe('courier delivered event on a partially shipped seller order', () => {
  test('is acknowledged with 200 (not 409), is stored, and the order is verified once the last parcel is delivered', async () => {
    const o = await paidOrder(pg.db);
    const sellerP: Principal = { userId: staffId, roles: ['seller'], sellerId: o.sellers[0].sellerId };
    const ship = (tracking: string, complete: boolean) =>
      call('POST', `/seller/orders/${o.A.id}/ship`, { as: sellerP, json: { pickupLocationId: o.sellers[0].locationId, trackingNumber: tracking, complete } });
    const hour = () => new Date(Date.now() + 3600_000).toISOString();
    const soStatus = async () => (await pg.db.select().from(sellerOrders).where(eq(sellerOrders.id, o.A.id)))[0].status;
    const courier = (tracking: string) => {
      const raw = JSON.stringify({ tracking_number: tracking, status: 'delivered', occurred_at: hour() });
      return call('POST', '/webhooks/courier', { raw, headers: { 'content-type': 'application/json', 'x-signature': signCourierBody(raw, config.courierWebhookSecret) }, a: autoApp });
    };

    expect((await ship('PS-1', false)).status).toBe(200);
    expect(await soStatus()).toBe('partially_shipped');
    const first = await courier('PS-1'); // would have been 409 before
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ matched: true, applied: true });
    expect(await soStatus()).toBe('partially_shipped'); // not verifiable yet
    expect((await pg.db.select().from(shipments).where(eq(shipments.sellerOrderId, o.A.id)))[0].status).toBe('delivered'); // the event was kept

    expect((await ship('PS-2', true)).status).toBe(200);
    expect((await courier('PS-2')).status).toBe(200);
    expect(await soStatus()).toBe('delivered'); // every parcel delivered: verified automatically
  });
});

describe('admin: payments, refunds, payouts', () => {
  test('bank-transfer confirmation is admin-only and idempotent; card payments cannot be confirmed by hand', async () => {
    const s = await seed(pg.db, { sellers: 1 });
    const bank = await call('POST', '/orders', { as: customer(s.buyerId), json: orderBody(s.sellers[0].variantId, 1, 'bank_transfer') });
    expect((await call('POST', `/admin/payments/${bank.body.paymentId}/confirm`, { as: customer(s.buyerId), json: {} })).status).toBe(403);
    expect((await call('POST', `/admin/payments/${bank.body.paymentId}/confirm`, { as: adminP, json: { reference: 'SLIP-9' } })).body.alreadyConfirmed).toBe(false);
    expect((await call('POST', `/admin/payments/${bank.body.paymentId}/confirm`, { as: adminP, json: {} })).body.alreadyConfirmed).toBe(true);
    const card = await call('POST', '/orders', { as: customer(s.buyerId), json: orderBody(s.sellers[0].variantId, 1, 'payhere') });
    expect((await call('POST', `/admin/payments/${card.body.paymentId}/confirm`, { as: adminP, json: {} })).status).toBe(422);
  });

  test('refund flow over HTTP: request, approve, start (one sender), complete; capacity conflicts are 409', async () => {
    const o = await paidOrder(pg.db);
    await markShipped(pg.db, o.A.id, o.sellers[0].locationId);
    await call('POST', `/admin/seller-orders/${o.A.id}/verify-delivery`, { as: adminP });
    const line = { sellerOrderId: o.A.id, itemAmountCents: 100000, deliveryAmountCents: 0 };
    const made = await call('POST', '/admin/refunds', { as: adminP, json: { orderId: o.orderId, lines: [line], reason: 'damaged' } });
    expect(made.status).toBe(201);
    const id = made.body.refundId;
    expect((await call('POST', `/admin/refunds/${id}/approve`, { as: adminP })).status).toBe(200);
    const starts = await Promise.all(Array.from({ length: 5 }, () => call('POST', `/admin/refunds/${id}/start`, { as: adminP })));
    expect(starts.filter((r) => r.body.started)).toHaveLength(1);
    expect((await call('POST', `/admin/refunds/${id}/complete`, { as: adminP, json: { providerReference: 'BANK-77' } })).body.alreadyCompleted).toBe(false);
    expect((await call('POST', `/admin/refunds/${id}/complete`, { as: adminP, json: {} })).body.alreadyCompleted).toBe(true);
    expect((await call('POST', `/admin/refunds/${id}/fail`, { as: adminP })).status).toBe(409);
    const [r] = await pg.db.select().from(refunds).where(eq(refunds.id, id));
    expect(r.status).toBe('succeeded');
    const overReq = await call('POST', '/admin/refunds', { as: adminP, json: { orderId: o.orderId, lines: [{ ...line, itemAmountCents: 300000 }] } });
    const over = overReq.status === 201 ? await call('POST', `/admin/refunds/${overReq.body.refundId}/approve`, { as: adminP }) : overReq;
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('refund_capacity_exceeded');
    expect((await call('POST', '/admin/refunds', { as: adminP, json: { orderId: o.orderId, lines: [] } })).status).toBe(400);
  });

  test('payout flow over HTTP, including the processing-cancel refusal', async () => {
    const o = await paidOrder(pg.db);
    await markShipped(pg.db, o.A.id, o.sellers[0].locationId);
    await call('POST', `/admin/seller-orders/${o.A.id}/verify-delivery`, { as: adminP });
    expect((await call('POST', '/admin/payouts', { as: adminP, json: { sellerId: o.sellers[0].sellerId } })).status).toBe(409); // no payout account
    await addPayoutAccount(pg.db, o.sellers[0].sellerId);
    const made = await call('POST', '/admin/payouts', { as: adminP, json: { sellerId: o.sellers[0].sellerId } });
    expect(made.status).toBe(201);
    expect(made.body.amountCents).toBe(270000);
    expect((await call('POST', '/admin/payouts', { as: adminP, json: { sellerId: o.sellers[0].sellerId } })).body).toMatchObject({ created: false, reason: 'nothing_to_pay' });
    const id = made.body.payoutId;
    await call('POST', `/admin/payouts/${id}/start`, { as: adminP });
    const cancel = await call('POST', `/admin/payouts/${id}/cancel`, { as: adminP });
    expect(cancel.status).toBe(409);
    expect(cancel.body.error.code).toBe('payout_outcome_unknown');
    expect((await call('POST', `/admin/payouts/${id}/paid`, { as: adminP, json: { bankReference: 'TRF-1' } })).body.changed).toBe(true);
    expect((await call('POST', `/admin/payouts/${id}/cancel`, { as: adminP })).body.error.code).toBe('payout_state');
  });
});

describe('cron jobs', () => {
  test('need the bearer secret; expiry cancels overdue orders; reconcile is green, and red (500) on a violation', async () => {
    const auth = { authorization: `Bearer ${config.cronSecret}` };
    expect((await call('GET', '/cron/expire-orders')).status).toBe(401);
    expect((await call('GET', '/cron/expire-orders', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    const s = await seed(pg.db, { sellers: 1, stock: 3 });
    const old = await placeOrder(pg.db, { buyerId: s.buyerId, paymentMethod: 'bank_transfer', shipping, now: new Date(Date.now() - 200 * 3600_000), items: [{ variantId: s.sellers[0].variantId, quantity: 1 }] });
    const r = await call('GET', '/cron/expire-orders', { headers: auth });
    expect(r.status).toBe(200);
    expect(r.body.cancelled).toBeGreaterThanOrEqual(1);
    expect(await status(old.orderId)).toBe('cancelled');
    expect((await call('GET', '/cron/reconcile', { headers: auth })).body).toEqual({ ok: true, violations: [] });
    const o = await paidOrder(pg.db);
    await pg.db.update(orders).set({ refundedCents: 5 }).where(eq(orders.id, o.orderId)); // tamper: cache without a refund
    const bad = await call('GET', '/cron/reconcile', { headers: auth });
    expect(bad.status).toBe(500);
    expect(bad.body.violations.join(' ')).toContain('refunded_cents');
    await pg.db.update(orders).set({ refundedCents: 0 }).where(eq(orders.id, o.orderId));
    expect((await call('GET', '/cron/reconcile', { headers: auth })).status).toBe(200);
  });
});

describe('scheduled payout run (cron)', () => {
  test('needs the cron secret, answers 503 when no system actor is configured, and creates pending payouts a person then starts', async () => {
    const auth = { authorization: `Bearer ${config.cronSecret}` };
    expect((await call('GET', '/cron/payout-run')).status).toBe(401);
    const unconfigured = await call('GET', '/cron/payout-run', { headers: auth });
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.body.error.code).toBe('not_configured');

    const sys = await ensureSystemActor(pg.db);
    const cronApp = createApp({ db: pg.db, authenticate, config: { ...config, systemActorId: sys } });
    const o = await paidOrder(pg.db);
    await markShipped(pg.db, o.A.id, o.sellers[0].locationId);
    await call('POST', `/admin/seller-orders/${o.A.id}/verify-delivery`, { as: adminP });
    await addPayoutAccount(pg.db, o.sellers[0].sellerId);
    await pg.db.update(sellerProfiles).set({ status: 'approved' }).where(eq(sellerProfiles.id, o.sellers[0].sellerId));

    const run = await call('GET', '/cron/payout-run', { headers: auth, a: cronApp });
    expect(run.status).toBe(200);
    expect(run.body.ok).toBe(true);
    const made = run.body.created.find((c: any) => c.sellerId === o.sellers[0].sellerId);
    expect(made.amountCents).toBe(270000);
    const [p] = await pg.db.select().from(payouts).where(eq(payouts.id, made.payoutId));
    expect(p.status).toBe('pending');
    expect(p.createdBy).toBe(sys);
    const beats = await pg.db.select().from(auditLogs).where(and(eq(auditLogs.entityType, 'system_job'), eq(auditLogs.action, 'payout_run.completed')));
    expect(beats.length).toBeGreaterThanOrEqual(1); // the run left a heartbeat for monitoring
    expect((beats.at(-1)!.metadata as any).failed).toEqual([]);

    // a finance person (not the system actor) starts it; the two-person rule is satisfied
    const start = await call('POST', `/admin/payouts/${made.payoutId}/start`, { as: adminP });
    expect(start.status).toBe(200);
  });

  test('payout-run writes a payout_run.failed row when the run itself throws', async () => {
    const sys = await ensureSystemActor(pg.db);
    const boom = new Set(['select', 'transaction', 'execute']);
    const flaky = new Proxy(pg.db, { get: (t, p, r) => (boom.has(p as string) ? () => { throw new Error('boom'); } : Reflect.get(t, p, r)) }) as typeof pg.db;
    const flakyApp = createApp({ db: flaky, authenticate, config: { ...config, systemActorId: sys } });
    const res = await call('GET', '/cron/payout-run', { headers: { authorization: `Bearer ${config.cronSecret}` }, a: flakyApp });
    expect(res.status).toBe(500);
    const rows = await pg.db.select().from(auditLogs).where(and(eq(auditLogs.entityType, 'system_job'), eq(auditLogs.action, 'payout_run.failed')));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(String((rows.at(-1)!.metadata as any).error)).toContain('boom');
  });
});

describe('PayHere checkout needs the buyer email before anything is committed', () => {
  test('POST /orders with no usable email answers 422 and leaves no order, payment or reservation behind', async () => {
    const s = await seed(pg.db, { sellers: 1, stock: 3 });
    await pg.db.update(users).set({ email: '' }).where(eq(users.id, s.buyerId));
    const before = await pg.db.select().from(orders).where(eq(orders.buyerId, s.buyerId));
    const r = await call('POST', '/orders', { as: customer(s.buyerId), json: orderBody(s.sellers[0].variantId, 1, 'payhere') });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('email_required');
    expect(await pg.db.select().from(orders).where(eq(orders.buyerId, s.buyerId))).toHaveLength(before.length);
    const [inv] = await pg.db.select().from(inventory).where(eq(inventory.id, s.sellers[0].inventoryId));
    expect(inv.reservedQty).toBe(0);
    await pg.db.update(users).set({ email: `buyer-${Date.now()}@x.lk` }).where(eq(users.id, s.buyerId)); // free the unique email
    // bank transfer needs no email and still works
    expect((await call('POST', '/orders', { as: customer(s.buyerId), json: orderBody(s.sellers[0].variantId, 1, 'bank_transfer') })).status).toBe(201);
  });

  test('POST /orders/:id/payments with no usable email answers 422 and creates no payment attempt', async () => {
    const s = await seed(pg.db, { sellers: 1, stock: 3 });
    const placed = await call('POST', '/orders', { as: customer(s.buyerId), json: orderBody(s.sellers[0].variantId, 1, 'bank_transfer') });
    await pg.db.update(users).set({ email: '' }).where(eq(users.id, s.buyerId));
    const r = await call('POST', `/orders/${placed.body.orderId}/payments`, { as: customer(s.buyerId), json: { method: 'payhere' } });
    expect(r.status).toBe(422);
    const pays = await pg.db.select().from(payments).where(eq(payments.orderId, placed.body.orderId));
    expect(pays).toHaveLength(1); // only the original bank-transfer attempt
  });
});

describe('admin: payouts for an unknown seller', () => {
  test('answers 404 seller_not_found, not a 500', async () => {
    const r = await call('POST', '/admin/payouts', { as: adminP, json: { sellerId: '00000000-0000-4000-8000-00000000dead' } });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('seller_not_found');
  });
});
