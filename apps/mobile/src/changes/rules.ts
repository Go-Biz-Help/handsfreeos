import {
  CONFIRMED_MINUTES,
  DEFAULT_TELEPHONY_SETTINGS,
  quietHoursState,
  type QuietHoursWindow,
} from '@hfos/core';

import { freshMinutesOf } from './commands';

/**
 * The queue's rules as plain functions (the plan's "A command runs once", "Send if fresh, otherwise ask" and "The
 * queue keeps order without jamming"), the same as the Node phone that proved them against the real API and PowerSync
 * (`apps/sync/test/harness/phone.ts`).
 */

/**
 * Where a change stands:
 * - `waiting`: made, and waiting its turn (for signal, or behind the changes made before it);
 * - `sending`: on its way to HandsFreeOS, tried again in place for up to a minute;
 * - `held`: waiting for a change or photo it depends on to go through first;
 * - `ask`: waiting for the person ("Still send?", quiet hours, or another question the API asks);
 * - `refused`: HandsFreeOS said no, and why; it never goes again unless the person fixes it;
 * - `retry`: couldn't get through for a minute, so it's set aside and sent again later, in order;
 * - `sent`: done.
 */
export type ChangeState = 'waiting' | 'sending' | 'held' | 'ask' | 'refused' | 'retry' | 'sent';

/** The states a person has to answer. */
export const NEEDS_YOU: readonly ChangeState[] = ['ask', 'refused'];

/** How long the uploader keeps trying a change in place before setting it aside (the Node phone's minute). */
export const RETRY_IN_PLACE_MS = 60_000;

/**
 * How long a set-aside change waits before it's sent again, round after round without getting through. Signal coming
 * back and the app coming to the front send them at once.
 */
export const RETRY_LATER_MS: readonly number[] = [30_000, 60_000, 120_000, 300_000, 600_000];

export function retryLaterDelay(round: number): number {
  return RETRY_LATER_MS[Math.min(Math.max(round, 0), RETRY_LATER_MS.length - 1)]!;
}

/** Sent changes stay listed under "Sent just now" this long, and are cleared from the phone after a day. */
export const SENT_SHOWN_MS = 2 * 60 * 60_000;
export const SENT_KEPT_MS = 24 * 60 * 60_000;

const MINUTE = 60_000;

// ------------------------------------------------------------------------------------------------ the API's answer

/** What came back from sending one command. */
export type Answer =
  /** Nothing came back: no signal, a timeout, or no token to send. */
  | { readonly reached: false; readonly message: string }
  | { readonly reached: true; readonly status: number; readonly body: unknown };

export interface RefusalBody {
  readonly error: {
    readonly code?: string;
    readonly message?: string;
    readonly rule?: string;
    readonly details?: unknown;
    readonly disposition?: 'final' | 'retry' | 'ask';
  };
}

/** A refusal's error, from its body (or the body as the outbox keeps it, JSON text). */
export function refusalOf(body: unknown): RefusalBody['error'] | null {
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body) as unknown;
    } catch {
      return null;
    }
  }
  if (!body || typeof body !== 'object' || !('error' in body)) return null;
  const error = (body as { error: unknown }).error;
  return error && typeof error === 'object' ? (error as RefusalBody['error']) : null;
}

/** What the uploader does with an answer. */
export type Outcome =
  | { readonly kind: 'sent'; readonly output: unknown }
  | {
      readonly kind: 'refused' | 'ask';
      readonly message: string;
      readonly rule: string | null;
      readonly body: unknown;
    }
  | { readonly kind: 'retry'; readonly message: string; readonly body: unknown }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'too_old'; readonly minVersion: string | null };

/**
 * - Applied (2xx): sent.
 * - 401: refresh the sign-in, then try again.
 * - 426: this build is too old; stop sending and keep everything.
 * - `final`: refused, with the API's words. `ask`: kept for the person.
 * - No answer, 5xx, `retry`, or a refusal without a disposition: try again.
 */
export function outcomeOf(answer: Answer): Outcome {
  if (!answer.reached) return { kind: 'retry', message: answer.message, body: null };
  const { status, body } = answer;
  if (status >= 200 && status < 300) return { kind: 'sent', output: body };
  if (status === 401) return { kind: 'unauthorized' };
  const error = refusalOf(body);
  if (status === 426) {
    const details = error?.details as { minVersion?: unknown } | undefined;
    return {
      kind: 'too_old',
      minVersion: typeof details?.minVersion === 'string' ? details.minVersion : null,
    };
  }
  const message = error?.message ?? `HandsFreeOS answered ${status}.`;
  if (status >= 500 || !error?.disposition || error.disposition === 'retry')
    return { kind: 'retry', message, body };
  return {
    kind: error.disposition === 'ask' ? 'ask' : 'refused',
    message,
    rule: error.rule ?? (error.code === 'validation' ? 'validation' : null),
    body,
  };
}

// --------------------------------------------------------------------------------------------- when it may go

/**
 * Whether a customer-facing change has waited too long to go on its own: made longer ago than its fresh minutes, and
 * not answered "Still send?" yes within the last few minutes (the API's `stale_action` rule, on the phone's clock).
 */
export function isStale(input: {
  readonly name: string;
  readonly madeAt: number;
  readonly confirmedAt: number | null;
  readonly now: number;
}): boolean {
  const fresh = freshMinutesOf(input.name);
  if (fresh === null || input.now - input.madeAt <= fresh * MINUTE) return false;
  return !(
    input.confirmedAt !== null && input.now - input.confirmedAt <= CONFIRMED_MINUTES * MINUTE
  );
}

/** When a customer-facing change stops going on its own, or null for a change that never asks. */
export function staleAfter(name: string, madeAt: number): number | null {
  const fresh = freshMinutesOf(name);
  return fresh === null ? null : madeAt + fresh * MINUTE;
}

/** The quiet-hours question for a text about to go: the business's time now and when quiet hours end. */
export interface QuietHoursQuestion {
  /** HH:MM, where the business is. */
  readonly localTime: string;
  /** HH:MM: when quiet hours end. */
  readonly endsAt: string;
  /** HH:MM: when quiet hours start. */
  readonly startsAt: string;
}

/** The business's quiet hours for texts, from its synced settings (JSON text or an object), or the default. */
export function quietHoursWindow(settings: unknown): QuietHoursWindow {
  let parsed: unknown = settings;
  if (typeof settings === 'string') {
    try {
      parsed = JSON.parse(settings);
    } catch {
      parsed = null;
    }
  }
  const stored = (parsed as { telephony?: { quietHours?: unknown } } | null)?.telephony?.quietHours;
  const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (
    stored &&
    typeof stored === 'object' &&
    typeof (stored as QuietHoursWindow).enabled === 'boolean' &&
    clock.test(String((stored as QuietHoursWindow).start)) &&
    clock.test(String((stored as QuietHoursWindow).end))
  )
    return stored as QuietHoursWindow;
  return DEFAULT_TELEPHONY_SETTINGS.quietHours;
}

/**
 * Whether a text would go inside the business's quiet hours, and so asks "Send now, or at 8:00 AM when quiet hours
 * end?" first: a `message.send` by text (the default channel) that hasn't been answered either way, judged at `now`
 * in the business's own time zone. Email and chat have no quiet hours.
 */
export function quietHoursQuestion(input: {
  readonly name: string;
  readonly input: unknown;
  readonly settings: unknown;
  readonly timeZone: string;
  readonly now: Date;
}): QuietHoursQuestion | null {
  if (input.name !== 'message.send') return null;
  const text = (input.input ?? {}) as {
    channel?: string;
    acknowledgeQuietHours?: boolean;
    sendAfterQuietHours?: boolean;
  };
  if ((text.channel ?? 'sms') !== 'sms' || text.acknowledgeQuietHours || text.sendAfterQuietHours)
    return null;
  const window = quietHoursWindow(input.settings);
  let state;
  try {
    state = quietHoursState(window, input.timeZone, input.now);
  } catch {
    // A time zone this phone can't read: the server still checks.
    return null;
  }
  if (!state.quiet) return null;
  return { localTime: state.localTime, endsAt: window.end, startsAt: window.start };
}

// ------------------------------------------------------------------------------------------------ what it waits on

export interface Dependency {
  readonly id: string;
  readonly state: ChangeState;
}

/**
 * The changes and photos that keep a change from going: every one it depends on that hasn't gone through yet. A
 * change goes only once all of them are sent; until then it's held, all the way down a chain, and released when the
 * last of them is sent. A dependency missing from the outbox was discarded, and holds it for good.
 */
export function blockersOf(
  dependsOn: readonly string[],
  found: readonly Dependency[],
): { readonly id: string; readonly state: ChangeState | 'gone' }[] {
  const byId = new Map(found.map((d) => [d.id, d.state]));
  return dependsOn
    .map((id) => ({ id, state: byId.get(id) ?? ('gone' as const) }))
    .filter((d) => d.state !== 'sent');
}

export function parseIds(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** Whether a set-aside change may still be tried in place: less than a minute since the first try. */
export function keepTryingInPlace(firstTriedAt: number, now: number, windowMs = RETRY_IN_PLACE_MS) {
  return now - firstTriedAt < windowMs;
}
