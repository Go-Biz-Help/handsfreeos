/**
 * A live test call from the test console (@hfos/core's ai-team/test-call.ts has the contract): the AI teammate
 * answers a call in real time, on the settings being tested, through the same live call loop a real call runs
 * (voice-agent/session.ts). What it thinks is the console's (console.ts runTest, one run a turn), so look-ups are
 * real, changes are pretend, nothing is sent and nobody rings. Every turn's events go to the console as a written
 * test's do, with what the listener hears and where each turn's time went, to the first sound of the answer.
 *
 * - `browser`: the console's websocket carries the call's audio too, as a phone line does (8 kHz μ-law).
 * - `phone`: the console gets a ticket and places a call from the browser over the business's own line; the
 *   TwiML (http/voice.ts) streams that call to `/webhooks/twilio/voice/agent/test/<machine>`, and the call is
 *   heard and spoken there. The console's websocket stays for the events. The stream has to reach the machine
 *   holding the console's end, so the route sends it on there (Fly's replay) when another machine picks it up.
 *
 * Refusals come back as `error` before anything is heard: not signed in, no ai_team.manage, settings that can't
 * be read, no teammate, the AI limit or the balance, one test call at a time per person, and a few a minute.
 */
import { randomUUID } from 'node:crypto';
import {
  HfosError,
  restToSay,
  TEST_MESSAGES_MAX,
  TestCallClientMessage,
  TestConsoleInput,
  walletRoom,
  WALLET_REFUSALS,
  type HumanActor,
  type TestCallServerMessage,
  type TestCallTiming,
  type TestCallWay,
  type TestEvent,
} from '@hfos/core/server';
import { and, eq } from 'drizzle-orm';
import { asWorker } from '@hfos/db/client';
import { phoneNumbers, telephonyAccounts } from '@hfos/db/schema';
import type WebSocket from 'ws';
import { KeyedLimiter } from '../chat/limiter';
import { hasPermission, parseBody, requirePermission, type HttpDeps } from '../http/common';
import { noteSpeech, speechKchars, speechMinutes } from '../money/speech-usage';
import type { TurnOutcome } from '../voice-agent/brain';
import { CONNECTING, tongue, type CallLine } from '../voice-agent/prompt';
import {
  CallSession,
  type CallLink,
  type CallMind,
  type MindReady,
  type SessionDeps,
} from '../voice-agent/session';
import { sealTestTicket, TEST_DIAL_TTL_MS } from '../voice-agent/ticket';
import type { TurnClock } from '../voice-agent/turn-clock';
import { nextTestTurn, prepareTest, runTest, type ConsoleDeps, type PreparedTest } from './console';

/** The worker machine this runs on, as Fly names it (`local` off Fly). */
export const thisMachine = (): string => process.env['FLY_MACHINE_ID']?.trim() || 'local';

/** A console that hasn't said what to test by now is closed. */
const START_WITHIN_MS = 10_000;
/** Test calls one person may start, per machine. */
const STARTS = { max: 12, timeWindow: 10 * 60_000 };

const NOT_SET_UP = 'Talking out loud isn’t set up yet, so a live test call can’t start.';
const STOPPED = 'The test call stopped. Try again.';
const NO_ANSWER = 'The call didn’t come through. Try again, or use This browser.';

const messageOf = (e: unknown): string => (e instanceof HfosError ? e.message : STOPPED);

/** The call's words so far, and what the caller just said, as the console's messages. */
export function testMessagesOf(
  lines: readonly CallLine[],
  said: string,
): TestConsoleInput['messages'] {
  const messages: TestConsoleInput['messages'] = lines
    .filter((l) => l.text.trim())
    .map((l) => ({
      from: l.who === 'caller' ? ('customer' as const) : ('teammate' as const),
      text: l.text.trim().slice(0, 2000),
    }));
  messages.push({ from: 'customer', text: said.trim().slice(0, 2000) || '(inaudible)' });
  return messages.slice(-TEST_MESSAGES_MAX);
}

function timingOf(log: ReturnType<TurnClock['log']>): TestCallTiming {
  const ms = (v: unknown): number | null => (typeof v === 'number' && v >= 0 ? v : null);
  return {
    firstSoundMs: ms(log['firstSoundMs']),
    loadMs: ms(log['loadMs']),
    waitMs: ms(log['waitMs']),
    sentenceMs: ms(log['sentenceMs']),
    voiceMs: ms(log['voiceMs']),
    thought: log['thought'] === true,
  };
}

export interface TestCallMind extends CallMind {
  /** Why it couldn't start, for the console. */
  readonly problem: string | null;
}

/**
 * A test call's mind: each turn is the console's (runTest), in the call's own words, with a run of its own. The
 * console hears every event; hanging up and handing on only end the call, since nobody is rung in a test.
 */
export function testCallMind(o: {
  readonly deps: ConsoleDeps;
  /** Checked at the start (prepareTest with run: false). */
  readonly test: PreparedTest;
  readonly testCallId: string;
  readonly send: (m: TestCallServerMessage) => void;
  /** It's over (after `ended`, or `error` when it couldn't start). */
  readonly onEnd: () => void;
}): TestCallMind {
  const { deps, test } = o;
  const stop = new AbortController();
  let problem: string | null = null;
  /** What the listener has settled on this turn so far: it's shown with the words still coming. */
  let finals: string[] = [];
  const event = (turn: number, e: TestEvent) => o.send({ type: 'event', turn, event: e });

  return {
    get problem() {
      return problem;
    },

    async prepare() {
      o.send({ type: 'turn', turn: 0, said: '' });
      const t = await nextTestTurn(deps, test, []);
      return new Promise<MindReady | { readonly ok: false; readonly why: string }>((resolve) => {
        let settled = false;
        const settle = (r: MindReady | { readonly ok: false; readonly why: string }) => {
          if (settled) return;
          settled = true;
          if (!r.ok) {
            problem ??= STOPPED;
            o.send({ type: 'error', message: problem });
            o.onEnd();
          }
          resolve(r);
        };
        const ready = (greeting: string): MindReady => ({
          ok: true,
          greeting,
          voice: test.config.phone.voice,
          placed: !!test.phone?.outbound,
        });
        // The greeting is known as soon as the call is read, and said then; the rest of the pickup (the FAQ and
        // open times, the AI reading ahead) carries on while it plays, as on a real call.
        runTest(
          deps,
          t,
          (e) => {
            event(0, e);
            if (e.type === 'delta' && e.text.trim()) settle(ready(e.text.trim()));
            else if (e.type === 'done')
              settle(e.reply ? ready(e.reply) : { ok: false, why: 'no greeting' });
          },
          stop.signal,
        ).then(
          () => settle({ ok: false, why: 'no greeting' }),
          (e: unknown) => {
            problem = messageOf(e);
            if (!(e instanceof HfosError))
              deps.log.error({ err: e }, 'a live test call’s pickup failed');
            event(0, { type: 'error', message: problem });
            settle({ ok: false, why: 'error' });
          },
        );
      });
    },

    // The pickup's own run read ahead (runTest, as the console's greeting does).
    warm: async () => undefined,

    async think({ turn, lines, said, language, speak, clock }) {
      finals = [];
      o.send({ type: 'turn', turn, said });
      const t = await nextTestTurn(deps, test, testMessagesOf(lines, said));
      const early: string[] = [];
      let done: Extract<TestEvent, { type: 'done' }> | null = null;
      let handedOn: string | null = null;
      try {
        await runTest(
          deps,
          t,
          (e) => {
            if (e.type === 'say') {
              early.push(e.text);
              speak(e.text, e.ending === true);
            } else if (e.type === 'done') done = e;
            else if (e.type === 'would' && e.kind === 'hand_off') handedOn = e.summary;
            event(turn, e);
          },
          stop.signal,
          { clock },
        );
      } catch (e) {
        if (!(e instanceof HfosError)) deps.log.error({ err: e }, 'a live test call’s turn failed');
        event(turn, { type: 'error', message: messageOf(e) });
        // The session says it can't go on and connects them, as a real call does when a turn fails.
        throw e;
      }
      const d = done as Extract<TestEvent, { type: 'done' }> | null;
      if (!d) return { kind: 'say', text: '', language };
      const reply = (d.reply ?? '').trim();
      if (d.outcome === 'handed_off')
        return {
          kind: 'transfer',
          text: reply || CONNECTING[tongue(language)],
          language,
          reason: 'other',
          note: handedOn ?? 'It would connect them to the team.',
        } satisfies TurnOutcome;
      // What it said while it wrote, then the rest.
      const start = early.join(' ');
      const rest = restToSay(early, reply);
      return {
        kind: d.ended ? 'end' : 'say',
        text: start ? [start, rest].filter(Boolean).join(' ') : reply,
        language,
        spoken: start.length,
      } satisfies TurnOutcome;
    },

    // Nobody is rung and nothing is recorded: the session ending the stream is the whole of hanging up.
    hangUp: async () => undefined,
    transfer: async () => undefined,

    async finish(_lines, ending) {
      stop.abort();
      o.send({ type: 'ended', outcome: ending.outcome, summary: ending.summary });
      o.onEnd();
    },

    // Talking out loud in a test is the business's to pay for, as the console's voice mode is.
    noteSpeech: (seconds, said) =>
      noteSpeech(deps, test.scope, [
        {
          key: 'speech.live.minute',
          quantity: speechMinutes(seconds),
          source: 'talk',
          ref: o.testCallId,
        },
        {
          key: 'speech.voice.kchar',
          quantity: speechKchars(said),
          source: 'talk',
          ref: o.testCallId,
        },
      ]),

    heard(words) {
      if (!words.text) return;
      if (words.final) finals.push(words.text);
      o.send({
        type: 'hearing',
        text: [...finals, ...(words.final ? [] : [words.text])].join(' '),
      });
    },

    cut: (turn) => o.send({ type: 'cut', turn }),

    timed: (turn, log) => o.send({ type: 'timing', turn, timing: timingOf(log) }),
  };
}

// ---- The phone line's calls, waiting for Twilio to stream them here ----

/** A test call over the phone line whose console is connected to this machine, waiting for its stream. */
interface WaitingCall {
  readonly workspaceId: string;
  readonly userId: string;
  /** The stream arrived: the call runs on it. */
  readonly answer: (link: CallLink, callSid: string) => CallSession;
}

const waiting = new Map<string, WaitingCall>();

/**
 * The stream of a test call placed over the phone line (http/voice-agent.ts): the session it runs on, or null
 * when no console here is waiting for it (it's over, never was, or is someone else's).
 */
export function answerTestCall(
  ticket: { readonly testCallId: string; readonly workspaceId: string; readonly userId: string },
  link: CallLink,
  callSid: string,
): CallSession | null {
  const w = waiting.get(ticket.testCallId);
  if (!w || w.workspaceId !== ticket.workspaceId || w.userId !== ticket.userId) return null;
  waiting.delete(ticket.testCallId);
  return w.answer(link, callSid);
}

// ---- The console's end ----

/** People on a test call on this machine: one at a time each. */
const onCall = new Set<string>();
const starts = new KeyedLimiter();

async function whoIsIt(deps: HttpDeps, token: string): Promise<HumanActor> {
  if (!deps.verifyToken) throw HfosError.unauthenticated();
  return deps.verifyToken(token);
}

/** Whether this business can place a call from a browser over its own line: a number, and calls set up. */
async function hasPhoneLine(deps: HttpDeps, workspaceId: string): Promise<boolean> {
  return asWorker(deps.httpDb, { workspaceId }, async (tx) => {
    const [account] = await tx
      .select({ twimlAppSid: telephonyAccounts.twimlAppSid })
      .from(telephonyAccounts)
      .where(eq(telephonyAccounts.workspaceId, workspaceId));
    const [number] = await tx
      .select({ id: phoneNumbers.id })
      .from(phoneNumbers)
      .where(and(eq(phoneNumbers.workspaceId, workspaceId), eq(phoneNumbers.status, 'active')));
    return !!account?.twimlAppSid && !!number;
  });
}

/**
 * The console's websocket (GET /v1/ai-team/test/call): its first message says who it is and what to test, then
 * the call runs on it (`browser`) or on the stream of the call it places (`phone`), and it hears every event.
 */
export function handleTestCallSocket(socket: WebSocket, deps: HttpDeps): void {
  const consoleDeps: ConsoleDeps = {
    db: deps.httpDb,
    ai: deps.ai,
    voiceAi: deps.voiceAi,
    aiFor: deps.aiFor,
    webUrl: deps.webUrl,
    log: deps.log,
    wallet: deps.wallet,
    geocoder: deps.geocoder,
  };
  let started = false;
  let over = false;
  let userId: string | null = null;
  let testCallId: string | null = null;
  let session: CallSession | null = null;
  /** The phone line's stream, once the call placed over it arrives. */
  let phoneLink: CallLink | null = null;
  let expiry: NodeJS.Timeout | null = null;

  const send = (m: TestCallServerMessage) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
  };
  const end = () => {
    if (over) return;
    over = true;
    if (expiry) clearTimeout(expiry);
    if (testCallId) waiting.delete(testCallId);
    if (userId) onCall.delete(userId);
    void session?.stop();
    // A call over the phone line hangs up with its stream.
    phoneLink?.close();
    if (socket.readyState === socket.OPEN) socket.close(1000);
  };
  const fail = (message: string) => {
    send({ type: 'error', message });
    end();
  };
  const unstarted = setTimeout(() => {
    if (!started) end();
  }, START_WITHIN_MS);

  /** Runs the call on `link`: the session starts, and says hello. */
  const run = (test: PreparedTest, id: string, link: CallLink): CallSession => {
    const sessionDeps: SessionDeps = {
      speech: deps.speech!,
      log: deps.log,
      ...(deps.voiceTimings ? { timings: deps.voiceTimings } : {}),
    };
    const mind = testCallMind({ deps: consoleDeps, test, testCallId: id, send, onEnd: end });
    const s = new CallSession(sessionDeps, link, mind, { testCallId: id });
    session = s;
    send({ type: 'answered' });
    void s.start().then(
      (ok) => {
        if (!ok && !over) fail(mind.problem ?? STOPPED);
      },
      (e: unknown) => {
        deps.log.error({ err: e }, 'a live test call failed to start');
        fail(STOPPED);
      },
    );
    return s;
  };

  const begin = async (m: Extract<TestCallClientMessage, { type: 'start' }>) => {
    const actor = await whoIsIt(deps, m.token);
    const input = parseBody(TestConsoleInput, { ...m.test, channel: 'phone', messages: [] });
    await requirePermission(deps, actor.userId, input.workspaceId, 'ai_team.manage');
    if (!deps.speech) throw HfosError.rule('speech_not_configured', 503, NOT_SET_UP);
    if (onCall.has(actor.userId))
      throw HfosError.rule(
        'test_call_busy',
        409,
        'You’re on a test call already. Hang that one up first.',
      );
    if (!starts.take([{ key: actor.userId, rule: STARTS }]).ok)
      throw HfosError.rule(
        'rate_limited',
        429,
        'That’s a lot of test calls. Wait a few minutes and try again.',
      );
    const test = await prepareTest(consoleDeps, input, { run: false });
    const room = await asWorker(deps.httpDb, test.scope, (tx) =>
      walletRoom(tx, test.scope.workspaceId, 'ai', (msg, e) => deps.log.error({ err: e }, msg)),
    );
    if (!room.allowed) throw HfosError.rule('wallet_empty', 402, WALLET_REFUSALS.ai);
    if (m.way === 'phone') {
      if (!(await hasPermission(deps, actor.userId, input.workspaceId, 'inbox.use')))
        throw HfosError.rule(
          'calls_not_allowed',
          403,
          'You can’t place calls in this business, so the test can’t use its phone line. Use This browser.',
        );
      if (!(await hasPhoneLine(deps, input.workspaceId)))
        throw HfosError.rule(
          'no_phone_line',
          409,
          'This business has no phone line to test on yet. Use This browser.',
        );
    }
    if (over) return;
    userId = actor.userId;
    onCall.add(actor.userId);
    const id = randomUUID();
    testCallId = id;
    deps.log.info(
      { testCallId: id, workspaceId: input.workspaceId, way: m.way satisfies TestCallWay },
      'a live test call started',
    );
    if (m.way === 'browser') {
      let quiet = false;
      run(test, id, {
        sendAudio: (audio) => {
          if (!quiet && socket.readyState === socket.OPEN) socket.send(audio, { binary: true });
        },
        sendMark: (name) => {
          if (!quiet) send({ type: 'mark', name });
        },
        clear: () => {
          if (!quiet) send({ type: 'clear' });
        },
        // The socket stays open for the call's ending (the mind closes it after `ended`).
        close: () => {
          quiet = true;
        },
      });
      return;
    }
    waiting.set(id, {
      workspaceId: input.workspaceId,
      userId: actor.userId,
      answer: (link) => {
        if (expiry) clearTimeout(expiry);
        phoneLink = link;
        return run(test, id, link);
      },
    });
    expiry = setTimeout(() => {
      if (waiting.delete(id)) fail(NO_ANSWER);
    }, TEST_DIAL_TTL_MS + 15_000);
    send({
      type: 'dial',
      ticket: sealTestTicket(deps.sealer, {
        workspaceId: input.workspaceId,
        organizationId: test.scope.organizationId,
        userId: actor.userId,
        testCallId: id,
        machine: thisMachine(),
        callSid: null,
      }),
    });
  };

  socket.on('message', (raw: WebSocket.RawData, isBinary: boolean) => {
    if (isBinary) {
      // The microphone, on a call in this browser.
      if (session && !phoneLink)
        session.onAudio(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer));
      return;
    }
    let m: TestCallClientMessage;
    try {
      m = TestCallClientMessage.parse(JSON.parse(String(raw)));
    } catch {
      return;
    }
    switch (m.type) {
      case 'start':
        if (started) return;
        started = true;
        clearTimeout(unstarted);
        void begin(m).catch((e: unknown) => {
          if (!(e instanceof HfosError))
            deps.log.error({ err: e }, 'a live test call didn’t start');
          fail(messageOf(e));
        });
        return;
      case 'played':
        session?.onMark(m.name);
        return;
      case 'hang_up':
        if (session) void session.stop();
        else end();
        return;
    }
  });
  socket.on('close', () => {
    clearTimeout(unstarted);
    end();
  });
  socket.on('error', (e: Error) => deps.log.warn({ err: e }, 'a live test call’s socket errored'));
}
