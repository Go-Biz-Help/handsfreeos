/**
 * The buyer's side of a deal from a phone's copy (Real Estate round six, step 15): what the buyer wants, as
 * `realestate.buyer_profile.get` answers it; their homes (`realestate.homes`); what's remembered about them
 * (`realestate.memory`); and their saved search's matches (`realestate.matches`). Worked out from the rows the phone
 * keeps, as ops/homes.ts, ops/memory.ts and ops/searches.ts work them out from the database.
 * `packages/core/test/addons/realestate-phone-buyer.test.ts` holds each to the server's answer.
 *
 * Each answers null when the phone doesn't hold the deal. A deal kept as its summary (someone who sees every deal,
 * not on this one) has none of the buyer's rows on the phone: `full` is false, and the profile, homes, memory and
 * matches load with signal. What's remembered still says how many suggestions fair housing left out: the deal's own
 * row keeps that.
 *
 * Left to the server: whether the business's listing feed is connected (`feedConnected`). That's a connector's
 * status, which phones don't keep, so the saved search here leaves it out.
 *
 * Browser-safe and pure.
 */
import type { z } from 'zod';
import { feedAddressWords, mlsOut, mlsStateWords, type MlsSnapshot, type MlsState } from '../feed';
import {
  buyerProfileOut,
  fitProfileOf,
  homeFit,
  type BuyerProfileFields,
  type HomeStatus,
  type ListingFacts,
} from '../homes';
import type { MemoryKind, MemoryStatus } from '../memory';
import type {
  BuyerProfileGetOutput,
  HomesInput,
  HomesOutput,
  MatchesInput,
  MatchesOutput,
  MemoryListInput,
  MemoryListOutput,
} from '../schemas';
import { searchMissing, searchWords } from '../searches';
import { holdsWhole, isoOr } from './deal-facts';
import { byText, iso, ms, text, type CopyRow, type RealestateCopy } from './synced';

export interface BuyerContext {
  readonly userId: string | null;
}

export type BuyerProfileView = z.infer<typeof BuyerProfileGetOutput> & { readonly full: boolean };
export type HomesFilter = Partial<Omit<z.input<typeof HomesInput>, 'workspaceId' | 'dealId'>>;
export type HomesView = z.infer<typeof HomesOutput> & { readonly full: boolean };
type HomeRow = z.infer<typeof HomesOutput>['homes'][number];
export type MemoryFilter = Partial<Omit<z.input<typeof MemoryListInput>, 'workspaceId' | 'dealId'>>;
export type MemoryView = z.infer<typeof MemoryListOutput> & { readonly full: boolean };
type MemoryRow = z.infer<typeof MemoryListOutput>['items'][number];
type Matches = z.infer<typeof MatchesOutput>;
export type MatchesFilter = Partial<Omit<z.input<typeof MatchesInput>, 'workspaceId' | 'dealId'>>;
/** The saved search without whether the feed is connected (the server's), or null until signal on a summary. */
export type MatchesView = Omit<Matches, 'search'> & {
  readonly search: Omit<Matches['search'], 'feedConnected'> | null;
  readonly full: boolean;
};

/** A text column as kept: empty text stays empty, as the server gives it. */
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const member = (copy: RealestateCopy, id: string | null) =>
  id ? { id, fullName: copy.user(id) ?? 'Former member' } : null;
/** A client's name as the buyer's pages give it: their first and last name, else "Client". */
const clientName = (copy: RealestateCopy, personId: string) =>
  copy.personName(personId) ?? 'Client';
const earliest = (at: string) => (a: CopyRow, b: CopyRow) =>
  (ms(a.data[at]) ?? 0) - (ms(b.data[at]) ?? 0) || byText(a.id, b.id);
const latest = (at: string) => (a: CopyRow, b: CopyRow) => earliest(at)(b, a);

/** The deal's buyer profile as kept, with its saved search's columns; null when there isn't one. */
function profileOfCopy(copy: RealestateCopy, dealId: string) {
  const p = copy.rows('buyer_profiles', dealId)[0]?.data;
  if (!p) return null;
  const fields: BuyerProfileFields = {
    budgetMinCents: num(p.budget_min_cents),
    budgetMaxCents: num(p.budget_max_cents),
    areas: strings(p.areas),
    homeTypes: strings(p.home_types),
    bedsMin: num(p.beds_min),
    bathsMin: num(p.baths_min),
    sqftMin: num(p.sqft_min),
    moveBy: str(p.move_by),
    mustHaves: strings(p.must_haves),
    dealBreakers: strings(p.deal_breakers),
    version: num(p.version) ?? 1,
    updatedAt: isoOr(p.updated_at) ?? iso(0),
  };
  return {
    fields,
    updatedBy: text(p.updated_by),
    searchOn: p.search_on === true,
    searchCheckedAt: isoOr(p.search_checked_at),
    searchFailure: str(p.search_failure),
  };
}

/** What the buyer wants, as last saved; null when the phone doesn't hold the deal. */
export function buyerProfileOfCopy(
  copy: RealestateCopy,
  dealId: string,
  ctx: BuyerContext,
): BuyerProfileView | null {
  if (!copy.deals.has(dealId)) return null;
  if (!holdsWhole(copy, dealId, ctx.userId)) return { profile: null, full: false };
  const p = profileOfCopy(copy, dealId);
  return {
    profile: p ? buyerProfileOut(p.fields, member(copy, p.updatedBy)) : null,
    full: true,
  };
}

/** The deal's homes, oldest first: each one's facts, where it stands, how it fits, and what each client said. */
export function homesOfCopy(
  copy: RealestateCopy,
  dealId: string,
  f: HomesFilter,
  ctx: BuyerContext,
): HomesView | null {
  if (!copy.deals.has(dealId)) return null;
  if (!holdsWhole(copy, dealId, ctx.userId)) return { homes: [], full: false };
  const profile = fitProfileOf(profileOfCopy(copy, dealId)?.fields ?? null);
  // As on the server: a reaction shows with its client, oldest first.
  const reactions = copy
    .rows('home_reactions', dealId)
    .filter((r) => copy.person(text(r.data.person_id) ?? '') !== null)
    .sort(earliest('reacted_at'));
  const homes = copy
    .rows('homes', dealId)
    .filter((h) => f.includeRemoved || text(h.data.status) !== 'removed')
    .sort(earliest('created_at'))
    .map(({ id, data: h }): HomeRow => {
      const facts = obj(h.facts) as ListingFacts;
      const address = str(h.address) ?? '';
      const factsState = (text(h.facts_state) ?? 'none') as HomeRow['factsState'];
      const mlsState = (text(h.mls_state) ?? 'none') as MlsState;
      const mls = h.mls && typeof h.mls === 'object' ? (h.mls as MlsSnapshot) : null;
      const { lines, ...counts } = homeFit(profile, facts, address);
      const client = text(h.added_by_person_id);
      return {
        id,
        address,
        source: text(h.source) as HomeRow['source'],
        link: str(h.link),
        status: text(h.status) as HomeStatus,
        statusNote: str(h.status_note),
        facts,
        factSources:
          factsState === 'suggested' ? (obj(h.fact_sources) as Record<string, string>) : {},
        factsState,
        factsFailure: str(h.facts_failure),
        hasPastedText: h.has_pasted_text === true,
        mls: mls ? mlsOut(mls, facts) : null,
        mlsState,
        mlsWords: mlsStateWords(mlsState, str(h.mls_failure)),
        fit: { ...counts, lines: [...lines] },
        reactions: reactions
          .filter((r) => text(r.data.home_id) === id)
          .map(({ data: r }) => {
            const personId = text(r.person_id) ?? '';
            return {
              personId,
              name: clientName(copy, personId),
              reaction: text(r.reaction) as 'saved' | 'passed',
              note: str(r.note),
              at: isoOr(r.reacted_at) ?? iso(0),
            };
          }),
        addedBy: member(copy, text(h.added_by)),
        addedByClient: client ? { id: client, name: clientName(copy, client) } : null,
        addedAt: isoOr(h.created_at) ?? iso(0),
      };
    });
  return { homes, full: true };
}

/** What's remembered about the buyer, newest first, and the AI's suggestions waiting for a person. */
export function memoryOfCopy(
  copy: RealestateCopy,
  dealId: string,
  f: MemoryFilter,
  ctx: BuyerContext,
): MemoryView | null {
  const deal = copy.deals.get(dealId);
  if (!deal) return null;
  const protectedDropped = num(deal.data.memory_protected_dropped) ?? 0;
  if (!holdsWhole(copy, dealId, ctx.userId))
    return { items: [], waiting: 0, protectedDropped, full: false };
  const items = copy
    .rows('memory_items', dealId)
    .filter(
      (i) => f.includeClosed || ['suggested', 'confirmed'].includes(text(i.data.status) ?? ''),
    )
    .sort(latest('created_at'))
    .map(({ id, data: i }): MemoryRow => ({
      id,
      kind: text(i.kind) as MemoryKind,
      words: str(i.words) ?? '',
      quote: str(i.quote),
      sourceKind: text(i.source_kind) as MemoryRow['sourceKind'],
      sourceId: text(i.source_id),
      status: text(i.status) as MemoryStatus,
      suggestedBy: text(i.suggested_by) as MemoryRow['suggestedBy'],
      createdBy: member(copy, text(i.created_by)),
      decidedBy: member(copy, text(i.decided_by)),
      decidedAt: isoOr(i.decided_at),
      createdAt: isoOr(i.created_at) ?? iso(0),
    }));
  return {
    items,
    waiting: items.filter((i) => i.status === 'suggested').length,
    protectedDropped,
    full: true,
  };
}

const ORDER = { new: 0, sent: 1, dismissed: 2 } as const;
type MatchState = keyof typeof ORDER;

/**
 * The buyer's saved search and what it found, new ones first, each with how it fits. Null when the phone doesn't hold
 * the deal, or for a listing (only a buyer has a saved search; the server refuses it).
 */
export function matchesOfCopy(
  copy: RealestateCopy,
  dealId: string,
  f: MatchesFilter,
  ctx: BuyerContext,
): MatchesView | null {
  const deal = copy.deals.get(dealId);
  if (!deal || deal.data.side !== 'buyer') return null;
  if (!holdsWhole(copy, dealId, ctx.userId))
    return { search: null, matches: [], counts: { new: 0, sent: 0, dismissed: 0 }, full: false };
  const p = profileOfCopy(copy, dealId);
  const profile = fitProfileOf(p?.fields ?? null);
  const all = copy.rows('feed_matches', dealId);
  const stateOf = (m: CopyRow) => (text(m.data.state) ?? 'new') as MatchState;
  const matches = all
    .filter((m) => !f.state || stateOf(m) === f.state)
    .sort(latest('found_at'))
    .sort((a, b) => ORDER[stateOf(a)] - ORDER[stateOf(b)])
    .map((m) => {
      const s = m.data.mls as MlsSnapshot;
      const address = feedAddressWords(s.address);
      const mls = mlsOut(s, {});
      const fit = homeFit(profile, mls.facts, address);
      return {
        id: m.id,
        state: stateOf(m),
        address,
        mls,
        fit: { ...fit, lines: [...fit.lines] },
        foundAt: isoOr(m.data.found_at) ?? iso(0),
        changedAt: isoOr(m.data.changed_at),
        homeId: text(m.data.home_id),
        decidedBy: member(copy, text(m.data.decided_by)),
        decidedAt: isoOr(m.data.decided_at),
      };
    });
  return {
    search: {
      on: p?.searchOn ?? false,
      missing: searchMissing(p ? profile : null),
      words: searchWords(profile),
      checkedAt: p?.searchCheckedAt ?? null,
      failure: p?.searchFailure ?? null,
    },
    matches,
    counts: {
      new: all.filter((m) => stateOf(m) === 'new').length,
      sent: all.filter((m) => stateOf(m) === 'sent').length,
      dismissed: all.filter((m) => stateOf(m) === 'dismissed').length,
    },
    full: true,
  };
}
