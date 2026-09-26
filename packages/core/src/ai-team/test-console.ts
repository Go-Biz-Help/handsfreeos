/**
 * The test console's contract (M7 "Other work", and calls): what the web's console and the phone app's send the
 * worker's POST /v1/ai-team/test, and the events it streams back. The worker reads the request with
 * `TestConsoleInput` (apps/worker/src/ai-team/console.ts); the web and the phone read the stream with
 * `readTestEvents`. Browser-safe.
 *
 *   POST {worker}/v1/ai-team/test
 *   Authorization: Bearer <the session's access token>. Needs ai_team.manage.
 *   Accept: text/event-stream
 *   Body (JSON), TestConsoleInput:
 *     workspaceId  string
 *     personId     string | null   who to be: someone in Customers, or null for an unknown visitor or caller
 *     channel      'sms' | 'email' | 'chat' | 'phone'
 *     call         { direction, purpose, goal } | null
 *                  a phone test only: they call in ('inbound'), or the teammate calls them ('outbound') for one
 *                  of AI_CALL_PURPOSES; a campaign call says what it's about in `goal`
 *     at           string | null   pretend it's this time (ISO 8601); null is now
 *     config       object | null   the settings to test (the builder's unsaved draft); null tests the saved ones
 *     messages     { from: 'customer' | 'teammate', text: string }[]
 *                  the test so far, oldest first, ending with the customer's new message (at most 40). A phone test
 *                  starts with none: the call is picked up (or placed) and the teammate says its greeting.
 *
 *   A refusal before the stream starts is the API's JSON error, { error: { code, message, rule } }: 403
 *   without ai_team.manage, 429 when the AI limit is reached, 409 when an outgoing call has nothing to be about
 *   (no visit to confirm, no open quote). A 404 means the route isn't there yet.
 *
 *   Then server-sent events: one JSON object on `data:` lines, ended by a blank line. ": ping" comments keep
 *   the connection open and are ignored. Every `at` is ISO 8601.
 *     { type: 'started', runId, at }
 *     { type: 'delta', text }                     the reply grows by `text`
 *     { type: 'context', title, detail, at }      what it read first ("Read who he is")
 *     { type: 'knowledge', query, items: { id, title }[], at }
 *     { type: 'tool', name, title, detail, at }   a look-up (name is a TeammateToolName)
 *     { type: 'would', kind, summary, at }        a change it would have made; kind is one of WOULD_KINDS,
 *                                                 summary like "booked Thu 10 AM"
 *     { type: 'check', ok, passed: ReplyRule[], problems: { rule, message }[], rewritten, at }
 *                                                 checkTeammateReply on the final reply
 *     { type: 'note', title, detail, at }         anything else worth a line ("Disclosure line")
 *     { type: 'done', outcome, reply, draft, ended, toolSteps, ms, firstWordsMs }
 *                                                 outcome: replied, drafted, handed_off or no_reply; draft:
 *                                                 training wheels would hold it for an OK; ended: a phone test's
 *                                                 call is over (it said goodbye, or connected them to the team);
 *                                                 firstWordsMs: a phone test's reply started being said this long
 *                                                 in, while the rest was written (null when it wasn't)
 *     { type: 'error', message }                  the run stopped; the message is for people
 *   `detail`, `query` and `reply` may be null. Unknown event types are skipped.
 */
import { z } from 'zod';
import { aiCallPurpose, type AiCallPurpose } from '../schemas/ai-call';

/** What a test can be: the teammate's three written channels, and a phone call. */
export const TEST_CONSOLE_CHANNELS = ['sms', 'email', 'chat', 'phone'] as const;
export type TestConsoleChannel = (typeof TEST_CONSOLE_CHANNELS)[number];

export const TEST_CALL_DIRECTIONS = ['inbound', 'outbound'] as const;
export type TestCallDirection = (typeof TEST_CALL_DIRECTIONS)[number];

/** How long a campaign call's "what it's about" may be. */
export const TEST_CALL_GOAL_MAX = 300;
/** How many messages one test sends: the newest are kept. */
export const TEST_MESSAGES_MAX = 40;

const TestCall = z.object({
  direction: z.enum(TEST_CALL_DIRECTIONS),
  /** Why it calls them; an outgoing call only. */
  purpose: aiCallPurpose.nullable().default(null),
  /** A campaign call: what the owner wants from these calls. */
  goal: z.string().trim().max(TEST_CALL_GOAL_MAX).nullable().default(null),
});
export type TestCall = z.infer<typeof TestCall>;

/** The request (the worker reads it; the web and the phone send it). */
export const TestConsoleInput = z
  .object({
    workspaceId: z.uuid(),
    /** Who to be: someone in Customers, or null for an unknown visitor. */
    personId: z.uuid().nullable().default(null),
    channel: z.enum(TEST_CONSOLE_CHANNELS),
    /** A phone test: which way the call goes. */
    call: TestCall.nullable().default(null),
    /** Pretend it's this time; null is now. */
    at: z.iso.datetime({ offset: true }).nullable().default(null),
    /** The settings to test (the builder's unsaved draft); null tests the saved ones. */
    config: z.unknown().nullable().default(null),
    /** The test so far, oldest first, ending with the customer's new message; none starts a phone test. */
    messages: z
      .array(
        z.object({
          from: z.enum(['customer', 'teammate']),
          text: z.string().trim().min(1).max(2000),
        }),
      )
      .max(TEST_MESSAGES_MAX),
  })
  .superRefine((v, ctx) => {
    if (v.channel !== 'phone') {
      if (!v.messages.length)
        ctx.addIssue({ code: 'custom', path: ['messages'], message: 'Write a message first.' });
      return;
    }
    if (!v.call) {
      ctx.addIssue({ code: 'custom', path: ['call'], message: 'Say which way the call goes.' });
      return;
    }
    if (v.call.direction === 'inbound') return;
    if (!v.call.purpose)
      ctx.addIssue({ code: 'custom', path: ['call', 'purpose'], message: 'Pick why it calls.' });
    if (!v.personId)
      ctx.addIssue({
        code: 'custom',
        path: ['personId'],
        message: 'Pick a customer for it to call.',
      });
    if (v.call.purpose === 'campaign' && !v.call.goal)
      ctx.addIssue({
        code: 'custom',
        path: ['call', 'goal'],
        message: 'Say what the campaign call is about.',
      });
  });
export type TestConsoleInput = z.infer<typeof TestConsoleInput>;
/** What the web and the phone send: the fields with defaults may be left out. */
export type TestConsoleBody = z.input<typeof TestConsoleInput>;

export interface TestMessage {
  readonly from: 'customer' | 'teammate';
  readonly text: string;
}

/** A change it would have made. */
export const WOULD_KINDS = [
  'book',
  'reschedule',
  'cancel',
  'repeat',
  'waitlist',
  'note',
  'task',
  'stage',
  'answers',
  'discount',
  'money',
  'form',
  'hand_off',
  /** On a call it placed: they said the visit still works. */
  'confirm',
  /** On a call it placed: they asked not to be called again. */
  'no_calls',
] as const;
export type WouldKind = (typeof WOULD_KINDS)[number];

export const TEST_OUTCOMES = ['replied', 'drafted', 'handed_off', 'no_reply'] as const;
export type TestOutcome = (typeof TEST_OUTCOMES)[number];

export type TestEvent =
  | { readonly type: 'started'; readonly runId: string; readonly at: string }
  | { readonly type: 'delta'; readonly text: string }
  | {
      readonly type: 'context' | 'note';
      readonly title: string;
      readonly detail: string | null;
      readonly at: string;
    }
  | {
      readonly type: 'knowledge';
      readonly query: string | null;
      readonly items: readonly { readonly id: string; readonly title: string }[];
      readonly at: string;
    }
  | {
      readonly type: 'tool';
      readonly name: string;
      readonly title: string;
      readonly detail: string | null;
      readonly at: string;
    }
  | {
      readonly type: 'would';
      readonly kind: WouldKind;
      readonly summary: string;
      readonly at: string;
    }
  | {
      readonly type: 'check';
      readonly ok: boolean;
      readonly passed: readonly string[];
      readonly problems: readonly { readonly rule: string; readonly message: string }[];
      readonly rewritten: boolean;
      readonly at: string;
    }
  | {
      readonly type: 'done';
      readonly outcome: TestOutcome;
      readonly reply: string | null;
      readonly draft: boolean;
      /** A phone test's call is over. */
      readonly ended: boolean;
      readonly toolSteps: number;
      readonly ms: number;
      /** A phone test: how long until its first words could be said (null: only once the reply was done). */
      readonly firstWordsMs: number | null;
    }
  | { readonly type: 'error'; readonly message: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const words = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const when = (v: unknown): string =>
  typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : new Date().toISOString();

/** One event as the worker sent it, or null when it isn't one the console knows. */
export function parseTestEvent(raw: unknown): TestEvent | null {
  if (!isObj(raw)) return null;
  const at = when(raw.at);
  switch (raw.type) {
    case 'started': {
      const runId = words(raw.runId);
      return runId ? { type: 'started', runId, at } : null;
    }
    case 'delta': {
      const text = str(raw.text);
      return text !== null ? { type: 'delta', text } : null;
    }
    case 'context': {
      const title = words(raw.title);
      return title ? { type: 'context', title, detail: words(raw.detail), at } : null;
    }
    case 'note': {
      const title = words(raw.title);
      return title ? { type: 'note', title, detail: words(raw.detail), at } : null;
    }
    case 'knowledge': {
      const items = Array.isArray(raw.items)
        ? raw.items.flatMap((i) => {
            const title = isObj(i) ? words(i.title) : null;
            return title && isObj(i) ? [{ id: str(i.id) ?? '', title }] : [];
          })
        : [];
      return { type: 'knowledge', query: words(raw.query), items, at };
    }
    case 'tool': {
      const name = words(raw.name);
      return name
        ? { type: 'tool', name, title: words(raw.title) ?? name, detail: words(raw.detail), at }
        : null;
    }
    case 'would': {
      const summary = words(raw.summary);
      const kind = WOULD_KINDS.find((k) => k === raw.kind) ?? 'note';
      return summary ? { type: 'would', kind, summary, at } : null;
    }
    case 'check': {
      const passed = Array.isArray(raw.passed)
        ? raw.passed.filter((r): r is string => typeof r === 'string')
        : [];
      const problems = Array.isArray(raw.problems)
        ? raw.problems.flatMap((p) =>
            isObj(p) && typeof p.rule === 'string'
              ? [{ rule: p.rule, message: str(p.message) ?? '' }]
              : [],
          )
        : [];
      return {
        type: 'check',
        ok: typeof raw.ok === 'boolean' ? raw.ok : problems.length === 0,
        passed,
        problems,
        rewritten: raw.rewritten === true,
        at,
      };
    }
    case 'done': {
      const outcome = TEST_OUTCOMES.find((o) => o === raw.outcome);
      return outcome
        ? {
            type: 'done',
            outcome,
            reply: words(raw.reply),
            draft: raw.draft === true,
            ended: raw.ended === true,
            toolSteps: num(raw.toolSteps),
            ms: num(raw.ms),
            firstWordsMs:
              typeof raw.firstWordsMs === 'number' && Number.isFinite(raw.firstWordsMs)
                ? raw.firstWordsMs
                : null,
          }
        : null;
    }
    case 'error':
      return { type: 'error', message: words(raw.message) ?? 'The test stopped. Try again.' };
    default:
      return null;
  }
}

/** One event block's `data:` lines as an event; pings, comments and anything unreadable are skipped. */
export function parseTestBlock(block: string): TestEvent | null {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');
  if (!data) return null;
  try {
    return parseTestEvent(JSON.parse(data));
  } catch {
    return null;
  }
}

/**
 * Splits what has arrived so far into whole events, and keeps the rest for the next chunk. `\r\n` line endings are
 * made plain first, so a proxy that rewrites them can't hide the blank line between events.
 */
export function readTestEvents(buffer: string): { events: TestEvent[]; rest: string } {
  let rest = buffer.replace(/\r\n/g, '\n');
  const events: TestEvent[] = [];
  for (let end = rest.indexOf('\n\n'); end >= 0; end = rest.indexOf('\n\n')) {
    const event = parseTestBlock(rest.slice(0, end));
    rest = rest.slice(end + 2);
    if (event) events.push(event);
  }
  return { events, rest };
}

// ---- The console's words, the same on the web and the phone ----

/** Why it calls, as the console's picker says it. */
export const TEST_CALL_REASONS: Readonly<Record<AiCallPurpose, string>> = {
  confirm_visit: 'Confirm a visit',
  missed_call: 'Call back a missed call',
  quote: 'Follow up a quote',
  campaign: 'Campaign call',
};

/** What each channel is called in the console. */
export const TEST_CHANNEL_NAMES: Readonly<Record<TestConsoleChannel, string>> = {
  sms: 'Text',
  chat: 'Website chat',
  email: 'Email',
  phone: 'Phone call',
};

/** Ready-made lines to try, for the channel and, on a call, which way it goes and why. */
export function testSamples(channel: TestConsoleChannel, call: TestCall | null): string[] {
  if (channel !== 'phone')
    return [
      'How much does a visit cost?',
      'Can I book for Thursday morning?',
      'Are you a real person?',
      'I want to talk to someone',
    ];
  if (call?.direction !== 'outbound')
    return [
      'Hi, can I book a visit for Thursday?',
      'How much does a visit cost?',
      'Can I talk to someone?',
      'That’s all, bye!',
    ];
  switch (call.purpose) {
    case 'confirm_visit':
      return ['Yes, that still works', 'Can we move it to Friday?', 'Please don’t call me again'];
    case 'quote':
      return ['What does the quote include?', 'I’d like to go ahead', 'Please don’t call me again'];
    case 'campaign':
      return ['Sure, tell me more', 'Not interested, thanks. Bye!', 'Please don’t call me again'];
    default:
      return ['I wanted to book a visit', 'How much does a visit cost?', 'That’s all, bye!'];
  }
}

/** "texted", "wrote in the chat", "said": the log's first line of each turn. */
export function testVerb(channel: TestConsoleChannel): string {
  return channel === 'sms'
    ? 'texted'
    : channel === 'email'
      ? 'emailed'
      : channel === 'phone'
        ? 'said'
        : 'wrote in the chat';
}
