/**
 * A deal's CMAs from a phone's copy (Real Estate round six): the list, as `realestate.cmas` answers it, and one CMA,
 * as `realestate.cma` does (ops/cma.ts), worked out from the rows the phone keeps with the same pure `cma.ts`: each
 * comp's value for the home and why it is or isn't counted, the range, and the summary with the amounts nothing
 * supports.
 * `packages/core/test/addons/realestate-phone-offers.test.ts` holds both to the server's answer.
 *
 * Left to the server: the summary's fair-housing checks (`fairHousing`), which stay off phones, and so whether it can
 * be shared yet (`shareBlocked`), which rests on them. A deal kept as its summary (someone who sees every deal, not on
 * this one) has no CMAs on the phone: null, and they wait for signal.
 *
 * Browser-safe and pure.
 */
import type { z } from 'zod';
import {
  cmaLine,
  cmaPage,
  type CmaCompRow,
  type CmaPage,
  type CmaRow,
  type CmaStatus,
  type CompAdjustment,
  type CompStatus,
} from '../cma';
import type { CmasOutput } from '../schemas';
import { num, record, str } from './columns';
import { holdsWhole, isoOr } from './deal-facts';
import { byText, iso, type CopyRow, type RealestateCopy } from './synced';

export type CmasView = z.infer<typeof CmasOutput>;
export interface CmaView {
  readonly cma: CmaPage;
}

const cmaRowOf = (dealId: string, { id, data: c }: CopyRow): CmaRow => ({
  id,
  dealRecordId: dealId,
  homeId: str(c.home_id),
  number: num(c.number) ?? 0,
  status: (str(c.status) ?? 'draft') as CmaStatus,
  asOf: str(c.as_of) ?? '',
  subjectAddress: str(c.subject_address) ?? '',
  subjectBeds: num(c.subject_beds),
  subjectBaths: num(c.subject_baths),
  subjectSqft: num(c.subject_sqft),
  subjectListPriceCents: num(c.subject_list_price_cents),
  subjectYearBuilt: num(c.subject_year_built),
  lowCents: num(c.low_cents),
  likelyCents: num(c.likely_cents),
  highCents: num(c.high_cents),
  perSqftCents: num(c.per_sqft_cents),
  summary: str(c.summary),
  summaryState: (str(c.summary_state) ?? 'none') as CmaRow['summaryState'],
  summaryFailure: str(c.summary_failure),
  summaryEditedAt: isoOr(c.summary_edited_at),
  compsState: (str(c.comps_state) ?? 'none') as CmaRow['compsState'],
  compsAsked: record(c.comps_asked),
  compsFoundAt: isoOr(c.comps_found_at),
  compsFailure: str(c.comps_failure),
  finalizedAt: isoOr(c.finalized_at),
  sharedAt: isoOr(c.shared_at),
  createdAt: isoOr(c.created_at) ?? iso(0),
});

/** A CMA's comps on the phone, in their order. */
const compsOf = (copy: RealestateCopy, dealId: string, cmaId: string): CmaCompRow[] =>
  copy
    .rows('cma_comps', dealId)
    .filter((r) => r.data.cma_id === cmaId)
    .sort((a, b) => (num(a.data.position) ?? 0) - (num(b.data.position) ?? 0) || byText(a.id, b.id))
    .map(({ id, data: r }) => ({
      id,
      address: str(r.address) ?? '',
      priceCents: num(r.price_cents) ?? 0,
      status: (str(r.status) ?? 'sold') as CompStatus,
      soldOn: str(r.sold_on),
      beds: num(r.beds),
      baths: num(r.baths),
      sqft: num(r.sqft),
      yearBuilt: num(r.year_built),
      distanceMiles: num(r.distance_miles),
      adjustments: (Array.isArray(r.adjustments) ? r.adjustments : []) as CompAdjustment[],
      used: r.used === true,
      note: str(r.note),
      source: (str(r.source) ?? 'agent') as CmaCompRow['source'],
      mlsNumber: str(r.mls_number),
      mls: record(r.mls),
    }));

/** The deal's CMAs, newest first; null when the phone doesn't hold the deal whole. */
export function cmasOfCopy(
  copy: RealestateCopy,
  dealId: string,
  ctx: { readonly userId: string | null },
): CmasView | null {
  if (!holdsWhole(copy, dealId, ctx.userId)) return null;
  const comps = new Map<string, number>();
  for (const { data } of copy.rows('cma_comps', dealId)) {
    const cma = str(data.cma_id) ?? '';
    comps.set(cma, (comps.get(cma) ?? 0) + 1);
  }
  return {
    cmas: copy
      .rows('cmas', dealId)
      .map((r) => cmaRowOf(dealId, r))
      .sort((a, b) => b.number - a.number)
      .map((c) => cmaLine(c, comps.get(c.id) ?? 0)),
  };
}

/** One CMA; null when the phone doesn't hold it. */
export function cmaOfCopy(
  copy: RealestateCopy,
  cmaId: string,
  ctx: { readonly userId: string | null },
): CmaView | null {
  for (const dealId of copy.deals.keys()) {
    const row = copy.rows('cmas', dealId).find((r) => r.id === cmaId);
    if (!row) continue;
    if (!holdsWhole(copy, dealId, ctx.userId)) return null;
    return { cma: cmaPage(cmaRowOf(dealId, row), compsOf(copy, dealId, cmaId)) };
  }
  return null;
}
