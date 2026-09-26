/**
 * Document numbers: `LS-1042`. A prefix a business chooses, a counter it keeps, and the zeros in between.
 * Browser-safe, so Settings previews exactly what the next invoice will say.
 *
 * What a business may change:
 * - **the prefix, any time.** It's how they recognise their own paperwork.
 * - **the next number, forward only.** Accountants expect them to climb, and a number already read out loud must
 *   never come round again. The counter itself is locked and incremented inside the transaction that sends, so
 *   two people sending at once can't land on the same number.
 *
 * Voided numbers are kept and never reused: the gap is the record.
 *
 * The limits here are `app.document_counters`' check constraints, to the character: a prefix of letters, digits
 * and hyphens, at most 12 of them.
 */

export const NUMBER_PREFIX_MAX = 12;
export const NUMBER_MIN = 1;
export const NUMBER_MAX = 1_000_000_000;
/** 0 pads nothing: the counter stands as it is. */
export const NUMBER_PAD_MIN = 0;
export const NUMBER_PAD_MAX = 10;

/** Letters, digits and hyphens: `LS-`, `INV`, `2026-`. */
const PREFIX = /^[A-Za-z0-9-]*$/;

/** One counter: what goes in front, what's next, and how many digits. */
export interface DocumentNumbering {
  /** '' for bare numbers, 'INV-' for INV-1042. Its own separator is part of it. */
  readonly prefix: string;
  /** The number the next document sent will get. */
  readonly next: number;
  /** Digits, padded with zeros: 4 makes 1042 and 0007. */
  readonly pad: number;
}

const clamp = (n: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, Number.isFinite(n) ? Math.round(n) : lo));

/** The prefix as it's stored: trimmed of outer spaces, at most ten characters. */
export function normalizePrefix(raw: string): string {
  return (raw ?? '').trim().slice(0, NUMBER_PREFIX_MAX);
}

/** 'LS-' + 1042 padded to 4 → 'LS-1042'. */
export function formatDocumentNumber(prefix: string, counter: number, pad: number): string {
  const n = clamp(counter, NUMBER_MIN, NUMBER_MAX);
  return `${normalizePrefix(prefix)}${String(n).padStart(clamp(pad, NUMBER_PAD_MIN, NUMBER_PAD_MAX), '0')}`;
}

/** What the next document sent will be called. */
export function numberPreview(numbering: DocumentNumbering): string {
  return formatDocumentNumber(numbering.prefix, numbering.next, numbering.pad);
}

/** Why a prefix can't be used, in a sentence, or null. An empty prefix is fine: the number stands alone. */
export function prefixProblem(prefix: string): string | null {
  const value = (prefix ?? '').trim();
  if (value === '') return null;
  if (value.length > NUMBER_PREFIX_MAX)
    return `Keep the prefix under ${NUMBER_PREFIX_MAX + 1} characters.`;
  if (!PREFIX.test(value)) return 'A prefix can have letters, numbers and hyphens.';
  return null;
}

/** Why the next number can't be set to this, or null. Forward only: a used number never comes round again. */
export function nextNumberProblem(current: number, next: number): string | null {
  if (!Number.isInteger(next) || next < NUMBER_MIN) return 'Enter a whole number, 1 or more.';
  if (next > NUMBER_MAX) return 'That number is too long.';
  if (Number.isInteger(current) && next < current)
    return `The next number only moves forward (it’s at ${current}).`;
  return null;
}

/**
 * A counter with its next number caught up to the numbers already taken. Sending an estimate or an invoice moves
 * the document counter, not the settings, and a save below the counter is refused ("only moves forward"), so
 * anything that saves the whole settings document starts from here. `preview` is money.settings' next number as
 * it reads, "INV-1005".
 */
export function numberingAtCounter(n: DocumentNumbering, preview: string): DocumentNumbering {
  const rest = preview.startsWith(n.prefix)
    ? preview.slice(n.prefix.length)
    : (/(\d+)$/.exec(preview)?.[1] ?? '');
  const at = Number(rest);
  return Number.isInteger(at) && at > n.next ? { ...n, next: at } : n;
}

/** Why a change to a counter can't be saved, or null: the prefix is free, the number only climbs. */
export function numberingChangeProblem(
  current: DocumentNumbering,
  proposed: DocumentNumbering,
): string | null {
  return prefixProblem(proposed.prefix) ?? nextNumberProblem(current.next, proposed.next);
}
