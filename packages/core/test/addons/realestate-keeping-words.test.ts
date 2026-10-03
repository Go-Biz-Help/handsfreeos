/**
 * Round six's words for keeping a deal (board 93): an export's line and Keeping records' saved message. Pure.
 */
import { describe, expect, it } from 'vitest';
import {
  EXPORT_WORDS,
  exportLine,
  exportSizeWords,
  KEEPING_WORDS,
} from '../../src/addons/realestate/keeping-words';

describe('an export, in words', () => {
  it('says its files, its size and that every fingerprint was checked', () => {
    expect(exportLine({ files: 48, sizeBytes: 31 * 1024 * 1024 + 200_000 })).toBe(
      '48 files · 31 MB · every file’s fingerprint checked',
    );
    expect(exportLine({ files: 1, sizeBytes: null })).toBe(
      '1 file · every file’s fingerprint checked',
    );
  });

  it('rounds sizes the way people read them', () => {
    expect(exportSizeWords(300)).toBe('1 KB');
    expect(exportSizeWords(820 * 1024)).toBe('820 KB');
    expect(exportSizeWords(4.2 * 1024 * 1024)).toBe('4.2 MB');
    expect(exportSizeWords(31.4 * 1024 * 1024)).toBe('31 MB');
  });

  it('has a word for every state the server answers', () => {
    expect(Object.keys(EXPORT_WORDS.states).sort()).toEqual(['building', 'failed', 'ready']);
  });
});

describe('Keeping records', () => {
  it('counts holds and says how long', () => {
    expect(KEEPING_WORDS.holdsTitle(1)).toBe('Legal holds · 1');
    expect(KEEPING_WORDS.keepSaved(1)).toBe('Saved. Closed deals are kept 1 year after they end.');
    expect(KEEPING_WORDS.keepSaved(7)).toBe('Saved. Closed deals are kept 7 years after they end.');
  });
});
