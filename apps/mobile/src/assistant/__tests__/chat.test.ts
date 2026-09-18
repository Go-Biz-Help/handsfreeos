import { ASSISTANT_WORDS } from '@hfos/core';

import { lapseCalls, noticeFor, settleSteps, upsertStep, type CallState } from '../chat';
import { AssistantError, parseBlock, readEvents } from '../stream';

/**
 * The Assistant's own working out on the phone: reading the worker's stream, what each kind of failure says, and the
 * rules the chat keeps — a step only lands once, steps still spinning settle when an answer ends, and cards left
 * waiting lapse as soon as something else is asked.
 */

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

const RUN = {
  type: 'run',
  runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  threadId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};

describe('reading the worker’s stream', () => {
  it('reads one event per blank line, and keeps a half-arrived one for the next chunk', () => {
    const first = readEvents(
      `data: ${JSON.stringify(RUN)}\n\ndata: ${JSON.stringify({ type: 'text', delta: 'Four ' })}\n\ndata: {"type":"text","de`,
    );
    expect(first.events).toEqual([RUN, { type: 'text', delta: 'Four ' }]);
    expect(first.rest).toBe('data: {"type":"text","de');
    const second = readEvents(`${first.rest}lta":"invoices"}\n\n`);
    expect(second.events).toEqual([{ type: 'text', delta: 'invoices' }]);
    expect(second.rest).toBe('');
  });

  it('reads blocks sent with Windows line endings', () => {
    const read = readEvents(`data: ${JSON.stringify(RUN)}\r\n\r\n`);
    expect(read.events).toEqual([RUN]);
  });

  it('skips pings, comments and anything it can’t read', () => {
    expect(parseBlock(': ping')).toBe(null);
    expect(parseBlock('event: message')).toBe(null);
    expect(parseBlock('data: not json')).toBe(null);
    // An event of a kind this build doesn't know is left out rather than shown wrong.
    expect(parseBlock('data: {"type":"something_new"}')).toBe(null);
  });

  it('joins several data lines into one event', () => {
    expect(parseBlock('data: {"type":"text",\ndata: "delta":"Hi"}')).toEqual({
      type: 'text',
      delta: 'Hi',
    });
  });
});

describe('why an answer stopped short', () => {
  it('says the Assistant needs signal, in the canvas’s words', () => {
    expect(noticeFor(new AssistantError('nope', 'no_signal'))).toEqual({
      code: 'no_signal',
      message: ASSISTANT_WORDS.offline.body,
    });
    // A request that never left the phone throws a TypeError, as fetch does with no signal.
    expect(noticeFor(new TypeError('Network request failed')).code).toBe('no_signal');
  });

  it('keeps the worker’s own words for the rest', () => {
    expect(noticeFor(new AssistantError('Today’s limit', 'budget_reached', 429))).toEqual({
      code: 'budget_reached',
      message: 'Today’s limit',
    });
    expect(noticeFor(new AssistantError('Still answering', 'already_running', 409)).code).toBe(
      'already_running',
    );
    expect(noticeFor(new AssistantError('Busy', 'busy', 503)).code).toBe('busy');
    expect(noticeFor(new AssistantError('Sign in', 'unauthenticated', 401)).code).toBe('forbidden');
    expect(noticeFor(new Error('boom'))).toEqual({
      code: 'failed',
      message: 'Something went wrong. Try again.',
    });
  });
});

describe('the steps under an answer', () => {
  it('shows each step once, in the order it arrived, and follows its state', () => {
    const one = upsertStep([], { id: 'a', label: 'Looking at Money', status: 'running' });
    const two = upsertStep(one, { id: 'b', label: 'Reading invoices', status: 'running' });
    const done = upsertStep(two, { id: 'a', label: 'Looking at Money', status: 'done' });
    expect(done.map((s) => [s.id, s.status])).toEqual([
      ['a', 'done'],
      ['b', 'running'],
    ]);
  });

  it('settles what was still spinning: done when the answer finished, failed when it didn’t', () => {
    const steps = [
      { id: 'a', label: 'One', status: 'running' as const },
      { id: 'b', label: 'Two', status: 'done' as const },
    ];
    expect(settleSteps(steps, true).map((s) => s.status)).toEqual(['done', 'done']);
    expect(settleSteps(steps, false).map((s) => s.status)).toEqual(['failed', 'done']);
  });
});

describe('cards left waiting', () => {
  it('lapse when something else is asked, and answered ones stay as they are', () => {
    const calls: Record<string, CallState> = {
      waiting: {
        status: 'awaiting_confirmation',
        tool: 'send_text',
        outcome: null,
        error: null,
        href: null,
      },
      sent: {
        status: 'confirmed',
        tool: 'send_text',
        outcome: 'Sent to Mike Johnson',
        error: null,
        href: null,
      },
    };
    const after = lapseCalls(calls);
    expect(after.waiting!.status).toBe('expired');
    expect(after.sent!.status).toBe('confirmed');
    expect(after.sent!.outcome).toBe('Sent to Mike Johnson');
  });
});
