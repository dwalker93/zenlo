import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { users } from '@workspace/db/schema';
import {
  createAdminApp, createApp, createMachineApp, createPublicApp, loadAdminConfig, permissionsOf, ROLE_PERMISSIONS,
  type AdminConfig, type ApiConfig, type Principal,
} from '../src';
import { addPayoutAccount, createPgTestDb, markShipped, paidOrder, seed, type PgTest } from '../../domain/test/pg';

let pg: PgTest;
const ids: Record<string, string> = {};
const authenticate = async (req: Request): Promise<Principal | null> => {
  const h = req.headers.get('x-principal');
  return h ? (JSON.parse(h) as Principal) : null;
};
const adminCfg = (o: Partial<AdminConfig> = {}): AdminConfig => ({ requireMfa: true, dualControlThresholdCents: 0, trustedOrigins: ['https://admin.x.test'], ...o });
const staff = (name: string, roles: Principal['roles'], mfaVerified = true): Principal => ({ userId: ids[name], roles, mfaVerified });
const adminApp = (o: Partial<AdminConfig> = {}) => createAdminApp({ db: pg.db, authenticate, config: adminCfg(o) });
async function call(a: { request: (p: string, i: RequestInit) => Response | Promise<Response> }, method: string, path: string, as?: Principal, json?: unknown) {
  const headers: Record<string, string> = {};
  if (as) headers['x-principal'] = JSON.stringify(as);
  if (json !== undefined) headers['content-type'] = 'application/json';
  const res = await a.request(path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

beforeAll(async () => {
  pg = await createPgTestDb();
  for (const n of ['admin', 'finance1', 'finance2', 'support']) {
    [{ id: ids[n] }] = await pg.db.insert(users).values({ email: `${n}@rbac.test`, name: n }).returning({ id: users.id });
  }
});
afterAll(async () => { await pg.close(); });

describe('permissions', () => {
  test('role map: admin has everything, support can only request refunds', () => {
    expect(permissionsOf({ roles: ['admin'] }).size).toBe(ROLE_PERMISSIONS.admin.length);
    expect([...permissionsOf({ roles: ['support'] })]).toEqual(['refunds.request']);
    expect(permissionsOf({ roles: ['customer', 'seller'] }).size).toBe(0);
  });

  test('matrix over HTTP: finance confirms payments, support cannot, customers and anonymous are refused', async () => {
    const app = adminApp();
    const s = await seed(pg.db, { sellers: 1 });
    const id = '00000000-0000-4000-8000-000000000001'; // permission is checked before the payment is looked up
    expect((await call(app, 'POST', `/payments/${id}/confirm`)).status).toBe(401);
    expect((await call(app, 'POST', `/payments/${id}/confirm`, { userId: s.buyerId, roles: ['customer'], mfaVerified: true }, {})).status).toBe(403);
    expect((await call(app, 'POST', `/payments/${id}/confirm`, staff('support', ['support']), {})).status).toBe(403);
    expect((await call(app, 'POST', `/payments/${id}/confirm`, staff('finance1', ['finance']), {})).status).toBe(404); // allowed, payment just doesn't exist
    expect((await call(app, 'POST', `/payments/${id}/confirm`, staff('admin', ['admin']), {})).status).toBe(404);
    expect((await call(app, 'POST', `/seller-orders/${id}/verify-delivery`, staff('support', ['support']))).status).toBe(403);
    expect((await call(app, 'POST', '/payouts', staff('support', ['support']), { sellerId: id })).status).toBe(403);
  });

  test('support may request a refund but not approve it', async () => {
    const app = adminApp();
    const o = await paidOrder(pg.db);
    await markShipped(pg.db, o.A.id, o.sellers[0].locationId);
    await call(app, 'POST', `/seller-orders/${o.A.id}/verify-delivery`, staff('finance1', ['finance']));
    const line = { sellerOrderId: o.A.id, itemAmountCents: 1000, deliveryAmountCents: 0 };
    const made = await call(app, 'POST', '/refunds', staff('support', ['support']), { orderId: o.orderId, lines: [line] });
    expect(made.status).toBe(201);
    expect((await call(app, 'POST', `/refunds/${made.body.refundId}/approve`, staff('support', ['support']))).status).toBe(403);
    expect((await call(app, 'POST', `/refunds/${made.body.refundId}/approve`, staff('finance1', ['finance']))).status).toBe(200);
  });
});

describe('route isolation', () => {
  test('each app serves only its own routes', async () => {
    const pub = createPublicApp({ db: pg.db, authenticate, config: { payhere: { merchantId: 'm', merchantSecret: 's', sandbox: true }, publicBaseUrl: 'https://x.test', trustedOrigins: ['https://x.test'] } });
    const machine = createMachineApp({ db: pg.db, config: { payhere: { merchantId: 'm', merchantSecret: 's' }, courierWebhookSecret: 'c', cronSecret: 'k', autoVerifyDelivery: false } });
    const admin = adminApp();
    const a = staff('admin', ['admin']);
    for (const path of ['/admin/payouts', '/payouts', '/refunds', '/webhooks/payhere', '/webhooks/courier', '/cron/reconcile']) {
      expect((await call(pub, 'POST', path, a, {})).status).toBe(404);
    }
    for (const path of ['/orders', '/seller/orders/x/ship', '/webhooks/payhere', '/webhooks/courier', '/cron/reconcile']) {
      expect((await call(admin, 'POST', path, a, {})).status).toBe(404);
    }
    for (const path of ['/orders', '/payouts', '/refunds', '/admin/payouts']) {
      expect((await call(machine, 'POST', path, a, {})).status).toBe(404);
    }
  });

  test('the combined dev app still mounts all three', async () => {
    const cfg: ApiConfig = { payhere: { merchantId: 'm', merchantSecret: 's', sandbox: true }, courierWebhookSecret: 'c', cronSecret: 'k', autoVerifyDelivery: false, publicBaseUrl: 'https://x.test', publicTrustedOrigins: ['https://x.test'], adminTrustedOrigins: ['https://admin.x.test'], requireMfa: true, dualControlThresholdCents: 0 };
    const app = createApp({ db: pg.db, authenticate, config: cfg });
    expect((await call(app, 'GET', '/health')).status).toBe(200);
    expect((await call(app, 'POST', '/admin/payouts', staff('support', ['support']), {})).status).toBe(403);
    expect((await call(app, 'GET', '/cron/reconcile')).status).toBe(401);
  });
});

describe('multi-factor authentication', () => {
  test('staff without a second factor are refused with mfa_required; disabling it is explicit', async () => {
    const noMfa = staff('admin', ['admin'], false);
    const r = await call(adminApp(), 'POST', '/payouts', noMfa, {});
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('mfa_required');
    expect((await call(adminApp({ requireMfa: false }), 'POST', '/payouts', noMfa, {})).status).toBe(400); // passes the gate, fails validation
  });

  test('the default config requires MFA', () => {
    expect(loadAdminConfig({ ADMIN_BASE_URL: 'https://admin.x.test' }).requireMfa).toBe(true);
    expect(loadAdminConfig({ ADMIN_BASE_URL: 'https://admin.x.test/' }).dualControlThresholdCents).toBe(5_000_000);
    expect(() => loadAdminConfig({ ADMIN_BASE_URL: 'https://a.test', DUAL_CONTROL_THRESHOLD_CENTS: '-1' })).toThrow();
    expect(loadAdminConfig({ ADMIN_BASE_URL: 'https://admin.x.test/' }).trustedOrigins).toEqual(['https://admin.x.test']);
    expect(() => loadAdminConfig({})).toThrow('ADMIN_BASE_URL');
  });
});

describe('separation of duties', () => {
  test('refund: the requester cannot approve at or above the threshold; another person can', async () => {
    const app = adminApp({ dualControlThresholdCents: 0 });
    const o = await paidOrder(pg.db);
    await markShipped(pg.db, o.A.id, o.sellers[0].locationId);
    await call(app, 'POST', `/seller-orders/${o.A.id}/verify-delivery`, staff('finance1', ['finance']));
    const made = await call(app, 'POST', '/refunds', staff('finance1', ['finance']), { orderId: o.orderId, lines: [{ sellerOrderId: o.A.id, itemAmountCents: 1000, deliveryAmountCents: 0 }] });
    const self = await call(app, 'POST', `/refunds/${made.body.refundId}/approve`, staff('finance1', ['finance']));
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('separation_of_duties');
    expect((await call(app, 'POST', `/refunds/${made.body.refundId}/approve`, staff('finance2', ['finance']))).status).toBe(200);
  });

  test('refund below the threshold: one person may do both', async () => {
    const app = adminApp({ dualControlThresholdCents: 1_000_000 });
    const o = await paidOrder(pg.db);
    await markShipped(pg.db, o.A.id, o.sellers[0].locationId);
    await call(app, 'POST', `/seller-orders/${o.A.id}/verify-delivery`, staff('finance1', ['finance']));
    const made = await call(app, 'POST', '/refunds', staff('finance1', ['finance']), { orderId: o.orderId, lines: [{ sellerOrderId: o.A.id, itemAmountCents: 1000, deliveryAmountCents: 0 }] });
    expect((await call(app, 'POST', `/refunds/${made.body.refundId}/approve`, staff('finance1', ['finance']))).status).toBe(200);
  });

  test('payout: the creator cannot start a payout at or above the threshold; another person can; below it one person may', async () => {
    const strict = adminApp({ dualControlThresholdCents: 0 });
    const o = await paidOrder(pg.db);
    await markShipped(pg.db, o.A.id, o.sellers[0].locationId);
    await call(strict, 'POST', `/seller-orders/${o.A.id}/verify-delivery`, staff('finance1', ['finance']));
    await addPayoutAccount(pg.db, o.sellers[0].sellerId);
    const made = await call(strict, 'POST', '/payouts', staff('finance1', ['finance']), { sellerId: o.sellers[0].sellerId });
    expect(made.status).toBe(201);
    const self = await call(strict, 'POST', `/payouts/${made.body.payoutId}/start`, staff('finance1', ['finance']));
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('separation_of_duties');
    expect((await call(strict, 'POST', `/payouts/${made.body.payoutId}/start`, staff('finance2', ['finance']))).status).toBe(200);

    const lax = adminApp({ dualControlThresholdCents: Number.MAX_SAFE_INTEGER });
    const o2 = await paidOrder(pg.db);
    await markShipped(pg.db, o2.A.id, o2.sellers[0].locationId);
    await call(lax, 'POST', `/seller-orders/${o2.A.id}/verify-delivery`, staff('finance1', ['finance']));
    await addPayoutAccount(pg.db, o2.sellers[0].sellerId);
    const m2 = await call(lax, 'POST', '/payouts', staff('finance1', ['finance']), { sellerId: o2.sellers[0].sellerId });
    expect((await call(lax, 'POST', `/payouts/${m2.body.payoutId}/start`, staff('finance1', ['finance']))).status).toBe(200);
  });
});
