/**
 * Reading a phone row's columns (`CopyRow.data`, Postgres's JSON) exactly as the server's queries read the same
 * columns: text as it is (an empty string stays one), numbers as numbers, and times to the microsecond for ordering
 * them as the server's SQL does. `views/tours.ts`, `views/cma.ts` and `views/offers.ts` read their rows with these.
 *
 * Browser-safe and pure.
 */
import { ms, text } from './synced';

/** A text column: its words, or null. */
export const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** A number column (integer, bigint or numeric): its value, or null. */
export const num = (v: unknown): number | null =>
  v === null || v === undefined || v === '' ? null : Number(v);

/** A yes-or-no column that may be empty. */
export const yesNo = (v: unknown): boolean | null =>
  v === null || v === undefined ? null : v === true;

/** A JSON object column, or null. */
export const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * A time to the microsecond ("2026-10-03T14:31:03.785123+00:00"), for putting rows in the server's order: two rows
 * written in the same millisecond still have one. Null when there's none.
 */
export const micros = (v: unknown): number | null => {
  const t = ms(v);
  if (t === null) return null;
  const fraction = /:\d{2}\.(\d+)/.exec(text(v) ?? '')?.[1] ?? '';
  return t * 1000 + Number(fraction.padEnd(6, '0').slice(3, 6));
};

/** Oldest first, as SQL's `asc`: no time last. */
export const byTimeAsc = (a: unknown, b: unknown): number => {
  const x = micros(a);
  const y = micros(b);
  return x === y ? 0 : x === null ? 1 : y === null ? -1 : x - y;
};

/** Newest first, as SQL's `desc`: no time first. */
export const byTimeDesc = (a: unknown, b: unknown): number => -byTimeAsc(a, b);
