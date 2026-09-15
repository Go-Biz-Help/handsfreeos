import { z } from 'zod';
import { isoDateTime, uuid } from './common';

/**
 * Where a change was made from (the kernel's RequestMeta.channel): the web app, the Assistant, a
 * customer on a public booking page, a workflow step, the AI teammate, a visitor in the website chat…
 */
export const requestChannel = z.enum([
  'web',
  'api',
  'worker',
  'cli',
  'sms',
  'assistant',
  'booking_page',
  'workflow',
  'ai_employee',
  'chat_widget',
  'test',
]);
export type RequestChannel = z.infer<typeof requestChannel>;

export const AuditListInput = z.object({
  workspaceId: uuid,
  limit: z.number().int().min(1).max(200).default(50),
  /** Return entries created before this timestamp (cursor). */
  before: isoDateTime.optional(),
  /** Return entries created at or after this timestamp. */
  since: isoDateTime.optional(),
  actorId: uuid.optional(),
  /** Command name prefix, e.g. "membership." */
  action: z.string().max(80).optional(),
  channel: requestChannel.optional(),
});

export const AuditEntry = z.object({
  id: uuid,
  eventId: uuid,
  action: z.string(),
  actor: z.object({
    type: z.string(),
    /** The person who did it. A workflow's id is here too (its actor_id); `workflow` names it. */
    userId: uuid.nullable(),
    fullName: z.string().nullable(),
    role: z.string().nullable(),
    /** When a workflow did it: which one, so the log can say "Workflow: Speed to lead". */
    workflow: z.object({ id: uuid, name: z.string() }).nullable(),
  }),
  entityType: z.string(),
  entityId: uuid.nullable(),
  /** Display name when the entity is a person (memberships); null otherwise. */
  entityName: z.string().nullable(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  reason: z.string().nullable(),
  channel: z.string(),
  correlationId: uuid,
  causationId: uuid.nullable(),
  createdAt: isoDateTime,
});
export type AuditEntry = z.infer<typeof AuditEntry>;

export const AuditListOutput = z.object({
  entries: z.array(AuditEntry),
  nextCursor: isoDateTime.nullable(),
});
