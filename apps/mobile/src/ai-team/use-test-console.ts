import {
  testSamples,
  TEST_MESSAGES_MAX,
  type AiCallPurpose,
  type TestCall,
  type TestCallDirection,
  type TestConsoleChannel,
} from '@hfos/core';
import * as Crypto from 'expo-crypto';
import * as React from 'react';

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
  }, []);

  const startOver = React.useCallback(() => {
    stop();
    setTurns([]);
    setFailure(null);
  }, [stop]);

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
  };
}

export type TestConsoleState = ReturnType<typeof useTestConsole>;
