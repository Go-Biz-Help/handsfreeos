/**
 * Our listings suggested to our buyers, step 11 (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round three: Listing
 * core"). Chris decided (2026-10-01): a new listing that fits one of the business's buyers is suggested to that
 * buyer's agent.
 *
 * - **Matching** (`realestate.match.run`, the worker's, when a listing goes live, its price changes or a suggestion is
 *   decided, and when a buyer's profile is saved) reads only the business's own live listings and open buyer deals,
 *   and only price, areas, kind of home, beds, baths and size (round two's `homeFit`), never who anyone is.
 * - **A suggestion** belongs to the buyer's deal, with a copy of the listing's public facts and how they fit, so the
 *   buyer's agent never reads the listing's deal. "Add to their homes" makes a home from it (its facts confirmed, as
 *   the listing has them); "Not a fit" sets it aside. One that stops fitting, or a listing off the market, is gone.
 * - **The listing's side** sees only how many it was suggested to and how many added it. S-23 and S-24's note.
 */
import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { HfosError } from '../../../errors';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import {
  addressKey,
  homeFit,
  LISTING_FACT_KEYS,
  suggestsListing,
  type ListingFacts,
} from '../homes';
import { streetOf } from '../listing';
import { realestateAddon } from '../manifest';
import {
  ListingInput,
  MatchRunInput,
  MatchRunOutput,
  SuggestionChangeOutput,
  SuggestionInput,
  SuggestionNotAFitInput,
  SuggestionsOutput,
} from '../schemas';
import { customRecords } from '@hfos/db/schema';
import { buyerProfiles, deals, homes, listings, listingSuggestions } from '../tables';
import {
  actorUserId,
  historyLine,
  inWorkspace,
  loadDeal,
  requireOpen,
  userNames,
  type Ctx,
  type Deal,
} from './common';
import { addHome, fitProfileOf, requireBuyerSide } from './homes';
import { listingAddress, listingOf, listPriceOf } from './listing';
import { addProof, PROOF_EVENTS } from './proof-hooks';

type Suggestion = typeof listingSuggestions.$inferSelect;

/** A listing's stages on the market: suggested while in one of these and live on the MLS. */
const ON_MARKET = ['active', 'showings', 'offers', 'negotiation'];
/** A buyer deal's stages while still looking. */
const LOOKING = [
  'lead',
  'onboarding',
  'representation',
  'financing',
  'searching',
  'touring',
  'offer',
  'negotiation',
];

interface Live {
  readonly dealId: string;
  readonly address: string;
  readonly facts: ListingFacts;
  readonly mlsNumber: string;
  readonly pageSlug: string | null;
}

/** A listing as a buyer's agent may see it: its address, its public facts and its price, while live. */
async function liveListing(ctx: Ctx, dealId: string): Promise<Live | null> {
  const deal = await loadDeal(ctx, dealId).catch(() => null);
  const l = deal ? await listingOf(ctx, dealId) : null;
  if (
    !deal ||
    !l?.mlsNumber ||
    deal.side !== 'listing' ||
    deal.outcome ||
    deal.archivedAt ||
    !ON_MARKET.includes(deal.stage)
  )
    return null;
  const address = await listingAddress(ctx, deal);
  if (!address) return null;
  const confirmed = (l.facts ?? {}) as Record<string, unknown>;
  const facts: Record<string, unknown> = {};
  for (const k of LISTING_FACT_KEYS) if (confirmed[k] !== undefined) facts[k] = confirmed[k];
  const price = await listPriceOf(ctx, dealId);
  if (price !== null) facts['price_cents'] = price;
  return {
    dealId,
    address,
    facts: facts as ListingFacts,
    mlsNumber: l.mlsNumber,
    pageSlug: l.pageState === 'published' ? l.slug : null,
  };
}

/** The business's buyer deals still looking, each with what they want. */
async function lookingBuyers(ctx: Ctx, only?: string) {
  const list = await ctx.tx
    .select({
      deal: deals,
      name: customRecords.name,
      ownerUserId: customRecords.ownerUserId,
      teamUserIds: customRecords.teamUserIds,
      profile: buyerProfiles,
    })
    .from(deals)
    .innerJoin(customRecords, eq(customRecords.id, deals.recordId))
    .innerJoin(
      buyerProfiles,
      and(
        eq(buyerProfiles.workspaceId, deals.workspaceId),
        eq(buyerProfiles.dealRecordId, deals.recordId),
      ),
    )
    .where(
      and(
        eq(deals.workspaceId, ctx.scope.workspaceId!),
        eq(deals.side, 'buyer'),
        isNull(deals.outcome),
        isNull(customRecords.archivedAt),
        inArray(deals.stage, LOOKING),
        ...(only ? [eq(deals.recordId, only)] : []),
      ),
    );
  return list;
}

async function liveListingIds(ctx: Ctx): Promise<string[]> {
  const list = await ctx.tx
    .select({ id: deals.recordId })
    .from(deals)
    .innerJoin(customRecords, eq(customRecords.id, deals.recordId))
    .innerJoin(
      listings,
      and(eq(listings.workspaceId, deals.workspaceId), eq(listings.dealRecordId, deals.recordId)),
    )
    .where(
      and(
        eq(deals.workspaceId, ctx.scope.workspaceId!),
        eq(deals.side, 'listing'),
        isNull(deals.outcome),
        isNull(customRecords.archivedAt),
        inArray(deals.stage, ON_MARKET),
      ),
    );
  return list.map((x) => x.id);
}

/** What the listing's side sees: how many it was suggested to, and how many added it. */
async function recount(ctx: Ctx, listingDealId: string): Promise<number> {
  const list = await ctx.tx
    .select({ state: listingSuggestions.state })
    .from(listingSuggestions)
    .where(
      and(
        eq(listingSuggestions.workspaceId, ctx.scope.workspaceId!),
        eq(listingSuggestions.listingDealId, listingDealId),
      ),
    );
  const suggested = list.filter((s) => s.state !== 'gone').length;
  await ctx.tx
    .update(listings)
    .set({
      matchesSuggested: suggested,
      matchesAdded: list.filter((s) => s.state === 'added').length,
      matchedAt: new Date(),
    })
    .where(
      and(
        eq(listings.workspaceId, ctx.scope.workspaceId!),
        eq(listings.dealRecordId, listingDealId),
      ),
    );
  return suggested;
}

const fitLines = (fit: ReturnType<typeof homeFit>) =>
  fit.lines.map((l) => ({ key: l.key, met: l.met, words: l.words }));

// ---------- the worker's ----------

export const matchRun = defineAddonCommand(realestateAddon, {
  name: 'realestate.match.run',
  description:
    'Worker: suggest the business’s live listings to its buyer deals still looking that they fit (price, areas, kind of home, beds, baths and size only), for one listing or one buyer, and set aside suggestions that no longer fit.',
  risk: 0,
  input: MatchRunInput,
  output: MatchRunOutput,
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: ['realestate.listing.suggested', ...PROOF_EVENTS],
  async handler(ctx, input) {
    const listingIds = input.listingDealId ? [input.listingDealId] : await liveListingIds(ctx);
    const buyers = await lookingBuyers(ctx, input.buyerDealId);
    const looking = new Set(buyers.map((b) => b.deal.recordId));
    let suggested = 0;
    let refreshed = 0;
    let gone = 0;
    const newFor = new Map<
      string,
      { buyer: (typeof buyers)[number]; ids: string[]; streets: string[] }
    >();
    const now = new Date();
    for (const listingId of listingIds) {
      const live = await liveListing(ctx, listingId);
      const had = await ctx.tx
        .select()
        .from(listingSuggestions)
        .where(
          and(
            eq(listingSuggestions.workspaceId, ctx.scope.workspaceId!),
            eq(listingSuggestions.listingDealId, listingId),
            ...(input.buyerDealId ? [eq(listingSuggestions.dealRecordId, input.buyerDealId)] : []),
          ),
        );
      const setGone = async (s: Suggestion) => {
        if (s.state !== 'new') return;
        await ctx.tx
          .update(listingSuggestions)
          .set({ state: 'gone', updatedAt: now })
          .where(eq(listingSuggestions.id, s.id));
        gone += 1;
      };
      if (!live) {
        for (const s of had) await setGone(s);
      } else {
        let added = 0;
        for (const b of buyers) {
          if (b.deal.recordId === listingId) continue;
          const fit = homeFit(fitProfileOf(b.profile), live.facts, live.address);
          const ok = suggestsListing(fit);
          const was = had.find((s) => s.dealRecordId === b.deal.recordId);
          if (!ok) {
            if (was) await setGone(was);
            continue;
          }
          const copy = {
            address: live.address,
            addressKey: addressKey(live.address),
            facts: live.facts as Record<string, unknown>,
            fit: fitLines(fit),
            mlsNumber: live.mlsNumber,
            pageSlug: live.pageSlug,
            updatedAt: now,
          };
          if (was) {
            if (was.state === 'new' || was.state === 'gone') {
              await ctx.tx
                .update(listingSuggestions)
                .set({ ...copy, state: 'new' })
                .where(eq(listingSuggestions.id, was.id));
              refreshed += 1;
            }
            continue;
          }
          // Already one of their homes: nothing to suggest.
          const [home] = await ctx.tx
            .select({ id: homes.id })
            .from(homes)
            .where(
              and(
                eq(homes.dealRecordId, b.deal.recordId),
                eq(homes.addressKey, copy.addressKey),
                ne(homes.status, 'removed'),
              ),
            );
          if (home) continue;
          const [row] = await ctx.tx
            .insert(listingSuggestions)
            .values({
              workspaceId: b.deal.workspaceId,
              dealRecordId: b.deal.recordId,
              listingDealId: listingId,
              ...copy,
            })
            .returning({ id: listingSuggestions.id });
          suggested += 1;
          added += 1;
          const entry = newFor.get(b.deal.recordId) ?? { buyer: b, ids: [], streets: [] };
          entry.ids.push(row!.id);
          entry.streets.push(streetOf(live.address));
          newFor.set(b.deal.recordId, entry);
        }
        if (added) {
          // S-23 "Notify agent buyer database" and S-24 "Identify potentially relevant agents": who was told, by count.
          const listingDeal = await loadDeal(ctx, listingId);
          await addProof(
            ctx,
            listingDeal,
            { keys: ['S-23', 'S-24'] },
            {
              kind: 'note',
              body: `Suggested to the agents of ${added} of our buyers`,
            },
          );
        }
      }
      // Buyer deals no longer looking lose what was waiting for them.
      if (live)
        for (const s of had)
          if (!looking.has(s.dealRecordId) && !input.buyerDealId) await setGone(s);
      await recount(ctx, listingId);
    }
    for (const [buyerDealId, n] of newFor)
      await ctx.emit({
        type: 'realestate.listing.suggested',
        entityType: 'realestate_deal',
        entityId: buyerDealId,
        payload: {
          suggestionIds: n.ids,
          streets: n.streets,
          dealName: n.buyer.name,
          ownerUserId: n.buyer.ownerUserId,
          teamUserIds: n.buyer.teamUserIds ?? [],
        },
      });
    return { suggested, refreshed, gone };
  },
});

// ---------- the buyer's agent's ----------

async function loadSuggestion(ctx: Ctx, id: string): Promise<{ s: Suggestion; deal: Deal }> {
  const [s] = await ctx.tx
    .select()
    .from(listingSuggestions)
    .where(
      and(
        eq(listingSuggestions.id, id),
        eq(listingSuggestions.workspaceId, ctx.scope.workspaceId!),
      ),
    )
    .for('update');
  if (!s)
    throw HfosError.notFound(
      'That suggestion isn’t there anymore, or you’re not on its deal. Refresh the deal’s homes.',
    );
  return { s, deal: await loadDeal(ctx, s.dealRecordId) };
}

async function decided(ctx: CommandContext, s: Suggestion, deal: Deal) {
  await ctx.emit({
    type: 'realestate.suggestion.decided',
    entityType: 'realestate_deal',
    entityId: deal.recordId,
    payload: { suggestionId: s.id, listingDealId: s.listingDealId },
  });
}

export const suggestionAdd = defineAddonCommand(realestateAddon, {
  name: 'realestate.suggestion.add',
  description:
    'Add one of our listings suggested for a buyer to their homes, with its facts as the listing has them.',
  risk: 1,
  input: SuggestionInput,
  output: SuggestionChangeOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.home.added', 'realestate.suggestion.decided'],
  async handler(ctx, input) {
    const { s, deal } = await loadSuggestion(ctx, input.suggestionId);
    requireOpen(deal);
    requireBuyerSide(deal);
    if (s.state === 'added') return { suggestionId: s.id, state: s.state, homeId: s.homeId };
    if (s.state === 'gone')
      throw HfosError.rule(
        'realestate_suggestion_gone',
        409,
        `${streetOf(s.address)} is no longer on the market, or no longer fits. Refresh the deal’s homes.`,
      );
    const { homeId } = await addHome(ctx, deal, { address: s.address, source: 'our_listing' });
    const at = changeMoment(ctx.meta);
    // The listing's facts were confirmed by its agent: the home takes them as they are.
    await ctx.tx
      .update(homes)
      .set({
        facts: s.facts,
        factsState: 'confirmed',
        factsConfirmedBy: actorUserId(ctx),
        factsConfirmedAt: at,
      })
      .where(eq(homes.id, homeId));
    await ctx.tx
      .update(listingSuggestions)
      .set({
        state: 'added',
        homeId,
        decidedBy: actorUserId(ctx),
        decidedAt: at,
        updatedAt: at,
      })
      .where(eq(listingSuggestions.id, s.id));
    await decided(ctx, s, deal);
    return { suggestionId: s.id, state: 'added' as const, homeId };
  },
});

export const suggestionNotAFit = defineAddonCommand(realestateAddon, {
  name: 'realestate.suggestion.not_a_fit',
  description:
    'Set aside one of our listings suggested for a buyer: it isn’t a fit, with why if you like.',
  risk: 1,
  input: SuggestionNotAFitInput,
  output: SuggestionChangeOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.suggestion.decided'],
  async handler(ctx, input) {
    const { s, deal } = await loadSuggestion(ctx, input.suggestionId);
    requireOpen(deal);
    if (s.state === 'added')
      throw HfosError.rule(
        'realestate_suggestion_added',
        409,
        `${streetOf(s.address)} is already one of their homes. Mark it passed there instead.`,
      );
    if (s.state === 'not_a_fit') return { suggestionId: s.id, state: s.state, homeId: null };
    const at = changeMoment(ctx.meta);
    await ctx.tx
      .update(listingSuggestions)
      .set({
        state: 'not_a_fit',
        decidedBy: actorUserId(ctx),
        decidedAt: at,
        decidedReason: input.reason ?? null,
        updatedAt: at,
      })
      .where(eq(listingSuggestions.id, s.id));
    await historyLine(ctx, deal, 'suggestion_not_a_fit', {
      after: { address: s.address },
      note: input.reason ?? null,
    });
    await decided(ctx, s, deal);
    return { suggestionId: s.id, state: 'not_a_fit' as const, homeId: null };
  },
});

export const suggestionsList = defineAddonQuery(realestateAddon, {
  name: 'realestate.suggestions',
  description:
    'Our own listings that fit what a buyer wants, suggested on their deal: each with its facts, how it fits, and whether it was added or set aside.',
  input: ListingInput,
  output: SuggestionsOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_listing_suggestions',
    description: 'The business’s own listings that fit a buyer, suggested on their deal.',
  },
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId);
    requireBuyerSide(deal);
    const list = await ctx.tx
      .select()
      .from(listingSuggestions)
      .where(eq(listingSuggestions.dealRecordId, deal.recordId))
      .orderBy(desc(listingSuggestions.createdAt));
    const names = await userNames(
      ctx,
      list.map((s) => s.decidedBy),
    );
    const order = { new: 0, added: 1, not_a_fit: 2, gone: 3 } as const;
    return {
      dealId: deal.recordId,
      suggestions: [...list]
        .sort((a, b) => order[a.state] - order[b.state])
        .map((s) => ({
          id: s.id,
          address: s.address,
          priceCents: typeof s.facts['price_cents'] === 'number' ? s.facts['price_cents'] : null,
          facts: s.facts,
          fit: s.fit,
          mlsNumber: s.mlsNumber,
          pageSlug: s.pageSlug,
          state: s.state,
          homeId: s.homeId,
          decidedBy: s.decidedBy
            ? { id: s.decidedBy, fullName: names.get(s.decidedBy) ?? 'Former member' }
            : null,
          decidedAt: s.decidedAt?.toISOString() ?? null,
          decidedReason: s.decidedReason,
          createdAt: s.createdAt.toISOString(),
        })),
    };
  },
});

export const matchingQueries = [suggestionsList] as const;
export const matchingCommands = [matchRun, suggestionAdd, suggestionNotAFit] as const;
