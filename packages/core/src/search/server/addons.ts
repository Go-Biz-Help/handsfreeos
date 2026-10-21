/**
 * Add-ons answering a search, server side (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "Add-ons answer searches"):
 * which add-ons answer for this person, each one's query run through the kernel (`executeQueryWithin`) inside the
 * search's own transaction and its own `step`, and what it answers held to core's rules. Core never names an add-on
 * and never reads an `addon_<id>` table: it reaches add-ons only through the module list, as the teammate's tools do.
 *
 * `runSearchEverything` and `runSearchKind` (./run.ts) call these, and keep any failure of an add-on's (turned off
 * mid-search, a timeout, a bug) to its own groups, marked `failed`, logged as its id and SQLSTATE at most.
 */
import type { AddonManifest, AddonSearchDeclaration } from '../../addons/manifest';
import { ADDON_SERVER_MODULES } from '../../addons/modules';
import type { AddonServerModule } from '../../addons/server';
import { executeQueryWithin } from '../../kernel/execute';
import type { QueryDef } from '../../kernel/types';
import type { WorkspacePermission } from '../../permissions';
import type { SearchGroup, SearchHit } from '../../schemas/search';
import {
  AddonSearchInput,
  AddonSearchOutput,
  addonHrefOk,
  addonSearchKindKey,
  type AddonSearchHit,
} from '../addon';
import { BEST_TIER, rankHits } from '../rank';
import { hitOf } from './hit';
import type { SearchDb, SearchPlan } from './run';

/** How long an add-on's search statement may take: the smaller of this and what's left of the request's budget. */
export const CONTRIBUTOR_MS = { quick: 1_500, full: 3_000 } as const;

/** An add-on's count is shown up to this in the box and on the Search page ("50+"). */
export const ADDON_COUNT_CAP = 50;

/** An add-on that answers searches: its manifest, its declaration and its query. */
export interface SearchContributor {
  readonly manifest: AddonManifest;
  readonly search: AddonSearchDeclaration;
  readonly query: QueryDef;
}

const queryOf = (module: AddonServerModule, name: string): QueryDef | undefined =>
  (module.queries ?? []).find((q) => q.name === name);

/** What keeps a declared search query from being run as one. */
function queryIssues(m: AddonManifest, s: AddonSearchDeclaration, op: QueryDef): string[] {
  const issues: string[] = [];
  const say = (what: string) => issues.push(`${m.id}: search query "${op.name}" ${what}`);
  if (op.addon?.id !== m.id) say("isn't one of its own (defineAddonQuery)");
  // Core asks it for the people holding the declared permission: asking for another would fail for some of them.
  if (op.permission !== s.permission)
    say(`asks for "${op.permission}", but the search runs for "${s.permission}"`);
  const actors = op.actors ?? ['human'];
  if (actors.length !== 1 || actors[0] !== 'human') say('is for people alone');
  if (op.input !== AddonSearchInput) say("must take core's AddonSearchInput, the same object");
  if (op.output !== AddonSearchOutput) say("must answer core's AddonSearchOutput, the same object");
  if (op.ai) say("isn't offered to the AI");
  if (op.route !== false)
    say('must be marked route: false, so it never runs outside a search, around its limits');
  return issues;
}

/**
 * What would keep an add-on's search from working as declared, for the tests to print over every module: a query it
 * doesn't have, or one that isn't its own, asks for another permission than the declaration's, isn't for people
 * alone, takes or answers anything but core's shapes, declares `ai`, or isn't marked `route: false`.
 * `manifestIssues` checks the declaration itself (its query's name, its kinds, `covers` and its permission).
 */
export function addonSearchIssues(modules: readonly AddonServerModule[]): string[] {
  return modules.flatMap((module) => {
    const s = module.manifest.search;
    if (!s) return [];
    const op = queryOf(module, s.query);
    return op
      ? queryIssues(module.manifest, s, op)
      : [`${module.manifest.id}: search runs "${s.query}", which it doesn't have`];
  });
}

/** Every add-on that answers searches, in the modules' order: what `addonSearchIssues` lets through. */
export function searchContributors(
  modules: readonly AddonServerModule[] = ADDON_SERVER_MODULES,
): SearchContributor[] {
  return modules.flatMap((module) => {
    const s = module.manifest.search;
    const query = s && queryOf(module, s.query);
    return s && query && queryIssues(module.manifest, s, query).length === 0
      ? [{ manifest: module.manifest, search: s, query }]
      : [];
  });
}

/** Its kinds the search asks for: null for every one, when no chip is picked. */
const kindsAsked = (c: SearchContributor, plan: Pick<SearchPlan, 'kinds'>): string[] | null =>
  plan.kinds
    ? c.search.kinds
        .map((k) => k.key)
        .filter((k) => plan.kinds!.has(addonSearchKindKey(c.manifest.id, k)))
    : null;

/**
 * The add-ons to ask: those the person may use (`can`, everything under a staff view-as) and, when chips are picked,
 * only those with a picked kind. Every one when none are picked. Whether each runs here is checked once a request,
 * after.
 */
export function contributorsAsked(
  all: readonly SearchContributor[],
  plan: Pick<SearchPlan, 'can' | 'kinds'>,
): SearchContributor[] {
  return all.filter(
    (c) =>
      plan.can(c.search.permission as WorkspacePermission) && kindsAsked(c, plan)?.length !== 0,
  );
}

/**
 * Whether a search asks an add-on for every kind it has, so what it covers may leave core's groups: chips naming only
 * some may leave out the ones that find those records.
 */
export const asksEveryKind = (c: SearchContributor, plan: Pick<SearchPlan, 'kinds'>): boolean =>
  (kindsAsked(c, plan) ?? c.search.kinds).length === c.search.kinds.length;

/** The add-on whose kind a group kind (`realestate.listings`) is, and the kind; null for anything else. */
export function contributorOfKind(
  all: readonly SearchContributor[],
  groupKind: string,
): { c: SearchContributor; kind: AddonSearchDeclaration['kinds'][number] } | null {
  const dot = groupKind.indexOf('.');
  if (dot < 0) return null;
  const c = all.find((x) => x.manifest.id === groupKind.slice(0, dot));
  const kind = c?.search.kinds.find((k) => k.key === groupKind.slice(dot + 1));
  return c && kind ? { c, kind } : null;
}

/** Asks an add-on for its answer, through the kernel, in the step it's handed: its kinds asked, and a page's place. */
export async function askContributor(
  db: SearchDb,
  plan: SearchPlan,
  c: SearchContributor,
  page: { readonly sort?: SearchPlan['sort']; readonly cursor?: string } = {},
): Promise<AddonSearchOutput> {
  const asked = kindsAsked(c, plan);
  // Core's probes, but never what was typed: the input's shape is the same, its lists only not marked read-only.
  const { q: _typed, ...probes } = plan.p;
  const input: AddonSearchInput = {
    workspaceId: plan.workspaceId,
    probes: probes as AddonSearchInput['probes'],
    ...(asked ? { kinds: asked } : {}),
    perKind: plan.perKind,
    includeArchived: plan.includeArchived,
    onlyMine: plan.onlyMine,
    depth: plan.depth,
    ...(page.sort ? { sort: page.sort } : {}),
    ...(page.cursor ? { cursor: page.cursor } : {}),
  };
  const out = await db.run((sp) => executeQueryWithin({ ...plan.ctx, tx: sp }, c.query, input));
  return out as AddonSearchOutput;
}

/** A hit of an add-on's as core's: its link under the business, its marks inside its snippet. */
function hitFrom(
  c: SearchContributor,
  plan: SearchPlan,
  kind: string,
  h: AddonSearchHit,
): SearchHit {
  const s = h.why.snippet;
  return hitOf({
    kind,
    id: h.id,
    title: h.title,
    subtitle: h.subtitle,
    badges: h.badges,
    why: {
      field: h.why.label || h.tier > BEST_TIER ? 'addon' : 'name',
      label: h.why.label,
      snippet: s
        ? { text: s.text, marks: s.marks.filter(([a, b]) => a >= 0 && a < b && b <= s.text.length) }
        : null,
      page: null,
    },
    tier: h.tier,
    exact: h.exact,
    at: h.at,
    href: `/app/w/${plan.workspaceId}${h.href}`,
  });
}

/**
 * An add-on's answer as core's groups: only its own kinds, each once and only when asked for; a hit whose link isn't
 * one of its own pages or its record's dropped, and an archived one unless archived records were asked for; a few
 * hits a kind (ranked on core's scale in the box and on the Search page, in the add-on's own order on a kind's page),
 * and its count shown up to `countUpTo`: 50, or on a kind's own page as far as core's kinds count there.
 */
export function contributorGroups(
  c: SearchContributor,
  plan: SearchPlan,
  out: AddonSearchOutput,
  countUpTo: number = ADDON_COUNT_CAP,
): { group: SearchGroup; nextCursor: string | null }[] {
  const declared = new Map(c.search.kinds.map((k) => [k.key, k]));
  const seen = new Set<string>();
  const answered: { group: SearchGroup; nextCursor: string | null }[] = [];
  for (const g of out.groups) {
    const kind = declared.get(g.kind);
    const key = addonSearchKindKey(c.manifest.id, g.kind);
    if (!kind || seen.has(g.kind) || (plan.kinds && !plan.kinds.has(key))) continue;
    seen.add(g.kind);
    const kept = g.items.filter(
      (h) =>
        addonHrefOk(c.manifest.id, h) && (plan.includeArchived || !h.badges.includes('archived')),
    );
    const hits = kept.map((h) => hitFrom(c, plan, key, h));
    const items = (plan.mode === 'everything' ? rankHits(hits) : hits).slice(0, plan.perKind);
    const total = Math.max(g.total - (g.items.length - kept.length), kept.length);
    answered.push({
      group: {
        kind: key,
        label: kind.plural,
        icon: kind.icon,
        total: Math.min(total, countUpTo),
        capped: g.capped || total > countUpTo,
        complete: true,
        searchedBack: null,
        unavailable: null,
        items,
      },
      nextCursor: g.nextCursor,
    });
  }
  return answered;
}

/** One line for an add-on that couldn't answer: "Real Estate couldn’t be searched just now", its own name. */
export function failedGroup(c: SearchContributor): SearchGroup {
  return {
    kind: c.manifest.id,
    label: c.manifest.name,
    icon: null,
    total: 0,
    capped: false,
    complete: false,
    searchedBack: null,
    unavailable: 'failed',
    items: [],
  };
}
