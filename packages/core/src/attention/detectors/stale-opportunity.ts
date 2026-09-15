/**
 * A stale opportunity: an open lead with no real contact, either way, for the stale days of its stage (7 by
 * default). Counts from its last contact, or from when it came in if there's been none. Imports count too (the
 * list folds them into a group). A new contact clears it, and it reopens when that goes stale in turn.
 */
import { chip, sinceChip } from '../chips';
import {
  leadIsOpen,
  leadProbability,
  leadValue,
  type BusinessFacts,
  type LeadFacts,
} from '../facts';
import { fingerprintOf } from '../fingerprint';
import { staleDaysFor, type AttentionSettings } from '../settings';
import { DAY, defineDetector, detection, ms, stamp, valueChips, type Assessment } from './define';

export interface StaleOpportunityFacts {
  readonly business: BusinessFacts;
  readonly lead: LeadFacts;
}

function assess(f: StaleOpportunityFacts, settings: AttentionSettings, now: number): Assessment {
  const { lead, business } = f;
  if (!leadIsOpen(lead)) return null;
  const from = ms(lead.lastContactAt ?? lead.createdAt);
  const due = from + staleDaysFor(settings, lead.stage.id) * DAY;
  if (now < due) return { wakeAt: due };
  const value = leadValue(lead, business, settings);
  return detection({
    fingerprint: fingerprintOf('stale_opportunity', {
      lead: lead.id,
      lastContact: lead.lastContactAt ? stamp(from) : null,
    }),
    since: from,
    urgentFrom: null,
    dueAt: due,
    value,
    probability: leadProbability({
      stage: lead.stage,
      qualified: lead.qualification === 'qualified',
      readyToBook: false,
      repeatCustomer: false,
      notAFit: lead.qualification === 'not_a_fit',
    }),
    confidence: 0.7,
    reasons: [
      ...valueChips(value),
      lead.lastContactAt
        ? sinceChip('last_contact', from, now)
        : chip('no_contact', 'No contact yet'),
      chip('stage', lead.stage.name),
    ],
    assignee: lead.assigneeUserId,
    recheckAt: null,
  });
}

export const { detect, wakeAt } = defineDetector<StaleOpportunityFacts>(
  'stale_opportunity',
  assess,
);
