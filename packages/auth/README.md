# @workspace/auth

Better Auth (1.7) wired to our schema, as two separate instances plus the functions that turn a session into the API's `Principal`.

| | Public (`createPublicAuth`) | Admin (`createAdminAuth`) |
|---|---|---|
| Who | customers, sellers | staff (`admin`, `finance`, `support`) |
| Sign-up | open; new users get the `customer` role, nothing else | **disabled**; staff are created with `provisionStaff` / `scripts/create-staff.ts` |
| Passwords | min 10 chars | min 12 chars |
| Session | 30 days | 8 hours |
| Second factor | none | TOTP (authenticator app), required by the admin API |
| Cookie | `zenlo.session_token` | `zenlo-admin.session_token` (separate) |
| Secret | `PUBLIC_AUTH_SECRET` | `ADMIN_AUTH_SECRET` (use a different value) |
| Origin | `PUBLIC_BASE_URL` | `ADMIN_BASE_URL` |

## How a request becomes a Principal
`publicAuthenticate(auth, db)` / `adminAuthenticate(auth, db)` read the session, then load the user's state and roles **from the database on every request**. Nothing role-related comes from the session, the cookie or the client.

- Public: returns only `customer` and `seller`. `seller` (and `sellerId`) only while the seller profile is `approved`. Staff roles are never returned here.
- Admin: returns only staff roles. `mfaVerified` is `users.two_factor_enabled`. With two-factor enabled, Better Auth does not create the session until the code is verified, so a live session for such a user means they passed it. Staff who have not enrolled can sign in only to enroll; the admin API answers `403 mfa_required` until they do.
- Inactive users (`users.is_active = false`) are never authenticated. Use `deactivateUser` (also deletes their sessions) and `setUserRoles` (also deletes sessions) so changes take effect immediately.
- Admin sessions can only be created for active staff, even with a valid password.

## Wiring (Next.js)
```ts
// apps/web/lib/auth.ts
import { db } from '@workspace/db/client';
import { createPublicAuth, publicAuthenticate } from '@workspace/auth';
export const auth = createPublicAuth({ db, secret: process.env.PUBLIC_AUTH_SECRET!, baseURL: process.env.PUBLIC_BASE_URL!, mailer /* optional, see below */ });
export const authenticate = publicAuthenticate(auth, db);

// apps/web/app/api/auth/[...all]/route.ts   (Better Auth's own endpoints: sign-in, sign-up, ...)
import { toNextJsHandler } from 'better-auth/next-js';
export const { GET, POST } = toNextJsHandler(auth);
```
Mount the Hono API at `app/api/[[...route]]/route.ts` as before, passing `authenticate`. Next.js prefers the more specific `/api/auth/*` route, so the two do not clash. The admin app is the same with `createAdminAuth`, `adminAuthenticate`, `ADMIN_AUTH_SECRET`, `ADMIN_BASE_URL`.

Client side (`better-auth/react`): `createAuthClient()` for the shop; for admin add `twoFactorClient({ twoFactorPage: '/two-factor' })` from `better-auth/client/plugins`, and build three screens: sign-in, enroll (`twoFactor.enable` shows the QR/URI, then `twoFactor.verifyTotp` to confirm), and the code prompt at sign-in.

## Environment
- Web: `PUBLIC_AUTH_SECRET` (32+ random chars), `PUBLIC_BASE_URL`, `DATABASE_URL`
- Admin: `ADMIN_AUTH_SECRET` (a different 32+ char secret), `ADMIN_BASE_URL`, `DATABASE_URL`
- Generate secrets with `openssl rand -base64 32`. Changing a secret signs everyone out and makes stored two-factor secrets unreadable, so treat them like keys.

## Creating the first admin
```
ADMIN_AUTH_SECRET=... ADMIN_BASE_URL=https://admin.example.com DATABASE_URL=... \
bun packages/auth/scripts/create-staff.ts --email you@example.com --name "You" --role admin
```
It prints a temporary password once. Sign in at the admin app, enroll the authenticator app, then change the password. Save the backup codes offline: that is your break-glass path.

## Things this package does NOT do yet
- **Email.** Without a `mailer`, email verification and password reset are off. Pass `mailer` (Resend, SES, ...) to the public instance to turn both on; verification is then required before sign-in.
- **Sign in with Google / social login.** Provider tokens are already encrypted at rest (`account.encryptOAuthTokens`, keyed from the auth secret), so no plaintext token rows will ever exist when you add a provider. Rotating the secret means users must re-link or sign in again with the provider. Not built yet: seller onboarding (creating `seller_profiles` and granting `seller`), and an admin screen for managing staff.
- **Rate limits** are stored in Postgres (`rate_limits`) so they hold across serverless instances: 5 sign-ins/min on the public app, 5 per 5 min on admin, 5 code attempts per 5 min. Two-factor also has its own lockout after repeated wrong codes.
- `scripts/create-system-actor.ts` (`bun run create-system-actor`) prints the `SYSTEM_ACTOR_ID` for scheduled payout runs: an inactive user with no roles or credentials.
- The script `create-staff.ts` is not tested against Neon; it uses the same `provisionStaff` function the tests cover.

## Tests
`bun test` (needs the test Postgres, see the domain README). Covers sign-up/sign-in, role escalation attempts, seller approval rules, deactivation, the complete two-factor flow, cookie isolation between the two apps, rate limiting, and the auth wired into the real API apps.
