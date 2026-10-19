/**
 * The support desk's Businesses (M13), said once for the web's /admin/businesses and the phone's Support desk: the
 * directory's totals and orders, one business's counts and what it has set up, its balance (M16), the model its calls
 * think with, and whether it is HandsFreeOS's own (M19). The screens differ; what they say and work out does not.
 */

import { money } from '../money/index';

import { DESK_WORDS, sinceIso, sinceWords } from './desk-words';

// ---------- the directory ----------

/** The directory's orders. Only Newest pages: it is the one order that can't change under the reader's feet. */
export const DESK_BUSINESS_SORTS = [
  { key: 'newest', label: 'Newest' },
  { key: 'busiest', label: 'Most active' },
  { key: 'quietest', label: 'Gone quiet' },
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
  email: 'Email',
  payments: 'Taking money',
  calendar: 'Calendar and booking',
  aiTeammate: 'AI teammate',
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
