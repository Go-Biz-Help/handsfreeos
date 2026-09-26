import {
  restToSay,
  testSamples,
  TEST_MESSAGES_MAX,
  type AiCallPurpose,
  type TestCall,
  type TestCallDirection,
  type TestConsoleChannel,
} from '@hfos/core';
import * as Crypto from 'expo-crypto';
import * as React from 'react';

import { useVoice } from '@/voice/use-voice';

import { firstName, historyOf, newTurn, stepTurn, type Turn } from './test-console';
import { streamTest, TestConsoleError, type TestFailure } from './test-stream';

/** Who the manager plays: someone in Customers, or nobody (an unknown visitor or caller). */
export interface TestPerson {
  readonly id: string;
  readonly name: string;
}

/**
 * The phone's test console: who to be, how (text, chat, email, or a call either way and why), when, and the turns
 * so far. Each turn goes to the worker (`streamTest`) and grows as its events come back. Changing who, how or why
 * starts over, as the web's does. Nothing is kept on the phone: a test isn't a change.
 *
 * On a call, talking out loud plays it for real, as on the web: the manager says what the caller says, and hears
 * each reply in the teammate's own phone voice, then it listens again, until the call ends.
 */
export function useTestConsole(workspaceId: string, name: string) {
  const [person, setPersonRaw] = React.useState<TestPerson | null>(null);
  const [channel, setChannelRaw] = React.useState<TestConsoleChannel>('sms');
  const [direction, setDirectionRaw] = React.useState<TestCallDirection>('inbound');
  const [purpose, setPurposeRaw] = React.useState<AiCallPurpose>('confirm_visit');
  const [goal, setGoalRaw] = React.useState('');
  /** Pretend it's this time (ISO 8601); null is now. */
  const [at, setAt] = React.useState<string | null>(null);
  /** What's typed and not sent yet. */
  const [text, setText] = React.useState('');
  const [turns, setTurns] = React.useState<readonly Turn[]>([]);
  const [busy, setBusy] = React.useState(false);
  /** Why the console can't be used at all (no signal, not in this build, the route isn't there). */
  const [failure, setFailure] = React.useState<TestFailure | null>(null);
  const abort = React.useRef<AbortController | null>(null);
  // The saved settings are what's tested, so it speaks in the teammate's saved voice (null asks the worker).
  const { session: voice, snap: voiceSnap } = useVoice(workspaceId, null);
  const talking = voiceSnap.phase !== 'off';
  /** The turns already read out (or not to be), so each reply is said once. */
  const said = React.useRef(new Set<string>());
  /** For the reply being written: how many of its early sentences have been said, and in which turn of the voice. */
  const saying = React.useRef<{ id: string; count: number; generation: number } | null>(null);

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
    ? firstName(person.name)
    : channel === 'chat'
      ? 'a visitor'
      : phone
        ? 'a caller'
        : 'a customer';
  const last = turns[turns.length - 1];
  /** The call has started: its greeting came back. */
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

  React.useEffect(() => () => abort.current?.abort(), []);

  const stop = React.useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    setBusy(false);
    voice.quiet();
  }, [voice]);

  const startOver = React.useCallback(() => {
    stop();
    said.current.clear();
    setTurns([]);
    setFailure(null);
  }, [stop]);

  // Talking out loud is for calls.
  React.useEffect(() => {
    if (!phone) voice.stop();
  }, [phone, voice]);

  /** Changing who, how or why starts the test over. */
  const restarting =
    <T>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      startOver();
    };

  const update = (id: string, fn: (t: Turn) => Turn) =>
    setTurns((xs) => xs.map((x) => (x.id === id ? fn(x) : x)));

  /** Sends what they wrote or said; with no words on a call, starts it (and starts it over when asked). */
  async function run(raw: string, restart = false) {
    const message = raw.trim();
    const kind = phone ? (message ? 'call' : 'greeting') : 'written';
    if ((kind !== 'greeting' && !message) || (busy && !restart)) return;
    if (restart) stop();
    // Typed while it listened or spoke: that turn is the one going now.
    if (voice.phase === 'listening' || voice.phase === 'speaking') voice.quiet();
    voice.thinking();
    const before = restart ? [] : turns;
    const id = Crypto.randomUUID();
    setTurns([
      ...before,
      newTurn({
        id,
        kind,
        message,
        channel,
        who: person ? firstName(person.name) : null,
        name,
        outbound,
      }),
    ]);
    setText('');
    setBusy(true);
    setFailure(null);
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      await streamTest(
        {
          workspaceId,
          personId: person?.id ?? null,
          channel,
          call,
          at,
          config: null,
          messages: [
            ...historyOf(before),
            ...(message ? [{ from: 'customer' as const, text: message }] : []),
          ].slice(-TEST_MESSAGES_MAX),
        },
        (e) => update(id, (t) => stepTurn(t, e)),
        ctrl.signal,
      );
      update(id, (t) => (t.done ? t : { ...t, done: true }));
    } catch (e) {
      const failed = e instanceof TestConsoleError ? e : null;
      // With no signal, or no console at all, the words are kept to send again and the screen says why.
      if (
        failed &&
        (failed.failure === 'no_signal' ||
          failed.failure === 'not_configured' ||
          failed.failure === 'gone')
      ) {
        setFailure(failed.failure);
        setTurns((xs) => xs.filter((x) => x.id !== id));
        if (message) setText((typed) => typed || message);
        // The screen says why; there's nothing to answer out loud.
        voice.idle();
      } else
        update(id, (t) => ({
          ...t,
          done: true,
          error: e instanceof Error ? e.message : 'The test stopped. Try again.',
        }));
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
  const sendRef = React.useRef(send);
  sendRef.current = send;

  /** Hears what the caller says, and says it. */
  const listenTurn = React.useCallback(async () => {
    const words = await voice.listen();
    if (words) sendRef.current(words);
  }, [voice]);

  // Out loud, a reply starts being said while it's written, a checked sentence at a time, as a real call says it;
  // talking over it stops it.
  React.useEffect(() => {
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
  React.useEffect(() => {
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
  }, [phone, talking, last, voice, listenTurn]);

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

  return {
    person,
    setPerson: restarting(setPersonRaw),
    channel,
    setChannel: restarting(setChannelRaw),
    direction,
    setDirection: restarting(setDirectionRaw),
    purpose,
    setPurpose: restarting(setPurposeRaw),
    goal,
    setGoal: restarting(setGoalRaw),
    at,
    setAt,
    text,
    setText,
    turns,
    busy,
    failure,
    phone,
    outbound,
    who,
    onCall,
    callOver,
    cantCall,
    samples: testSamples(channel, call),
    /** The box to write or speak in shows: always in writing, and on a call while it's going. */
    canWrite: !phone || (onCall && !callOver),
    send,
    startCall,
    stop,
    startOver,
    /** Talking out loud on a call. */
    voice,
    voiceSnap,
    talking,
    toggleTalk,
    talkNow,
  };
}

export type TestConsoleState = ReturnType<typeof useTestConsole>;
