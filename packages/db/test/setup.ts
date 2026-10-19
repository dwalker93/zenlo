import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '../src/schema';

export async function createTestDb() {
  const client = new PGlite(); // in-memory Postgres
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: resolve(import.meta.dir, '../drizzle') });
  return { db, client };
}
export type TestDb = Awaited<ReturnType<typeof createTestDb>>['db'];
