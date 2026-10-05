/**
 * The CMA (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round two: Buyer core"): what a home is worth next to
 * homes sold nearby. Chris decided (2026-09-30): the agent adds the comps, HandsFreeOS works out the range, and the
 * AI drafts the summary for the agent to check. Browser-safe and pure: the commands, the screens, the portal, the phone
 * and the Assistant all read the same numbers, and the server and the phone build a CMA's page the same way.
 *
 * Method 1, "adjusted price per square foot, recent sales weighted more":
 *
 * - Each sold comp the agent uses, with its square feet, gives a price per square foot after the agent's own
 *   adjustments ("Newer roof +$5,000"), and so a value for the home at its own size.
 * - Each counts less the longer ago it sold: half as much every six months.
 * - Likely is the weighted average of those values; low and high are the lowest and highest. Low rounds down, high
 *   up and likely to the nearest $1,000.
 * - A comp still for sale or pending is shown for context and never counted.
 */
import type { z } from 'zod';
import { money } from '../../money/format';
import { compsStateWords, mlsSourceWords, type MlsSnapshot } from './feed';
import type { CmaOut, CmasOutput } from './schemas';

export const CMA_METHOD = 1;
export const CMA_METHOD_WORDS = 'Adjusted price per square foot, recent sales weighted more.';

/** How far back a sale counts half as much. */
export const HALF_WEIGHT_DAYS = 180;
/** The most comps on one CMA. */
export const MAX_COMPS = 20;

export const COMP_STATUSES = { sold: 'Sold', pending: 'Pending', active: 'For sale' } as const;
export type CompStatus = keyof typeof COMP_STATUSES;
export const COMP_STATUS_KEYS = Object.keys(COMP_STATUSES) as [CompStatus, ...CompStatus[]];

export const CMA_STATUSES = { draft: 'Draft', final: 'Final', shared: 'Shared' } as const;
export type CmaStatus = keyof typeof CMA_STATUSES;
export const CMA_STATUS_KEYS = Object.keys(CMA_STATUSES) as [CmaStatus, ...CmaStatus[]];

/** The home the CMA is for. */
export interface CmaSubject {
  readonly beds: number | null;
  readonly baths: number | null;
  readonly sqft: number | null;
  readonly listPriceCents: number | null;
  readonly yearBuilt: number | null;
}

/** One adjustment the agent made to a comp, with its reason: "+$5,000 Newer roof". Cents, signed. */
export interface CompAdjustment {
  readonly label: string;
  readonly cents: number;
}

export interface CmaComp {
  readonly id: string;
  readonly address: string;
  readonly priceCents: number;
  readonly status: CompStatus;
  readonly soldOn: string | null;
  readonly beds: number | null;
  readonly baths: number | null;
  readonly sqft: number | null;
  readonly distanceMiles: number | null;
  readonly adjustments: readonly CompAdjustment[];
  readonly used: boolean;
}

/** What a comp says about the home. */
export interface CompValue {
  readonly id: string;
  /** Its value for the home, at the home's size and after the agent's adjustments; null when it can't say. */
  readonly valueCents: number | null;
  /** The value less its price: what the comp was adjusted by. */
  readonly adjustmentCents: number | null;
  /** How much it counts next to the others (1 for a sale today). */
  readonly weight: number;
  readonly counted: boolean;
  /** Why it isn't counted, when it isn't. */
  readonly why: string | null;
  /** Things to look at: an old sale, a far one, a much bigger or smaller home. */
  readonly warnings: readonly string[];
}

export interface CmaRange {
  readonly lowCents: number;
  readonly likelyCents: number;
  readonly highCents: number;
  /** The weighted price per square foot it rests on, in cents. */
  readonly perSqftCents: number;
  /** How many comps it counts. */
  readonly counted: number;
}

export interface CmaResult {
  readonly comps: readonly CompValue[];
  readonly range: CmaRange | null;
  /** Why there's no range yet, and what to do. */
  readonly missing: string | null;
}

const DAY = 86_400_000;
const THOUSAND = 100_000;
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY);

/** The comps' values for the home, and the range they give, as of a date. */
export function cmaValues(subject: CmaSubject, comps: readonly CmaComp[], asOf: string): CmaResult {
  const size = subject.sqft && subject.sqft > 0 ? subject.sqft : null;
  const out: CompValue[] = comps.map((c) => {
    const warnings: string[] = [];
    if (c.soldOn && daysBetween(c.soldOn, asOf) > 365) warnings.push('Sold over a year ago');
    if (c.distanceMiles !== null && c.distanceMiles > 1) warnings.push('Over a mile away');
    if (size && c.sqft && c.sqft > size * 1.25) warnings.push('Much bigger');
    if (size && c.sqft && c.sqft < size * 0.75) warnings.push('Much smaller');
    const adjusted = c.priceCents + c.adjustments.reduce((n, a) => n + a.cents, 0);
    const valueCents = size && c.sqft && c.sqft > 0 ? Math.round((adjusted / c.sqft) * size) : null;
    const weight =
      c.status === 'sold' && c.soldOn
        ? 0.5 ** (Math.max(0, daysBetween(c.soldOn, asOf)) / HALF_WEIGHT_DAYS)
        : 0;
    const why = !c.used
      ? 'Left out'
      : c.status !== 'sold'
        ? `${COMP_STATUSES[c.status]}: shown for context, not counted`
        : !c.soldOn
          ? 'Add the date it sold to count it'
          : !c.sqft
            ? 'Add its square feet to count it'
            : !size
              ? 'Add the home’s square feet to count it'
              : null;
    return {
      id: c.id,
      valueCents,
      adjustmentCents: valueCents === null ? null : valueCents - c.priceCents,
      weight,
      counted: why === null,
      why,
      warnings,
    };
  });
  const counted = out
    .map((v, i) => ({ v, c: comps[i]! }))
    .filter((x) => x.v.counted && x.v.valueCents !== null);
  if (!size)
    return { comps: out, range: null, missing: 'Add the home’s square feet to work out a range.' };
  if (!counted.length)
    return {
      comps: out,
      range: null,
      missing: 'Add a sold comp with its price, date and square feet to work out a range.',
    };
  const total = counted.reduce((n, x) => n + x.v.weight, 0);
  const likely = counted.reduce((n, x) => n + x.v.valueCents! * x.v.weight, 0) / total;
  const values = counted.map((x) => x.v.valueCents!);
  const perSqft =
    counted.reduce(
      (n, x) =>
        n +
        ((x.c.priceCents + x.c.adjustments.reduce((m, a) => m + a.cents, 0)) / x.c.sqft!) *
          x.v.weight,
      0,
    ) / total;
  const low = Math.floor(Math.min(...values) / THOUSAND) * THOUSAND;
  const high = Math.ceil(Math.max(...values) / THOUSAND) * THOUSAND;
  const mid = Math.min(high, Math.max(low, Math.round(likely / THOUSAND) * THOUSAND));
  return {
    comps: out,
    range: {
      lowCents: low,
      likelyCents: mid,
      highCents: high,
      perSqftCents: Math.round(perSqft),
      counted: counted.length,
    },
    missing: null,
  };
}

/** "$401,000 to $414,000, most likely $406,000". */
export const rangeWords = (r: Pick<CmaRange, 'lowCents' | 'likelyCents' | 'highCents'>): string =>
  `${money(r.lowCents)} to ${money(r.highCents)}, most likely ${money(r.likelyCents)}`;

/** An adjustment as it reads: "+$4,100", "−$6,300". */
/** An amount the CMA worked out, to the nearest $100: "$416,000", not "$416,023.26". */
export const roundedMoney = (cents: number): string => money(Math.round(cents / 10_000) * 10_000);

export const adjustmentWords = (cents: number): string =>
  Math.abs(cents) < 5_000 ? '$0' : `${cents > 0 ? '+' : '−'}${roundedMoney(Math.abs(cents))}`;

const AMOUNT = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?\s?(k|K)?\b/g;

/**
 * Dollar amounts in a summary that nothing in the CMA supports: not within $1,000 of a price, a value, an
 * adjustment or the range's ends, nor inside the range. The agent is asked to check them before it's shared.
 */
export function unsupportedAmounts(
  text: string,
  figures: readonly number[],
  range: Pick<CmaRange, 'lowCents' | 'highCents'> | null,
): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(AMOUNT)) {
    const whole = Number(m[1]!.replace(/,/g, ''));
    const cents = (m[3] ? whole * 1000 : whole) * 100 + (m[2] ? Number(m[2]) : 0);
    const near = figures.some((f) => Math.abs(Math.abs(f) - cents) <= THOUSAND);
    const inside =
      range !== null && cents >= range.lowCents - THOUSAND && cents <= range.highCents + THOUSAND;
    if (!near && !inside && !out.includes(m[0].trim())) out.push(m[0].trim());
  }
  return out;
}

// ---------- a CMA as its pages show it ----------

/** A numeric column: text from the server, a number on the phone. */
const num = (v: string | number | null): number | null => (v === null ? null : Number(v));

/** A CMA's row, as the server reads it and a phone keeps it (times as a `Date` or ISO text). */
export interface CmaRow {
  readonly id: string;
  readonly dealRecordId: string;
  readonly homeId: string | null;
  readonly number: number;
  readonly status: CmaStatus;
  readonly asOf: string;
  readonly subjectAddress: string;
  readonly subjectBeds: number | null;
  readonly subjectBaths: string | number | null;
  readonly subjectSqft: number | null;
  readonly subjectListPriceCents: number | null;
  readonly subjectYearBuilt: number | null;
  readonly lowCents: number | null;
  readonly likelyCents: number | null;
  readonly highCents: number | null;
  readonly perSqftCents: number | null;
  readonly summary: string | null;
  readonly summaryState: 'none' | 'drafting' | 'ready' | 'failed';
  readonly summaryFailure: string | null;
  readonly summaryEditedAt: Date | string | null;
  readonly compsState: 'none' | 'finding' | 'found' | 'none_found' | 'failed';
  readonly compsAsked: Readonly<Record<string, unknown>> | null;
  readonly compsFoundAt: Date | string | null;
  readonly compsFailure: string | null;
  readonly finalizedAt: Date | string | null;
  readonly sharedAt: Date | string | null;
  readonly createdAt: Date | string;
}

/** A comp's row, as the server reads it and a phone keeps it (numeric columns as text or numbers). */
export interface CmaCompRow {
  readonly id: string;
  readonly address: string;
  readonly priceCents: number;
  readonly status: CompStatus;
  readonly soldOn: string | null;
  readonly beds: number | null;
  readonly baths: string | number | null;
  readonly sqft: number | null;
  readonly yearBuilt: number | null;
  readonly distanceMiles: string | number | null;
  readonly adjustments: readonly CompAdjustment[];
  readonly used: boolean;
  readonly note: string | null;
  readonly source: 'agent' | 'mls';
  readonly mlsNumber: string | null;
  readonly mls: Readonly<Record<string, unknown>> | null;
}

/** The home a CMA is for, from its row. */
export const cmaSubjectOf = (c: CmaRow): CmaSubject => ({
  beds: c.subjectBeds,
  baths: num(c.subjectBaths),
  sqft: c.subjectSqft,
  listPriceCents: c.subjectListPriceCents,
  yearBuilt: c.subjectYearBuilt,
});

/** A comp as the range reads it, from its row. */
export const cmaCompOf = (r: CmaCompRow): CmaComp => ({
  id: r.id,
  address: r.address,
  priceCents: r.priceCents,
  status: r.status,
  soldOn: r.soldOn,
  beds: r.beds,
  baths: num(r.baths),
  sqft: r.sqft,
  distanceMiles: num(r.distanceMiles),
  adjustments: r.adjustments,
  used: r.used,
});

/** A comp from the feed as the screens show it: its number, first photo and its MLS's lines. */
const compMls = (mlsNumber: string, s: MlsSnapshot) => ({
  mlsNumber,
  sourceWords: mlsSourceWords(s),
  photoUrl: s.photos?.[0]?.url ?? null,
  courtesy: s.display?.courtesy ?? null,
  notice: s.display?.notice ?? null,
});

/**
 * A CMA as its page shows it, but for its fair-housing checks and whether it can be shared yet, which rest on those
 * checks: the server adds them. Its comps in their order.
 */
export type CmaPage = Omit<z.infer<typeof CmaOut>, 'fairHousing' | 'shareBlocked'>;

export function cmaPage(cma: CmaRow, rows: readonly CmaCompRow[]): CmaPage {
  const subject = cmaSubjectOf(cma);
  const result = cmaValues(subject, rows.map(cmaCompOf), cma.asOf);
  const range =
    cma.status === 'draft'
      ? result.range
      : {
          lowCents: cma.lowCents!,
          likelyCents: cma.likelyCents!,
          highCents: cma.highCents!,
          perSqftCents: cma.perSqftCents ?? result.range?.perSqftCents ?? 0,
          counted: result.range?.counted ?? 0,
        };
  const figures = [
    ...(subject.listPriceCents ? [subject.listPriceCents] : []),
    ...rows.map((r) => r.priceCents),
    ...result.comps.flatMap((v) => [v.valueCents ?? 0, v.adjustmentCents ?? 0]),
    ...rows.flatMap((r) => r.adjustments.map((a) => a.cents)),
    ...(range ? [range.lowCents, range.likelyCents, range.highCents, range.perSqftCents] : []),
  ];
  return {
    id: cma.id,
    dealId: cma.dealRecordId,
    homeId: cma.homeId,
    number: cma.number,
    status: cma.status,
    asOf: cma.asOf,
    method: CMA_METHOD_WORDS,
    subject: { address: cma.subjectAddress, ...subject },
    comps: rows.map((r, i) => {
      const v = result.comps[i]!;
      return {
        id: r.id,
        address: r.address,
        priceCents: r.priceCents,
        status: r.status,
        soldOn: r.soldOn,
        beds: r.beds,
        baths: num(r.baths),
        sqft: r.sqft,
        yearBuilt: r.yearBuilt,
        distanceMiles: num(r.distanceMiles),
        adjustments: [...r.adjustments],
        used: r.used,
        note: r.note,
        source: r.source,
        mls: r.mls && r.mlsNumber ? compMls(r.mlsNumber, r.mls as unknown as MlsSnapshot) : null,
        valueCents: v.valueCents,
        adjustmentCents: v.adjustmentCents,
        weight: Math.round(v.weight * 1000) / 1000,
        counted: v.counted,
        why: v.why,
        warnings: [...v.warnings],
      };
    }),
    range,
    missing: range ? null : result.missing,
    summary: {
      state: cma.summaryState,
      text: cma.summary,
      failure: cma.summaryFailure,
      byAi: cma.summaryState === 'ready' && cma.summaryEditedAt === null,
      unsupportedAmounts: cma.summary ? unsupportedAmounts(cma.summary, figures, range) : [],
    },
    findComps: {
      state: cma.compsState,
      words: compsStateWords(cma.compsState, cma.compsFailure),
      asked: cma.compsAsked
        ? {
            miles: Number(cma.compsAsked['miles'] ?? 1),
            months: Number(cma.compsAsked['months'] ?? 6),
          }
        : null,
      at: cma.compsFoundAt ? new Date(cma.compsFoundAt).toISOString() : null,
    },
    finalizedAt: cma.finalizedAt ? new Date(cma.finalizedAt).toISOString() : null,
    sharedAt: cma.sharedAt ? new Date(cma.sharedAt).toISOString() : null,
    createdAt: new Date(cma.createdAt).toISOString(),
  };
}

export type CmaLine = z.infer<typeof CmasOutput>['cmas'][number];

/** A CMA as the deal's list shows it, with how many comps it has. A draft's range is what its comps give now. */
export function cmaLine(c: CmaRow, comps: number): CmaLine {
  const range =
    c.status === 'draft'
      ? null
      : { lowCents: c.lowCents, likelyCents: c.likelyCents, highCents: c.highCents };
  return {
    id: c.id,
    number: c.number,
    subjectAddress: c.subjectAddress,
    status: c.status,
    likelyCents: range?.likelyCents ?? null,
    lowCents: range?.lowCents ?? null,
    highCents: range?.highCents ?? null,
    comps,
    createdAt: new Date(c.createdAt).toISOString(),
  };
}
