import { readTestEvents, type TestEvent } from '@hfos/core';

import {
  historyOf,
  newTurn,
  stepTurn,
  turnHeading,
  turnMeta,
  turnSteps,
  type Turn,
} from '../test-console';

/**
 * The phone's test console, worked out: each worker event grows the turn the way the web's console does, a call's
 * greeting and goodbye read as a call, and what goes back to the worker is the test so far. A turn keeps the run that
 * wrote it, for feedback, and "Retry with the fix" says so on its first line.
 */

const AT = '2026-09-25T15:00:00.000Z';
const play = (t: Turn, events: readonly TestEvent[]) =>
  events.reduce((x, e) => stepTurn(x, e, AT), t);
const turn = (kind: Turn['kind'], message = '', outbound = false) =>
  newTurn({
    id: `t-${kind}`,
    kind,
    message,
    channel: kind === 'written' ? 'sms' : 'phone',
    who: 'Omar',
    name: 'Ava',
    outbound,
    now: AT,
  });

describe('a written turn', () => {
  it('grows with the reply, and shows what it looked up, would have done and held', () => {
    const t = play(turn('written', 'Can I book Thursday?'), [
      { type: 'started', runId: 'r1', at: AT },
      { type: 'context', title: 'Read who Omar is', detail: 'No open lead', at: AT },
      { type: 'knowledge', query: null, items: [{ id: 'k1', title: 'Prices' }], at: AT },
      { type: 'tool', name: 'find_times', title: 'Looked up open times', detail: null, at: AT },
      { type: 'would', kind: 'book', summary: 'booked Thu 10 AM on Tune-ups', at: AT },
      { type: 'delta', text: 'You’re booked ' },
      { type: 'delta', text: 'for Thu 10 AM.' },
      {
        type: 'check',
        ok: true,
        passed: ['length', 'links'],
        problems: [],
        rewritten: false,
        at: AT,
      },
      {
        type: 'done',
        outcome: 'drafted',
        reply: null,
        draft: true,
        ended: false,
        toolSteps: 2,
        ms: 1400,
        firstWordsMs: null,
        steps: null,
      },
    ]);
    expect(t.reply).toBe('You’re booked for Thu 10 AM.');
    expect(t.runId).toBe('r1');
    expect(t.would).toEqual(['Would have: booked Thu 10 AM on Tune-ups (simulated)']);
    expect(t.log.map((l) => l.title)).toEqual([
      'Omar texted',
      'Read who Omar is',
      'Searched Knowledge',
      'Looked up open times',
      'Would have: booked Thu 10 AM on Tune-ups',
      'Safety check passed',
      'Draft (training wheels)',
    ]);
    expect(t.log[0]!.quote).toBe('Can I book Thursday?');
    expect(t.log[2]!.knowledge).toEqual(['Prices']);
    expect(t.log[5]!.detail).toBe('2 checks passed');
    expect(turnMeta(t)).toBe('2 look-ups · 1.4 s');
  });

  it('says it tried again with the feedback, for Retry with the fix', () => {
    const fresh = turn('written', 'Are you open Sunday?');
    expect(fresh.runId).toBeNull();
    const again = newTurn({
      id: 't-again',
      kind: 'written',
      message: 'Are you open Sunday?',
      channel: 'sms',
      who: 'Omar',
      name: 'Ava',
      outbound: false,
      now: AT,
      again: { better: 'We’re closed Sundays.', why: 'We don’t work Sundays' },
    });
    expect(again.customer).toBe('Are you open Sunday?');
    expect(again.log).toEqual([
      expect.objectContaining({
        tone: 'ai',
        icon: 'retry',
        title: 'Tried again with your feedback',
        detail: 'We’re closed Sundays. · We don’t work Sundays',
      }),
    ]);
    const onlyWhy = newTurn({
      id: 't-why',
      kind: 'written',
      message: 'Hi',
      channel: 'sms',
      who: null,
      name: 'Ava',
      outbound: false,
      now: AT,
      again: { better: null, why: 'Too long' },
    });
    expect(onlyWhy.log[0]!.detail).toBe('Too long');
  });

  it('says why the test stopped', () => {
    const t = play(turn('written', 'Hi'), [{ type: 'error', message: 'The AI didn’t answer.' }]);
    expect(t).toMatchObject({ done: true, error: 'The AI didn’t answer.' });
    expect(t.log.at(-1)).toMatchObject({ tone: 'bad', title: 'The test stopped' });
  });
});

describe('a call', () => {
  it('opens with its greeting, which has no words of theirs', () => {
    const t = play(turn('greeting', '', true), [
      { type: 'delta', text: 'Hi Omar, this is Ava.' },
      {
        type: 'done',
        outcome: 'replied',
        reply: null,
        draft: false,
        ended: false,
        toolSteps: 0,
        ms: 5,
        firstWordsMs: null,
        steps: null,
      },
    ]);
    expect(t.customer).toBe('');
    expect(t.log.map((l) => l.title)).toEqual(['Ava called Omar', 'Said its greeting']);
    expect(historyOf([t])).toEqual([{ from: 'teammate', text: 'Hi Omar, this is Ava.' }]);
  });

  it('ends on a goodbye, or when it connects them to the team', () => {
    const bye = play(turn('call', 'That’s all, bye!'), [
      {
        type: 'done',
        outcome: 'replied',
        reply: 'Thanks for calling. Bye now!',
        draft: false,
        ended: true,
        toolSteps: 1,
        ms: 10,
        firstWordsMs: null,
        steps: null,
      },
    ]);
    expect(bye).toMatchObject({ ended: true, reply: 'Thanks for calling. Bye now!' });
    expect(bye.log[0]!.title).toBe('Omar said');
    expect(bye.log.at(-1)!.title).toBe('Said goodbye and hung up');

    const handed = play(turn('call', 'I want a person'), [
      {
        type: 'done',
        outcome: 'handed_off',
        reply: 'One moment, I’ll connect you with the team.',
        draft: false,
        ended: true,
        toolSteps: 0,
        ms: 10,
        firstWordsMs: null,
        steps: null,
      },
    ]);
    expect(handed.log.at(-1)!.title).toBe('Connected them to the team');
  });

  it('shows the words it says while writing, then the whole reply', () => {
    const writing = play(turn('call', 'Are you open Saturdays?'), [
      { type: 'say', text: 'Yes, we are.' },
      { type: 'say', text: 'We open at nine.' },
    ]);
    expect(writing).toMatchObject({
      done: false,
      early: ['Yes, we are.', 'We open at nine.'],
      reply: 'Yes, we are. We open at nine.',
    });
    const finished = play(writing, [
      {
        type: 'done',
        outcome: 'replied',
        reply: 'Yes, we are. We open at nine. Anything else?',
        draft: false,
        ended: false,
        toolSteps: 0,
        ms: 900,
        firstWordsMs: 300,
        steps: null,
      },
    ]);
    expect(finished.reply).toBe('Yes, we are. We open at nine. Anything else?');
  });

  it('says when it started talking, for a reply it said while writing it', () => {
    const t = play(turn('call', 'What time are you open?'), [
      { type: 'note', title: 'Starts talking', detail: null, at: AT },
      {
        type: 'done',
        outcome: 'replied',
        reply: 'We’re open eight to five.',
        draft: false,
        ended: false,
        toolSteps: 1,
        ms: 2400,
        firstWordsMs: 800,
        steps: null,
      },
    ]);
    expect(turnMeta(t)).toBe('1 look-up · talks at 0.8 s · done at 2.4 s');
    expect(turnSteps(t)).toBeNull();
  });

  it('says where a call’s time went, step by step', () => {
    const t = play(turn('call', 'What time are you open?'), [
      {
        type: 'done',
        outcome: 'replied',
        reply: 'We’re open eight to five.',
        draft: false,
        ended: false,
        toolSteps: 0,
        ms: 1100,
        firstWordsMs: 700,
        steps: { loadMs: 50, waitMs: 450, sentenceMs: 200, thought: false, ready: true },
      },
    ]);
    expect(turnSteps(t)).toBe(
      'Where the time went: loading 0.1 s · the AI starts 0.5 s · first sentence 0.2 s · its instructions were ready',
    );
  });

  it('numbers the replies after the greeting', () => {
    const turns = [turn('greeting'), turn('call', 'Hi'), turn('call', 'Bye')];
    expect(turns.map((_, i) => turnHeading(turns, i, 'Ava', false))).toEqual([
      'Ava picks up',
      'First reply',
      'Second reply',
    ]);
    expect(turnHeading(turns, 0, 'Ava', true)).toBe('Ava calls');
  });
});

describe('the stream', () => {
  it('reads whole events, skips pings and keeps a half-read one for the next chunk', () => {
    const { events, rest } = readTestEvents(
      ': ping\n\ndata: {"type":"delta","text":"Hi"}\r\n\r\ndata: {"type":"done","outcome":"replied","ended":true',
    );
    expect(events).toEqual([{ type: 'delta', text: 'Hi' }]);
    expect(rest).toBe('data: {"type":"done","outcome":"replied","ended":true');
    const more = readTestEvents(`${rest},"toolSteps":1,"ms":2}\n\n`);
    expect(more.events[0]).toMatchObject({ type: 'done', ended: true, draft: false });
  });
});
