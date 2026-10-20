/**
 * How search ranks what it found (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, How it works, 4), the same on the
 * server and on the phone. The database only filters roughly; these decide the order.
 *
 * | Tier | What matched                                                                           |
 * | ---- | -------------------------------------------------------------------------------------- |
 * | 0    | An exact identifier: a phone, an email, a document number, an amount, a card's last 4. |
 * | 1    | Every word starts a word of the name or title; or the website's or email's domain.     |
 * | 2    | The name or title holds every word.                                                    |
 * | 3    | Another identifying field: address, city, company, phone digits, a custom field.       |
 * | 4    | Words in content: a message, a note, a file, a form answer, a knowledge item.          |
 * | 5    | A close match (a typo).                                                                |
 */
import type { SearchGroup, SearchHit } from '../schemas/search';
import { fold } from './fold';
import { kindRank } from './kinds';
import type { SearchProbes } from './probes';

export type SearchTier = 0 | 1 | 2 | 3 | 4 | 5;

/** A best match is a hit at this tier or better. */
export const BEST_TIER = 2;

/** Tier 1 or 2 for a name or a title the words match, or null when they don't all. */
export function tierOf(name: string | null | undefined, p: SearchProbes): 1 | 2 | null {
  if (!name || p.folded.length === 0) return null;
  const folded = fold(name);
  if (!p.folded.every((w) => folded.includes(w))) return null;
  return p.folded.every((w) => startsAWord(folded, w)) ? 1 : 2;
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** Whether `word` starts one of the words of `text`: at its start, or after a space or punctuation. */
function startsAWord(text: string, word: string): boolean {
  for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + 1))
    if (at === 0 || !LETTER_OR_DIGIT.test(text[at - 1]!)) return true;
  return false;
}

/** Done, won, lost, void or cancelled: kept in its kind, after the open ones (decision 25). */
const FINISHED: ReadonlySet<string> = new Set(['done', 'won', 'lost', 'void', 'cancelled']);
export const isFinished = (hit: Pick<SearchHit, 'badges'>): boolean =>
  hit.badges.some((b) => FINISHED.has(b));
const isArchived = (hit: Pick<SearchHit, 'badges'>): boolean => hit.badges.includes('archived');

const time = (at: string | null): number => (at ? Date.parse(at) : 0);

/**
 * The order inside a kind: archived after the rest; then by tier; open before finished; one-to-one messages before
 * campaign and automated sends (`automated`); the newest; then the name.
 */
export function rankHits<T extends SearchHit>(
  hits: readonly T[],
  opts: { automated?: (hit: T) => boolean } = {},
): T[] {
  const automated = opts.automated ?? (() => false);
  return [...hits].sort(
    (a, b) =>
      Number(isArchived(a)) - Number(isArchived(b)) ||
      a.tier - b.tier ||
      Number(isFinished(a)) - Number(isFinished(b)) ||
      Number(automated(a)) - Number(automated(b)) ||
      time(b.at) - time(a.at) ||
      a.title.localeCompare(b.title),
  );
}

/** The kinds a best match may come from: people, companies, leads, money, records and add-ons' own. */
function bestKind(kind: string): boolean {
  return (
    kind === 'contacts' ||
    kind === 'companies' ||
    kind === 'leads' ||
    kind === 'money' ||
    kind.includes('.')
  );
}

/**
 * The best match: the best hit overall at tier 2 or better, from contacts, companies, leads, money, a business's own
 * kinds or an add-on's, ties going to kind order. Null when nothing is that good.
 */
export function bestOf(groups: readonly SearchGroup[]): SearchHit | null {
  let best: { hit: SearchHit; rank: number } | null = null;
  for (const g of groups) {
    if (!bestKind(g.kind)) continue;
    const rank = kindRank(g.kind);
    for (const hit of g.items) {
      if (hit.tier > BEST_TIER || isArchived(hit)) continue;
      if (!best || hit.tier < best.hit.tier || (hit.tier === best.hit.tier && rank < best.rank))
        best = { hit, rank };
    }
  }
  return best?.hit ?? null;
}

/** A group's best tier, or 9 when it holds nothing. */
const topTier = (g: SearchGroup): number => Math.min(9, ...g.items.map((h) => h.tier));

/**
 * The order of the groups (decision 33): those whose best hit is tier 0 to 2 first, by that tier, ties in kind order;
 * then every other group in kind order. The chips and the Search page's kinds list follow the same order.
 */
export function orderGroups<G extends SearchGroup>(groups: readonly G[]): G[] {
  return groups
    .map((g, i) => {
      const tier = topTier(g);
      return { g, i, tier: tier <= BEST_TIER ? tier : 9, rank: kindRank(g.kind) };
    })
    .sort((a, b) => a.tier - b.tier || a.rank - b.rank || a.i - b.i)
    .map((x) => x.g);
}
