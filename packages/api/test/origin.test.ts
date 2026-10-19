import { describe, expect, test } from 'bun:test';
import { createAdminApp, createPublicApp, type Principal } from '../src';

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
