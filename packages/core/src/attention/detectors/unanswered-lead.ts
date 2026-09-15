/**
 * An unanswered lead: a new lead that came in on its own and nobody has reached out to, after the unanswered
 * threshold in open-hours minutes (15 minutes from 4:55 PM with a 5 PM close is 8:10 AM the next open day).
 * Imports and leads a person entered by hand never count. Urgent as soon as it opens.
 */
import { chip, sinceChip } from '../chips';
import {
  leadIsOpen,
  leadProbability,
  leadValue,
  neverContacted,
  type BusinessFacts,
  type LeadFacts,
} from '../facts';
import { fingerprintOf } from '../fingerprint';
import { addOpenTime } from '../open-time';
import type { AttentionSettings } from '../settings';
import {
  defineDetector,
  detection,
  MINUTE,
  ms,
  stamp,
  valueChips,
  type Assessment,
} from './define';

export interface UnansweredLeadFacts {
  readonly business: BusinessFacts;
  readonly lead: LeadFacts;
}

function assess(f: UnansweredLeadFacts, settings: AttentionSettings, now: number): Assessment {
  const { lead, business } = f;
  if (!leadIsOpen(lead) || !neverContacted(lead)) return null;
  const since = ms(lead.createdAt);
  const due = addOpenTime(
    business.openHours,
    business.timeZone,
    since,
    settings.unanswered.afterOpenMinutes * MINUTE,
  );
  if (now < due) return { wakeAt: due };
  const value = leadValue(lead, business, settings);
  return detection({
    fingerprint: fingerprintOf('unanswered_lead', { lead: lead.id, since: stamp(since) }),
    since,
    urgentFrom: due,
    dueAt: due,
    value,
    probability: leadProbability({
      stage: lead.stage,
      qualified: lead.qualification === 'qualified',
      readyToBook: false,
      repeatCustomer: false,
      notAFit: lead.qualification === 'not_a_fit',
    }),
    confidence: 0.9,
    reasons: [
      ...valueChips(value),
      sinceChip('waiting', since, now),
      chip('not_contacted', 'not contacted yet'),
    ],
    assignee: lead.assigneeUserId,
    recheckAt: null,
  });
}

export const { detect, wakeAt } = defineDetector<UnansweredLeadFacts>('unanswered_lead', assess);
