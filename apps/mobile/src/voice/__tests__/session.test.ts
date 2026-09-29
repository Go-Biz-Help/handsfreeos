import { VOICE_WORDS } from '@hfos/core';

import { SpeechError } from '../speech';
import { VoiceSession } from '../session';

/**
 * Talking out loud on the phone, with the stand-in microphone and speaker (jest.setup.ts) and the worker played by
 * stand-ins for `hear` and `say`: it asks for the microphone, hears a turn once they stop talking (or when they tap
 * Done), gives up when nothing is said, says text a piece at a time in order, stops speaking when talked over, and
 * turns itself off when talking out loud isn't set up.
 */

const mockHear = jest.fn();
const mockSay = jest.fn();
jest.mock('../speech', () => {
  const actual = jest.requireActual('../speech');
  return {
    ...actual,
    hear: (...args: unknown[]) => mockHear(...args),
    say: (...args: unknown[]) => mockSay(...args),
    forget: jest.fn(),
  };
});

interface FakeRecorder {
  meter: (ms: number) => number;
  uri: string | null;
}
const audio = jest.requireMock('expo-audio') as {
  __recorder: FakeRecorder;
  __played: string[];
  requestRecordingPermissionsAsync: jest.Mock;
};

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function newSession(voice: 'warm' | null = null) {
  return new VoiceSession({
    workspaceId: () => WS,
    voice: () => voice,
    recorder: () => audio.__recorder as never,
  });
}

/** Runs the clock forward, letting what it wakes up finish. */
const pass = (ms: number) => jest.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  jest.useFakeTimers();
  mockHear.mockReset();
  mockSay.mockReset();
  audio.__played.length = 0;
  audio.__recorder.meter = () => -60;
});
afterEach(() => {
  jest.useRealTimers();
});

describe('starting', () => {
  it('asks for the microphone, and says why it can’t start without it', async () => {
    audio.requestRecordingPermissionsAsync.mockResolvedValueOnce({ granted: false });
    const s = newSession();
    expect(await s.start()).toBe(false);
    expect(s.getSnapshot()).toEqual({ phase: 'off', error: VOICE_WORDS.noMic });
    expect(await s.start()).toBe(true);
    expect(s.phase).toBe('idle');
  });
});

describe('listening', () => {
  it('hears a turn once they stop talking, and sends the recording', async () => {
    // The room, then talking for 0.6 s, then quiet.
    audio.__recorder.meter = (ms) => (ms > 300 && ms < 900 ? -20 : -60);
    mockHear.mockResolvedValue({ text: 'Can I book Thursday?', language: 'es' });
    const s = newSession();
    await s.start();
    const heard = s.listen();
    await pass(500);
    expect(s.phase).toBe('listening');
    await pass(2000);
    expect(await heard).toBe('Can I book Thursday?');
    expect(mockHear).toHaveBeenCalledWith(WS, audio.__recorder.uri);
    expect(s.phase).toBe('thinking');

    // What's said back is in the language they spoke.
    mockSay.mockResolvedValue('file:///cache/clip-1.mp3');
    s.speak('Sí, el jueves.');
    await pass(50);
    expect(mockSay.mock.calls[0]![0]).toMatchObject({ language: 'es', voice: null });
  });

  it('gives up when nothing is said', async () => {
    const s = newSession();
    await s.start();
    const heard = s.listen();
    await pass(10_500);
    expect(await heard).toBeNull();
    expect(mockHear).not.toHaveBeenCalled();
    expect(s.getSnapshot()).toEqual({ phase: 'idle', error: VOICE_WORDS.heardNothing });
  });

  it('Done sends what they’ve said so far', async () => {
    audio.__recorder.meter = (ms) => (ms < 150 ? -60 : -20);
    mockHear.mockResolvedValue({ text: 'Hi', language: 'en' });
    const s = newSession();
    await s.start();
    const heard = s.listen();
    await pass(700);
    s.finishTurn();
    await pass(10);
    expect(await heard).toBe('Hi');
  });

  it('says it needs signal when the recording can’t be sent', async () => {
    audio.__recorder.meter = (ms) => (ms > 100 && ms < 600 ? -20 : -60);
    mockHear.mockRejectedValue(new SpeechError('Talking out loud needs signal.', 'no_signal'));
    const s = newSession();
    await s.start();
    const heard = s.listen();
    await pass(2500);
    expect(await heard).toBeNull();
    expect(s.getSnapshot()).toEqual({ phase: 'idle', error: VOICE_WORDS.needsSignal });
  });
});

describe('speaking', () => {
  it('says text a piece at a time, in order, in the voice asked for', async () => {
    let n = 0;
    mockSay.mockImplementation(async () => `file:///cache/clip-${++n}.mp3`);
    const s = newSession('warm');
    await s.start();
    s.speak('Thanks for calling. This is Ava, the AI assistant for Lone Star. How can I help?');
    const finished = s.finishSpeaking();
    expect(s.phase).toBe('speaking');
    await pass(200);
    await finished;
    expect(mockSay.mock.calls.map((c) => (c[0] as { text: string }).text)).toEqual([
      'Thanks for calling.',
      'This is Ava, the AI assistant for Lone Star. How can I help?',
    ]);
    expect(mockSay.mock.calls[0]![0]).toMatchObject({ workspaceId: WS, voice: 'warm' });
    expect(audio.__played).toEqual(['file:///cache/clip-1.mp3', 'file:///cache/clip-2.mp3']);
    expect(s.phase).toBe('idle');
  });

  it('stops speaking when talked over', async () => {
    mockSay.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve('file:///cache/slow.mp3'), 1000)),
    );
    const s = newSession();
    await s.start();
    s.speak('One. Two. Three.');
    const finished = s.finishSpeaking();
    const before = s.generation;
    s.hush();
    await finished;
    await pass(2000);
    expect(s.generation).not.toBe(before);
    expect(audio.__played).toEqual([]);
    expect(s.phase).toBe('idle');
  });

  it('turns itself off, and says why, when the business’s balance has run out', async () => {
    const words =
      'Your balance has run out, so the AI has paused. Top up in Settings → Usage & balance and it picks up where it left off.';
    mockSay.mockRejectedValue(new SpeechError(words, 'no_balance', 402));
    const s = newSession();
    await s.start();
    s.speak('Hello.');
    await pass(50);
    expect(s.getSnapshot()).toEqual({ phase: 'off', error: words });
  });

  it('turns itself off when talking out loud isn’t set up', async () => {
    mockSay.mockRejectedValue(
      new SpeechError('Talking out loud isn’t set up yet.', 'not_configured', 503),
    );
    const s = newSession();
    await s.start();
    s.speak('Hello.');
    await pass(50);
    expect(s.getSnapshot()).toEqual({
      phase: 'off',
      error: 'Talking out loud isn’t set up yet.',
    });
  });
});
