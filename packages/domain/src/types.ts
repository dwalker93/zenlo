import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type * as schema from '@workspace/db/schema';

/**
 * Any drizzle Postgres database or transaction (neon-serverless in
 * production, node-postgres or PGlite in tests). Use cases open their own
 * transaction with `db.transaction(...)`.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
