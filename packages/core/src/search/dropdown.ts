/**
 * What the dropdown under the search box shows, worked out once for the web and the phone
 * (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "Web: the box and its dropdown"): the chips, the best match, a few
 * groups, "Also found", and which line goes at the top. The client merges its own Settings group in first, so the
 * close-match line, the no-one-active line and the empty state are decided with the settings it found, and the counts
 * include them.
 */
import type { SearchEverythingOutput, SearchGroup, SearchHit } from '../schemas/search';
import { bestOf, orderGroups } from './rank';
import { SEARCH_KIND_LABELS, SEARCH_WORDS } from './words';

export interface DropdownChip {
  /** 'all', or a group's kind. */
  readonly kind: string;
  readonly label: string;
  readonly count: number;
  readonly capped: boolean;
}

export interface DropdownGroup {
  readonly group: SearchGroup;
  readonly label: string;
  /** The rows shown. */
  readonly rows: readonly SearchHit[];
  /** How many more "See all" opens. */
  readonly more: number;
}

export interface Dropdown {
  /** The line at the top, or null: close matches, nobody active, or nothing at all. */
  readonly line: 'close' | 'none_active' | 'empty' | null;
  /** Everything found, the Settings group included. */
  readonly total: number;
  readonly capped: boolean;
  readonly chips: readonly DropdownChip[];
  /** The best match, taken out of its group. Null under an exact match. */
  readonly best: SearchHit | null;
  /**
   * When a phone, an email or a number was typed and something matched it exactly: those hits, under "Exact match",
   * and the groups below under "Also has 1042 in it". Null otherwise.
   */
  readonly exact: readonly SearchHit[] | null;
  readonly groups: readonly DropdownGroup[];
  /** The groups that didn't fit: "Also found: Calendar 2 · Tasks 1". */
  readonly alsoFound: readonly { kind: string; label: string; total: number; capped: boolean }[];
  /** Kinds that were slow, skipped or failed this time, each with its own line (`unavailableLine`) and Try again. */
  readonly unavailable: readonly SearchGroup[];
  /** Shown only when the active groups hold fewer than 3 hits (decision 28). */
  readonly archived: SearchGroup | null;
  readonly bin: SearchGroup | null;
}

/** A group's heading: a business's own kind or an add-on's carries its own; core names the rest. */
export function groupLabel(group: Pick<SearchGroup, 'kind' | 'label'>): string {
  return (
    group.label ??
    (SEARCH_KIND_LABELS as Readonly<Record<string, string>>)[group.kind] ??
    group.kind
  );
}

/**
 * The line for a group that didn't answer, with its Try again: "Contacts took too long to search. Try again, or pick
 * Contacts on its own." The business's own kinds, which have no one chip, only say Try again. Null when it answered.
 */
export function unavailableLine(
  group: Pick<SearchGroup, 'kind' | 'label' | 'unavailable'>,
): string | null {
  if (!group.unavailable) return null;
  const label = groupLabel(group);
  if (group.unavailable === 'failed') return SEARCH_WORDS.failed(label);
  if (group.kind === 'records')
    return group.unavailable === 'too_slow'
      ? SEARCH_WORDS.ownKindsTooSlow
      : SEARCH_WORDS.ownKindsSkipped;
  return group.unavailable === 'too_slow'
    ? SEARCH_WORDS.tooSlow(label)
    : SEARCH_WORDS.skipped(label);
}

/** Archived and the bin show in the dropdown only when the active groups found fewer than this. */
const FEW_ACTIVE = 3;

/**
 * The dropdown for an answer and the Settings group the device found (null when none). `maxGroups` groups of up to
 * 3 rows show (2 a group when more than 3 groups show), `maxRows` rows at most in all.
 */
export function dropdownOf(
  answer: SearchEverythingOutput,
  settings: SearchGroup | null,
  opts: { maxGroups?: number; maxRows?: number } = {},
): Dropdown {
  const maxGroups = opts.maxGroups ?? 5;
  const maxRows = opts.maxRows ?? 10;
  const settingsFound = !!settings && settings.items.length > 0;
  // A setting that matched means the words were spelled right: no close matches over it.
  const serverGroups = answer.close && settingsFound ? [] : answer.groups;
  const merged = orderGroups([...serverGroups, ...(settingsFound ? [settings] : [])]);
  const found = merged.filter((g) => g.items.length > 0 || g.total > 0);
  const unavailable = merged.filter((g) => g.unavailable && g.items.length === 0);
  const total = found.reduce((n, g) => n + g.total, 0);
  const capped = found.some((g) => g.capped);

  const exactMode =
    ['phone', 'email', 'number'].includes(answer.probes.looksLike) &&
    found.some((g) => g.items.some((h) => h.exact));
  const exact = exactMode ? found.flatMap((g) => g.items.filter((h) => h.exact)) : null;
  const best = exactMode || answer.close ? null : (answer.best ?? bestOf(found));
  const taken = new Set<SearchHit>([...(exact ?? []), ...(best ? [best] : [])]);
  const sameHit = (h: SearchHit) =>
    taken.has(h) || (!!best && h.kind === best.kind && h.id === best.id);

  const withRows = found
    .map((g) => ({ g, left: g.items.filter((h) => !sameHit(h)) }))
    .filter((x) => x.left.length > 0);
  const shown = withRows.slice(0, maxGroups);
  const perGroup = shown.length > 3 ? 2 : 3;
  let budget = Math.max(0, maxRows - (best ? 1 : 0) - (exact?.length ?? 0));
  const groups: DropdownGroup[] = [];
  for (const { g, left } of shown) {
    const rows = left.slice(0, Math.min(perGroup, budget));
    if (rows.length === 0) break;
    budget -= rows.length;
    groups.push({
      group: g,
      label: groupLabel(g),
      rows,
      more: Math.max(0, g.total - rows.length - (g.items.length - left.length)),
    });
  }
  const placed = new Set(groups.map((d) => d.group));
  const alsoFound = withRows
    .filter((x) => !placed.has(x.g))
    .map((x) => ({ kind: x.g.kind, label: groupLabel(x.g), total: x.g.total, capped: x.g.capped }));

  const fewActive = total < FEW_ACTIVE;
  const archived = fewActive && answer.archived?.items.length ? answer.archived : null;
  const bin = fewActive && answer.bin?.items.length ? answer.bin : null;
  // Nobody active, and nothing at all, only when every kind answered: the lines of those that didn't say so instead.
  const line: Dropdown['line'] = answer.tooShort
    ? null
    : answer.close && !settingsFound && total > 0
      ? 'close'
      : total > 0 || unavailable.length > 0
        ? null
        : answer.archived?.items.length || answer.bin?.items.length
          ? 'none_active'
          : 'empty';

  return {
    line,
    total,
    capped,
    chips: [
      { kind: 'all', label: 'All', count: total, capped },
      ...found.map((g) => ({
        kind: g.kind,
        label: groupLabel(g),
        count: g.total,
        capped: g.capped,
      })),
    ],
    best,
    exact,
    groups,
    alsoFound,
    unavailable,
    archived,
    bin,
  };
}
