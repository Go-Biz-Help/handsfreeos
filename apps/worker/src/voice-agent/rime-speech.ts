/**
 * Rime speaking in the AI teammate's Rime voices (@hfos/core voices.ts): Coda, its most natural, and Mist v3, its
 * fastest, with RIME_API_KEY. It only speaks; listening stays with Deepgram (voices.ts sends each its own work).
 *
 * - On a call, `openVoice` keeps one WebSocket open for every sentence (rime-voice-line.ts), and `speak` is the
 *   request a sentence goes by when the line can't take it: Rime's streaming HTTP, answered as 8 kHz μ-law
 *   (`audio/PCMU`) as it's made, so nothing converts audio and the first words play before the last exist.
 * - Talking out loud and "Hear it" get one MP3 clip (`audio/mpeg`).
 *
 * A request that doesn't start answering within RIME_START_MS is given up on, sooner than Deepgram's: a Rime voice
 * that can't speak is switched for its Deepgram one (session.ts, http/speech.ts), and the caller is waiting.
 */
import { phoneVoiceInfo, voiceSpeaker, type PhoneVoice } from '@hfos/core/server';
import type { Logger } from 'pino';
import { openRimeVoice } from './rime-voice-line';
import { voiceModel, type SpeakOptions, type VoiceClip, type VoiceServices } from './speech';

/** Each Rime model's own host: HTTP to say one thing, a WebSocket to keep. */
export const RIME_HOSTS = {
  coda: { http: 'https://coda.api.rime.ai/', ws: 'wss://coda.api.rime.ai/ws' },
  mistv3: { http: 'https://mist.api.rime.ai/', ws: 'wss://mist.api.rime.ai/ws' },
} as const;

/** How long a request may take to start answering before it's given up on. */
export const RIME_START_MS = 5_000;
/** The longest a whole sentence or clip may take. */
const RIME_WHOLE_MS = 30_000;

/** Rime's host for a voice; Deepgram's voices have none. */
function hostOf(voice: PhoneVoice) {
  const { model } = phoneVoiceInfo(voice);
  if (model === 'aura-2') throw new Error(`${voice} isn’t a Rime voice`);
  return RIME_HOSTS[model];
}

/** Rime's language tag for the voice's speaker: Spanish or English, as the speaker speaks. */
export const rimeLanguage = (language: string | null): 'es' | 'en' =>
  language?.toLowerCase().startsWith('es') ? 'es' : 'en';

/** What one request says. */
export function rimeBody(
  voice: PhoneVoice,
  text: string,
  language: string | null,
  samplingRate: number,
) {
  return {
    speaker: voiceSpeaker(voice, language),
    text,
    lang: rimeLanguage(language),
    samplingRate,
  };
}

export function createRimeSpeech(deps: {
  readonly apiKey: string;
  readonly log: Logger;
  /** Tests point it at a stand-in server. */
  readonly hosts?: Partial<
    Record<keyof typeof RIME_HOSTS, { readonly http: string; readonly ws: string }>
  >;
}): VoiceServices {
  const host = (voice: PhoneVoice) => {
    const { model } = phoneVoiceInfo(voice);
    return (model !== 'aura-2' && deps.hosts?.[model]) || hostOf(voice);
  };

  /** One request, answered as it's made; it gives up when nothing has come back within RIME_START_MS. */
  async function request(
    voice: PhoneVoice,
    accept: string,
    body: ReturnType<typeof rimeBody>,
    signal?: AbortSignal,
  ): Promise<{ readonly res: Response; readonly started: () => void }> {
    const slow = new AbortController();
    const timer = setTimeout(
      () => slow.abort(new Error('Rime didn’t start answering in time')),
      RIME_START_MS,
    );
    const all = AbortSignal.any([
      slow.signal,
      AbortSignal.timeout(RIME_WHOLE_MS),
      ...(signal ? [signal] : []),
    ]);
    let res: Response;
    try {
      res = await fetch(host(voice).http, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${deps.apiKey}`,
          accept,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: all,
      });
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
    if (!res.ok || !res.body) {
      clearTimeout(timer);
      const text = await res.text().catch(() => '');
      throw new Error(`Rime couldn’t speak (${res.status}): ${text.slice(0, 200)}`);
    }
    return { res, started: () => clearTimeout(timer) };
  }

  return {
    async *speak(text: string, options: SpeakOptions): AsyncIterable<Buffer> {
      const { res, started } = await request(
        options.voice,
        'audio/PCMU',
        rimeBody(options.voice, text, options.language, 8000),
        options.signal,
      );
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        started();
        yield Buffer.from(chunk);
      }
      started();
    },

    openVoice: (options) =>
      openRimeVoice({
        apiKey: deps.apiKey,
        url: host(options.voice).ws,
        model: voiceModel(options.voice, options.language),
        speaker: voiceSpeaker(options.voice, options.language),
        language: rimeLanguage(options.language),
        log: deps.log,
      }),

    async voiceClip(text, options): Promise<VoiceClip> {
      const { res, started } = await request(
        options.voice,
        'audio/mpeg',
        rimeBody(options.voice, text, options.language, 24000),
        options.signal,
      );
      // A clip is played once it's all here: it started when Rime answered.
      started();
      return { contentType: 'audio/mpeg', audio: Buffer.from(await res.arrayBuffer()) };
    },
  };
}
