/**
 * Create a staff account. The admin app has no sign-up, so this (or a future admin screen calling provisionStaff) is the only way in.
 *
 *   ADMIN_AUTH_SECRET=... ADMIN_BASE_URL=https://admin.example.com DATABASE_URL=... \
 *   bun packages/auth/scripts/create-staff.ts --email a@b.com --name "A B" --role finance
 *
 * Password: STAFF_PASSWORD if set, otherwise a random one printed once. The person signs in, enrolls two-factor, then changes it.
 */
import { randomBytes } from 'node:crypto';
import { db } from '@workspace/db/client';
import { STAFF_ROLES, type StaffRole } from '@workspace/api/permissions';
import { createAdminAuth, provisionStaff } from '../src';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing environment variable ${k}`);
  return v;
};

const email = arg('email');
const name = arg('name');
const role = arg('role') as StaffRole | undefined;
if (!email || !name || !role || !STAFF_ROLES.includes(role)) {
  console.error(`usage: --email <email> --name <name> --role <${STAFF_ROLES.join('|')}>`);
  process.exit(1);
}

const auth = createAdminAuth({ db, secret: need('ADMIN_AUTH_SECRET'), baseURL: need('ADMIN_BASE_URL') });
const password = process.env.STAFF_PASSWORD ?? randomBytes(18).toString('base64url');
const { userId } = await provisionStaff(auth, db, { email, name, role, password });
console.log(`created ${role} ${email} (${userId})`);
if (!process.env.STAFF_PASSWORD) console.log(`temporary password (shown once): ${password}`);
process.exit(0);
