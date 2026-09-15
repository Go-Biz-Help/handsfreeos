/**
 * The website chat's volume limits (plan M7, "Abuse limits"). Each worker machine counts in memory, like the
 * booking page's per-address limits, and keeps separate counts per address, per visitor, per widget and per
 * business, so one noisy visitor, site or network can't use up the others' room. Floods of new visitors from
 * one network, repeated messages and the widget's daily cap on new chats are counted in the database instead,
 * across machines.
 */
import { HfosError } from '@hfos/core/server';
import type { RateRule } from '../http/booking';

const MIN = 60_000;
const HOUR = 60 * MIN;

export interface ChatLimits {
  /** Per address: the widget's settings. */
  readonly ipConfig: RateRule;
  /** Per address: chats started or picked up again. */
  readonly ipStart: RateRule;
  /** Per address: messages and details sent. */
  readonly ipSend: RateRule;
  /** Per address: the live stream, polling, heartbeats and read receipts. */
  readonly ipRead: RateRule;
  /** Per visitor: messages. */
  readonly visitorSend: RateRule;
  /** Per visitor: their name, number and email. */
  readonly visitorIdentify: RateRule;
  /** Per visitor: the live stream, polling, heartbeats and read receipts. */
  readonly visitorRead: RateRule;
  /** Per widget: messages, and chats started. */
  readonly widgetSend: RateRule;
  readonly widgetStart: RateRule;
  /** Per business, across its widgets: messages, and chats started. */
  readonly businessSend: RateRule;
  readonly businessStart: RateRule;
  /** New visitors from one network (a hashed address) in one business, counted in the database. */
  readonly networkNewVisitors: RateRule;
  /** The same message from one visitor: more than `max` in the window is refused. Never scaled. */
  readonly repeats: RateRule;
}

/** Production's limits. Outside production each volume limit is multiplied by 10 (one address runs everything). */
export const CHAT_LIMITS: ChatLimits = {
  ipConfig: { max: 60, timeWindow: MIN },
  ipStart: { max: 20, timeWindow: MIN },
  ipSend: { max: 30, timeWindow: MIN },
  ipRead: { max: 240, timeWindow: MIN },
  visitorSend: { max: 10, timeWindow: MIN },
  visitorIdentify: { max: 5, timeWindow: 10 * MIN },
  visitorRead: { max: 120, timeWindow: MIN },
  widgetSend: { max: 300, timeWindow: MIN },
  widgetStart: { max: 120, timeWindow: MIN },
  businessSend: { max: 600, timeWindow: MIN },
  businessStart: { max: 240, timeWindow: MIN },
  networkNewVisitors: { max: 30, timeWindow: HOUR },
  repeats: { max: 2, timeWindow: 10 * MIN },
};

export function chatLimitsFor(opts: {
  readonly limitFactor?: number;
  readonly limits?: Partial<ChatLimits>;
}): ChatLimits {
  const factor = Math.max(1, Math.floor(opts.limitFactor ?? 1));
  const out: Partial<Record<keyof ChatLimits, RateRule>> = {};
  for (const key of Object.keys(CHAT_LIMITS) as (keyof ChatLimits)[]) {
    const base = CHAT_LIMITS[key];
    out[key] =
      opts.limits?.[key] ??
      (key === 'repeats' ? base : { max: base.max * factor, timeWindow: base.timeWindow });
  }
  return out as ChatLimits;
}

export interface Hit {
  readonly key: string;
  readonly rule: RateRule;
}

/** Fixed windows per key, in memory. A refused request counts against none of its keys. */
export class KeyedLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private readonly now: () => number;
  private calls = 0;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  take(
    hits: readonly Hit[],
  ): { readonly ok: true } | { readonly ok: false; readonly retryAfterMs: number } {
    const now = this.now();
    if (++this.calls % 500 === 0)
      for (const [key, w] of this.windows) if (w.resetAt <= now) this.windows.delete(key);
    for (const hit of hits) {
      const w = this.windows.get(hit.key);
      if (w && w.resetAt > now && w.count >= hit.rule.max)
        return { ok: false, retryAfterMs: w.resetAt - now };
    }
    for (const hit of hits) {
      const w = this.windows.get(hit.key);
      if (w && w.resetAt > now) w.count += 1;
      else this.windows.set(hit.key, { count: 1, resetAt: now + hit.rule.timeWindow });
    }
    return { ok: true };
  }
}

export const rateLimited = (): HfosError =>
  HfosError.rule(
    'rate_limited',
    429,
    'That’s a lot of messages from here. Wait a minute and try again.',
  );
