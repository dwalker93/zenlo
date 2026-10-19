# @workspace/api

Three Hono apps that wire HTTP to `@workspace/domain`. Server-only. Deploy them as **three separate projects** (same database, nothing else shared):

| App | Factory | Config | Env it needs | Suggested host |
|---|---|---|---|---|
| Public | `createPublicApp({ db, authenticate, config })` | `loadPublicConfig` | `PAYHERE_MERCHANT_ID/SECRET/SANDBOX`, `PUBLIC_BASE_URL` (also the CSRF-trusted origin) | `example.com/api` |
| Admin | `createAdminApp({ db, authenticate, config })` | `loadAdminConfig` | `ADMIN_BASE_URL` (required, the CSRF-trusted origin), `REQUIRE_MFA` (default true), `DUAL_CONTROL_THRESHOLD_CENTS` (default 5000000 = LKR 50,000; 0 = always two people) | `admin.example.com` |
| Machine | `createMachineApp({ db, config, courier? })` | `loadMachineConfig` | `PAYHERE_MERCHANT_ID/SECRET`, `COURIER_WEBHOOK_SECRET`, `CRON_SECRET`, `SYSTEM_ACTOR_ID` (optional, for the payout run), `AUTO_VERIFY_DELIVERY` | `example.com/api` (webhook/cron paths only) |

`createApp` mounts all three in one process (public/machine at `/`, admin at `/admin`) for local dev and tests only. Use the Node.js runtime for money routes.
Each app has its own `/health`. The public app has no staff, webhook or cron routes; the admin app has no public or machine routes (tested).

## Mounting in the Next.js public app (`apps/web`)
`createWebApp` composes the public and machine apps under `/api`. Two route files, plus lazy setup so a build without secrets does not fail:

```ts
// apps/web/lib/server.ts
import { db } from '@workspace/db/client';
import { createPublicAuth, publicAuthenticate } from '@workspace/auth';
import { createWebApp, loadMachineConfig, loadPublicConfig } from '@workspace/api';

let auth: ReturnType<typeof createPublicAuth> | undefined;
let api: ReturnType<typeof createWebApp> | undefined;

export const getAuth = () =>
  (auth ??= createPublicAuth({ db, secret: process.env.PUBLIC_AUTH_SECRET!, baseURL: process.env.PUBLIC_BASE_URL! }));

export const getApi = () =>
  (api ??= createWebApp({ db, authenticate: publicAuthenticate(getAuth(), db), publicConfig: loadPublicConfig(), machineConfig: loadMachineConfig() }));
```
```ts
// apps/web/app/api/[[...route]]/route.ts   (orders, seller, webhooks, cron)
import { getApi } from '@/lib/server';
const handler = (req: Request) => getApi().fetch(req);
export { handler as GET, handler as POST };

// apps/web/app/api/auth/[...all]/route.ts   (Better Auth: sign-in, sign-up, ...)
import { getAuth } from '@/lib/server';
const handler = (req: Request) => getAuth().handler(req);
export { handler as GET, handler as POST };
```
- Next prefers the specific `/api/auth/*` file over the `[[...route]]` catch-all, so they do not clash.
- Do not export `runtime` or `dynamic` from these files if you enable Cache Components: they are not allowed there, and the Node.js runtime is what you get anyway. Route handlers are uncached unless you opt in.
- `next.config.ts`: `transpilePackages: ['@workspace/api', '@workspace/auth', '@workspace/domain', '@workspace/db']`.
- `vercel.json`: crons for `/api/cron/expire-orders` (every 15 min) and `/api/cron/reconcile` (hourly); add `/api/cron/payout-run` (e.g. daily) once `SYSTEM_ACTOR_ID` is set. Vercel sends `Authorization: Bearer $CRON_SECRET` when `CRON_SECRET` is set.
- PayHere notify URL is already `PUBLIC_BASE_URL/api/webhooks/payhere`.
- Browser code calls `fetch('/api/orders', { method: 'POST', ... })` from the same origin; the cookie and `Origin` header go along and pass the CSRF guard.
- Needs the Node.js runtime with a global `WebSocket` (Node 22+) for the Neon driver, or set `neonConfig.webSocketConstructor = ws`.

## Public app
| Route | Who | Does |
|---|---|---|
| `POST /orders` | customer | checkout; returns the PayHere checkout form (server-computed hash) for card payments |
| `POST /orders/:id/payments` | customer (owner) | new payment attempt after a failed/cancelled one |
| `POST /seller/orders/:id/ship`, `/cancel` | owning seller | ship (processing -> shipped), cancel before shipping |

## Machine app
| Route | Who | Does |
|---|---|---|
| `POST /webhooks/payhere` | PayHere | verify `md5sig`, then confirm / record failure / flag |
| `POST /webhooks/courier` | courier | signed event -> shipment status (does NOT pay the seller) |
| `GET /cron/expire-orders`, `/cron/reconcile`, `/cron/payout-run` | cron | `Authorization: Bearer $CRON_SECRET`; reconcile answers 500 on any violation so alerting fires. `payout-run` creates one PENDING payout per approved seller with a payable balance, acting as the system actor (`SYSTEM_ACTOR_ID`; 503 if unset). A person with `payouts.manage` still starts each transfer. Setup: see [Scheduled payouts](#scheduled-payouts). Answers 500 if any seller errored |

## Admin app: roles, permissions, MFA, two-person rule
Staff roles: `admin`, `finance`, `support` (customers and sellers are never staff). **Routes check permissions, not role names**; the role -> permission map lives in `src/permissions.ts`.

| Permission | admin | finance | support | Routes |
|---|:-:|:-:|:-:|---|
| `payments.confirm` | x | x | | `POST /payments/:id/confirm` (bank transfers only) |
| `delivery.verify` | x | x | | `POST /seller-orders/:id/verify-delivery` (posts the ledger) |
| `refunds.request` | x | x | x | `POST /refunds` |
| `refunds.approve` | x | x | | `POST /refunds/:id/approve`, `/:id/reject` |
| `refunds.process` | x | x | | `POST /refunds/:id/start`, `/complete`, `/fail` (you send the money between start and complete) |
| `payouts.manage` | x | x | | `POST /payouts`, `/:id/start`, `/paid`, `/failed`, `/retry`, `/cancel` |

- **MFA:** every admin route needs a staff role and `principal.mfaVerified === true` (else 403 `mfa_required`). Your `authenticate` must set it from the real second-factor check. `REQUIRE_MFA=false` is for dev only.
- **Separation of duties:** for a refund or payout of at least `DUAL_CONTROL_THRESHOLD_CENTS`, the person who *requested* a refund cannot approve it, and the person who *created* a payout cannot start it (403 `separation_of_duties`). Requests are recorded in `audit_logs` (`refund.requested`, `refund.approved`).
- No superadmin account exists in code. Recommended break-glass: keep one emergency `admin` account with credentials stored offline, hardware-key MFA, and alert on every login.
- Add a permission only together with the route that needs it (moderation permissions come with the moderation routes).

## PayHere notification policy
Bad signature or wrong merchant id -> **403**. After that the notification is genuine, so anything that cannot be applied automatically
(unknown payment, amount/currency mismatch, money for an expired/cancelled/already-paid order, chargeback) is written to `audit_logs`
(`payment.needs_manual_review`, `payment.payhere_amount_mismatch`, `payment.chargeback`, ...) and answered **200** so PayHere stops retrying;
a person handles it. Card fields are never stored. The payment id is PayHere's `order_id`. Amounts are compared as integer cents.

## PayHere checkout fields
The checkout form carries every field PayHere requires: `first_name`, `last_name` (split from the shipping name; a single name fills both), `email` (the buyer's account email), `phone`, `address`, `city` and `country` (`Sri Lanka`), taken from the order's shipping snapshot. A buyer with no email gets 422 `email_required` for card payments.

## Courier events
Tracking numbers are unique per courier (`shipments_courier_tracking_uq`), and events match on courier + tracking number. A courier adapter sets `courier` on each event (default `promptxpress`).

## CSRF
The public and admin apps authenticate with cookies, so state-changing requests (anything but GET/HEAD/OPTIONS) must come from the app's own origin (`trustedOrigins`, set by the loaders): a foreign `Origin` is refused with 403 `bad_origin`, and with no `Origin` a `Sec-Fetch-Site: cross-site` request is refused. Webhooks are in the machine app, which uses signatures and has no cookies.

## Things you must supply
- `authenticate(req)`: provided by `@workspace/auth` (`publicAuthenticate`, `adminAuthenticate`); see its README. It resolves the session to `{ userId, roles, sellerId?, mfaVerified? }`. Staff sessions must carry `mfaVerified`. **Roles, `sellerId` and `mfaVerified` must come from trusted server-side session data, never from request headers or client input** (the tests' `x-principal` header is a test stub only). This is now implemented in `@workspace/auth`.
- **Courier adapter.** The PromptXpress webhook/API format was not available, so the default is a generic HMAC-signed JSON contract (`courier.ts`).
  Replace it with a `CourierAdapter` for their real API; nothing else changes. Until then, ship/deliver via the admin routes.
- Environment: see the per-app table above. `PAYHERE_SANDBOX` must be `false` in production. `AUTO_VERIFY_DELIVERY=true` lets a courier "delivered" verify delivery automatically; default off = staff verify.
- `vercel.json` crons: `/api/cron/expire-orders` every 15 min, `/api/cron/reconcile` hourly, and `/api/cron/payout-run` at your payout cadence (see [Scheduled payouts](#scheduled-payouts); it needs `SYSTEM_ACTOR_ID`).
- Refund money itself is sent outside this API (manual bank transfer or the PayHere refund API): `request` -> `approve` -> `start`, send ONE refund keyed by the refund id, then `complete` or (only if confirmed not sent) `fail`.

## Scheduled payouts
`GET /api/cron/payout-run` creates one **pending** payout per approved seller that has a default active payout account and a positive unclaimed balance (up to 200 sellers per call; `more: true` means run it again). It never sends money: a person with `payouts.manage` still starts each transfer, so the two-person rule holds.

1. **Create the system actor** once per environment. It is an inactive user with no roles and no credentials, so it can never sign in or be the second person in a two-person rule. From the repo root:
   ```
   DATABASE_URL=... bun packages/auth/scripts/create-system-actor.ts
   ```
   (or `bun run create-system-actor` inside `packages/auth`). It prints `SYSTEM_ACTOR_ID=<uuid>` and is safe to run again. The script is `packages/auth/scripts/create-system-actor.ts`; it calls `ensureSystemActor(db)` from `@workspace/domain`, which refuses to reuse an existing `@system.invalid` user that is active or has a role.
2. **Set `SYSTEM_ACTOR_ID`** on the project that serves `/api/cron` (the public Next.js project, next to `CRON_SECRET`). Until it is set the route answers `503 not_configured` and creates nothing.
3. **Schedule it** in `vercel.json` at the cadence you want, e.g. daily at 03:00 UTC:
   ```json
   { "crons": [
     { "path": "/api/cron/expire-orders", "schedule": "*/15 * * * *" },
     { "path": "/api/cron/reconcile", "schedule": "0 * * * *" },
     { "path": "/api/cron/payout-run", "schedule": "0 3 * * *" }
   ] }
   ```
   Vercel sends `Authorization: Bearer $CRON_SECRET`; the route answers 401 without it and 500 if any seller errored, so cron alerting fires.
4. Staff then see the pending payouts in the admin app and start them (`POST /admin/payouts/:id/start`).

## Tests
`bun test` (needs `DATABASE_URL_TEST`, see the domain README). Every route is exercised through `app.request()` against real PostgreSQL.
