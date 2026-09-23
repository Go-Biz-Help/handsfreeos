/**
 * A channel gone quiet (Automations' "Channel went quiet"): the business's texts, calls, email or website chat
 * usually bring something in, and nothing has for three times its usual gap — counted in open hours, and at least
 * one open day. A number that stopped ringing or a chat box that fell off the website is found by its silence,
 * not by an error.
 *
 * Only a channel that's busy enough to have a usual gap counts (ten or more in the last 30 days). The card goes the
 * moment something comes in again.
 */
import { chip, sinceChip } from '../chips';
import { leadValue, type BusinessFacts } from '../facts';
import { fingerprintOf } from '../fingerprint';
import type { AttentionSettings } from '../settings';
import { DAY, HOUR, MINUTE, defineDetector, detection, ms, type Assessment } from './define';

/** How many in the last 30 days make a channel one that "usually" gets something. */
export const CHANNEL_QUIET_MIN_COUNT = 10;
/** Quiet is this many usual gaps with nothing. */
export const CHANNEL_QUIET_GAPS = 3;

export type ChannelKind = 'text' | 'call' | 'email' | 'chat';

export const CHANNEL_WORDS: Readonly<Record<ChannelKind, string>> = {
  text: 'Texts',
  call: 'Calls',
  email: 'Email',
  chat: 'Website chat',
};

export interface ChannelQuietFacts {
  readonly business: BusinessFacts;
  readonly channel: {
    /** Derived from the business and the channel: there is one of each. */
    readonly id: string;
    readonly kind: ChannelKind;
    /** What came in over the last 30 days. */
    readonly count: number;
    readonly lastInboundAt: string | null;
    /** The median time between two of them. */
    readonly usualGapMs: number;
    /** When it counts as quiet: three usual gaps of open time after the last one, and at least an open day. */
    readonly quietAt: string | null;
  };
}

/** "2 h", "40 min", "3 days". */
export function gapWords(gap: number): string {
  if (gap >= 2 * DAY) return `${Math.round(gap / DAY)} days`;
  if (gap >= HOUR) {
    const h = Math.round(gap / HOUR);
    return `${h} h`;
  }
  return `${Math.max(1, Math.round(gap / MINUTE))} min`;
}

function assess(f: ChannelQuietFacts, settings: AttentionSettings, now: number): Assessment {
  const c = f.channel;
  if (c.count < CHANNEL_QUIET_MIN_COUNT || !c.lastInboundAt || !c.quietAt) return null;
  const opens = ms(c.quietAt);
  if (now < opens) return { wakeAt: opens };
  return detection({
    fingerprint: fingerprintOf('channel_quiet', { channel: c.id, last: c.lastInboundAt }),
    since: opens,
    urgentFrom: null,
    dueAt: null,
    value: leadValue(null, f.business, settings),
    probability: 0.5,
    confidence: 0.7,
    reasons: [
      chip('quiet_channel', `${CHANNEL_WORDS[c.kind]} usually every ${gapWords(c.usualGapMs)}`),
      sinceChip('silent', ms(c.lastInboundAt), now),
    ],
    assignee: null,
    recheckAt: null,
  });
}

export const { detect, wakeAt } = defineDetector<ChannelQuietFacts>('channel_quiet', assess);
