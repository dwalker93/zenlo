import { eq } from 'drizzle-orm';
import { users } from '@workspace/db/schema';
import type { Db } from './types';

/**
 * A non-human actor for scheduled jobs, so their audit rows and `payouts.created_by` name a real user row.
 * It is created INACTIVE with no roles, no password and no OAuth account: it can never sign in, and it holds
 * no permission, so it can never be the second person in a two-person rule. Idempotent: returns the same id every time.
 */
export async function ensureSystemActor(db: Db, key = 'payout-runner'): Promise<string> {
  if (!/^[a-z0-9-]{3,40}$/.test(key)) throw new Error('system actor key must be 3-40 chars of a-z, 0-9, -');
  const email = `${key}@system.invalid`;
  await db.insert(users).values({ email, name: `System: ${key}`, isActive: false, emailVerified: true }).onConflictDoNothing({ target: users.email });
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  return u.id;
}
