/**
 * Listing data from the business's feed (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, round five, step 4): a
 * buyer's home and our own listing looked up on the MLS, and sold homes nearby for a CMA. The worker asks the feed
 * (it holds the keys); these commands say what's asked and keep what it found.
 *
 * Chris decided (2026-10-02): a feed is a source of facts, never of authority.
 * - **A home's facts.** What the feed says is kept as it said it (with its supplier, MLS and time) and fills only
 *   the facts that are still empty, as suggestions for the agent to confirm. Where it disagrees with what a person
 *   confirmed, both are shown and a person picks; nothing confirmed is overwritten.
 * - **Our listing.** The MLS is one more source beside the seller's questionnaire and the old listing's words.
 * - **A CMA's comps.** Sold homes near the home come in as comps from the MLS that don't count until the agent
 *   ticks them.
 */
import { and, eq } from 'drizzle-orm';
import { HfosError } from '../../../errors';
import type { CommandContext } from '../../../kernel/types';
import { defineAddonCommand } from '../../server';
import { MAX_COMPS } from '../cma';
import {
  feedAddressWords,
  feedFacts,
  listingFeedDiffers,
  mlsSourceWords,
  type MlsSnapshot,
} from '../feed';
import { addressKey, LISTING_FACT_KEYS, type ListingFactKey } from '../homes';
import { realestateAddon } from '../manifest';
import {
  CmaCompsFoundInput,
  CmaCompsFoundOutput,
  CmaFindCompsInput,
  CmaFindCompsOutput,
  HomeLookupInput,
  HomeLookupOutput,
  ListingFeedStatusInput,
  ListingFeedStatusOutput,
  ListingLookupInput,
  ListingLookupOutput,
  MlsFoundInput,
  MlsFoundOutput,
} from '../schemas';
import { cmaComps, cmas, homes, listings } from '../tables';
import { compsOf, loadCma, requireDraft } from './cma';
import {
  feedConnected,
  inWorkspace,
  loadDeal,
  requireNotArchived,
  timeZoneOf,
  todayIn,
} from './common';
import { loadHome } from './homes';
import { ensureListing, listingAddress, listingOf, listPriceOf } from './listing';
import { markListingLive } from './marketing';
import { PROOF_EVENTS } from './proof-hooks';

/** Asked of a person with nothing connected. */
export const noFeed = () =>
  HfosError.rule(
    'realestate_no_feed',
    409,
    'No listing feed is connected. Someone who runs the deal settings can connect one under Real Estate → Settings → Connections.',
  );

/** The words a failure to look something up is kept with. */
const failureWords = (failure: string) => failure.slice(0, 500);

// ---------- a buyer's home ----------

/** Puts a home in "looking it up" and asks the worker. */
export async function askHomeLookup(
  ctx: CommandContext,
  home: { id: string; dealRecordId: string },
  mlsNumber: string | null,
): Promise<void> {
  await ctx.tx
    .update(homes)
    .set({ mlsState: 'looking', mlsFailure: null })
    .where(eq(homes.id, home.id));
  await ctx.emit({
    type: 'realestate.home.lookup_requested',
    entityType: 'realestate_deal',
    entityId: home.dealRecordId,
    payload: { homeId: home.id, mlsNumber },
  });
}

export const homeLookup = defineAddonCommand(realestateAddon, {
  name: 'realestate.home.lookup',
  description:
    'Look a buyer’s home up on the business’s listing feed again, by its address or an MLS number: its facts, photos and where it stands on the MLS, for the agent to check.',
  risk: 0,
  input: HomeLookupInput,
  output: HomeLookupOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_look_up_home',
    description: 'Look a buyer’s home up on the MLS for its facts, photos and status.',
  },
  emits: ['realestate.home.lookup_requested'],
  async handler(ctx, input) {
    const home = await loadHome(ctx, input.homeId, { lock: true });
    const deal = await loadDeal(ctx, home.dealRecordId);
    requireNotArchived(deal);
    if (!(await feedConnected(ctx))) throw noFeed();
    await askHomeLookup(ctx, home, input.mlsNumber ?? null);
    return { homeId: home.id, looking: true as const };
  },
});

/** The facts the feed fills in: only those still empty, with where each came from. */
function fillEmpty(
  facts: Record<string, unknown>,
  sources: Record<string, string>,
  snapshot: MlsSnapshot,
): { facts: Record<string, unknown>; sources: Record<string, string>; filled: ListingFactKey[] } {
  const from = feedFacts(snapshot) as Record<string, unknown>;
  const words = mlsSourceWords(snapshot);
  const filled: ListingFactKey[] = [];
  const next = { ...facts };
  const nextSources = { ...sources };
  for (const key of LISTING_FACT_KEYS) {
    const value = from[key];
    if (value === undefined || value === null) continue;
    if (next[key] !== undefined && next[key] !== null) continue;
    next[key] = value;
    nextSources[key] = words;
    filled.push(key);
  }
  return { facts: next, sources: nextSources, filled };
}

export const homeMlsFound = defineAddonCommand(realestateAddon, {
  name: 'realestate.home.mls_found',
  description:
    'Worker: what the listing feed found for a buyer’s home (kept as it said it, filling only empty facts for the agent to confirm), that it isn’t there, or why it couldn’t look.',
  risk: 0,
  input: MlsFoundInput,
  output: MlsFoundOutput,
  permission: 'realestate.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['realestate.home.mls_found'],
  async handler(ctx, input) {
    if (!input.homeId) throw HfosError.validation([{ path: 'homeId', message: 'Which home.' }]);
    const home = await loadHome(ctx, input.homeId, { lock: true });
    if (home.mlsState !== 'looking') return { state: 'skipped' as const, filled: [] };
    const at = new Date();
    let state: 'none' | 'found' | 'not_found' | 'failed';
    let filled: ListingFactKey[] = [];
    if (input.noFeed) {
      state = 'none';
      await ctx.tx.update(homes).set({ mlsState: 'none' }).where(eq(homes.id, home.id));
    } else if (input.failure) {
      state = 'failed';
      await ctx.tx
        .update(homes)
        .set({ mlsState: 'failed', mlsFailure: failureWords(input.failure), mlsCheckedAt: at })
        .where(eq(homes.id, home.id));
    } else if (!input.listing) {
      state = 'not_found';
      await ctx.tx
        .update(homes)
        .set({ mlsState: 'not_found', mlsFailure: null, mlsCheckedAt: at })
        .where(eq(homes.id, home.id));
    } else {
      state = 'found';
      // A person's confirmed facts, and the AI's reading still under way, are left as they are.
      const fill =
        home.factsState === 'none' ||
        home.factsState === 'failed' ||
        home.factsState === 'suggested'
          ? fillEmpty(
              home.factsState === 'suggested' ? home.facts : {},
              home.factsState === 'suggested' ? home.factSources : {},
              input.listing,
            )
          : null;
      filled = fill?.filled ?? [];
      await ctx.tx
        .update(homes)
        .set({
          mls: input.listing as unknown as Record<string, unknown>,
          mlsState: 'found',
          mlsFailure: null,
          mlsCheckedAt: at,
          ...(fill && fill.filled.length
            ? {
                facts: fill.facts,
                factSources: fill.sources,
                factsState: 'suggested' as const,
                factsFailure: null,
              }
            : {}),
        })
        .where(eq(homes.id, home.id));
    }
    await ctx.emit({
      type: 'realestate.home.mls_found',
      entityType: 'realestate_deal',
      entityId: home.dealRecordId,
      payload: {
        homeId: home.id,
        state,
        filled,
        ...(input.listing
          ? { mlsNumber: input.listing.mlsNumber, status: input.listing.status }
          : {}),
      },
    });
    return { state, filled };
  },
});

// ---------- our own listing ----------

export const listingLookup = defineAddonCommand(realestateAddon, {
  name: 'realestate.listing.lookup',
  description:
    'Look the deal’s own listing up on the business’s listing feed, by its MLS number or address: what the MLS says of its facts, beside the seller’s and the old listing’s, and where it stands there.',
  risk: 0,
  input: ListingLookupInput,
  output: ListingLookupOutput,
  permission: 'realestate.use',
  ai: { tool: 'realestate_listing_lookup' },
  scope: inWorkspace,
  emits: ['realestate.listing.lookup_requested'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireNotArchived(deal);
    const listing = await ensureListing(ctx, deal);
    if (!(await feedConnected(ctx))) throw noFeed();
    const address = await listingAddress(ctx, deal);
    const mlsNumber = input.mlsNumber ?? listing.mlsNumber ?? null;
    if (!mlsNumber && !address)
      throw HfosError.rule(
        'realestate_listing_no_address',
        409,
        `${deal.name} has no home address yet. Add the property on the deal, or look it up by its MLS number.`,
      );
    await ctx.tx
      .update(listings)
      .set({ mlsState: 'looking', mlsFailure: null })
      .where(
        and(eq(listings.workspaceId, deal.workspaceId), eq(listings.dealRecordId, deal.recordId)),
      );
    await ctx.emit({
      type: 'realestate.listing.lookup_requested',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { dealId: deal.recordId, mlsNumber, address },
    });
    return { dealId: deal.recordId, looking: true as const };
  },
});

export const listingMlsFound = defineAddonCommand(realestateAddon, {
  name: 'realestate.listing.mls_found',
  description:
    'Worker: what the listing feed found for the deal’s own listing (kept as it said it, one more source for each fact), that it isn’t there, or why it couldn’t look.',
  risk: 0,
  input: MlsFoundInput,
  output: MlsFoundOutput,
  permission: 'realestate.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['realestate.listing.mls_found'],
  async handler(ctx, input) {
    if (!input.dealId) throw HfosError.validation([{ path: 'dealId', message: 'Which deal.' }]);
    const listing = await listingOf(ctx, input.dealId, true);
    if (!listing || listing.mlsState !== 'looking')
      return { state: 'skipped' as const, filled: [] };
    const at = new Date();
    const state = input.noFeed
      ? ('none' as const)
      : input.failure
        ? ('failed' as const)
        : input.listing
          ? ('found' as const)
          : ('not_found' as const);
    await ctx.tx
      .update(listings)
      .set({
        mlsState: state,
        mlsFailure: input.failure ? failureWords(input.failure) : null,
        ...(state === 'none' ? {} : { mlsCheckedAt: at }),
        ...(input.listing ? { mls: input.listing as unknown as Record<string, unknown> } : {}),
      })
      .where(
        and(
          eq(listings.workspaceId, listing.workspaceId),
          eq(listings.dealRecordId, listing.dealRecordId),
        ),
      );
    await ctx.emit({
      type: 'realestate.listing.mls_found',
      entityType: 'realestate_deal',
      entityId: listing.dealRecordId,
      payload: {
        dealId: listing.dealRecordId,
        state,
        ...(input.listing
          ? { mlsNumber: input.listing.mlsNumber, status: input.listing.status }
          : {}),
      },
    });
    return { state, filled: [] };
  },
});

// ---------- a CMA's comps ----------

export const cmaFindComps = defineAddonCommand(realestateAddon, {
  name: 'realestate.cma.find_comps',
  description:
    'Ask the business’s listing feed for homes sold near a draft CMA’s home: they come in as comps from the MLS that don’t count until the agent ticks them.',
  risk: 0,
  input: CmaFindCompsInput,
  output: CmaFindCompsOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_find_comps',
    description:
      'Find homes sold near a CMA’s home on the MLS, as comps for the agent to pick from.',
  },
  emits: ['realestate.cma.comps_requested'],
  async handler(ctx, input) {
    const { cma, deal } = await loadCma(ctx, input.cmaId, true);
    requireNotArchived(deal);
    requireDraft(cma);
    if (!(await feedConnected(ctx))) throw noFeed();
    if ((await compsOf(ctx, cma.id)).length >= MAX_COMPS)
      throw HfosError.rule(
        'realestate_cma_full',
        409,
        `CMA ${cma.number} already has ${MAX_COMPS} comps. Take off the ones you don’t use, then find more.`,
      );
    const asked = { miles: input.miles, months: input.months };
    await ctx.tx
      .update(cmas)
      .set({ compsState: 'finding', compsAsked: asked, compsFailure: null })
      .where(eq(cmas.id, cma.id));
    await ctx.emit({
      type: 'realestate.cma.comps_requested',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { cmaId: cma.id, ...asked },
    });
    return { cmaId: cma.id, finding: true as const };
  },
});

export const cmaCompsFound = defineAddonCommand(realestateAddon, {
  name: 'realestate.cma.comps_found',
  description:
    'Worker: homes the listing feed found sold near a CMA’s home, added as comps from the MLS that don’t count until the agent ticks them; or why it couldn’t look.',
  risk: 0,
  input: CmaCompsFoundInput,
  output: CmaCompsFoundOutput,
  permission: 'realestate.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['realestate.cma.comps_found', 'realestate.cma.changed'],
  async handler(ctx, input) {
    const { cma, deal } = await loadCma(ctx, input.cmaId, true);
    if (cma.compsState !== 'finding') return { cmaId: cma.id, state: 'skipped' as const, added: 0 };
    const at = new Date();
    const done = async (
      state: 'none' | 'found' | 'none_found' | 'failed',
      added: number,
      failure?: string,
    ) => {
      await ctx.tx
        .update(cmas)
        .set({
          compsState: state,
          compsFailure: failure ? failureWords(failure) : null,
          ...(state === 'none' ? {} : { compsFoundAt: at }),
          ...(added ? { updatedAt: at } : {}),
        })
        .where(eq(cmas.id, cma.id));
      await ctx.emit({
        type: 'realestate.cma.comps_found',
        entityType: 'realestate_deal',
        entityId: deal.recordId,
        payload: { cmaId: cma.id, state, added },
      });
      if (added)
        await ctx.emit({
          type: 'realestate.cma.changed',
          entityType: 'realestate_deal',
          entityId: deal.recordId,
          payload: { cmaId: cma.id, what: 'comps_found', added },
        });
      return { cmaId: cma.id, state, added };
    };
    if (input.noFeed) return done('none', 0);
    if (input.failure) return done('failed', 0, input.failure);
    // Finalized since it was asked: its comps stay as they are.
    if (cma.status !== 'draft') return done('none', 0);
    const list = await compsOf(ctx, cma.id);
    const seenNumbers = new Set(list.map((c) => c.mlsNumber).filter(Boolean));
    const seenAddresses = new Set([
      addressKey(cma.subjectAddress),
      ...list.map((c) => addressKey(c.address)),
    ]);
    let position = Math.max(0, ...list.map((c) => c.position));
    let added = 0;
    for (const { listing, distanceMiles } of input.comps) {
      if (list.length + added >= MAX_COMPS) break;
      const address = feedAddressWords(listing.address);
      const price = listing.soldPriceCents ?? listing.listPriceCents;
      if (!price || listing.status !== 'sold' || !listing.soldOn) continue;
      if (seenNumbers.has(listing.mlsNumber) || seenAddresses.has(addressKey(address))) continue;
      seenNumbers.add(listing.mlsNumber);
      seenAddresses.add(addressKey(address));
      const f = feedFacts(listing);
      await ctx.tx.insert(cmaComps).values({
        workspaceId: cma.workspaceId,
        dealRecordId: cma.dealRecordId,
        cmaId: cma.id,
        address,
        priceCents: price,
        status: 'sold',
        soldOn: listing.soldOn,
        beds: f.beds ?? null,
        baths: f.baths?.toString() ?? null,
        sqft: f.sqft && f.sqft >= 100 ? f.sqft : null,
        yearBuilt: f.year_built ?? null,
        distanceMiles:
          distanceMiles === null ? null : (Math.round(distanceMiles * 100) / 100).toString(),
        // From the MLS, it waits for the agent to tick it before it counts.
        used: false,
        note: `MLS #${listing.mlsNumber}. ${mlsSourceWords(listing)}.`,
        source: 'mls',
        mlsNumber: listing.mlsNumber,
        mls: listing as unknown as Record<string, unknown>,
        position: ++position,
        createdBy: null,
      });
      added++;
    }
    return done(added ? 'found' : 'none_found', added);
  },
});

// ---------- our own listing's status on the MLS (step 6) ----------

export const listingFeedStatus = defineAddonCommand(realestateAddon, {
  name: 'realestate.listing.feed_status',
  description:
    'Worker: what the listing feed says of the deal’s own listing now. Active on the MLS marks it live here (the feed as proof); a price or status that differs from the deal’s is flagged for a person, never copied over.',
  risk: 1,
  input: ListingFeedStatusInput,
  output: ListingFeedStatusOutput,
  permission: 'realestate.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: [
    'realestate.listing.feed_checked',
    'realestate.listing.live',
    'realestate.deal.stage_changed',
    ...PROOF_EVENTS,
  ],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    if (deal.side !== 'listing' || input.noFeed)
      return { dealId: deal.recordId, state: 'skipped' as const, live: false, differences: [] };
    const l = await ensureListing(ctx, deal);
    const at = new Date();
    const where = and(
      eq(listings.workspaceId, l.workspaceId),
      eq(listings.dealRecordId, l.dealRecordId),
    );
    if (input.failure) {
      await ctx.tx
        .update(listings)
        .set({ mlsFailure: failureWords(input.failure), mlsCheckedAt: at })
        .where(where);
      return { dealId: deal.recordId, state: 'failed' as const, live: false, differences: [] };
    }
    if (!input.listing) {
      await ctx.tx
        .update(listings)
        .set({ mlsState: 'not_found', mlsCheckedAt: at, mlsFailure: null })
        .where(where);
      return { dealId: deal.recordId, state: 'not_found' as const, live: false, differences: [] };
    }
    await ctx.tx
      .update(listings)
      .set({
        mls: input.listing as unknown as Record<string, unknown>,
        mlsState: 'found',
        mlsCheckedAt: at,
        mlsFailure: null,
      })
      .where(where);
    // Active on the MLS, and not live here yet: it is now, with the feed as proof (Chris, 2026-10-02).
    let live = false;
    if (
      input.listing.status === 'active' &&
      !l.mlsLiveOn &&
      deal.outcome === null &&
      !deal.archivedAt &&
      (await listingAddress(ctx, deal))
    ) {
      const today = todayIn(await timeZoneOf(ctx));
      const listed = input.listing.listedOn;
      await markListingLive(ctx, {
        dealId: deal.recordId,
        mlsNumber: input.listing.mlsNumber,
        liveOn: listed && listed <= today ? listed : today,
        fromFeed: `seen on the MLS, ${mlsSourceWords(input.listing).replace(/^From /, 'from ')}`,
      });
      live = true;
    }
    const now = await loadDeal(ctx, deal.recordId);
    const differences = listingFeedDiffers(
      {
        stage: now.stage,
        listPriceCents: await listPriceOf(ctx, deal.recordId),
        closed: now.outcome === 'closed',
      },
      input.listing,
    );
    await ctx.emit({
      type: 'realestate.listing.feed_checked',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: {
        dealId: deal.recordId,
        mlsNumber: input.listing.mlsNumber,
        status: input.listing.status,
        live,
        differences: differences.map((d) => d.key),
      },
    });
    return { dealId: deal.recordId, state: 'found' as const, live, differences };
  },
});

export const feedCommands = [
  homeLookup,
  homeMlsFound,
  listingLookup,
  listingMlsFound,
  listingFeedStatus,
  cmaFindComps,
  cmaCompsFound,
] as const;
