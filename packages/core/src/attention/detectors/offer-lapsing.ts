/**
 * An offer about to end (Automations' "Promotion ending"): an offer from Knowledge → Promotions whose end date is three days
 * away or less. Time to extend it, or to send one last campaign while it still runs. It goes once the offer is
 * extended past the window, archived, or over.
 */
import { addDays, localInstant } from '../../calendar/engine/zoned';
import { chip } from '../chips';
import { leadValue, type BusinessFacts } from '../facts';
import { fingerprintOf } from '../fingerprint';
import type { AttentionSettings } from '../settings';
import { DAY, defineDetector, detection, type Assessment } from './define';

/** How many days before its end date an offer opens a card. */
export const OFFER_LAPSING_DAYS = 3;

export interface OfferLapsingFacts {
  readonly business: BusinessFacts;
  readonly offer: {
    readonly id: string;
    readonly name: string;
    /** The last day it runs, where the business is: "2026-10-31". */
    readonly endsOn: string | null;
    readonly archived: boolean;
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Sep 30" for a stored day ("2026-09-30"): a calendar date, so no time zone comes into it. */
const dayWords = (date: string): string =>
  `${MONTHS[Number(date.slice(5, 7)) - 1] ?? ''} ${Number(date.slice(8, 10))}`;

function assess(f: OfferLapsingFacts, settings: AttentionSettings, now: number): Assessment {
  const o = f.offer;
  if (o.archived || !o.endsOn) return null;
  const tz = f.business.timeZone;
  // It runs to the end of its last day; the card opens at the start of the day three days before.
  const over = localInstant(addDays(o.endsOn, 1), '00:00', tz);
  const opens = localInstant(addDays(o.endsOn, -OFFER_LAPSING_DAYS), '00:00', tz);
  if (now >= over) return null;
  if (now < opens) return { wakeAt: opens };
  return detection({
    // A new end date is a new card.
    fingerprint: fingerprintOf('offer_lapsing', { offer: o.id, ends: o.endsOn }),
    since: opens,
    urgentFrom: over - DAY,
    dueAt: over,
    value: leadValue(null, f.business, settings),
    probability: 0.5,
    confidence: 0.9,
    reasons: [chip('offer_ends', `${o.name} · ends ${dayWords(o.endsOn)}`)],
    assignee: null,
    recheckAt: over,
  });
}

export const { detect, wakeAt } = defineDetector<OfferLapsingFacts>('offer_lapsing', assess);
