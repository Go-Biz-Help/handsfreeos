/**
 * Deepgram for a live call (M18 step 5): Nova-3 listening over a websocket, and Aura 2 speaking over HTTP.
 * The same DEEPGRAM_API_KEY the recorded-call transcripts use.
 *
 * Listening:
 * - `language=multi` hears English and Spanish (and switching between them) without being told which.
 * - `endpointing` marks the end of a turn after a short pause; `utterance_end_ms` catches the turns endpointing
 *   misses in noise. `vad_events` says when they start talking, so the teammate stops mid-sentence.
 * - A call with nobody talking sends a keep-alive, or Deepgram closes the stream after ten seconds.
 *
 * Speaking: one request per sentence, answered with the audio as it's made (μ-law at 8 kHz, no container), so
 * the first words play before the last ones exist.
 *
 * Voice mode's clips (the web and the phone): a recording is one pre-recorded request, heard in English or
 * Spanish without being told which, and a clip to play is one Aura 2 request answered as an MP3.
 */
import type { Logger } from 'pino';
import WebSocket from 'ws';
import {
  voiceModel,
  type HeardClip,
  type HeardWords,
  type ListenHandlers,
  type Listening,
  type SpeakOptions,
  type SpeechServices,
} from './speech';

const LISTEN_URL = 'wss://api.deepgram.com/v1/listen';
const CLIP_LISTEN_URL = 'https://api.deepgram.com/v1/listen';
const SPEAK_URL = 'https://api.deepgram.com/v1/speak';
const KEEP_ALIVE_MS = 5_000;
/** How long a sentence may take to start coming back before it's given up on. */
const SPEAK_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 5_000;
/** A minute of talking is heard in a few seconds; longer than that and something is wrong. */
const CLIP_TIMEOUT_MS = 30_000;

interface DeepgramResult {
  readonly type?: string;
  readonly is_final?: boolean;
  readonly speech_final?: boolean;
  readonly channel?: {
    readonly alternatives?: readonly {
      readonly transcript?: string;
      readonly languages?: readonly string[];
    }[];
  };
}

export function listenParams(): URLSearchParams {
  return new URLSearchParams({
    model: 'nova-3',
    language: 'multi',
    encoding: 'mulaw',
    sample_rate: '8000',
    channels: '1',
    interim_results: 'true',
    punctuate: 'true',
    smart_format: 'true',
    endpointing: '300',
    utterance_end_ms: '1000',
    vad_events: 'true',
  });
}

interface DeepgramClipReply {
  readonly metadata?: { readonly duration?: number };
  readonly results?: {
    readonly channels?: readonly {
      readonly detected_language?: string;
      readonly alternatives?: readonly {
        readonly transcript?: string;
        readonly languages?: readonly string[];
      }[];
    }[];
  };
}

export function clipListenParams(): URLSearchParams {
  return new URLSearchParams({
    model: 'nova-3',
    language: 'multi',
    punctuate: 'true',
    smart_format: 'true',
  });
}

/** A pre-recorded answer as the words heard. */
export function heardClipOf(reply: DeepgramClipReply): HeardClip {
  const channel = reply.results?.channels?.[0];
  const alt = channel?.alternatives?.[0];
  const seconds = Number(reply.metadata?.duration);
  return {
    text: (alt?.transcript ?? '').trim(),
    language: alt?.languages?.[0] ?? channel?.detected_language ?? null,
    seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 0,
  };
}

const timeoutWith = (ms: number, signal?: AbortSignal) =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);

/** One of Deepgram's messages, as words heard, or null when it's something else. */
export function heardOf(m: DeepgramResult): HeardWords | null {
  if (m.type !== 'Results') return null;
  const alt = m.channel?.alternatives?.[0];
  const text = (alt?.transcript ?? '').trim();
  return {
    text,
    final: !!m.is_final,
    endOfTurn: !!m.speech_final,
    language: alt?.languages?.[0] ?? null,
  };
}

export function createDeepgramSpeech(deps: {
  readonly apiKey: string;
  readonly log: Logger;
}): SpeechServices {
  return {
    name: 'deepgram',

    listen(handlers: ListenHandlers): Promise<Listening> {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${LISTEN_URL}?${listenParams().toString()}`, {
          headers: { authorization: `Token ${deps.apiKey}` },
        });
        let open = false;
        let lastSent = Date.now();
        const timer = setTimeout(() => {
          if (!open) {
            ws.terminate();
            reject(new Error('Deepgram didn’t answer in time'));
          }
        }, CONNECT_TIMEOUT_MS);
        const keepAlive = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN && Date.now() - lastSent >= KEEP_ALIVE_MS)
            ws.send(JSON.stringify({ type: 'KeepAlive' }));
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
              lastSent = Date.now();
              ws.send(audio);
            },
            async close() {
              stop();
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'CloseStream' }));
                ws.close();
              } else ws.terminate();
            },
          });
        });
        ws.on('message', (data, isBinary) => {
          if (isBinary) return;
          let m: DeepgramResult;
          try {
            m = JSON.parse(String(data)) as DeepgramResult;
          } catch {
            return;
          }
          if (m.type === 'SpeechStarted') return handlers.onSpeechStarted();
          if (m.type === 'UtteranceEnd') return handlers.onUtteranceEnd();
          const heard = heardOf(m);
          if (heard) handlers.onWords(heard);
        });
        ws.on('error', (e) => {
          stop();
          if (!open) reject(e);
          else handlers.onError(e);
        });
        ws.on('close', (code) => {
          stop();
          if (open && code !== 1000 && code !== 1005)
            handlers.onError(new Error(`Deepgram closed the stream (${code})`));
        });
      });
    },

    async *speak(text: string, options: SpeakOptions): AsyncIterable<Buffer> {
      const params = new URLSearchParams({
        model: voiceModel(options.voice, options.language),
        encoding: 'mulaw',
        sample_rate: '8000',
        container: 'none',
      });
      const signal = options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(SPEAK_TIMEOUT_MS)])
        : AbortSignal.timeout(SPEAK_TIMEOUT_MS);
      const res = await fetch(`${SPEAK_URL}?${params.toString()}`, {
        method: 'POST',
        headers: { authorization: `Token ${deps.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal,
      });
      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => '');
        throw new Error(`Deepgram couldn’t speak (${res.status}): ${body.slice(0, 200)}`);
      }
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>)
        yield Buffer.from(chunk);
    },

    async transcribe(audio, options) {
      const res = await fetch(`${CLIP_LISTEN_URL}?${clipListenParams().toString()}`, {
        method: 'POST',
        headers: { authorization: `Token ${deps.apiKey}`, 'content-type': options.contentType },
        body: new Uint8Array(audio),
        signal: timeoutWith(CLIP_TIMEOUT_MS, options.signal),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Deepgram couldn’t hear the clip (${res.status}): ${body.slice(0, 200)}`);
      }
      return heardClipOf((await res.json().catch(() => ({}))) as DeepgramClipReply);
    },

    async voiceClip(text, options) {
      const params = new URLSearchParams({
        model: voiceModel(options.voice, options.language),
        encoding: 'mp3',
      });
      const res = await fetch(`${SPEAK_URL}?${params.toString()}`, {
        method: 'POST',
        headers: { authorization: `Token ${deps.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: timeoutWith(CLIP_TIMEOUT_MS, options.signal),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Deepgram couldn’t speak (${res.status}): ${body.slice(0, 200)}`);
      }
      return { contentType: 'audio/mpeg', audio: Buffer.from(await res.arrayBuffer()) };
    },
  };
}
