import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createAdminApp, createPublicApp } from '@workspace/api';
import { sellerProfiles, sessions, userRoles, users } from '@workspace/db/schema';
import {
  adminAuthenticate, createAdminAuth, createPublicAuth, deactivateUser, provisionStaff, publicAuthenticate, setUserRoles,
} from '../src';
import { createPgTestDb, type PgTest } from '../../domain/test/pg';

const PUBLIC = 'https://shop.test';
const ADMIN = 'https://admin.shop.test';
const SECRET_A = 'public-secret-public-secret-public-secret-1234';
const SECRET_B = 'admin-secret-admin-secret-admin-secret-98765';
const PW = 'a-long-test-password-123';

/** The otpauth URI carries the secret base32-encoded (what authenticator apps read); the server's TOTP takes the raw secret. */
function secretFromUri(uri: string) {
  const b32 = new URL(uri).searchParams.get('secret')!;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of b32.replace(/=+$/, '')) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = bits.match(/.{8}/g)!.map((b) => parseInt(b, 2));
  return Buffer.from(bytes).toString('utf8');
}

let pg: PgTest;
let pub: ReturnType<typeof createPublicAuth>;
let adm: ReturnType<typeof createAdminAuth>;
let pubAuthn: ReturnType<typeof publicAuthenticate>;
let admAuthn: ReturnType<typeof adminAuthenticate>;

beforeAll(async () => {
  pg = await createPgTestDb();
  pub = createPublicAuth({ db: pg.db, secret: SECRET_A, baseURL: PUBLIC, disableRateLimit: true });
  adm = createAdminAuth({ db: pg.db, secret: SECRET_B, baseURL: ADMIN, disableRateLimit: true });
  pubAuthn = publicAuthenticate(pub, pg.db);
  admAuthn = adminAuthenticate(adm, pg.db);
});
afterAll(async () => { await pg.close(); });

let n = 0;
const email = (p: string) => `${p}${++n}-${Date.now()}@test.example`;

type Handler = { handler: (r: Request) => Promise<Response> };
async function post(a: Handler, origin: string, path: string, body: unknown, cookie = '', ip = '10.0.0.1') {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin, 'x-forwarded-for': ip };
  if (cookie) headers.cookie = cookie;
  const res = await a.handler(new Request(`${origin}/api/auth${path}`, { method: 'POST', headers, body: JSON.stringify(body) }));
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('='));
  return { status: res.status, body: (await res.json().catch(() => null)) as any, cookie: cookies.join('; ') };
}
const req = (origin: string, cookie?: string) => new Request(`${origin}/x`, { headers: cookie ? { cookie } : {} });

async function customer() {
  const e = email('buyer');
  const r = await post(pub, PUBLIC, '/sign-up/email', { email: e, password: PW, name: 'Buyer One' });
  expect(r.status).toBe(200);
  return { email: e, userId: r.body.user.id as string, cookie: r.cookie };
}

describe('secrets at rest', () => {
  test('both instances encrypt OAuth provider tokens before storing them', async () => {
    expect((await pub.$context).options.account?.encryptOAuthTokens).toBe(true);
    expect((await adm.$context).options.account?.encryptOAuthTokens).toBe(true);
  });
});

describe('public auth', () => {
  test('sign-up makes a customer; the session becomes a customer principal; signed-out is null', async () => {
    const c = await customer();
    expect(await pubAuthn(req(PUBLIC, c.cookie))).toEqual({ userId: c.userId, roles: ['customer'], sellerId: null });
    expect(await pubAuthn(req(PUBLIC))).toBeNull();
    expect(await pubAuthn(req(PUBLIC, c.cookie.replace(/=.{5}/, '=XXXXX')))).toBeNull(); // tampered cookie
  });

  test('a client cannot grant itself a role at sign-up', async () => {
    const e = email('sneaky');
    const r = await post(pub, PUBLIC, '/sign-up/email', { email: e, password: PW, name: 'S', role: 'admin', roles: ['admin'], twoFactorEnabled: true, isActive: true });
    const id = r.body.user.id as string;
    expect((await pg.db.select().from(userRoles).where(eq(userRoles.userId, id))).map((x) => x.role)).toEqual(['customer']);
    expect((await pg.db.select().from(users).where(eq(users.id, id)))[0].twoFactorEnabled).toBe(false);
  });

  test('sign-in with the right password works, the wrong one does not', async () => {
    const c = await customer();
    expect((await post(pub, PUBLIC, '/sign-in/email', { email: c.email, password: 'wrong-password-123' })).status).toBe(401);
    const ok = await post(pub, PUBLIC, '/sign-in/email', { email: c.email, password: PW });
    expect(ok.status).toBe(200);
    expect((await pubAuthn(req(PUBLIC, ok.cookie)))?.userId).toBe(c.userId);
  });

  test('short passwords are refused', async () => {
    expect((await post(pub, PUBLIC, '/sign-up/email', { email: email('short'), password: 'short', name: 'X' })).status).toBe(400);
  });

  test('seller role counts only while the seller profile is approved', async () => {
    const c = await customer();
    await pg.db.insert(userRoles).values({ userId: c.userId, role: 'seller' });
    const [sp] = await pg.db.insert(sellerProfiles).values({ userId: c.userId, shopName: 'Leaf', slug: `leaf-${n}-${Date.now()}` }).returning();
    expect((await pubAuthn(req(PUBLIC, c.cookie)))?.roles).toEqual(['customer']); // pending
    expect((await pubAuthn(req(PUBLIC, c.cookie)))?.sellerId).toBeNull();
    await pg.db.update(sellerProfiles).set({ status: 'approved' }).where(eq(sellerProfiles.id, sp.id));
    expect(await pubAuthn(req(PUBLIC, c.cookie))).toEqual({ userId: c.userId, roles: ['customer', 'seller'], sellerId: sp.id });
    await pg.db.update(sellerProfiles).set({ status: 'suspended' }).where(eq(sellerProfiles.id, sp.id));
    expect((await pubAuthn(req(PUBLIC, c.cookie)))?.roles).toEqual(['customer']);
  });

  test('staff roles never reach the public app', async () => {
    const c = await customer();
    await pg.db.insert(userRoles).values({ userId: c.userId, role: 'admin' });
    expect((await pubAuthn(req(PUBLIC, c.cookie)))?.roles).toEqual(['customer']);
  });

  test('deactivating a user ends their sessions immediately', async () => {
    const c = await customer();
    expect(await pubAuthn(req(PUBLIC, c.cookie))).not.toBeNull();
    await deactivateUser(pg.db, c.userId);
    expect(await pubAuthn(req(PUBLIC, c.cookie))).toBeNull();
    expect(await pg.db.select().from(sessions).where(eq(sessions.userId, c.userId))).toHaveLength(0);
    expect((await post(pub, PUBLIC, '/sign-in/email', { email: c.email, password: PW })).status).toBe(200); // password still valid...
    expect(await pubAuthn(req(PUBLIC, (await post(pub, PUBLIC, '/sign-in/email', { email: c.email, password: PW })).cookie))).toBeNull(); // ...but inactive users are never authenticated
  });

  test('changing roles ends old sessions', async () => {
    const c = await customer();
    await setUserRoles(pg.db, c.userId, ['customer']);
    expect(await pubAuthn(req(PUBLIC, c.cookie))).toBeNull();
  });

  test('sign-in is rate limited', async () => {
    const limited = createPublicAuth({ db: pg.db, secret: SECRET_A, baseURL: PUBLIC, disableRateLimit: false });
    const e = email('rl');
    await post(limited, PUBLIC, '/sign-up/email', { email: e, password: PW, name: 'R' }, '', '10.9.9.9');
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await post(limited, PUBLIC, '/sign-in/email', { email: e, password: 'wrong-password-123' }, '', '10.9.9.9')).status);
    expect(codes).toContain(429);
  });
});

describe('admin auth', () => {
  async function staff(role: 'admin' | 'finance' | 'support') {
    const e = email(role);
    const { userId } = await provisionStaff(adm, pg.db, { email: e, name: role, role, password: PW });
    return { email: e, userId };
  }

  test('nobody can sign up on the admin instance', async () => {
    const r = await post(adm, ADMIN, '/sign-up/email', { email: email('x'), password: PW, name: 'X' });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body?.user).toBeUndefined();
  });

  test('provisioning validates role and password and refuses duplicates', async () => {
    const e = email('v');
    await expect(provisionStaff(adm, pg.db, { email: e, name: 'V', role: 'customer' as any, password: PW })).rejects.toThrow('not a staff role');
    await expect(provisionStaff(adm, pg.db, { email: e, name: 'V', role: 'finance', password: 'short' })).rejects.toThrow('12 characters');
    await provisionStaff(adm, pg.db, { email: e, name: 'V', role: 'finance', password: PW });
    await expect(provisionStaff(adm, pg.db, { email: e, name: 'V', role: 'finance', password: PW })).rejects.toThrow('already exists');
  });

  test('staff without a second factor can sign in (to enroll) but are not mfaVerified', async () => {
    const s = await staff('finance');
    const si = await post(adm, ADMIN, '/sign-in/email', { email: s.email, password: PW });
    expect(si.status).toBe(200);
    expect(await admAuthn(req(ADMIN, si.cookie))).toEqual({ userId: s.userId, roles: ['finance'], mfaVerified: false });
  });

  test('full two-factor flow: enroll, then sign-in needs the code and only then yields an mfaVerified session', async () => {
    const s = await staff('admin');
    const first = await post(adm, ADMIN, '/sign-in/email', { email: s.email, password: PW });
    // enroll
    const enable = await post(adm, ADMIN, '/two-factor/enable', { password: PW }, first.cookie);
    expect(enable.status).toBe(200);
    const secret = secretFromUri(enable.body.totpURI);
    const code = async () => (await adm.api.generateTOTP({ body: { secret } })).code;
    // enrolled but not yet confirmed: still not verified
    expect((await admAuthn(req(ADMIN, first.cookie)))?.mfaVerified).toBe(false);
    const confirm = await post(adm, ADMIN, '/two-factor/verify-totp', { code: await code() }, first.cookie);
    expect(confirm.status).toBe(200);
    expect((await admAuthn(req(ADMIN, confirm.cookie || first.cookie)))?.mfaVerified).toBe(true);

    // a fresh sign-in no longer yields a session until the code is verified
    const again = await post(adm, ADMIN, '/sign-in/email', { email: s.email, password: PW });
    expect(again.body.twoFactorRedirect).toBe(true);
    expect(await admAuthn(req(ADMIN, again.cookie))).toBeNull(); // only the pending-2FA cookie exists
    const bad = await post(adm, ADMIN, '/two-factor/verify-totp', { code: '000000' }, again.cookie);
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const good = await post(adm, ADMIN, '/two-factor/verify-totp', { code: await code() }, again.cookie);
    expect(good.status).toBe(200);
    expect(await admAuthn(req(ADMIN, good.cookie))).toEqual({ userId: s.userId, roles: ['admin'], mfaVerified: true });
  });

  test('completing TOTP enrollment revokes every other session; only the confirming session is mfaVerified', async () => {
    const s = await staff('finance');
    const a = await post(adm, ADMIN, '/sign-in/email', { email: s.email, password: PW }, '', '10.0.1.1');
    const b = await post(adm, ADMIN, '/sign-in/email', { email: s.email, password: PW }, '', '10.0.1.2'); // e.g. a stolen or forgotten session
    expect((await admAuthn(req(ADMIN, b.cookie)))?.mfaVerified).toBe(false);
    const enable = await post(adm, ADMIN, '/two-factor/enable', { password: PW }, a.cookie);
    const secret = secretFromUri(enable.body.totpURI);
    // before the code is confirmed nothing changes
    expect(await admAuthn(req(ADMIN, b.cookie))).not.toBeNull();
    const confirm = await post(adm, ADMIN, '/two-factor/verify-totp', { code: (await adm.api.generateTOTP({ body: { secret } })).code }, a.cookie);
    expect(confirm.status).toBe(200);
    expect(await admAuthn(req(ADMIN, confirm.cookie))).toEqual({ userId: s.userId, roles: ['finance'], mfaVerified: true });
    expect(await admAuthn(req(ADMIN, b.cookie))).toBeNull(); // the other session never entered a code
    expect(await admAuthn(req(ADMIN, a.cookie))).toBeNull(); // the pre-enrollment session of the enrolling device is replaced
  });

  test('later profile updates do not revoke sessions of an enrolled user', async () => {
    const s = await staff('support');
    const a = await post(adm, ADMIN, '/sign-in/email', { email: s.email, password: PW }, '', '10.0.2.1');
    const enable = await post(adm, ADMIN, '/two-factor/enable', { password: PW }, a.cookie);
    const secret = secretFromUri(enable.body.totpURI);
    const confirm = await post(adm, ADMIN, '/two-factor/verify-totp', { code: (await adm.api.generateTOTP({ body: { secret } })).code }, a.cookie);
    const upd = await post(adm, ADMIN, '/update-user', { name: 'Renamed' }, confirm.cookie);
    expect(upd.status).toBe(200);
    expect((await admAuthn(req(ADMIN, confirm.cookie)))?.mfaVerified).toBe(true); // still signed in
  });

  test('a customer cannot get an admin session even with the right password', async () => {
    const c = await customer();
    const r = await post(adm, ADMIN, '/sign-in/email', { email: c.email, password: PW });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await admAuthn(req(ADMIN, r.cookie))).toBeNull();
  });

  test('public and admin sessions are not interchangeable', async () => {
    const c = await customer();
    expect(await admAuthn(req(ADMIN, c.cookie))).toBeNull(); // public cookie on the admin app
    const s = await staff('support');
    const si = await post(adm, ADMIN, '/sign-in/email', { email: s.email, password: PW });
    expect(await pubAuthn(req(PUBLIC, si.cookie))).toBeNull(); // admin cookie on the public app
  });

  test('deactivated staff lose access at once', async () => {
    const s = await staff('support');
    const si = await post(adm, ADMIN, '/sign-in/email', { email: s.email, password: PW });
    expect(await admAuthn(req(ADMIN, si.cookie))).not.toBeNull();
    await deactivateUser(pg.db, s.userId);
    expect(await admAuthn(req(ADMIN, si.cookie))).toBeNull();
  });
});

describe('wired into the API apps', () => {
  const adminApi = () => createAdminApp({ db: pg.db, authenticate: admAuthn, config: { requireMfa: true, dualControlThresholdCents: 0, trustedOrigins: ['https://admin.test'] } });
  const id = '00000000-0000-4000-8000-000000000001';

  test('admin API: no session 401; customer session 401; unenrolled staff mfa_required; enrolled staff reaches the route', async () => {
    const api = adminApi();
    const call = (cookie?: string) => api.request(`/payments/${id}/confirm`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: '{}' });
    expect((await call()).status).toBe(401);
    const c = await customer();
    expect((await call(c.cookie)).status).toBe(401);

    const e = email('fin');
    await provisionStaff(adm, pg.db, { email: e, name: 'F', role: 'finance', password: PW });
    const first = await post(adm, ADMIN, '/sign-in/email', { email: e, password: PW });
    const r = await call(first.cookie);
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe('mfa_required');

    const enable = await post(adm, ADMIN, '/two-factor/enable', { password: PW }, first.cookie);
    const secret = secretFromUri(enable.body.totpURI);
    await post(adm, ADMIN, '/two-factor/verify-totp', { code: (await adm.api.generateTOTP({ body: { secret } })).code }, first.cookie);
    const login = await post(adm, ADMIN, '/sign-in/email', { email: e, password: PW });
    const done = await post(adm, ADMIN, '/two-factor/verify-totp', { code: (await adm.api.generateTOTP({ body: { secret } })).code }, login.cookie);
    expect((await call(done.cookie)).status).toBe(404); // permitted: the payment just does not exist
  });

  test('public API: a customer session can place orders, signed-out cannot', async () => {
    const api = createPublicApp({
      db: pg.db, authenticate: pubAuthn,
      config: { payhere: { merchantId: 'm', merchantSecret: 's', sandbox: true }, publicBaseUrl: PUBLIC, trustedOrigins: [PUBLIC] },
    });
    const c = await customer();
    const body = JSON.stringify({ items: [{ variantId: id, quantity: 1 }], shipping: { fullName: 'A B', phone: '0771234567', line1: 'x', city: 'c', district: 'd' }, paymentMethod: 'payhere' });
    const go = (cookie?: string) => api.request('/orders', { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body });
    expect((await go()).status).toBe(401);
    expect((await go(c.cookie)).status).toBe(422); // authenticated; the variant does not exist
  });
});
