/**
 * A call's open voice (voice-agent/deepgram-voice-line.ts) against a stand-in for Deepgram's streaming voice, how
 * a call says one sentence with it or without it (session.ts `sayOne`), and the stopwatch on a turn
 * (turn-clock.ts).
 */
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { FLUSHES_PER_MINUTE, openDeepgramVoice } from '../src/voice-agent/deepgram-voice-line';
import { sayOne } from '../src/voice-agent/session';
import { LineBusy, type VoiceLine } from '../src/voice-agent/speech';
import { TurnClock } from '../src/voice-agent/turn-clock';

const log = pino({ level: 'silent' });

/**
 * Deepgram's side: each flushed sentence comes back as its words (in two pieces), then `Flushed`. "slow" sends
 * the first piece and nothing more; "warn" answers with a warning.
 */
let server: WebSocketServer;
let url: string;
const opened: { url: string; auth: string | undefined }[] = [];

beforeAll(async () => {
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/speak`;
  server.on('connection', (ws, req) => {
    opened.push({ url: req.url ?? '', auth: req.headers.authorization });
    let text = '';
    let flushes = 0;
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as { type: string; text?: string };
      if (m.type === 'Speak') text += m.text ?? '';
      if (m.type === 'Flush') {
        const said = text;
        text = '';
        if (said.startsWith('warn')) {
          ws.send(JSON.stringify({ type: 'Warning', description: 'Too many flushes', code: 'W1' }));
          return;
        }
        const half = Math.ceil(said.length / 2);
        ws.send(Buffer.from(said.slice(0, half)));
        if (said.startsWith('slow')) return;
        ws.send(Buffer.from(said.slice(half)));
        ws.send(JSON.stringify({ type: 'Flushed', sequence_id: flushes++ }));
      }
      if (m.type === 'Close') ws.close();
    });
  });
});

afterAll(async () => {
  for (const c of server.clients) c.terminate();
  await new Promise((resolve) => server.close(resolve));
});

const line = () => openDeepgramVoice({ apiKey: 'test-key', model: 'aura-2-thalia-en', log, url });

async function heard(l: VoiceLine, text: string, signal?: AbortSignal): Promise<string> {
  let out = '';
  for await (const audio of l.say(text, signal)) out += audio.toString('utf8');
  return out;
}

describe('a call’s open voice', () => {
  it('says each sentence down one connection, in the phone line’s μ-law', async () => {
    const before = opened.length;
    const l = await line();
    expect(await heard(l, 'Thanks for calling.')).toBe('Thanks for calling.');
    expect(await heard(l, 'How can I help?')).toBe('How can I help?');
    expect(opened.length).toBe(before + 1);
    const params = new URL(opened.at(-1)!.url, 'ws://x').searchParams;
    expect(Object.fromEntries(params)).toEqual({
      model: 'aura-2-thalia-en',
      encoding: 'mulaw',
      sample_rate: '8000',
    });
    expect(opened.at(-1)!.auth).toBe('Token test-key');
    expect(l.open).toBe(true);
    l.close();
    expect(l.open).toBe(false);
  });

  it('is done with the connection when a sentence is stopped part-way', async () => {
    const l = await line();
    const stop = new AbortController();
    let got = '';
    for await (const audio of l.say('slow and steady', stop.signal)) {
      got += audio.toString('utf8');
      stop.abort();
    }
    expect(got).toBe('slow and');
    expect(l.open).toBe(false);
    await expect(heard(l, 'Anything else?')).rejects.toThrow();
  });

  it('closes on a warning, before any of the sentence is said', async () => {
    const l = await line();
    await expect(heard(l, 'warn me')).rejects.toThrow('Too many flushes');
    expect(l.open).toBe(false);
  });

  it('sends a sentence past the minute’s share by request, and stays open', async () => {
    const l = await line();
    for (let i = 0; i < FLUSHES_PER_MINUTE; i++) await heard(l, `Sentence ${i}.`);
    await expect(heard(l, 'One more.')).rejects.toBeInstanceOf(LineBusy);
    expect(l.open).toBe(true);
    l.close();
  });
});

describe('saying one sentence', () => {
  const audioOf = (...pieces: string[]) =>
    (async function* () {
      for (const p of pieces) yield Buffer.from(p);
    })();
  const lineThat = (say: VoiceLine['say']): VoiceLine => ({
    model: 'aura-2-thalia-en',
    open: true,
    say,
    close: () => undefined,
  });
  async function said(o: { line: VoiceLine | null }) {
    const sent: string[] = [];
    const failed: unknown[] = [];
    let requested = false;
    await sayOne({
      line: o.line,
      byRequest: () => {
        requested = true;
        return audioOf('by ', 'request');
      },
      sentence: 'Hello.',
      signal: new AbortController().signal,
      send: (a) => sent.push(a.toString()),
      lineFailed: (e) => failed.push(e),
    });
    return { sent: sent.join(''), requested, failed };
  }

  it('goes down the line when there is one', async () => {
    expect(await said({ line: lineThat(() => audioOf('down ', 'the line')) })).toEqual({
      sent: 'down the line',
      requested: false,
      failed: [],
    });
  });

  it('goes by request without a line, or when the line is busy (which isn’t a failure)', async () => {
    expect(await said({ line: null })).toMatchObject({ sent: 'by request', requested: true });
    const busy = lineThat(async function* () {
      yield* [];
      throw new LineBusy('busy');
    });
    expect(await said({ line: busy })).toEqual({ sent: 'by request', requested: true, failed: [] });
  });

  it('goes by request when the line breaks before saying anything, and counts it', async () => {
    const broken = lineThat(async function* () {
      yield* [];
      throw new Error('closed');
    });
    const r = await said({ line: broken });
    expect(r).toMatchObject({ sent: 'by request', requested: true });
    expect(r.failed).toHaveLength(1);
  });

  it('never says a sentence twice: a line that breaks part-way is the sentence’s failure', async () => {
    const halfway = lineThat(async function* () {
      yield Buffer.from('Hel');
      throw new Error('closed');
    });
    await expect(said({ line: halfway })).rejects.toThrow('closed');
  });
});

describe('the stopwatch', () => {
  it('times each step of a turn from the end of their words, counting only the first AI call', () => {
    const clock = new TurnClock();
    const at = (ms: number) => clock.started + ms;
    clock.onAsked(1);
    clock.asked = at(40);
    clock.onStarted(1, 'thinking');
    clock.answered = at(540);
    clock.onAsked(2);
    clock.onStarted(2, 'text');
    clock.usage({ inputTokens: 300, outputTokens: 20, cacheReadTokens: 5000, cacheWriteTokens: 0 });
    clock.usage({ inputTokens: 900, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 });
    clock.firstSentence = at(760);
    clock.firstAudio = at(990);
    expect(clock.steps()).toEqual({
      loadMs: 40,
      waitMs: 500,
      sentenceMs: 220,
      thought: true,
      ready: true,
    });
    expect(clock.log()).toMatchObject({
      voiceMs: 230,
      firstSoundMs: 990,
      readyTokens: 5000,
      freshTokens: 300,
    });
  });

  it('has no steps when the AI was never asked', () => {
    expect(new TurnClock().steps()).toBeNull();
  });
});
