/**
 * The Action Center's kinds of attention item: their names, the one-card-per-lead precedence, the permission
 * each action on them needs, and which may run on their own. Browser-safe.
 *
 * `attention_items.kind` is check-constrained to ATTENTION_KINDS, and a DB parity test keeps the two identical.
 * Milestone 9's money kinds are added here (and one line each in the registry).
 */
import { hasWorkspacePermission, type Permission, type WorkspaceRole } from '../permissions';

export const ATTENTION_KINDS = [
  'hot_lead',
  'unanswered_lead',
  'stale_opportunity',
  'missing_next_action',
  'unconfirmed_appointment',
  'ai_approval',
  'customer_waiting',
  'overdue_task',
  'estimate_waiting',
  'invoice_overdue',
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export const isAttentionKind = (value: unknown): value is AttentionKind =>
  typeof value === 'string' && (ATTENTION_KINDS as readonly string[]).includes(value);

export const ATTENTION_KIND_LABELS: Readonly<Record<AttentionKind, string>> = {
  hot_lead: 'Hot lead',
  unanswered_lead: 'Unanswered lead',
  stale_opportunity: 'Gone quiet',
  missing_next_action: 'No next action',
  unconfirmed_appointment: 'Not confirmed',
  ai_approval: 'Approval',
  customer_waiting: 'Customer waiting',
  overdue_task: 'Overdue task',
  estimate_waiting: 'Estimate waiting',
  invoice_overdue: 'Invoice overdue',
};

/** For folded groups: "Unconfirmed appointments · 4 customers". */
export const ATTENTION_KIND_PLURALS: Readonly<Record<AttentionKind, string>> = {
  hot_lead: 'Hot leads',
  unanswered_lead: 'Unanswered leads',
  stale_opportunity: 'Gone quiet',
  missing_next_action: 'No next action',
  unconfirmed_appointment: 'Unconfirmed appointments',
  ai_approval: 'Approvals',
  customer_waiting: 'Customers waiting',
  overdue_task: 'Overdue tasks',
  estimate_waiting: 'Estimates waiting',
  invoice_overdue: 'Overdue invoices',
};

/**
 * What each kind is about: `attention_items.subject_type`, with `subject_id` that row's id. An AI approval is a
 * workflow approval step or an AI teammate draft (its facts say which table).
 */
export const ATTENTION_SUBJECT_OF = {
  hot_lead: 'lead',
  unanswered_lead: 'lead',
  stale_opportunity: 'lead',
  missing_next_action: 'lead',
  unconfirmed_appointment: 'attendee',
  ai_approval: 'approval',
  customer_waiting: 'conversation',
  overdue_task: 'task',
  estimate_waiting: 'estimate',
  invoice_overdue: 'invoice',
} as const satisfies Record<AttentionKind, string>;
export type AttentionSubjectType = (typeof ATTENTION_SUBJECT_OF)[AttentionKind];

/** The kinds about a lead. One card per lead: only the first of these that holds opens. */
export const LEAD_PRECEDENCE = [
  'hot_lead',
  'unanswered_lead',
  'stale_opportunity',
  'missing_next_action',
] as const satisfies readonly AttentionKind[];
export type LeadAttentionKind = (typeof LEAD_PRECEDENCE)[number];

export const isLeadKind = (kind: AttentionKind): kind is LeadAttentionKind =>
  (LEAD_PRECEDENCE as readonly string[]).includes(kind);

// ---- Actions and who may take them ----

export const ATTENTION_ACTIONS = ['handle', 'let_handle', 'assign', 'snooze', 'dismiss'] as const;
export type AttentionAction = (typeof ATTENTION_ACTIONS)[number];

const ITEM = 'records.write' satisfies Permission;

/**
 * Chasing money — following up an estimate, reminding someone about an invoice — is `money.manage`, the
 * permission owners and admins have and members don't, so a member sees the card but no Send button.
 */
const MONEY = 'money.manage' satisfies Permission;

/**
 * Every permission an action on a kind needs; null when the kind doesn't offer it.
 * - Changing the item itself (its state, snooze, dismissal, assignee) is `records.write`, as the table's
 *   row-level security says, so every action that touches the item lists it.
 * - handle: what the main button does. Calling or replying is `inbox.use`, confirming an appointment
 *   `appointments.write`. Deciding an AI approval is checked on the approval itself (the people it names, or owners
 *   and admins), as `workflow.decide_approval` does, and the worker then resolves the item: `workspace.read`.
 * - let_handle: what HandsFreeOS does for you, with the same permissions. AI approvals are never handed off, and an
 *   overdue task is a person's own to-do.
 * - assign: passes through to the real owner (lead.update, conversation.assign, task.update); appointments and
 *   approvals assign only the item.
 */
export const ATTENTION_PERMISSIONS: Readonly<
  Record<AttentionKind, Readonly<Record<AttentionAction, readonly Permission[] | null>>>
> = {
  hot_lead: {
    handle: [ITEM, 'inbox.use'],
    let_handle: [ITEM, 'inbox.use'],
    assign: [ITEM],
    snooze: [ITEM],
    dismiss: [ITEM],
  },
  unanswered_lead: {
    handle: [ITEM, 'inbox.use'],
    let_handle: [ITEM, 'inbox.use'],
    assign: [ITEM],
    snooze: [ITEM],
    dismiss: [ITEM],
  },
  stale_opportunity: {
    handle: [ITEM, 'inbox.use'],
    let_handle: [ITEM, 'inbox.use'],
    assign: [ITEM],
    snooze: [ITEM],
    dismiss: [ITEM],
  },
  missing_next_action: {
    handle: [ITEM],
    let_handle: [ITEM],
    assign: [ITEM],
    snooze: [ITEM],
    dismiss: [ITEM],
  },
  unconfirmed_appointment: {
    handle: [ITEM, 'appointments.write'],
    let_handle: [ITEM, 'appointments.write'],
    assign: [ITEM],
    snooze: [ITEM],
    dismiss: [ITEM],
  },
  ai_approval: {
    handle: ['workspace.read'],
    let_handle: null,
    assign: [ITEM],
    snooze: [ITEM],
    dismiss: [ITEM],
  },
  customer_waiting: {
    handle: [ITEM, 'inbox.use'],
    let_handle: [ITEM, 'inbox.use'],
    assign: [ITEM, 'inbox.use'],
    snooze: [ITEM],
    dismiss: [ITEM],
  },
  overdue_task: {
    handle: [ITEM],
    let_handle: null,
    assign: [ITEM],
    snooze: [ITEM],
    dismiss: [ITEM],
  },
  estimate_waiting: {
    handle: [ITEM, MONEY],
    let_handle: [ITEM, MONEY],
    assign: [ITEM],
    snooze: [ITEM],
    dismiss: [ITEM],
  },
  invoice_overdue: {
    handle: [ITEM, MONEY],
    let_handle: [ITEM, MONEY],
    assign: [ITEM],
    snooze: [ITEM],
    dismiss: [ITEM],
  },
};

/** The permissions an action on a kind needs, or null when the kind doesn't offer it. */
export function attentionPermissions(
  kind: AttentionKind,
  action: AttentionAction,
): readonly Permission[] | null {
  return ATTENTION_PERMISSIONS[kind][action];
}

/** Whether a role may take an action on a kind (the list's allowed actions per item). */
export function mayTakeAttentionAction(
  role: WorkspaceRole | null,
  kind: AttentionKind,
  action: AttentionAction,
): boolean {
  const needed = ATTENTION_PERMISSIONS[kind][action];
  return needed !== null && needed.every((p) => hasWorkspacePermission(role, p));
}

/** The main button's verb; the card adds the name ("Call Maria"). */
export const ATTENTION_HANDLE_LABELS: Readonly<Record<AttentionKind, string>> = {
  hot_lead: 'Call',
  unanswered_lead: 'Reply',
  stale_opportunity: 'Follow up',
  missing_next_action: 'Set next action',
  unconfirmed_appointment: 'Confirm',
  ai_approval: 'Review',
  customer_waiting: 'Reply',
  overdue_task: 'Open task',
  estimate_waiting: 'Follow up',
  invoice_overdue: 'Send reminder',
};

// ---- What runs on its own ----

/** The only things HandsFreeOS may do without asking: one confirmation request, or one follow-up nudge. */
export const AUTO_ACTIONS = ['confirm_request', 'nudge'] as const;
export type AutoAction = (typeof AUTO_ACTIONS)[number];

/**
 * The kinds that may run on their own, and what they do. A missing next action runs on its own only when it is
 * an overdue follow-up (the lead's next action has a time, and it has passed): a nudge. With no next action at
 * all, it asks first (a suggested one).
 *
 * Money is never here. An unreviewed message chasing money is the worst possible first automatic message, so
 * both money kinds ask first — the per-document reminders a business agreed to in advance are a different
 * thing, scheduled when the invoice is sent.
 */
export const AUTO_KINDS: Readonly<Partial<Record<AttentionKind, AutoAction>>> = {
  unconfirmed_appointment: 'confirm_request',
  stale_opportunity: 'nudge',
  missing_next_action: 'nudge',
};

/** The reason code that marks a missing next action as an overdue follow-up (see `reasons` on a detection). */
export const FOLLOW_UP_OVERDUE = 'follow_up_overdue';

/** The wait between scheduling an automatic action and sending it: "Will follow up at 10:40 · Cancel". */
export const AUTO_CANCEL_WINDOW_MINUTES = 60;
/** Nothing automatic goes to someone a person messaged within this long. */
export const AUTO_RECENT_PERSON_HOURS = 72;

/** The automatic action for one item, or null when it must ask first (or can't be handed off). */
export function autoActionOf(
  kind: AttentionKind,
  reasons: readonly { readonly code: string }[] = [],
): AutoAction | null {
  const action = AUTO_KINDS[kind] ?? null;
  if (kind === 'missing_next_action' && !reasons.some((r) => r.code === FOLLOW_UP_OVERDUE))
    return null;
  return action;
}

/**
 * What Let HandsFreeOS Handle does for one item: runs on its own ('auto'), asks first ('ask'), or isn't offered
 * ('none'). `reasons` are the item's reason chips.
 */
export function letHandleModeOf(
  kind: AttentionKind,
  reasons: readonly { readonly code: string }[] = [],
): 'auto' | 'ask' | 'none' {
  if (autoActionOf(kind, reasons)) return 'auto';
  return ATTENTION_PERMISSIONS[kind].let_handle ? 'ask' : 'none';
}
