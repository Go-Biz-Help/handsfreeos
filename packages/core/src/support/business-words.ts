/**
 * The support desk's Businesses (M13), said once for the web's /admin/businesses and the phone's Support desk: the
 * directory's totals and orders, one business's counts and what it has set up, its balance (M16), the model its calls
 * think with, and whether it is HandsFreeOS's own (M19). The screens differ; what they say and work out does not.
 */

import { withAddonNames } from '../addons/catalog';
import { formatPhone } from '../crm/phone';
import { industryLabel } from '../industries';
import { intlTimeZone } from '../intl/engine-zones';
import { money, PAYMENT_PROVIDER_LABELS } from '../money/index';
import { SOURCE_LABELS, type MigrationSourceSystem } from '../schemas/migration';
import type {
  BusinessAttentionValue,
  BusinessGlance,
  BusinessPlanValue,
  TicketStatusValue,
} from '../schemas/support';

import { DESK_WORDS, sinceIso, sinceWords } from './desk-words';

export type { BusinessAttentionValue, BusinessGlance, BusinessPlanValue };

// ---------- the directory ----------

/**
 * The directory's orders. Only Newest and Needs a look page: they go by sign-up, the one order that can't change under
 * the reader's feet. Needs a look is only the businesses with something to look at (`deskBusinessFlags`).
 */
export const DESK_BUSINESS_SORTS = [
  { key: 'newest', label: 'Newest' },
  { key: 'busiest', label: 'Most active' },
  { key: 'quietest', label: 'Gone quiet' },
  { key: 'attention', label: 'Needs a look' },
  { key: 'name', label: 'By name' },
] as const;

export type DeskBusinessSort = (typeof DESK_BUSINESS_SORTS)[number]['key'];

/** A sort from an address or a tap; anything else is Newest. */
export const deskBusinessSort = (value: string | null | undefined): DeskBusinessSort =>
  DESK_BUSINESS_SORTS.find((s) => s.key === value)?.key ?? 'newest';

/** The three numbers over the directory, the ones looked at daily. */
export function deskBusinessTotals(totals: {
  readonly businesses: number;
  readonly newThisWeek: number;
  readonly activeThisWeek: number;
}): readonly { readonly label: string; readonly value: number }[] {
  return [
    { label: 'On HandsFreeOS', value: totals.businesses },
    { label: 'Signed up this week', value: totals.newThisWeek },
    { label: 'Did something this week', value: totals.activeThisWeek },
  ];
}

/** "3 hours", or "never" for somebody (or a business) who has never done anything. */
export const deskLastActive = (iso: string | null, now = Date.now()): string =>
  iso ? sinceIso(iso, now) : DESK_BUSINESS_WORDS.never;

/** "3 hours ago", "just now", or "never": when somebody last did anything, as a sentence ends it. */
export function deskActiveAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return DESK_BUSINESS_WORDS.never;
  const since = sinceIso(iso, now);
  return since === sinceWords(0) ? since : `${since} ago`;
}

/** How much of each thing one business holds, as the five numbers over its page. */
export function deskBusinessCounts(counts: {
  readonly people: number;
  readonly leads: number;
  readonly conversations: number;
  readonly appointments: number;
  readonly invoices: number;
}): readonly { readonly label: string; readonly value: number }[] {
  return [
    { label: 'Contacts', value: counts.people },
    { label: 'Leads', value: counts.leads },
    { label: 'Conversations', value: counts.conversations },
    { label: 'Appointments', value: counts.appointments },
    { label: 'Invoices', value: counts.invoices },
  ];
}

/** What is set up, as a support person would ask it: can they text, email, take money, book. */
export const DESK_SETUP_WORDS: Readonly<Record<string, string>> = {
  phone: 'Texting and calls',
  registration: 'Texting registration',
  email: 'Email',
  payments: 'Taking money',
  calendar: 'Calendar and booking',
  aiTeammate: 'AI teammate',
  meta: 'Facebook and Instagram',
  gettingStarted: 'Getting started',
};

export const DESK_BUSINESS_WORDS = {
  searchPlaceholder: 'Search by business or agency name',
  searchLabel: 'Search businesses',
  nothingMatches: 'Nothing matches that.',
  more: 'More',
  allBusinesses: 'All businesses',
  never: 'never',
  people: DESK_WORDS.people,
  /** "· last active 3 hours" on a row of the directory. */
  lastActive: (iso: string | null, now = Date.now()) => `last active ${deskLastActive(iso, now)}`,
  openTickets: (n: number) => `${n} open ${n === 1 ? 'ticket' : 'tickets'}`,
  /** The line under a business's name: "Lone Star Group · signed up 8/1/2026 · last active 3 hours ago". */
  headline: (
    b: { readonly organizationName: string; readonly lastActiveAt: string | null },
    signedUp: string,
    now = Date.now(),
  ) =>
    `${b.organizationName ? `${b.organizationName} · ` : ''}signed up ${signedUp} · last active ${deskActiveAgo(
      b.lastActiveAt,
      now,
    )}`,
  whatIsSetUp: 'What is set up',
  setUpYes: 'Yes',
  setUpNotYet: 'Not yet',
  theirPeople: 'Their people',
  theirTickets: 'Their tickets',
  neverWrittenIn: 'They have never written in.',
  needsALook: 'Needs a look',
} as const;

// ---------- their balance (M16) ----------

export type DeskWalletStage = 'off' | 'warn' | 'enforce' | 'agency';

/**
 * The rollout's stages, in the order the buttons come. Moving a business from silent to warned to stopped is the only
 * control in HandsFreeOS that can stop somebody's phone working, so it is one business at a time, with a reason.
 * Paid by the agency sits beside the rollout: its usage is still recorded, but nothing is shown and nothing stops.
 */
export const DESK_WALLET_STAGES: Readonly<
  Record<DeskWalletStage, { readonly label: string; readonly what: string }>
> = {
  off: {
    label: 'Silent',
    what: 'They do not know the balance exists. Nothing is shown to them and nothing stops.',
  },
  warn: {
    label: 'Warned',
    what: 'They see their balance and statement and are told when it runs low or out. Nothing stops.',
  },
  enforce: {
    label: 'Stopped at zero',
    what: 'The same, and outgoing texts and calls stop once the balance runs out. No overdraft applies.',
  },
  agency: {
    label: 'Paid by the agency',
    what: 'The agency pays for everything they use. They never see a balance, are never asked for a card, and nothing stops. Usage is still recorded here; moving them off writes off what they ran up.',
  },
};

/** Each stage's badge, in the badge colours the web and the phone share. */
export const DESK_WALLET_STAGE_TONES: Readonly<
  Record<DeskWalletStage, 'member' | 'accent' | 'pending' | 'ok'>
> = {
  off: 'member',
  warn: 'accent',
  enforce: 'pending',
  agency: 'ok',
};

/** The stages a business can be moved to from where it is. */
export const deskWalletMoves = (stage: DeskWalletStage): readonly DeskWalletStage[] =>
  (Object.keys(DESK_WALLET_STAGES) as DeskWalletStage[]).filter((s) => s !== stage);

/** What `platform.wallet.get` says of a balance, as far as the desk shows it. */
export interface DeskWallet {
  readonly opened: boolean;
  readonly stage: DeskWalletStage;
  readonly balanceCents: number;
  readonly autoTopup: boolean;
  readonly floorCents: number;
  readonly topupCents: number;
  readonly hasCard: boolean;
  readonly cardBrand: string | null;
  readonly cardLast4: string | null;
  readonly declinesInRow: number;
  readonly escalationStep: number;
  readonly spent30dCents: number;
  readonly cost30dCents: number;
  readonly toppedUp30dCents: number;
}

/** Charged over cost, as a multiple. Null where nothing cost us anything, which is not a margin of infinity. */
export const deskWalletMargin = (w: {
  readonly spent30dCents: number;
  readonly cost30dCents: number;
}): number | null => (w.cost30dCents > 0 ? w.spent30dCents / w.cost30dCents : null);

/** Under this, the rate card is wrong. */
export const DESK_THIN_MARGIN = 1.2;

export interface DeskWalletLine {
  readonly label: string;
  readonly value: string;
  readonly tone: 'danger' | null;
}

/**
 * A balance, line by line. **Cost is shown beside price**, the one place in the product it is: a business is shown what
 * it was charged, and staff both, because the question they get asked is why.
 */
export function deskWalletLines(w: DeskWallet): readonly DeskWalletLine[] {
  const margin = deskWalletMargin(w);
  const lines: DeskWalletLine[] = [
    // Under the agency the balance only runs down: it is what the agency is covering, not a debt.
    {
      label: w.stage === 'agency' ? 'Balance, the agency covers it' : 'Balance',
      value: money(w.balanceCents),
      tone: w.balanceCents <= 0 && w.stage !== 'agency' ? 'danger' : null,
    },
    {
      label: 'Card',
      value: w.hasCard ? `${w.cardBrand ?? 'Card'} ····${w.cardLast4 ?? '????'}` : 'None',
      tone: null,
    },
    {
      label: 'Automatic top-up',
      value: w.autoTopup ? `${money(w.topupCents)} below ${money(w.floorCents)}` : 'Off',
      tone: null,
    },
    { label: 'Topped up, 30 days', value: money(w.toppedUp30dCents), tone: null },
    { label: 'Charged them, 30 days', value: money(w.spent30dCents), tone: null },
    {
      label: 'Cost us, 30 days',
      value: `${money(w.cost30dCents)}${margin === null ? '' : ` · ${margin.toFixed(2)}×`}`,
      tone: margin !== null && margin < DESK_THIN_MARGIN ? 'danger' : null,
    },
  ];
  if (w.declinesInRow > 0)
    lines.push({ label: 'Declines in a row', value: String(w.declinesInRow), tone: 'danger' });
  if (w.escalationStep > 0)
    lines.push({ label: 'Top-up escalation', value: `step ${w.escalationStep}`, tone: null });
  return lines;
}

/** A reason long enough to be one: `wallet.set_stage` and `wallet.adjust` refuse fewer than three letters. */
export const deskReasonGiven = (reason: string): boolean => reason.trim().length >= 3;

/** Dollars typed as cents, or null when it isn't an amount or is nothing. Negative takes a credit back. */
export function deskCreditCents(amount: string): number | null {
  const cents = Math.round(Number(amount) * 100);
  return Number.isFinite(cents) && cents !== 0 ? cents : null;
}

/** One reference per decision: sending the same one twice is the same credit, not a second. */
export const deskCreditReference = (workspaceId: string, now = Date.now()): string =>
  `admin:${workspaceId}:${now}`;

export const DESK_WALLET_WORDS = {
  title: 'Their balance',
  explain:
    'What they pay us for texts, calls, numbers and AI — not money their own customers owe them.',
  notOpened: 'Nothing yet. They have never spent anything and have never been moved along.',
  suspended: (date: string, reason: string | null) =>
    `Suspended ${date} · ${reason ?? 'the card was declined'}`,
  moveTo: (stage: DeskWalletStage) => `Move to ${DESK_WALLET_STAGES[stage].label.toLowerCase()}`,
  moveTitle: (business: string, stage: DeskWalletStage) =>
    `Move ${business} to ${DESK_WALLET_STAGES[stage].label.toLowerCase()}`,
  writtenOff: (cents: number) =>
    `The ${money(cents)} they ran up while the agency paid is written off with a credit, so they start from zero.`,
  enforceWarning:
    'From now on their outgoing texts and calls stop when the balance runs out. Calls coming in still reach them. Check they have a card on file first.',
  why: 'Why?',
  movePlaceholder: 'First cohort, they have a card and have been warned a week',
  moveThem: 'Move them',
  credit: 'Put a credit on',
  creditTitle: (business: string) => `Put a credit on ${business}`,
  creditExplain:
    'It shows on their statement like everything else, with your reason. A negative amount takes one back.',
  howMuch: 'How much, in dollars?',
  defaultAmount: '25',
  creditPlaceholder: 'Sorry about the outage on the 14th',
  putItOn: 'Put it on',
  cancel: 'Cancel',
  sayWhy: 'Say why, in a few words.',
  putInAmount: 'Put in an amount.',
} as const;

// ---------- AI on their calls, and HandsFreeOS's own business ----------

export const DESK_PHONE_MODEL_WORDS = {
  title: 'AI on their calls',
  explain:
    'The model their AI teammate thinks with on phone calls and in test calls. Default is the worker’s VOICE_MODEL, Claude Haiku 5.5 unless it’s set. It changes from the next call.',
  label: 'Model on their calls',
  default: 'Default',
} as const;

export const DESK_OWN_BUSINESS_WORDS = {
  title: 'HandsFreeOS’s own business',
  explain:
    'Only HandsFreeOS’s own business may use handsfreeos.com for its email and receive mail there. Names the support desk uses stay reserved.',
  yes: 'Yes',
  no: 'No',
} as const;

// ---------- the quick look ----------

/** The quick look's tabs, in order: the directory opens a business here instead of on its own page. */
export const DESK_QUICK_LOOK_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'people', label: 'People' },
  { key: 'money', label: 'Money' },
  { key: 'setup', label: 'Set up' },
  { key: 'tickets', label: 'Tickets' },
] as const;

export type DeskQuickLookTab = (typeof DESK_QUICK_LOOK_TABS)[number]['key'];

/** A date as the desk writes it: "Aug 1, 2026". In UTC, so the server and the browser agree. */
const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: intlTimeZone('UTC'),
  });

const count = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;
/** A reason from somewhere else, ended with a full stop when it hasn't one. */
const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

export const DESK_QUICK_LOOK_WORDS = {
  loading: 'Getting their details…',
  failed: 'Their details didn’t load. Try again in a minute.',
  tryAgain: 'Try again',
  close: 'Close',
  previous: 'Previous business',
  next: 'Next business',
  position: (n: number, of: number) => `${n} of ${of}`,
  viewAs: 'View as',
  fullPage: 'Full page',
  nothingNeedsALook: 'Nothing needs a look right now.',
  lastThirtyDays: 'Last 30 days',
  activityTotal: (n: number) => `${plural(n, 'thing', 'things')} happened`,
  activityChart: (n: number) =>
    `How much happened each day for the last 30 days, ${plural(n, 'thing', 'things')} in all`,
  thirtyDaysAgo: '30 days ago',
  today: 'Today',
  planAndBalance: 'Plan and balance',
  setUpScore: (done: number, of: number) => `${done} of ${of}`,
  seeAll: (n: number) => `See all ${n}`,
  moreAboutThem: 'More about them',
  whatTheyPayUs: 'What they pay us',
  whatTheyPayUsExplain: 'Their plan, and the balance for texts, calls, numbers and AI.',
  whatCustomersPayThem: 'What their customers pay them',
  whatCustomersPayThemExplain: 'Money through their own invoices. None of it is ours.',
  changeOnFullPage:
    'To put a credit on, move their balance along or change their plan, open the full page.',
  problemReports: 'Problem reports from them',
  noProblemReports: 'They haven’t sent any.',
  handled: 'Handled',
  notHandled: 'Not handled',
  businessId: 'Business ID',
  copy: 'Copy',
  copied: 'Copied the business ID',
  keys: 'Esc closes · ← → moves between businesses',
  active: (iso: string | null, now = Date.now()) => `active ${deskActiveAgo(iso, now)}`,
} as const;

// ---- what needs a look ----

export type DeskFlagTone = 'danger' | 'warning' | 'accent';

/** One thing that needs a look, and the tab that says more about it. */
export interface DeskFlag {
  readonly key: BusinessAttentionValue | 'open_tickets' | 'problem_reports';
  readonly tone: DeskFlagTone;
  readonly text: string;
  readonly tab: DeskQuickLookTab | null;
}

/** The button beside a flag that opens its tab. */
export const DESK_FLAG_ACTIONS: Readonly<Record<DeskQuickLookTab, string>> = {
  overview: 'See overview',
  people: 'See people',
  money: 'See money',
  setup: 'See set up',
  tickets: 'See tickets',
};

const BROKEN = ['reauth_required', 'error', 'needs_attention'];
const MAILBOX_NAMES: Readonly<Record<string, string>> = { google: 'Gmail', microsoft: 'Outlook' };
const CALENDAR_NAMES: Readonly<Record<string, string>> = {
  google: 'Google Calendar',
  microsoft: 'Outlook calendar',
};
const paymentName = (provider: string) => PAYMENT_PROVIDER_LABELS[provider] ?? provider;

/** "Stripe", "Stripe and Gmail", "Stripe, Gmail and Google Calendar". */
const andList = (names: readonly string[]) =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** What is connected but needs signing in again, by name. */
function brokenConnections(setup: BusinessGlance['setup']): string[] {
  return [
    ...setup.payments.filter((c) => BROKEN.includes(c.status)).map((c) => paymentName(c.provider)),
    ...setup.calendarConnections
      .filter((c) => BROKEN.includes(c.status))
      .map((c) => CALENDAR_NAMES[c.provider] ?? c.provider),
    ...setup.mailboxes
      .filter((c) => BROKEN.includes(c.status))
      .map((c) => `${MAILBOX_NAMES[c.provider] ?? c.provider} mailbox`),
    ...(setup.meta && BROKEN.includes(setup.meta) ? ['Facebook and Instagram'] : []),
  ];
}

const OPEN_TICKET: readonly TicketStatusValue[] = ['new', 'open', 'waiting_on_customer'];

/**
 * What needs a look, most serious first, each said with what the request knows: the balance, the reason, how long.
 * Which businesses need one is the database's call (`attention`); these are its words, then the open tickets and
 * problem reports, which are worth a look without being trouble.
 */
export function deskBusinessFlags(
  b: {
    readonly attention: readonly BusinessAttentionValue[];
    readonly lastActiveAt: string | null;
    readonly createdAt: string;
    readonly tickets: readonly { readonly status: TicketStatusValue; readonly createdAt: string }[];
  },
  glance: BusinessGlance,
  wallet: DeskWallet | null,
  now = Date.now(),
): DeskFlag[] {
  const balance = wallet ? money(wallet.balanceCents) : null;
  const flags: DeskFlag[] = b.attention.map((key): DeskFlag => {
    switch (key) {
      case 'being_deleted':
        return {
          key,
          tone: 'danger',
          text: `An owner asked to delete this business${
            glance.deletionRequestedAt ? ` on ${day(glance.deletionRequestedAt)}` : ''
          }. It’s being taken out of HandsFreeOS.`,
          tab: null,
        };
      case 'wallet_suspended':
        return {
          key,
          tone: 'danger',
          text: 'Their balance is suspended, so their outgoing texts and calls are stopped.',
          tab: 'money',
        };
      case 'card_declined': {
        const n = wallet?.declinesInRow ?? 1;
        return {
          key,
          tone: 'danger',
          text: `Their card was declined ${n === 1 ? 'the last time' : `${n} times in a row`}${
            balance ? `, and their balance is ${balance}` : ''
          }.`,
          tab: 'money',
        };
      }
      case 'balance_out':
        return wallet?.stage === 'enforce'
          ? {
              key,
              tone: 'danger',
              text: `Their balance is ${balance ?? money(0)}, so their outgoing texts and calls have stopped.`,
              tab: 'money',
            }
          : {
              key,
              tone: 'warning',
              text: `Their balance is ${balance ?? money(0)}. They’re being told; nothing has stopped yet.`,
              tab: 'money',
            };
      case 'plan_trouble': {
        const plan = glance.plan;
        const text = plan?.renewalProblem
          ? `Their plan didn’t renew. ${sentence(plan.renewalProblem)}`
          : plan?.status === 'grace' && plan.graceEndsAt
            ? `Their plan is in grace until ${day(plan.graceEndsAt)}.`
            : 'Their plan’s payment is late.';
        return { key, tone: 'danger', text, tab: 'money' };
      }
      case 'texting_rejected': {
        const reason = glance.setup.registration?.reason;
        return {
          key,
          tone: 'danger',
          text: `Their texting registration was turned down.${reason ? ` ${sentence(reason)}` : ''}`,
          tab: 'setup',
        };
      }
      case 'connection_broken': {
        const names = brokenConnections(glance.setup);
        return {
          key,
          tone: 'warning',
          text: names.length
            ? `${andList(names)} ${names.length === 1 ? 'needs' : 'need'} signing in again.`
            : 'A connection needs signing in again.',
          tab: 'setup',
        };
      }
      case 'texting_waiting': {
        const since = glance.setup.registration?.since;
        return {
          key,
          tone: 'warning',
          text: since
            ? `Their texting registration has waited on the carriers for ${sinceIso(since, now)}.`
            : 'Their texting registration has waited on the carriers for a while.',
          tab: 'setup',
        };
      }
      case 'thin_margin': {
        const margin = wallet ? deskWalletMargin(wallet) : null;
        return {
          key,
          tone: 'warning',
          text: `We charged them ${
            margin === null ? 'less than 1.2×' : `only ${margin.toFixed(2)}×`
          } what they cost us in 30 days. The rate card may be off.`,
          tab: 'money',
        };
      }
      case 'gone_quiet':
        return {
          key,
          tone: 'warning',
          text: b.lastActiveAt
            ? `Gone quiet: nobody there has done anything in ${sinceIso(b.lastActiveAt, now)}.`
            : `Gone quiet: nobody there has done anything since they signed up ${day(b.createdAt)}.`,
          tab: 'people',
        };
      case 'setup_stalled':
        return {
          key,
          tone: 'warning',
          text:
            glance.setup.gettingStarted === 'started'
              ? 'They started Getting started but haven’t finished it.'
              : 'They haven’t started Getting started.',
          tab: 'setup',
        };
    }
  });
  const open = b.tickets.filter((t) => OPEN_TICKET.includes(t.status));
  if (open.length) {
    const oldest = open.reduce((a, t) => (t.createdAt < a ? t.createdAt : a), open[0]!.createdAt);
    flags.push({
      key: 'open_tickets',
      tone: 'accent',
      text: `${plural(open.length, 'open ticket', 'open tickets')}. The oldest has waited ${sinceIso(oldest, now)}.`,
      tab: 'tickets',
    });
  }
  if (glance.problemReports.open) {
    flags.push({
      key: 'problem_reports',
      tone: 'accent',
      text: `${plural(glance.problemReports.open, 'problem report', 'problem reports')} nobody has handled yet.`,
      tab: 'tickets',
    });
  }
  return flags;
}

// ---- the plan, and the money ----

/** The plans, as a row of the directory names them. */
export const DESK_PLAN_WORDS: Readonly<Record<BusinessPlanValue, string>> = {
  founding_free: 'Founding, free',
  founding_lifetime: 'Founding seat',
  monthly: 'Monthly',
};

/** The plan in full, once its dates are known: a founding seat is for life, or paid by the year. */
export function deskPlanLabel(plan: BusinessGlance['plan']): string {
  if (!plan) return 'No plan yet';
  if (plan.plan === 'founding_lifetime')
    return plan.periodEnd ? 'Founding, yearly' : 'Founding, lifetime';
  return DESK_PLAN_WORDS[plan.plan];
}

/** The plan, line by line, in the shape of the balance's lines so the two read as one list. */
export function deskPlanLines(plan: BusinessGlance['plan']): readonly DeskWalletLine[] {
  if (!plan) return [{ label: 'Plan', value: 'No plan yet', tone: null }];
  const per = plan.plan === 'monthly' ? ' a month' : plan.periodEnd ? ' a year' : '';
  const lines: DeskWalletLine[] = [
    {
      label: 'Plan',
      value: `${deskPlanLabel(plan)}${plan.priceCents > 0 ? `, ${money(plan.priceCents)}${per}` : ''}`,
      tone: null,
    },
  ];
  if (plan.status === 'canceled')
    lines.push({
      label: 'Canceled',
      value: plan.canceledAt ? day(plan.canceledAt) : 'Yes',
      tone: 'danger',
    });
  else if (plan.status === 'grace')
    lines.push({
      label: 'In grace until',
      value: plan.graceEndsAt ? day(plan.graceEndsAt) : 'Soon',
      tone: 'danger',
    });
  else if (plan.status === 'past_due')
    lines.push({ label: 'Payment', value: 'Late', tone: 'danger' });
  if (plan.renewalProblem)
    lines.push({
      label: 'Renewal failed',
      value: plan.renewalFailedAt ? day(plan.renewalFailedAt) : 'Yes',
      tone: 'danger',
    });
  if (plan.periodEnd)
    lines.push({
      label: plan.renewalStoppedAt ? 'Ends' : 'Renews',
      value: day(plan.periodEnd),
      tone: null,
    });
  else if (plan.plan !== 'monthly')
    lines.push({
      label: 'Renews',
      value: plan.plan === 'founding_free' ? 'Never, it’s free' : 'Never, it’s for life',
      tone: null,
    });
  return lines;
}

/** The overview's short version of the plan and balance: the plan, then the balance, the card and the margin. */
export function deskPlanAndBalanceShort(
  plan: BusinessGlance['plan'],
  wallet: DeskWallet | null,
): readonly DeskWalletLine[] {
  const keep = ['Balance', 'Balance, the agency covers it', 'Card', 'Cost us, 30 days'];
  return [
    ...deskPlanLines(plan).slice(0, 2),
    ...(wallet?.opened
      ? deskWalletLines(wallet).filter((l) => keep.includes(l.label))
      : [{ label: 'Balance', value: 'Never opened', tone: null }]),
  ];
}

/** Money their own customers paid them, which is theirs, never ours. */
export function deskTheirMoneyLines(glance: BusinessGlance): readonly DeskWalletLine[] {
  const m = glance.theirMoney;
  const takes = glance.setup.payments
    .filter((c) => c.status === 'active')
    .map((c) => paymentName(c.provider));
  const lines: DeskWalletLine[] = [
    { label: 'Collected, 30 days', value: money(m.collected30dCents), tone: null },
    {
      label: 'Waiting to be paid',
      value: m.openInvoices
        ? `${money(m.openInvoiceCents)} on ${plural(m.openInvoices, 'invoice', 'invoices')}`
        : 'Nothing',
      tone: null,
    },
  ];
  if (m.overdueInvoices)
    lines.push({
      label: 'Overdue',
      value: plural(m.overdueInvoices, 'invoice', 'invoices'),
      tone: 'danger',
    });
  lines.push(
    {
      label: 'Refunded, 30 days',
      value: m.refunded30dCents ? money(m.refunded30dCents) : 'Nothing',
      tone: null,
    },
    {
      label: 'Open disputes',
      value: m.openDisputes ? count(m.openDisputes) : 'None',
      tone: m.openDisputes ? 'danger' : null,
    },
    {
      label: 'Takes payments with',
      value: takes.length ? andList(takes) : 'Nothing connected',
      tone: null,
    },
  );
  return lines;
}

// ---- what is set up ----

export type DeskSetupState = 'yes' | 'no' | 'waiting' | 'problem';

export interface DeskSetupRow {
  readonly key: string;
  readonly label: string;
  readonly detail: string;
  readonly state: DeskSetupState;
}

/** The word on each row's badge. */
export const DESK_SETUP_STATE_WORDS: Readonly<Record<DeskSetupState, string>> = {
  yes: 'Yes',
  no: 'Not yet',
  waiting: 'Waiting',
  problem: 'Needs fixing',
};

/** Each thing a business can connect, how, and whether it works: the Set up tab, row by row. */
export function deskSetupRows(setup: BusinessGlance['setup'], now = Date.now()): DeskSetupRow[] {
  const row = (key: string, detail: string, state: DeskSetupState): DeskSetupRow => ({
    key,
    label: DESK_SETUP_WORDS[key] ?? key,
    detail,
    state,
  });

  const [first, ...others] = setup.numbers;
  const phone = first
    ? row(
        'phone',
        `${formatPhone(first)}${others.length ? ` and ${others.length} more` : ''}`,
        'yes',
      )
    : row('phone', 'No number yet', 'no');

  const r = setup.registration;
  const registration = !r
    ? row('registration', 'Not started', 'no')
    : r.state === 'approved'
      ? row('registration', 'Approved', 'yes')
      : r.state === 'waiting'
        ? row(
            'registration',
            r.since ? `With the carriers, ${sinceIso(r.since, now)}` : 'With the carriers',
            'waiting',
          )
        : r.state === 'rejected'
          ? row(
              'registration',
              r.reason ? `Turned down. ${sentence(r.reason)}` : 'Turned down',
              'problem',
            )
          : row('registration', 'Started, not sent yet', 'no');

  const mailbox = setup.mailboxes[0];
  const mailboxName = mailbox
    ? `${MAILBOX_NAMES[mailbox.provider] ?? mailbox.provider} mailbox`
    : '';
  const domain = setup.emailDomain;
  const email =
    mailbox && BROKEN.includes(mailbox.status)
      ? row('email', `${mailboxName} needs signing in again`, 'problem')
      : domain?.status === 'failed'
        ? row('email', `${domain.domain}, its records don’t check out`, 'problem')
        : domain?.status === 'verified'
          ? row('email', `${domain.domain}, verified`, 'yes')
          : mailbox?.status === 'active'
            ? row('email', mailboxName, 'yes')
            : domain
              ? row('email', `${domain.domain}, waiting on its records`, 'waiting')
              : setup.emailAddresses
                ? row('email', 'A HandsFreeOS address only', 'yes')
                : row('email', 'Not set up', 'no');

  const brokenPay = setup.payments.filter((c) => BROKEN.includes(c.status));
  const activePay = setup.payments.filter((c) => c.status === 'active');
  const payments = brokenPay.length
    ? row(
        'payments',
        `${andList(brokenPay.map((c) => paymentName(c.provider)))} needs signing in again`,
        'problem',
      )
    : activePay.length
      ? row('payments', andList(activePay.map((c) => paymentName(c.provider))), 'yes')
      : setup.payments.length
        ? row(
            'payments',
            `${paymentName(setup.payments[0]!.provider)}, not finished connecting`,
            'waiting',
          )
        : row('payments', 'Nothing connected', 'no');

  const brokenCal = setup.calendarConnections.filter((c) => BROKEN.includes(c.status));
  const activeCal = setup.calendarConnections.filter((c) => c.status === 'active');
  const calendarParts = [
    ...activeCal.map((c) => CALENDAR_NAMES[c.provider] ?? c.provider),
    ...(setup.calendars ? [plural(setup.calendars, 'calendar', 'calendars')] : []),
    ...(setup.bookingPage?.enabled ? ['booking page on'] : []),
  ];
  const calendar = brokenCal.length
    ? row(
        'calendar',
        `${andList(brokenCal.map((c) => CALENDAR_NAMES[c.provider] ?? c.provider))} needs signing in again`,
        'problem',
      )
    : calendarParts.length
      ? row(
          'calendar',
          calendarParts.join(', '),
          setup.calendars || activeCal.length ? 'yes' : 'no',
        )
      : row('calendar', 'Not set up', 'no');

  const aiTeammate =
    setup.aiTeammate === 'automatic'
      ? row('aiTeammate', 'Answers on its own', 'yes')
      : setup.aiTeammate === 'training'
        ? row('aiTeammate', 'Learning: a person OKs its replies', 'yes')
        : setup.aiTeammate === 'off'
          ? row('aiTeammate', 'Switched off', 'no')
          : row('aiTeammate', 'Not set up', 'no');

  const meta =
    setup.meta === 'connected'
      ? row('meta', 'Connected', 'yes')
      : setup.meta && BROKEN.includes(setup.meta)
        ? row('meta', 'Needs signing in again', 'problem')
        : setup.meta
          ? row('meta', 'Not finished connecting', 'waiting')
          : row('meta', 'Not connected', 'no');

  const gettingStarted = {
    finished: row('gettingStarted', 'Finished', 'yes'),
    started: row('gettingStarted', 'Started, not finished', 'waiting'),
    off: row('gettingStarted', 'Turned off', 'no'),
    not_started: row('gettingStarted', 'Not started', 'no'),
  }[setup.gettingStarted];

  return [phone, registration, email, payments, calendar, aiTeammate, meta, gettingStarted];
}

/** "6 of 8": how many rows are set up and working. */
export const deskSetupScore = (rows: readonly DeskSetupRow[]): string =>
  DESK_QUICK_LOOK_WORDS.setUpScore(rows.filter((r) => r.state === 'yes').length, rows.length);

// ---- the overview's numbers ----

/** The six numbers over the overview: what the business holds, then what its customers paid it this month. */
export function deskQuickLookCounts(
  counts: Parameters<typeof deskBusinessCounts>[0],
  glance: BusinessGlance,
): readonly { readonly label: string; readonly value: string }[] {
  return [
    ...deskBusinessCounts(counts).map((c) => ({ label: c.label, value: count(c.value) })),
    { label: 'Collected, 30 days', value: money(glance.theirMoney.collected30dCents) },
  ];
}

/** Texts, calls, emails and AI replies, the last 30 days. */
export function deskTrafficLines(
  traffic: BusinessGlance['traffic'],
): readonly { readonly label: string; readonly value: string }[] {
  return [
    { label: 'Texts', value: count(traffic.texts) },
    { label: 'Calls', value: count(traffic.calls) },
    { label: 'Emails', value: count(traffic.emails) },
    { label: 'AI replies', value: count(traffic.aiReplies) },
  ];
}

/** Each day's bar as a share of the busiest day, 0 to 1; all zero when nothing happened. */
export function deskActivityBars(activity: readonly number[]): readonly number[] {
  const most = Math.max(0, ...activity);
  return activity.map((n) => (most ? n / most : 0));
}

/** The time where the business is, so a call isn't placed at 6am their time: "3:42 PM". */
export function deskTheirTime(timezone: string, now = Date.now()): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: intlTimeZone(timezone),
  }).format(now);
}

// ---- more about them ----

const MOVED: readonly string[] = ['imported', 'transition', 'finalizing', 'completed'];

const SUPPORT_ACCESS_WORDS: Readonly<
  Record<NonNullable<BusinessGlance['more']['supportAccess']>['status'], string>
> = {
  requested: 'Asked, no answer yet',
  active: 'Granted',
  declined: 'They said no',
  ended: 'Ended',
};

/** Everything else worth knowing on a call with them, as label and value. */
export function deskMoreLines(
  b: { readonly industry: string; readonly timezone: string; readonly createdAt: string },
  glance: BusinessGlance,
  phoneModel: string | null,
  now = Date.now(),
): readonly { readonly label: string; readonly value: string }[] {
  const more = glance.more;
  const from = more.cameFrom;
  const access = more.supportAccess;
  const offer = more.mainOffer;
  return [
    { label: 'Industry', value: industryLabel(b.industry) },
    { label: 'Their time', value: `${deskTheirTime(b.timezone, now)}, ${b.timezone}` },
    { label: 'Signed up', value: day(b.createdAt) },
    {
      label: 'Came from',
      value: from
        ? `${SOURCE_LABELS[from.source as MigrationSourceSystem] ?? from.source}, ${
            MOVED.includes(from.status)
              ? `moved${from.at ? ` ${day(from.at)}` : ''}`
              : 'still moving'
          }`
        : 'Started fresh',
    },
    {
      label: 'Add-ons on',
      value: more.addons.length
        ? more.addons.map((id) => withAddonNames(`{addon:${id}}`)).join(', ')
        : 'None',
    },
    {
      label: 'Main offer',
      value: offer?.liveVersion
        ? `Live, version ${offer.liveVersion}`
        : offer?.revision
          ? 'Drafted, not live yet'
          : 'Not started',
    },
    { label: 'AI on their calls', value: phoneModel ?? DESK_PHONE_MODEL_WORDS.default },
    {
      label: 'Support access',
      value: !access
        ? 'Never asked'
        : access.status === 'active' && access.expiresAt
          ? `Granted until ${day(access.expiresAt)}`
          : SUPPORT_ACCESS_WORDS[access.status],
    },
    {
      label: 'We last viewed as them',
      value: more.lastViewedAs ? deskActiveAgo(more.lastViewedAs, now) : 'Never',
    },
  ];
}

/** A problem report's line in the Tickets tab: where it was, and what they said. */
export const deskProblemReportLine = (r: BusinessGlance['problemReports']['recent'][number]) =>
  `${r.area ?? 'Somewhere'}${r.note ? `: “${r.note}”` : ''}`;
