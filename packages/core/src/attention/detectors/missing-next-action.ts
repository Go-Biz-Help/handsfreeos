/**
 * A missing next action, one of two ways:
 * - an overdue follow-up: the lead's next action has a time, and it has passed (it may run on its own as a nudge);
 * - no next action at all (it asks first, with a suggested one).
 * A next action in the future isn't missing: it opens when its time comes. One with words but no time isn't either.
 *
 * A lead with an estimate still out raises nothing here either: chasing the estimate is the next action, and
 * the estimate's own card carries it.
 */
import { FOLLOW_UP_OVERDUE } from '../kinds';
import { chip, sinceChip } from '../chips';
import {
  leadHasEstimateOut,
  leadIsOpen,
  leadProbability,
  leadValue,
  type BusinessFacts,
  type LeadFacts,
} from '../facts';
import { fingerprintOf } from '../fingerprint';
import type { AttentionSettings } from '../settings';
import { clip, defineDetector, detection, ms, stamp, valueChips, type Assessment } from './define';

export interface MissingNextActionFacts {
  readonly business: BusinessFacts;
  readonly lead: LeadFacts;
}

function assess(f: MissingNextActionFacts, settings: AttentionSettings, now: number): Assessment {
  const { lead, business } = f;
  if (!leadIsOpen(lead)) return null;
  // The next action on a lead with an estimate out is "chase the estimate", which has its own card.
  if (leadHasEstimateOut(lead)) return null;
  const value = leadValue(lead, business, settings);
  const probability = leadProbability({
    stage: lead.stage,
    qualified: lead.qualification === 'qualified',
    readyToBook: false,
    repeatCustomer: false,
    notAFit: lead.qualification === 'not_a_fit',
  });
  const words = lead.nextAction?.trim() ?? '';

  if (lead.nextActionAt) {
    const at = ms(lead.nextActionAt);
    if (now < at) return { wakeAt: at };
    return detection({
      fingerprint: fingerprintOf('missing_next_action', { lead: lead.id, overdue: stamp(at) }),
      since: at,
      urgentFrom: null,
      dueAt: at,
      value,
      probability,
      confidence: 0.8,
      reasons: [
        ...valueChips(value),
        sinceChip(FOLLOW_UP_OVERDUE, at, now),
        ...(words ? [chip('next_action', clip(words, 60))] : []),
      ],
      assignee: lead.assigneeUserId,
      recheckAt: null,
    });
  }
  if (words) return null;

  return detection({
    fingerprint: fingerprintOf('missing_next_action', { lead: lead.id, none: lead.stage.id }),
    since: Math.max(ms(lead.stageEnteredAt), ms(lead.createdAt)),
    urgentFrom: null,
    dueAt: null,
    value,
    probability,
    confidence: 0.6,
    reasons: [
      ...valueChips(value),
      chip('no_next_action', 'no next action'),
      chip('stage', lead.stage.name),
    ],
    assignee: lead.assigneeUserId,
    recheckAt: null,
  });
}

export const { detect, wakeAt } = defineDetector<MissingNextActionFacts>(
  'missing_next_action',
  assess,
);
