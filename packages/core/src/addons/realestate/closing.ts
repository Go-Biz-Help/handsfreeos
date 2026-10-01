/**
 * Financing, inspections and repairs on a buyer deal (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round two:
 * Buyer core"): the steps of a loan, the Closing Disclosure's deadline, what an inspection found and the repair
 * request drafted from it. Browser-safe and pure: the deal's pages, the portal, the phone and the Assistant say the
 * same.
 */
import { addDays, weekdayOf } from '../../calendar/engine/zoned';
import { fmtMonthDay } from '../../calendar/when';
import { money } from '../../money/format';
import { holidayOn } from './dates/holidays';

/** A loan's steps, in order, each with the document kinds that prove it. */
export const FINANCING_STEPS = {
  preapproval: { label: 'Preapproval', proof: ['preapproval'] },
  application: { label: 'Loan application', proof: [] },
  rate_lock: { label: 'Rate lock', proof: ['rate_lock'] },
  appraisal: { label: 'Appraisal', proof: ['appraisal'] },
  conditional_approval: { label: 'Conditional approval', proof: ['loan_approval'] },
  clear_to_close: { label: 'Clear to close', proof: ['clear_to_close'] },
  closing_disclosure: { label: 'Closing Disclosure', proof: ['closing_disclosure'] },
  funding: { label: 'Funding', proof: ['settlement_statement'] },
} as const;
export type FinancingStep = keyof typeof FINANCING_STEPS;
export const FINANCING_STEP_KEYS = Object.keys(FINANCING_STEPS) as [
  FinancingStep,
  ...FinancingStep[],
];

export const STEP_STATUSES = {
  not_started: 'Not started',
  in_progress: 'Under way',
  done: 'Done',
} as const;
export type StepStatus = keyof typeof STEP_STATUSES;

/** A step as stored. */
export interface StepFacts {
  readonly step: FinancingStep;
  readonly status: StepStatus;
  readonly startedOn: string | null;
  readonly expectedOn: string | null;
  readonly doneOn: string | null;
  readonly amountCents: number | null;
  readonly rate: number | null;
  readonly expiresOn: string | null;
}

/**
 * The day the Closing Disclosure must reach the buyers by: three business days before closing, where every day but
 * Sunday and federal holidays counts (the federal rule's own business days, not the office's).
 */
export function cdDeadline(closing: string): string {
  let at = closing;
  let counted = 0;
  while (counted < 3) {
    at = addDays(at, -1);
    if (weekdayOf(at) !== 0 && !holidayOn(at)) counted += 1;
  }
  return at;
}

const day = (d: string) => fmtMonthDay(d);

/** A step's line, as the financing page says it: "Up to $425,000 · ends Nov 12", "6.125% until Nov 10". */
export function stepWords(
  s: StepFacts,
  deal: { readonly closing: string | null; readonly priceCents: number | null },
): { readonly line: string; readonly warning: string | null } {
  const parts: string[] = [];
  let warning: string | null = null;
  switch (s.step) {
    case 'preapproval':
      if (s.amountCents) parts.push(`Up to ${money(s.amountCents)}`);
      if (s.expiresOn) parts.push(`ends ${day(s.expiresOn)}`);
      if (s.expiresOn && deal.closing && s.expiresOn < deal.closing)
        warning = 'Ends before closing';
      break;
    case 'rate_lock':
      if (s.rate !== null)
        parts.push(`${s.rate}%${s.expiresOn ? ` until ${day(s.expiresOn)}` : ''}`);
      else if (s.expiresOn) parts.push(`Until ${day(s.expiresOn)}`);
      if (s.expiresOn && deal.closing && s.expiresOn < deal.closing)
        warning = 'The lock ends before closing';
      break;
    case 'appraisal':
      if (s.status === 'done' && s.amountCents) {
        parts.push(`Came in at ${money(s.amountCents)}`);
        if (deal.priceCents && s.amountCents < deal.priceCents)
          warning = `${money(deal.priceCents - s.amountCents)} below the price`;
      } else {
        if (s.startedOn) parts.push(`Ordered ${day(s.startedOn)}`);
        if (s.expectedOn) parts.push(`due ${day(s.expectedOn)}`);
      }
      break;
    case 'closing_disclosure':
      if (s.status === 'done' && s.doneOn) parts.push(`Received ${day(s.doneOn)}`);
      else if (deal.closing)
        parts.push(`Must reach the buyers by ${day(cdDeadline(deal.closing))}`);
      if (s.status === 'done' && s.doneOn && deal.closing && s.doneOn > cdDeadline(deal.closing))
        warning = 'Received late: closing may have to move';
      break;
    case 'funding':
      if (s.doneOn) parts.push(`Funded ${day(s.doneOn)}`);
      else if (deal.closing) parts.push(day(deal.closing));
      break;
    default:
      if (s.status === 'done' && s.doneOn)
        parts.push(`${s.step === 'application' ? 'Sent' : 'Done'} ${day(s.doneOn)}`);
      else if (s.expectedOn) parts.push(`Expected by ${day(s.expectedOn)}`);
  }
  if (!parts.length) parts.push(s.status === 'not_started' ? 'Not started' : 'Under way');
  return { line: parts.join(' · '), warning };
}

// ---------- inspections ----------

export const INSPECTION_KINDS = {
  general: 'General inspection',
  termite: 'Termite',
  roof: 'Roof',
  sewer: 'Sewer scope',
  radon: 'Radon',
  mold: 'Mold',
  pool: 'Pool',
  hvac: 'Heating and cooling',
  structural: 'Structural',
  other: 'Other inspection',
} as const;
export type InspectionKind = keyof typeof INSPECTION_KINDS;
export const INSPECTION_KIND_KEYS = Object.keys(INSPECTION_KINDS) as [
  InspectionKind,
  ...InspectionKind[],
];

export const FINDING_SEVERITIES = { safety: 'Safety', repair: 'Repair', minor: 'Minor' } as const;
export type FindingSeverity = keyof typeof FINDING_SEVERITIES;
export const FINDING_SEVERITY_KEYS = Object.keys(FINDING_SEVERITIES) as [
  FindingSeverity,
  ...FindingSeverity[],
];

export const CLIENT_PRIORITIES = {
  must_fix: 'Must fix',
  would_like: 'Would like',
  skip: 'Skip',
} as const;
export type ClientPriority = keyof typeof CLIENT_PRIORITIES;
export const CLIENT_PRIORITY_KEYS = Object.keys(CLIENT_PRIORITIES) as [
  ClientPriority,
  ...ClientPriority[],
];

export const FINDING_ASKS = {
  repair: 'Repair',
  replace: 'Replace',
  credit: 'Credit',
  not_asked: 'Not asked',
} as const;
export type FindingAsk = keyof typeof FINDING_ASKS;
export const FINDING_ASK_KEYS = Object.keys(FINDING_ASKS) as [FindingAsk, ...FindingAsk[]];

export interface FindingFacts {
  readonly id: string;
  readonly title: string;
  readonly location: string | null;
  readonly clientPriority: ClientPriority | null;
  readonly ask: FindingAsk;
  readonly creditCents: number | null;
  readonly estimateCents: number | null;
}

/** One thing a repair request asks for. */
export interface RepairItem {
  readonly findingId: string;
  readonly title: string;
  readonly ask: Exclude<FindingAsk, 'not_asked'>;
  readonly creditCents: number | null;
}

/**
 * The repair request drafted from the findings: each one with something to ask for that the client didn't skip,
 * must-fixes first, in plain words for the agent to edit before it's sent.
 */
export function repairDraft(findings: readonly FindingFacts[]): {
  readonly items: RepairItem[];
  readonly words: string;
  readonly creditCents: number;
} {
  const asked = findings
    .filter((f) => f.ask !== 'not_asked' && f.clientPriority !== 'skip')
    .sort(
      (a, b) => Number(b.clientPriority === 'must_fix') - Number(a.clientPriority === 'must_fix'),
    );
  const items: RepairItem[] = asked.map((f) => ({
    findingId: f.id,
    title: f.title,
    ask: f.ask as RepairItem['ask'],
    creditCents: f.ask === 'credit' ? (f.creditCents ?? f.estimateCents) : null,
  }));
  const creditCents = items.reduce((n, i) => n + (i.creditCents ?? 0), 0);
  const where = (f: FindingFacts) => (f.location ? ` (${f.location.toLowerCase()})` : '');
  const lines = asked.map((f, i) => {
    const what = `${f.title.charAt(0).toLowerCase()}${f.title.slice(1)}${where(f)}`;
    const item = items[i]!;
    return item.ask === 'credit'
      ? `- A credit of ${money(item.creditCents ?? 0)} at closing for ${what}`
      : `- ${FINDING_ASKS[item.ask]}: ${what}`;
  });
  const words = lines.length
    ? [
        'The buyers ask the seller for the following, done by licensed professionals with receipts:',
        ...lines,
      ].join('\n')
    : '';
  return { items, words, creditCents };
}
