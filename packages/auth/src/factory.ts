import { betterAuth, type BetterAuthPlugin } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { twoFactor } from 'better-auth/plugins';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { accounts, rateLimits, sessions, twoFactors, userRoles, users, verifications } from '@workspace/db/schema';
import type { Db } from '@workspace/domain';
import { STAFF_ROLES } from '@workspace/api/permissions';

export interface Mailer {
  sendVerificationEmail(user: { email: string; name: string }, url: string): Promise<void>;
  sendPasswordReset(user: { email: string; name: string }, url: string): Promise<void>;
}

export interface AuthDeps {
  db: Db;
  /** 32+ random characters. Use a DIFFERENT secret for the public and the admin instance. */
  secret: string;
  /** Origin the browser sees for this app, e.g. https://example.com or https://admin.example.com */
  baseURL: string;
  /** Extra origins allowed to call the auth endpoints (the app's own origin is always trusted). */
  trustedOrigins?: string[];
  /** Pass `false` in local http development. Defaults to true when baseURL is https. */
  secureCookies?: boolean;
  /** Turn off rate limiting (tests only). */
  disableRateLimit?: boolean;
}
export interface PublicAuthDeps extends AuthDeps {
  /** Without a mailer, email verification and password reset are off. With one, verification is required before sign-in. */
  mailer?: Mailer;
}
export interface AdminAuthDeps extends AuthDeps {
  /** Shown in authenticator apps. */
  issuer?: string;
  /**
   * Framework integration plugins, appended AFTER the built-in ones (a cookie plugin such as tanstackStartCookies() must be
   * last). Meant for plugins that add no endpoints: they are not reflected in the AdminAuth type.
   */
  extraPlugins?: BetterAuthPlugin[];
}

const schema = { user: users, session: sessions, account: accounts, verification: verifications, twoFactor: twoFactors, rateLimit: rateLimits };

function base(d: AuthDeps, cookiePrefix: string) {
  return {
    baseURL: d.baseURL,
    secret: d.secret,
    trustedOrigins: [d.baseURL, ...(d.trustedOrigins ?? [])],
    database: drizzleAdapter(d.db as never, { provider: 'pg', schema }),
    // Provider tokens (access/refresh/id) are encrypted with XChaCha20-Poly1305, keyed from `secret`, before they reach the database.
    account: { encryptOAuthTokens: true },
    advanced: {
      cookiePrefix,
      useSecureCookies: d.secureCookies ?? d.baseURL.startsWith('https://'),
      database: { generateId: 'uuid' as const }, // our ids are uuid columns
    },
    // Counters live in Postgres so limits hold across serverless instances (in-memory limits do not).
    rateLimit: { enabled: !d.disableRateLimit, storage: 'database' as const, window: 60, max: 120 },
  };
}


/** Staff sessions last at most this long on the server, whatever the cookie says. */
const ADMIN_SESSION_SECONDS = 60 * 60 * 8;

const VERIFY_TOTP = '/two-factor/verify-totp';
type EnrollmentMarker = { mfaEnrollment?: { userId: string } };

/**
 * Completing TOTP enrollment makes `mfaVerified` true (it is derived from twoFactorEnabled). Better Auth swaps only the
 * session that submitted the code, so a session opened BEFORE enrollment (never asked for a code) would suddenly count
 * as MFA-verified. Those sessions must go, but only once it is safe: in 1.7.10 the verify endpoint (1) sets
 * twoFactorEnabled, (2) creates the confirming session, (3) deletes the submitting session, (4) marks the twoFactors row
 * verified. Revoking inside a database hook (during step 1) would delete every session BEFORE the confirming one exists,
 * and if step 2 then fails (for example the staff member was just deactivated) the user is locked out. So this runs as
 * an after-hook on the endpoint: only when it succeeded, the confirming session exists and the twoFactors row is
 * verified, it deletes every other session of that user. If anything failed, nothing is revoked.
 * The before-hook marks the request as an enrollment (an active session submitting a code for a not-yet-verified
 * factor); a normal sign-in code check has no active session and is never touched, nor is any profile update.
 */
function revokeOtherSessionsOnEnrollment(db: Db) {
  return {
    id: 'revoke-other-sessions-on-mfa-enrollment',
    hooks: {
      before: [
        {
          matcher: (ctx: { path?: string }) => ctx.path === VERIFY_TOTP,
          handler: createAuthMiddleware(async (ctx) => {
            const active = await getSessionFromCtx(ctx).catch(() => null);
            if (!active?.session) return;
            const pending = await db
              .select({ id: twoFactors.id })
              .from(twoFactors)
              .where(and(eq(twoFactors.userId, active.user.id), eq(twoFactors.verified, false)))
              .limit(1);
            if (pending.length === 0) return;
            return { context: { mfaEnrollment: { userId: active.user.id } } satisfies EnrollmentMarker };
          }),
        },
      ],
      after: [
        {
          matcher: (ctx: { path?: string }) => ctx.path === VERIFY_TOTP,
          handler: createAuthMiddleware(async (ctx) => {
            const marker = (ctx as unknown as EnrollmentMarker).mfaEnrollment;
            if (!marker) return;
            const returned = ctx.context.returned;
            if (returned instanceof Error || (returned as { error?: unknown } | undefined)?.error) return; // the code was refused or the endpoint failed
            const confirming = ctx.context.newSession?.session;
            if (!confirming || confirming.userId !== marker.userId) return; // no confirming session: revoke nothing
            const verified = await db
              .select({ id: twoFactors.id })
              .from(twoFactors)
              .where(and(eq(twoFactors.userId, marker.userId), eq(twoFactors.verified, true)))
              .limit(1);
            if (verified.length === 0) return;
            await db.delete(sessions).where(and(eq(sessions.userId, marker.userId), ne(sessions.id, confirming.id)));
          }),
        },
      ],
    },
  };
}

/**
 * Admin sessions live in a browser-session cookie only (no Max-Age/Expires), so closing the browser drops them. The client
 * may send `rememberMe`, but it is ignored here: a forgotten flag or a tampered request cannot make a staff session persistent.
 * Better Auth remembers the choice in the signed `dont_remember` cookie, so the later steps that create the session (the
 * two-factor code check, the enrollment confirmation) inherit it and need no hook of their own.
 */
function sessionCookieOnly() {
  return {
    id: 'admin-session-cookie-only',
    hooks: {
      before: [
        {
          matcher: (ctx: { path?: string }) => ctx.path === '/sign-in/email',
          handler: createAuthMiddleware(async (ctx) => ({ context: { body: { ...(ctx.body as Record<string, unknown>), rememberMe: false } } })),
        },
      ],
    },
  };
}

/** Customers and sellers. Anyone can sign up; they get the customer role and nothing else. */
export function createPublicAuth(d: PublicAuthDeps) {
  const b = base(d, 'zenlo');
  return betterAuth({
    ...b,
    appName: 'Zenlo',
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      requireEmailVerification: Boolean(d.mailer),
      sendResetPassword: d.mailer ? async ({ user, url }) => d.mailer!.sendPasswordReset(user, url) : undefined,
    },
    emailVerification: d.mailer
      ? { sendOnSignUp: true, autoSignInAfterVerification: true, sendVerificationEmail: async ({ user, url }) => d.mailer!.sendVerificationEmail(user, url) }
      : undefined,
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    rateLimit: {
      ...b.rateLimit,
      customRules: {
        '/sign-in/email': { window: 60, max: 5 },
        '/sign-up/email': { window: 60, max: 5 },
        '/request-password-reset': { window: 300, max: 3 },
      },
    },
    databaseHooks: {
      user: {
        create: {
          // Roles are granted here, on the server. Nothing a client sends can set one.
          after: async (user) => {
            await d.db.insert(userRoles).values({ userId: user.id, role: 'customer' }).onConflictDoNothing();
          },
        },
      },
    },
  });
}

/**
 * Staff only. No sign-up (staff are provisioned by an admin script), short sessions, a separate cookie, and TOTP
 * two-factor. A staff member whose second factor is not enrolled can sign in only to enroll it: the admin API
 * refuses them (mfa_required) until twoFactorEnabled is true.
 */
export function createAdminAuth(d: AdminAuthDeps) {
  const b = base(d, 'zenlo-admin');
  return betterAuth({
    ...b,
    appName: 'Zenlo Admin',
    emailAndPassword: { enabled: true, disableSignUp: true, autoSignIn: false, minPasswordLength: 12, maxPasswordLength: 128 },
    session: { expiresIn: ADMIN_SESSION_SECONDS, updateAge: 60 * 15 },
    plugins: [sessionCookieOnly(), twoFactor({ issuer: d.issuer ?? 'Zenlo Admin' }), revokeOtherSessionsOnEnrollment(d.db), ...((d.extraPlugins ?? []) as [])], // no trusted devices: staff re-verify on every sign-in
    rateLimit: {
      ...b.rateLimit,
      customRules: {
        '/sign-in/email': { window: 300, max: 5 },
        '/two-factor/verify-totp': { window: 300, max: 5 },
        '/two-factor/verify-backup-code': { window: 300, max: 5 },
      },
    },
    databaseHooks: {
      session: {
        create: {
          // Only active staff may hold an admin session, whatever else they can do on the public site.
          before: async (session) => {
            const [u] = await d.db.select({ isActive: users.isActive }).from(users).where(eq(users.id, session.userId));
            const staff = await d.db
              .select({ role: userRoles.role })
              .from(userRoles)
              .where(and(eq(userRoles.userId, session.userId), inArray(userRoles.role, [...STAFF_ROLES])));
            if (!u?.isActive || staff.length === 0) throw new APIError('FORBIDDEN', { message: 'Staff access only' });
            // Better Auth gives a 'don't remember' session a fixed 24 h in the database; staff sessions never outlive their configured lifetime.
            const latest = Date.now() + ADMIN_SESSION_SECONDS * 1000;
            return { data: { ...session, expiresAt: new Date(Math.min(session.expiresAt.getTime(), latest)) } };
          },
        },
      },
    },
  });
}

export type PublicAuth = ReturnType<typeof createPublicAuth>;
export type AdminAuth = ReturnType<typeof createAdminAuth>;
