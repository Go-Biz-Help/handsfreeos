/**
 * A referral (Automations' "Referral mentioned"): a customer said somebody else needs the business ("my
 * neighbour Jan needs her AC looked at"), and the worker's AI read agreed. The card offers "Create lead".
 *
 * It holds while the referral is still only mentioned, for thirty days; creating the lead (or the person it
 * would make already being a lead) is what finishes it.
 */
import { chip } from '../chips';
import { leadValue, type BusinessFacts } from '../facts';
import { fingerprintOf } from '../fingerprint';
import type { AttentionSettings } from '../settings';
import { DAY, clip, defineDetector, detection, ms, type Assessment } from './define';

export const REFERRAL_CARD_DAYS = 30;

export interface ReferralMentionedFacts {
  readonly business: BusinessFacts;
  readonly referral: {
    readonly id: string;
    readonly status: 'mentioned' | 'lead_created' | 'dismissed';
    readonly createdAt: string;
    readonly relation: string | null;
    readonly need: string | null;
  };
  /** Who looks after the customer who mentioned them: their top lead's or conversation's owner. */
  readonly assigneeUserId: string | null;
}

function assess(f: ReferralMentionedFacts, settings: AttentionSettings, now: number): Assessment {
  const r = f.referral;
  if (r.status !== 'mentioned') return null;
  const at = ms(r.createdAt);
  const until = at + REFERRAL_CARD_DAYS * DAY;
  if (now >= until) return null;
  const words = [r.relation, r.need].filter((w): w is string => !!w?.trim()).join(' · ');
  return detection({
    fingerprint: fingerprintOf('referral_mentioned', { referral: r.id }),
    since: at,
    urgentFrom: null,
    dueAt: null,
    // Somebody new: the typical job, as an estimate.
    value: leadValue(null, f.business, settings),
    probability: 0.4,
    confidence: 0.7,
    reasons: words ? [chip('referral', clip(words, 60))] : [],
    assignee: f.assigneeUserId,
    recheckAt: until,
  });
}

export const { detect, wakeAt } = defineDetector<ReferralMentionedFacts>(
  'referral_mentioned',
  assess,
);
