/**
 * Daily budgets for the paid map lookups a signed-out booking page starts: Google's Geocoding, Route Matrix and
 * Places Text Search, on the worker's server key. Anyone can open a booking page, so each business, and each worker
 * machine, gets so many lookups a day; past that the page carries on as it does with maps off, rather than
 * running up the bill or using up the key's quota for every business.
 *
 * Only a request asked to count (`within`) counts: the open times and the coffee spot halfway. A booking (behind the
 * bot check), a customer's change-or-cancel link, jobs and signed-in screens look up as before. Answers already kept
 * (a found or not-found address, a coffee spot, a drive) cost nothing and count nothing: the lookups call
 * `spendLookup` just before they ask Google.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { KeyedLimiter } from '../chat/limiter';

const DAY = 86_400_000;

export interface LookupBudget {
  /** Lookups one business's booking pages may start in a day, on one machine. */
  readonly perBusiness: number;
  /** Lookups all booking pages together may start in a day, on one machine. */
  readonly perMachine: number;
}

/**
 * Paid map lookups that signed-out booking pages may start in a day. A lookup is one request to Google: finding an
 * address, finding a coffee spot, or timing the drives to up to 25 places. A real customer costs a handful, as
 * answers are kept, so 500 is a busy business's booking page many times over; 20,000 bounds what one machine spends
 * whatever the number of businesses or addresses an attacker uses. Each machine counts on its own; the daily quotas
 * on the key in Google Cloud are the hard stop across machines ("Daily quotas on the Google Maps server key" in
 * docs/operations.md). Outside production both are multiplied by the booking page's `limitFactor`.
 */
export const MAP_LOOKUP_BUDGET: LookupBudget = { perBusiness: 500, perMachine: 20_000 };

/** Thrown just before a paid lookup when a budget is spent, so nothing is asked of Google and nothing is kept. */
export class LookupsPaused extends Error {
  constructor() {
    super('Map lookups are paused: a daily budget is spent');
    this.name = 'LookupsPaused';
  }
}

export interface LookupBudgets {
  /**
   * Runs `fn` with its paid lookups counted against this business's budget and this machine's. `paused` when a
   * budget stopped a lookup that `fn` didn't carry on without itself.
   */
  within<T>(workspaceId: string, fn: () => Promise<T>): Promise<T | 'paused'>;
}

const counting = new AsyncLocalStorage<() => boolean>();

export function createLookupBudgets(
  budget: LookupBudget = MAP_LOOKUP_BUDGET,
  now: () => number = Date.now,
): LookupBudgets {
  const limiter = new KeyedLimiter(now);
  const perBusiness = { max: budget.perBusiness, timeWindow: DAY };
  const perMachine = { max: budget.perMachine, timeWindow: DAY };
  return {
    async within(workspaceId, fn) {
      const take = () =>
        limiter.take([
          { key: `business:${workspaceId}`, rule: perBusiness },
          { key: 'machine', rule: perMachine },
        ]).ok;
      try {
        return await counting.run(take, fn);
      } catch (e) {
        if (e instanceof LookupsPaused) return 'paused';
        throw e;
      }
    },
  };
}

/**
 * Called just before asking Google. Throws `LookupsPaused` when the request counts and a budget is spent; does
 * nothing for a request that doesn't count.
 */
export function spendLookup(): void {
  const take = counting.getStore();
  if (take && !take()) throw new LookupsPaused();
}
