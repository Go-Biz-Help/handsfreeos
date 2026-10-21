/**
 * Where a search matched (search/snippet.ts), with no database: marks found in folded text fit the original, digits
 * are found through a phone's punctuation, a long text is cut around its first match, and nothing is ever read as
 * markup but knowledge's own `**`.
 */
import { describe, expect, it } from 'vitest';
import { searchProbes } from '../../src/search/probes';
import { marksFromStars, marksIn, snippetOf } from '../../src/search/snippet';

const marked = (text: string, marks: readonly (readonly [number, number])[]) =>
  marks.map(([s, e]) => text.slice(s, e));

describe('marks', () => {
  it('fold, so "jose" marks "José" and the range fits the original', () => {
    const text = 'Call José García back';
    expect(marked(text, marksIn(text, searchProbes('jose garcia')))).toEqual(['José', 'García']);
  });

  it('fit the original after ß and ł, which fold to one letter each', () => {
    const text = 'Straße 4, Łódź and Smith';
    expect(marked(text, marksIn(text, searchProbes('smith')))).toEqual(['Smith']);
    expect(marked(text, marksIn(text, searchProbes('lodz')))).toEqual(['Łódź']);
    expect(marked(text, marksIn(text, searchProbes('strase')))).toEqual(['Straße']);
  });

  it('read digits through punctuation', () => {
    const text = 'Dana · (504) 555-0142';
    expect(marked(text, marksIn(text, searchProbes('5550142')))).toEqual(['555-0142']);
    // From the first digit to the last: the bracket before it isn't a digit.
    expect(marked(text, marksIn(text, searchProbes('+1 504 555 0142')))).toEqual(['504) 555-0142']);
  });

  it('merge where words overlap', () => {
    expect(marksIn('smithfield', searchProbes('smith smithf'))).toEqual([[0, 6]]);
  });
});

describe('snippets', () => {
  it('cut a long text around the first match, with the marks moved to fit', () => {
    const body = `${'Lorem ipsum dolor sit amet. '.repeat(10)}The gate code is 4471 and the dog is friendly. ${'More words here. '.repeat(10)}`;
    const s = snippetOf(body, searchProbes('gate code'));
    expect(s.text.startsWith('…')).toBe(true);
    expect(s.text.endsWith('…')).toBe(true);
    expect(s.text.length).toBeLessThanOrEqual(202);
    expect(marked(s.text, s.marks)).toEqual(['gate', 'code']);
  });

  it('show the start of a text with no match', () => {
    expect(snippetOf('Short note', searchProbes('zzz'))).toEqual({ text: 'Short note', marks: [] });
  });

  it('keep "<script>" as text: marks are ranges, never markup', () => {
    const s = snippetOf('<script>alert(1)</script> smith', searchProbes('smith'));
    expect(s.text).toBe('<script>alert(1)</script> smith');
    expect(marked(s.text, s.marks)).toEqual(['smith']);
  });
});

describe('knowledge’s own marks', () => {
  it('turn ** markers into ranges and drop them from the text', () => {
    const s = marksFromStars('We **unclog** drains … **Drain** cleaning from $99');
    expect(s.text).toBe('We unclog drains … Drain cleaning from $99');
    expect(marked(s.text, s.marks)).toEqual(['unclog', 'Drain']);
    expect(marksFromStars('an open **marker')).toEqual({ text: 'an open marker', marks: [] });
  });
});
