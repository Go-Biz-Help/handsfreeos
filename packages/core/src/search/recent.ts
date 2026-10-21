/**
 * Recent searches (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, decision 17), one rule for the web's, kept in
 * `localStorage`, and the phone's, kept in its own local-only table: what was typed, trimmed and cut to 120
 * characters, never under 2; at most 8 a person a business, newest first; and the same words searched again move to
 * the top rather than show twice, whatever their case or accents, as search itself folds them. Browser-safe.
 */
import { fold } from './fold';

/** Searches kept a person, a business. */
export const RECENT_SEARCHES_KEPT = 8;

/** What a search is kept as: what was typed, trimmed and cut to 120 characters; null when it's too short to keep. */
export function recentSearchText(typed: string): string | null {
  const q = typed.trim().slice(0, 120);
  return q.length >= 2 ? q : null;
}

/** Whether two searches are the same words: case and accents aside, as search folds them ("JOSÉ" and "jose"). */
export function sameSearch(a: string, b: string): boolean {
  return fold(a.trim()) === fold(b.trim());
}

/** The recent searches after one more: it first, the same words searched before taken out, the newest 8 kept. */
export function nextRecentSearches(list: readonly string[], typed: string): string[] {
  const q = recentSearchText(typed);
  if (!q) return list.slice(0, RECENT_SEARCHES_KEPT);
  return [q, ...list.filter((r) => !sameSearch(r, q))].slice(0, RECENT_SEARCHES_KEPT);
}
