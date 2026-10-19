import type { MiddlewareHandler } from 'hono';
import { HttpError } from './http';

const norm = (o: string) => o.trim().replace(/\/$/, '').toLowerCase();

/**
 * CSRF guard for cookie-authenticated apps. A state-changing request from a browser must come from one of our own
 * origins. Browsers always send Origin on cross-origin writes; when it is absent we fall back to Sec-Fetch-Site,
 * and requests with neither (curl, server-to-server) are allowed because they carry no ambient browser cookies.
 */
export const requireTrustedOrigin = (trusted: readonly string[] | undefined): MiddlewareHandler => {
  // Fail closed: an empty list would not mean "allow nothing" to a reader, and silently skipping the guard is worse.
  if (!trusted || trusted.length === 0) throw new Error('trustedOrigins must list at least one origin (CSRF guard)');
  const allowed = new Set(trusted.map(norm));
  return async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS') return next();
    const origin = c.req.header('origin');
    if (origin !== undefined) {
      if (!allowed.has(norm(origin))) throw new HttpError(403, 'bad_origin', 'Request origin is not allowed');
    } else if (c.req.header('sec-fetch-site') === 'cross-site') {
      throw new HttpError(403, 'bad_origin', 'Cross-site request refused');
    }
    await next();
  };
};
