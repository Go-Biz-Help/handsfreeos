import { randomUUID } from 'node:crypto';
import type { Tx } from '@hfos/db/client';
import { auditLogs, events, outbox } from '@hfos/db/schema';

export interface SystemEventInput {
  readonly type: string;
  readonly action: string;
  readonly organizationId: string | null;
  readonly workspaceId: string | null;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly payload?: Record<string, unknown>;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly correlationId: string;
  readonly causationId: string;
  /** The add-on it's about, when it is one's (an add-on's alert): its details go when the add-on's data is deleted. */
  readonly addonId?: string | null;
}

/** The worker's own footprint in the event stream and audit log: actor `system`, caused by the event it handled. */
export async function recordSystemEvent(tx: Tx, input: SystemEventInput): Promise<string> {
  const id = randomUUID();
  await tx.insert(events).values({
    id,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    eventType: input.type,
    actorType: 'system',
    actorId: null,
    entityType: input.entityType,
    entityId: input.entityId,
    payload: input.payload ?? {},
    correlationId: input.correlationId,
    causationId: input.causationId,
    addonId: input.addonId ?? null,
  });
  await tx.insert(outbox).values({
    eventId: id,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    eventType: input.type,
  });
  await tx.insert(auditLogs).values({
    eventId: id,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    actorType: 'system',
    actorId: null,
    actorRole: null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    before: input.before ?? null,
    after: input.after ?? null,
    channel: 'worker',
    correlationId: input.correlationId,
    causationId: input.causationId,
    addonId: input.addonId ?? null,
  });
  return id;
}
