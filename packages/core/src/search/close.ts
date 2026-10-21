/**
 * Close matches, for a typo (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, decision 26): only when nothing else matched,
 * on contact, company, lead and record names. The database finds up to 300 names that look roughly alike (trigrams);
 * this decides which are close, by edit distance that counts two swapped letters as one change, so "dnaa smtih" finds
 * Dana Smith. Browser-safe: the phone runs the same check on its own copy.
 */
import { fold } from './fold';

/** Close matching needs a typed word of at least this many letters. */
export const CLOSE_MIN_LETTERS = 4;

/**
 * Optimal string alignment distance: insertions, deletions, substitutions, and two neighbouring letters swapped,
 * each one change. `osaDistance('dnaa', 'dana')` is 1.
 */
export function osaDistance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  const d: number[][] = Array.from({ length: x.length + 1 }, (_, i) =>
    Array.from({ length: y.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= x.length; i++)
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1])
        best = Math.min(best, d[i - 2]![j - 2]! + 1);
      d[i]![j] = best;
    }
  return d[x.length]![y.length]!;
}

/** How many changes a typed word may be from a name's word: 1 for 4 to 7 letters, 2 for 8 or more, none below. */
export function closeAllowance(word: string): number {
  const n = [...word].length;
  return n >= 8 ? 2 : n >= CLOSE_MIN_LETTERS ? 1 : 0;
}

/**
 * Whether a typed word (folded) is close to a word: within its allowance. Lengths further apart than that can't be,
 * so they're turned away before the distance is worked out, which keeps a long pasted word cheap.
 */
export function wordIsClose(typed: string, word: string): boolean {
  const allowed = closeAllowance(typed);
  return (
    Math.abs([...typed].length - [...word].length) <= allowed && osaDistance(typed, word) <= allowed
  );
}

/** Whether close matches are worth looking for: some typed word has 4 or more letters. */
export function closeWorthTrying(folded: readonly string[]): boolean {
  return folded.some((w) => [...w].length >= CLOSE_MIN_LETTERS);
}

/** How many of the typed words (folded) are close to one of a name's words. */
export function closeWords(name: string, folded: readonly string[]): number {
  const words = fold(name)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return folded.filter((typed) => words.some((w) => wordIsClose(typed, w))).length;
}

/**
 * The names close to what was typed, in order: close on every word first, then by how many, keeping the order they
 * came in (the database's best look-alike first) between equals. A name close on no word is left out.
 */
export function closeMatches<T>(
  candidates: readonly T[],
  nameOf: (c: T) => string,
  folded: readonly string[],
): T[] {
  return candidates
    .map((c, i) => ({ c, i, n: closeWords(nameOf(c), folded) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .map((x) => x.c);
}
