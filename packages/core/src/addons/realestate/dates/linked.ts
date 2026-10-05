/**
 * A client's sale and purchase, checked against each other (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round
 * four", step 6). Chris decided (2026-10-02): watch both and warn. Each check reads only the other deal's key dates,
 * and says it from this deal's side: what doesn't fit, and what to do. Browser-safe and pure.
 *
 * - The purchase closes before the sale (the purchase deal's own date checks say it there).
 * - The purchase's home-sale contingency ends before the sale closes.
 * - The purchase's rate lock ends before the sale closes.
 * - The client hands over the home they're selling before they get the one they're buying.
 */
import { daysBetween } from '../../../calendar/engine/zoned';
import { fmtDateShort } from '../../../calendar/when';
import type { HealthLinked } from '../health';
import type { DealSide } from '../states';

/** One side's key dates, as far as the link shows them. */
export type LinkedDates = Readonly<
  Record<string, { readonly date: string; readonly confirmed?: boolean }>
>;

export interface LinkedOther {
  readonly name: string;
  readonly side: DealSide;
  readonly kind: 'same_home' | 'sale_and_purchase';
  readonly agentName: string | null;
  readonly keyDates: LinkedDates;
}

const day = fmtDateShort;

/** What the linked deal breaks, from this deal's side. Nothing for two sides of one home. */
export function linkedProblems(
  self: { readonly side: DealSide; readonly keyDates: LinkedDates },
  other: LinkedOther,
): HealthLinked[] {
  if (other.kind !== 'sale_and_purchase' || self.side === other.side) return [];
  const buying = self.side === 'buyer';
  const purchase = buying ? self.keyDates : other.keyDates;
  const sale = buying ? other.keyDates : self.keyDates;
  const saleClosing = sale['closing']?.date;
  const who = other.agentName ?? 'the other deal’s agent';
  const out: HealthLinked[] = [];
  const closing = purchase['closing']?.date;
  // The purchase deal already says this among its own dates.
  if (!buying && closing && saleClosing && closing < saleClosing)
    out.push({
      words: `Their purchase, ${other.name}, closes ${day(closing)}, before this sale closes (${day(saleClosing)}).`,
      next: `Move this closing to ${day(closing)} or earlier, or ask ${who} to move theirs.`,
      keys: ['closing'],
    });
  const homeSale = purchase['home_sale_end']?.date;
  if (homeSale && saleClosing && homeSale < saleClosing)
    out.push(
      buying
        ? {
            words: `The home-sale contingency here ends ${day(homeSale)}, before their sale closes (${day(saleClosing)}).`,
            next: 'Ask the sellers to extend it, or ask the sale’s agent about closing sooner.',
            keys: ['home_sale_end'],
          }
        : {
            words: `Their purchase’s home-sale contingency ends ${day(homeSale)}, before this sale closes (${day(saleClosing)}).`,
            next: `Tell ${who}; the sellers there may need to extend it, or this sale close sooner.`,
            keys: ['closing'],
          },
    );
  const lock = purchase['rate_lock_expiry']?.date;
  if (lock && saleClosing && lock < saleClosing)
    out.push(
      buying
        ? {
            words: `The rate lock here ends ${day(lock)}, before their sale closes (${day(saleClosing)}).`,
            next: 'Ask the lender to extend the lock past the sale’s closing.',
            keys: ['rate_lock_expiry'],
          }
        : {
            words: `Their purchase’s rate lock ends ${day(lock)}, before this sale closes (${day(saleClosing)}).`,
            next: `Tell ${who}, so their lender can extend it.`,
            keys: ['closing'],
          },
    );
  const handOver = sale['possession']?.date ?? saleClosing;
  const getKeys = purchase['possession']?.date ?? closing;
  if (handOver && getKeys && handOver < getKeys) {
    const gap = daysBetween(handOver, getKeys);
    out.push({
      words: `The client hands over the home they’re selling on ${day(handOver)} but gets the one they’re buying on ${day(getKeys)}: ${gap} ${gap === 1 ? 'day' : 'days'} with nowhere to live.`,
      next: 'Arrange a rent-back, or move one of the dates, with both agents.',
      keys: ['possession'],
    });
  }
  return out;
}
