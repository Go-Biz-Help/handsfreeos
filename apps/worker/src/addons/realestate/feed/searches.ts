/**
 * Buyers' saved searches on the listing feed (round five, step 5): `realestate.feed_check`, every fifteen minutes
 * while the add-on is on, asks the business's feed for each open buyer deal's profile and hands core what it found
 * (`realestate.search.found`). New homes wait for the agent: a Home card for the deal's agent at most once a day,
 * taken down once nothing waits. Never to the client.
 *
 * After the first look, each check asks only for what the MLS changed since the last (an hour's overlap, so a
 * supplier's slow clock loses nothing). No feed connected, or one that turned its key down, stops the round there;
 * a supplier that doesn't answer is asked again next time.
 */
import { fitProfileOf } from '@hfos/core/addons/realestate/ops/homes';
import { listingFeedStatus } from '@hfos/core/addons/realestate/ops/feed';
import { searchFound } from '@hfos/core/addons/realestate/ops/searches';
import {
  matchesAlertKey,
  newMatchesWords,
  profileSearch,
} from '@hfos/core/addons/realestate/searches';
import type { FeedListing, MlsSnapshot } from '@hfos/core/addons/realestate/feed';
import { executeCommand } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { JobResult } from '../../../jobs';
import { clearAddonAlert, raiseAddonAlert } from '../../alerts';
import { ConnectionRefused } from '../../connections';
import { scheduleAddonJob } from '../../queue';
import type { AddonEventContext, AddonJobContext, AddonScopeContext } from '../../types';
import { askFeed, FeedUnreachable, FeedUnsupported } from './index';
import { findListing } from './lookups';

export const FEED_CHECK = 'realestate.feed_check';
export const FEED_CHECK_EVERY = 15 * 60_000;
/** How far back each check also looks, past the last one. */
const OVERLAP_MS = 60 * 60_000;

/** Arms the feed check (a no-op while one is waiting, unless `now` pulls the waiting one in). */
export async function armFeedCheck(
  ctx: AddonScopeContext,
  at = new Date(),
  opts: { readonly now?: boolean } = {},
): Promise<void> {
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: FEED_CHECK,
        dedupeKey: `${FEED_CHECK}:${ctx.scope.workspaceId}`,
        runAt: at,
        payload: {},
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
      { pullEarlier: opts.now ?? false },
    ),
  );
}

/**
 * A buyer's search turned on (`realestate.search.changed`), or what it asks changed (`realestate.buyer_profile.saved`
 * with `searchChanged`): asked at once, not at the next quarter hour. The check asks only searches that are on.
 */
export async function searchChanged(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as Record<string, unknown>;
  if (p['on'] === true || p['searchChanged'] === true)
    await armFeedCheck(ctx, new Date(), { now: true });
}

interface SearchRow extends Record<string, unknown> {
  readonly deal_record_id: string;
  readonly name: string;
  readonly owner_user_id: string | null;
  readonly team: string[] | null;
  readonly search_checked_at: Date | null;
  readonly budget_min_cents: string | number | null;
  readonly budget_max_cents: string | number | null;
  readonly areas: string[];
  readonly home_types: string[];
  readonly beds_min: number | null;
  readonly baths_min: string | null;
  readonly sqft_min: number | null;
}

/** `realestate.feed_check`: each open buyer deal's saved search, then our own listings, asked of the feed. */
export async function feedCheckJob(ctx: AddonJobContext): Promise<JobResult> {
  const next = { rescheduleAt: new Date(ctx.now + FEED_CHECK_EVERY) };
  if ((await buyerSearches(ctx)) === 'stop') return next;
  await ourListings(ctx);
  return next;
}

/** Each open buyer deal's saved search. 'stop' when the feed can't be asked this time. */
async function buyerSearches(ctx: AddonJobContext): Promise<'stop' | 'go'> {
  const next = 'stop' as const;
  const searches = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<SearchRow>(
      tx,
      sql`select b.deal_record_id, r.name, r.owner_user_id, r.team_user_ids as team, b.search_checked_at,
                 b.budget_min_cents, b.budget_max_cents, b.areas, b.home_types, b.beds_min, b.baths_min, b.sqft_min
          from addon_realestate.buyer_profiles b
          join addon_realestate.deals d on d.workspace_id = b.workspace_id and d.record_id = b.deal_record_id
          join app.custom_records r on r.id = d.record_id
          where b.workspace_id = ${ctx.scope.workspaceId} and b.search_on
            and d.side = 'buyer' and d.outcome is null and r.archived_at is null
          order by b.search_checked_at nulls first`,
    ),
  );
  for (const s of searches) {
    const ready = profileSearch(
      fitProfileOf({
        // Cents come back from the database as text (bigint).
        budgetMinCents: s.budget_min_cents === null ? null : Number(s.budget_min_cents),
        budgetMaxCents: s.budget_max_cents === null ? null : Number(s.budget_max_cents),
        areas: s.areas,
        homeTypes: s.home_types,
        bedsMin: s.beds_min,
        bathsMin: s.baths_min,
        sqftMin: s.sqft_min,
      } as Parameters<typeof fitProfileOf>[0]),
    );
    if (!ready.search) continue;
    const record = (input: Record<string, unknown>) =>
      executeCommand(
        ctx.db,
        searchFound,
        { workspaceId: ctx.scope.workspaceId, dealId: s.deal_record_id, ...input },
        ctx.actor,
        ctx.meta,
      ).then((r) => r.output);
    let answer;
    try {
      answer = await askFeed(ctx, {
        ...ready.search,
        ...(s.search_checked_at
          ? {
              updatedSince: new Date(
                new Date(s.search_checked_at).getTime() - OVERLAP_MS,
              ).toISOString(),
            }
          : {}),
      });
    } catch (e) {
      if (e instanceof FeedUnsupported) {
        await record({ failure: e.message.slice(0, 500) });
        continue;
      }
      // A refused key or a supplier that's down: every other search would fail the same way. Next time.
      if (e instanceof ConnectionRefused) return next;
      if (e instanceof FeedUnreachable) {
        ctx.log.warn({ err: e.message }, 'the listing feed didn’t answer');
        return next;
      }
      throw e;
    }
    if (!answer) return next;
    const found = await record({
      listings: answer.listings.map((l): MlsSnapshot => ({
        ...l,
        checkedAt: new Date(ctx.now).toISOString(),
      })),
    });
    if (found.cardDue)
      await raiseAddonAlert(ctx, {
        key: matchesAlertKey(s.deal_record_id),
        severity: 'info',
        title: newMatchesWords(found.waiting, s.name).slice(0, 200),
        detail: 'From their saved search on the MLS. Send the ones they’d like, or set them aside.',
        href: `/a/realestate/deals/${s.deal_record_id}/matches`,
        permission: 'realestate.use',
        customRecordId: s.deal_record_id,
        audienceUserIds: [s.owner_user_id, ...(s.team ?? [])].filter((u): u is string => !!u),
      });
  }
  return 'go';
}

/**
 * `realestate.match.sent` / `.dismissed`, and `realestate.home.added` (a home added by hand settles its match): the
 * deal's card comes down once nothing waits on the agent.
 */
export async function matchDecided(ctx: AddonEventContext): Promise<void> {
  const dealId =
    (ctx.event.payload as Record<string, unknown> | null)?.['dealId'] ?? ctx.event.entityId;
  if (typeof dealId !== 'string') return;
  const [left] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ n: number }>(
      tx,
      sql`select count(*)::int as n from addon_realestate.feed_matches
          where workspace_id = ${ctx.scope.workspaceId} and deal_record_id = ${dealId} and state = 'new'`,
    ),
  );
  if (!left?.n) await clearAddonAlert(ctx, matchesAlertKey(dealId), 'done');
}

interface ListingRow extends Record<string, unknown> {
  readonly deal_record_id: string;
  readonly name: string;
  readonly owner_user_id: string | null;
  readonly team: string[] | null;
  readonly mls_number: string | null;
  readonly address: string | null;
}

/** The Home card's key for where the MLS and our listing disagree. */
export const feedDiffersAlertKey = (dealId: string) => `feed:${dealId}`;
/** How many listings without an MLS number are looked for by address each time. */
const BY_ADDRESS_EACH_TIME = 10;

/**
 * Each open listing deal on the MLS (round five, step 6): by its MLS number (all at once), or, before it has one, by
 * its address. Core marks it live when the MLS shows it Active, and says where the two disagree: a Home card for the
 * deal's people until they agree. Nothing is ever copied over, and nothing is written to the MLS.
 */
async function ourListings(ctx: AddonJobContext): Promise<void> {
  const list = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<ListingRow>(
      tx,
      sql`select d.record_id as deal_record_id, r.name, r.owner_user_id, r.team_user_ids as team,
                 l.mls_number, p.address
          from addon_realestate.deals d
          join app.custom_records r on r.id = d.record_id
          left join addon_realestate.listings l on l.workspace_id = d.workspace_id and l.deal_record_id = d.record_id
          left join lateral (
            select pr.name as address from app.relationships rel
            join app.relationship_types rt on rt.id = rel.type_id and rt.addon_key = 'realestate_property_of'
            join app.custom_records pr on pr.id = rel.b_custom_record_id
            where rel.workspace_id = d.workspace_id and rel.a_custom_record_id = d.record_id
            order by rel.created_at desc limit 1) p on true
          where d.workspace_id = ${ctx.scope.workspaceId} and d.side = 'listing'
            and d.outcome is null and r.archived_at is null
            and (l.mls_number is not null or p.address is not null)
          order by l.mls_checked_at nulls first`,
    ),
  );
  if (!list.length) return;
  const record = (dealId: string, input: Record<string, unknown>) =>
    executeCommand(
      ctx.db,
      listingFeedStatus,
      { workspaceId: ctx.scope.workspaceId, dealId, ...input },
      ctx.actor,
      ctx.meta,
    ).then((r) => r.output);
  const stamp = (l: FeedListing): MlsSnapshot => ({
    ...l,
    checkedAt: new Date(ctx.now).toISOString(),
  });
  const found = new Map<string, MlsSnapshot | null>();
  try {
    const numbered = list.filter((l) => l.mls_number);
    for (let i = 0; i < numbered.length; i += 50) {
      const batch = numbered.slice(i, i + 50);
      const answer = await askFeed(ctx, {
        statuses: ['coming_soon', 'active', 'pending', 'sold', 'off_market'],
        mlsNumbers: batch.map((l) => l.mls_number!),
        limit: 100,
      });
      if (!answer) return;
      for (const l of batch) {
        const hit = answer.listings
          .filter((x) => x.mlsNumber.toLowerCase() === l.mls_number!.toLowerCase())
          .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0];
        found.set(l.deal_record_id, hit ? stamp(hit) : null);
      }
    }
    for (const l of list.filter((x) => !x.mls_number && x.address).slice(0, BY_ADDRESS_EACH_TIME)) {
      const result = await findListing(ctx, { mlsNumber: null, address: l.address });
      if (!result) return;
      // Not on the MLS yet is no news before it has a number: nothing is said.
      if (result.found) found.set(l.deal_record_id, stamp(result.found));
    }
  } catch (e) {
    if (
      e instanceof ConnectionRefused ||
      e instanceof FeedUnreachable ||
      e instanceof FeedUnsupported
    ) {
      ctx.log.warn({ err: e.message }, 'couldn’t read our listings from the feed');
      if (!found.size) return;
    } else throw e;
  }
  for (const l of list) {
    if (!found.has(l.deal_record_id)) continue;
    const out = await record(l.deal_record_id, { listing: found.get(l.deal_record_id) });
    const key = feedDiffersAlertKey(l.deal_record_id);
    if (out.differences.length)
      await raiseAddonAlert(ctx, {
        key,
        severity: 'attention',
        title: `The MLS and HandsFreeOS disagree on ${l.name}`.slice(0, 200),
        detail: out.differences.map((d) => d.words).join(' '),
        href: `/a/realestate/deals/${l.deal_record_id}/listing`,
        permission: 'realestate.use',
        customRecordId: l.deal_record_id,
        audienceUserIds: [l.owner_user_id, ...(l.team ?? [])].filter((u): u is string => !!u),
      });
    else if (out.state === 'found') await clearAddonAlert(ctx, key, 'done');
  }
}
