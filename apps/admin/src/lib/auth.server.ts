// Server only. The `.server.ts` suffix makes Start refuse to bundle this file for the browser, and the
// "browser" export condition on @workspace/auth and @workspace/db/client is a second guard.
import { adminAuthenticate, createAdminAuth } from '@workspace/auth'
import { db } from '@workspace/db/client'
import { tanstackStartCookies } from 'better-auth/tanstack-start'

const need = (k: string) => {
  const v = process.env[k]
  if (!v) throw new Error(`missing environment variable ${k}`)
  return v
}

let auth: ReturnType<typeof createAdminAuth> | undefined

/** Created on first use, so a build without secrets does not fail. */
export const getAdminAuth = () =>
  (auth ??= createAdminAuth({
    db,
    secret: need('ADMIN_AUTH_SECRET'),
    baseURL: need('ADMIN_BASE_URL'),
    // Lets server code that calls auth.api.* (not the HTTP route) set cookies. Must be the last plugin.
    extraPlugins: [tanstackStartCookies()],
  }))

/** Roles come from the database, never from the session or the client. `mfaVerified` is true only for enrolled staff. */
export const getAdminPrincipal = (req: Request) => adminAuthenticate(getAdminAuth(), db)(req)
