/**
 * Money in changed (Automations' "Money in changed"): on Monday morning, when last week's money in (payments less
 * refunds) was 30% or more above or below the business's usual week — the median of the eight before it, with
 * at least four of them having any money in — a card says so, with the main reason. Weeks run Monday to Sunday
 * where the business is. The card is the week's: next Monday's is a new one, or none.
 */
import { chip } from '../chips';
import { leadValue, type BusinessFacts } from '../facts';
import { fingerprintOf } from '../fingerprint';
import { money } from '../../money/format';
import type { AttentionSettings } from '../settings';
import { defineDetector, detection, ms, type Assessment } from './define';

/** How far from the usual week counts. */
export const REVENUE_MOVED_SHARE = 0.3;
/** A usual week smaller than this is too small to call a change. */
export const REVENUE_MOVED_MIN_CENTS = 50_000;
/** Weeks with money in needed before there is a "usual". */
export const REVENUE_MOVED_MIN_WEEKS = 4;

export interface RevenueMovedFacts {
  readonly business: BusinessFacts;
  readonly week: {
    /** Last week's Monday (YYYY-MM-DD). */
    readonly start: string;
    /** This Monday at 6 AM, and next Monday at 6 AM, where the business is. */
    readonly opensAt: string;
    readonly endsAt: string;
  };
  readonly lastCents: number;
  /** The median of the weeks before with any money in, or null with too few. */
  readonly usualCents: number | null;
  readonly weeksCounted: number;
  /** The main reason, in words ("6 jobs done, usually 10"), or null. */
  readonly reason: string | null;
}

/** The change as a share of the usual week, or null when there's nothing to compare. */
export function revenueChange(
  f: Pick<RevenueMovedFacts, 'lastCents' | 'usualCents' | 'weeksCounted'>,
): number | null {
  if (f.usualCents === null || f.weeksCounted < REVENUE_MOVED_MIN_WEEKS) return null;
  if (f.usualCents < REVENUE_MOVED_MIN_CENTS) return null;
  return (f.lastCents - f.usualCents) / f.usualCents;
}

function assess(f: RevenueMovedFacts, settings: AttentionSettings, now: number): Assessment {
  const change = revenueChange(f);
  if (change === null || Math.abs(change) < REVENUE_MOVED_SHARE) return null;
  const opens = ms(f.week.opensAt);
  const ends = ms(f.week.endsAt);
  if (now >= ends) return null;
  if (now < opens) return { wakeAt: opens };
  const pct = Math.round(change * 100);
  return detection({
    fingerprint: fingerprintOf('revenue_moved', { week: f.week.start }),
    since: opens,
    urgentFrom: null,
    dueAt: null,
    value: leadValue(null, f.business, settings),
    probability: 0.5,
    confidence: 0.8,
    reasons: [
      chip(
        'revenue',
        `${money(f.lastCents)} last week · usually ${money(f.usualCents!)} (${pct > 0 ? '+' : '−'}${Math.abs(pct)}%)`,
      ),
    ],
    assignee: null,
    recheckAt: ends,
  });
}

export const { detect, wakeAt } = defineDetector<RevenueMovedFacts>('revenue_moved', assess);
