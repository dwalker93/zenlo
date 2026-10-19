import type { Principal } from './auth';

/**
 * Permissions are defined here, in code, and routes check permissions, never role names.
 * Add a permission only together with the route that needs it.
 */
export const PERMISSIONS = [
  'payments.confirm',
  'delivery.verify',
  'refunds.request',
  'refunds.approve',
  'refunds.process',
  'payouts.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export type StaffRole = 'admin' | 'finance' | 'support';
export const STAFF_ROLES: readonly StaffRole[] = ['admin', 'finance', 'support'];

export const ROLE_PERMISSIONS: Record<StaffRole, readonly Permission[]> = {
  admin: PERMISSIONS,
  finance: ['payments.confirm', 'delivery.verify', 'refunds.request', 'refunds.approve', 'refunds.process', 'payouts.manage'],
  support: ['refunds.request'],
};

export const isStaff = (p: Pick<Principal, 'roles'>) => p.roles.some((r) => (STAFF_ROLES as readonly string[]).includes(r));

export function permissionsOf(p: Pick<Principal, 'roles'>): Set<Permission> {
  const out = new Set<Permission>();
  for (const r of p.roles) for (const perm of ROLE_PERMISSIONS[r as StaffRole] ?? []) out.add(perm);
  return out;
}
export const can = (p: Pick<Principal, 'roles'>, perm: Permission) => permissionsOf(p).has(perm);
