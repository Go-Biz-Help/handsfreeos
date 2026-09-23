/**
 * Job missing an address (Automations' pipeline and jobs): a visit at the customer's place, two days or less
 * away, with no address on the visit or on the customer. Whoever goes needs to know where.
 *
 * It holds until an address is added (to the visit or the customer), the visit moves more than two days out, or
 * its time comes.
 */
import { chip } from '../chips';
import { leadValue } from '../facts';
import { fingerprintOf } from '../fingerprint';
import type { AttentionSettings } from '../settings';
import { DAY, defineDetector, detection, ms, type Assessment } from './define';
import type { JobFacts } from './job-unconfirmed';

export const JOB_NO_ADDRESS_DAYS = 2;

export interface JobNoAddressFacts extends JobFacts {
  /** Where it happens: only `customer_address` needs an address from them. */
  readonly locationKind: 'customer_address' | 'business' | 'virtual' | 'phone' | null;
  /** An address on the visit, or on any customer booked on it. */
  readonly hasAddress: boolean;
}

function assess(f: JobNoAddressFacts, settings: AttentionSettings, now: number): Assessment {
  const a = f.appointment;
  if (a.status !== 'scheduled' || f.locationKind !== 'customer_address' || f.hasAddress)
    return null;
  const starts = ms(a.startsAt);
  const opens = starts - JOB_NO_ADDRESS_DAYS * DAY;
  if (now >= starts) return null;
  if (now < opens) return { wakeAt: opens };
  return detection({
    fingerprint: fingerprintOf('job_no_address', { appointment: a.id }),
    since: opens,
    urgentFrom: starts - DAY,
    dueAt: starts,
    value: leadValue(f.lead, f.business, settings),
    probability: 0.6,
    confidence: 0.9,
    reasons: [chip('no_address', a.label)],
    assignee: f.assigneeUserId,
    recheckAt: starts,
  });
}

export const { detect, wakeAt } = defineDetector<JobNoAddressFacts>('job_no_address', assess);
