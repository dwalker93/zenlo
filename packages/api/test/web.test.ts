import { describe, expect, test } from 'bun:test';
import { createWebApp } from '../src';

const db = {} as never; // every case below is answered before any query runs
const app = createWebApp({
  db,
  authenticate: async () => null,
  publicConfig: { payhere: { merchantId: 'm', merchantSecret: 's', sandbox: true }, publicBaseUrl: 'https://shop.test', trustedOrigins: ['https://shop.test'] },
  machineConfig: { payhere: { merchantId: 'm', merchantSecret: 's' }, courierWebhookSecret: 'c', cronSecret: 'k', autoVerifyDelivery: false },
});
const post = (path: string, headers: Record<string, string> = {}, body = '{}') =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

describe('createWebApp (public + machine under /api)', () => {
  test('everything lives under /api and nothing outside it', async () => {
    expect((await app.request('/api/health')).status).toBe(200);
    expect((await app.request('/health')).status).toBe(404);
    expect((await post('/orders')).status).toBe(404);
  });

  test('public routes: signed-out is 401, a foreign origin is refused first', async () => {
    expect((await post('/api/orders', { origin: 'https://shop.test' })).status).toBe(401);
    expect((await post('/api/orders', { origin: 'https://evil.test' })).status).toBe(403);
  });

  test('webhooks and cron are reachable, and the browser origin guard does not apply to them', async () => {
    const form = new URLSearchParams({ merchant_id: 'x', md5sig: 'bad' }).toString();
    const ph = await app.request('/api/webhooks/payhere', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://payhere.test' }, body: form });
    expect(ph.status).toBe(403); // rejected for its signature, not for its origin
    expect((await ph.json()).error.code).toBe('bad_signature');
    expect((await app.request('/api/cron/reconcile')).status).toBe(401);
    expect((await app.request('/api/cron/reconcile', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
  });

  test('no admin routes here', async () => {
    expect((await post('/api/admin/payouts', { origin: 'https://shop.test' })).status).toBe(404);
  });
});

describe('lazy machine config', () => {
  const publicConfig = { payhere: { merchantId: 'm', merchantSecret: 's', sandbox: true }, publicBaseUrl: 'https://shop.test', trustedOrigins: ['https://shop.test'] };
  const good = { payhere: { merchantId: 'm', merchantSecret: 's' }, courierWebhookSecret: 'c', cronSecret: 'k', autoVerifyDelivery: false };
  const cron = (a: ReturnType<typeof createWebApp>, bearer: string) => a.request('/api/cron/reconcile', { headers: { authorization: `Bearer ${bearer}` } });

  test('missing machine secrets break only machine endpoints, with 503', async () => {
    const a = createWebApp({ db, authenticate: async () => null, publicConfig, machineConfig: () => { throw new Error('missing environment variable CRON_SECRET'); } });
    expect((await a.request('/api/health')).status).toBe(200);
    expect((await a.request('/api/orders', { method: 'POST', headers: { origin: 'https://shop.test', 'content-type': 'application/json' }, body: '{}' })).status).toBe(401); // public route still answers
    const r = await cron(a, 'k');
    expect(r.status).toBe(503);
    const body = await r.json();
    expect(body.error.code).toBe('not_configured');
    expect(JSON.stringify(body)).not.toContain('CRON_SECRET'); // no env var names in the response
    const ph = await a.request('/api/webhooks/payhere', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'merchant_id=x' });
    expect(ph.status).toBe(503);
  });

  test('a failed load is not cached; a success is', async () => {
    let calls = 0;
    let ready = false;
    const a = createWebApp({ db, authenticate: async () => null, publicConfig, machineConfig: () => { calls++; if (!ready) throw new Error('missing'); return good; } });
    expect((await cron(a, 'wrong')).status).toBe(503);
    ready = true;
    expect((await cron(a, 'wrong')).status).toBe(401); // loaded now: the bearer check runs
    expect((await cron(a, 'wrong')).status).toBe(401);
    expect(calls).toBe(2); // one failure + one success; the success is cached
  });
});
