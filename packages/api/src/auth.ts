import type { Context, MiddlewareHandler } from 'hono';
import { HttpError } from './http';
import { can, isStaff, type Permission } from './permissions';

export interface Principal {
  userId: string;
  roles: ('customer' | 'seller' | 'admin' | 'finance' | 'support')[];
  /** Staff only: true when this session passed a second factor. The admin app refuses staff without it. */
  mfaVerified?: boolean;
  /** seller_profiles.id when the user is a seller */
  sellerId?: string | null;
}
/** Plug in Better Auth / Auth.js here: resolve the session from the request, or null when signed out. */
export type Authenticate = (req: Request) => Promise<Principal | null>;

export type Env = { Variables: { principal: Principal } };

export const requireUser = (authenticate: Authenticate): MiddlewareHandler<Env> => async (c, next) => {
  const p = await authenticate(c.req.raw);
  if (!p) throw new HttpError(401, 'unauthenticated', 'Sign in first');
  c.set('principal', p);
  await next();
};

export const requireRole = (role: Principal['roles'][number]): MiddlewareHandler<Env> => async (c, next) => {
  if (!c.get('principal').roles.includes(role)) throw new HttpError(403, 'forbidden', `Requires the ${role} role`);
  await next();
};

export const principalOf = (c: Context<Env>) => c.get('principal');

/** Staff-only gate for the admin app: a staff role, and (unless disabled for dev/tests) a second factor. */
export const requireStaff = (requireMfa: boolean): MiddlewareHandler<Env> => async (c, next) => {
  const p = c.get('principal');
  if (!isStaff(p)) throw new HttpError(403, 'forbidden', 'Staff only');
  if (requireMfa && !p.mfaVerified) throw new HttpError(403, 'mfa_required', 'Multi-factor authentication is required');
  await next();
};

export const requirePermission = (perm: Permission): MiddlewareHandler<Env> => async (c, next) => {
  if (!can(c.get('principal'), perm)) throw new HttpError(403, 'forbidden', `Requires permission ${perm}`);
  await next();
};
