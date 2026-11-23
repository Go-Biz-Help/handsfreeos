/**
 * How often a plan bills, in the words each provider uses for it.
 *
 * Our plans bill every month, quarter or year, times a count ("every 3 months" is month × 3). Stripe takes any
 * count of months or years. Square only names a handful of rhythms, so a plan is refused before it is sold
 * through Square in a rhythm Square has no name for, rather than billed in the nearest one. Until 23 Nov 2026
 * every Square plan that wasn't yearly was made monthly, so a quarterly plan would have billed every month.
 *
 * Pure, so the command that sells a plan and the worker that makes it at Square ask the same question.
 */
import type { PlanInterval } from '../schemas/money';

/** How many months one cycle of a plan is: a quarter is three, a year twelve. */
export function planMonths(interval: PlanInterval | 'month' | 'year', count: number): number {
  const n = Math.max(1, Math.trunc(count));
  return interval === 'year' ? 12 * n : interval === 'quarter' ? 3 * n : n;
}

/** Square's rhythms that are a whole number of months (its `SubscriptionCadence`), by how many months each is. */
const SQUARE_CADENCES: Readonly<Record<number, string>> = {
  1: 'MONTHLY',
  2: 'EVERY_TWO_MONTHS',
  3: 'QUARTERLY',
  4: 'EVERY_FOUR_MONTHS',
  6: 'EVERY_SIX_MONTHS',
  12: 'ANNUAL',
  24: 'EVERY_TWO_YEARS',
};

/** Square's name for how often this plan bills, or null when Square has none for it. */
export function squareCadenceOf(
  interval: PlanInterval | 'month' | 'year',
  count: number,
): string | null {
  return SQUARE_CADENCES[planMonths(interval, count)] ?? null;
}

/** The rhythms Square can bill, in words, for a refusal to offer instead. */
export const SQUARE_CADENCE_WORDS = 'every 1, 2, 3, 4 or 6 months, every year, or every 2 years';
