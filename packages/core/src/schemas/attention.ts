/**
 * The Action Center's commands and queries (M8): the ranked list, the badge, the banners on other pages, what
 * Let HandsFreeOS Handle would do, and the item commands. Browser-safe.
 */
import { z } from 'zod';
import { ATTENTION_KINDS, AUTO_ACTIONS } from '../attention/kinds';
import { AttentionSettings } from '../attention/settings';
import { REASON_CODES } from '../attention/types';
import { isoDateTime, uuid } from './common';
import { notApplied } from './crm';

export const ATTENTION_STATES = ['open', 'snoozed', 'dismissed', 'handled', 'resolved'] as const;
export const attentionKind = z.enum(ATTENTION_KINDS);
export const attentionState = z.enum(ATTENTION_STATES);
export const attentionScope = z.enum(['mine', 'everyone']);
export const autoAction = z.enum(AUTO_ACTIONS);
export const autoState = z.enum(['scheduled', 'sent', 'skipped', 'cancelled']);
export const handledVia = z.enum(['person', 'let_handle', 'auto']);
/** The channel an item would use with the customer: a text, an email, or a reply in a website chat. */
export const attentionReach = z.enum(['sms', 'email', 'chat']);

/** What Let HandsFreeOS Handle does for an ask-first item, as the person who chose it. */
export const ATTENTION_ASK_ACTIONS = ['hand_to_ai', 'reply', 'set_next_action'] as const;
export const attentionAskAction = z.enum(ATTENTION_ASK_ACTIONS);
export type AttentionAskAction = (typeof ATTENTION_ASK_ACTIONS)[number];

const itemRef = { workspaceId: uuid, itemId: uuid };
const person = z.object({ id: uuid, fullName: z.string() });

// ---------- one item, as the list and the banners show it ----------

export const AttentionChipOut = z.object({
  code: z.enum(REASON_CODES),
  /** The words as stored. */
  label: z.string(),
  /** The words as of this read (ticking chips recount: "waiting 12 min"). */
  text: z.string(),
  since: isoDateTime.optional(),
  until: isoDateTime.optional(),
});

/** What this person may do with the item (each action's permissions, and deciding an approval). */
export const AttentionActionsOut = z.object({
  handle: z.boolean(),
  letHandle: z.boolean(),
  assign: z.boolean(),
  snooze: z.boolean(),
  dismiss: z.boolean(),
});

export const AttentionItemOut = z.object({
  id: uuid,
  kind: attentionKind,
  state: attentionState,
  /** What it is about: lead, attendee, approval, conversation or task, and that row's id. */
  subject: z.object({ type: z.string(), id: uuid }),
  personId: uuid.nullable(),
  leadId: uuid.nullable(),
  conversationId: uuid.nullable(),
  /** A "Not confirmed" item's appointment, and when it starts (as it stands now); null for other kinds. */
  appointmentId: uuid.nullable(),
  startsAt: isoDateTime.nullable(),
  /**
   * How the item reaches the customer: its automatic action (a confirmation request or a nudge, by the same rules
   * as the preview), a person's reply for a hot lead, an unanswered lead or a waiting customer, or the follow-up
   * a money card would send. Null when it doesn't contact them, or nothing can reach them.
   */
  reach: attentionReach.nullable(),
  /** A phone number to ring, and the business is open: the card offers the call before the message. */
  callable: z.boolean().default(false),
  title: z.string(),
  detail: z.string().nullable(),
  valueCents: z.number(),
  /** The typical job value stood in: shown without dollars and left out of "$ affected". */
  valueIsEstimate: z.boolean(),
  reasons: z.array(AttentionChipOut),
  /** Past its urgent moment, as of this read. */
  urgent: z.boolean(),
  /** Its rank's score and urgency (U), as of this read. */
  score: z.number(),
  urgency: z.number(),
  since: isoDateTime.nullable(),
  urgentFrom: isoDateTime.nullable(),
  dueAt: isoDateTime.nullable(),
  openedAt: isoDateTime,
  assignee: person.nullable(),
  snoozedUntil: isoDateTime.nullable(),
  dismissedAt: isoDateTime.nullable(),
  dismissReason: z.string().nullable(),
  handled: z.object({ at: isoDateTime, via: handledVia, by: person.nullable() }).nullable(),
  /** Its automatic action: what it would be, and where it stands. */
  auto: z.object({
    action: autoAction.nullable(),
    state: autoState.nullable(),
    scheduledFor: isoDateTime.nullable(),
    doneAt: isoDateTime.nullable(),
    skipReason: z.string().nullable(),
  }),
  /** What Let HandsFreeOS Handle does: on its own, asks first, or isn't offered. */
  letHandleMode: z.enum(['auto', 'ask', 'none']),
  /** The main button's verb ("Call", "Reply", "Confirm"). */
  handleLabel: z.string(),
  actions: AttentionActionsOut,
});
export type AttentionItemOut = z.infer<typeof AttentionItemOut>;

// ---------- attention.list ----------

export const AttentionListInput = z.object({
  workspaceId: uuid,
  /** Mine: yours and unassigned ones. Left out: Mine for members, Everyone for owners and admins. */
  scope: attentionScope.optional(),
  kinds: z.array(attentionKind).max(ATTENTION_KINDS.length).optional(),
  /** Also today's handled items (the "Handled by HandsFreeOS" section). */
  includeHandled: z.boolean().default(false),
});
export const AttentionScheduledOut = z.object({
  itemId: uuid,
  kind: attentionKind,
  title: z.string(),
  action: autoAction,
  scheduledFor: isoDateTime,
});
export const AttentionListOutput = z.object({
  /** The moment the ranking and the chips were worked out. */
  now: isoDateTime,
  scope: attentionScope,
  /** Open items, urgent first, then by score. */
  items: z.array(AttentionItemOut),
  /** Today's handled items, newest first (only with includeHandled). */
  handled: z.array(AttentionItemOut),
  /** Automatic actions waiting to go out: "Coming up from HandsFreeOS". */
  scheduled: z.array(AttentionScheduledOut),
  /** "$X affected": each lead's real value once, estimates left out. */
  affectedCents: z.number(),
  counts: z.object({
    total: z.int(),
    urgent: z.int(),
    snoozed: z.int(),
    /** Open items in each scope, for the Mine / Everyone switch. */
    mine: z.int(),
    everyone: z.int(),
  }),
  /** Items handled today (by anyone, or HandsFreeOS) and items someone's action cleared today. */
  handledToday: z.int(),
});
export type AttentionListOutput = z.infer<typeof AttentionListOutput>;

// ---------- attention.summary ----------

export const AttentionSummaryInput = z.object({ workspaceId: uuid });
const tally = z.object({ total: z.int(), urgent: z.int() });
export const AttentionSummaryOutput = z.object({
  /** The viewer's default scope (Mine for members). */
  scope: attentionScope,
  total: z.int(),
  urgent: z.int(),
  mine: tally,
  everyone: tally,
});

// ---------- attention.for_record ----------

export const AttentionForRecordInput = z.object({
  workspaceId: uuid,
  recordType: z.enum(['lead', 'person', 'conversation', 'appointment', 'task']),
  recordId: uuid,
});
export const AttentionForRecordOutput = z.object({ items: z.array(AttentionItemOut) });

// ---------- attention.preview_handle ----------

/** One check behind an automatic action, in the words the Let HandsFreeOS Handle sheet shows. */
export const AttentionCheckOut = z.object({
  /** texts, email, quiet_hours, talking, busy or cooldown. */
  code: z.string(),
  /** "Nathan said texts are OK", "Outside quiet hours (8 PM to 8 AM)". */
  label: z.string(),
  ok: z.boolean(),
});
export const AttentionAutoPlanOut = z.object({
  action: autoAction,
  channel: z.enum(['sms', 'email']).nullable(),
  /** Who it goes to: "(512) 555-0142" or an address. */
  to: z.string().nullable(),
  /** An email's subject. */
  subject: z.string().nullable(),
  /** The words exactly as they'd go out (a preview shows a placeholder for the booking link). */
  text: z.string().nullable(),
  /** When it would go: after the cancel window, and after quiet hours for a text. */
  sendAt: isoDateTime.nullable(),
  /** Already waiting to go out. */
  scheduledFor: isoDateTime.nullable(),
  /** Why it can't go, in plain words, or null. */
  blocked: z.object({ code: z.string(), message: z.string() }).nullable(),
  /** What else to know ("They haven't agreed to texts, so this goes by email."). */
  notes: z.array(z.string()),
  /** The checks it ran, in order ("Checked just now"). A failed one also feeds `blocked` or `notes`. */
  checks: z.array(AttentionCheckOut),
});
export type AttentionAutoPlanOut = z.infer<typeof AttentionAutoPlanOut>;
export const AttentionAskOptionOut = z.object({
  action: attentionAskAction,
  label: z.string(),
  available: z.boolean(),
  /** Why not, in plain words, when it isn't available. */
  reason: z.string().nullable(),
  channel: z.enum(['sms', 'email', 'chat']).nullable(),
  conversationId: uuid.nullable(),
  /** A suggested next action. */
  suggestion: z.object({ text: z.string(), dueAt: isoDateTime.nullable() }).nullable(),
  /**
   * The message already written, for the person to read, change or send as it is: a money card's follow-up,
   * built from the document's own figures. Nothing sends it but a person.
   */
  draft: z.object({ body: z.string(), subject: z.string().nullable() }).nullable().default(null),
  /**
   * What the person should know before they send it — "Your last reminder about this invoice went out by text
   * on Fri, Sep 18" — whether or not the option is available.
   */
  note: z.string().nullable().default(null),
});
export type AttentionAskOptionOut = z.infer<typeof AttentionAskOptionOut>;
export const AttentionPreviewHandleInput = z.object(itemRef);
export const AttentionPreviewHandleOutput = z.object({
  itemId: uuid,
  kind: attentionKind,
  mode: z.enum(['auto', 'ask', 'none']),
  /** On its own: the message, channel and time, or why it can't. */
  auto: AttentionAutoPlanOut.nullable(),
  /** Asks first: the choices, each as the person would run it. */
  options: z.array(AttentionAskOptionOut),
  /** Not offered: why. */
  reason: z.string().nullable(),
});

// ---------- attention.settings ----------

export const AttentionSettingsGetInput = z.object({ workspaceId: uuid });
export const AttentionSettingsGetOutput = z.object({
  /** The saved settings, every default filled in. */
  settings: AttentionSettings,
  /**
   * The typical job value HandsFreeOS works out for itself (what it uses when `settings.typicalJobValueCents` is
   * null): the median won lead over the last 365 days, else $500.
   */
  typicalJobValueCents: z.int(),
  typicalFrom: z.enum(['won_median', 'default']),
});

// ---------- item commands ----------

export const AttentionItemRefInput = z.object(itemRef);
export const AttentionItemStateOutput = z.object({
  itemId: uuid,
  state: attentionState,
  snoozedUntil: isoDateTime.nullable(),
  /** False when it was already that way, or a later change stood. */
  changed: z.boolean(),
  /**
   * ['state'] when a snooze or dismissal was overtaken (M10): the card came back with something new, or someone
   * snoozed or dismissed it, later than it was made.
   */
  notApplied,
});
export const AttentionSnoozeInput = z.object({ ...itemRef, until: isoDateTime });
export const AttentionDismissInput = z.object({
  ...itemRef,
  reason: z.string().trim().max(500, 'Keep it under 500 characters.').nullable().optional(),
});
export const AttentionAssignInput = z.object({ ...itemRef, assigneeUserId: uuid.nullable() });
export const AttentionAssignOutput = z.object({
  itemId: uuid,
  assigneeUserId: uuid.nullable(),
  /** For Undo. */
  previousAssigneeUserId: uuid.nullable(),
  /** The real owner it changed, or null for an appointment or approval (the item's own). */
  passedTo: z.enum(['lead', 'conversation', 'task']).nullable(),
  changed: z.boolean(),
});

export const AttentionLetHandleInput = z.object({
  ...itemRef,
  /** Ask-first items: what to do. Left out for items HandsFreeOS handles on its own. */
  action: attentionAskAction.optional(),
  /** reply: the message, its channel (the conversation's by default), an email's subject. */
  body: z.string().trim().min(1, 'Write a message.').max(10000).optional(),
  channel: z.enum(['sms', 'email', 'chat']).optional(),
  subject: z.string().trim().max(200).optional(),
  acknowledgeQuietHours: z.boolean().default(false),
  /** set_next_action: what to do next, and when. */
  text: z.string().trim().min(1, 'Say what to do next.').max(500).optional(),
  dueAt: isoDateTime.nullable().optional(),
});
export const AttentionLetHandleOutput = z.object({
  itemId: uuid,
  mode: z.enum(['auto', 'ask']),
  action: z.enum([...AUTO_ACTIONS, ...ATTENTION_ASK_ACTIONS]),
  /** requested: the worker schedules it; already_scheduled: it was waiting already; done: carried out. */
  status: z.enum(['requested', 'already_scheduled', 'done']),
  state: attentionState,
  scheduledFor: isoDateTime.nullable(),
  conversationId: uuid.nullable(),
  messageId: uuid.nullable(),
});
export const AttentionCancelAutoOutput = z.object({
  itemId: uuid,
  autoState: autoState.nullable(),
  changed: z.boolean(),
});

export const AttentionSaveSettingsInput = z.object({
  workspaceId: uuid,
  settings: AttentionSettings,
});
export const AttentionSaveSettingsOutput = z.object({
  workspaceId: uuid,
  settings: AttentionSettings,
  changed: z.boolean(),
});

export const AttentionRecordAutoInput = z
  .object({
    ...itemRef,
    action: autoAction,
    outcome: z.enum(['scheduled', 'sent', 'skipped']),
    /** The facts it was planned on: a schedule for facts that changed since is refused. */
    fingerprint: z.string().min(1).max(200).optional(),
    scheduledFor: isoDateTime.optional(),
    /** Why it was skipped: a code (opted_out, quiet_hours, cooldown, someone_talking…). */
    reason: z
      .string()
      .regex(/^[a-z][a-z_]{0,59}$/, 'A reason code, like opted_out.')
      .optional(),
    channel: z.enum(['sms', 'email']).nullable().optional(),
    messageId: uuid.nullable().optional(),
    /** The person whose Let HandsFreeOS Handle asked for it, if one did. */
    requestedBy: uuid.nullable().optional(),
    /** A sent confirmation request: the item stays handled until then (12 hours before the start). */
    handledUntil: isoDateTime.nullable().optional(),
  })
  .refine((v) => v.outcome !== 'scheduled' || !!v.scheduledFor, {
    path: ['scheduledFor'],
    error: 'Say when it goes.',
  })
  .refine((v) => v.outcome !== 'skipped' || !!v.reason, {
    path: ['reason'],
    error: 'Say why it was skipped.',
  });
export const AttentionRecordAutoOutput = z.object({
  itemId: uuid,
  state: attentionState,
  autoState: autoState.nullable(),
  changed: z.boolean(),
});
