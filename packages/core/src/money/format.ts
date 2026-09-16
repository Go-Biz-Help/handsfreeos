/**
 * Money in words, in one place. Two formatters replace the five copies that had drifted apart: the web's
 * `formatMoney`, the Action Center's `moneyLabel`, the booking page's `money`, the Assistant's rounded `money`
 * and the workflow data's (which printed "$123.5"). Browser-safe, so the same cents read the same on a screen,
 * in an email and on the customer's page.
 *
 * - `money` is exact, with cents only when there are any: $18,500 · $18,500.50.
 * - `moneyRounded` drops the cents for summaries and tiles: $18,501.
 *
 * Everything is integer cents, USD. A fractional cent is rounded to the nearest one before it's shown.
 */
import { roundHalfUp } from './totals';

const exact = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const dollars = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** $18,500 · $18,500.50 · −$40. Nothing, null or a stray value reads as $0. */
export function money(cents: number | null | undefined): string {
  const c = roundHalfUp(cents ?? 0);
  return (c % 100 === 0 ? dollars : exact).format(c / 100);
}

/** Whole dollars, for summaries and tiles: $18,501. Halves round up ($0.50 becomes $1). */
export function moneyRounded(cents: number | null | undefined): string {
  return dollars.format(roundHalfUp(roundHalfUp(cents ?? 0) / 100));
}

const DIGITS_MAX = 12;

/**
 * What someone typed, as cents: "$1,234.56" → 123456, "" → 0. Null when it isn't an amount (letters, a second
 * dot, something negative, or a number too large to be a price). A third decimal rounds to the nearest cent.
 */
export function parseMoney(input: string): number | null {
  const text = (input ?? '').trim();
  if (text === '') return 0;
  if (/[-−(]/.test(text)) return null;
  const cleaned = text.replace(/[$,\s]/g, '');
  const parts = /^(\d*)(?:\.(\d*))?$/.exec(cleaned);
  if (!parts) return null;
  const [, whole = '', fraction = ''] = parts;
  if (whole === '' && fraction === '') return null;
  if (whole.length > DIGITS_MAX) return null;
  const thousandths = `${fraction}000`.slice(0, 3);
  const carry = Number(thousandths[2]) >= 5 ? 1 : 0;
  return Number(whole || '0') * 100 + Number(thousandths.slice(0, 2)) + carry;
}
