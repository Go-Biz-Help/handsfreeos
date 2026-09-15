/**
 * An unconfirmed appointment: a one-on-one booking the customer hasn't confirmed, from the appointment window
 * (48 hours by default) before it starts until it starts. Group sessions are never asked to confirm. Its urgency
 * grows as the start nears; it may run on its own as one confirmation request.
 */
import { chip, untilChip } from '../chips';
import { leadValue, type BusinessFacts, type LinkedLeadFacts } from '../facts';
import { fingerprintOf } from '../fingerprint';
import type { AttentionSettings } from '../settings';
import { defineDetector, detection, HOUR, ms, stamp, valueChips, type Assessment } from './define';

export interface UnconfirmedAppointmentFacts {
  readonly business: BusinessFacts;
  readonly appointment: {
    readonly id: string;
    /** booking: one-on-one; session: a group session (never asked to confirm). */
    readonly kind: 'booking' | 'session';
    readonly status: 'scheduled' | 'completed' | 'cancelled' | 'no_show';
    readonly startsAt: string;
    readonly ownerUserId: string | null;
  };
  readonly attendee: {
    readonly id: string;
    readonly personId: string;
    readonly status: 'booked' | 'cancelled' | 'no_show' | 'attended';
    readonly confirmedAt: string | null;
    readonly confirmAskedAt: string | null;
  };
  /** The appointment's lead, for the value. */
  readonly lead: LinkedLeadFacts | null;
}

function assess(
  f: UnconfirmedAppointmentFacts,
  settings: AttentionSettings,
  now: number,
): Assessment {
  const { appointment: a, attendee: t } = f;
  if (a.kind !== 'booking' || a.status !== 'scheduled') return null;
  if (t.status !== 'booked' || t.confirmedAt) return null;
  const start = ms(a.startsAt);
  if (now >= start) return null;
  const opens = start - settings.appointments.windowHours * HOUR;
  if (now < opens) return { wakeAt: opens };
  const value = leadValue(f.lead, f.business, settings);
  return detection({
    fingerprint: fingerprintOf('unconfirmed_appointment', { attendee: t.id, starts: stamp(start) }),
    since: opens,
    urgentFrom: null,
    dueAt: start,
    value,
    probability: 0.5,
    confidence: 0.6,
    reasons: [
      ...valueChips(value),
      untilChip('starts_in', start, now),
      ...(t.confirmAskedAt ? [chip('asked_to_confirm', 'asked to confirm')] : []),
    ],
    assignee: a.ownerUserId,
    // It clears when the appointment starts.
    recheckAt: start,
  });
}

export const { detect, wakeAt } = defineDetector<UnconfirmedAppointmentFacts>(
  'unconfirmed_appointment',
  assess,
);
