/**
 * Hearing and speaking on a live call (M18 step 5). The call's audio arrives from Twilio Media Streams as 8 kHz
 * μ-law, and what the teammate says goes back the same way, so both sides of this seam speak μ-law and nothing
 * converts audio in between.
 *
 * - `listen` opens one stream for the whole call. It reports words as they're heard (interim and final), when
 *   the caller starts talking (so the teammate stops mid-sentence), and when they've finished a thought.
 * - `speak` turns one sentence into audio, streamed, so the first words play while the rest is still made.
 *
 * `deepgram` (deepgram-speech.ts) is the real one; `fake` (fake-speech.ts) is the stand-in for tests, which
 * treats the audio it's sent as the words themselves.
 */
import type { PhoneVoice } from '@hfos/core/server';

/** Words heard on the call. */
export interface HeardWords {
  readonly text: string;
  /** The words won't change any more (an interim guess is replaced by the next result). */
  readonly final: boolean;
  /** The caller paused long enough to have finished a thought. */
  readonly endOfTurn: boolean;
  /** The language the words were in ('en', 'es'…), when the listener says. */
  readonly language: string | null;
}

export interface ListenHandlers {
  readonly onWords: (w: HeardWords) => void;
  /** They started talking: the teammate stops speaking. */
  readonly onSpeechStarted: () => void;
  /** Silence after words that may never have been marked the end of a turn (noise, a trailing "um"). */
  readonly onUtteranceEnd: () => void;
  readonly onError: (e: Error) => void;
}

export interface Listening {
  /** One frame of the caller's audio (8 kHz μ-law). */
  send(audio: Buffer): void;
  close(): Promise<void>;
}

export interface SpeakOptions {
  readonly voice: PhoneVoice;
  /** The caller's language: a Spanish voice speaks Spanish. */
  readonly language: string | null;
  readonly signal?: AbortSignal;
}

export interface SpeechServices {
  readonly name: 'deepgram' | 'fake';
  listen(handlers: ListenHandlers): Promise<Listening>;
  /** 8 kHz μ-law audio of `text`, in pieces as they're made. */
  speak(text: string, options: SpeakOptions): AsyncIterable<Buffer>;
}

/**
 * Each voice the owner can pick, in English and in Spanish (Deepgram Aura 2). Any other language is spoken in the
 * English voice.
 */
export const VOICE_MODELS: Readonly<
  Record<PhoneVoice, { readonly en: string; readonly es: string }>
> = {
  warm: { en: 'aura-2-thalia-en', es: 'aura-2-celeste-es' },
  bright: { en: 'aura-2-andromeda-en', es: 'aura-2-estrella-es' },
  calm: { en: 'aura-2-helena-en', es: 'aura-2-celeste-es' },
  deep: { en: 'aura-2-apollo-en', es: 'aura-2-nestor-es' },
};

export function voiceModel(voice: PhoneVoice, language: string | null): string {
  const v = VOICE_MODELS[voice] ?? VOICE_MODELS.warm;
  return language?.toLowerCase().startsWith('es') ? v.es : v.en;
}
