/**
 * Deepgram Flux listening on a live call, the other way to hear a caller: VOICE_LISTENER=flux picks it, and Nova-3
 * (deepgram-speech.ts) stays the default. Flux is made for conversations: it decides itself when the caller has
 * finished (EndOfTurn), from what they said and how, where Nova-3 waits for a set pause.
 *
 * - `flux-general-multi`, with English and Spanish hinted: it hears both, and a caller switching between them,
 *   and still hears another language when that's what they speak (a hint leans; it doesn't limit).
 * - A turn is one transcript that grows. StartOfTurn (always with words) and each Update are the turn so far,
 *   passed on as not yet final, so the caller's first words stop the teammate mid-sentence as Nova-3's interim
 *   results do. EndOfTurn is the whole turn, final. Updates with no words (silence, a noise) aren't passed on,
 *   so they don't keep "Are you still there?" from being asked.
 * - Nothing like Nova-3's UtteranceEnd: a turn Flux isn't sure has ended ends after `eot_timeout_ms` of quiet
 *   (Deepgram's default, five seconds).
 * - The caller's audio goes in 80 ms pieces, as Deepgram recommends for Flux, from Twilio's 20 ms frames.
 * - Flux has no KeepAlive: a call that has sent no audio for five seconds sends a piece of silence instead.
 */
import type { Logger } from 'pino';
import WebSocket from 'ws';
import {
  heardEndMs,
  MULAW_BYTES_A_SECOND,
  type HeardWords,
  type ListenHandlers,
  type Listening,
} from './speech';

export const FLUX_URL = 'wss://api.deepgram.com/v2/listen';
/** 80 ms of the caller's audio: what's sent to Flux at a time. */
export const FLUX_CHUNK_BYTES = (MULAW_BYTES_A_SECOND * 80) / 1000;
/** 80 ms of quiet in μ-law, sent when the call has sent nothing for a while. */
const SILENCE = Buffer.alloc(FLUX_CHUNK_BYTES, 0xff);
const KEEP_ALIVE_MS = 5_000;
const CONNECT_TIMEOUT_MS = 5_000;

export interface FluxMessage {
  readonly type?: string;
  readonly event?: string;
  readonly transcript?: string;
  readonly words?: readonly { readonly word?: string; readonly end?: number | string }[];
  readonly languages?: readonly string[];
  readonly code?: string;
  readonly description?: string;
}

export function fluxListenParams(): URLSearchParams {
  const params = new URLSearchParams({
    model: 'flux-general-multi',
    encoding: 'mulaw',
    sample_rate: '8000',
  });
  params.append('language_hint', 'en');
  params.append('language_hint', 'es');
  return params;
}

/**
 * One of Flux's messages as words heard, or null when it's something else or has no words. `heardTo` is how much
 * of the call's audio it had been sent by then, in seconds.
 */
export function fluxHeardOf(m: FluxMessage, heardTo: number): HeardWords | null {
  if (m.type !== 'TurnInfo') return null;
  const text = (m.transcript ?? '').trim();
  if (!text) return null;
  const end = m.event === 'EndOfTurn';
  return {
    text,
    final: end,
    endOfTurn: end,
    language: m.languages?.[0] ?? null,
    endOfTurnMs: end ? heardEndMs(heardTo, m.words?.at(-1)?.end) : null,
  };
}

export function listenWithFlux(o: {
  readonly apiKey: string;
  readonly handlers: ListenHandlers;
  readonly log: Logger;
  /** Tests point it at a stand-in server. */
  readonly url?: string;
}): Promise<Listening> {
  const { handlers } = o;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${o.url ?? FLUX_URL}?${fluxListenParams().toString()}`, {
      headers: { authorization: `Token ${o.apiKey}` },
    });
    let open = false;
    let failed = false;
    /** The caller's audio not sent yet, until there's 80 ms of it. */
    let waiting: Buffer[] = [];
    let waitingBytes = 0;
    /** All the audio of the call so far, in bytes: where the call is on Flux's clock. */
    let heard = 0;
    let lastSent = Date.now();
    const sendWaiting = () => {
      if (!waitingBytes) return;
      ws.send(waiting.length === 1 ? waiting[0]! : Buffer.concat(waiting, waitingBytes));
      waiting = [];
      waitingBytes = 0;
      lastSent = Date.now();
    };
    const fail = (e: Error) => {
      if (failed) return;
      failed = true;
      handlers.onError(e);
    };
    const timer = setTimeout(() => {
      if (!open) {
        ws.terminate();
        reject(new Error('Deepgram didn’t answer in time'));
      }
    }, CONNECT_TIMEOUT_MS);
    const keepAlive = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN || Date.now() - lastSent < KEEP_ALIVE_MS) return;
      if (waitingBytes) return sendWaiting();
      ws.send(SILENCE);
      heard += SILENCE.length;
      lastSent = Date.now();
    }, KEEP_ALIVE_MS);
    const stop = () => {
      clearTimeout(timer);
      clearInterval(keepAlive);
    };
    ws.on('open', () => {
      open = true;
      clearTimeout(timer);
      resolve({
        send(audio) {
          if (ws.readyState !== WebSocket.OPEN) return;
          heard += audio.length;
          waiting.push(audio);
          waitingBytes += audio.length;
          if (waitingBytes >= FLUX_CHUNK_BYTES) sendWaiting();
        },
        async close() {
          stop();
          if (ws.readyState === WebSocket.OPEN) {
            sendWaiting();
            ws.send(JSON.stringify({ type: 'CloseStream' }));
            ws.close();
          } else ws.terminate();
        },
      });
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let m: FluxMessage;
      try {
        m = JSON.parse(String(data)) as FluxMessage;
      } catch {
        return;
      }
      if (m.type === 'Error')
        return fail(new Error(`Deepgram Flux: ${m.description ?? m.code ?? 'an error'}`));
      if (m.type === 'Warning')
        return o.log.warn({ code: m.code, description: m.description }, 'Deepgram Flux warned');
      if (m.type === 'TurnInfo' && m.event === 'StartOfTurn') handlers.onSpeechStarted();
      const words = fluxHeardOf(m, heard / MULAW_BYTES_A_SECOND);
      if (words) handlers.onWords(words);
    });
    ws.on('error', (e) => {
      stop();
      if (!open) reject(e);
      else fail(e);
    });
    ws.on('close', (code) => {
      stop();
      if (open && code !== 1000 && code !== 1005)
        fail(new Error(`Deepgram closed the stream (${code})`));
    });
  });
}
