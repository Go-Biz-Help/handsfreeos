/**
 * A regular gone quiet (Automations' "Regular customer gone quiet"): someone with three or more visits done who
 * hasn't been back for twice their usual gap between visits (and at least 60 days), with no visit booked and
 * nobody in touch since. A person is asked to check in.
 *
 * Left to "Maintenance due" when that covers them (a service of theirs repeats on a schedule), so nobody hears
 * from the business twice about the same thing. It holds until someone gets in touch or they book, and lets go
 * after 90 days.
 */
import { chip } from '../chips';
import { leadValue, type BusinessFacts, type LinkedLeadFacts } from '../facts';
import { fingerprintOf } from '../fingerprint';
import type { AttentionSettings } from '../settings';
import { DAY, defineDetector, detection, ms, type Assessment } from './define';

export const CLIENT_QUIET_MIN_VISITS = 3;
export const CLIENT_QUIET_MIN_DAYS = 60;
export const CLIENT_QUIET_CARD_DAYS = 90;

export interface ClientQuietFacts {
  readonly business: BusinessFacts;
  readonly regular: {
    readonly personId: string;
    /** Visits done (completed, and they were there). */
    readonly visits: number;
    readonly lastVisitAt: string;
    /** The median days between their visits. */
    readonly usualGapDays: number;
    /** A visit of theirs is booked ahead. */
    readonly bookedAhead: boolean;
    /** "Maintenance due" reminds them already. */
    readonly covered: boolean;
    /** Their latest message or call, either way, or null. */
    readonly lastContactAt: string | null;
  };
  readonly lead: LinkedLeadFacts | null;
  readonly assigneeUserId: string | null;
}

/** "3 months", "5 weeks". */
export function spanWords(days: number): string {
  if (days >= 60) {
    const months = Math.round(days / 30);
    return `${months} ${months === 1 ? 'month' : 'months'}`;
  }
  const weeks = Math.max(1, Math.round(days / 7));
  return `${weeks} ${weeks === 1 ? 'week' : 'weeks'}`;
}

/** When a regular counts as quiet: twice their usual gap after their last visit, and at least 60 days. */
export function quietFrom(lastVisitAt: number, usualGapDays: number): number {
  return lastVisitAt + Math.max(CLIENT_QUIET_MIN_DAYS, 2 * usualGapDays) * DAY;
}

function assess(f: ClientQuietFacts, settings: AttentionSettings, now: number): Assessment {
  const r = f.regular;
  if (r.visits < CLIENT_QUIET_MIN_VISITS || r.bookedAhead || r.covered) return null;
  const last = ms(r.lastVisitAt);
  const opens = quietFrom(last, r.usualGapDays);
  if (r.lastContactAt && ms(r.lastContactAt) >= opens) return null;
  const until = opens + CLIENT_QUIET_CARD_DAYS * DAY;
  if (now >= until) return null;
  if (now < opens) return { wakeAt: opens };
  return detection({
    fingerprint: fingerprintOf('client_quiet', { person: r.personId, last: r.lastVisitAt }),
    since: opens,
    urgentFrom: null,
    dueAt: null,
    value: leadValue(f.lead, f.business, settings),
    probability: 0.4,
    confidence: 0.6,
    reasons: [
      chip(
        'quiet',
        `Usually every ${spanWords(r.usualGapDays)} · ${spanWords((now - last) / DAY)} since`,
      ),
    ],
    assignee: f.assigneeUserId,
    recheckAt: until,
  });
}

export const { detect, wakeAt } = defineDetector<ClientQuietFacts>('client_quiet', assess);
