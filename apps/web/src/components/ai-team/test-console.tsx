'use client';
import {
  AI_CALL_PURPOSES,
  PHONE_VOICES,
  TEST_CALL_GOAL_MAX,
  TEST_CALL_REASONS,
  TEST_CHANNEL_NAMES,
  restToSay,
  stepsLine,
  testSamples,
  testVerb,
  type AiCallPurpose,
  type TestCall,
  type TestCallDirection,
  type TestConsoleChannel,
  type TestSteps,
} from '@hfos/core';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  AlertCircle,
  BookOpen,
  CalendarCheck,
  Hand,
  Hourglass,
  Info,
  MessageSquare,
  Mic,
  Phone,
  PhoneCall,
  PhoneIncoming,
  PhoneOff,
  PhoneOutgoing,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
  UserRound,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';
import { CustomerPicker, type PickedCustomer } from '@/components/calendar/customer-picker';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { VoiceBar, VoiceError } from '@/components/voice/voice-bar';
import { checkViews, firstName, plural, toolName } from '@/lib/ai-team/describe';
import {
  streamTest,
  testConsoleMissing,
  type TestEvent,
  type TestMessage,
} from '@/lib/ai-team/test-stream';
import type { RunOutcome } from '@/lib/ai-team/types';
import { errorMessage } from '@/lib/api/client';
import { toLocalInputValue } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useVoice } from '@/lib/voice/use-voice';
import { clockSeconds } from '@/lib/workflows/run-words';
import { LogRow, type LogLine, type LogTone } from './log';
import { AiTile, TeammateMark } from './mark';

/** A written message and its reply, a turn of a call, or the call's greeting (no words of theirs). */
type TurnKind = 'written' | 'call' | 'greeting';

/** One message from the manager and how the teammate handled it. */
interface Turn {
  readonly id: string;
  readonly kind: TurnKind;
  /** What they wrote or said; empty for a call's greeting. */
  readonly customer: string;
  /** The reply as it streams in. */
  readonly reply: string;
  readonly done: boolean;
  readonly outcome: RunOutcome | null;
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

const TOOL_ICONS: Readonly<Record<string, LucideIcon>> = {
  search_knowledge: BookOpen,
  find_times: CalendarCheck,
  my_appointments: CalendarCheck,
  read_call_transcript: PhoneCall,
};
const ORDINALS = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth'];

/** Seconds, as the console shows them: "1.4 s". */
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function lineAt(
  at: string,
  timeZone: string,
  tone: LogTone,
  icon: LucideIcon,
  title: string,
  extra: Partial<LogLine> = {},
): LogLine {
  return { id: crypto.randomUUID(), time: clockSeconds(at, timeZone), tone, icon, title, ...extra };
}

/** How a turn ended, as its last line. */
function endLine(t: Turn, e: Extract<TestEvent, { type: 'done' }>, timeZone: string): LogLine {
  const now = new Date().toISOString();
  if (t.kind === 'greeting')
    return lineAt(now, timeZone, 'ok', Phone, 'Said its greeting', {
      detail: 'On a real call it says this out loud, then listens.',
    });
  if (e.outcome === 'handed_off')
    return t.kind === 'call'
      ? lineAt(now, timeZone, 'held', Hand, 'Connected them to the team', {
          detail:
            'On a real call your team’s phones ring on the same call, and the conversation goes to Needs a person, with a note.',
        })
      : lineAt(now, timeZone, 'held', Hand, 'Handed to a person', {
          detail: 'In a real conversation it goes to Needs a person, with a note.',
        });
  if (e.outcome === 'no_reply') return lineAt(now, timeZone, 'wait', Info, 'Decided not to reply');
  if (t.kind === 'call')
    return e.ended
      ? lineAt(now, timeZone, 'ok', PhoneOff, 'Said goodbye and hung up')
      : lineAt(now, timeZone, 'ok', Phone, 'Would say it now', {
          detail: 'On a real call it says this out loud, then listens.',
        });
  if (e.draft)
    return lineAt(now, timeZone, 'held', Hourglass, 'Draft (training wheels)', {
      detail:
        'In a real conversation this waits in the inbox and on Approvals, with any booking held until someone approves it.',
    });
  return lineAt(now, timeZone, 'ok', Send, 'Would send it now', {
    detail: 'It works on its own, so a real reply goes out straight away.',
  });
}

/** A turn after one more event from the worker. */
function step(t: Turn, e: TestEvent, timeZone: string): Turn {
  const now = new Date().toISOString();
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
      return {
        ...t,
        log: [...t.log, lineAt(e.at, timeZone, 'run', UserRound, e.title, { detail: e.detail })],
      };
    case 'note':
      return {
        ...t,
        log: [...t.log, lineAt(e.at, timeZone, 'ai', Sparkles, e.title, { detail: e.detail })],
      };
    case 'knowledge':
      return {
        ...t,
        log: [
          ...t.log,
          lineAt(
            e.at,
            timeZone,
            'ai',
            BookOpen,
            e.query ? `Searched Knowledge for “${e.query}”` : 'Searched Knowledge',
            {
              knowledge: e.items.map((i) => ({ id: i.id || null, title: i.title })),
              detail: e.items.length ? null : 'Nothing matched.',
            },
          ),
        ],
      };
    case 'tool':
      return {
        ...t,
        log: [
          ...t.log,
          lineAt(e.at, timeZone, 'run', TOOL_ICONS[e.name] ?? Wrench, e.title || toolName(e.name), {
            detail: e.detail,
          }),
        ],
      };
    case 'would':
      return {
        ...t,
        would: [...t.would, `Would have: ${e.summary} (simulated)`],
        log: [
          ...t.log,
          lineAt(e.at, timeZone, 'run', CalendarCheck, `Would have: ${e.summary}`, {
            detail: 'Simulated, so nothing changed.',
          }),
        ],
      };
    case 'check':
      return {
        ...t,
        log: [
          ...t.log,
          lineAt(
            e.at,
            timeZone,
            e.ok ? 'ok' : 'bad',
            ShieldCheck,
            e.ok
              ? e.rewritten
                ? 'Safety check passed after one rewrite'
                : 'Safety check passed'
              : 'Safety check failed',
            { checks: checkViews(e.passed, e.problems) },
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
        log: [...t.log, endLine(t, e, timeZone)],
      };
    case 'error':
      return {
        ...t,
        done: true,
        error: e.message,
        log: [
          ...t.log,
          lineAt(now, timeZone, 'bad', AlertCircle, 'The test stopped', { detail: e.message }),
        ],
      };
  }
}

/** The phone voice in the builder's draft, so a test call sounds like the settings being tested. */
function draftVoice(config: unknown): (typeof PHONE_VOICES)[number] | null {
  const phone = (config as { phone?: { voice?: unknown } } | null)?.phone;
  return PHONE_VOICES.find((v) => v === phone?.voice) ?? null;
}

/**
 * The test console: a manager writes as a customer (someone in Customers, or an unknown visitor) by text,
 * chat or email, or plays a phone call (they call in, or the teammate calls them to confirm a visit, ring back
 * a missed call, follow up a quote or for a campaign), at now or a time they pick. They see the reply stream in,
 * then what the teammate looked up, the knowledge it used, the checks the reply passed, and anything it would
 * have done. Look-ups are real, changes are simulated, and nothing is sent. Full screen on phones; the phone
 * app has the same console (apps/mobile/src/app/app/w/[workspaceId]/ai-test.tsx).
 *
 * On a call, Talk out loud plays it for real: the manager says what the caller says, and hears each reply in
 * the teammate's phone voice (the draft's), then it listens again, until the call ends.
 */
export function TestConsole({
  open,
  onOpenChange,
  workspaceId,
  name,
  timeZone,
  config,
  unsaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  name: string;
  timeZone: string;
  /** The settings to test: the builder's draft. */
  config: unknown;
  /** The draft has changes that aren't saved yet. */
  unsaved: boolean;
}) {
  const [person, setPerson] = useState<PickedCustomer | null>(null);
  const [channel, setChannel] = useState<TestConsoleChannel>('sms');
  const [direction, setDirection] = useState<TestCallDirection>('inbound');
  const [purpose, setPurpose] = useState<AiCallPurpose>('confirm_visit');
  const [goal, setGoal] = useState('');
  const [at, setAt] = useState('');
  const [text, setText] = useState('');
  const [turns, setTurns] = useState<readonly Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);
  const [pane, setPane] = useState<'chat' | 'log'>('chat');
  const abort = useRef<AbortController | null>(null);
  const { session: voice, snap: voiceSnap } = useVoice(workspaceId, draftVoice(config));
  const talking = voiceSnap.phase !== 'off';
  /** The turns already read out (or not to be), so each reply is said once. */
  const said = useRef(new Set<string>());
  /** For the reply being written: how many of its early sentences have been said, and in which turn of the voice. */
  const saying = useRef<{ id: string; count: number; generation: number } | null>(null);
  const chatRef = useRef<HTMLDivElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const phone = channel === 'phone';
  const outbound = phone && direction === 'outbound';
  const call: TestCall | null = phone
    ? {
        direction,
        purpose: outbound ? purpose : null,
        goal: outbound && purpose === 'campaign' ? goal.trim() || null : null,
      }
    : null;
  const who = person
    ? firstName(person.fullName)
    : channel === 'chat'
      ? 'a visitor'
      : phone
        ? 'a caller'
        : 'a customer';
  const last = turns[turns.length - 1];
  /** The call has started: the greeting came back. */
  const onCall = phone && turns.some((t) => t.kind === 'greeting' && t.done && !t.error);
  const callOver = phone && !!last?.done && last.ended;
  /** Why the call can't start yet. */
  const cantCall = !outbound
    ? null
    : !person
      ? `Pick a customer for ${name} to call.`
      : purpose === 'campaign' && !goal.trim()
        ? 'Say what the campaign call is about.'
        : null;

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    for (const el of [chatRef.current, logRef.current]) if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);
  // Talking out loud is for calls.
  useEffect(() => {
    if (!phone) voice.stop();
  }, [phone, voice]);

  const update = (id: string, fn: (t: Turn) => Turn) =>
    setTurns((xs) => xs.map((x) => (x.id === id ? fn(x) : x)));

  function stop() {
    abort.current?.abort();
    abort.current = null;
    setBusy(false);
    voice.quiet();
  }

  function startOver() {
    stop();
    said.current.clear();
    setTurns([]);
  }

  /** Changing who, how or why starts the test over. */
  function change<T>(set: (v: T) => void): (v: T) => void {
    return (v) => {
      set(v);
      startOver();
    };
  }

  /** Sends a message (or, on a call, what they say); with no words on a call, starts it. */
  async function run(raw: string, restart = false) {
    const message = raw.trim();
    const kind: TurnKind = phone ? (message ? 'call' : 'greeting') : 'written';
    if ((kind !== 'greeting' && !message) || (busy && !restart)) return;
    if (restart) stop();
    // Typed while it listened or spoke: that turn is the one going now.
    if (voice.phase === 'listening' || voice.phase === 'speaking') voice.quiet();
    voice.thinking();
    const id = crypto.randomUUID();
    const before = restart ? [] : turns;
    const history: TestMessage[] = before.flatMap((t) => [
      ...(t.customer ? [{ from: 'customer' as const, text: t.customer }] : []),
      ...(t.reply.trim() ? [{ from: 'teammate' as const, text: t.reply }] : []),
    ]);
    const nowIso = new Date().toISOString();
    const opened =
      kind === 'greeting'
        ? outbound
          ? lineAt(nowIso, timeZone, 'ok', PhoneOutgoing, `${name} called ${who}`)
          : lineAt(nowIso, timeZone, 'ok', PhoneIncoming, `${person ? who : 'Someone'} called`)
        : lineAt(
            nowIso,
            timeZone,
            'ok',
            phone ? Phone : MessageSquare,
            `${person ? firstName(person.fullName) : 'They'} ${testVerb(channel)}`,
            { quote: message },
          );
    const turn: Turn = {
      id,
      kind,
      customer: message,
      reply: '',
      done: false,
      outcome: null,
      draft: false,
      ended: false,
      would: [],
      log: [opened],
      toolSteps: 0,
      ms: null,
      firstWordsMs: null,
      steps: null,
      early: [],
      error: null,
    };
    setTurns([...before, turn]);
    setText('');
    setBusy(true);
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      await streamTest(
        {
          workspaceId,
          personId: person?.id ?? null,
          channel,
          call,
          at: at ? new Date(at).toISOString() : null,
          config,
          messages: [
            ...history,
            ...(message ? [{ from: 'customer' as const, text: message }] : []),
          ].slice(-40),
        },
        (e) => update(id, (t) => step(t, e, timeZone)),
        ctrl.signal,
      );
      update(id, (t) => (t.done ? t : { ...t, done: true }));
    } catch (e) {
      if (testConsoleMissing(e)) {
        setMissing(true);
        setTurns((xs) => xs.filter((x) => x.id !== id));
        voice.stop();
      } else update(id, (t) => ({ ...t, done: true, error: errorMessage(e) }));
    } finally {
      if (abort.current === ctrl) {
        abort.current = null;
        setBusy(false);
      }
    }
  }

  const send = (raw: string) => void run(raw);
  const startCall = () => void run('', true);
  /** The latest `send`, for a turn heard after the screen has moved on. */
  const sendRef = useRef(send);
  sendRef.current = send;

  /** Hears what the caller says, and says it. */
  async function listenTurn() {
    const words = await voice.listen();
    if (words) sendRef.current(words);
  }

  async function toggleTalk() {
    if (talking) {
      voice.stop();
      return;
    }
    if (!(await voice.start())) return;
    // What's already on screen isn't read out: it starts with what comes next.
    for (const t of turns) if (t.done) said.current.add(t.id);
    if (onCall && !callOver && !busy) void listenTurn();
  }

  /** Talk: listen now, or start the call when there's none going. */
  function talkNow() {
    if (!onCall || callOver) {
      if (!cantCall) startCall();
      else voice.idle(cantCall);
      return;
    }
    if (!busy) void listenTurn();
  }

  // Out loud, a reply starts being said while it's written, a checked sentence at a time, as a real call says it;
  // talking over it stops it.
  useEffect(() => {
    if (!phone || !talking || !last || last.done || said.current.has(last.id)) return;
    const s = saying.current?.id === last.id ? saying.current : null;
    const count = s?.count ?? 0;
    if (last.early.length <= count) return;
    if (s && voice.generation !== s.generation) {
      said.current.add(last.id);
      return;
    }
    voice.hold(true);
    for (const sentence of last.early.slice(count)) voice.speak(sentence);
    saying.current = { id: last.id, count: last.early.length, generation: voice.generation };
  }, [phone, talking, last, voice]);

  // Then the rest of it once it's done (all of it when nothing was said early), and it listens for the answer,
  // until the call ends.
  useEffect(() => {
    if (!phone || !talking || !last?.done || said.current.has(last.id)) return;
    said.current.add(last.id);
    voice.hold(false);
    if (last.error) {
      voice.idle(last.error);
      return;
    }
    const s = saying.current?.id === last.id ? saying.current : null;
    // They talked over the start of it: the rest isn't said either.
    if (s && voice.generation !== s.generation) return;
    const cut = voice.generation;
    const reply = restToSay(s ? last.early.slice(0, s.count) : [], last.reply);
    const ended = last.ended;
    void (async () => {
      if (reply) voice.speak(reply);
      await voice.finishSpeaking();
      if (!voice.on || voice.generation !== cut) return;
      if (ended) voice.idle();
      else await listenTurn();
    })();
    // listenTurn reads the latest send through its ref.
  }, [phone, talking, last, voice]);

  const meta = (t: Turn) =>
    t.done
      ? [
          plural(t.toolSteps, 'look-up', 'look-ups'),
          t.firstWordsMs !== null ? `talks at ${seconds(t.firstWordsMs)}` : null,
          t.ms !== null
            ? t.firstWordsMs !== null
              ? `done at ${seconds(t.ms)}`
              : seconds(t.ms)
            : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : 'Working on it…';
  const heading = (t: Turn, i: number) => {
    if (t.kind === 'greeting') return outbound ? `${name} calls` : `${name} picks up`;
    const n = turns.slice(0, i).filter((x) => x.kind !== 'greeting').length;
    return ORDINALS[n] ? `${ORDINALS[n]} reply` : `Reply ${n + 1}`;
  };
  const samples = testSamples(channel, call);
  const canWrite = !phone || (onCall && !callOver);

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          stop();
          voice.stop();
        }
        onOpenChange(o);
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 hidden bg-[var(--scrim)] lg:block" />
        <DialogPrimitive.Content
          data-testid="test-console"
          className="fixed inset-0 z-50 flex flex-col bg-card focus:outline-none lg:left-auto lg:w-[960px] lg:max-w-[calc(100vw-48px)] lg:border-l lg:border-border lg:shadow-3"
        >
          <div className="flex flex-none items-start gap-3 border-b border-border px-4 pb-3.5 pt-4 lg:px-[22px] lg:pt-5">
            <AiTile />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <DialogPrimitive.Title className="text-lg font-semibold tracking-tight">
                Test console
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="text-[13px] text-text-2">
                Chat with {name} as a customer, or play a phone call. Look-ups are real. Bookings
                and changes are pretend, and nothing is sent.
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close
              aria-label="Close"
              className="flex h-11 w-11 flex-none items-center justify-center rounded-control text-text-2 hover:bg-card-2 hover:text-text focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring lg:h-8 lg:w-8"
            >
              <X className="h-[18px] w-[18px]" />
            </DialogPrimitive.Close>
          </div>

          <div className="flex flex-none flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3 lg:px-[22px]">
            <div className="flex items-center gap-2">
              <label htmlFor="test-as" className="text-[13px] font-semibold">
                Test as
              </label>
              <div className="w-[230px]">
                <CustomerPicker
                  id="test-as"
                  workspaceId={workspaceId}
                  value={person}
                  onChange={change(setPerson)}
                />
              </div>
            </div>
            <div className="flex max-w-full items-center gap-2 overflow-x-auto">
              <span className="text-[13px] font-semibold">By</span>
              <Segmented
                value={channel}
                ariaLabel="Channel"
                onChange={change(setChannel)}
                options={(['sms', 'chat', 'email', 'phone'] as const).map((c) => ({
                  value: c,
                  label: TEST_CHANNEL_NAMES[c],
                  testId: `test-channel-${c}`,
                }))}
              />
            </div>
            <div className="flex items-center gap-2">
              <label htmlFor="test-at" className="text-[13px] font-semibold">
                At
              </label>
              <Select
                id="test-at"
                selectSize="sm"
                className="w-[130px]"
                value={at ? 'pick' : 'now'}
                onChange={(e) =>
                  setAt(e.target.value === 'now' ? '' : toLocalInputValue(new Date()))
                }
              >
                <option value="now">Now</option>
                <option value="pick">Pick a time</option>
              </Select>
              {at ? (
                <Input
                  type="datetime-local"
                  inputSize="sm"
                  className="w-[200px]"
                  aria-label="Pretend it’s this time"
                  value={at}
                  onChange={(e) => setAt(e.target.value)}
                />
              ) : null}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              disabled={!turns.length && !busy}
              onClick={startOver}
            >
              <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} />
              Start over
            </Button>
            {phone ? (
              <div
                className="flex w-full flex-wrap items-center gap-x-3 gap-y-2"
                data-testid="test-call-options"
              >
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-semibold">Call</span>
                  <Segmented
                    value={direction}
                    ariaLabel="Which way the call goes"
                    onChange={change(setDirection)}
                    options={[
                      {
                        value: 'inbound',
                        label: 'Incoming',
                        icon: <PhoneIncoming className="h-3.5 w-3.5" strokeWidth={1.75} />,
                        testId: 'test-call-inbound',
                      },
                      {
                        value: 'outbound',
                        label: 'Outgoing',
                        icon: <PhoneOutgoing className="h-3.5 w-3.5" strokeWidth={1.75} />,
                        testId: 'test-call-outbound',
                      },
                    ]}
                  />
                </div>
                {outbound ? (
                  <div className="flex items-center gap-2">
                    <label htmlFor="test-call-why" className="text-[13px] font-semibold">
                      Why
                    </label>
                    <Select
                      id="test-call-why"
                      selectSize="sm"
                      className="w-[200px]"
                      value={purpose}
                      onChange={(e) => change(setPurpose)(e.target.value as AiCallPurpose)}
                    >
                      {AI_CALL_PURPOSES.map((p) => (
                        <option key={p} value={p}>
                          {TEST_CALL_REASONS[p]}
                        </option>
                      ))}
                    </Select>
                  </div>
                ) : null}
                {outbound && purpose === 'campaign' ? (
                  <Input
                    inputSize="sm"
                    className="w-full max-w-[320px]"
                    aria-label="What the campaign call is about"
                    placeholder="What the calls are about, like our spring tune-up special"
                    maxLength={TEST_CALL_GOAL_MAX}
                    value={goal}
                    onChange={(e) => change(setGoal)(e.target.value)}
                    data-testid="test-call-goal"
                  />
                ) : null}
                <Button
                  size="sm"
                  variant={talking ? 'primary' : 'secondary'}
                  aria-pressed={talking}
                  title={`Say what the caller says, and hear ${name} answer in its phone voice`}
                  onClick={() => void toggleTalk()}
                  data-testid="test-console-talk"
                >
                  <Mic className="h-3.5 w-3.5" strokeWidth={1.75} />
                  {talking ? 'Talking out loud' : 'Talk out loud'}
                </Button>
                <VoiceError snap={voiceSnap} className="w-full" />
              </div>
            ) : null}
          </div>

          {missing ? (
            <div
              className="flex min-h-0 flex-1 items-center justify-center p-6"
              data-testid="test-console-missing"
            >
              <EmptyState
                dashed
                className="max-w-md"
                title="The test console arrives with the teammate’s runtime."
              >
                Set {name} up now. Once its runtime is in, you can chat with it here before any
                customer does.
              </EmptyState>
            </div>
          ) : (
            <>
              <div className="flex-none px-4 pt-3 lg:hidden">
                <Segmented
                  fill
                  size="lg"
                  value={pane}
                  ariaLabel="Show"
                  onChange={setPane}
                  options={[
                    { value: 'chat', label: phone ? 'Call' : 'Chat' },
                    { value: 'log', label: `What ${name} did` },
                  ]}
                />
              </div>
              <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[410px_minmax(0,1fr)]">
                <div
                  className={cn(
                    'min-h-0 flex-col bg-card-2 lg:flex lg:border-r lg:border-border',
                    pane === 'chat' ? 'flex' : 'hidden',
                  )}
                >
                  <div
                    ref={chatRef}
                    className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-3 pt-4"
                    aria-live="polite"
                    data-testid="test-console-chat"
                  >
                    <div className="self-center text-xs font-medium text-text-3">
                      {phone
                        ? `Test call · ${outbound ? `outgoing, ${TEST_CALL_REASONS[purpose].toLowerCase()}` : 'incoming'}`
                        : `Test chat · by ${TEST_CHANNEL_NAMES[channel].toLowerCase()}`}
                    </div>
                    {!phone && !turns.length ? (
                      <p className="mt-4 text-center text-[13px] text-text-2">
                        Write as {who} to see how {name} answers.
                      </p>
                    ) : null}
                    {turns.map((t) => (
                      <Fragment key={t.id}>
                        {t.customer ? (
                          <div className="flex max-w-[86%] flex-col items-end gap-[3px] self-end">
                            <div className="whitespace-pre-wrap rounded-2xl bg-accent px-[13px] py-[9px] text-sm leading-[1.45] text-white [overflow-wrap:anywhere]">
                              {t.customer}
                            </div>
                            <span className="text-xs text-text-3">You, as {who}</span>
                          </div>
                        ) : null}
                        {t.error && !t.reply ? null : (
                          <div className="flex max-w-[90%] flex-col gap-[5px] self-start">
                            <span className="flex items-center gap-[5px] text-xs text-text-3">
                              <TeammateMark size="xs" />
                              <strong className="font-semibold text-text-2">{name} (AI)</strong>
                              {t.kind !== 'written' ? <span>says</span> : null}
                            </span>
                            <div
                              className="whitespace-pre-wrap rounded-2xl border border-border bg-card px-[13px] py-[9px] text-sm leading-[1.45] [overflow-wrap:anywhere]"
                              data-testid="test-console-reply"
                            >
                              {t.reply || (
                                <span className="text-text-3">
                                  {t.done
                                    ? 'No reply.'
                                    : t.kind === 'greeting'
                                      ? 'Ringing…'
                                      : 'Writing…'}
                                </span>
                              )}
                            </div>
                            {t.done ? (
                              <span className="flex flex-wrap gap-1.5">
                                {t.draft ? (
                                  <Tag
                                    className="bg-warning-soft text-warning-text"
                                    icon={Hourglass}
                                  >
                                    Draft (training wheels)
                                  </Tag>
                                ) : null}
                                {t.outcome === 'handed_off' ? (
                                  <Tag className="bg-warning-soft text-warning-text" icon={Hand}>
                                    {t.kind === 'call'
                                      ? 'Connected to the team'
                                      : 'Handed to a person'}
                                  </Tag>
                                ) : t.ended ? (
                                  <Tag className="bg-card text-text-2" icon={PhoneOff}>
                                    Hung up
                                  </Tag>
                                ) : null}
                                {t.would.map((w, i) => (
                                  <Tag key={i} className="bg-card text-text-2" icon={CalendarCheck}>
                                    {w}
                                  </Tag>
                                ))}
                              </span>
                            ) : null}
                          </div>
                        )}
                        {t.error ? (
                          <p role="alert" className="text-xs text-danger-text">
                            {t.error}
                          </p>
                        ) : null}
                      </Fragment>
                    ))}
                    {phone && !onCall && !busy ? (
                      <div className="mt-4 flex flex-col items-center gap-3 text-center">
                        <p className="text-[13px] text-text-2">
                          {cantCall ??
                            (outbound
                              ? `${name} calls ${who} to ${TEST_CALL_REASONS[purpose].toLowerCase()}. You answer as them.`
                              : `Call in as ${who} to hear how ${name} picks up.`)}
                        </p>
                        <Button
                          size="sm"
                          disabled={!!cantCall}
                          onClick={startCall}
                          data-testid="test-console-start-call"
                        >
                          <PhoneCall className="h-3.5 w-3.5" strokeWidth={1.75} />
                          Start the call
                        </Button>
                      </div>
                    ) : null}
                    {callOver ? (
                      <div
                        className="flex flex-col items-center gap-2 pt-1 text-center"
                        data-testid="test-console-call-over"
                      >
                        <span className="text-xs font-medium text-text-3">The call ended.</span>
                        <Button variant="secondary" size="sm" onClick={startCall}>
                          <PhoneCall className="h-3.5 w-3.5" strokeWidth={1.75} />
                          Call again
                        </Button>
                      </div>
                    ) : null}
                  </div>
                  {phone ? <VoiceBar session={voice} snap={voiceSnap} onTalk={talkNow} /> : null}
                  {canWrite ? (
                    <div className="flex-none border-t border-border bg-card px-3.5 pb-3.5 pt-2.5">
                      <div className="mb-2 flex flex-wrap items-center gap-1.5">
                        <span className="text-xs text-text-3">Try:</span>
                        {samples.map((s) => (
                          <button
                            key={s}
                            type="button"
                            disabled={busy}
                            onClick={() => send(s)}
                            className="inline-flex h-7 items-center rounded-full border border-border-strong bg-card px-3 text-[12.5px] font-medium text-text-2 hover:bg-card-2 hover:text-text focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring disabled:opacity-50"
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          send(text);
                        }}
                        className="rounded-xl border border-border-strong bg-card transition-[border-color,box-shadow] focus-within:border-accent focus-within:ring-[3px] focus-within:ring-ring"
                      >
                        <textarea
                          value={text}
                          rows={2}
                          placeholder={phone ? `Say as ${who}…` : `Write as ${who}…`}
                          aria-label={phone ? `Say as ${who}` : `Write as ${who}`}
                          data-testid="test-console-input"
                          onChange={(e) => setText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              send(text);
                            }
                          }}
                          className="block w-full resize-none bg-transparent px-3 pb-0.5 pt-2.5 text-base leading-[1.45] text-text outline-none placeholder:text-placeholder lg:text-[14.5px]"
                        />
                        <div className="flex items-center justify-end px-1.5 pb-1.5">
                          <Button
                            type="submit"
                            size="sm"
                            loading={busy}
                            disabled={!text.trim()}
                            data-testid="test-console-send"
                          >
                            <Send className="h-3.5 w-3.5" strokeWidth={1.75} />
                            {phone ? 'Say it' : 'Send'}
                          </Button>
                        </div>
                      </form>
                    </div>
                  ) : null}
                </div>
                <div
                  ref={logRef}
                  className={cn(
                    'min-h-0 flex-col overflow-y-auto px-4 py-3.5 lg:flex lg:px-5',
                    pane === 'log' ? 'flex' : 'hidden',
                  )}
                  data-testid="test-console-log"
                >
                  <h3 className="text-[15px] font-semibold">What {name} did</h3>
                  {!turns.length ? (
                    <p className="mt-1 text-[13px] text-text-2">
                      Each reply shows what it looked up, the knowledge it used, the checks it
                      passed, and anything it would have done.
                    </p>
                  ) : (
                    turns.map((t, i) => (
                      <section
                        key={t.id}
                        className={cn('mt-2', i > 0 && 'border-t border-border pt-3')}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[13px] font-semibold">{heading(t, i)}</span>
                          <span className="text-xs text-text-3">{meta(t)}</span>
                        </div>
                        {t.steps ? (
                          <p
                            className="mt-0.5 text-xs text-text-3"
                            data-testid="test-console-steps"
                          >
                            Where the time went: {stepsLine(t.steps, seconds)}
                          </p>
                        ) : null}
                        {t.log.map((l, j) => (
                          <LogRow key={l.id} line={l} first={j === 0} />
                        ))}
                      </section>
                    ))
                  )}
                </div>
              </div>
            </>
          )}

          <p className="flex flex-none items-start gap-2 border-t border-border px-4 py-2.5 text-xs text-text-3 lg:px-[22px]">
            <Info className="mt-px h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
            <span>
              Tests don’t count toward training wheels and never reach a customer.
              {unsaved ? ' It tests your unsaved changes too.' : ''}{' '}
              {phone
                ? `On a test call nothing rings: type what they say, or turn on Talk out loud to say it and hear ${name} answer.`
                : 'Pick “Website chat” to test as an unknown visitor.'}
            </span>
          </p>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function Tag({
  children,
  icon: Icon,
  className,
}: {
  children: string;
  icon: LucideIcon;
  className: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-[6px] px-1.5 text-[11.5px] font-medium',
        className,
      )}
    >
      <Icon className="h-3 w-3" strokeWidth={1.75} />
      {children}
    </span>
  );
}
