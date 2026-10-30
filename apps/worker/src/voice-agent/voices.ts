/**
 * Every provider's voices behind one SpeechServices (@hfos/core voices.ts has the list): Deepgram listens and
 * speaks its own voices, and Rime speaks its own when the worker has RIME_API_KEY. Without the key a Rime voice
 * speaks in the Deepgram voice closest to it, and `voices()` says Rime isn't ready, so the pickers say so too.
 *
 * Trouble is the caller's job, not this file's: a Rime voice that fails on a call switches the rest of the call to
 * its Deepgram voice (session.ts), and a clip that fails is said again in it (http/speech.ts). Both tell support
 * through `trouble` (voice-trouble.ts).
 */
import { phoneVoiceInfo, voiceFallback, type PhoneVoice } from '@hfos/core/server';
import type { SpeechServices, VoiceServices } from './speech';

export function withVoices(o: {
  /** Listens, and speaks Deepgram's voices (or the stand-in, which speaks every voice). */
  readonly base: SpeechServices;
  /** Speaks Rime's voices; null without RIME_API_KEY. */
  readonly rime: VoiceServices | null;
  readonly trouble?: SpeechServices['trouble'];
}): SpeechServices {
  const { base, rime } = o;
  /** Who says it, and in which voice. */
  const route = (voice: PhoneVoice): { readonly by: VoiceServices; readonly voice: PhoneVoice } =>
    phoneVoiceInfo(voice).provider === 'rime'
      ? rime
        ? { by: rime, voice }
        : { by: base, voice: voiceFallback(voice) }
      : { by: base, voice };
  return {
    name: base.name,
    listen: (handlers, options) => base.listen(handlers, options),
    transcribe: (audio, options) => base.transcribe(audio, options),
    speak(text, options) {
      const r = route(options.voice);
      return r.by.speak(text, { ...options, voice: r.voice });
    },
    ...(base.openVoice || rime?.openVoice
      ? {
          openVoice(options) {
            const r = route(options.voice);
            if (!r.by.openVoice) return Promise.reject(new Error('This voice has no open line.'));
            return r.by.openVoice({ ...options, voice: r.voice });
          },
        }
      : {}),
    voiceClip(text, options) {
      const r = route(options.voice);
      return r.by.voiceClip(text, { ...options, voice: r.voice });
    },
    voices: () => ({ deepgram: true, rime: !!rime }),
    trouble(from, to, where, error) {
      try {
        o.trouble?.(from, to, where, error);
      } catch {
        // Telling support never gets in the way of the call.
      }
    },
  };
}
