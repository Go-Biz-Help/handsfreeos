/**
 * Listening to a live call with Deepgram Flux (voice-agent/deepgram-flux.ts, VOICE_LISTENER=flux) against a
 * stand-in for Flux's websocket, and how long each listener took to hear the end of a turn (heardEndMs).
 */
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  FLUX_CHUNK_BYTES,
  fluxHeardOf,
  listenWithFlux,
  type FluxMessage,
} from '../src/voice-agent/deepgram-flux';
import type { PhoneListener } from '@hfos/core/server';
import { heardOf } from '../src/voice-agent/deepgram-speech';
import { createFakeSpeech } from '../src/voice-agent/fake-speech';
import { CallSession, type CallLink, type CallMind } from '../src/voice-agent/session';
import { heardEndMs, type HeardWords, type Listening } from '../src/voice-agent/speech';

const log = pino({ level: 'silent' });

/** Flux's side: what each stream was sent, and its socket, so a test says what Flux heard. */
interface Stream {
  readonly url: string;
  readonly auth: string | undefined;
  readonly audio: Buffer[];
  readonly text: unknown[];
  readonly ws: WebSocket;
}
let server: WebSocketServer;
let url: string;
const streams: Stream[] = [];

beforeAll(async () => {
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v2/listen`;
  server.on('connection', (ws, req) => {
    const stream: Stream = {
      url: req.url ?? '',
      auth: req.headers.authorization,
      audio: [],
      text: [],
      ws,
    };
    streams.push(stream);
    ws.send(JSON.stringify({ type: 'Connected', request_id: 'r1', sequence_id: 0 }));
    ws.on('message', (raw, isBinary) => {
      if (isBinary) stream.audio.push(Buffer.from(raw as Buffer));
      else stream.text.push(JSON.parse(String(raw)));
    });
  });
});

afterAll(async () => {
  for (const c of server.clients) c.terminate();
  await new Promise((resolve) => server.close(resolve));
});

interface Heard {
  readonly words: HeardWords[];
  started: number;
  readonly errors: Error[];
}

async function listening(): Promise<{ l: Listening; heard: Heard; stream: Stream }> {
  const heard: Heard = { words: [], started: 0, errors: [] };
  const l = await listenWithFlux({
    apiKey: 'test-key',
    log,
    url,
    handlers: {
      onWords: (w) => heard.words.push(w),
      onSpeechStarted: () => heard.started++,
      onUtteranceEnd: () => undefined,
      onError: (e) => heard.errors.push(e),
    },
  });
  const stream = await vi.waitFor(() => {
    const s = streams.at(-1);
    if (!s) throw new Error('no stream yet');
    return s;
  });
  return { l, heard, stream };
}

/** One of Flux's turn messages. */
const turn = (event: string, transcript: string, more: Partial<FluxMessage> = {}) =>
  JSON.stringify({ type: 'TurnInfo', event, transcript, turn_index: 0, words: [], ...more });

/** 20 ms of a phone call, as Twilio sends it. */
const frame = () => Buffer.alloc(160, 0x7f);

describe('listening with Flux', () => {
  it('asks for the multilingual model on phone audio, with English and Spanish hinted', async () => {
    const { l, stream } = await listening();
    const params = new URL(stream.url, 'ws://x').searchParams;
    expect(params.get('model')).toBe('flux-general-multi');
    expect(params.get('encoding')).toBe('mulaw');
    expect(params.get('sample_rate')).toBe('8000');
    expect(params.getAll('language_hint')).toEqual(['en', 'es']);
    expect(stream.auth).toBe('Token test-key');
    await l.close();
  });

  it('sends the caller’s audio in 80 ms pieces, and what’s left when the call ends', async () => {
    const { l, stream } = await listening();
    for (let i = 0; i < 6; i++) l.send(frame());
    await vi.waitFor(() => expect(stream.audio).toHaveLength(1));
    expect(stream.audio[0]!.length).toBe(FLUX_CHUNK_BYTES);
    await l.close();
    await vi.waitFor(() => expect(stream.text).toContainEqual({ type: 'CloseStream' }));
    expect(stream.audio.map((a) => a.length)).toEqual([FLUX_CHUNK_BYTES, 320]);
  });

  it('passes on a turn as it grows, and the whole of it once they’ve finished', async () => {
    const { l, heard, stream } = await listening();
    // A second of the call, so where it is on Flux's clock is known.
    for (let i = 0; i < 50; i++) l.send(frame());
    stream.ws.send(turn('Update', ''));
    stream.ws.send(turn('StartOfTurn', 'Hi I'));
    stream.ws.send(turn('Update', 'Hi I need a quote'));
    stream.ws.send(
      turn('EndOfTurn', 'Hi, I need a quote.', {
        languages: ['en'],
        words: [
          { word: 'need', end: 0.45 },
          { word: 'quote', end: '0.6' },
        ],
      }),
    );
    await vi.waitFor(() => expect(heard.words).toHaveLength(3));
    // The update with no words (silence, a noise) isn't anything heard.
    expect(heard.started).toBe(1);
    expect(heard.words).toEqual([
      { text: 'Hi I', final: false, endOfTurn: false, language: null, endOfTurnMs: null },
      {
        text: 'Hi I need a quote',
        final: false,
        endOfTurn: false,
        language: null,
        endOfTurnMs: null,
      },
      // A second heard, and their last word ended at 0.6 s.
      {
        text: 'Hi, I need a quote.',
        final: true,
        endOfTurn: true,
        language: 'en',
        endOfTurnMs: 400,
      },
    ]);
    expect(heard.errors).toEqual([]);
    await l.close();
  });

  it('says once when Flux gives up, however it closes, and only logs a warning', async () => {
    const { heard, stream } = await listening();
    stream.ws.send(JSON.stringify({ type: 'Warning', code: 'SLOW_AUDIO', description: 'Slow' }));
    stream.ws.send(JSON.stringify({ type: 'Error', code: 'BAD', description: 'Bad audio' }));
    stream.ws.close(1011);
    await vi.waitFor(() => expect(heard.errors).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(heard.errors.map((e) => e.message)).toEqual(['Deepgram Flux: Bad audio']);
  });

  it('refuses when Flux can’t be reached', async () => {
    await expect(
      listenWithFlux({
        apiKey: 'test-key',
        log,
        url: 'ws://127.0.0.1:1/v2/listen',
        handlers: {
          onWords: () => undefined,
          onSpeechStarted: () => undefined,
          onUtteranceEnd: () => undefined,
          onError: () => undefined,
        },
      }),
    ).rejects.toThrow();
  });
});

describe('how long it took to hear they’d finished', () => {
  it('is the audio heard since their last word ended', () => {
    expect(heardEndMs(1, 0.6)).toBe(400);
    expect(heardEndMs(1, '0.75')).toBe(250);
    // Heard before the audio caught up: never less than nothing.
    expect(heardEndMs(1, 1.2)).toBe(0);
    expect(heardEndMs(1, undefined)).toBeNull();
    expect(heardEndMs(1, '')).toBeNull();
    expect(heardEndMs(1, 'soon')).toBeNull();
  });

  it('comes from Nova-3 when its pause ends the turn, and Flux when it decides', () => {
    expect(
      heardOf(
        {
          type: 'Results',
          is_final: true,
          speech_final: true,
          channel: {
            alternatives: [{ transcript: 'Hola', languages: ['es'], words: [{ end: 2.1 }] }],
          },
        },
        2.5,
      ),
    ).toMatchObject({ endOfTurn: true, endOfTurnMs: 400 });
    expect(
      heardOf(
        {
          type: 'Results',
          is_final: true,
          channel: { alternatives: [{ transcript: 'Hola', words: [{ end: 2.1 }] }] },
        },
        2.5,
      ),
    ).toMatchObject({ endOfTurn: false, endOfTurnMs: null });
    expect(fluxHeardOf({ type: 'TurnInfo', event: 'EndOfTurn', transcript: 'Hola' }, 2)).toEqual({
      text: 'Hola',
      final: true,
      endOfTurn: true,
      language: null,
      endOfTurnMs: null,
    });
    expect(fluxHeardOf({ type: 'TurnInfo', event: 'EndOfTurn', transcript: ' ' }, 2)).toBeNull();
    expect(fluxHeardOf({ type: 'Connected' }, 2)).toBeNull();
  });
});

describe('who hears a business’s calls', () => {
  const link: CallLink = {
    sendAudio: () => undefined,
    sendMark: () => undefined,
    clear: () => undefined,
    close: () => undefined,
  };
  /** A call that only gets as far as listening: it can't answer, so it stops there. */
  const mind = (listener?: () => Promise<PhoneListener | null>): CallMind => ({
    ...(listener ? { listener } : {}),
    prepare: () => Promise.resolve({ ok: false, why: 'only listening' }),
    warm: () => Promise.resolve(),
    think: () => Promise.reject(new Error('no turns')),
    hangUp: () => Promise.resolve(),
    transfer: () => Promise.resolve(),
    finish: () => Promise.resolve(),
    noteSpeech: () => Promise.resolve(),
  });

  it('is the business’s own pick, and the worker’s when there’s none or it can’t be read', async () => {
    const speech = createFakeSpeech();
    const call = (m: CallMind) => new CallSession({ speech, log }, link, m).start();
    expect(await call(mind(() => Promise.resolve('flux')))).toBe(false);
    await call(mind(() => Promise.resolve(null)));
    await call(mind(() => Promise.reject(new Error('The database is away'))));
    await call(mind());
    expect(speech.listeners).toEqual(['flux', null, null, null]);
  });
});
