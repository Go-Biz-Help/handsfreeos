/**
 * A connection broken or silent (Automations' "Connection broke" and "Connection went silent"): the systems the
 * business connected — Stripe or Square, a calendar, an email inbox, Google or Facebook reviews, a phone number.
 *
 * - `connection_error`: it stopped working (a sign-in expired, access was removed, the provider refused it).
 *   Urgent at once — payments, bookings or messages are failing until someone reconnects — and never dismissed.
 *   Owners and admins also get a push (the worker's, from the event that broke it).
 * - `connection_silent`: it says it's fine but hasn't brought anything in for three times its usual gap (and at
 *   least two hours): a sync that quietly stopped.
 *
 * Both read the same facts, and only one holds at a time: a broken connection isn't also "silent".
 */
import { chip, sinceChip } from '../chips';
import { leadValue, type BusinessFacts } from '../facts';
import { fingerprintOf } from '../fingerprint';
import type { AttentionSettings } from '../settings';
import { HOUR, defineDetector, detection, ms, type Assessment } from './define';

/** Silent is this many usual gaps with nothing... */
export const CONNECTION_SILENT_GAPS = 3;
/** ...and at least this long. */
export const CONNECTION_SILENT_MIN_MS = 2 * HOUR;

/** Which page fixes it. */
export type ConnectionSystem = 'payments' | 'calendar' | 'mailbox' | 'reviews' | 'phone';
/** What went wrong: the sign-in expired, access was taken back, or it failed. */
export type ConnectionProblem = 'reauth' | 'revoked' | 'failed';

export const CONNECTION_PROBLEM_WORDS: Readonly<Record<ConnectionProblem, string>> = {
  reauth: 'Sign-in expired',
  revoked: 'Access removed',
  failed: 'Stopped working',
};

export interface ConnectionFacts {
  readonly business: BusinessFacts;
  readonly connection: {
    readonly id: string;
    readonly system: ConnectionSystem;
    /** What people call it: "Stripe", "Google Calendar · Dale", "(512) 555-0142". */
    readonly name: string;
    readonly problem: ConnectionProblem | null;
    /** When it broke, as near as the row says. */
    readonly brokenSince: string | null;
    /** Its last successful sync, for the ones that sync. */
    readonly lastDataAt: string | null;
    /** How often it normally syncs, or null when it doesn't. */
    readonly usualGapMs: number | null;
    /** Whose it is (a person's own calendar or inbox), or null for the business's. */
    readonly userId: string | null;
  };
}

/** When a syncing connection counts as silent, or null when it can't. */
export function silentAt(c: ConnectionFacts['connection']): number | null {
  if (c.problem || !c.lastDataAt || c.usualGapMs === null) return null;
  return (
    ms(c.lastDataAt) + Math.max(CONNECTION_SILENT_GAPS * c.usualGapMs, CONNECTION_SILENT_MIN_MS)
  );
}

function assessError(f: ConnectionFacts, settings: AttentionSettings, now: number): Assessment {
  const c = f.connection;
  if (!c.problem) return null;
  const since = c.brokenSince ? Math.min(ms(c.brokenSince), now) : now;
  return detection({
    fingerprint: fingerprintOf('connection_error', { connection: c.id, problem: c.problem }),
    since,
    urgentFrom: since,
    dueAt: null,
    value: leadValue(null, f.business, settings),
    probability: 0.9,
    confidence: 0.9,
    reasons: [chip('broken', CONNECTION_PROBLEM_WORDS[c.problem])],
    assignee: c.userId,
    recheckAt: null,
  });
}

function assessSilent(f: ConnectionFacts, settings: AttentionSettings, now: number): Assessment {
  const c = f.connection;
  const at = silentAt(c);
  if (at === null) return null;
  if (now < at) return { wakeAt: at };
  return detection({
    fingerprint: fingerprintOf('connection_silent', { connection: c.id, last: c.lastDataAt }),
    since: at,
    urgentFrom: null,
    dueAt: null,
    value: leadValue(null, f.business, settings),
    probability: 0.6,
    confidence: 0.7,
    reasons: [sinceChip('silent', ms(c.lastDataAt!), now)],
    assignee: c.userId,
    recheckAt: null,
  });
}

export const connectionError = defineDetector<ConnectionFacts>('connection_error', assessError);
export const connectionSilent = defineDetector<ConnectionFacts>('connection_silent', assessSilent);
