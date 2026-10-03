/**
 * Buyers' saved searches and their new matches (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, round five, step 5).
 * The worker asks the business's listing feed for each open buyer deal's profile every fifteen minutes and keeps what
 * it found here; the agent sends a match to the client (it becomes one of the deal's homes) or sets it aside.
 *
 * Chris decided (2026-10-02): new matches go to the agent first, at most one Home card a day per buyer, never to the
 * client; the client sees only homes the agent sent, with each MLS's notice and logo.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { HfosError } from '../../../errors';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { feedAddressWords, mlsOut, type MlsSnapshot } from '../feed';
import { addressKey, fitProfileOf, homeFit } from '../homes';
import { realestateAddon } from '../manifest';
import {
  MatchDismissInput,
  MatchDismissOutput,
  MatchesInput,
  MatchesOutput,
  MatchSendInput,
  MatchSendOutput,
  SearchFoundInput,
  SearchFoundOutput,
  SearchSetInput,
  SearchSetOutput,
} from '../schemas';
import { searchMissing, searchWords } from '../searches';
import { buyerProfiles, feedMatches, homes } from '../tables';
import {
  actorUserId,
  dealLine,
  feedConnected,
  inWorkspace,
  loadDeal,
  requireNotArchived,
  timeZoneOf,
  todayIn,
  userNames,
  type Ctx,
} from './common';
import { addHome, requireBuyerSide } from './homes';

type Match = typeof feedMatches.$inferSelect;

async function profileRow(ctx: Ctx, dealId: string, lock = false) {
  const q = ctx.tx
    .select()
    .from(buyerProfiles)
    .where(
      and(
        eq(buyerProfiles.workspaceId, ctx.scope.workspaceId!),
        eq(buyerProfiles.dealRecordId, dealId),
      ),
    );
  const [p] = lock ? await q.for('update') : await q;
  return p ?? null;
}

async function loadMatch(ctx: Ctx, matchId: string): Promise<Match> {
  const [m] = await ctx.tx
    .select()
    .from(feedMatches)
    .where(and(eq(feedMatches.id, matchId), eq(feedMatches.workspaceId, ctx.scope.workspaceId!)))
    .for('update');
  if (!m)
    throw HfosError.notFound(
      'That match isn’t there anymore, or you’re not on its deal. Refresh the deal’s matches.',
    );
  return m;
}

const decidedAlready = (m: Match) =>
  HfosError.rule(
    'realestate_match_decided',
    409,
    m.state === 'sent'
      ? 'That home was already sent to the client. It’s on the deal’s homes.'
      : 'That match was set aside. Refresh to see the matches as they are now.',
  );

/** What the MLS changed between two looks at a listing: its price or where it stands. */
const changed = (was: MlsSnapshot, now: MlsSnapshot) =>
  was.listPriceCents !== now.listPriceCents || was.status !== now.status;

export const searchSet = defineAddonCommand(realestateAddon, {
  name: 'realestate.search.set',
  description:
    'Turn a buyer’s saved search on the business’s listing feed on or off. On, their profile is asked every fifteen minutes and new homes come to the agent.',
  risk: 1,
  input: SearchSetInput,
  output: SearchSetOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.search.changed'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireBuyerSide(deal);
    requireNotArchived(deal);
    const p = await profileRow(ctx, deal.recordId, true);
    if (!p)
      throw HfosError.rule(
        'realestate_search_no_profile',
        409,
        `${deal.name} has no buyer profile yet. Fill in what the buyer wants, and their search can start.`,
      );
    if (p.searchOn === input.on) return { dealId: deal.recordId, on: input.on, changed: false };
    await ctx.tx
      .update(buyerProfiles)
      .set({ searchOn: input.on, searchFailure: null })
      .where(
        and(
          eq(buyerProfiles.workspaceId, deal.workspaceId),
          eq(buyerProfiles.dealRecordId, deal.recordId),
        ),
      );
    await ctx.emit({
      type: 'realestate.search.changed',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { dealId: deal.recordId, on: input.on },
    });
    return { dealId: deal.recordId, on: input.on, changed: true };
  },
});

export const searchFound = defineAddonCommand(realestateAddon, {
  name: 'realestate.search.found',
  description:
    'Worker: what one check of a buyer’s saved search found on the listing feed. New homes wait for the agent; ones the MLS changed since are marked.',
  risk: 0,
  input: SearchFoundInput,
  output: SearchFoundOutput,
  permission: 'realestate.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['realestate.search.matched'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    const p = await profileRow(ctx, deal.recordId, true);
    const at = new Date();
    const where = and(
      eq(buyerProfiles.workspaceId, deal.workspaceId),
      eq(buyerProfiles.dealRecordId, deal.recordId),
    );
    const waitingNow = async () =>
      (
        await ctx.tx
          .select({ id: feedMatches.id })
          .from(feedMatches)
          .where(and(eq(feedMatches.dealRecordId, deal.recordId), eq(feedMatches.state, 'new')))
      ).length;
    if (!p || !p.searchOn || deal.outcome !== null || deal.archivedAt || input.noFeed)
      return {
        dealId: deal.recordId,
        added: 0,
        changed: 0,
        cardDue: false,
        waiting: await waitingNow(),
      };
    if (input.failure) {
      await ctx.tx
        .update(buyerProfiles)
        .set({ searchFailure: input.failure, searchCheckedAt: at })
        .where(where);
      return {
        dealId: deal.recordId,
        added: 0,
        changed: 0,
        cardDue: false,
        waiting: await waitingNow(),
      };
    }
    // Homes already on the deal aren't news.
    const onDeal = new Set(
      (
        await ctx.tx
          .select({ key: homes.addressKey })
          .from(homes)
          .where(
            and(eq(homes.workspaceId, deal.workspaceId), eq(homes.dealRecordId, deal.recordId)),
          )
      ).map((h) => h.key),
    );
    const keys = input.listings.map((l) => l.listingKey);
    const known = keys.length
      ? await ctx.tx
          .select()
          .from(feedMatches)
          .where(
            and(
              eq(feedMatches.workspaceId, deal.workspaceId),
              eq(feedMatches.dealRecordId, deal.recordId),
              inArray(feedMatches.listingKey, keys),
            ),
          )
      : [];
    const byKey = new Map(known.map((m) => [`${m.provider}:${m.listingKey}`, m]));
    let added = 0;
    let changedCount = 0;
    for (const l of input.listings) {
      const was = byKey.get(`${l.provider}:${l.listingKey}`);
      if (was) {
        const moved = changed(was.mls as unknown as MlsSnapshot, l);
        if (moved) changedCount++;
        await ctx.tx
          .update(feedMatches)
          .set({
            mls: l as unknown as Record<string, unknown>,
            ...(moved ? { changedAt: at } : {}),
          })
          .where(eq(feedMatches.id, was.id));
        continue;
      }
      if (onDeal.has(addressKey(feedAddressWords(l.address)))) continue;
      await ctx.tx.insert(feedMatches).values({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        provider: l.provider,
        listingKey: l.listingKey,
        mlsNumber: l.mlsNumber,
        mls: l as unknown as Record<string, unknown>,
        foundAt: at,
      });
      added++;
    }
    // One Home card a day per buyer: due when new ones came and today's hasn't gone up.
    const today = todayIn(await timeZoneOf(ctx), at);
    const cardDue = added > 0 && p.searchCardOn !== today;
    await ctx.tx
      .update(buyerProfiles)
      .set({
        searchCheckedAt: at,
        searchFailure: null,
        ...(cardDue ? { searchCardOn: today } : {}),
      })
      .where(where);
    const waiting = await waitingNow();
    if (added || changedCount)
      await ctx.emit({
        type: 'realestate.search.matched',
        entityType: 'realestate_deal',
        entityId: deal.recordId,
        payload: { dealId: deal.recordId, added, changed: changedCount, waiting, cardDue },
      });
    return { dealId: deal.recordId, added, changed: changedCount, cardDue, waiting };
  },
});

export const matchSend = defineAddonCommand(realestateAddon, {
  name: 'realestate.match.send',
  description:
    'Send a buyer’s new match to the client: it becomes one of the deal’s homes, with what the MLS says of it, and the client sees it in their portal with the MLS’s notice.',
  risk: 2,
  input: MatchSendInput,
  output: MatchSendOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_send_match',
    description: 'Send a home from a buyer’s new matches to the client, as one of their homes.',
  },
  emits: ['realestate.match.sent', 'realestate.home.added'],
  async handler(ctx, input) {
    const m = await loadMatch(ctx, input.matchId);
    if (m.state !== 'new') throw decidedAlready(m);
    const deal = await loadDeal(ctx, m.dealRecordId, { lock: true });
    const snapshot = m.mls as unknown as MlsSnapshot;
    const { homeId } = await addHome(ctx, deal, {
      address: feedAddressWords(snapshot.address),
      source: 'mls',
      mls: snapshot,
    });
    await ctx.tx
      .update(feedMatches)
      .set({ state: 'sent', homeId, decidedBy: actorUserId(ctx), decidedAt: new Date() })
      .where(eq(feedMatches.id, m.id));
    const eventId = await ctx.emit({
      type: 'realestate.match.sent',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { dealId: deal.recordId, matchId: m.id, homeId, mlsNumber: m.mlsNumber },
    });
    await dealLine(ctx, deal, `sent MLS #${m.mlsNumber} to the client from their search`, {
      eventId,
    });
    return { matchId: m.id, homeId };
  },
});

export const matchDismiss = defineAddonCommand(realestateAddon, {
  name: 'realestate.match.dismiss',
  description:
    'Set aside one of a buyer’s new matches: the client never sees it, and it doesn’t come back.',
  risk: 1,
  input: MatchDismissInput,
  output: MatchDismissOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.match.dismissed'],
  async handler(ctx, input) {
    const m = await loadMatch(ctx, input.matchId);
    if (m.state === 'dismissed') return { matchId: m.id, changed: false };
    if (m.state !== 'new') throw decidedAlready(m);
    await loadDeal(ctx, m.dealRecordId);
    await ctx.tx
      .update(feedMatches)
      .set({ state: 'dismissed', decidedBy: actorUserId(ctx), decidedAt: new Date() })
      .where(eq(feedMatches.id, m.id));
    await ctx.emit({
      type: 'realestate.match.dismissed',
      entityType: 'realestate_deal',
      entityId: m.dealRecordId,
      payload: { dealId: m.dealRecordId, matchId: m.id },
    });
    return { matchId: m.id, changed: true };
  },
});

export const dealMatches = defineAddonQuery(realestateAddon, {
  name: 'realestate.matches',
  description:
    'A buyer deal’s saved search on the listing feed: what it asks, whether it’s on, and the homes it found, new ones first, each with how it fits what the buyer wants.',
  input: MatchesInput,
  output: MatchesOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_matches',
    description: 'The homes a buyer’s saved search found on the MLS, and how each fits.',
  },
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId);
    requireBuyerSide(deal);
    const p = await profileRow(ctx, deal.recordId);
    const profile = fitProfileOf(p);
    const list = await ctx.tx
      .select()
      .from(feedMatches)
      .where(
        and(
          eq(feedMatches.workspaceId, deal.workspaceId),
          eq(feedMatches.dealRecordId, deal.recordId),
          ...(input.state ? [eq(feedMatches.state, input.state)] : []),
        ),
      )
      .orderBy(desc(feedMatches.foundAt), desc(feedMatches.id));
    const all = input.state
      ? await ctx.tx
          .select({ state: feedMatches.state })
          .from(feedMatches)
          .where(
            and(
              eq(feedMatches.workspaceId, deal.workspaceId),
              eq(feedMatches.dealRecordId, deal.recordId),
            ),
          )
      : list;
    const names = await userNames(
      ctx,
      list.map((m) => m.decidedBy),
    );
    const order = { new: 0, sent: 1, dismissed: 2 } as const;
    return {
      search: {
        on: p?.searchOn ?? false,
        missing: searchMissing(p ? profile : null),
        words: searchWords(profile),
        feedConnected: await feedConnected(ctx),
        checkedAt: p?.searchCheckedAt?.toISOString() ?? null,
        failure: p?.searchFailure ?? null,
      },
      matches: [...list]
        .sort((a, b) => order[a.state] - order[b.state])
        .map((m) => {
          const s = m.mls as unknown as MlsSnapshot;
          const address = feedAddressWords(s.address);
          const fit = homeFit(profile, mlsOut(s, {}).facts, address);
          return {
            id: m.id,
            state: m.state,
            address,
            mls: mlsOut(s, {}),
            fit: { ...fit, lines: [...fit.lines] },
            foundAt: m.foundAt.toISOString(),
            changedAt: m.changedAt?.toISOString() ?? null,
            homeId: m.homeId,
            decidedBy: m.decidedBy
              ? { id: m.decidedBy, fullName: names.get(m.decidedBy) ?? 'Former member' }
              : null,
            decidedAt: m.decidedAt?.toISOString() ?? null,
          };
        }),
      counts: {
        new: all.filter((m) => m.state === 'new').length,
        sent: all.filter((m) => m.state === 'sent').length,
        dismissed: all.filter((m) => m.state === 'dismissed').length,
      },
    };
  },
});

export const searchCommands = [searchSet, searchFound, matchSend, matchDismiss] as const;
export const searchQueries = [dealMatches] as const;
