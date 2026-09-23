/**
 * Booked, never marked done (Automations' pipeline and jobs): a visit's time passed three days ago and nobody has
 * said whether it happened. Its money, its thank-you and its deal all wait on that.
 *
 * It holds until someone marks it done or missed (or cancels it), and lets go thirty days after the visit, so a
 * business that never marked its jobs isn't handed a year of them at once.
 */
import { chip } from '../chips';
import { leadValue } from '../facts';
import { fingerprintOf } from '../fingerprint';
import type { AttentionSettings } from '../settings';
import { DAY, defineDetector, detection, ms, type Assessment } from './define';
import { JOB_NEVER_COMPLETED_DAYS, type JobFacts } from './job-unconfirmed';

export const JOB_NEVER_COMPLETED_UNTIL_DAYS = 30;

export type JobNeverCompletedFacts = JobFacts;

function assess(f: JobNeverCompletedFacts, settings: AttentionSettings, now: number): Assessment {
  const a = f.appointment;
  if (a.status !== 'scheduled') return null;
  const ended = ms(a.endsAt);
  const opens = ended + JOB_NEVER_COMPLETED_DAYS * DAY;
  const until = ended + JOB_NEVER_COMPLETED_UNTIL_DAYS * DAY;
  if (now >= until) return null;
  if (now < opens) return { wakeAt: opens };
  return detection({
    fingerprint: fingerprintOf('job_never_completed', { appointment: a.id }),
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

export const { detect, wakeAt } = defineDetector<JobNeverCompletedFacts>(
  'job_never_completed',
  assess,
);
