/**
 * Close matches (search/close.ts), with no database: edit distance that counts two swapped letters as one change, and
 * names close on every typed word before names close on some.
 */
import { describe, expect, it } from 'vitest';
import {
  closeAllowance,
  closeMatches,
  closeWords,
  closeWorthTrying,
  osaDistance,
} from '../../src/search/close';
import { searchProbes } from '../../src/search/probes';

describe('optimal string alignment distance', () => {
  it('counts a swap of two neighbouring letters as one change', () => {
    expect(osaDistance('dnaa', 'dana')).toBe(1);
    expect(osaDistance('smtih', 'smith')).toBe(1);
    expect(osaDistance('smith', 'smith')).toBe(0);
    expect(osaDistance('smyth', 'smith')).toBe(1);
    expect(osaDistance('dana', 'marcus')).toBeGreaterThan(2);
    expect(osaDistance('', 'abc')).toBe(3);
  });

  it('allows one change for 4 to 7 letters, two from 8, and none below 4', () => {
    expect(closeAllowance('dan')).toBe(0);
    expect(closeAllowance('dana')).toBe(1);
    expect(closeAllowance('smithson')).toBe(2);
    expect(closeWorthTrying(['jo', 'li'])).toBe(false);
    expect(closeWorthTrying(['jo', 'smtih'])).toBe(true);
  });
});

describe('close matches for "dnaa smtih"', () => {
  it('finds both Dana Smiths, close on both words, before Marcus Smith, close on one', () => {
    const { folded } = searchProbes('dnaa smtih');
    const names = [
      { id: 'marcus', name: 'Marcus Smith' },
      { id: 'dana1', name: 'Dana Smith' },
      { id: 'kim', name: 'Kim Le' },
      { id: 'dana2', name: 'Dana Smith' },
    ];
    expect(closeWords('Dana Smith', folded)).toBe(2);
    expect(closeWords('Marcus Smith', folded)).toBe(1);
    expect(closeMatches(names, (n) => n.name, folded).map((n) => n.id)).toEqual([
      'dana1',
      'dana2',
      'marcus',
    ]);
  });

  it('folds the names, so a typo still finds an accented one', () => {
    expect(closeWords('José García', searchProbes('gracia').folded)).toBe(1);
  });
});
