/**
 * The Action Center's kinds of attention item: their names, the one-card-per-lead precedence, the permission
 * each action on them needs, and which may run on their own. Browser-safe.
 *
 * `attention_items.kind` is check-constrained to ATTENTION_KINDS, and a DB parity test keeps the two identical.
 * Milestone 9's money kinds are added here (and one line each in the registry).
 */
import { holds, type Grants, type Permission } from '../permissions';

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
  // The usage wallet (M16). Unlike every other kind these are not about a customer at all: they are about the
  // business's own ability to keep working, which is why they carry no person, lead or conversation.
  'wallet_low',
  'wallet_empty',
  'wallet_card_declined',
  // After the job (Automations, stage 2b).
  'job_not_thanked',
  'referral_mentioned',
  'maintenance_due',
  // Pipeline and jobs (Automations, stage 3b).
  'pipeline_mismatch',
  'quiet_after_price',
  'job_unconfirmed',
  'job_never_completed',
  'job_no_address',
  // Service, hand-offs and revenue (Automations, stage 4a).
  'client_quiet',
  'promise_due',
  'revenue_moved',
  // Health and quality (Automations, stage 4b): the business's own set-up, not a customer.
  'channel_quiet',
  'connection_error',
  'connection_silent',
  'ai_unreviewed',
  'ai_corrections',
  'website_changed',
  'faq_suggestions',
  // Promotions (Automations, after stage 5): an offer about to end.
  'offer_lapsing',
  // Getting started (HANDSFREEOS_ONBOARDING_IMPLEMENTATION_PLAN.md §6): the carriers turned down texting, weeks
  // after the guide counted the number step done.
  'texting_rejected',
  // Add-ons (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md step 5): what an add-on raised for someone to see, in
  // its own words (a row of app.addon_alerts). Every add-on shares this one kind.
  'addon_alert',
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
  wallet_low: 'Balance running low',
  wallet_empty: 'Balance empty',
  wallet_card_declined: 'Card declined',
  job_not_thanked: 'Say thanks',
  referral_mentioned: 'Referral',
  maintenance_due: 'Maintenance due',
  pipeline_mismatch: 'Wrong stage',
  quiet_after_price: 'Quiet after a price',
  job_unconfirmed: 'Did it happen?',
  job_never_completed: 'Never marked done',
  job_no_address: 'No address',
  client_quiet: 'Gone quiet',
  promise_due: 'Promise due',
  revenue_moved: 'Money in changed',
  channel_quiet: 'Channel quiet',
  connection_error: 'Connection broken',
  connection_silent: 'Connection silent',
  ai_unreviewed: 'AI not reviewed',
  ai_corrections: 'Something to teach the AI',
  website_changed: 'Website changed',
  faq_suggestions: 'Question to answer',
  offer_lapsing: 'Promotion ending',
  texting_rejected: 'Texting turned down',
  addon_alert: 'Add-on alert',
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
  // One wallet per business, so a plural never actually shows; the shape asks for one all the same.
  wallet_low: 'Balance running low',
  wallet_empty: 'Balance empty',
  wallet_card_declined: 'Card declined',
  job_not_thanked: 'Customers to thank',
  referral_mentioned: 'Referrals',
  maintenance_due: 'Maintenance due',
  pipeline_mismatch: 'Deals in the wrong stage',
  quiet_after_price: 'Quiet after a price',
  job_unconfirmed: 'Jobs to check',
  job_never_completed: 'Jobs never marked done',
  job_no_address: 'Jobs with no address',
  client_quiet: 'Regulars gone quiet',
  promise_due: 'Promises due',
  revenue_moved: 'Money in changed',
  channel_quiet: 'Channels gone quiet',
  connection_error: 'Connections broken',
  connection_silent: 'Connections silent',
  ai_unreviewed: 'AI not reviewed',
  ai_corrections: 'Things to teach the AI',
  website_changed: 'Website changes',
  faq_suggestions: 'Questions to answer',
  offer_lapsing: 'Promotions ending',
  texting_rejected: 'Texting turned down',
  addon_alert: 'Add-on alerts',
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
  // One wallet per business, so the subject is the business itself. There is never more than one of these.
  wallet_low: 'wallet',
  wallet_empty: 'wallet',
  wallet_card_declined: 'wallet',
  // A row of app.thank_yous: one customer, one job.
  job_not_thanked: 'thank_you',
  referral_mentioned: 'referral',
  // A row of app.maintenance_reminders: one customer, one service, one due day.
  maintenance_due: 'maintenance',
  // A deal whose stage is behind what happened. Its own card beside the lead's (not folded into it), so the
  // one-press move stays in reach.
  pipeline_mismatch: 'lead',
  quiet_after_price: 'lead',
  // One visit each.
  job_unconfirmed: 'appointment',
  job_never_completed: 'appointment',
  job_no_address: 'appointment',
  // A regular customer: the person themselves.
  client_quiet: 'person',
  // A row of app.promises: something someone on the team said they'd do, by when.
  promise_due: 'promise',
  // One per business, like the wallet's: the subject is the workspace's own id.
  revenue_moved: 'revenue',
  // One of the business's channels. Stored as the channel's own type (HEALTH_SUBJECT_TYPES), so the card knows
  // which page checks it; the id is derived from the business and the channel.
  channel_quiet: 'channel',
  // A row of payment_connections, calendar_connections, mailbox_connections, review_connections, phone_numbers
  // or meta_accounts, stored as that table's type (HEALTH_SUBJECT_TYPES).
  connection_error: 'connection',
  connection_silent: 'connection',
  // An AI teammate.
  ai_unreviewed: 'teammate',
  // A row of app.teammate_lessons: one line of guidance made of repeated corrections.
  ai_corrections: 'lesson',
  // A website scan that found changes.
  website_changed: 'scan',
  // A row of app.knowledge_suggestions: a question the AI couldn't answer, asked again and again.
  faq_suggestions: 'suggestion',
  // A row of app.offers whose end date is close.
  offer_lapsing: 'offer',
  texting_rejected: 'registration',
  // A row of app.addon_alerts.
  addon_alert: 'addon_alert',
} as const satisfies Record<AttentionKind, string>;
/** What a quiet channel's or a connection's card is stored as: the page that fixes it. */
export const HEALTH_SUBJECT_TYPES = [
  'channel_text',
  'channel_call',
  'channel_email',
  'channel_chat',
  'payment_connection',
  'calendar_connection',
  'mailbox',
  'review_connection',
  'phone_number',
  'meta_account',
] as const;
export type HealthSubjectType = (typeof HEALTH_SUBJECT_TYPES)[number];
export type AttentionSubjectType = (typeof ATTENTION_SUBJECT_OF)[AttentionKind] | HealthSubjectType;

/** The kinds about a lead. One card per lead: only the first of these that holds opens. */
export const LEAD_PRECEDENCE = [
  'hot_lead',
  'unanswered_lead',
  'quiet_after_price',
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
  // Money asks first: Let HandsFreeOS Handle writes the follow-up and waits for a person to send it, so both
  // actions need money.manage — a member sees the card, and the money, and no way to write to the customer
  // about it.
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
  /**
   * The wallet's three. Handling one means opening the usage page and topping up or fixing a card, which is
   * `money.manage`; a member sees that the business is running out and cannot spend its money.
   *
   * None of them may be handed to HandsFreeOS: what would that even be — charging the card again, which is
   * what already failed. And none may be assigned: a wallet belongs to the business, not to a person.
   */
  wallet_low: {
    handle: [ITEM, MONEY],
    let_handle: null,
    assign: null,
    snooze: [ITEM],
    dismiss: [ITEM],
  },
  wallet_empty: {
    handle: [ITEM, MONEY],
    let_handle: null,
    assign: null,
    snooze: [ITEM],
    // Never dismissed: the business cannot text anybody, and hiding that does not fix it.
    dismiss: null,
  },
  wallet_card_declined: {
    handle: [ITEM, MONEY],
    let_handle: null,
    assign: null,
    snooze: [ITEM],
    dismiss: null,
  },
  // Thanking a customer is writing to them. HandsFreeOS already tried (that's why the card is here).
  job_not_thanked: {
    handle: [ITEM, 'inbox.use'],
    let_handle: null,
    assign: [ITEM],
    snooze: [ITEM],
    dismiss: [ITEM],
  },
  // "Create lead" makes a customer and a lead: records.write, which the item already needs.
  referral_mentioned: {
    handle: [ITEM],
    let_handle: null,
    assign: [ITEM],
    snooze: [ITEM],
    dismiss: [ITEM],
  },
  // Two texts went already: this one is a person's call.
  maintenance_due: {
    handle: [ITEM, 'inbox.use'],
    let_handle: null,
    assign: [ITEM],
    snooze: [ITEM],
    dismiss: [ITEM],
  },
  // Moving the deal is lead.move_stage: records.write, which the item already needs.
  pipeline_mismatch: {
    handle: [ITEM],
    let_handle: null,
    assign: [ITEM],
    snooze: [ITEM],
    dismiss: [ITEM],
  },
  // The follow-up texts are already going; this is a person picking up the phone.
  quiet_after_price: {
    handle: [ITEM, 'inbox.use'],
    let_handle: null,
    assign: [ITEM],
    snooze: [ITEM],
    dismiss: [ITEM],
  },
  // Marking a visit done (or not) is appointment.set_status; adding an address is appointment.update.
  job_unconfirmed: {
    handle: [ITEM, 'appointments.write'],
    let_handle: null,
    assign: [ITEM],
    snooze: [ITEM],
    dismiss: [ITEM],
  },
  job_never_completed: {
    handle: [ITEM, 'appointments.write'],
    let_handle: null,
    assign: [ITEM],
    snooze: [ITEM],
    dismiss: [ITEM],
  },
  job_no_address: {
    handle: [ITEM, 'appointments.write'],
    let_handle: null,
    assign: [ITEM],
    snooze: [ITEM],
    dismiss: [ITEM],
  },
  // Checking in is a call or a text: a person's, since they're a regular.
  client_quiet: {
    handle: [ITEM, 'inbox.use'],
    let_handle: null,
    assign: [ITEM],
    snooze: [ITEM],
    dismiss: [ITEM],
  },
  // Keeping the promise is on whoever made it.
  promise_due: {
    handle: [ITEM, 'inbox.use'],
    let_handle: null,
    assign: [ITEM],
    snooze: [ITEM],
    dismiss: [ITEM],
  },
  // The business's own money: owners and admins. Nobody to assign it to.
  revenue_moved: {
    handle: [ITEM, MONEY],
    let_handle: null,
    assign: null,
    snooze: [ITEM],
    dismiss: [ITEM],
  },
  /**
   * Health and quality. The business's own set-up: opening the page that fixes it is all the button does, and the
   * page asks for its own permission. Nobody to assign most of them to, and nothing HandsFreeOS can fix itself.
   */
  channel_quiet: {
    handle: [ITEM],
    let_handle: null,
    assign: null,
    snooze: [ITEM],
    dismiss: [ITEM],
  },
  connection_error: {
    handle: [ITEM],
    let_handle: null,
    assign: null,
    snooze: [ITEM],
    // Never dismissed: payments, bookings or messages are failing until it's reconnected.
    dismiss: null,
  },
  connection_silent: {
    handle: [ITEM],
    let_handle: null,
    assign: null,
    snooze: [ITEM],
    dismiss: [ITEM],
  },
  ai_unreviewed: {
    handle: [ITEM],
    let_handle: null,
    assign: [ITEM],
    snooze: [ITEM],
    dismiss: [ITEM],
  },
  // Saving the line adds to the AI teammate's instructions: ai_team.manage, like its other settings.
  ai_corrections: {
    handle: [ITEM, 'ai_team.manage'],
    let_handle: null,
    assign: null,
    snooze: [ITEM],
    dismiss: [ITEM],
  },
  website_changed: {
    handle: [ITEM, 'knowledge.manage'],
    let_handle: null,
    assign: [ITEM],
    snooze: [ITEM],
    dismiss: [ITEM],
  },
  faq_suggestions: {
    handle: [ITEM, 'knowledge.manage'],
    let_handle: null,
    assign: [ITEM],
    snooze: [ITEM],
    dismiss: [ITEM],
  },
  // Extending an offer is a knowledge edit, like making it.
  offer_lapsing: {
    handle: [ITEM, 'knowledge.manage'],
    let_handle: null,
    assign: [ITEM],
    snooze: [ITEM],
    dismiss: [ITEM],
  },
  // Sending the details again is setting up texting (channels.manage), as the first time was.
  texting_rejected: {
    handle: [ITEM, 'channels.manage'],
    let_handle: null,
    assign: null,
    snooze: [ITEM],
    // Never dismissed: the business can't text until the carriers say yes.
    dismiss: null,
  },
  /**
   * Seeing one at all takes the add-on permission its alert names (the table's own policy); opening it is the item's
   * own action, like a broken connection's. It goes when the add-on says it's dealt with, so nobody dismisses it or
   * hands it to someone else from Home, and HandsFreeOS never handles it: the add-on's own page is where the work is.
   */
  addon_alert: {
    handle: [ITEM],
    let_handle: null,
    assign: null,
    snooze: [ITEM],
    dismiss: null,
  },
};

/** The permissions an action on a kind needs, or null when the kind doesn't offer it. */
export function attentionPermissions(
  kind: AttentionKind,
  action: AttentionAction,
): readonly Permission[] | null {
  return ATTENTION_PERMISSIONS[kind][action];
}

/** Whether someone may take an action on a kind (the list's allowed actions per item). */
export function mayTakeAttentionAction(
  who: Grants,
  kind: AttentionKind,
  action: AttentionAction,
): boolean {
  const needed = ATTENTION_PERMISSIONS[kind][action];
  return needed !== null && needed.every((p) => holds(who, p));
}

/**
 * The main button's verb; the card adds the name ("Call Maria").
 *
 * A money card is handled in one press like every other kind: it reaches the customer the way that suits them
 * (a call in open hours, otherwise a text or an email), with the follow-up already written. The document itself
 * is one press away in the card's ⋯ menu — reading it is not handling it.
 */
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
  invoice_overdue: 'Follow up',
  wallet_low: 'Top up',
  wallet_empty: 'Top up',
  wallet_card_declined: 'Fix the card',
  job_not_thanked: 'Say thanks',
  referral_mentioned: 'Create lead',
  maintenance_due: 'Call',
  pipeline_mismatch: 'Move',
  quiet_after_price: 'Call',
  job_unconfirmed: 'Mark done',
  job_never_completed: 'Mark done',
  job_no_address: 'Add address',
  client_quiet: 'Check in',
  promise_due: 'Follow through',
  revenue_moved: 'Open money',
  channel_quiet: 'Check it',
  connection_error: 'Reconnect',
  connection_silent: 'Check it',
  ai_unreviewed: 'Review',
  ai_corrections: 'Add to its instructions',
  website_changed: 'Review updates',
  faq_suggestions: 'Answer',
  offer_lapsing: 'Open the promotion',
  texting_rejected: 'Fix and send again',
  addon_alert: 'Open',
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

/**
 * How long a money card rests once someone has followed it up. Following up doesn't pay an invoice or answer
 * an estimate, so the card isn't finished — it just shouldn't be asked again tomorrow. It comes back after
 * this, or sooner if the figures move (a part payment, a refund).
 */
export const MONEY_FOLLOW_UP_REST_DAYS = 7;
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
 * The kinds HandsFreeOS never handles, and what a person is told when they ask it to. One sentence each, used by
 * the command that refuses, by the preview the sheet reads, and by the Assistant — so everyone says the same
 * thing, and nobody meets a bare permission error for something no role may do.
 *
 * Money is deliberately **not** here. Chris's rule is that money never chases itself *unreviewed*: HandsFreeOS
 * writes the follow-up from the document's own figures and puts it in front of a person, who reads it and
 * presses send. That is the ask-first shape a hot lead already uses — nothing is queued, nothing is sent, and
 * the AI teammate is never offered a conversation about money.
 */
export const LET_HANDLE_REFUSALS: Readonly<Partial<Record<AttentionKind, string>>> = {
  ai_approval: 'Approvals always wait for a person to decide.',
  overdue_task: 'This is a to-do for someone on the team.',
  // Handling these would mean charging the card again, which is exactly what has already failed.
  wallet_low: 'Only you can put money on your own balance.',
  wallet_empty: 'Only you can put money on your own balance.',
  wallet_card_declined: 'Only you can put a working card on your own balance.',
  job_not_thanked: 'HandsFreeOS couldn’t send this thank-you, so it’s one for you.',
  referral_mentioned: 'Reaching out to somebody new is your call.',
  maintenance_due: 'HandsFreeOS already texted them twice, so this one needs a person.',
  pipeline_mismatch: 'HandsFreeOS couldn’t move this deal itself, so it’s one for you.',
  quiet_after_price: 'The follow-up texts are already going, so this one needs a person.',
  job_unconfirmed: 'Only someone who was there knows whether it happened.',
  job_never_completed: 'Only someone who was there knows whether it happened.',
  job_no_address: 'Only you or the customer know where the job is.',
  client_quiet: 'A regular hears from a person, not an automatic text.',
  promise_due: 'The promise was yours, so keeping it is too.',
  revenue_moved: 'This is for you to look at, not something to send.',
  channel_quiet: 'Only you can check what’s wrong with it.',
  connection_error: 'Reconnecting needs you to sign in again.',
  connection_silent: 'Only you can check what’s wrong with it.',
  ai_unreviewed: 'Reviewing the AI’s work is for a person.',
  ai_corrections: 'What the AI learns is yours to decide.',
  website_changed: 'What the AI learns is yours to decide.',
  faq_suggestions: 'Only you know the answer.',
  offer_lapsing: 'Whether a promotion runs longer is your call.',
  texting_rejected: 'Only you can fix the details the carriers turned down.',
  addon_alert: 'The add-on that raised this says when it’s done.',
};

/** Why HandsFreeOS won't handle this kind, or null when it does. */
export function letHandleRefusal(kind: AttentionKind): string | null {
  return LET_HANDLE_REFUSALS[kind] ?? null;
}

/**
 * What Let HandsFreeOS Handle does for one item: runs on its own ('auto'), asks first ('ask'), or isn't offered
 * ('none'). `reasons` are the item's reason chips.
 */
export function letHandleModeOf(
  kind: AttentionKind,
  reasons: readonly { readonly code: string }[] = [],
): 'auto' | 'ask' | 'none' {
  if (letHandleRefusal(kind)) return 'none';
  if (autoActionOf(kind, reasons)) return 'auto';
  return ATTENTION_PERMISSIONS[kind].let_handle ? 'ask' : 'none';
}
