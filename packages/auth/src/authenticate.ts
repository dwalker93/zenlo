import { eq } from 'drizzle-orm';
import { sellerProfiles, userRoles, users } from '@workspace/db/schema';
import type { Db } from '@workspace/domain';
import { STAFF_ROLES } from '@workspace/api/permissions';
import type { Authenticate, Principal } from '@workspace/api';
import type { AdminAuth, PublicAuth } from './factory';

type SessionSource = { api: { getSession(o: { headers: Headers }): Promise<{ user: { id: string } } | null> } };

/** One query: the user's state, every role, and the seller profile if any. Roles always come from the database, never from the session or the client. */
async function loadIdentity(db: Db, userId: string) {
  const rows = await db
    .select({
      isActive: users.isActive,
      twoFactorEnabled: users.twoFactorEnabled,
      role: userRoles.role,
      sellerId: sellerProfiles.id,
      sellerStatus: sellerProfiles.status,
    })
    .from(users)
    .leftJoin(userRoles, eq(userRoles.userId, users.id))
    .leftJoin(sellerProfiles, eq(sellerProfiles.userId, users.id))
    .where(eq(users.id, userId));
  if (rows.length === 0) return null;
  return {
    isActive: rows[0].isActive,
    twoFactorEnabled: rows[0].twoFactorEnabled,
    roles: new Set(rows.flatMap((r) => (r.role ? [r.role] : []))),
    sellerId: rows[0].sellerId,
    sellerStatus: rows[0].sellerStatus,
  };
}

async function sessionUserId(auth: SessionSource, req: Request) {
  try {
    const s = await auth.api.getSession({ headers: req.headers });
    return s?.user.id ?? null;
  } catch {
    return null; // a broken or tampered session is just "signed out"
  }
}

/**
 * Public app. Only customer and seller roles are ever returned (a staff member browsing the shop is a customer at most),
 * and 'seller' only while the seller profile is approved, so a suspended or pending seller cannot ship or cancel.
 */
export function publicAuthenticate(auth: PublicAuth, db: Db): Authenticate {
  return async (req) => {
    const userId = await sessionUserId(auth, req);
    if (!userId) return null;
    const id = await loadIdentity(db, userId);
    if (!id || !id.isActive) return null;
    const roles: Principal['roles'] = [];
    if (id.roles.has('customer')) roles.push('customer');
    const sellerApproved = id.roles.has('seller') && id.sellerId && id.sellerStatus === 'approved';
    if (sellerApproved) roles.push('seller');
    return { userId, roles, sellerId: sellerApproved ? id.sellerId : null };
  };
}

/**
 * Admin app. Only staff roles are returned. `mfaVerified` is true only when the user has an enrolled second factor:
 * with two-factor enabled Better Auth does not create the session until the code is verified, so a live session for
 * such a user means they passed it. A user without one gets mfaVerified=false and the admin API refuses them.
 */
export function adminAuthenticate(auth: AdminAuth, db: Db): Authenticate {
  return async (req) => {
    const userId = await sessionUserId(auth, req);
    if (!userId) return null;
    const id = await loadIdentity(db, userId);
    if (!id || !id.isActive) return null;
    const roles = STAFF_ROLES.filter((r) => id.roles.has(r));
    return { userId, roles, mfaVerified: id.twoFactorEnabled };
  };
}
