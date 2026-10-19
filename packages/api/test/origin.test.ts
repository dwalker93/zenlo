import { describe, expect, test } from 'bun:test';
import { createAdminApp, createApp, createPublicApp, loadConfig, type ApiConfig, type Principal } from '../src';

const staff: Principal = { userId: '00000000-0000-4000-8000-0000000000aa', roles: ['admin'], mfaVerified: true };
const id = '00000000-0000-4000-8000-000000000001';
// Stand-in db: any `select().from().where()` resolves to no rows, so allowed requests end in a clean 404/401, not a crash.
const rows: any = { from: () => rows, where: () => rows, then: (resolve: (v: unknown[]) => void) => resolve([]) };
const db = { select: () => rows } as never;

const admin = createAdminApp({ db, authenticate: async () => staff, config: { requireMfa: true, dualControlThresholdCents: 0, trustedOrigins: ['https://admin.shop.test'] } });
const pub = createPublicApp({
  db, authenticate: async () => null,
  config: { payhere: { merchantId: 'm', merchantSecret: 's', sandbox: true }, publicBaseUrl: 'https://shop.test', trustedOrigins: ['https://shop.test'] },
});
const post = (app: { request: (p: string, i: RequestInit) => Response | Promise<Response> }, path: string, headers: Record<string, string> = {}) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });

describe('CSRF origin guard', () => {
  test('a write from a foreign origin is refused before any work happens', async () => {
    for (const origin of ['https://evil.test', 'null', 'https://shop.test.evil.test']) {
      const r = await post(admin, `/payments/${id}/confirm`, { origin });
      expect(r.status).toBe(403);
      expect((await r.json()).error.code).toBe('bad_origin');
    }
    expect((await post(pub, '/orders', { origin: 'https://evil.test' })).status).toBe(403);
  });

  test('our own origin passes the guard (trailing slash and case do not matter)', async () => {
    expect((await post(admin, `/payments/${id}/confirm`, { origin: 'https://admin.shop.test' })).status).not.toBe(403);
    expect((await post(admin, `/payments/${id}/confirm`, { origin: 'HTTPS://Admin.Shop.test/' })).status).not.toBe(403);
    expect((await post(pub, '/orders', { origin: 'https://shop.test' })).status).toBe(401); // reached auth
  });

  test('no Origin: cross-site browsers are refused, same-site and non-browser clients pass', async () => {
    expect((await post(pub, '/orders', { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await post(pub, '/orders', { 'sec-fetch-site': 'same-origin' })).status).toBe(401);
    expect((await post(pub, '/orders')).status).toBe(401);
  });

  test('reads are never blocked', async () => {
    expect((await pub.request('/health', { headers: { origin: 'https://evil.test' } })).status).toBe(200);
  });
});

describe('origin lists stay separate and fail closed', () => {
  const cfg: ApiConfig = {
    payhere: { merchantId: 'm', merchantSecret: 's', sandbox: true }, courierWebhookSecret: 'c', cronSecret: 'k', autoVerifyDelivery: false,
    publicBaseUrl: 'https://shop.test', publicTrustedOrigins: ['https://shop.test'], adminTrustedOrigins: ['https://admin.shop.test'],
    requireMfa: true, dualControlThresholdCents: 0,
  };
  const combined = createApp({ db, authenticate: async () => staff, config: cfg });

  const refused = async (path: string, origin: string) => {
    const r = await post(combined, path, { origin });
    return r.status === 403 && (await r.json()).error.code === 'bad_origin';
  };
  test('in the combined app each guard accepts only its own origin', async () => {
    // (the stand-in principal is staff, so an accepted origin ends in a role refusal, not bad_origin)
    expect(await refused('/orders', 'https://shop.test')).toBe(false);
    expect(await refused('/orders', 'https://admin.shop.test')).toBe(true);
    expect(await refused(`/admin/payments/${id}/confirm`, 'https://admin.shop.test')).toBe(false);
    expect(await refused(`/admin/payments/${id}/confirm`, 'https://shop.test')).toBe(true);
  });

  test('loadConfig keeps the two lists apart', () => {
    const c = loadConfig({
      PAYHERE_MERCHANT_ID: 'm', PAYHERE_MERCHANT_SECRET: 's', PUBLIC_BASE_URL: 'https://shop.test/', ADMIN_BASE_URL: 'https://admin.shop.test',
      COURIER_WEBHOOK_SECRET: 'c', CRON_SECRET: 'k',
    });
    expect(c.publicTrustedOrigins).toEqual(['https://shop.test']);
    expect(c.adminTrustedOrigins).toEqual(['https://admin.shop.test']);
  });

  test('an app built without any trusted origin refuses to start instead of running unguarded', () => {
    const pubCfg = { payhere: { merchantId: 'm', merchantSecret: 's', sandbox: true }, publicBaseUrl: 'https://shop.test' };
    expect(() => createPublicApp({ db, authenticate: async () => null, config: pubCfg as never })).toThrow('trustedOrigins');
    expect(() => createPublicApp({ db, authenticate: async () => null, config: { ...pubCfg, trustedOrigins: [] } })).toThrow('trustedOrigins');
    expect(() => createAdminApp({ db, authenticate: async () => staff, config: { requireMfa: true, dualControlThresholdCents: 0 } as never })).toThrow('trustedOrigins');
  });
});
