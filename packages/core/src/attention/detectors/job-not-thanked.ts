/**
 * A customer nobody thanked (Automations' "Thank-you after the job"): two hours after a job was marked done,
 * HandsFreeOS tried to thank them and couldn't (no AI teammate, or it's switched off), so a person is asked to.
 *
 * It holds while nobody has written to them since the job was done, for three days: a thank-you a week later
 * reads oddly, so the card lets it go. Automations' switch decides whether a thank-you is tried at all, so the
 * card never opens while it's off.
 */
import { sinceChip } from '../chips';
import { leadValue, type BusinessFacts, type LinkedLeadFacts } from '../facts';
import { fingerprintOf } from '../fingerprint';
import type { AttentionSettings } from '../settings';
import { DAY, defineDetector, detection, ms, type Assessment } from './define';

/** How long the card offers the thank-you. */
export const THANK_YOU_CARD_DAYS = 3;

export interface JobNotThankedFacts {
  readonly business: BusinessFacts;
  readonly thankYou: {
    readonly id: string;
    /** When the job was marked done. */
    readonly completedAt: string;
    /** What the thank-you job recorded: only `card` opens one. */
    readonly outcome: 'sent' | 'drafted' | 'card' | 'skipped';
    /** The latest message to them since the job was done (by anybody), or null. */
    readonly contactedAt: string | null;
    readonly personArchived: boolean;
  };
  /** Automations' "Thank-you after the job" switch. */
  readonly switchOn: boolean;
  readonly lead: LinkedLeadFacts | null;
  readonly assigneeUserId: string | null;
}

function assess(f: JobNotThankedFacts, settings: AttentionSettings, now: number): Assessment {
  const t = f.thankYou;
  if (!f.switchOn || t.outcome !== 'card' || t.personArchived || t.contactedAt) return null;
  const done = ms(t.completedAt);
  const until = done + THANK_YOU_CARD_DAYS * DAY;
  if (now >= until) return null;
  const value = leadValue(f.lead, f.business, settings);
  return detection({
    fingerprint: fingerprintOf('job_not_thanked', { thankYou: t.id }),
    since: done,
    urgentFrom: null,
    dueAt: null,
    value,
    probability: 0.3,
    confidence: 0.8,
    reasons: [sinceChip('job_done', done, now)],
    assignee: f.assigneeUserId,
    // Look again when the offer runs out.
    recheckAt: until,
  });
}

export const { detect, wakeAt } = defineDetector<JobNotThankedFacts>('job_not_thanked', assess);
