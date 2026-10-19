/**
 * Create (or find) the system actor that scheduled payout runs act as, and print its id.
 *
 *   DATABASE_URL=... bun packages/auth/scripts/create-system-actor.ts
 *
 * Put the printed id in SYSTEM_ACTOR_ID for the machine app (the one serving /api/cron/payout-run).
 * The actor is inactive, has no roles and no credentials: it cannot sign in and cannot approve or start anything.
 * Safe to run again; it prints the same id.
 */
import { db } from '@workspace/db/client';
import { ensureSystemActor } from '@workspace/domain';

const id = await ensureSystemActor(db);
console.log(`SYSTEM_ACTOR_ID=${id}`);
process.exit(0);
