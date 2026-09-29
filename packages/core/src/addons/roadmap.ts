/**
 * Voting on what's next (0109, docs/addon-architecture.md): the rules the planned list, the vote, the weekly pick
 * and Home's note share. Browser-safe, so the web's page, the phone's screen, the API and the worker all decide the
 * same way.
 *
 * The owner's decisions (2026-09-28): one vote per business, on as many planned add-ons as it likes; votes never
 * expire; every Sunday at midnight, US Eastern, the one with the most votes becomes Coming soon, and with no votes
 * or a tie the team chooses; Coming soon stays until it ships.
 */
import { addDays, localDateOf, startOfLocalDay, weekdayOf } from '../calendar/engine/zoned';
import type { Catalog } from './graph';
import { ADDON_CATEGORIES, type AddonCategory, type CatalogStatus } from './manifest';
import { ADDON_CATEGORY_WORDS } from './words';

/** Where the week ends: US Eastern, whatever the business's own zone. */
export const ADDON_PICK_ZONE = 'America/New_York';

/**
 * The next weekly pick after `now`: the midnight that ends Sunday in US Eastern (Monday 00:00 there), daylight saving
 * and all.
 */
export function nextAddonPickAt(now: number): Date {
  const today = localDateOf(now, ADDON_PICK_ZONE);
  const toMonday = (8 - weekdayOf(today)) % 7;
  const at = startOfLocalDay(addDays(today, toMonday), ADDON_PICK_ZONE);
  return new Date(at > now ? at : startOfLocalDay(addDays(today, toMonday + 7), ADDON_PICK_ZONE));
}

/** Its status with HandsFreeOS's switch applied: what the catalogue says, unless staff took it down. */
const statusOf = (
  m: { readonly id: string; readonly catalog: { readonly status: CatalogStatus } },
  overrides: Readonly<Record<string, string>>,
) => (overrides[m.id] as CatalogStatus | undefined) ?? m.catalog.status;

/**
 * The add-ons a business can vote for now: planned in the catalogue and not picked yet. The race each week closes
 * over, and what a vote is checked against.
 */
export function addonsInRace(
  catalog: Catalog,
  overrides: Readonly<Record<string, string>>,
  picked: ReadonlySet<string>,
): string[] {
  return catalog
    .filter((m) => statusOf(m, overrides) === 'planned' && !picked.has(m.id))
    .map((m) => m.id);
}

/**
 * Where a picked add-on has got to: `coming_soon` while it can't be added yet (planned, or being built), `shipped`
 * once businesses can add it, and `gone` when it's in the catalogue no longer or HandsFreeOS took it down.
 */
export type PickStage = 'coming_soon' | 'shipped' | 'gone';

export function pickStage(status: CatalogStatus | null): PickStage {
  switch (status) {
    case 'planned':
    case 'development':
    case 'beta':
    case 'built':
      return 'coming_soon';
    case 'available':
      return 'shipped';
    default:
      return 'gone';
  }
}

export function pickStageOf(
  catalog: Catalog,
  overrides: Readonly<Record<string, string>>,
  addonId: string,
): PickStage {
  const m = catalog.find((a) => a.id === addonId);
  return pickStage(m ? statusOf(m, overrides) : null);
}

// ---------- the planned list: search, filters and order ----------

/** One planned add-on as the list shows it. */
export interface PlannedAddonView {
  readonly addonId: string;
  readonly name: string;
  readonly summary: string;
  readonly category: string;
  readonly groups: readonly string[];
  readonly overlap: string | null;
  readonly votes: number;
  /** This business voted for it. */
  readonly voted: boolean;
}

export type PlannedSort = 'votes' | 'az';
export const PLANNED_SORTS: readonly PlannedSort[] = ['votes', 'az'];

export interface PlannedFilter {
  /** What was typed: every word must be found in its name, what it does, its groups or its category. */
  readonly query: string;
  /** A category, or null for all. */
  readonly category: string | null;
  /** A group, or null for all. */
  readonly group: string | null;
}

export const NO_PLANNED_FILTER: PlannedFilter = { query: '', category: null, group: null };

const wordsOf = (text: string) => text.toLowerCase().split(/\s+/).filter(Boolean);

function haystack(a: PlannedAddonView): string {
  const category = ADDON_CATEGORY_WORDS[a.category as AddonCategory] ?? a.category;
  return [a.name, a.summary, a.overlap ?? '', category, ...a.groups].join(' ').toLowerCase();
}

/** Whether an add-on matches what was typed. */
export function matchesPlannedQuery(a: PlannedAddonView, query: string): boolean {
  const words = wordsOf(query);
  if (!words.length) return true;
  const text = haystack(a);
  return words.every((w) => text.includes(w));
}

/** The planned list with the search, category and group applied, in the order asked for. */
export function filterPlanned(
  list: readonly PlannedAddonView[],
  filter: PlannedFilter,
  sort: PlannedSort,
): PlannedAddonView[] {
  const shown = list.filter(
    (a) =>
      matchesPlannedQuery(a, filter.query) &&
      (!filter.category || a.category === filter.category) &&
      (!filter.group || a.groups.includes(filter.group)),
  );
  return shown.sort(
    (a, b) => (sort === 'votes' ? b.votes - a.votes : 0) || a.name.localeCompare(b.name),
  );
}

/** How many match the search in each category (and `all`), for the category chips. */
export function plannedCategoryCounts(
  list: readonly PlannedAddonView[],
  query: string,
): Record<string, number> {
  const counts: Record<string, number> = { all: 0 };
  for (const c of ADDON_CATEGORIES) counts[c] = 0;
  for (const a of list) {
    if (!matchesPlannedQuery(a, query)) continue;
    counts['all'] = (counts['all'] ?? 0) + 1;
    counts[a.category] = (counts[a.category] ?? 0) + 1;
  }
  return counts;
}

/** The categories that have planned add-ons, in the catalogue's order. */
export function plannedCategories(list: readonly PlannedAddonView[]): AddonCategory[] {
  return ADDON_CATEGORIES.filter((c) => list.some((a) => a.category === c));
}

/** The groups to filter by within a category (or all of them), A to Z. */
export function plannedGroups(
  list: readonly PlannedAddonView[],
  category: string | null,
): string[] {
  const groups = new Set<string>();
  for (const a of list)
    if (!category || a.category === category) a.groups.forEach((g) => groups.add(g));
  return [...groups].sort((a, b) => a.localeCompare(b));
}

/** A vote's new count, shown at once while the vote goes out (the server's answer replaces it). */
export function withVote(a: PlannedAddonView, voted: boolean): PlannedAddonView {
  if (a.voted === voted) return a;
  return { ...a, voted, votes: Math.max(0, a.votes + (voted ? 1 : -1)) };
}
