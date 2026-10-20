/**
 * A live test call from the test console: the AI teammate answers a call in real time, on the settings being
 * tested, and the manager hears it as a caller would, with the timing a caller would get. Changes are pretend,
 * as in every test (the console's `would` lines), and nothing reaches a customer.
 *
 * Two ways to place it:
 * - `phone`: the browser rings the business's own phone line (Twilio's browser calling), so what's heard is a
 *   phone call end to end: the carrier, phone audio, and the live listener and voice a real call gets.
 * - `browser`: the browser sends its microphone straight to the worker and plays what comes back, as phone audio
 *   (voice/phone-audio.ts). No phone line: for a business without a number yet, or where calls aren't set up.
 *
 * Both run the loop a real call runs (the worker's voice-agent/session.ts). One websocket carries the console's
 * side of it, `wss://{worker}/v1/ai-team/test/call`:
 *
 *   → { type: 'start', token, way, test }   first: the session's access token, and what to test (TestCallSettings)
 *   → binary                                 browser way: the microphone, 8 kHz μ-law
 *   → { type: 'played', name }               browser way: everything sent before that mark has played
 *   → { type: 'hang_up' }
 *   ← { type: 'dial', ticket }               phone way: place the call with the ticket (dialParams)
 *   ← { type: 'answered' }                   the call is up; the greeting comes next
 *   ← { type: 'turn', turn, said }           a turn starts: what the caller said (turn 0 is the pickup, with none)
 *   ← { type: 'event', turn, event }         the console's TestEvent for that turn, as a written test gets it
 *   ← { type: 'hearing', text }              what the listener has heard of them so far (not final)
 *   ← { type: 'cut', turn }                  they talked over that turn's reply, so the rest wasn't said
 *   ← { type: 'timing', turn, timing }       where the turn's time went, to the first sound of its answer
 *   ← { type: 'ended', outcome, summary }    the call is over (the socket closes after)
 *   ← { type: 'error', message }             it couldn't start or go on (the socket closes after)
 *   ← binary                                 browser way: what it says, 8 kHz μ-law
 *   ← { type: 'clear' }                      browser way: stop playing now (they talked over it)
 *   ← { type: 'mark', name }                 browser way: send `played` once everything before it has played
 */
import { z } from 'zod';
import { parseTestEvent, type TestCall, type TestEvent } from './test-console';

export const TEST_CALL_WAYS = ['phone', 'browser'] as const;
export type TestCallWay = (typeof TEST_CALL_WAYS)[number];

/** How each way is named where it's picked. */
export const TEST_CALL_WAY_NAMES: Readonly<Record<TestCallWay, string>> = {
  phone: 'Phone line',
  browser: 'This browser',
};

/** What each way is, in a sentence. */
export const TEST_CALL_WAY_HINTS: Readonly<Record<TestCallWay, string>> = {
  phone:
    'Rings your business number from this browser, so you hear exactly what a caller hears, phone line and all.',
  browser:
    'Talks straight from this browser, in phone-quality sound, without using your phone line. Headphones keep it from hearing itself.',
};

/**
 * The number a test call over the phone line is placed to. It's never a phone: the worker answers it with the AI
 * teammate, and Twilio's reports about it stay out of the call log.
 */
export const TEST_CALL_TO = 'hfos:test-call';
/** The browser call's parameter that carries the test call's ticket. */
export const TEST_CALL_PARAM = 'HfosTest';

/** The parameters the browser places a test call over the phone line with. */
export function dialParams(ticket: string): Record<string, string> {
  return { To: TEST_CALL_TO, [TEST_CALL_PARAM]: ticket };
}

/** What a test call tests: the test console's request without the channel (a call) or messages (it's live). */
export interface TestCallSettings {
  readonly workspaceId: string;
  readonly personId: string | null;
  readonly call: TestCall;
  readonly at: string | null;
  readonly config: unknown;
}

/** The console's messages to the worker, as the worker reads them. */
export const TestCallClientMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('start'),
    token: z.string().min(1).max(10_000),
    way: z.enum(TEST_CALL_WAYS),
    test: z.record(z.string(), z.unknown()),
  }),
  z.object({ type: z.literal('played'), name: z.string().min(1).max(100) }),
  z.object({ type: z.literal('hang_up') }),
]);
export type TestCallClientMessage = z.infer<typeof TestCallClientMessage>;

/** Where one turn's time went, from the end of the caller's words to the first sound of the answer. */
export interface TestCallTiming {
  /** The whole wait: the end of their words to the first sound. */
  readonly firstSoundMs: number | null;
  /** Their last word, until the listener said they'd finished (null: it didn't say when their words ended). */
  readonly heardMs: number | null;
  /** Before the AI was asked: the knowledge that matches their words, and the budget. */
  readonly loadMs: number | null;
  /** Asked, until its answer started coming back. */
  readonly waitMs: number | null;
  /** Its answer started, until the first sentence was written and checked. */
  readonly sentenceMs: number | null;
  /** The first sentence ready, until its first sound went down the line. */
  readonly voiceMs: number | null;
  /** It thought before it wrote anything. */
  readonly thought: boolean;
}

export const TEST_CALL_OUTCOMES = ['replied', 'handed_off', 'no_reply'] as const;
export type TestCallOutcome = (typeof TEST_CALL_OUTCOMES)[number];

/** The worker's messages to the console. */
export type TestCallServerMessage =
  | { readonly type: 'dial'; readonly ticket: string }
  | { readonly type: 'answered' }
  | { readonly type: 'turn'; readonly turn: number; readonly said: string }
  | { readonly type: 'event'; readonly turn: number; readonly event: TestEvent }
  | { readonly type: 'hearing'; readonly text: string }
  | { readonly type: 'cut'; readonly turn: number }
  | { readonly type: 'timing'; readonly turn: number; readonly timing: TestCallTiming }
  | { readonly type: 'clear' }
  | { readonly type: 'mark'; readonly name: string }
  | { readonly type: 'ended'; readonly outcome: TestCallOutcome; readonly summary: string }
  | { readonly type: 'error'; readonly message: string };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const turnOf = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
const msOf = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

function timingOf(v: unknown): TestCallTiming | null {
  if (!isObj(v)) return null;
  return {
    firstSoundMs: msOf(v.firstSoundMs),
    heardMs: msOf(v.heardMs),
    loadMs: msOf(v.loadMs),
    waitMs: msOf(v.waitMs),
    sentenceMs: msOf(v.sentenceMs),
    voiceMs: msOf(v.voiceMs),
    thought: v.thought === true,
  };
}

/** One of the worker's messages as the console reads it, or null when it isn't one it knows. */
export function parseTestCallMessage(raw: unknown): TestCallServerMessage | null {
  if (!isObj(raw)) return null;
  switch (raw.type) {
    case 'dial': {
      const ticket = text(raw.ticket);
      return ticket ? { type: 'dial', ticket } : null;
    }
    case 'answered':
      return { type: 'answered' };
    case 'turn': {
      const turn = turnOf(raw.turn);
      return turn === null ? null : { type: 'turn', turn, said: text(raw.said) ?? '' };
    }
    case 'event': {
      const turn = turnOf(raw.turn);
      const event = parseTestEvent(raw.event);
      return turn === null || !event ? null : { type: 'event', turn, event };
    }
    case 'hearing':
      return { type: 'hearing', text: text(raw.text) ?? '' };
    case 'cut': {
      const turn = turnOf(raw.turn);
      return turn === null ? null : { type: 'cut', turn };
    }
    case 'timing': {
      const turn = turnOf(raw.turn);
      const timing = timingOf(raw.timing);
      return turn === null || !timing ? null : { type: 'timing', turn, timing };
    }
    case 'clear':
      return { type: 'clear' };
    case 'mark': {
      const name = text(raw.name);
      return name ? { type: 'mark', name } : null;
    }
    case 'ended': {
      const outcome = TEST_CALL_OUTCOMES.find((o) => o === raw.outcome) ?? 'replied';
      return { type: 'ended', outcome, summary: text(raw.summary) ?? '' };
    }
    case 'error':
      return {
        type: 'error',
        message: text(raw.message)?.trim() || 'The test call stopped. Try again.',
      };
    default:
      return null;
  }
}

/**
 * "First sound 1.7 s after they stopped · heard they’d stopped 0.4 s · the AI starts 0.6 s · first sentence 0.3 s
 * · voice 0.2 s": a live turn's timing, as the console shows it under the turn.
 */
export function testCallTimingLine(t: TestCallTiming, seconds: (ms: number) => string): string {
  return [
    t.firstSoundMs !== null ? `first sound ${seconds(t.firstSoundMs)} after they stopped` : null,
    t.heardMs !== null ? `heard they’d stopped ${seconds(t.heardMs)}` : null,
    t.loadMs !== null ? `loading ${seconds(t.loadMs)}` : null,
    t.waitMs !== null ? `the AI starts ${seconds(t.waitMs)}` : null,
    t.sentenceMs !== null ? `first sentence ${seconds(t.sentenceMs)}` : null,
    t.voiceMs !== null ? `voice ${seconds(t.voiceMs)}` : null,
    t.thought ? 'it thought first' : null,
  ]
    .filter(Boolean)
    .join(' · ');
}
