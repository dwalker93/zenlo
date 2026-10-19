import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError } from 'better-auth/api';
import { twoFactor } from 'better-auth/plugins';
import { and, eq, inArray } from 'drizzle-orm';
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
    session: { expiresIn: 60 * 60 * 8, updateAge: 60 * 15 },
    plugins: [twoFactor({ issuer: d.issuer ?? 'Zenlo Admin' })], // no trusted devices: staff re-verify on every sign-in
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
            return { data: session };
          },
        },
      },
    },
  });
}

export type PublicAuth = ReturnType<typeof createPublicAuth>;
export type AdminAuth = ReturnType<typeof createAdminAuth>;
