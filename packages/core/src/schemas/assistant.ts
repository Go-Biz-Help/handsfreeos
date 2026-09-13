import { z } from 'zod';
import { isoDateTime, uuid } from './common';

/** Where a card's row or button goes: an app path only (the panel never renders other links). */
const appPath = z.string().regex(/^\/app\/w\/[0-9a-f-]{36}(\/[A-Za-z0-9_\-/?=&.]*)?$/);
const tone = z.enum(['accent', 'warning', 'danger', 'muted']);

/**
 * What the panel draws under an answer. Every card is built by the worker from real records, so
 * names, numbers and links never come from the model's own words.
 */
export const AssistantCard = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('customer'),
    personId: uuid,
    fullName: z.string(),
    detail: z.string(),
    href: appPath,
    lead: z.object({ title: z.string(), stageName: z.string(), valueCents: z.number() }).nullable(),
    waitingSince: isoDateTime.nullable(),
  }),
  z.object({
    type: z.literal('lead'),
    leadId: uuid,
    title: z.string(),
    customer: z.string(),
    stageName: z.string(),
    valueCents: z.number(),
    assignee: z.string().nullable(),
    nextAction: z.string().nullable(),
    needsNextAction: z.boolean(),
    href: appPath,
  }),
  z.object({
    type: z.literal('choices'),
    title: z.string(),
    items: z
      .array(z.object({ id: uuid, label: z.string(), detail: z.string(), href: appPath }))
      .max(8),
  }),
  z.object({
    type: z.literal('attention'),
    items: z
      .array(
        z.object({
          title: z.string(),
          detail: z.string(),
          tone,
          waitingSince: isoDateTime.nullable(),
          href: appPath,
        }),
      )
      .max(8),
  }),
  z.object({
    type: z.literal('numbers'),
    label: z.string(),
    value: z.string(),
    delta: z.string().nullable(),
    stats: z.array(z.object({ value: z.string(), label: z.string() })).max(4),
    href: appPath.nullable(),
  }),
  z.object({
    type: z.literal('list'),
    title: z.string(),
    items: z
      .array(z.object({ title: z.string(), detail: z.string(), tone, href: appPath.nullable() }))
      .max(12),
  }),
  z.object({
    type: z.literal('done'),
    toolCallId: uuid,
    kind: z.enum(['task', 'note']),
    title: z.string(),
    detail: z.string(),
    href: appPath.nullable(),
    /** Whether Undo can take it back (adding a task or a note, completing a task). */
    undoable: z.boolean(),
  }),
  z.object({
    type: z.literal('confirm'),
    toolCallId: uuid,
    tool: z.string(),
    /** Who a text or email goes to, so Edit opens the right composer. */
    personId: uuid.nullable(),
    conversationId: uuid.nullable(),
    title: z.string(),
    /** Label and value pairs: To, From, Subject, Name, Phone… */
    fields: z.array(z.object({ label: z.string(), value: z.string() })).max(6),
    body: z.string().nullable(),
    stageFrom: z.string().nullable(),
    stageTo: z.string().nullable(),
    /** Rules the person should see before saying yes (quiet hours, a possible duplicate). */
    warnings: z.array(z.object({ kind: z.string(), text: z.string() })).max(3),
    /** Lost reasons to pick from when moving a lead to a lost stage. */
    reasons: z.array(z.string()).max(12),
    confirmLabel: z.string(),
    editable: z.boolean(),
  }),
  z.object({
    type: z.literal('call'),
    personId: uuid,
    fullName: z.string(),
    phone: z.string(),
  }),
]);
export type AssistantCard = z.infer<typeof AssistantCard>;

export const assistantToolStatus = z.enum([
  'done',
  'failed',
  'awaiting_confirmation',
  'confirmed',
  'cancelled',
  'expired',
]);

/** A tool call as the panel needs it: the state behind a confirmation or "done" card. */
export const AssistantToolCallOut = z.object({
  id: uuid,
  tool: z.string(),
  status: assistantToolStatus,
  /** One plain sentence about the outcome ("Sent to Mike Johnson", "Moved to Won"). */
  outcome: z.string().nullable(),
  error: z.string().nullable(),
  href: appPath.nullable(),
  /** A task or note the Assistant added on its own that someone took back with Undo. */
  undone: z.boolean(),
});

export const AssistantMessageOut = z.object({
  id: uuid,
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  cards: z.array(AssistantCard),
  createdAt: isoDateTime,
});

export const AssistantThreadSummary = z.object({
  id: uuid,
  title: z.string(),
  lastMessageAt: isoDateTime,
});

export const AssistantThreadListInput = z.object({
  workspaceId: uuid,
  limit: z.number().int().min(1).max(50).default(20),
});
export const AssistantThreadListOutput = z.object({ items: z.array(AssistantThreadSummary) });

export const AssistantThreadGetInput = z.object({ workspaceId: uuid, threadId: uuid });
export const AssistantThreadGetOutput = z.object({
  thread: AssistantThreadSummary,
  messages: z.array(AssistantMessageOut),
  toolCalls: z.array(AssistantToolCallOut),
});

export const AssistantThreadRenameInput = z.object({
  workspaceId: uuid,
  threadId: uuid,
  title: z.string().trim().min(1).max(200),
});
export const AssistantThreadArchiveInput = z.object({ workspaceId: uuid, threadId: uuid });
export const AssistantThreadOutput = z.object({ threadId: uuid });

/** The page the person is looking at when they ask (from the address bar). */
export const AssistantPageRecord = z.object({
  type: z.enum(['person', 'company', 'lead', 'conversation']),
  id: uuid,
});

/** What the browser sends to the worker for one question. */
export const AssistantAskInput = z.object({
  workspaceId: uuid,
  threadId: uuid.optional(),
  text: z.string().trim().min(1).max(4000),
  page: AssistantPageRecord.nullable().default(null),
});

export const assistantErrorCode = z.enum([
  'not_configured',
  'budget_reached',
  'busy',
  'already_running',
  'failed',
  'stopped',
]);

/** One server-sent event while the worker answers. */
export const AssistantEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run'), runId: uuid, threadId: uuid }),
  z.object({
    type: z.literal('step'),
    id: z.string(),
    label: z.string(),
    status: z.enum(['running', 'done', 'failed']),
  }),
  z.object({ type: z.literal('text'), delta: z.string() }),
  z.object({ type: z.literal('card'), card: AssistantCard }),
  z.object({ type: z.literal('done'), messageId: uuid }),
  z.object({ type: z.literal('error'), code: assistantErrorCode, message: z.string() }),
]);
export type AssistantEvent = z.infer<typeof AssistantEvent>;

export const AssistantDecisionInput = z.object({
  workspaceId: uuid,
  /** Required when a lost stage needs a reason. */
  lostReason: z.string().trim().min(1).max(300).optional(),
});
export const AssistantDecisionOutput = AssistantToolCallOut;
