import { z } from 'zod';
import { attentionKind, attentionScope } from './attention';
import { AppointmentStatusValue } from './calendar';
import { isoDateTime, uuid } from './common';

/**
 * Where a card's row or button goes: an app path only (the panel never renders other links). Home itself may take
 * a query ("?item=…", an Action Center item).
 */
const appPath = z.string().regex(/^\/app\/w\/[0-9a-f-]{36}([/?][A-Za-z0-9_\-/?=&.]*)?$/);
const tone = z.enum(['accent', 'warning', 'danger', 'muted']);
const named = z.object({ id: uuid, name: z.string() });

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
  /**
   * "What needs my attention?": the Action Center's list in Home's order (M8). Chats saved before M8 have only each
   * row's words, tone and link, so everything the Action Center adds is optional.
   */
  z.object({
    type: z.literal('attention'),
    /** The header: "$47,300 affected", how many need attention and how many are urgent, in Mine or Everyone. */
    affected: z
      .object({ cents: z.number(), total: z.int(), urgent: z.int(), scope: attentionScope })
      .optional(),
    items: z
      .array(
        z.object({
          title: z.string(),
          detail: z.string(),
          tone,
          waitingSince: isoDateTime.nullable(),
          href: appPath,
          /** The attention item (its row on Home). */
          itemId: uuid.optional(),
          kind: attentionKind.optional(),
          /** Up to three reason chips, worded as of the answer: "$18,500", "waiting 11 min", "qualified". */
          chips: z
            .array(z.object({ code: z.string(), text: z.string() }))
            .max(3)
            .optional(),
          /** Its value; left out when the typical job value stands in for a lead with none. */
          valueCents: z.number().optional(),
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
    /** Beside the title: "Thu, Sep 17 · Central Time". */
    aside: z.string().optional(),
    items: z
      .array(z.object({ title: z.string(), detail: z.string(), tone, href: appPath.nullable() }))
      .max(12),
  }),
  /** "When is Priya free Thursday?": open times on one calendar, a day per row; tapping one asks to book it. */
  z.object({
    type: z.literal('slots'),
    /** The teammate asked about, else the calendar's name. */
    title: z.string(),
    /** "Central Time", and the IANA zone the times are in. */
    zone: z.string(),
    timezone: z.string(),
    calendar: named,
    service: named.nullable(),
    person: z.object({ userId: uuid, fullName: z.string() }).nullable(),
    durationMinutes: z.int(),
    days: z
      .array(
        z.object({
          /** The local date, 2026-09-24. */
          date: z.string(),
          /** "Thu, Sep 24". */
          label: z.string(),
          times: z.array(z.object({ startsAt: isoDateTime, label: z.string() })).max(8),
        }),
      )
      .max(3),
    href: appPath,
  }),
  /** One appointment: what, who it's for, when, who works it and where it stands. */
  z.object({
    type: z.literal('appointment'),
    appointmentId: uuid,
    /** The service or the appointment's title: "AC tune-up". */
    what: z.string(),
    customer: z.string().nullable(),
    /** "Fri, Sep 18, 10:00–11:00 AM". */
    when: z.string(),
    with: z.string().nullable(),
    status: AppointmentStatusValue,
    href: appPath,
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
    /** Label and value pairs: To, From, Subject, Name, Phone; Customer, What, When, With… */
    fields: z.array(z.object({ label: z.string(), value: z.string() })).max(6),
    body: z.string().nullable(),
    stageFrom: z.string().nullable(),
    stageTo: z.string().nullable(),
    /**
     * Rules the person should see before saying yes: quiet hours, a possible duplicate; for appointments
     * conflict, outside_hours, busy, time_off, in_past and no_text_consent.
     */
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
  /**
   * A workflow, or a draft of one from the AI builder (a proposal nobody has applied yet): its name, what
   * starts it, its first steps, what it would change, its checks, and where to open it.
   */
  z.object({
    type: z.literal('workflow'),
    workflowId: uuid.nullable(),
    proposalId: uuid.nullable(),
    name: z.string(),
    /** 'proposal' until someone applies it. */
    status: z.enum(['proposal', 'draft', 'active', 'paused', 'archived']),
    /** "When a new lead comes in". */
    trigger: z.string(),
    /** The main path, a line a step ("Send a text: “Hi …”"). */
    steps: z.array(z.string()).max(8),
    /** Steps left off the list. */
    more: z.int().min(0),
    /** A proposal for a workflow that exists: what it changes, in plain words. */
    changes: z.array(z.string()).max(8),
    /** Checks that need a fix, and the first one's words. */
    issues: z.int().min(0),
    issueNote: z.string().nullable(),
    /** Asked for, and workflows can't do it. */
    unsupported: z.array(z.string()).max(5),
    href: appPath,
  }),
  /**
   * Money: a total ("what are we owed?") or the documents behind it. Every figure is already formatted by the
   * worker from real rows, so the model never writes an amount of its own. New in M9 — chats saved before it
   * have no card of this type, and every part beyond the headline is optional so it can stay that way.
   */
  z.object({
    type: z.literal('money'),
    /** "What you are owed", "Collected in the last 30 days", "INV-1044". */
    title: z.string(),
    /** The figure itself, already formatted: "$12,480.75". */
    value: z.string(),
    /** Under the figure: "6 invoices · 2 overdue". */
    detail: z.string().nullable().optional(),
    tone: tone.optional(),
    /** Up to four smaller figures beside it: overdue, on its way, quoted out. */
    stats: z
      .array(z.object({ value: z.string(), label: z.string() }))
      .max(4)
      .optional(),
    /** The documents behind the figure, one row each. */
    items: z
      .array(
        z.object({
          title: z.string(),
          detail: z.string(),
          /** What the document's own page calls it: "Overdue", "Paying", "Sent". */
          status: z.string().optional(),
          tone,
          href: appPath.nullable(),
        }),
      )
      .max(8)
      .optional(),
    href: appPath.nullable(),
  }),
  /** Knowledge base matches the answer drew on. */
  z.object({
    type: z.literal('knowledge'),
    items: z
      .array(
        z.object({
          id: uuid,
          kind: z.enum(['faq', 'article', 'fact', 'document']),
          title: z.string(),
          /** The best passage, matched words wrapped in ** **. */
          snippet: z.string(),
          href: appPath,
        }),
      )
      .max(5),
    href: appPath,
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

/** The page the person is looking at when they ask (from the address bar; /calendar?appt= is an appointment). */
export const AssistantPageRecord = z.object({
  type: z.enum([
    'person',
    'company',
    'lead',
    'conversation',
    'appointment',
    'workflow',
    'workflow_run',
  ]),
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
