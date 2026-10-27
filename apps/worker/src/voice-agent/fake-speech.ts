/**
 * The stand-in for hearing and speaking (development and tests). Audio here is words: a frame the caller sends
 * is taken as UTF-8 text they said, finished and done (so one frame is one turn), and what the teammate says
 * comes back as its own words in UTF-8. A test reads a call's outgoing audio as text. Its open voice (a call's
 * VoiceLine) does the same, and notes what went down it.
 *
 * Words wrapped in `[es]…` are heard as Spanish; a frame of `[talking]` is them starting to talk over it (a sound,
 * then their first word, not yet final), and `[noise]` is a sound that isn't words.
 *
 * A live test call from a browser (ai-team/test-call.ts) sends real audio instead, 8 kHz μ-law from the
 * microphone: nobody is here to hear it, so a stretch of talking and then a pause is heard as FAKE_HEARD, the way
 * a recording is (they start talking when it starts, and finish when the pause does).
 *
 * Voice mode's clips: a recording sent as text/plain is those words (how tests talk); a real recording (a browser
 * or a phone on a developer's computer) is heard as FAKE_HEARD, since there's nobody to listen. A clip it says is
 * a quiet WAV about as long as the words would take, so the app plays something and moves on.
 */
import { linearOf, type PhoneListener } from '@hfos/core/server';
import {
  voiceModel,
  type HeardClip,
  type ListenHandlers,
  type Listening,
  type ListenOptions,
  type SpeakOptions,
  type SpeechServices,
  type VoiceClip,
  type VoiceLine,
} from './speech';

export const FAKE_TALKING = '[talking]';
export const FAKE_NOISE = '[noise]';
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

/**
 * Audio rather than words: phone audio doesn't read as clean text. Its positive samples are bytes from 0x80 up,
 * which aren't UTF-8 on their own (silence is 0xFF), and the quietest negative one (0x7F) and the loudest (below
 * 0x20) are control characters.
 */
const isAudio = (frame: Buffer): boolean =>
  frame.toString('utf8').includes('\uFFFD') ||
  frame.some((b) => b === 0x7f || (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d));

/** How loud a frame of μ-law audio (or 16-bit `wide` sound) is, as a 16-bit sample's root mean square. */
function loudness(frame: Buffer, wide: boolean): number {
  let sum = 0;
  const samples = wide ? Math.floor(frame.length / 2) : frame.length;
  for (let i = 0; i < samples; i++) {
    const s = wide ? frame.readInt16LE(i * 2) : linearOf(frame[i]!);
    sum += s * s;
  }
  return Math.sqrt(sum / Math.max(1, samples));
}

/**
 * Hears real audio the only way the stand-in can: talking (loud for a moment) is them starting to talk, and the
 * pause after it is the end of their turn, heard as FAKE_HEARD. Time is the audio's own, 8,000 samples a second
 * (16,000 two-byte samples for `wide` sound).
 */
function fakeEar(handlers: ListenHandlers, wide = false) {
  /** Louder than this is talking (about -36 dBFS). */
  const LOUD = 500;
  const TALKING_MS = 180;
  const PAUSE_MS = 700;
  let at = 0;
  let loudSince: number | null = null;
  let lastLoud = 0;
  let talking = false;
  return (frame: Buffer) => {
    at += (frame.length / (wide ? 32_000 : 8000)) * 1000;
    if (loudness(frame, wide) >= LOUD) {
      if (loudSince === null || at - lastLoud > 300) loudSince = at;
      lastLoud = at;
      if (!talking && at - loudSince >= TALKING_MS) {
        talking = true;
        handlers.onSpeechStarted();
      }
      return;
    }
    if (talking && at - lastLoud >= PAUSE_MS) {
      talking = false;
      loudSince = null;
      handlers.onWords({ text: FAKE_HEARD, final: true, endOfTurn: true, language: 'en' });
    }
  };
}

export function createFakeSpeech(): SpeechServices & {
  readonly spoken: string[];
  readonly heard: string[];
  /** What was said down a call's open voice (openVoice), rather than by request. */
  readonly lined: string[];
  /** Who each call asked to hear it (ListenOptions), in order: null is the worker's own. */
  readonly listeners: (PhoneListener | null)[];
} {
  const spoken: string[] = [];
  const heard: string[] = [];
  const lined: string[] = [];
  const listeners: (PhoneListener | null)[] = [];
  return {
    name: 'fake',
    spoken,
    heard,
    lined,
    listeners,

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

    async listen(handlers: ListenHandlers, options?: ListenOptions): Promise<Listening> {
      listeners.push(options?.listener ?? null);
      let closed = false;
      const ear = fakeEar(handlers, options?.audio === 'wide');
      return {
        send(audio) {
          if (closed) return;
          if (isAudio(audio)) {
            ear(audio);
            return;
          }
          const said = audio.toString('utf8').trim();
          if (!said) return;
          if (said === FAKE_NOISE) return handlers.onSpeechStarted();
          if (said === FAKE_TALKING) {
            handlers.onSpeechStarted();
            return handlers.onWords({
              text: 'Wait',
              final: false,
              endOfTurn: false,
              language: 'en',
            });
          }
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
