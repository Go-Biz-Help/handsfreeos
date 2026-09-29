import {
  stepsLine,
  testVerb,
  type TestConsoleChannel,
  type TestEvent,
  type TestMessage,
  type TestOutcome,
  type TestSteps,
} from '@hfos/core';

/**
 * The phone's test console, worked out (the screen draws it: components/ai-team/test-console.tsx). The same turns
 * and log as the web's console (apps/web/src/components/ai-team/test-console.tsx): each message, or turn of a call,
 * and how the teammate handled it, built one worker event at a time.
 */

/** A written message and its reply, a turn of a call, or the call's greeting (no words of theirs). */
export type TurnKind = 'written' | 'call' | 'greeting';

export type LogTone = 'ok' | 'run' | 'ai' | 'held' | 'wait' | 'bad';
export type LogIcon =
  | 'message'
  | 'call-in'
  | 'call-out'
  | 'phone'
  | 'who'
  | 'note'
  | 'knowledge'
  | 'tool'
  | 'would'
  | 'check'
  | 'hand'
  | 'hung-up'
  | 'draft'
  | 'send'
  | 'wait'
  | 'error';

/** One line of "What Ava did". */
export interface LogLine {
  readonly id: string;
  /** ISO 8601. */
  readonly at: string;
  readonly tone: LogTone;
  readonly icon: LogIcon;
  readonly title: string;
  readonly detail: string | null;
  /** Their words, quoted. */
  readonly quote?: string | null;
  /** The knowledge it found. */
  readonly knowledge?: readonly string[];
}

export interface Turn {
  readonly id: string;
  readonly kind: TurnKind;
  /** What they wrote or said; empty for a call's greeting. */
  readonly customer: string;
  /** The reply as it streams in. */
  readonly reply: string;
  readonly done: boolean;
  readonly outcome: TestOutcome | null;
  /** Training wheels would hold it for an OK. */
  readonly draft: boolean;
  /** A call's end: it said goodbye, or connected them to the team. */
  readonly ended: boolean;
  /** "Would have: booked Thu 10 AM (simulated)". */
  readonly would: readonly string[];
  readonly log: readonly LogLine[];
  readonly toolSteps: number;
  readonly ms: number | null;
  /** A call's reply started being said this long in, while the rest was written. */
  readonly firstWordsMs: number | null;
  /** A call's stopwatch: where the time went before it could start talking. */
  readonly steps: TestSteps | null;
  /** On a call, the reply's sentences a real call says while the rest is written, as they come. */
  readonly early: readonly string[];
  readonly error: string | null;
}

let lines = 0;
const nextId = () => `line-${Date.now().toString(36)}-${(lines++).toString(36)}`;

function line(
  at: string,
  tone: LogTone,
  icon: LogIcon,
  title: string,
  extra: Partial<Omit<LogLine, 'id' | 'at' | 'tone' | 'icon' | 'title'>> = {},
): LogLine {
  return { id: nextId(), at, tone, icon, title, detail: null, ...extra };
}

/** A new turn, before the worker answers: its first line says who did what. */
export function newTurn(o: {
  readonly id: string;
  readonly kind: TurnKind;
  readonly message: string;
  readonly channel: TestConsoleChannel;
  /** Their first name, when they're someone in Contacts. */
  readonly who: string | null;
  readonly name: string;
  readonly outbound: boolean;
  readonly now?: string;
}): Turn {
  const at = o.now ?? new Date().toISOString();
  const first =
    o.kind === 'greeting'
      ? o.outbound
        ? line(at, 'ok', 'call-out', `${o.name} called ${o.who ?? 'them'}`)
        : line(at, 'ok', 'call-in', `${o.who ?? 'Someone'} called`)
      : line(
          at,
          'ok',
          o.channel === 'phone' ? 'phone' : 'message',
          `${o.who ?? 'They'} ${testVerb(o.channel)}`,
          { quote: o.message },
        );
  return {
    id: o.id,
    kind: o.kind,
    customer: o.message,
    reply: '',
    done: false,
    outcome: null,
    draft: false,
    ended: false,
    would: [],
    log: [first],
    toolSteps: 0,
    ms: null,
    firstWordsMs: null,
    steps: null,
    early: [],
    error: null,
  };
}

/** How a turn ended, as its last line. */
function endLine(t: Turn, e: Extract<TestEvent, { type: 'done' }>, at: string): LogLine {
  if (t.kind === 'greeting')
    return line(at, 'ok', 'phone', 'Said its greeting', {
      detail: 'On a real call it says this out loud, then listens.',
    });
  if (e.outcome === 'handed_off')
    return t.kind === 'call'
      ? line(at, 'held', 'hand', 'Connected them to the team', {
          detail:
            'On a real call your team’s phones ring on the same call, and the conversation goes to Needs a person, with a note.',
        })
      : line(at, 'held', 'hand', 'Handed to a person', {
          detail: 'In a real conversation it goes to Needs a person, with a note.',
        });
  if (e.outcome === 'no_reply') return line(at, 'wait', 'wait', 'Decided not to reply');
  if (t.kind === 'call')
    return e.ended
      ? line(at, 'ok', 'hung-up', 'Said goodbye and hung up')
      : line(at, 'ok', 'phone', 'Would say it now', {
          detail: 'On a real call it says this out loud, then listens.',
        });
  if (e.draft)
    return line(at, 'held', 'draft', 'Draft (training wheels)', {
      detail:
        'In a real conversation this waits in the inbox and on Approvals, with any booking held until someone approves it.',
    });
  return line(at, 'ok', 'send', 'Would send it now', {
    detail: 'It works on its own, so a real reply goes out straight away.',
  });
}

/** A turn after one more event from the worker. */
export function stepTurn(t: Turn, e: TestEvent, now = new Date().toISOString()): Turn {
  switch (e.type) {
    case 'started':
      return t;
    case 'delta':
      return { ...t, reply: t.reply + e.text };
    // The words it's saying show as they're said; the reply replaces them once it's done.
    case 'say': {
      const early = [...t.early, e.text];
      return { ...t, early, reply: early.join(' ') };
    }
    case 'context':
      return { ...t, log: [...t.log, line(e.at, 'run', 'who', e.title, { detail: e.detail })] };
    case 'note':
      return { ...t, log: [...t.log, line(e.at, 'ai', 'note', e.title, { detail: e.detail })] };
    case 'knowledge':
      return {
        ...t,
        log: [
          ...t.log,
          line(
            e.at,
            'ai',
            'knowledge',
            e.query ? `Searched Knowledge for “${e.query}”` : 'Searched Knowledge',
            {
              knowledge: e.items.map((i) => i.title),
              detail: e.items.length ? null : 'Nothing matched.',
            },
          ),
        ],
      };
    case 'tool':
      return { ...t, log: [...t.log, line(e.at, 'run', 'tool', e.title, { detail: e.detail })] };
    case 'would':
      return {
        ...t,
        would: [...t.would, `Would have: ${e.summary} (simulated)`],
        log: [
          ...t.log,
          line(e.at, 'run', 'would', `Would have: ${e.summary}`, {
            detail: 'Simulated, so nothing changed.',
          }),
        ],
      };
    case 'check':
      return {
        ...t,
        log: [
          ...t.log,
          line(
            e.at,
            e.ok ? 'ok' : 'bad',
            'check',
            e.ok
              ? e.rewritten
                ? 'Safety check passed after one rewrite'
                : 'Safety check passed'
              : 'Safety check failed',
            {
              detail: e.problems.length
                ? e.problems.map((p) => p.message).join(' · ')
                : `${e.passed.length} ${e.passed.length === 1 ? 'check' : 'checks'} passed`,
            },
          ),
        ],
      };
    case 'done':
      return {
        ...t,
        done: true,
        outcome: e.outcome,
        draft: e.draft,
        ended: e.ended,
        reply: e.reply ?? t.reply,
        toolSteps: e.toolSteps,
        ms: e.ms,
        firstWordsMs: e.firstWordsMs,
        steps: e.steps,
        log: [...t.log, endLine(t, e, now)],
      };
    case 'error':
      return {
        ...t,
        done: true,
        error: e.message,
        log: [...t.log, line(now, 'bad', 'error', 'The test stopped', { detail: e.message })],
      };
  }
}

/** The test so far, as the worker takes it: their words and its replies, oldest first. */
export function historyOf(turns: readonly Turn[]): TestMessage[] {
  return turns.flatMap((t) => [
    ...(t.customer ? [{ from: 'customer' as const, text: t.customer }] : []),
    ...(t.reply.trim() ? [{ from: 'teammate' as const, text: t.reply }] : []),
  ]);
}

const ORDINALS = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth'];

/** "First reply", or on a call "Ava picks up" / "Ava calls" for the greeting. */
export function turnHeading(
  turns: readonly Turn[],
  i: number,
  name: string,
  outbound: boolean,
): string {
  const t = turns[i]!;
  if (t.kind === 'greeting') return outbound ? `${name} calls` : `${name} picks up`;
  const n = turns.slice(0, i).filter((x) => x.kind !== 'greeting').length;
  return ORDINALS[n] ? `${ORDINALS[n]} reply` : `Reply ${n + 1}`;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/**
 * "2 look-ups · 1.4 s", "1 look-up · talks at 0.8 s · done at 2.4 s" for a call that started talking early, or
 * "Working on it…" while it runs.
 */
export function turnMeta(t: Turn): string {
  if (!t.done) return 'Working on it…';
  return [
    `${t.toolSteps} ${t.toolSteps === 1 ? 'look-up' : 'look-ups'}`,
    t.firstWordsMs !== null ? `talks at ${seconds(t.firstWordsMs)}` : null,
    t.ms !== null ? (t.firstWordsMs !== null ? `done at ${seconds(t.ms)}` : seconds(t.ms)) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** A call's stopwatch in words ("Where the time went: loading 0.1 s · …"), or null when there's none. */
export function turnSteps(t: Turn): string | null {
  return t.steps ? `Where the time went: ${stepsLine(t.steps, seconds)}` : null;
}

/** The first word of a name. */
export const firstName = (name: string): string => name.trim().split(/\s+/)[0] || name;
