/**
 * Hearing and speaking on a live call (M18 step 5). The call's audio arrives from Twilio Media Streams as 8 kHz
 * μ-law, and what the teammate says goes back the same way, so both sides of this seam speak μ-law and nothing
 * converts audio in between.
 *
 * - `listen` opens one stream for the whole call. It reports words as they're heard (interim and final), when
 *   the caller starts talking (so the teammate stops mid-sentence), and when they've finished a thought.
 * - `speak` turns one sentence into audio, streamed, so the first words play while the rest is still made.
 *   `openVoice` does the same over one connection kept open for the call, which saves each sentence the time it
 *   takes to start a request; `speak` stays the fallback whenever that connection can't.
 *
 * Voice mode on the web and the phone (the Assistant, and the test console on a call) uses the same services for
 * whole clips instead of a live stream: `transcribe` reads one recording the app made, and `voiceClip` answers
 * with a file the app plays (MP3).
 *
 * `deepgram` (deepgram-speech.ts) is the real one, listening with Nova-3 or, with VOICE_LISTENER=flux, Flux
 * (deepgram-flux.ts); `fake` (fake-speech.ts) is the stand-in for tests, which treats the audio it's sent as the
 * words themselves. A business may pick a Rime voice instead of a Deepgram one: voices.ts sends each voice's
 * speaking to its provider (rime-speech.ts for Rime), and listening always stays with Deepgram.
 */
import {
  phoneVoiceInfo,
  voiceFallback,
  voiceSpeaker,
  type PhoneListener,
  type PhoneVoice,
  type VoiceReadiness,
} from '@hfos/core/server';

/** Words heard on the call. */
export interface HeardWords {
  readonly text: string;
  /** The words won't change any more (an interim guess is replaced by the next result). */
  readonly final: boolean;
  /** The caller paused long enough to have finished a thought. */
  readonly endOfTurn: boolean;
  /** The language the words were in ('en', 'es'…), when the listener says. */
  readonly language: string | null;
  /**
   * With `endOfTurn`: how long after their last word the listener said they'd finished, when it says where that
   * word ended (heardEndMs). The wait before the turn's own stopwatch starts.
   */
  readonly endOfTurnMs?: number | null;
}

/** 8 kHz μ-law is a byte a sample: a call's audio in bytes, divided by this, is its length in seconds. */
export const MULAW_BYTES_A_SECOND = 8_000;

/** A video call's sound (`audio: 'wide'`): 16 kHz, 16-bit, one channel, so two bytes a sample. */
export const WIDE_SAMPLE_RATE = 16_000;
export const WIDE_BYTES_A_SECOND = WIDE_SAMPLE_RATE * 2;

/**
 * How long after the caller's last word the listener said their turn was over, in milliseconds: the audio heard
 * by then (`heardTo`, seconds from the start of the stream) less where that word ended. Null when the word's end
 * isn't known.
 */
export function heardEndMs(heardTo: number, wordEnd: unknown): number | null {
  // Flux's schema allows a number written as a string.
  const end: unknown = typeof wordEnd === 'string' && wordEnd.trim() ? Number(wordEnd) : wordEnd;
  if (typeof end !== 'number' || !Number.isFinite(end) || end < 0) return null;
  return Math.max(0, Math.round((heardTo - end) * 1000));
}

/** A language as two lowercase letters ('es-419' → 'es'), or null when there's none to tell. */
export function spokenLanguage(raw: string | null | undefined): string | null {
  const m = /^([a-z]{2})(?:[-_][a-z0-9]+)*$/i.exec(raw?.trim() ?? '');
  return m ? m[1]!.toLowerCase() : null;
}

export interface ListenHandlers {
  readonly onWords: (w: HeardWords) => void;
  /** They started talking: the teammate stops speaking. */
  readonly onSpeechStarted: () => void;
  /** Silence after words that may never have been marked the end of a turn (noise, a trailing "um"). */
  readonly onUtteranceEnd: () => void;
  readonly onError: (e: Error) => void;
}

export interface ListenOptions {
  /** Who hears the call, when support picked one for the business in /admin; null is the worker's VOICE_LISTENER. */
  readonly listener?: PhoneListener | null;
  /**
   * What the audio is: a phone call's 8 kHz μ-law (`phone`, the default), or a HandsFreeOS video call's 16 kHz
   * 16-bit sound (`wide`, little-endian), which is heard better. Wide sound is always heard by Nova-3.
   */
  readonly audio?: 'phone' | 'wide';
}

export interface Listening {
  /** One frame of the caller's audio (8 kHz μ-law, or 16 kHz 16-bit with `audio: 'wide'`). */
  send(audio: Buffer): void;
  close(): Promise<void>;
}

export interface SpeakOptions {
  readonly voice: PhoneVoice;
  /** The caller's language: a Spanish voice speaks Spanish. */
  readonly language: string | null;
  readonly signal?: AbortSignal;
}

/** Words heard in one recording. */
export interface HeardClip {
  readonly text: string;
  readonly language: string | null;
  /** How long the recording was: what hearing it is billed on. */
  readonly seconds: number;
}

/** One clip of speech, as a file a browser or a phone plays. */
export interface VoiceClip {
  readonly contentType: string;
  readonly audio: Buffer;
}

/**
 * One voice kept open for a whole call: each sentence goes down a connection opened once, rather than a request of
 * its own, so the first sound of each comes sooner. A line speaks in one voice (`model`); a caller who switches
 * language gets another. When a line can't say a sentence it throws before any audio, and the call says that one
 * with `speak` instead; `LineBusy` means only this sentence (the line stays open).
 */
export interface VoiceLine {
  /** The voice it speaks in (voiceModel). */
  readonly model: string;
  /** False once it's closed or broken: the call opens another. */
  readonly open: boolean;
  /** 8 kHz μ-law audio of `text`, in pieces as they're made. Stopping part-way closes the line. */
  say(text: string, signal?: AbortSignal): AsyncIterable<Buffer>;
  close(): void;
}

/** This sentence can't go down the line (it's saying another, or has said its fill this minute): use `speak`. */
export class LineBusy extends Error {
  constructor(why: string) {
    super(why);
    this.name = 'LineBusy';
  }
}

export interface SpeechServices {
  readonly name: 'deepgram' | 'fake';
  listen(handlers: ListenHandlers, options?: ListenOptions): Promise<Listening>;
  /** 8 kHz μ-law audio of `text`, in pieces as they're made. */
  speak(text: string, options: SpeakOptions): AsyncIterable<Buffer>;
  /** Opens a voice for a call (VoiceLine). Without it, every sentence is said with `speak`. */
  openVoice?(options: Omit<SpeakOptions, 'signal'>): Promise<VoiceLine>;
  /** The words in one recording (`contentType` is its own: audio/webm, audio/mp4…). */
  transcribe(
    audio: Buffer,
    options: { readonly contentType: string; readonly signal?: AbortSignal },
  ): Promise<HeardClip>;
  /** `text` said in one clip. */
  voiceClip(text: string, options: SpeakOptions): Promise<VoiceClip>;
  /** Which providers can speak (voices.ts); without it, Deepgram's voices alone. */
  voices?(): VoiceReadiness;
  /**
   * A voice couldn't speak, so the call or the clip switched to `to`, its closest Deepgram voice: support is told
   * (voice-trouble.ts). It never throws.
   */
  trouble?(from: PhoneVoice, to: PhoneVoice, where: 'call' | 'clip', error: unknown): void;
}

/** One provider's speaking, without the listening: Rime (rime-speech.ts). */
export type VoiceServices = Pick<SpeechServices, 'speak' | 'openVoice' | 'voiceClip'>;

/**
 * What a voice speaks in for the caller's language: Deepgram's model ("aura-2-thalia-en"), or a Rime speaker named
 * with its model ("rime-coda:eyre"), so a call's open voice (VoiceLine.model) changes when the voice or the language
 * does. Spanish is spoken by the voice's Spanish speaker, anything else by its English one (@hfos/core voices.ts).
 */
export function voiceModel(voice: PhoneVoice, language: string | null): string {
  const info = phoneVoiceInfo(voice);
  const speaker = voiceSpeaker(voice, language);
  return info.provider === 'deepgram' ? speaker : `rime-${info.model}:${speaker}`;
}

/** Deepgram's model for a voice: a Rime voice that reaches Deepgram asks for the Deepgram voice closest to it. */
export const deepgramModel = (voice: PhoneVoice, language: string | null): string =>
  voiceSpeaker(voiceFallback(voice), language);
