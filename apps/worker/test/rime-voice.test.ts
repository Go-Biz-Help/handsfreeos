/**
 * Rime's voices (the owner's picks, 28 Oct 2026): Rime speaking over HTTP and on a call's open voice, against
 * stand-ins for its servers (voice-agent/rime-speech.ts, rime-voice-line.ts); each voice going to its provider, and
 * a Rime voice speaking in its Deepgram one without RIME_API_KEY (voices.ts); and support told about trouble at
 * most once an hour (voice-trouble.ts).
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import type { MailMessage } from '../src/mailer';
import { createFakeSpeech } from '../src/voice-agent/fake-speech';
import { createRimeSpeech } from '../src/voice-agent/rime-speech';
import { openRimeVoice, RIME_SUBPROTOCOL } from '../src/voice-agent/rime-voice-line';
import { LineBusy, type VoiceLine } from '../src/voice-agent/speech';
import { voiceTroubleAlarm } from '../src/voice-agent/voice-trouble';
import { withVoices } from '../src/voice-agent/voices';

const log = pino({ level: 'silent' });

// ---------- Rime's HTTP: each request answers its own text as the audio, in two pieces ----------

let http: Server;
let httpUrl: string;
const requests: { url: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = [];

// ---------- Rime's WebSocket v1: ready, then each context's text back as base64 audio, then done ----------

let wss: WebSocketServer;
let wsUrl: string;
const sockets: { protocol: string; auth: string | undefined; starts: Record<string, unknown>[] }[] =
  [];
const cancels: string[] = [];

beforeAll(async () => {
  http = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push({ url: req.url ?? '', headers: req.headers, body });
      const text = String(body.text);
      if (text.startsWith('fail')) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'invalid speaker' }));
        return;
      }
      res.writeHead(200, { 'content-type': String(req.headers.accept) });
      const half = Math.ceil(text.length / 2);
      res.write(text.slice(0, half));
      res.end(text.slice(half));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  httpUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}/`;

  wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => wss.once('listening', resolve));
  wsUrl = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/ws`;
  wss.on('connection', (ws, req) => {
    const socket = {
      protocol: ws.protocol,
      auth: req.headers.authorization,
      starts: [] as Record<string, unknown>[],
    };
    sockets.push(socket);
    ws.send(JSON.stringify({ ready: { protocol: 1, languages: ['en', 'es'] } }));
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as {
        contextId: string;
        start?: { text: string } & Record<string, unknown>;
        cancel?: object;
      };
      if (m.cancel) {
        cancels.push(m.contextId);
        ws.send(JSON.stringify({ contextId: m.contextId, cancelled: {} }));
        return;
      }
      if (!m.start) return;
      socket.starts.push(m.start);
      const text = m.start.text;
      const send = (piece: string) =>
        ws.send(
          JSON.stringify({ contextId: m.contextId, audio: Buffer.from(piece).toString('base64') }),
        );
      if (text.startsWith('oops')) {
        ws.send(
          JSON.stringify({
            contextId: m.contextId,
            error: { kind: 'invalid_input', message: 'Unknown voice' },
          }),
        );
        return;
      }
      const half = Math.ceil(text.length / 2);
      send(text.slice(0, half));
      // "slow…" sends its first half and waits, as a long sentence does while the caller talks over it.
      if (text.startsWith('slow')) return;
      send(text.slice(half));
      ws.send(JSON.stringify({ contextId: m.contextId, done: {} }));
    });
  });
});

afterAll(async () => {
  for (const c of wss.clients) c.terminate();
  await new Promise((resolve) => wss.close(resolve));
  await new Promise((resolve) => http.close(resolve));
});

const rime = () =>
  createRimeSpeech({
    apiKey: 'rime-key',
    log,
    hosts: { coda: { http: httpUrl, ws: wsUrl }, mistv3: { http: `${httpUrl}mist`, ws: wsUrl } },
  });

async function textOf(audio: AsyncIterable<Buffer>): Promise<string> {
  let out = '';
  for await (const b of audio) out += b.toString('utf8');
  return out;
}

describe('Rime over HTTP', () => {
  it('says a sentence as phone audio, in the voice’s speaker for the caller’s language', async () => {
    expect(
      await textOf(rime().speak('Thanks for calling.', { voice: 'rime_eyre', language: 'en' })),
    ).toBe('Thanks for calling.');
    const r = requests.at(-1)!;
    expect(r.headers.authorization).toBe('Bearer rime-key');
    expect(r.headers.accept).toBe('audio/PCMU');
    expect(r.body).toEqual({
      speaker: 'eyre',
      text: 'Thanks for calling.',
      lang: 'en',
      samplingRate: 8000,
    });
    // Spanish is said by its Spanish speaker; a Mist voice goes to Mist's host.
    await textOf(rime().speak('Hola.', { voice: 'rime_cove', language: 'es-419' }));
    expect(requests.at(-1)!.url).toBe('/mist');
    expect(requests.at(-1)!.body).toMatchObject({ speaker: 'isa', lang: 'es' });
  });

  it('says a clip as an MP3', async () => {
    const clip = await rime().voiceClip('Hi there.', { voice: 'rime_bancroft', language: null });
    expect(clip).toEqual({ contentType: 'audio/mpeg', audio: Buffer.from('Hi there.') });
    expect(requests.at(-1)!.headers.accept).toBe('audio/mpeg');
    expect(requests.at(-1)!.body).toMatchObject({ speaker: 'bancroft', samplingRate: 24000 });
  });

  it('throws when Rime refuses, before any audio', async () => {
    await expect(
      textOf(rime().speak('fail this', { voice: 'rime_eyre', language: null })),
    ).rejects.toThrow('Rime couldn’t speak (400)');
  });
});

describe('Rime’s open voice on a call', () => {
  const line = () =>
    openRimeVoice({
      apiKey: 'rime-key',
      url: wsUrl,
      model: 'rime-coda:eyre',
      speaker: 'eyre',
      language: 'en',
      log,
    });
  const heard = async (l: VoiceLine, text: string, signal?: AbortSignal) => {
    let out = '';
    for await (const b of l.say(text, signal)) out += b.toString('utf8');
    return out;
  };

  it('says each sentence as its own context down one connection, as 8 kHz μ-law', async () => {
    const before = sockets.length;
    const l = await line();
    expect(await heard(l, 'Thanks for calling.')).toBe('Thanks for calling.');
    expect(await heard(l, 'How can I help?')).toBe('How can I help?');
    expect(sockets.length).toBe(before + 1);
    const s = sockets.at(-1)!;
    expect(s.protocol).toBe(RIME_SUBPROTOCOL);
    expect(s.auth).toBe('Bearer rime-key');
    expect(s.starts).toEqual([
      {
        speaker: 'eyre',
        language: 'en',
        text: 'Thanks for calling.',
        audioParameters: { audioFormat: 'audio/pcmu', samplingRate: 8000 },
      },
      expect.objectContaining({ text: 'How can I help?' }),
    ]);
    expect(l.model).toBe('rime-coda:eyre');
    l.close();
    expect(l.open).toBe(false);
  });

  it('cancels a sentence stopped part-way and keeps the line for the next', async () => {
    const l = await line();
    const stop = new AbortController();
    let got = '';
    for await (const b of l.say('slow and steady', stop.signal)) {
      got += b.toString('utf8');
      stop.abort();
    }
    expect(got).toBe('slow and');
    await new Promise((r) => setTimeout(r, 30));
    expect(cancels.length).toBeGreaterThan(0);
    expect(l.open).toBe(true);
    expect(await heard(l, 'Anything else?')).toBe('Anything else?');
    l.close();
  });

  it('takes one sentence at a time', async () => {
    const l = await line();
    const first = l.say('slow one')[Symbol.asyncIterator]();
    await first.next();
    await expect(heard(l, 'Second.')).rejects.toBeInstanceOf(LineBusy);
    await first.return?.();
    l.close();
  });

  it('closes on an error, before any of the sentence is said', async () => {
    const l = await line();
    await expect(heard(l, 'oops')).rejects.toThrow('Unknown voice');
    expect(l.open).toBe(false);
  });
});

describe('each voice to its provider', () => {
  it('sends Rime’s voices to Rime and Deepgram’s to Deepgram, and says so', async () => {
    const deepgram = createFakeSpeech();
    const rimeFake = createFakeSpeech();
    const speech = withVoices({ base: deepgram, rime: rimeFake });
    await textOf(speech.speak('Hello.', { voice: 'rime_cove', language: null }));
    await textOf(speech.speak('Hi.', { voice: 'warm', language: null }));
    await speech.voiceClip('Clip.', { voice: 'rime_summit', language: null });
    expect(rimeFake.voiced).toEqual([
      { text: 'Hello.', voice: 'rime_cove' },
      { text: 'Clip.', voice: 'rime_summit' },
    ]);
    expect(deepgram.voiced).toEqual([{ text: 'Hi.', voice: 'warm' }]);
    expect(speech.voices?.()).toEqual({ deepgram: true, rime: true });
  });

  it('without a Rime key, a Rime voice speaks in its closest Deepgram voice', async () => {
    const deepgram = createFakeSpeech();
    const speech = withVoices({ base: deepgram, rime: null });
    await textOf(speech.speak('Hello.', { voice: 'rime_eyre', language: null }));
    const l = await speech.openVoice!({ voice: 'rime_masonry', language: null });
    await textOf(l.say('Howdy.'));
    expect(deepgram.voiced).toEqual([
      { text: 'Hello.', voice: 'calm' },
      { text: 'Howdy.', voice: 'deep' },
    ]);
    expect(speech.voices?.()).toEqual({ deepgram: true, rime: false });
  });
});

describe('telling support about a Rime voice’s trouble', () => {
  it('emails once an hour, with how many more times it happened', async () => {
    const sent: MailMessage[] = [];
    let now = 0;
    const tell = voiceTroubleAlarm({
      mailer: {
        async send(m) {
          sent.push(m);
          return { messageId: String(sent.length) };
        },
      },
      log,
      alertEmails: ['ops@example.com'],
      webUrl: 'https://app.example.com/',
      now: () => now,
    });
    tell('rime_eyre', 'calm', 'call', new Error('Rime’s voice went quiet'));
    now += 10 * 60_000;
    tell('rime_eyre', 'calm', 'call', new Error('again'));
    tell('rime_cove', 'warm', 'clip', new Error('and again'));
    now += 60 * 60_000;
    tell('rime_cove', 'warm', 'clip', new Error('Rime couldn’t speak (503)'));
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      to: 'ops@example.com',
      subject: 'A Rime voice had trouble, so the AI used Deepgram',
    });
    expect(sent[0]!.text).toContain('Rime couldn’t speak in the Eyre voice on a call');
    expect(sent[0]!.text).toContain('switched to Calm');
    expect(sent[0]!.text).toContain('https://app.example.com/admin/health');
    expect(sent[1]!.text).toContain('for a clip');
    expect(sent[1]!.text).toContain('It happened 2 more times since the last email.');
  });
});
