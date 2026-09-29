/**
 * Texting turned down (HANDSFREEOS_ONBOARDING_IMPLEMENTATION_PLAN.md §6): the carriers refused the business's
 * texting registration. Getting started counted the number step done once the details were sent, and the refusal can
 * come weeks later, when nobody is looking at the guide any more; owners get an email, and this puts it on Home.
 *
 * One card per registration row, and only the newest of its kind for the business's current number, as Settings →
 * Texting & calls reads them: an older row left behind by a changed number isn't the business's problem now. It goes
 * once the details are sent again (the same row goes back to submitted) or approved.
 */
import { chip } from '../chips';
import { leadValue, type BusinessFacts } from '../facts';
import { fingerprintOf } from '../fingerprint';
import type { AttentionSettings } from '../settings';
import { defineDetector, detection, ms, type Assessment } from './define';

export interface TextingRejectedFacts {
  readonly business: BusinessFacts;
  readonly registration: {
    readonly id: string;
    readonly status: string;
    /** The carriers' own words, when they gave any. */
    readonly rejectionReason: string | null;
    /** When the details were last sent: a second refusal of new details is a new card. */
    readonly submittedAt: string | null;
    /** When it was turned down, as near as the row says. */
    readonly rejectedAt: string;
    /** The newest of its kind for the business's current number. */
    readonly current: boolean;
  };
}

function assess(f: TextingRejectedFacts, settings: AttentionSettings, now: number): Assessment {
  const r = f.registration;
  if (r.status !== 'rejected' || !r.current) return null;
  const since = Math.min(ms(r.rejectedAt), now);
  return detection({
    fingerprint: fingerprintOf('texting_rejected', {
      registration: r.id,
      sent: r.submittedAt,
      reason: r.rejectionReason,
    }),
    since,
    urgentFrom: since,
    dueAt: null,
    value: leadValue(null, f.business, settings),
    probability: 0.9,
    confidence: 0.95,
    reasons: [chip('broken', 'Turned down by the carriers')],
    assignee: null,
    recheckAt: null,
  });
}

export const { detect, wakeAt } = defineDetector<TextingRejectedFacts>('texting_rejected', assess);

/** How much of the carriers' reason the card quotes, so what to do next always fits after it. */
const REASON_MAX = 180;

/** The card's words: the carriers' reason, quoted, and what to do, as the email says it. */
export function textingRejectedWords(
  reason: string | null,
  number: string | null,
): { readonly title: string; readonly detail: string } {
  const said = reason?.replace(/\s+/g, ' ').trim() ?? '';
  const quoted =
    said.length > REASON_MAX
      ? `${said.slice(0, REASON_MAX - 1).trimEnd()}…`
      : said.replace(/[.\s]+$/, '');
  return {
    title: number
      ? `The carriers turned down texting for ${number}`
      : 'The carriers turned down texting',
    detail: `${quoted ? `Their reason: “${quoted}${/[.!?…]$/.test(quoted) ? '' : '.'}” ` : 'They didn’t give a reason. '}Fix your details in Settings → Texting & calls and send them again. Calls keep working meanwhile.`,
  };
}
