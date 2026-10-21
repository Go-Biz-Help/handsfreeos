/**
 * Recent searches' one rule (search/recent.ts), which the web's `localStorage` list and the phone's own table both
 * keep: at most 8, newest first, what was typed cut to 120 characters and never under 2, and the same words searched
 * again moving up, whatever their case or accents.
 */
import { describe, expect, it } from 'vitest';
import {
  nextRecentSearches,
  RECENT_SEARCHES_KEPT,
  recentSearchText,
  sameSearch,
} from '../../src/search/recent';

describe('recent searches', () => {
  it('keep what was typed, trimmed and cut, and nothing under 2 characters', () => {
    expect(recentSearchText('  dana smith ')).toBe('dana smith');
    expect(recentSearchText('d')).toBeNull();
    expect(recentSearchText('x'.repeat(200))).toHaveLength(120);
  });

  it('move the same words to the top, case and accents aside, and keep the newest 8', () => {
    expect(sameSearch('JOSÉ', 'josé')).toBe(true);
    expect(sameSearch('Jose', 'josé')).toBe(true);
    expect(sameSearch('dana', 'dan')).toBe(false);
    expect(nextRecentSearches(['tom becnel', 'JOSÉ'], 'josé')).toEqual(['josé', 'tom becnel']);
    const full = Array.from({ length: RECENT_SEARCHES_KEPT }, (_, i) => `search ${i}`);
    expect(nextRecentSearches(full, 'water heater')).toEqual([
      'water heater',
      ...full.slice(0, RECENT_SEARCHES_KEPT - 1),
    ]);
    expect(nextRecentSearches(full, 'x')).toEqual(full);
  });
});
