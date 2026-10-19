import { eq } from 'drizzle-orm';
import { userRoles, users } from '@workspace/db/schema';
import type { Db } from './types';

/**
 * A non-human actor for scheduled jobs, so their audit rows and `payouts.created_by` name a real user row.
 * It is created INACTIVE with no roles, no password and no OAuth account: it can never sign in, and it holds
 * no permission, so it can never be the second person in a two-person rule. Idempotent: returns the same id every time. Refuses (throws) to reuse an existing row that is active or holds a role.
 */
export async function ensureSystemActor(db: Db, key = 'payout-runner'): Promise<string> {
  if (!/^[a-z0-9-]{3,40}$/.test(key)) throw new Error('system actor key must be 3-40 chars of a-z, 0-9, -');
  const email = `${key}@system.invalid`;
  await db.insert(users).values({ email, name: `System: ${key}`, isActive: false, emailVerified: true }).onConflictDoNothing({ target: users.email });
  const [u] = await db.select({ id: users.id, isActive: users.isActive }).from(users).where(eq(users.email, email));
  if (!u) throw new Error(`system actor ${key} could not be created`);
  // The email is unique, so the insert above may have left a pre-existing row in place. Only reuse one that honours the contract.
  if (u.isActive) throw new Error(`user ${email} exists and is active; refusing to use it as a system actor`);
  const [role] = await db.select({ userId: userRoles.userId }).from(userRoles).where(eq(userRoles.userId, u.id)).limit(1);
  if (role) throw new Error(`user ${email} has roles; refusing to use it as a system actor`);
  return u.id;
}
