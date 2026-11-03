/**
 * Rime's streaming voice (its WebSocket v1 protocol, JSON messages) as one call's VoiceLine: opened once, when the
 * call is picked up, and used for every sentence after, as Deepgram's is (deepgram-voice-line.ts). Coda and Mist v3
 * speak the same protocol on their own hosts.
 *
 * - The connection asks for the `rime.v1.json` subprotocol and waits for `ready` (protocol 1) before it's used.
 * - Each sentence is a context of its own (a new `contextId`), sent whole in `start` as 8 kHz μ-law
 *   (`audio/pcmu`), so nothing converts audio. Its audio comes back base64 in `audio` events until `done`.
 * - One sentence at a time: another while one is going is LineBusy, and goes by request.
 * - Stopping part-way (the caller talked over it) cancels that context and keeps the line: whatever arrives for
 *   it after is dropped by its id. An error, a stall or the socket closing ends the line; the call opens another.
 * - Rime pings every 30 seconds and the `ws` library answers, which keeps a quiet call's line open.
 */
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import WebSocket from 'ws';
import { LineBusy, type VoiceLine } from './speech';

export const RIME_SUBPROTOCOL = 'rime.v1.json';
const CONNECT_TIMEOUT_MS = 5_000;
/** Longer than this without a piece of audio and a sentence is given up on. */
const QUIET_TIMEOUT_MS = 8_000;

interface Sentence {
  readonly id: string;
  readonly audio: Buffer[];
  done: boolean;
  error: Error | null;
  wake: (() => void) | null;
}

/** One of Rime's events, as much of it as a line reads. */
interface RimeEvent {
  readonly contextId?: string;
  readonly ready?: { readonly protocol?: number };
  readonly audio?: string;
  readonly done?: unknown;
  readonly cancelled?: unknown;
  readonly error?: { readonly kind?: string; readonly message?: string };
}

/** What a sentence is said as: one context, its whole text, phone audio. */
export function rimeStart(o: {
  readonly contextId: string;
  readonly speaker: string;
  readonly language: string;
  readonly text: string;
}): string {
  return JSON.stringify({
    contextId: o.contextId,
    start: {
      speaker: o.speaker,
      language: o.language,
      text: o.text,
      audioParameters: { audioFormat: 'audio/pcmu', samplingRate: 8000 },
    },
  });
}

export async function openRimeVoice(o: {
  readonly apiKey: string;
  /** The model's socket: wss://coda.api.rime.ai/ws or wss://mist.api.rime.ai/ws. */
  readonly url: string;
  /** VoiceLine.model: the voice it speaks in (speech.ts voiceModel). */
  readonly model: string;
  readonly speaker: string;
  /** 'en' or 'es'. */
  readonly language: string;
  readonly log: Logger;
}): Promise<VoiceLine> {
  const ws = new WebSocket(o.url, RIME_SUBPROTOCOL, {
    headers: { authorization: `Bearer ${o.apiKey}` },
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('Rime’s voice didn’t answer in time'));
    }, CONNECT_TIMEOUT_MS);
    const done = (e?: Error) => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      if (e) reject(e);
      else resolve();
    };
    const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      let m: RimeEvent;
      try {
        m = JSON.parse(String(data)) as RimeEvent;
      } catch {
        return;
      }
      if (m.ready) {
        if (m.ready.protocol === 1) done();
        else {
          ws.terminate();
          done(new Error(`Rime’s voice speaks protocol ${m.ready.protocol ?? '?'}, not 1`));
        }
      } else if (m.error) {
        ws.terminate();
        done(new Error(`Rime’s voice: ${m.error.message ?? m.error.kind ?? 'error'}`));
      }
    };
    ws.on('message', onMessage);
    ws.once('error', (e) => done(e));
    ws.once('close', (code) =>
      done(new Error(`Rime closed the voice before it was ready (${code})`)),
    );
  });
  return new RimeVoiceLine(ws, o);
}

class RimeVoiceLine implements VoiceLine {
  private shut = false;
  private sentence: Sentence | null = null;
  readonly model: string;

  constructor(
    private readonly ws: WebSocket,
    private readonly o: {
      readonly model: string;
      readonly speaker: string;
      readonly language: string;
      readonly log: Logger;
    },
  ) {
    this.model = o.model;
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let m: RimeEvent;
      try {
        m = JSON.parse(String(data)) as RimeEvent;
      } catch {
        return;
      }
      const s = this.sentence;
      // A sentence cancelled or finished before: whatever is still on its way is dropped.
      if (!s || m.contextId !== s.id) {
        if (m.error && !m.contextId)
          this.fail(new Error(`Rime’s voice: ${m.error.message ?? m.error.kind ?? 'error'}`));
        return;
      }
      if (typeof m.audio === 'string') {
        if (!s.done) {
          s.audio.push(Buffer.from(m.audio, 'base64'));
          s.wake?.();
        }
      } else if ('done' in m || 'cancelled' in m) {
        s.done = true;
        s.wake?.();
      } else if (m.error) {
        s.error ??= new Error(`Rime’s voice: ${m.error.message ?? m.error.kind ?? 'error'}`);
        s.wake?.();
      }
    });
    ws.on('error', (e) => this.fail(e));
    ws.on('close', () => this.fail(new Error('Rime’s voice closed')));
  }

  get open(): boolean {
    return !this.shut && this.ws.readyState === WebSocket.OPEN;
  }

  async *say(text: string, signal?: AbortSignal): AsyncIterable<Buffer> {
    if (!this.open) throw new Error('Rime’s voice isn’t open');
    if (this.sentence) throw new LineBusy('It’s saying another sentence.');
    const s: Sentence = { id: randomUUID(), audio: [], done: false, error: null, wake: null };
    this.sentence = s;
    this.ws.send(
      rimeStart({ contextId: s.id, speaker: this.o.speaker, language: this.o.language, text }),
    );
    const stop = () => s.wake?.();
    signal?.addEventListener('abort', stop);
    let failed = false;
    try {
      for (;;) {
        if (signal?.aborted) return;
        const piece = s.audio.shift();
        if (piece) {
          yield piece;
          continue;
        }
        if (s.error) {
          failed = true;
          throw s.error;
        }
        if (s.done) return;
        const heard = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), QUIET_TIMEOUT_MS);
          s.wake = () => {
            clearTimeout(timer);
            resolve(true);
          };
        });
        s.wake = null;
        if (!heard) {
          failed = true;
          throw new Error('Rime’s voice went quiet');
        }
      }
    } finally {
      signal?.removeEventListener('abort', stop);
      this.sentence = null;
      if (failed) this.close();
      // Stopped part-way: Rime stops that one, and the line stays for the next.
      else if (!s.done && this.open) {
        s.done = true;
        try {
          this.ws.send(JSON.stringify({ contextId: s.id, cancel: {} }));
        } catch (e) {
          this.o.log.debug({ err: e }, 'cancelling a sentence on Rime’s voice');
        }
      }
    }
  }

  close(): void {
    if (this.shut) return;
    this.shut = true;
    try {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
      else this.ws.terminate();
    } catch (e) {
      this.o.log.debug({ err: e }, 'closing Rime’s voice');
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
