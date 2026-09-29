/**
 * Voting on what's next (0109, docs/addon-architecture.md): the planned list with its votes and what's coming soon,
 * Home's note about an add-on the business voted for, and the team's view of the vote. Made by a factory over a
 * catalogue, like the other add-on queries.
 */
import { rows, sql } from '@hfos/db/client';
import { findAddon, type Catalog } from '../addons/graph';
import { loadInstallations, loadOverrides } from '../addons/load';
import { isInstalledState } from '../addons/lifecycle';
import type { AddonManifest } from '../addons/manifest';
import { addonsInRace, nextAddonPickAt, pickStageOf } from '../addons/roadmap';
import { loadBusinessVotes, loadPicks, loadVoteCounts } from '../addons/roadmap-load';
import { requireHuman } from '../kernel/actor';
import { defineQuery } from '../kernel/define';
import {
  AddonNewsInput,
  AddonNewsOutput,
  AddonPickOverviewInput,
  AddonPickOverviewOutput,
  AddonRoadmapInput,
  AddonRoadmapOutput,
} from '../schemas/addon';

/** How long Home keeps a note about a pick up, unless it's set aside first. */
export const ADDON_NEWS_DAYS = 30;
/** How many closed weeks the team's view lists. */
export const ADDON_WEEKS_SHOWN = 12;

const DAY = 86_400_000;
const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());

/** The voting queries, over a catalogue. */
export function addonRoadmapQueries(catalog: Catalog) {
  const scope = (i: { workspaceId: string }) => ({
    kind: 'workspace' as const,
    workspaceId: i.workspaceId,
  });

  const roadmap = defineQuery({
    name: 'addon.roadmap',
    description:
      'What is coming soon, and every planned add-on still up for a vote, with its votes and whether this business voted for it.',
    input: AddonRoadmapInput,
    output: AddonRoadmapOutput,
    permission: 'addons.manage',
    scope,
    async handler(ctx, input) {
      const [overrides, picks, counts, ours] = await Promise.all([
        loadOverrides(ctx.tx),
        loadPicks(ctx.tx),
        loadVoteCounts(ctx.tx),
        loadBusinessVotes(ctx.tx, input.workspaceId),
      ]);
      const picked = new Set(picks.map((p) => p.addonId));
      return {
        comingSoon: picks.flatMap((p) => {
          const m = findAddon(catalog, p.addonId);
          if (!m || pickStageOf(catalog, overrides, p.addonId) !== 'coming_soon') return [];
          return [
            {
              addonId: m.id,
              name: m.name,
              summary: m.summary,
              how: p.how,
              pickedAt: p.pickedAt.toISOString(),
              votes: counts[m.id] ?? p.votes,
              voted: ours.has(m.id),
            },
          ];
        }),
        planned: addonsInRace(catalog, overrides, picked).flatMap((id) => {
          const m = findAddon(catalog, id);
          return m
            ? [
                {
                  addonId: m.id,
                  name: m.name,
                  summary: m.summary,
                  category: m.category,
                  groups: [...(m.catalog.groups ?? [])],
                  overlap: m.catalog.overlap ?? null,
                  votes: counts[m.id] ?? 0,
                  voted: ours.has(m.id),
                },
              ]
            : [];
        }),
        nextPickAt: nextAddonPickAt(Date.now()).toISOString(),
      };
    },
  });

  const news = defineQuery({
    name: 'addon.news',
    description:
      'Home’s note, if any: an add-on this business voted for is coming soon, or ready to add. Only for people who manage add-ons.',
    input: AddonNewsInput,
    output: AddonNewsOutput,
    permission: 'workspace.read',
    scope,
    async handler(ctx, input) {
      // Only the people who could vote hear about it, and it costs everyone else nothing to ask.
      if (!(ctx.scope.workspacePermissions ?? []).includes('addons.manage')) return { news: null };
      const me = requireHuman(ctx).userId;
      const [overrides, picks, ours, installations, seen] = await Promise.all([
        loadOverrides(ctx.tx),
        loadPicks(ctx.tx),
        loadBusinessVotes(ctx.tx, input.workspaceId),
        loadInstallations(ctx.tx, input.workspaceId),
        rows<{ addon_id: string; kind: string }>(
          ctx.tx,
          sql`select addon_id, kind from platform.addon_news_seen where user_id = ${me}::uuid`,
        ),
      ]);
      const setAside = new Set(seen.map((s) => `${s.addon_id}:${s.kind}`));
      const has = new Set(
        installations.filter((i) => isInstalledState(i.state)).map((i) => i.addonId),
      );
      const since = Date.now() - ADDON_NEWS_DAYS * DAY;
      type Note = { m: AddonManifest; kind: 'picked' | 'shipped'; at: number };
      const notes = picks.flatMap((p): Note[] => {
        const m = findAddon(catalog, p.addonId);
        if (!m || !ours.has(p.addonId)) return [];
        const stage = pickStageOf(catalog, overrides, p.addonId);
        if (
          stage === 'shipped' &&
          p.shippedAt &&
          p.shippedAt.getTime() > since &&
          !has.has(p.addonId) &&
          !setAside.has(`${p.addonId}:shipped`)
        )
          return [{ m, kind: 'shipped', at: p.shippedAt.getTime() }];
        if (
          stage === 'coming_soon' &&
          p.pickedAt.getTime() > since &&
          !setAside.has(`${p.addonId}:picked`)
        )
          return [{ m, kind: 'picked', at: p.pickedAt.getTime() }];
        return [];
      });
      // Ready to add first, then the newest.
      const first = notes.sort(
        (a, b) => Number(b.kind === 'shipped') - Number(a.kind === 'shipped') || b.at - a.at,
      )[0];
      return {
        news: first
          ? { addonId: first.m.id, name: first.m.name, summary: first.m.summary, kind: first.kind }
          : null,
      };
    },
  });

  const overview = defineQuery({
    name: 'addon_pick.overview',
    description:
      'The team’s view of the vote: weeks waiting for a pick, the last weeks, every planned add-on by votes, and what’s coming soon.',
    input: AddonPickOverviewInput,
    output: AddonPickOverviewOutput,
    permission: 'platform.addons.manage',
    scope: () => ({ kind: 'platform' as const }),
    async handler(ctx) {
      const [overrides, picks, counts, weeks] = await Promise.all([
        loadOverrides(ctx.tx),
        loadPicks(ctx.tx),
        loadVoteCounts(ctx.tx),
        rows<{
          id: string;
          ends_at: Date | string;
          outcome: 'votes' | 'no_votes' | 'tie';
          addon_id: string | null;
          tied: string[];
          top_votes: number;
          decided_at: Date | string | null;
          decided_by: string | null;
        }>(
          ctx.tx,
          sql`select w.id, w.ends_at, w.outcome, w.addon_id, w.tied, w.top_votes, w.decided_at,
                nullif(btrim(s.display_name), '') as decided_by
              from platform.addon_vote_weeks w
              left join platform.staff s on s.user_id = w.decided_by
              where w.addon_id is null or w.ends_at > now() - make_interval(days => ${ADDON_WEEKS_SHOWN * 7})
              order by w.ends_at desc`,
        ),
      ]);
      const picked = new Set(picks.map((p) => p.addonId));
      const nameOf = (id: string | null) => (id ? (findAddon(catalog, id)?.name ?? id) : null);
      return {
        waiting: weeks.flatMap((w) =>
          w.addon_id === null && w.outcome !== 'votes'
            ? [
                {
                  weekId: w.id,
                  endsAt: new Date(w.ends_at).toISOString(),
                  outcome: w.outcome,
                  tied: w.tied ?? [],
                  topVotes: Number(w.top_votes),
                },
              ]
            : [],
        ),
        weeks: weeks.slice(0, ADDON_WEEKS_SHOWN).map((w) => ({
          weekId: w.id,
          endsAt: new Date(w.ends_at).toISOString(),
          outcome: w.outcome,
          addonId: w.addon_id,
          name: nameOf(w.addon_id),
          topVotes: Number(w.top_votes),
          decidedAt: iso(w.decided_at),
          decidedBy: w.decided_by,
        })),
        race: addonsInRace(catalog, overrides, picked)
          .flatMap((id) => {
            const m = findAddon(catalog, id);
            return m
              ? [{ addonId: m.id, name: m.name, category: m.category, votes: counts[m.id] ?? 0 }]
              : [];
          })
          .sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name)),
        comingSoon: picks.flatMap((p) => {
          if (pickStageOf(catalog, overrides, p.addonId) !== 'coming_soon') return [];
          return [
            {
              addonId: p.addonId,
              name: nameOf(p.addonId) ?? p.addonId,
              how: p.how,
              pickedAt: p.pickedAt.toISOString(),
              votes: counts[p.addonId] ?? p.votes,
              shippedAt: iso(p.shippedAt),
            },
          ];
        }),
        nextPickAt: nextAddonPickAt(Date.now()).toISOString(),
      };
    },
  });

  return { roadmap, news, overview };
}
