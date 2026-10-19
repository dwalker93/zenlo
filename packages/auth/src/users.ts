import { eq, inArray } from 'drizzle-orm';
import { sessions, userRoles, users } from '@workspace/db/schema';
import type { Db } from '@workspace/domain';
import { STAFF_ROLES, type StaffRole } from '@workspace/api/permissions';
import type { AdminAuth } from './factory';

export interface ProvisionStaffInput {
  email: string;
  name: string;
  role: StaffRole;
  /** At least 12 characters. The person should change it at first sign-in. */
  password: string;
}

/**
 * Create a staff account (the admin instance has no sign-up). Run from a script or a one-off admin action, never from a public route.
 * The account has no second factor yet: the person signs in once to enroll it, and until then the admin API refuses them.
 */
export async function provisionStaff(auth: AdminAuth, db: Db, input: ProvisionStaffInput) {
  if (!(STAFF_ROLES as readonly string[]).includes(input.role)) throw new Error(`not a staff role: ${input.role}`);
  if (input.password.length < 12) throw new Error('staff passwords must be at least 12 characters');
  const email = input.email.trim().toLowerCase();
  const ctx = await auth.$context;
  if (await ctx.internalAdapter.findUserByEmail(email, { includeAccounts: false })) throw new Error(`a user with ${email} already exists`);
  const user = await ctx.internalAdapter.createUser({ email, name: input.name, emailVerified: true }, { method: 'admin' });
  await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: 'credential', accountId: user.id, password: await ctx.password.hash(input.password) });
  await db.insert(userRoles).values({ userId: user.id, role: input.role });
  return { userId: user.id };
}

/** Switch a user off and end every session they hold, so the change takes effect now, not at session expiry. */
export async function deactivateUser(db: Db, userId: string) {
  await db.transaction(async (tx) => {
    await tx.update(users).set({ isActive: false }).where(eq(users.id, userId));
    await tx.delete(sessions).where(eq(sessions.userId, userId));
  });
}

/** Change what a user may do and end their sessions, so old sessions never carry stale access. */
export async function setUserRoles(db: Db, userId: string, roles: (typeof userRoles.$inferInsert.role)[]) {
  await db.transaction(async (tx) => {
    await tx.delete(userRoles).where(eq(userRoles.userId, userId));
    if (roles.length) await tx.insert(userRoles).values(roles.map((role) => ({ userId, role })));
    await tx.delete(sessions).where(inArray(sessions.userId, [userId]));
  });
}
