/**
 * The Automations catalog: every proactive thing HandsFreeOS does, in the words an owner reads on Settings →
 * Automations. Browser-safe, so the page, the worker and the Assistant describe each one the same way.
 *
 * The catalog owns no behaviour. Each entry says where its switch lives (`binding`):
 * - `attention_kind`: an Action Center kind (`settings.attention.kinds`), on when every kind it names is on;
 * - `teammate`: a skill in the AI teammate's settings;
 * - `automations`: a switch in `settings.automations.switches` (see ./settings).
 * So the code that runs an automation keeps reading the setting it always read, and turning a row off here is the
 * same as turning that setting off anywhere else.
 */
import type { AttentionKind } from '../attention/kinds';
import type { AutomationSwitch } from './settings';

/** The page's two halves, in the owner's words. */
export const AUTOMATION_SECTIONS = [
  {
    id: 'customers',
    title: 'Reaching customers',
    groups: ['leads', 'appointments', 'after_job'],
  },
  {
    id: 'business',
    title: 'Keeping the business on track',
    groups: ['briefings', 'pipeline', 'service', 'marketing', 'money', 'health'],
  },
] as const;

export const AUTOMATION_GROUPS = [
  'leads',
  'appointments',
  'after_job',
  'briefings',
  'pipeline',
  'service',
  'marketing',
  'money',
  'health',
] as const;
export type AutomationGroup = (typeof AUTOMATION_GROUPS)[number];

export const AUTOMATION_GROUP_TITLES: Readonly<Record<AutomationGroup, string>> = {
  leads: 'Leads and sales',
  appointments: 'Appointments',
  after_job: 'After the job',
  briefings: 'Daily briefings',
  pipeline: 'Pipeline and records',
  service: 'Service and handoffs',
  marketing: 'Marketing and content',
  money: 'Ads and money',
  health: 'Health and quality',
};

/** What an automation does to the world, as the row's tag says it. */
export const AUTOMATION_EFFECTS = ['texts', 'alerts', 'records'] as const;
export type AutomationEffect = (typeof AUTOMATION_EFFECTS)[number];

export const AUTOMATION_EFFECT_LABELS: Readonly<Record<AutomationEffect, string>> = {
  texts: 'Texts customers',
  alerts: 'Just alerts you',
  records: 'Updates records',
};

/** The AI teammate settings a row can switch. */
export const TEAMMATE_SWITCH_PATHS = [
  'respond.newLeads.enabled',
  'followUp.enabled',
  'followUp.neverReplied',
  'followUp.chaseTimes',
] as const;
export type TeammateSwitchPath = (typeof TEAMMATE_SWITCH_PATHS)[number];

export type AutomationBinding =
  | { readonly store: 'attention_kind'; readonly kinds: readonly AttentionKind[] }
  | { readonly store: 'teammate'; readonly path: TeammateSwitchPath }
  | { readonly store: 'automations'; readonly key: AutomationSwitch };

/**
 * Who writes what the customer reads:
 * - 'ai': the AI teammate writes it, so it follows training mode (a draft to approve while it is training);
 * - 'owner_wording': fixed words the business has read (a reminder, a confirmation request), sent as they are;
 * - null: nothing goes to a customer.
 */
export type CustomerFacing = 'ai' | 'owner_wording' | null;

/** What a row needs before it can do anything. Shown as "needs setup" with a link, never as an error. */
export const AUTOMATION_REQUIREMENTS = [
  'teammate_on',
  'intake_form',
  'maintenance_schedule',
] as const;
export type AutomationRequirement = (typeof AUTOMATION_REQUIREMENTS)[number];

/** The fine-tuning panels the page's Adjust sheet offers. */
export const ADJUST_PANELS = [
  'new_lead',
  'hot_lead',
  'unanswered',
  'follow_ups',
  'never_replied',
  'chase_times',
  'reengage',
  'day_before',
  'unconfirmed',
  'waitlist',
  'intake',
  'maintenance',
  'thank_you',
  'invoices',
  'morning',
  'evening',
  'stale',
  'estimates',
  'balance',
] as const;
export type AdjustPanel = (typeof ADJUST_PANELS)[number];

export interface AutomationDef {
  readonly id: string;
  readonly group: AutomationGroup;
  readonly label: string;
  /** One sentence, plain words: what it does. */
  readonly oneLiner: string;
  readonly effect: AutomationEffect;
  /**
   * On for a business that never touched it. Documents the default of the store the switch lives in (a test
   * keeps the two the same); it isn't read on its own.
   */
  readonly defaultOn: boolean;
  readonly binding: AutomationBinding;
  readonly customerFacing: CustomerFacing;
  readonly needs: readonly AutomationRequirement[];
  /** The Adjust sheet's panel, or null when there's nothing to tune. */
  readonly adjust: AdjustPanel | null;
  /** Can't be turned off (a person must always see what waits on them). */
  readonly locked?: boolean;
  /** Can't be turned on until an owner has read its wording in the Adjust sheet ("Looks good, turn on"). */
  readonly reviewFirst?: boolean;
  /**
   * An AI-written row that still does something without the AI teammate, in one sentence the row shows while
   * there is none (so it doesn't read as "needs setup").
   */
  readonly withoutTeammate?: string;
}

/** Every automation, in the page's order. */
export const AUTOMATIONS = [
  // ---- Leads and sales ----
  {
    id: 'new_lead_greeting',
    group: 'leads',
    label: 'New lead greeting',
    oneLiner: 'Texts a brand-new lead or form fill right away.',
    effect: 'texts',
    defaultOn: true,
    binding: { store: 'teammate', path: 'respond.newLeads.enabled' },
    customerFacing: 'ai',
    needs: ['teammate_on'],
    adjust: 'new_lead',
  },
  {
    id: 'hot_lead_alert',
    group: 'leads',
    label: 'Hot lead alert',
    oneLiner: 'Flags a lead who looks ready to buy, so someone calls them first.',
    effect: 'alerts',
    defaultOn: true,
    binding: { store: 'attention_kind', kinds: ['hot_lead'] },
    customerFacing: null,
    needs: [],
    adjust: 'hot_lead',
  },
  {
    id: 'unanswered_alert',
    group: 'leads',
    label: 'Unanswered-message alert',
    oneLiner: 'Flags a customer or new lead who has been waiting too long for a reply.',
    effect: 'alerts',
    defaultOn: true,
    binding: { store: 'attention_kind', kinds: ['unanswered_lead', 'customer_waiting'] },
    customerFacing: null,
    needs: [],
    adjust: 'unanswered',
  },
  {
    id: 'follow_ups_after_silence',
    group: 'leads',
    label: 'Follow-ups after silence',
    oneLiner: 'Nudges a customer who stops replying: 9 times over a month, then monthly.',
    effect: 'texts',
    defaultOn: true,
    binding: { store: 'teammate', path: 'followUp.enabled' },
    customerFacing: 'ai',
    needs: ['teammate_on'],
    adjust: 'follow_ups',
  },
  {
    id: 'never_replied',
    group: 'leads',
    label: 'Follow-ups when a lead never replied',
    oneLiner: 'Chases a new lead who never answered, written from what they put on the form.',
    effect: 'texts',
    defaultOn: true,
    binding: { store: 'teammate', path: 'followUp.neverReplied' },
    customerFacing: 'ai',
    needs: ['teammate_on'],
    adjust: 'never_replied',
  },
  {
    id: 'chase_offered_time',
    group: 'leads',
    label: 'Chase an offered time',
    oneLiner: 'Follows up sooner when a lead was offered times and went quiet.',
    effect: 'texts',
    defaultOn: true,
    binding: { store: 'teammate', path: 'followUp.chaseTimes' },
    customerFacing: 'ai',
    needs: ['teammate_on'],
    adjust: 'chase_times',
  },
  {
    id: 'reengage_dead_leads',
    group: 'leads',
    label: 'Re-engage dead leads',
    oneLiner: 'Texts open leads nobody has been in touch with for months, in your words.',
    effect: 'texts',
    defaultOn: false,
    binding: { store: 'automations', key: 'reengage' },
    customerFacing: 'owner_wording',
    needs: [],
    adjust: 'reengage',
    reviewFirst: true,
  },

  // ---- Appointments ----
  {
    id: 'day_before_confirmation',
    group: 'appointments',
    label: 'Day-before confirmation',
    oneLiner: 'Reminds the customer about tomorrow’s visit and asks them to confirm.',
    effect: 'texts',
    defaultOn: true,
    binding: { store: 'automations', key: 'dayBefore' },
    customerFacing: 'owner_wording',
    needs: [],
    adjust: 'day_before',
  },
  {
    id: 'day_of_reminder',
    group: 'appointments',
    label: 'Day-of reminder',
    oneLiner: 'Reminds the customer a couple of hours before their visit.',
    effect: 'texts',
    defaultOn: true,
    binding: { store: 'automations', key: 'dayOf' },
    customerFacing: 'owner_wording',
    needs: [],
    adjust: 'day_before',
  },
  {
    id: 'unconfirmed_alert',
    group: 'appointments',
    label: 'Unconfirmed visit alert',
    oneLiner: 'Flags upcoming visits the customer hasn’t confirmed, and asks them once more.',
    effect: 'alerts',
    defaultOn: true,
    binding: { store: 'attention_kind', kinds: ['unconfirmed_appointment'] },
    customerFacing: null,
    needs: [],
    adjust: 'unconfirmed',
  },
  {
    id: 'intake_questions',
    group: 'appointments',
    label: 'Intake questions',
    oneLiner: 'Sends a first-time customer your intake form right after they book.',
    effect: 'texts',
    defaultOn: true,
    binding: { store: 'automations', key: 'intake' },
    customerFacing: 'owner_wording',
    needs: ['intake_form'],
    adjust: 'intake',
  },
  {
    id: 'maintenance_due',
    group: 'appointments',
    label: 'Maintenance due',
    oneLiner: 'Texts a customer to rebook when their regular service comes round again.',
    effect: 'texts',
    defaultOn: true,
    binding: { store: 'automations', key: 'maintenance' },
    customerFacing: 'owner_wording',
    needs: ['maintenance_schedule'],
    adjust: 'maintenance',
  },
  {
    id: 'waitlist_slot_opened',
    group: 'appointments',
    label: 'Waitlist slot opened',
    oneLiner: 'Tells the next person waiting when a time in their window frees up.',
    effect: 'texts',
    defaultOn: true,
    binding: { store: 'automations', key: 'waitlist' },
    customerFacing: 'owner_wording',
    needs: [],
    adjust: 'waitlist',
  },

  // ---- After the job ----
  {
    id: 'job_thank_you',
    group: 'after_job',
    label: 'Thank-you after the job',
    oneLiner: 'Texts the customer a short thank-you two hours after a job is marked done.',
    effect: 'texts',
    defaultOn: true,
    binding: { store: 'automations', key: 'thankYou' },
    customerFacing: 'ai',
    needs: [],
    adjust: 'thank_you',
    withoutTeammate: 'Without an AI teammate, a card on Home reminds you to thank them.',
  },
  {
    id: 'overdue_invoices',
    group: 'after_job',
    label: 'Overdue invoices',
    oneLiner: 'Flags past-due invoices and writes the follow-up for you to send.',
    effect: 'alerts',
    defaultOn: true,
    binding: { store: 'attention_kind', kinds: ['invoice_overdue'] },
    customerFacing: null,
    needs: [],
    adjust: 'invoices',
  },
  {
    id: 'referral_mentioned',
    group: 'after_job',
    label: 'Referral mentioned',
    oneLiner: 'Flags a customer who mentions someone who needs you, so you can reach out.',
    effect: 'alerts',
    defaultOn: true,
    binding: { store: 'attention_kind', kinds: ['referral_mentioned'] },
    customerFacing: null,
    needs: [],
    adjust: null,
  },

  // ---- Daily briefings ----
  {
    id: 'morning_brief',
    group: 'briefings',
    label: 'Morning brief',
    oneLiner: 'An email at 7 AM with today’s jobs, who to call and what needs attention.',
    effect: 'alerts',
    defaultOn: true,
    binding: { store: 'automations', key: 'morningBrief' },
    customerFacing: null,
    needs: [],
    adjust: 'morning',
  },
  {
    id: 'evening_brief',
    group: 'briefings',
    label: 'End-of-day email',
    oneLiner: 'An email at 6 PM with what’s still open and the day in numbers.',
    effect: 'alerts',
    defaultOn: true,
    binding: { store: 'automations', key: 'eveningBrief' },
    customerFacing: null,
    needs: [],
    adjust: 'evening',
  },

  // ---- Pipeline and records ----
  {
    id: 'stale_opportunities',
    group: 'pipeline',
    label: 'Stale opportunities',
    oneLiner: 'Flags open deals nobody has been in touch with for a while.',
    effect: 'alerts',
    defaultOn: true,
    binding: { store: 'attention_kind', kinds: ['stale_opportunity'] },
    customerFacing: null,
    needs: [],
    adjust: 'stale',
  },
  {
    id: 'no_next_step',
    group: 'pipeline',
    label: 'Leads with no next step',
    oneLiner: 'Flags open leads with nothing planned, or a follow-up that’s overdue.',
    effect: 'alerts',
    defaultOn: true,
    binding: { store: 'attention_kind', kinds: ['missing_next_action'] },
    customerFacing: null,
    needs: [],
    adjust: null,
  },
  {
    id: 'quotes_no_decision',
    group: 'pipeline',
    label: 'Quotes with no decision',
    oneLiner: 'Flags estimates with no yes or no, and writes the follow-up for you to send.',
    effect: 'alerts',
    defaultOn: true,
    binding: { store: 'attention_kind', kinds: ['estimate_waiting'] },
    customerFacing: null,
    needs: [],
    adjust: 'estimates',
  },

  // ---- Service and handoffs ----
  {
    id: 'overdue_tasks',
    group: 'service',
    label: 'Overdue tasks',
    oneLiner: 'Flags to-dos that are past their due time.',
    effect: 'alerts',
    defaultOn: true,
    binding: { store: 'attention_kind', kinds: ['overdue_task'] },
    customerFacing: null,
    needs: [],
    adjust: null,
  },

  // ---- Marketing and content ----
  {
    id: 'drafts_awaiting_review',
    group: 'marketing',
    label: 'Drafts awaiting review',
    oneLiner: 'Shows AI drafts and approvals waiting on someone to decide.',
    effect: 'alerts',
    defaultOn: true,
    binding: { store: 'attention_kind', kinds: ['ai_approval'] },
    customerFacing: null,
    needs: [],
    adjust: null,
    locked: true,
  },

  // ---- Ads and money ----
  {
    id: 'balance_low',
    group: 'money',
    label: 'Balance running low',
    oneLiner: 'Warns you before your texting balance runs out.',
    effect: 'alerts',
    defaultOn: true,
    binding: { store: 'attention_kind', kinds: ['wallet_low'] },
    customerFacing: null,
    needs: [],
    adjust: 'balance',
  },
] as const satisfies readonly AutomationDef[];

export type AutomationId = (typeof AUTOMATIONS)[number]['id'];

const BY_ID = new Map<string, AutomationDef>(AUTOMATIONS.map((a) => [a.id, a]));

export const isAutomationId = (value: unknown): value is AutomationId =>
  typeof value === 'string' && BY_ID.has(value);

/** One automation's definition. */
export function automationDef(id: AutomationId): AutomationDef {
  return BY_ID.get(id)!;
}

/** The automations in one group, in the page's order. */
export function automationsIn(group: AutomationGroup): readonly AutomationDef[] {
  return AUTOMATIONS.filter((a) => a.group === group);
}
