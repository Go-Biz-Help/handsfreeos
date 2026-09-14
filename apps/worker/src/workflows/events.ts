/**
 * The engine's own footprint in the event stream and the audit log: a run started or ended, an approval
 * opened or expired, a webhook address revealed. Recorded as the workflow (actor_id the workflow, channel
 * 'workflow') or as the system; the worker never records as a person (the database refuses that), so work
 * done on someone's request names them in the payload instead. Broadcast live like every event.
 */
import { randomUUID } from 'node:crypto';
import type { Tx } from '@hfos/db/client';
import { auditLogs, events, outbox } from '@hfos/db/schema';

export type EngineActor =
  { readonly type: 'workflow'; readonly workflowId: string } | { readonly type: 'system' };

export interface EngineEventInput {
  readonly type: string;
  /** The audit log's action. */
  readonly action: string;
  readonly workspaceId: string;
  readonly organizationId: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly payload?: Record<string, unknown>;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly actor: EngineActor;
  readonly correlationId?: string | null;
  readonly causationId?: string | null;
}

export async function recordEngineEvent(tx: Tx, e: EngineEventInput): Promise<string> {
  const id = randomUUID();
  const correlationId = e.correlationId ?? randomUUID();
  const actorType = e.actor.type;
  const actorId = e.actor.type === 'workflow' ? e.actor.workflowId : null;
  await tx.insert(events).values({
    id,
    organizationId: e.organizationId,
    workspaceId: e.workspaceId,
    eventType: e.type,
    actorType,
    actorId,
    entityType: e.entityType,
    entityId: e.entityId,
    payload: e.payload ?? {},
    correlationId,
    causationId: e.causationId ?? null,
  });
  await tx.insert(outbox).values({
    eventId: id,
    organizationId: e.organizationId,
    workspaceId: e.workspaceId,
    eventType: e.type,
  });
  await tx.insert(auditLogs).values({
    eventId: id,
    organizationId: e.organizationId,
    workspaceId: e.workspaceId,
    actorType,
    actorId,
    actorRole: actorType,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    before: e.before ?? null,
    after: e.after ?? null,
    channel: actorType === 'workflow' ? 'workflow' : 'worker',
    correlationId,
    causationId: e.causationId ?? null,
  });
  return id;
}
