/**
 * Deepgram's streaming voice (Aura 2 over a websocket, `wss://api.deepgram.com/v1/speak`) as one call's
 * VoiceLine: opened once, when the call is picked up, and used for every sentence after. Each sentence is sent
 * (`Speak`) and flushed (`Flush`); its audio comes back as binary frames, μ-law at 8 kHz, until Deepgram says
 * it's `Flushed`.
 *
 * It never holds a sentence up for long:
 * - One sentence at a time. Stopping part-way (the caller talked over it), a warning, an error or a stall closes
 *   the line, since what's left on it is unknown; the call opens another and says the rest with `speak`.
 * - Deepgram takes about twenty flushes a minute on one connection. Past `FLUSHES_PER_MINUTE`, a sentence is
 *   refused with LineBusy and goes by HTTP, and the line stays open for the next.
 */
import type { Logger } from 'pino';
import WebSocket from 'ws';
import { LineBusy, type VoiceLine } from './speech';

export const SPEAK_STREAM_URL = 'wss://api.deepgram.com/v1/speak';
/** A little under Deepgram's twenty a minute, so a busy minute never reaches its limit. */
export const FLUSHES_PER_MINUTE = 18;
const CONNECT_TIMEOUT_MS = 5_000;
/** Longer than this without a piece of audio and a sentence is given up on. */
const QUIET_TIMEOUT_MS = 8_000;

interface Sentence {
  readonly audio: Buffer[];
  done: boolean;
  error: Error | null;
  wake: (() => void) | null;
}

export async function openDeepgramVoice(o: {
  readonly apiKey: string;
  readonly model: string;
  readonly log: Logger;
  /** Tests point it at a stand-in server. */
  readonly url?: string;
}): Promise<VoiceLine> {
  const params = new URLSearchParams({ model: o.model, encoding: 'mulaw', sample_rate: '8000' });
  const ws = new WebSocket(`${o.url ?? SPEAK_STREAM_URL}?${params.toString()}`, {
    headers: { authorization: `Token ${o.apiKey}` },
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('Deepgram’s voice didn’t answer in time'));
    }, CONNECT_TIMEOUT_MS);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
  return new DeepgramVoiceLine(ws, o.model, o.log);
}

class DeepgramVoiceLine implements VoiceLine {
  private shut = false;
  private sentence: Sentence | null = null;
  private readonly flushes: number[] = [];

  constructor(
    private readonly ws: WebSocket,
    readonly model: string,
    private readonly log: Logger,
  ) {
    ws.on('message', (data, isBinary) => {
      const s = this.sentence;
      if (isBinary) {
        if (s && !s.done) {
          s.audio.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
          s.wake?.();
        }
        return;
      }
      let m: { type?: string; description?: string; code?: string };
      try {
        m = JSON.parse(String(data)) as typeof m;
      } catch {
        return;
      }
      if (m.type === 'Flushed') {
        if (s) {
          s.done = true;
          s.wake?.();
        }
      } else if (m.type === 'Warning' || m.type === 'Error') {
        this.fail(new Error(`Deepgram’s voice: ${m.description ?? m.code ?? m.type}`));
      }
    });
    ws.on('error', (e) => this.fail(e));
    ws.on('close', () => this.fail(new Error('Deepgram’s voice closed')));
  }

  get open(): boolean {
    return !this.shut && this.ws.readyState === WebSocket.OPEN;
  }

  async *say(text: string, signal?: AbortSignal): AsyncIterable<Buffer> {
    if (!this.open) throw new Error('Deepgram’s voice isn’t open');
    if (this.sentence) throw new LineBusy('It’s saying another sentence.');
    const now = Date.now();
    while (this.flushes.length && now - this.flushes[0]! > 60_000) this.flushes.shift();
    if (this.flushes.length >= FLUSHES_PER_MINUTE)
      throw new LineBusy('It has said its fill for this minute.');
    const s: Sentence = { audio: [], done: false, error: null, wake: null };
    this.sentence = s;
    this.flushes.push(now);
    this.ws.send(JSON.stringify({ type: 'Speak', text }));
    this.ws.send(JSON.stringify({ type: 'Flush' }));
    const stop = () => s.wake?.();
    signal?.addEventListener('abort', stop);
    try {
      for (;;) {
        if (signal?.aborted) return;
        const piece = s.audio.shift();
        if (piece) {
          yield piece;
          continue;
        }
        if (s.error) throw s.error;
        if (s.done) return;
        const heard = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), QUIET_TIMEOUT_MS);
          s.wake = () => {
            clearTimeout(timer);
            resolve(true);
          };
        });
        s.wake = null;
        if (!heard) throw new Error('Deepgram’s voice went quiet');
      }
    } finally {
      signal?.removeEventListener('abort', stop);
      this.sentence = null;
      // Stopped part-way, or it failed: what's left on the line is unknown, so it's done with.
      if (!s.done || s.error) this.close();
    }
  }

  close(): void {
    if (this.shut) return;
    this.shut = true;
    try {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'Close' }));
        this.ws.close();
      } else this.ws.terminate();
    } catch (e) {
      this.log.debug({ err: e }, 'closing Deepgram’s voice');
    }
  }

  private fail(e: Error): void {
    const s = this.sentence;
    if (s && !s.done) {
      s.error ??= e;
      s.wake?.();
    }
    if (!this.shut) {
      this.shut = true;
      this.ws.terminate();
    }
  }
}
