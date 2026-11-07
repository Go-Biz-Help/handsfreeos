/**
 * The Add-ons page, the vote on what's next and the Roadmap as the Assistant reads them: what each card says on the
 * screen, in the words both apps share (packages/core/src/addons/words.ts, ideas/words.ts), so the model can answer
 * "why is it stuck?", "can I add it?" and "what did we vote for?" the way the page would, and never offers what the
 * page wouldn't.
 */
import {
  ADDON_CATALOG,
  ADDON_CATEGORY_WORDS,
  ADDON_PAGE_WORDS as W,
  ADDON_STATE_WORDS,
  addonBlockedWords,
  addonCategoryLine,
  addonCheckWords,
  addonOffer,
  addonOfferNote,
  filterPlanned,
  findAddon,
  IDEA_STATUS_MEANING,
  IDEA_STATUS_WORDS,
  IDEAS_WORDS,
  plannedCategories,
  plannedCategoryCounts,
  plannedGroups,
  type AddonCategory,
  type AddonManifest,
  type AddonOffer,
  type InstallationState,
  type PlannedAddonView,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import type { ToolContext } from './runtime';
import { query } from './tools-read';

type Args = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
/** Somebody else's words, marked so the model reads them as what they wrote and nothing more. */
const theirs = (text: string) => ({ someone_wrote: text });

// ---------- the Add-ons page (get_settings, area add_ons) ----------

interface AddonList {
  installed: {
    addonId: string;
    name: string;
    summary: string;
    state: InstallationState;
    lastError: string | null;
    failedChecks: string[];
    retired: boolean;
    status: string | null;
    running: boolean;
  }[];
  capabilities: { installable: { provider: string }[] };
  catalog: {
    addonId: string;
    name: string;
    summary: string;
    status: string;
    testing: boolean;
  }[];
}

/**
 * What one add-on's card says beyond its name: its category, its longer description, What it lets you do, and What it
 * needs and Works with, each with why. Nothing for one this build has no code for (retired).
 */
function aboutAddon(m: AddonManifest | undefined) {
  if (!m) return {};
  const nameOf = (id: string) => findAddon(ADDON_CATALOG, id)?.name ?? id;
  const needs = (kind: 'required' | 'optional') =>
    (m.requires ?? [])
      .filter((d) => d.kind === kind)
      .map((d) => ({ addonId: d.addon, name: nameOf(d.addon), why: d.why }));
  const required = needs('required');
  const optional = needs('optional');
  const category = addonCategoryLine(m.category);
  return {
    ...(category ? { category } : {}),
    ...(m.description.trim() !== m.summary.trim() ? { description: m.description } : {}),
    whatItLetsYouDo: m.capabilities.map((c) => ({ label: c.label, description: c.description })),
    whatItNeeds: required.length ? required : W.needsNothing,
    ...(optional.length ? { worksWith: optional } : {}),
  };
}

/**
 * The Add-ons page as its cards say it: In this business, each add-on with where it stands in the page's words (or
 * HandsFreeOS has switched it off, or no longer has it), the Testing badge, the trouble callout with each check that
 * failed, and how one that was removed could come back; then Available to add, with the ones handed to the business to
 * test, each with Install or the note in its place (a paid one, or what it needs that can't come). Its id goes with
 * each: manage_add_on, update_addon_settings and the rest take it.
 */
export function addOnsRead(v: unknown): unknown {
  const list = v as AddonList | null;
  if (!list || !Array.isArray(list.installed)) return v;
  const stateOf = (id: string): InstallationState | null =>
    list.installed.find((i) => i.addonId === id)?.state ?? null;
  // What HandsFreeOS says this business could add now: available, free, and everything it needs can come too.
  const installable = new Set((list.capabilities?.installable ?? []).map((c) => c.provider));
  const catalog = list.catalog ?? [];
  const testing = new Set(catalog.filter((c) => c.testing).map((c) => c.addonId));
  const here = new Set(list.installed.map((i) => i.addonId));
  const blockedBy = (m: AddonManifest | undefined, offer: AddonOffer | null) =>
    offer === 'blocked' && m
      ? addonBlockedWords(ADDON_CATALOG, m, stateOf, (id) => installable.has(id))
      : null;
  return {
    inThisBusiness: list.installed.map((i) => {
      const m = findAddon(ADDON_CATALOG, i.addonId);
      const words = ADDON_STATE_WORDS[i.state];
      // On here, but not running: HandsFreeOS has switched it off everywhere for now.
      const paused = i.state === 'enabled' && !i.running && !i.retired;
      const offer = addonOffer(i.state, m, i.status, installable.has(i.addonId));
      const comesBack = i.retired ? null : addonOfferNote(offer, blockedBy(m, offer));
      return {
        addonId: i.addonId,
        name: i.name,
        ...(i.summary ? { summary: i.summary } : {}),
        state: words.label,
        ...(paused
          ? { note: W.paused(i.name) }
          : i.retired
            ? { note: W.retired }
            : { whatThatMeans: words.detail }),
        running: i.running,
        ...(testing.has(i.addonId) ? { testing: W.testingDetail } : {}),
        // Only while there's trouble, as the page says it: the checks that failed, each in its words.
        ...(i.lastError !== null
          ? {
              trouble: i.failedChecks.length
                ? [W.troubleChecks, ...i.failedChecks.map(addonCheckWords)]
                : W.trouble,
            }
          : {}),
        ...(comesBack ? { inPlaceOfInstall: comesBack } : {}),
        ...aboutAddon(m),
      };
    }),
    availableToAdd: catalog
      .filter((c) => (c.status === 'available' || c.testing) && !here.has(c.addonId))
      .map((c) => {
        const m = findAddon(ADDON_CATALOG, c.addonId);
        const canInstall = installable.has(c.addonId);
        const offer = addonOffer(null, m, c.status, canInstall);
        // In place of Install, as the card says it: a paid one, one support hands out, what it needs that can't come.
        const note = addonOfferNote(offer, blockedBy(m, offer));
        return {
          addonId: c.addonId,
          name: c.name,
          summary: c.summary,
          canInstall,
          ...(note ? { inPlaceOfInstall: note } : {}),
          ...(c.testing ? { testing: W.testingDetail } : {}),
          ...aboutAddon(m),
        };
      }),
  };
}

interface AddonRoadmap {
  comingSoon: {
    addonId: string;
    name: string;
    summary: string;
    votes: number;
    voted: boolean;
  }[];
  planned: PlannedAddonView[];
  nextPickAt: string;
}

/**
 * Coming soon and the vote, summed up for get_settings: what's coming with whether the business voted for it, the
 * most-voted handful, and what the business voted for, each with its id (do_addon_vote and do_addon_unvote take it).
 * The whole list, searched and filtered as the page does, is read_addon_roadmap's.
 */
export function voteRead(v: unknown): unknown {
  const roadmap = v as AddonRoadmap | null;
  if (!roadmap || !Array.isArray(roadmap.planned)) return v;
  const planned = roadmap.planned;
  return {
    comingSoon: (roadmap.comingSoon ?? []).map((c) => ({
      addonId: c.addonId,
      name: c.name,
      summary: c.summary,
      youVoted: c.voted,
    })),
    mostVotes: [...planned]
      .sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name))
      .slice(0, 5)
      .map((p) => ({ addonId: p.addonId, name: p.name, votes: p.votes, youVoted: p.voted })),
    youVotedFor: planned.filter((p) => p.voted).map((p) => ({ addonId: p.addonId, name: p.name })),
    planned: planned.length,
    nextPickAt: roadmap.nextPickAt ?? null,
    howItWorks: W.voteDetail,
    note: 'read_addon_roadmap lists and searches every planned add-on, with its votes, category and groups.',
  };
}

/** The two parts together, as the page draws them: Coming soon leaves out what the business already has. */
export function addOnsTidy(parts: Record<string, unknown>): Record<string, unknown> {
  const addOns = parts['addOns'] as { inThisBusiness?: { addonId: string }[] } | null;
  const vote = parts['vote'] as { comingSoon?: { addonId: string }[] } | null;
  if (!addOns?.inThisBusiness || !vote?.comingSoon) return parts;
  const here = new Set(addOns.inThisBusiness.map((i) => i.addonId));
  return {
    ...parts,
    vote: { ...vote, comingSoon: vote.comingSoon.filter((c) => !here.has(c.addonId)) },
  };
}

// ---------- the screens' look-ups (read_addon_roadmap, read_idea_roadmap, read_addon_connection_list) ----------

/** How many planned add-ons one answer lists unless asked for more. */
const PLANNED_FIRST = 20;

/**
 * Vote on what's next as the page filters it: Coming soon first (without what the business has), then the planned
 * add-ons with the search, category and group applied in the order asked for, the category chips with their counts,
 * the groups to filter by, and each add-on's tags and Already in HandsFreeOS.
 */
export function plannedRead(got: unknown, args: Args, here: ReadonlySet<string>): unknown {
  const roadmap = got as AddonRoadmap | null;
  if (!roadmap || !Array.isArray(roadmap.planned)) return got;
  const filter = {
    query: str(args['search']) ?? '',
    category: str(args['category']) ?? null,
    group: str(args['group']) ?? null,
  };
  const matched = filterPlanned(roadmap.planned, filter, args['sort'] === 'az' ? 'az' : 'votes');
  const limit = typeof args['limit'] === 'number' ? args['limit'] : PLANNED_FIRST;
  const counts = plannedCategoryCounts(roadmap.planned, filter.query);
  const label = (c: string) => ADDON_CATEGORY_WORDS[c as AddonCategory] ?? c;
  return {
    comingSoon: roadmap.comingSoon
      .filter((c) => !here.has(c.addonId))
      .map((c) => ({
        addonId: c.addonId,
        name: c.name,
        summary: c.summary,
        votes: c.votes,
        ...(c.voted ? { youVoted: W.comingSoonVoted } : {}),
      })),
    howItWorks: W.voteDetail,
    nextPickAt: roadmap.nextPickAt,
    categories: [
      { category: 'all', label: W.allCategories, count: counts['all'] ?? 0 },
      ...plannedCategories(roadmap.planned).map((c) => ({
        category: c,
        label: label(c),
        count: counts[c] ?? 0,
      })),
    ],
    groups: plannedGroups(roadmap.planned, filter.category),
    shown: W.plannedCount(matched.length),
    ...(matched.length > limit
      ? {
          more: matched.length - limit,
          note: `Only the first ${limit} that match are here: narrow it with search, category or group, or ask for a larger limit.`,
        }
      : {}),
    planned: matched.slice(0, limit).map((a) => ({
      addonId: a.addonId,
      name: a.name,
      summary: a.summary,
      category: label(a.category),
      groups: a.groups,
      ...(a.overlap ? { alreadyInHandsFreeOS: a.overlap } : {}),
      votes: a.votes,
      youVoted: a.voted,
    })),
  };
}

type RoadmapCard = {
  id: string;
  number: number;
  title: string;
  areaId: string;
  voteCount: number;
  voted: boolean;
  statusChangedAt: string | null;
};
const COLUMNS = [
  ['planned', 'planned'],
  ['in_progress', 'inProgress'],
  ['done', 'done'],
] as const;
/** How many cards of each column the Roadmap's read lists, and how many of one column asked for on its own. */
const ROADMAP_FIRST = 15;
const ROADMAP_COLUMN = 60;

/**
 * The Roadmap tab as it shows it: Planned, In progress and Done lately (the last 90 days, newest first), each with
 * what it means, its count and its cards. Without `column`, each column's first cards, so Done lately is never the
 * part that's cut for length; with it, far more of that one column.
 */
export function roadmapRead(
  got: unknown,
  args: Args,
  areas: readonly { id: string; name: string }[],
): unknown {
  const roadmap = got as Record<(typeof COLUMNS)[number][1], RoadmapCard[]> | null;
  if (!roadmap || !Array.isArray(roadmap.planned)) return got;
  const areaOf = (id: string) => areas.find((a) => a.id === id)?.name ?? id;
  const column = str(args['column']);
  return {
    columns: COLUMNS.filter(([status]) => !column || status === column).map(([status, key]) => {
      const cards = roadmap[key] ?? [];
      const shown = cards.slice(0, column ? ROADMAP_COLUMN : ROADMAP_FIRST);
      return {
        column: status === 'done' ? IDEAS_WORDS.doneLately : IDEA_STATUS_WORDS[status],
        status,
        means:
          status === 'done'
            ? `${IDEA_STATUS_MEANING.done} Shipped in the last 90 days, newest first.`
            : IDEA_STATUS_MEANING[status],
        count: cards.length,
        ...(cards.length ? {} : { empty: IDEAS_WORDS.roadmapEmpty[status] }),
        cards: shown.map((c) => ({
          ideaId: c.id,
          number: c.number,
          title: theirs(c.title),
          area: areaOf(c.areaId),
          votes: c.voteCount,
          ...(c.voted ? { youVoted: true } : {}),
          ...(c.statusChangedAt ? { since: c.statusChangedAt.slice(0, 10) } : {}),
        })),
        ...(shown.length < cards.length
          ? {
              more: cards.length - shown.length,
              note: column
                ? `find_ideas with status ${status} reads the rest, a page at a time.`
                : `Ask again with column ${status} for more of it.`,
            }
          : {}),
      };
    }),
  };
}

/** An add-on's connections, with the link to its Connections page (its own tab, when it keeps one). */
export function connectionsRead(
  got: unknown,
  args: Args,
  workspaceId: string,
  webUrl: string,
): unknown {
  const addonId = str(args['addonId']);
  if (!got || typeof got !== 'object' || !addonId) return got;
  return {
    ...(got as object),
    page: `${webUrl.replace(/\/+$/, '')}/app/w/${workspaceId}/addons/${addonId}/connections`,
  };
}

/** The screens' look-ups this file says in the screens' words, by query. */
export const addonsPageReads: Readonly<
  Record<
    string,
    (got: unknown, args: Args, db: Db, ctx: ToolContext, webUrl: string) => Promise<unknown>
  >
> = {
  // Coming soon leaves out the add-ons the business has, as the page does.
  'addon.roadmap': async (got, args, db, ctx) => {
    const list = await query<AddonList>(db, ctx, 'addon.list').catch(() => null);
    return plannedRead(got, args, new Set((list?.installed ?? []).map((i) => i.addonId)));
  },
  // Each card's area by its name, as the Roadmap shows it.
  'idea.roadmap': async (got, args, db, ctx) => {
    const areas = await query<{ areas: { id: string; name: string }[] }>(
      db,
      ctx,
      'idea.areas',
    ).catch(() => null);
    return roadmapRead(got, args, areas?.areas ?? []);
  },
  'addon_connection.list': async (got, args, _db, ctx, webUrl) =>
    connectionsRead(got, args, ctx.workspaceId, webUrl),
};
