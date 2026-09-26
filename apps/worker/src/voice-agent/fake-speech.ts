/**
 * The stand-in for hearing and speaking (development and tests). Audio here is words: a frame the caller sends
 * is taken as UTF-8 text they said, finished and done (so one frame is one turn), and what the teammate says
 * comes back as its own words in UTF-8. A test reads a call's outgoing audio as text. Its open voice (a call's
 * VoiceLine) does the same, and notes what went down it.
 *
 * Words wrapped in `[es]…` are heard as Spanish; a frame of `[talking]` is them starting to talk over it.
 *
 * Voice mode's clips: a recording sent as text/plain is those words (how tests talk); a real recording (a browser
 * or a phone on a developer's computer) is heard as FAKE_HEARD, since there's nobody to listen. A clip it says is
 * a quiet WAV about as long as the words would take, so the app plays something and moves on.
 */
import {
  voiceModel,
  type HeardClip,
  type ListenHandlers,
  type Listening,
  type SpeakOptions,
  type SpeechServices,
  type VoiceClip,
  type VoiceLine,
} from './speech';

export const FAKE_TALKING = '[talking]';
/** What the stand-in hears in a real recording. */
export const FAKE_HEARD = 'Hello, can you hear me?';

/** A silent 8 kHz, 16-bit mono WAV of about `seconds`. */
export function silentWav(seconds: number): Buffer {
  const rate = 8000;
  const samples = Math.max(1, Math.round(rate * seconds));
  const data = samples * 2;
  const wav = Buffer.alloc(44 + data);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + data, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(data, 40);
  return wav;
}

export function createFakeSpeech(): SpeechServices & {
  readonly spoken: string[];
  readonly heard: string[];
  /** What was said down a call's open voice (openVoice), rather than by request. */
  readonly lined: string[];
} {
  const spoken: string[] = [];
  const heard: string[] = [];
  const lined: string[] = [];
  return {
    name: 'fake',
    spoken,
    heard,
    lined,

    async openVoice(options): Promise<VoiceLine> {
      let open = true;
      return {
        model: voiceModel(options.voice, options.language),
        get open() {
          return open;
        },
        async *say(text: string, signal?: AbortSignal): AsyncIterable<Buffer> {
          if (!open) throw new Error('closed');
          if (signal?.aborted) return;
          spoken.push(text);
          lined.push(text);
          yield Buffer.from(text, 'utf8');
        },
        close() {
          open = false;
        },
      };
    },

    async listen(handlers: ListenHandlers): Promise<Listening> {
      let closed = false;
      return {
        send(audio) {
          if (closed) return;
          const said = audio.toString('utf8').trim();
          if (!said) return;
          if (said === FAKE_TALKING) return handlers.onSpeechStarted();
          const es = /^\[es\]\s*/.exec(said);
          handlers.onSpeechStarted();
          handlers.onWords({
            text: es ? said.slice(es[0].length) : said,
            final: true,
            endOfTurn: true,
            language: es ? 'es' : 'en',
          });
        },
        async close() {
          closed = true;
        },
      };
    },

    async *speak(text: string, options: SpeakOptions): AsyncIterable<Buffer> {
      if (options.signal?.aborted) return;
      spoken.push(text);
      yield Buffer.from(text, 'utf8');
    },

    async transcribe(audio, options): Promise<HeardClip> {
      const said =
        options.contentType === 'text/plain' ? audio.toString('utf8').trim() : FAKE_HEARD;
      heard.push(said);
      const es = /^\[es\]\s*/.exec(said);
      const words = said.split(/\s+/).filter(Boolean).length;
      return {
        text: es ? said.slice(es[0].length) : said,
        language: es ? 'es' : 'en',
        // About how long it takes to say: what hearing it is billed on.
        seconds: options.contentType === 'text/plain' ? Math.max(1, words * 0.4) : 2,
      };
    },

    async voiceClip(text, options): Promise<VoiceClip> {
      if (options.signal?.aborted) throw new Error('stopped');
      spoken.push(text);
      const words = text.split(/\s+/).filter(Boolean).length;
      return { contentType: 'audio/wav', audio: silentWav(Math.min(6, 0.3 + words * 0.25)) };
    },
  };
}
