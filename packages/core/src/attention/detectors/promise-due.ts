/**
 * A promise not kept (Automations' "Promises not kept"): someone on the team told a customer they'd do something
 * by a time ("I'll send the quote tomorrow", "I'll call you back this afternoon") and nothing of the kind has
 * reached them since. An hour after that time, whoever said it is asked to follow through.
 *
 * Kept means something of its kind reached the customer after the promise: any message or call, a quote or an
 * invoice for "send", a visit booked for "visit". It lets go after 14 days.
 */
import { chip } from '../chips';
import { leadValue, type BusinessFacts, type LinkedLeadFacts } from '../facts';
import { fingerprintOf } from '../fingerprint';
import type { AttentionSettings } from '../settings';
import { DAY, defineDetector, detection, HOUR, ms, type Assessment } from './define';

/** Grace after the promised time before a person is asked. */
export const PROMISE_GRACE_MS = HOUR;
export const PROMISE_CARD_DAYS = 14;

export interface PromiseDueFacts {
  readonly business: BusinessFacts;
  readonly promise: {
    readonly id: string;
    /** "send the quote", "call you back". */
    readonly what: string;
    readonly kind: 'call' | 'send' | 'visit' | 'other';
    readonly dueAt: string;
    /** "Tue", "today at 3:00 PM": the due time as the business says it. */
    readonly dueLabel: string;
    readonly status: 'open' | 'kept' | 'dismissed';
  };
  /** When something of its kind reached them after the promise, or null. */
  readonly keptAt: string | null;
  readonly lead: LinkedLeadFacts | null;
  /** Whoever made the promise. */
  readonly assigneeUserId: string | null;
}

function assess(f: PromiseDueFacts, settings: AttentionSettings, now: number): Assessment {
  const p = f.promise;
  if (p.status !== 'open' || f.keptAt) return null;
  const due = ms(p.dueAt);
  const opens = due + PROMISE_GRACE_MS;
  const until = due + PROMISE_CARD_DAYS * DAY;
  if (now >= until) return null;
  if (now < opens) return { wakeAt: opens };
  return detection({
    fingerprint: fingerprintOf('promise_due', { promise: p.id }),
    since: due,
    urgentFrom: null,
    dueAt: due,
    value: leadValue(f.lead, f.business, settings),
    probability: 0.6,
    confidence: 0.6,
    reasons: [chip('promise', `You said: ${p.what} · ${p.dueLabel}`)],
    assignee: f.assigneeUserId,
    recheckAt: until,
  });
}

export const { detect, wakeAt } = defineDetector<PromiseDueFacts>('promise_due', assess);
