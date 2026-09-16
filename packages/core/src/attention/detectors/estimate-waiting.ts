/**
 * An estimate nobody answered: sent, still unanswered, and a few days old. It opens `money.estimateWaitingDays`
 * after it went out and clears when the customer answers or it stops being good — an expired estimate is
 * reissued, not chased.
 *
 * Ask-first only. Money never chases itself: Let HandsFreeOS Handle drafts the follow-up and waits to be sent.
 *
 * Its value is what was quoted, marked as an estimate, so it shows on the card but stays out of "$ affected"
 * until the customer accepts it and it becomes an invoice.
 */
import { chip, untilChip } from '../chips';
import { estimateIsOpen, type EstimateStatus } from '../../money/status';
import { quotedWording } from '../../money/words';
import type { ValueFacts } from '../facts';
import { fingerprintOf } from '../fingerprint';
import type { AttentionSettings } from '../settings';
import { DAY, defineDetector, detection, ms, stamp, type Assessment } from './define';

export interface EstimateWaitingFacts {
  readonly estimate: {
    readonly id: string;
    readonly status: EstimateStatus;
    /** What it comes to, in cents. */
    readonly totalCents: number;
    readonly sentAt: string | null;
    /** When the customer first opened it; null when they haven't. */
    readonly viewedAt: string | null;
    /** When it stops being good; null when it never does. */
    readonly expiresAt: string | null;
    /** Whose it is: the estimate's assignee. */
    readonly assigneeUserId: string | null;
  };
}

function assess(f: EstimateWaitingFacts, settings: AttentionSettings, now: number): Assessment {
  const e = f.estimate;
  if (!estimateIsOpen(e.status) || !e.sentAt) return null;
  const sent = ms(e.sentAt);
  const expires = e.expiresAt ? ms(e.expiresAt) : null;
  const opens = sent + settings.money.estimateWaitingDays * DAY;
  // Once it has expired there's nothing to chase: the business reissues it.
  if (expires !== null && expires <= opens) return null;
  if (expires !== null && now >= expires) return null;
  if (now < opens) return { wakeAt: opens };
  const value: ValueFacts = {
    value: Math.max(0, Math.round(e.totalCents)),
    valueIsEstimate: true,
    moneyKey: `estimate:${e.id}`,
  };
  return detection({
    fingerprint: fingerprintOf('estimate_waiting', {
      estimate: e.id,
      sent: stamp(sent),
      total: value.value,
      opened: e.viewedAt !== null,
    }),
    since: sent,
    urgentFrom: null,
    dueAt: expires,
    value,
    probability: 0.5,
    confidence: 0.8,
    reasons: [
      chip('amount', quotedWording(value.value)),
      ...(expires !== null ? [untilChip('expires_in', expires, now)] : []),
      ...(e.viewedAt ? [] : [chip('not_viewed', 'not opened yet')]),
    ],
    assignee: e.assigneeUserId,
    // It clears when it stops being good.
    recheckAt: expires,
  });
}

export const { detect, wakeAt } = defineDetector<EstimateWaitingFacts>('estimate_waiting', assess);
