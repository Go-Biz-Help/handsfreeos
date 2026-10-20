/**
 * Where a search matched in a text, and the stretch of it a row shows (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, How
 * it works, 4). Marks are `[start, end)` ranges into the text as it is shown, found in its folded form ("jose" marks
 * "José"), which fits because folding keeps the length, and digit-aware ("5550142" marks "(504) 555-0142"). Both apps
 * draw them as text inside `<mark>`, never as HTML, so a body holding "<" can't inject anything.
 */
import { fold } from './fold';
import type { SearchProbes } from './probes';

export type SearchMark = readonly [number, number];

export interface Snippet {
  readonly text: string;
  readonly marks: [number, number][];
}

/** Overlapping and touching ranges made one, in order. */
function merged(ranges: readonly SearchMark[]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/** Every place `needle` sits in `haystack`. */
function placesOf(haystack: string, needle: string): SearchMark[] {
  const out: SearchMark[] = [];
  if (!needle) return out;
  for (
    let at = haystack.indexOf(needle);
    at >= 0;
    at = haystack.indexOf(needle, at + needle.length)
  )
    out.push([at, at + needle.length]);
  return out;
}

/** Where a run of digits sits in a text, whatever punctuation the text puts between them. */
function digitPlaces(text: string, digits: string): SearchMark[] {
  const at: number[] = [];
  let only = '';
  for (let i = 0; i < text.length; i++)
    if (text[i]! >= '0' && text[i]! <= '9') {
      only += text[i];
      at.push(i);
    }
  return placesOf(only, digits).map(([s, e]) => [at[s]!, at[e - 1]! + 1] as const);
}

/** The digit runs a probe looks for: what was typed, and a phone's national number. */
function digitRuns(p: SearchProbes): string[] {
  const runs = new Set<string>();
  if (p.digits) runs.add(p.digits);
  if (p.phoneE164) {
    runs.add(p.phoneE164.slice(1));
    // A North American number is written without its 1 more often than with it.
    if (p.phoneE164.startsWith('+1')) runs.add(p.phoneE164.slice(2));
  }
  return [...runs];
}

/** Every place a search matched in a text: each folded word, digit runs, and the email or phone typed. */
export function marksIn(text: string | null | undefined, p: SearchProbes): [number, number][] {
  if (!text) return [];
  const folded = fold(text);
  const ranges: SearchMark[] = [];
  for (const word of p.folded) ranges.push(...placesOf(folded, word));
  if (p.email) ranges.push(...placesOf(folded, p.email));
  for (const run of digitRuns(p)) ranges.push(...digitPlaces(text, run));
  return merged(ranges);
}

/** Around this many characters of a long text, cut where the first match is. */
const SNIPPET_LENGTH = 200;
const SNIPPET_BEFORE = 70;

/**
 * The stretch of a long text a row shows: about 200 characters from a little before the first match, with "…" where
 * it was cut and the marks moved to fit. A text with no match shows its start.
 */
export function snippetOf(
  text: string | null | undefined,
  p: SearchProbes,
  opts: { length?: number; before?: number } = {},
): Snippet {
  const whole = (text ?? '').replace(/\s+/g, ' ').trim();
  const length = opts.length ?? SNIPPET_LENGTH;
  const before = opts.before ?? SNIPPET_BEFORE;
  const marks = marksIn(whole, p);
  let start = marks[0] ? Math.max(0, marks[0][0] - before) : 0;
  // Start on a word, not halfway through one.
  if (start > 0) {
    const space = whole.indexOf(' ', start);
    if (space >= 0 && space < (marks[0]?.[0] ?? start)) start = space + 1;
  }
  const end = Math.min(whole.length, start + length);
  const lead = start > 0 ? '…' : '';
  const tail = end < whole.length ? '…' : '';
  const shift = lead.length - start;
  return {
    text: `${lead}${whole.slice(start, end)}${tail}`,
    marks: marks
      .filter(([s, e]) => s >= start && e <= end)
      .map(([s, e]) => [s + shift, e + shift] as [number, number]),
  };
}

/**
 * Knowledge's own snippets come marked with `**` (`searchKnowledge`'s `ts_headline`): the text without them, and
 * where they were as marks. Nothing else in the text is read as markup.
 */
export function marksFromStars(marked: string): Snippet {
  const parts = marked.split('**');
  const marks: [number, number][] = [];
  let text = '';
  parts.forEach((part, i) => {
    // Every other part sat between two markers; a marker left open at the end marks nothing.
    if (i % 2 === 1 && i < parts.length - 1 && part)
      marks.push([text.length, text.length + part.length]);
    text += part;
  });
  return { text, marks };
}
