import { describe, expect, it } from 'vitest';
import {
  dialParams,
  parseTestCallMessage,
  TEST_CALL_PARAM,
  TEST_CALL_TO,
  TestCallClientMessage,
  testCallTimingLine,
} from '../src/index';

/** A live test call's messages: what the console sends the worker, and reads back from it. */

describe('what the console sends', () => {
  it('starts with a token, a way and the settings to test', () => {
    const start = TestCallClientMessage.parse({
      type: 'start',
      token: 'jwt',
      way: 'browser',
      test: { workspaceId: 'w', call: { direction: 'inbound' } },
    });
    expect(start).toMatchObject({ type: 'start', way: 'browser' });
    expect(() =>
      TestCallClientMessage.parse({ type: 'start', token: 'jwt', way: 'fax', test: {} }),
    ).toThrow();
    expect(TestCallClientMessage.parse({ type: 'played', name: 'said-1' })).toEqual({
      type: 'played',
      name: 'said-1',
    });
    expect(TestCallClientMessage.parse({ type: 'hang_up' })).toEqual({ type: 'hang_up' });
  });

  it('places a call over the phone line to the test number, with the ticket', () => {
    expect(dialParams('sealed')).toEqual({ To: TEST_CALL_TO, [TEST_CALL_PARAM]: 'sealed' });
  });
});

describe('what the worker sends back', () => {
  it('reads each message, and the console event inside one', () => {
    expect(parseTestCallMessage({ type: 'dial', ticket: 't' })).toEqual({
      type: 'dial',
      ticket: 't',
    });
    expect(parseTestCallMessage({ type: 'turn', turn: 2, said: 'Hi' })).toEqual({
      type: 'turn',
      turn: 2,
      said: 'Hi',
    });
    expect(
      parseTestCallMessage({ type: 'event', turn: 1, event: { type: 'say', text: 'Yes.' } }),
    ).toEqual({ type: 'event', turn: 1, event: { type: 'say', text: 'Yes.' } });
    expect(parseTestCallMessage({ type: 'mark', name: 'said-3' })).toEqual({
      type: 'mark',
      name: 'said-3',
    });
    expect(parseTestCallMessage({ type: 'ended', outcome: 'handed_off', summary: 'x' })).toEqual({
      type: 'ended',
      outcome: 'handed_off',
      summary: 'x',
    });
    expect(parseTestCallMessage({ type: 'error' })).toEqual({
      type: 'error',
      message: 'The test call stopped. Try again.',
    });
  });

  it('skips what it can’t read', () => {
    expect(parseTestCallMessage(null)).toBeNull();
    expect(parseTestCallMessage({ type: 'turn', turn: -1 })).toBeNull();
    expect(parseTestCallMessage({ type: 'event', turn: 1, event: { type: 'nope' } })).toBeNull();
    expect(parseTestCallMessage({ type: 'mystery' })).toBeNull();
  });

  it('says where a turn’s time went, from the end of their words to the first sound', () => {
    const timing = parseTestCallMessage({
      type: 'timing',
      turn: 1,
      timing: { firstSoundMs: 1300, loadMs: 100, waitMs: 600, sentenceMs: 300, voiceMs: 200 },
    });
    expect(timing?.type).toBe('timing');
    if (timing?.type !== 'timing') return;
    expect(testCallTimingLine(timing.timing, (ms) => `${(ms / 1000).toFixed(1)} s`)).toBe(
      'first sound 1.3 s after they stopped · loading 0.1 s · the AI starts 0.6 s · first sentence 0.3 s · voice 0.2 s',
    );
  });
});
