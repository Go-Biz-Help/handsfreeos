/**
 * Offers in words (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round two: Buyer core"): an offer's terms, its
 * clock, and the one-page summary the client sees in their portal ("This is a plain-words summary. The signed contract
 * is what counts."). Browser-safe and pure: the deal's page, the portal, the phone and the Assistant say the same.
 */
import { fmtDateLong, fmtDateShort, fmtTime, localDayOf } from '../../calendar/when';
import { money } from '../../money/format';

export const LOAN_TYPES = {
  conventional: 'Conventional',
  fha: 'FHA',
  va: 'VA',
  usda: 'USDA',
  cash: 'Cash',
  other: 'Other loan',
} as const;
export type LoanType = keyof typeof LOAN_TYPES;
export const LOAN_TYPE_KEYS = Object.keys(LOAN_TYPES) as [LoanType, ...LoanType[]];

export const OFFER_STATUSES = {
  waiting_them: 'Waiting on the seller',
  waiting_us: 'Waiting on us',
  accepted: 'Accepted',
  declined: 'Declined',
  expired: 'Expired',
  withdrawn: 'Withdrawn',
} as const;
export type OfferStatus = keyof typeof OFFER_STATUSES;
export const OFFER_STATUS_KEYS = Object.keys(OFFER_STATUSES) as [OfferStatus, ...OfferStatus[]];
export const LIVE_OFFER_STATUSES: readonly OfferStatus[] = ['waiting_them', 'waiting_us'];

/** One version's terms, as stored. */
export interface OfferTerms {
  readonly priceCents: number;
  readonly emdCents: number | null;
  readonly emdDays: number | null;
  readonly sellerCreditCents: number;
  readonly inspectionDays: number | null;
  readonly loanType: LoanType | null;
  readonly financingDays: number | null;
  readonly appraisalContingency: boolean | null;
  readonly closingDate: string | null;
  readonly otherTerms: string | null;
}

export interface OfferVersionFacts extends OfferTerms {
  readonly number: number;
  readonly side: 'us' | 'them';
  readonly respondBy: string | null;
}

const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

/** "In 2 h 14 min", "in 3 days", or how long ago it passed: the clock on the offer's page. */
export function clockWords(respondBy: string, now: number): string {
  const ms = Date.parse(respondBy) - now;
  const mins = Math.round(Math.abs(ms) / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const span =
    h >= 48 ? days(Math.round(h / 24)) : h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
  return ms >= 0 ? `${span} left` : `passed ${span} ago`;
}

/** When it's due, as the client reads it: "today at 6:00 PM", "tomorrow at 12:00 PM", "Fri, Oct 2 at 6:00 PM". */
export function dueWords(at: string, timeZone: string, now: number): string {
  const day = localDayOf(at, timeZone);
  const today = localDayOf(now, timeZone);
  const tomorrow = localDayOf(now + 86_400_000, timeZone);
  const time = fmtTime(at, timeZone);
  if (day === today) return `today at ${time}`;
  if (day === tomorrow) return `tomorrow at ${time}`;
  return `${fmtDateShort(day)} at ${time}`;
}

/** Each term as a line of the summary, in the client's words. */
export function termLines(t: OfferTerms): { label: string; value: string }[] {
  const lines = [{ label: 'Price', value: money(t.priceCents) }];
  if (t.emdCents !== null)
    lines.push({
      label: 'Earnest money',
      value:
        t.emdDays !== null ? `${money(t.emdCents)}, within ${days(t.emdDays)}` : money(t.emdCents),
    });
  lines.push({
    label: 'Seller pays toward your costs',
    value: t.sellerCreditCents > 0 ? money(t.sellerCreditCents) : 'Nothing',
  });
  lines.push({
    label: 'Inspections',
    value:
      t.inspectionDays === null || t.inspectionDays === 0
        ? 'No inspection period'
        : `${days(t.inspectionDays)} to inspect and ask`,
  });
  if (t.loanType)
    lines.push({
      label: 'Your loan',
      value:
        t.loanType === 'cash'
          ? 'Paying cash'
          : t.financingDays !== null
            ? `${LOAN_TYPES[t.loanType]}, ${days(t.financingDays)}`
            : LOAN_TYPES[t.loanType],
    });
  if (t.appraisalContingency !== null)
    lines.push({
      label: 'Appraisal',
      value: t.appraisalContingency
        ? 'You can back out if it appraises low'
        : 'No appraisal condition',
    });
  if (t.closingDate) lines.push({ label: 'Closing', value: fmtDateLong(t.closingDate) });
  if (t.otherTerms?.trim()) lines.push({ label: 'Also', value: t.otherTerms.trim() });
  return lines;
}

/** The one-page summary for the client: its title, its terms, and what happens next. */
export interface OfferSummary {
  readonly title: string;
  readonly note: string;
  readonly lines: { label: string; value: string }[];
  readonly next: string;
}

export function offerSummary(
  v: OfferVersionFacts,
  ctx: {
    readonly address: string;
    readonly status: OfferStatus;
    readonly agentFirstName: string;
    readonly timeZone: string;
    readonly now: number;
  },
): OfferSummary {
  const home = ctx.address.split(',')[0]!.trim();
  const title =
    ctx.status === 'accepted'
      ? `Your accepted offer on ${home}`
      : v.side === 'them'
        ? `The seller’s counteroffer on ${home}`
        : v.number === 1
          ? `Your offer on ${home}`
          : `Your counteroffer on ${home}`;
  const due = v.respondBy ? dueWords(v.respondBy, ctx.timeZone, ctx.now) : null;
  const inspections =
    v.inspectionDays && v.inspectionDays > 0
      ? ' If they accept, your inspection days start the next day.'
      : '';
  const next =
    ctx.status === 'accepted'
      ? `It’s accepted. ${ctx.agentFirstName} will walk you through the next dates.`
      : ctx.status === 'waiting_them'
        ? `${due ? `The seller has until ${due} to accept, counter or decline.` : 'The seller will accept, counter or decline.'} ${ctx.agentFirstName} will let you know right away.${inspections}`
        : ctx.status === 'waiting_us'
          ? `${ctx.agentFirstName} will go over it with you${due ? ` and answer by ${due}` : ''}.`
          : 'This offer is no longer open.';
  return {
    title,
    note: 'This is a plain-words summary. The signed contract is what counts.',
    lines: termLines(v),
    next,
  };
}
