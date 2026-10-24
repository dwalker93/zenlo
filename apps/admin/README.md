# Admin app (TanStack Start)

Staff-only back office. Its own project and its own auth instance (`createAdminAuth`, cookie prefix `zenlo-admin`, secret `ADMIN_AUTH_SECRET`).
Currently a shell: sign-in, TOTP enrollment, TOTP sign-in, and one protected route (`/dashboard`).

## Run
```
cp apps/admin/.env.example apps/admin/.env     # DATABASE_URL, ADMIN_AUTH_SECRET, ADMIN_BASE_URL
bun run create-staff -- --email you@example.com --name "You" --role admin   # in packages/auth; the admin app has no sign-up
bun run dev                                    # from apps/admin: http://localhost:3001
```
Use the same `ADMIN_AUTH_SECRET` and `ADMIN_BASE_URL` for `create-staff` and the app.

## How it fits together
| File | Role |
|---|---|
| `src/routes/api/auth/$.ts` | Hands every `/api/auth/*` request to Better Auth (`getAdminAuth().handler`). Sign-in, sign-out, two-factor enable/verify all go through it. |
| `src/lib/auth.server.ts` | Server only (`.server.ts`). Builds the admin auth lazily and adds `tanstackStartCookies()` as the last plugin. |
| `src/lib/session.functions.ts` | `getAdminSession` server function: role and MFA state come from `adminAuthenticate` (database), not from the session. |
| `src/lib/auth-client.ts` | Browser client with `twoFactorClient()`. |
| `src/routes/index.tsx` | Signed out -> `/login`; signed in without a second factor -> `/enroll`; otherwise `/dashboard`. |

## Verified (against PostgreSQL 16, local)
- HTTP level: redirects for every state, cookie flags (HttpOnly, SameSite=Lax, `zenlo-admin.` prefix), foreign origin refused, wrong code refused, the pending-2FA cookie is not a session, **completing enrollment revokes the enrolling device's old session and every other session**.
- Real browser (Chromium): sign-in -> enroll -> dashboard -> sign out -> sign-in with code (wrong code shows an error) -> dashboard -> reload keeps the session.
- `vite build` succeeds; the client bundle contains no server code.

## Known limits / next
- No QR code: the enrollment page shows the key and an `otpauth://` link. Add a QR library when polishing.
- Deployment: `vite build` outputs `dist/client` and `dist/server/server.js` (a fetch handler). Vercel needs Start's Nitro/Vercel preset; not set up yet.
- The Hono admin API (`createAdminApp`) is not mounted yet; mount it under `/api/admin` with `adminAuthenticate` when the first admin screen needs it.
- Admin sign-in is rate limited to 5 per 5 minutes per IP (Better Auth, stored in Postgres); the UI says so on 429.
- `@workspace/db/client` uses the Neon WebSocket driver, so local development needs a Neon database (or a Neon-compatible proxy), not a plain local Postgres.
