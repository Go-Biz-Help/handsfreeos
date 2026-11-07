import { z } from 'zod';
import { isoDateTime, uuid } from './common';

/**
 * Where a change was made from (the kernel's RequestMeta.channel): the web app, the phone app, the Assistant,
 * a customer on a public booking page, a workflow step, the AI teammate, a visitor in the website chat…
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
  'mobile',
  // The browser extension, for Social Outreach (docs/outreach.md).
  'extension',
  // The AI keeping customers' tags and details up to date on its own (0107).
  'contact_ai',
  // A customer signed in to their portal (Real Estate round two).
  'portal',
  'test',
]);
export type RequestChannel = z.infer<typeof requestChannel>;

/** The audit log's kinds of change, as Filter by activity names them (audit/describe.ts sorts each action into one). */
export const AUDIT_CATEGORIES = [
  'members',
  'invitations',
  'workspace',
  'customers',
  'inbox',
  'calendar',
  'leads',
  'tasks',
  'files',
  'imports',
  'workflows',
  'ai_team',
  'action_center',
  'other',
] as const;

/** Who a row says did it: a person, HandsFreeOS itself, a workflow, the AI teammate, a customer in their portal… */
export const AUDIT_ACTOR_TYPES = [
  'human',
  'system',
  'workflow',
  'assistant',
  'ai_employee',
  'api',
  'integration',
  'customer',
] as const;

export const AuditListInput = z.object({
  workspaceId: uuid,
  limit: z.number().int().min(1).max(200).default(50),
  /** Return entries created before this timestamp. */
  before: isoDateTime.optional(),
  /** The last page's `nextCursor`: the entries after it, one command's entries never split across pages. */
  cursor: z.string().max(400).optional(),
  /** Return entries created at or after this timestamp. */
  since: isoDateTime.optional(),
  actorId: uuid.optional(),
  /** Command name prefix, e.g. "membership." */
  action: z.string().max(80).optional(),
  channel: requestChannel.optional(),
  /** Only what this kind of actor did: system is HandsFreeOS itself, ai_employee the AI teammate. */
  actorType: z.enum(AUDIT_ACTOR_TYPES).optional(),
  /** Only this kind of change, as Filter by activity sorts them (customers is Contacts, inbox Texts, calls & email). */
  category: z.enum(AUDIT_CATEGORIES).optional(),
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
  /** Pass back as `cursor` for the next page. */
  nextCursor: z.string().nullable(),
});
