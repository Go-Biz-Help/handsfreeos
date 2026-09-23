/**
 * Did the job happen? (Automations' "Did the job happen?"): a visit whose time has passed that nobody has marked
 * done or missed. Whoever was on it got a push half an hour after it ended and another that evening; the next
 * morning it's a card (and in the owner's morning email).
 *
 * It holds from 6 AM the day after the visit until someone marks it, or until it becomes "Booked, never marked
 * done" three days after (`job_never_completed`), which takes it over. It only opens while the job check is on;
 * with it off, that three-day card is the only one.
 */
import { chip } from '../chips';
import { leadValue, type BusinessFacts, type LinkedLeadFacts } from '../facts';
import { fingerprintOf } from '../fingerprint';
import type { AttentionSettings } from '../settings';
import { addDays, localDateOf, localInstant } from '../../calendar/engine/zoned';
import { DAY, defineDetector, detection, ms, type Assessment } from './define';

/** The morning it becomes a card, where the business is. */
export const JOB_CHECK_MORNING = '06:00';
/** How long after a visit's end it's "never marked done" instead. */
export const JOB_NEVER_COMPLETED_DAYS = 3;

export interface JobFacts {
  readonly business: BusinessFacts;
  readonly appointment: {
    readonly id: string;
    readonly status: 'scheduled' | 'completed' | 'cancelled' | 'no_show';
    readonly startsAt: string;
    readonly endsAt: string;
    /** "AC tune-up · Tue 2:00 PM". */
    readonly label: string;
  };
  readonly lead: LinkedLeadFacts | null;
  /** Whoever was on it (the first of its staff, else its owner). */
  readonly assigneeUserId: string | null;
}

export interface JobUnconfirmedFacts extends JobFacts {
  /** Automations' "Did the job happen?" switch. */
  readonly jobCheckOn: boolean;
}

/** 6 AM the day after the visit ended, where the business is. */
export function morningAfter(endsAt: number, timeZone: string): number {
  return localInstant(addDays(localDateOf(endsAt, timeZone), 1), JOB_CHECK_MORNING, timeZone);
}

function assess(f: JobUnconfirmedFacts, settings: AttentionSettings, now: number): Assessment {
  const a = f.appointment;
  if (!f.jobCheckOn || a.status !== 'scheduled') return null;
  const ended = ms(a.endsAt);
  const opens = morningAfter(ended, f.business.timeZone);
  const until = ended + JOB_NEVER_COMPLETED_DAYS * DAY;
  if (now >= until) return null;
  if (now < opens) return { wakeAt: opens };
  return detection({
    fingerprint: fingerprintOf('job_unconfirmed', { appointment: a.id }),
    since: ended,
    urgentFrom: null,
    dueAt: null,
    value: leadValue(f.lead, f.business, settings),
    probability: 0.6,
    confidence: 0.8,
    reasons: [chip('job_passed', a.label)],
    assignee: f.assigneeUserId,
    recheckAt: until,
  });
}

export const { detect, wakeAt } = defineDetector<JobUnconfirmedFacts>('job_unconfirmed', assess);
