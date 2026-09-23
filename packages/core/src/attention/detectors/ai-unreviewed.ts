/**
 * Nobody reviewing the AI (Automations' "Nobody reviewing the AI"): the AI teammate is working and nobody has
 * looked at what it does for a week.
 * - In training, its replies wait for a person to approve them: three or more drafts in the last 7 days and none
 *   approved or rejected in 7 days (they expire unsent).
 * - In automatic, it replies on its own: three or more conversations it replied in over the last 7 days and nobody
 *   read, answered or took over one of its conversations in 7 days.
 * Only once it has been in that mode for a week. It goes when someone looks.
 */
import { chip } from '../chips';
import { leadValue, type BusinessFacts } from '../facts';
import { fingerprintOf } from '../fingerprint';
import type { AttentionSettings } from '../settings';
import { DAY, defineDetector, detection, ms, type Assessment } from './define';

/** How long with nobody looking. */
export const AI_UNREVIEWED_DAYS = 7;
/** How much work there has to be for it to matter. */
export const AI_UNREVIEWED_MIN_WORK = 3;

export interface AiUnreviewedFacts {
  readonly business: BusinessFacts;
  readonly teammate: {
    readonly id: string;
    readonly name: string;
    readonly status: 'off' | 'training' | 'automatic';
    /** When it went into its current mode. */
    readonly modeSince: string;
    /** Training: the drafts it made in the last 7 days. Automatic: the conversations it replied in. */
    readonly work: number;
    /** Training: the last draft a person decided. Automatic: the last time a person read, answered or took over. */
    readonly lastLookAt: string | null;
  };
}

function assess(f: AiUnreviewedFacts, settings: AttentionSettings, now: number): Assessment {
  const t = f.teammate;
  if (t.status === 'off' || t.work < AI_UNREVIEWED_MIN_WORK) return null;
  const window = AI_UNREVIEWED_DAYS * DAY;
  const opens = Math.max(ms(t.modeSince), t.lastLookAt ? ms(t.lastLookAt) : 0) + window;
  if (now < opens) return { wakeAt: opens };
  const label =
    t.status === 'training'
      ? `${t.work} ${t.work === 1 ? 'draft' : 'drafts'} · none reviewed in ${AI_UNREVIEWED_DAYS} days`
      : `${t.work} conversations · nobody looked in ${AI_UNREVIEWED_DAYS} days`;
  return detection({
    fingerprint: fingerprintOf('ai_unreviewed', {
      teammate: t.id,
      status: t.status,
      look: t.lastLookAt,
    }),
    since: opens,
    urgentFrom: null,
    dueAt: null,
    value: leadValue(null, f.business, settings),
    probability: 0.6,
    confidence: 0.8,
    reasons: [chip('unreviewed', label)],
    assignee: null,
    recheckAt: null,
  });
}

export const { detect, wakeAt } = defineDetector<AiUnreviewedFacts>('ai_unreviewed', assess);
