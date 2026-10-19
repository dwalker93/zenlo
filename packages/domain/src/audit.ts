import { auditLogs } from '@workspace/db/schema';
import type { Db } from './types';

/** Write an audit row inside the caller's transaction. */
export async function audit(
  tx: Db,
  e: { actorId?: string | null; action: string; entityType: string; entityId: string; metadata?: Record<string, unknown> },
) {
  await tx.insert(auditLogs).values({
    actorId: e.actorId ?? null,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    metadata: e.metadata ?? null,
  });
}
