/**
 * A customer waiting: an open conversation whose customer's message is overdue for a reply, by the business's
 * reply threshold (`unansweredReminderMinutes`), or one the AI teammate handed to a person, after 15 open-hours
 * minutes from the hand-off. The same timing as today's unanswered alert, which it replaces. Urgent as soon as it
 * opens (a threshold of 0 turns the alert off: it opens right away and never counts as urgent).
 *
 * When the customer has a lead card, the card covers the conversation instead (see folding).
 */
import { chip, sinceChip } from '../chips';
import { leadValue, type BusinessFacts, type LinkedLeadFacts } from '../facts';
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

/** A hand-off waits this many open-hours minutes (the worker's hand-off alert uses the same). */
export const HANDOFF_OPEN_MINUTES = 15;

/**
 * A customer in someone's hands (messaging/hands.ts) waits this many open-hours minutes for them to answer before the
 * card asks whether to let the AI take it (the owner's pick, 19 Nov 2026: an hour, in working hours).
 */
export const IN_HANDS_OPEN_MINUTES = 60;

export interface CustomerWaitingFacts {
  readonly business: BusinessFacts;
  readonly conversation: {
    readonly id: string;
    readonly personId: string | null;
    readonly status: 'open' | 'snoozed' | 'closed';
    readonly assigneeUserId: string | null;
    readonly awaitingReplySince: string | null;
    readonly handledBy: 'none' | 'ai' | 'person';
    readonly needsPersonSince: string | null;
    readonly takenOverBy: string | null;
    /** A hand-off nobody picked up for hours, and the owners have been told (Automations). */
    readonly escalated?: boolean;
    /** Its customer is in someone's hands: the AI holds off until they let it take over. */
    readonly inHands?: boolean;
  };
  /** The business's reply threshold in minutes (`unansweredReminderMinutes`); 0 turns the alert off. */
  readonly replyThresholdMinutes: number;
  /** The customer's open lead (the most valuable), for the value. */
  readonly lead: LinkedLeadFacts | null;
}

function assess(f: CustomerWaitingFacts, settings: AttentionSettings, now: number): Assessment {
  const c = f.conversation;
  if (c.status !== 'open') return null;
  const handedOff = c.handledBy === 'person' && c.needsPersonSince !== null && !c.takenOverBy;
  const waitingSince = c.awaitingReplySince ?? (handedOff ? c.needsPersonSince : null);
  if (!waitingSince) return null;
  const since = ms(waitingSince);
  const threshold = Math.max(0, f.replyThresholdMinutes);
  const handoffAt = handedOff ? ms(c.needsPersonSince!) : null;
  // In someone's hands, a message of theirs waits an hour of open time first, so a chat going back and forth isn't
  // interrupted; then it asks whether to let the AI answer.
  const inHands = !handedOff && c.inHands === true;
  const due =
    handoffAt !== null
      ? addOpenTime(
          f.business.openHours,
          f.business.timeZone,
          handoffAt,
          HANDOFF_OPEN_MINUTES * MINUTE,
        )
      : inHands
        ? addOpenTime(
            f.business.openHours,
            f.business.timeZone,
            since,
            IN_HANDS_OPEN_MINUTES * MINUTE,
          )
        : since + threshold * MINUTE;
  if (now < due) return { wakeAt: due };
  const value = leadValue(f.lead, f.business, settings);
  return detection({
    fingerprint: fingerprintOf('customer_waiting', {
      conversation: c.id,
      since: stamp(since),
      handoff: handoffAt !== null ? stamp(handoffAt) : null,
    }),
    since,
    urgentFrom: handoffAt !== null || inHands || threshold > 0 ? due : null,
    dueAt: due,
    value,
    probability: 0.45,
    confidence: 0.7,
    reasons: [
      ...valueChips(value),
      sinceChip('waiting', since, now),
      ...(handoffAt !== null
        ? [
            chip(
              'handed_off',
              c.escalated ? 'handed to a person · owner told' : 'handed to a person',
            ),
          ]
        : []),
      ...(inHands ? [chip('in_hands', 'in your hands · the AI is waiting')] : []),
    ],
    assignee: c.assigneeUserId,
    recheckAt: null,
  });
}

export const { detect, wakeAt } = defineDetector<CustomerWaitingFacts>('customer_waiting', assess);
