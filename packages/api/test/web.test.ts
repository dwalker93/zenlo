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
