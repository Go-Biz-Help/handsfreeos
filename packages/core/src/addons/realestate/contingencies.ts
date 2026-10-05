/**
 * Contingencies (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round four", step 3): each one a deal has, when it
 * ends, and how it ended, in the add-on's words for the agent and for the client. Browser-safe and pure.
 *
 * - **One of each kind** a contract has (inspection, financing, appraisal, the sale of the buyer's home, HOA
 *   documents, title review), each ending on its key date, so moving the date moves it; and any others the agent names,
 *   each with its own date.
 * - **How it ended**, recorded by the agent with the signed form (Chris, 2026-10-02): satisfied, waived or expired.
 */
import { fmtMonthDay } from '../../calendar/when';
import { parseLocalDate } from '../../calendar/engine/zoned';
import { businessDaysBetween, type BusinessCalendar } from './dates/business-days';
import type { KeyDateKey, KeyDates } from './dates/key-dates';
import type { DealSide } from './states';

export const CONTINGENCY_KINDS = {
  inspection: { label: 'Inspection', endKey: 'inspection_end' },
  financing: { label: 'Financing', endKey: 'financing_end' },
  appraisal: { label: 'Appraisal', endKey: 'appraisal_end' },
  home_sale: { label: 'Sale of the buyer’s home', endKey: 'home_sale_end' },
  hoa: { label: 'HOA documents', endKey: 'hoa_review_end' },
  title: { label: 'Title review', endKey: 'title_objection_end' },
  other: { label: 'Other', endKey: null },
} as const satisfies Record<string, { label: string; endKey: KeyDateKey | null }>;
export type ContingencyKind = keyof typeof CONTINGENCY_KINDS;
export const CONTINGENCY_KIND_KEYS = Object.keys(CONTINGENCY_KINDS) as [
  ContingencyKind,
  ...ContingencyKind[],
];

export const CONTINGENCY_STATES = ['open', 'satisfied', 'waived', 'expired'] as const;
export type ContingencyState = (typeof CONTINGENCY_STATES)[number];
/** How one ends. */
export const CONTINGENCY_ENDINGS = ['satisfied', 'waived', 'expired'] as const;
export type ContingencyEnding = (typeof CONTINGENCY_ENDINGS)[number];

/** The kind whose end is this key date, if any. */
export const contingencyOfKey = (key: string): Exclude<ContingencyKind, 'other'> | null =>
  (Object.entries(CONTINGENCY_KINDS).find(([, d]) => d.endKey === key)?.[0] as
    Exclude<ContingencyKind, 'other'> | undefined) ?? null;

/** The key dates contingencies end on. */
export const CONTINGENCY_END_KEYS = Object.values(CONTINGENCY_KINDS)
  .map((d) => d.endKey)
  .filter((k): k is NonNullable<typeof k> => k !== null);

export interface ContingencyRow {
  readonly kind: ContingencyKind;
  readonly label: string | null;
  readonly endsOn: string | null;
  readonly state: ContingencyState;
}

export const contingencyLabel = (c: Pick<ContingencyRow, 'kind' | 'label'>) =>
  c.kind === 'other' ? (c.label ?? 'Other') : CONTINGENCY_KINDS[c.kind].label;

/** A label inside a sentence: "the financing contingency", but "the HOA documents contingency". */
export const inSentence = (label: string) =>
  /^[A-Z][a-z]/.test(label) ? label[0]!.toLowerCase() + label.slice(1) : label;

/** When it ends: its own date, or its key date as the deal has it now; whether a person confirmed that date. */
export function contingencyEnd(
  c: Pick<ContingencyRow, 'kind' | 'endsOn'>,
  keyDates: KeyDates,
): { readonly date: string | null; readonly confirmed: boolean } {
  if (c.kind === 'other') return { date: c.endsOn, confirmed: c.endsOn !== null };
  const v = keyDates[CONTINGENCY_KINDS[c.kind].endKey];
  return { date: v?.date ?? null, confirmed: v?.confirmed ?? false };
}

/** Where an open one stands against today: ended, ending within two business days, or later. */
export function contingencyClock(
  end: string | null,
  today: string,
  calendar?: BusinessCalendar,
): 'unknown' | 'passed' | 'ending' | 'open' {
  if (!end) return 'unknown';
  if (end < today) return 'passed';
  return businessDaysBetween(today, end, calendar) <= 2 ? 'ending' : 'open';
}

const ENDED_WORDS: Readonly<Record<ContingencyEnding, string>> = {
  satisfied: 'Satisfied',
  waived: 'Waived',
  expired: 'Expired',
};

/** "Open · ends Oct 8", "Ends today", "Satisfied Oct 1", "End date not entered". */
export function contingencyStateWords(
  c: Pick<ContingencyRow, 'state'> & { readonly resolvedOn?: string | null },
  end: string | null,
  today: string,
): string {
  const year = parseLocalDate(today).year;
  if (c.state !== 'open')
    return `${ENDED_WORDS[c.state]}${c.resolvedOn ? ` ${fmtMonthDay(c.resolvedOn, year)}` : ''}`;
  if (!end) return 'End date not entered';
  if (end === today) return 'Ends today';
  if (end < today) return `Ended ${fmtMonthDay(end, year)}, nothing recorded`;
  return `Open · ends ${fmtMonthDay(end, year)}`;
}

/** What it is, for the client, in a line: never advice, only what it's for. */
export function contingencyMeaning(kind: ContingencyKind, side: DealSide): string {
  const yours = side === 'buyer';
  switch (kind) {
    case 'inspection':
      return yours
        ? 'Time to have the home inspected and decide whether to go ahead.'
        : 'Time for the buyer to have the home inspected and decide whether to go ahead.';
    case 'financing':
      return yours
        ? 'Time for your loan to be approved.'
        : 'Time for the buyer’s loan to be approved.';
    case 'appraisal':
      return 'The home has to appraise for at least the price.';
    case 'home_sale':
      return yours
        ? 'Time to sell the home you have now.'
        : 'Time for the buyer to sell the home they have now.';
    case 'hoa':
      return yours
        ? 'Time to read the HOA’s documents.'
        : 'Time for the buyer to read the HOA’s documents.';
    case 'title':
      return 'Time to check the title report for anything that needs fixing.';
    case 'other':
      return 'A condition in the contract.';
  }
}
