import { Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import * as schema from './schema';

// neon-serverless (WebSocket Pool) is used instead of neon-http because
// checkout, refunds and payouts need real multi-statement transactions
// with row locks. On Node versions without a global WebSocket, set
// neonConfig.webSocketConstructor = ws (from the "ws" package).
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const db = drizzle(pool, { schema });
export type Database = typeof db;
