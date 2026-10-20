/**
 * Real Estate's rows in Search everything (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, Search 4b): the line under each
 * hit and the chip core has no word for. The server's `realestate.search` (ops/search.ts) writes them, and the phone
 * can say the same with no signal. Browser-safe and pure.
 */
import { money } from '../../money/format';
import { HOME_STATUSES, type HomeStatus } from './homes';
import { RE_DEAL_WORDS } from './phone-words-deals';
import { roomsLine } from './phone-words-buyer';
import { STAGE_LABELS, type DealStage } from './states';

/** The chip on a deal found by its client. Core words the rest ("MLS number", "Address": `whyLabel`). */
export const RE_SEARCH_WORDS = {
  client: 'Client',
} as const;

const stageOf = (stage: string | null): string | null =>
  stage ? (STAGE_LABELS[stage as DealStage] ?? stage) : null;
const line = (parts: readonly (string | null | undefined)[]): string | null =>
  parts.filter(Boolean).join(' · ') || null;

/** "Active · $389,000 · 3 bd · 2 ba": the listing's stage, its list price and its rooms, what's known of them. */
export function listingSearchLine(l: {
  readonly stage: string | null;
  readonly priceCents: number | null;
  readonly beds?: number | null;
  readonly baths?: number | null;
}): string | null {
  return line([
    stageOf(l.stage),
    l.priceCents != null ? money(l.priceCents) : null,
    roomsLine({ beds: l.beds, baths: l.baths }),
  ]);
}

/** "Buyer deal · Touring": the deal's side and stage, as the phone's Deals list says them. */
export function dealSearchLine(side: string | null, stage: string | null): string | null {
  const sides: Readonly<Record<string, string>> = {
    buyer: RE_DEAL_WORDS.buyerDeal,
    listing: RE_DEAL_WORDS.listing,
  };
  return line([side ? (sides[side] ?? null) : null, stageOf(stage)]);
}

/** "Shortlisted · Okafor purchase": where the agent has the home, and the buyer deal it's on. */
export function homeSearchLine(status: string, dealName: string | null): string | null {
  return line([HOME_STATUSES[status as HomeStatus] ?? null, dealName]);
}

/** "2 deals", or "No deals yet": what a property's Real Estate panel lists. */
export function propertySearchLine(deals: number): string {
  if (deals === 0) return 'No deals yet';
  return `${deals.toLocaleString('en-US')} ${deals === 1 ? 'deal' : 'deals'}`;
}
