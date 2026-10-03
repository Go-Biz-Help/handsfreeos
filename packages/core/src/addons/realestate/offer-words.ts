/**
 * Offers in words (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round two: Buyer core"): an offer's terms, its
 * clock, and the one-page summary the client sees in their portal ("This is a plain-words summary. The signed contract
 * is what counts."). Browser-safe and pure: the deal's page, the portal, the phone and the Assistant say the same.
 */
import type { z } from 'zod';
import { fmtAt, fmtDateLong, fmtDateShort, fmtTime, localDayOf } from '../../calendar/when';
import { money } from '../../money/format';
import { netEstimate, type NetFigures } from './net';
import type { CompareRowOut, OfferOut } from './schemas';

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

/** On a listing it's the other way round: "them" are the buyers and "us" the seller and their agent. */
export const LISTING_OFFER_STATUSES: Readonly<Record<OfferStatus, string>> = {
  waiting_them: 'Waiting on the buyers',
  waiting_us: 'Waiting on our answer',
  accepted: 'Accepted',
  declined: 'Declined',
  expired: 'Expired',
  withdrawn: 'Withdrawn by the buyers',
};

/** An offer's status in words, for the side the deal is on. */
export const offerStatusWords = (status: OfferStatus, side: 'buyer' | 'listing'): string =>
  side === 'listing' ? LISTING_OFFER_STATUSES[status] : OFFER_STATUSES[status];

/**
 * The rows of a listing's offers side by side, in order, as the agent's page and the seller's portal label them.
 * The last is the seller's estimate, and says so.
 */
export const COMPARE_LABELS = {
  priceCents: 'Price',
  paying: 'Paying',
  emdCents: 'Earnest money',
  sellerCreditCents: 'Seller credit',
  buyerAgentFee: 'Their agent’s fee',
  inspection: 'Inspection',
  financing: 'Financing',
  homeSale: 'Home to sell first',
  escalation: 'Escalation',
  closingDate: 'Closing',
  possession: 'Possession',
  respondBy: 'Answer by',
  net: 'You’d take home (estimate)',
} as const;

/** What the seller is told beside the estimate, every time. */
export const NET_NOTE =
  'An estimate from the figures your agent entered, not a settlement statement. Your closing statement is what counts.';

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

// ---------- an offer as the offers page shows it ----------

/** An offer's row, as the server reads it and a phone keeps it (times as a `Date` or ISO text). */
export interface OfferRow {
  readonly id: string;
  readonly number: number;
  readonly homeId: string | null;
  readonly buyerNames: string | null;
  readonly status: OfferStatus;
  readonly theirAgentName: string | null;
  readonly theirBrokerage: string | null;
  readonly theirEmail: string | null;
  readonly theirPhone: string | null;
  readonly acceptedVersionId: string | null;
  readonly endedAt: Date | string | null;
  readonly endedReason: string | null;
  readonly sharedVersionId: string | null;
  readonly sharedAt: Date | string | null;
}

/** A version's row: its terms as sent. */
export interface OfferVersionRow {
  readonly id: string;
  readonly offerId: string;
  readonly number: number;
  readonly side: 'us' | 'them';
  readonly at: Date | string;
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
  /** Numeric: text from the server, a number on the phone. */
  readonly downPaymentPct: string | number | null;
  readonly homeSaleContingency: boolean | null;
  readonly escalationCapCents: number | null;
  readonly escalationStepCents: number | null;
  readonly possession: string | null;
  readonly buyerAgentFeeBp: number | null;
  readonly buyerAgentFeeCents: number | null;
  readonly respondBy: Date | string | null;
  readonly note: string | null;
}

/** One of the deal's documents, as far as a version is one. */
export interface OfferDocumentRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly lineageId: string;
  readonly version: number;
  readonly offerVersionId: string | null;
}

const isLive = (s: OfferStatus) => LIVE_OFFER_STATUSES.includes(s);
const isoOr = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());

/** The deal's main agent's first name, as the client's summary says it. */
export const agentFirstNameOf = (name: string | null): string =>
  (name ?? 'Your agent').split(/\s+/)[0]!;

/** The version that counts: the one accepted, else the newest. `versions` by number. */
function versionThatCounts(o: OfferRow, versions: readonly OfferVersionRow[]): OfferVersionRow {
  const newest = versions.at(-1)!;
  return o.status === 'accepted'
    ? (versions.find((v) => v.id === o.acceptedVersionId) ?? newest)
    : newest;
}

/**
 * An offer as the offers page shows it: every version with the document it is as that stands now (the newest version
 * of what was attached), who answers next and by when, and the one-page summary the client would see. `versions` are
 * the offer's, by number; `documents` the deal's, oldest first.
 */
export function offerOut(
  o: OfferRow,
  address: string,
  versions: readonly OfferVersionRow[],
  documents: readonly OfferDocumentRow[],
  ctx: { readonly agentFirstName: string; readonly timeZone: string; readonly now: number },
): z.infer<typeof OfferOut> {
  const documentOf = (versionId: string) => {
    const attached = documents.filter((d) => d.offerVersionId === versionId);
    if (!attached.length) return null;
    const lineage = attached[0]!.lineageId;
    const newest = documents
      .filter((d) => d.lineageId === lineage && d.status !== 'void')
      .sort((a, b) => b.version - a.version)[0];
    const d = newest ?? attached[0]!;
    return { id: d.id, title: d.title, status: d.status, signed: d.status === 'signed' };
  };
  const newest = versions.at(-1)!;
  const shown = versionThatCounts(o, versions);
  const respondBy = isoOr(newest.respondBy);
  return {
    id: o.id,
    number: o.number,
    homeId: o.homeId,
    buyerNames: o.buyerNames,
    address,
    status: o.status,
    theirAgentName: o.theirAgentName,
    theirBrokerage: o.theirBrokerage,
    theirEmail: o.theirEmail,
    theirPhone: o.theirPhone,
    versions: versions.map((v) => ({
      id: v.id,
      number: v.number,
      side: v.side,
      at: new Date(v.at).toISOString(),
      priceCents: v.priceCents,
      emdCents: v.emdCents,
      emdDays: v.emdDays,
      sellerCreditCents: v.sellerCreditCents,
      inspectionDays: v.inspectionDays,
      loanType: v.loanType,
      financingDays: v.financingDays,
      appraisalContingency: v.appraisalContingency,
      closingDate: v.closingDate,
      otherTerms: v.otherTerms,
      downPaymentPct: v.downPaymentPct === null ? null : Number(v.downPaymentPct),
      homeSaleContingency: v.homeSaleContingency,
      escalationCapCents: v.escalationCapCents,
      escalationStepCents: v.escalationStepCents,
      possession: v.possession,
      buyerAgentFeeBp: v.buyerAgentFeeBp,
      buyerAgentFeeCents: v.buyerAgentFeeCents,
      respondBy: isoOr(v.respondBy),
      note: v.note,
      document: documentOf(v.id),
    })),
    acceptedVersionId: o.acceptedVersionId,
    endedAt: isoOr(o.endedAt),
    endedReason: o.endedReason,
    clock: isLive(o.status)
      ? {
          waitingOn: o.status === 'waiting_them' ? ('them' as const) : ('us' as const),
          respondBy,
          words: respondBy
            ? `Due ${fmtAt(respondBy, ctx.timeZone)} · ${clockWords(respondBy, ctx.now)}`
            : null,
        }
      : null,
    shared:
      o.sharedVersionId && o.sharedAt
        ? {
            versionId: o.sharedVersionId,
            at: new Date(o.sharedAt).toISOString(),
            current: o.sharedVersionId === shown.id,
          }
        : null,
    summary: offerSummary(
      {
        number: shown.number,
        side: shown.side,
        respondBy: isoOr(shown.respondBy),
        priceCents: shown.priceCents,
        emdCents: shown.emdCents,
        emdDays: shown.emdDays,
        sellerCreditCents: shown.sellerCreditCents,
        inspectionDays: shown.inspectionDays,
        loanType: shown.loanType,
        financingDays: shown.financingDays,
        appraisalContingency: shown.appraisalContingency,
        closingDate: shown.closingDate,
        otherTerms: shown.otherTerms,
      },
      {
        address,
        status: o.status,
        agentFirstName: ctx.agentFirstName,
        timeZone: ctx.timeZone,
        now: ctx.now,
      },
    ),
  };
}

// ---------- a listing's offers side by side ----------

const pct = (n: number) => `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;

/** How the buyer pays, in words: "Cash", "Conventional · 20% down". */
export function payingWords(v: Pick<OfferVersionRow, 'loanType' | 'downPaymentPct'>): string {
  if (!v.loanType) return 'Not said';
  const down = v.downPaymentPct === null ? null : Number(v.downPaymentPct);
  return v.loanType === 'cash' || down === null
    ? LOAN_TYPES[v.loanType]
    : `${LOAN_TYPES[v.loanType]} · ${pct(down)} down`;
}

/**
 * Each open or accepted offer's version that counts, side by side, with the seller's estimate for it from the figures:
 * the most they'd take home first, the best flagged when there's more than one.
 */
export function compareRows(
  offers: readonly OfferRow[],
  versions: readonly OfferVersionRow[],
  f: NetFigures,
): CompareRowOut[] {
  const list = offers.filter((o) => isLive(o.status) || o.status === 'accepted');
  if (!list.length) return [];
  const rows = list.map((o) => {
    const v = versionThatCounts(
      o,
      versions.filter((x) => x.offerId === o.id).sort((a, b) => a.number - b.number),
    );
    const net = netEstimate(
      {
        priceCents: v.priceCents,
        sellerCreditCents: v.sellerCreditCents,
        buyerAgentFeeBp: v.buyerAgentFeeBp,
        buyerAgentFeeCents: v.buyerAgentFeeCents,
      },
      f,
    );
    return {
      offerId: o.id,
      number: o.number,
      buyers: o.buyerNames,
      agent: o.theirAgentName,
      brokerage: o.theirBrokerage,
      status: o.status,
      versionId: v.id,
      versionNumber: v.number,
      priceCents: v.priceCents,
      paying: payingWords(v),
      emdCents: v.emdCents,
      sellerCreditCents: v.sellerCreditCents,
      buyerAgentFee:
        v.buyerAgentFeeBp !== null
          ? `${pct(v.buyerAgentFeeBp / 100)} · ${money(Math.round((v.priceCents * v.buyerAgentFeeBp) / 10_000))}`
          : v.buyerAgentFeeCents !== null
            ? money(v.buyerAgentFeeCents)
            : null,
      inspection: v.inspectionDays !== null ? `${v.inspectionDays} days` : null,
      financing:
        v.loanType === 'cash'
          ? null
          : [
              v.financingDays !== null ? `${v.financingDays} days` : null,
              v.appraisalContingency ? 'appraisal contingency' : null,
            ]
              .filter(Boolean)
              .join(' · ') || null,
      homeSale: v.homeSaleContingency,
      escalation:
        v.escalationCapCents !== null
          ? `Up to ${money(v.escalationCapCents)}${v.escalationStepCents ? `, by ${money(v.escalationStepCents)}` : ''}`
          : null,
      closingDate: v.closingDate,
      possession: v.possession,
      respondBy: isoOr(v.respondBy),
      net,
      best: false,
    };
  });
  const top = Math.max(...rows.map((r) => r.net.netCents));
  return rows
    .map((r) => ({ ...r, best: rows.length > 1 && r.net.netCents === top }))
    .sort((a, b) => b.net.netCents - a.net.netCents || a.number - b.number);
}
