/**
 * Building a search hit from a row, shared by the server's searchers (`search/server/kinds`) and the phone's own search
 * (`copy.ts`, `explain.ts`). Browser-safe and pure: nothing here reads the database.
 */
import type { SearchHit, SearchSnippet } from '../schemas/search';
import { fold } from './fold';
import type { SearchProbes } from './probes';
import { marksIn, snippetOf } from './snippet';

/** A hit with everything a searcher doesn't say left empty. */
export function hitOf(
  h: Pick<SearchHit, 'kind' | 'id' | 'title' | 'href' | 'tier'> & Partial<SearchHit>,
): SearchHit {
  return {
    subtitle: null,
    badges: [],
    why: { field: 'name', label: null, snippet: null, page: null },
    exact: false,
    at: null,
    contact: null,
    amount: null,
    facts: {},
    duplicateOf: null,
    ...h,
  };
}

/** A short field's text with where the search matched in it, or null when it didn't. */
export function fieldSnippet(
  text: string | null | undefined,
  p: SearchProbes,
): SearchSnippet | null {
  if (!text) return null;
  const marks = marksIn(text, p);
  return marks.length ? { text, marks } : null;
}

/** Whether every typed word sits somewhere in these texts together, accents folded. */
export function holdsAll(texts: readonly (string | null | undefined)[], p: SearchProbes): boolean {
  const all = fold(texts.filter(Boolean).join(' '));
  return p.folded.length > 0 && p.folded.every((w) => all.includes(w));
}

/** Whether any typed word sits in this text, accents folded. */
export function holdsAny(text: string | null | undefined, p: SearchProbes): boolean {
  if (!text) return false;
  const all = fold(text);
  return p.folded.some((w) => all.includes(w));
}

/** The typed words, folded, that none of these texts holds: what another field of the row must have matched. */
export function wordsLeft(
  texts: readonly (string | null | undefined)[],
  p: SearchProbes,
): string[] {
  const all = fold(texts.filter(Boolean).join(' '));
  return p.folded.filter((w) => !all.includes(w));
}

/**
 * Which of a row's fields matched the words left over: the first that holds every one of them, else the first that
 * holds any, else null. So "dana metairie" on Dana Smith of Metairie is her address, whatever her email holds.
 */
export function fieldHolding<F>(
  left: readonly string[],
  fields: readonly { readonly field: F; readonly text: string | null | undefined }[],
): F | null {
  if (left.length === 0) return null;
  const folded = fields.map((f) => ({ field: f.field, text: f.text ? fold(f.text) : '' }));
  return (
    folded.find((f) => left.every((w) => f.text.includes(w)))?.field ??
    folded.find((f) => left.some((w) => f.text.includes(w)))?.field ??
    null
  );
}

/** The values of a list of other phones or emails, as a record keeps them (`[{ "phone": … }]`). */
export const listedValues = (raw: unknown, key: 'phone' | 'email'): string[] =>
  Array.isArray(raw)
    ? raw
        .map((e) => (e && typeof e === 'object' ? (e as Record<string, unknown>)[key] : null))
        .filter((v): v is string => typeof v === 'string' && v.length > 0)
    : [];

/** Only the digits of a text. */
export const digitsIn = (s: string | null | undefined): string => (s ?? '').replace(/\D/g, '');

/**
 * A snippet from a stretch SQL cut out of a long text (`stretchOf`): core's marks, and "…" where the text was cut, at
 * either end.
 */
export function stretchSnippet(
  stretch: string | null | undefined,
  cut: { readonly before: boolean; readonly after: boolean },
  p: SearchProbes,
): SearchSnippet | null {
  if (!stretch?.trim()) return null;
  const s = snippetOf(stretch, p);
  const lead = cut.before && !s.text.startsWith('…') ? '…' : '';
  const tail = cut.after && !s.text.endsWith('…') ? '…' : '';
  return {
    text: `${lead}${s.text}${tail}`,
    marks: s.marks.map(([a, b]) => [a + lead.length, b + lead.length] as [number, number]),
  };
}
