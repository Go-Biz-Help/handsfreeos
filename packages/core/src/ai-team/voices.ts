/**
 * The AI teammate's phone voices, from every provider, in one list: what a business picks under AI teammate →
 * Phone → Its voice, and what the test console lets it try. The owner's picks (28 Oct 2026):
 *
 * - Deepgram's Aura 2: the four voices it started with, on the usual price line (`speech.voice.kchar`).
 * - Rime's Coda, its most natural voices, and Mist v3, its fastest: each model on its own price line, at 1.5× what
 *   it costs us like the rest of speech (`speech.voice.coda.kchar`, `speech.voice.mist.kchar`).
 *
 * Every voice has an English and a Spanish speaker, so a Spanish caller is answered in Spanish; any other language
 * is spoken in the English one. A Rime voice has a Deepgram voice that sounds closest to it (`fallback`): the call
 * switches to it when Rime isn't set up (no RIME_API_KEY on the worker) or has trouble, so a caller never hears
 * silence. Browser-safe: the web, the phone app and the worker all read it.
 */
import type { UsageKey } from '../money/rates';

export const VOICE_PROVIDERS = ['deepgram', 'rime'] as const;
export type VoiceProvider = (typeof VOICE_PROVIDERS)[number];

export const VOICE_PROVIDER_NAMES: Readonly<Record<VoiceProvider, string>> = {
  deepgram: 'Deepgram',
  rime: 'Rime',
};

/** The models that speak: Deepgram's Aura 2, and Rime's Coda and Mist v3. */
export const PHONE_VOICE_MODELS = ['aura-2', 'coda', 'mistv3'] as const;
export type PhoneVoiceModel = (typeof PHONE_VOICE_MODELS)[number];

/** Each model's group in a voice picker. */
export const PHONE_VOICE_MODEL_WORDS: Readonly<Record<PhoneVoiceModel, string>> = {
  'aura-2': 'Deepgram',
  coda: 'Rime Coda: most natural, costs a little more',
  mistv3: 'Rime Mist: fastest',
};

/** How it sounds on a call, in picker order. The first four are the Deepgram voices every business started with. */
export const PHONE_VOICES = [
  'warm',
  'bright',
  'calm',
  'deep',
  'rime_eyre',
  'rime_clementine',
  'rime_bancroft',
  'rime_masonry',
  'rime_cove',
  'rime_summit',
] as const;
export type PhoneVoice = (typeof PHONE_VOICES)[number];

/** The Deepgram voices: what a Rime voice falls back to. */
export type DeepgramVoice = Extract<PhoneVoice, 'warm' | 'bright' | 'calm' | 'deep'>;

/** The price line each model's speaking is charged on, per thousand characters. */
export type VoiceRateKey = Extract<
  UsageKey,
  'speech.voice.kchar' | 'speech.voice.coda.kchar' | 'speech.voice.mist.kchar'
>;

export const VOICE_RATE_KEYS: Readonly<Record<PhoneVoiceModel, VoiceRateKey>> = {
  'aura-2': 'speech.voice.kchar',
  coda: 'speech.voice.coda.kchar',
  mistv3: 'speech.voice.mist.kchar',
};

export interface PhoneVoiceInfo {
  readonly id: PhoneVoice;
  /** What the picker calls it: "Warm", "Eyre". */
  readonly name: string;
  /** Who it sounds like, in a few plain words. */
  readonly sound: string;
  readonly provider: VoiceProvider;
  readonly model: PhoneVoiceModel;
  /** The provider's own name for it in each language: a Deepgram model, or a Rime speaker. */
  readonly speakers: { readonly en: string; readonly es: string };
  /** The Deepgram voice it switches to when its own can't speak; a Deepgram voice is its own. */
  readonly fallback: DeepgramVoice;
}

const voice = (
  id: PhoneVoice,
  model: PhoneVoiceModel,
  name: string,
  sound: string,
  en: string,
  es: string,
  fallback: DeepgramVoice,
): PhoneVoiceInfo => ({
  id,
  name,
  sound,
  provider: model === 'aura-2' ? 'deepgram' : 'rime',
  model,
  speakers: { en, es },
  fallback,
});

export const PHONE_VOICE_INFO: Readonly<Record<PhoneVoice, PhoneVoiceInfo>> = {
  warm: voice(
    'warm',
    'aura-2',
    'Warm',
    'a woman, clear and friendly',
    'aura-2-thalia-en',
    'aura-2-celeste-es',
    'warm',
  ),
  bright: voice(
    'bright',
    'aura-2',
    'Bright',
    'a woman, casual and expressive',
    'aura-2-andromeda-en',
    'aura-2-estrella-es',
    'bright',
  ),
  calm: voice(
    'calm',
    'aura-2',
    'Calm',
    'a woman, caring and natural',
    'aura-2-helena-en',
    'aura-2-celeste-es',
    'calm',
  ),
  deep: voice(
    'deep',
    'aura-2',
    'Deep',
    'a man, confident and relaxed',
    'aura-2-apollo-en',
    'aura-2-nestor-es',
    'deep',
  ),
  rime_eyre: voice('rime_eyre', 'coda', 'Eyre', 'a woman, warm and calm', 'eyre', 'brisa', 'calm'),
  rime_clementine: voice(
    'rime_clementine',
    'coda',
    'Clementine',
    'a woman, bright and lively',
    'clementine',
    'amanecer',
    'bright',
  ),
  rime_bancroft: voice(
    'rime_bancroft',
    'coda',
    'Bancroft',
    'a man, composed and professional',
    'bancroft',
    'celestino',
    'deep',
  ),
  rime_masonry: voice(
    'rime_masonry',
    'coda',
    'Masonry',
    'a man, low and confident, Southern',
    'masonry',
    'atardecer',
    'deep',
  ),
  rime_cove: voice(
    'rime_cove',
    'mistv3',
    'Cove',
    'a woman, warm and caring',
    'cove',
    'isa',
    'warm',
  ),
  rime_summit: voice(
    'rime_summit',
    'mistv3',
    'Summit',
    'a man, friendly and professional',
    'summit',
    'pablo',
    'deep',
  ),
};

export const isPhoneVoice = (v: unknown): v is PhoneVoice =>
  typeof v === 'string' && (PHONE_VOICES as readonly string[]).includes(v);

export const phoneVoiceInfo = (v: PhoneVoice): PhoneVoiceInfo =>
  PHONE_VOICE_INFO[v] ?? PHONE_VOICE_INFO.warm;

/** Its name and how it sounds, as a picker lists it: "Eyre: a woman, warm and calm". */
export const phoneVoiceLine = (v: PhoneVoice): string => {
  const info = phoneVoiceInfo(v);
  return `${info.name}: ${info.sound}`;
};

/** The provider's name for it in the caller's language: a Spanish caller hears the Spanish speaker. */
export function voiceSpeaker(v: PhoneVoice, language: string | null): string {
  const { speakers } = phoneVoiceInfo(v);
  return language?.toLowerCase().startsWith('es') ? speakers.es : speakers.en;
}

/** The Deepgram voice it switches to when its own can't speak (itself for a Deepgram voice). */
export const voiceFallback = (v: PhoneVoice): DeepgramVoice => phoneVoiceInfo(v).fallback;

/** The price line its speaking is charged on. */
export const voiceRateKey = (v: PhoneVoice): VoiceRateKey =>
  VOICE_RATE_KEYS[phoneVoiceInfo(v).model];

/** The voices in picker order, grouped by model, for an <optgroup> or a sectioned list. */
export const PHONE_VOICE_GROUPS: readonly {
  readonly model: PhoneVoiceModel;
  readonly label: string;
  readonly voices: readonly PhoneVoice[];
}[] = PHONE_VOICE_MODELS.map((model) => ({
  model,
  label: PHONE_VOICE_MODEL_WORDS[model],
  voices: PHONE_VOICES.filter((v) => PHONE_VOICE_INFO[v].model === model),
}));

/** Which providers can speak right now: what the worker answers at GET /v1/speech/voices. */
export type VoiceReadiness = Readonly<Record<VoiceProvider, boolean>>;

/** Before the worker has said, Deepgram is taken as ready and Rime as not. */
export const VOICES_ASSUMED: VoiceReadiness = { deepgram: true, rime: false };

/** The worker's answer, read defensively. */
export function voiceReadinessOf(raw: unknown): VoiceReadiness {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const p =
    typeof o.providers === 'object' && o.providers !== null
      ? (o.providers as Record<string, unknown>)
      : {};
  return { deepgram: p.deepgram !== false, rime: p.rime === true };
}

/** A voice can be picked: its provider is set up. */
export const voiceReady = (v: PhoneVoice, ready: VoiceReadiness): boolean =>
  ready[phoneVoiceInfo(v).provider];

/** What "Hear it" says: the greeting it picks up with, or the usual one with its name (as the builder shows it). */
export function phoneVoiceSample(config: {
  readonly identity: { readonly name: string; readonly disclosure?: string };
  readonly phone: { readonly greeting: string };
}): string {
  const own = config.phone.greeting.trim();
  if (own) return own;
  const name = config.identity.name;
  return config.identity.disclosure === 'first_message'
    ? `Thanks for calling. This is ${name}, the AI assistant. How can I help?`
    : `Thanks for calling, this is ${name}. How can I help?`;
}

/** What Hear it says for a settings document as the API sends it, with `name` when it has none. */
export function phoneVoiceSampleOf(config: unknown, name: string): string {
  const c = config as {
    identity?: { name?: unknown; disclosure?: unknown };
    phone?: { greeting?: unknown };
  } | null;
  const own = c?.identity?.name;
  const disclosure = c?.identity?.disclosure;
  const greeting = c?.phone?.greeting;
  return phoneVoiceSample({
    identity: {
      name: typeof own === 'string' && own.trim() ? own.trim() : name,
      disclosure: typeof disclosure === 'string' ? disclosure : '',
    },
    phone: { greeting: typeof greeting === 'string' ? greeting : '' },
  });
}

/** A settings document with another phone voice, for a test that tries it before it's picked. */
export function withPhoneVoice(config: unknown, v: PhoneVoice | null): unknown {
  if (!v || typeof config !== 'object' || config === null) return config;
  const c = config as Record<string, unknown>;
  const phone =
    typeof c.phone === 'object' && c.phone !== null ? (c.phone as Record<string, unknown>) : {};
  return { ...c, phone: { ...phone, voice: v } };
}

/** The voice a settings document picked, or null when it has none it knows. */
export function phoneVoiceOf(config: unknown): PhoneVoice | null {
  const v = (config as { phone?: { voice?: unknown } } | null)?.phone?.voice;
  return isPhoneVoice(v) ? v : null;
}

export const PHONE_VOICE_PICK_WORDS = {
  label: 'Voice',
  hear: 'Hear it',
  hearing: 'Playing…',
  use: 'Use this voice',
  /** Beside the saved voice in the phone's list. */
  savedTag: 'its voice',
  notReady: 'not ready yet',
  /** Under a Rime voice picked while Rime isn't set up. */
  notReadyNote:
    'Rime voices aren’t set up for HandsFreeOS yet. Until they are, calls use the closest Deepgram voice.',
  /** Hear it, when a Rime voice couldn't speak and its Deepgram voice said it instead. */
  saidInstead: (asked: string, spoken: string) =>
    `Rime couldn’t say it in ${asked} just now, so you heard ${spoken}, the closest Deepgram voice.`,
  /** After "Use this voice": the builder saves it as it saves any change, and elsewhere it's saved straight away. */
  saved: (name: string) => `${name} is its phone voice now.`,
  /** The picker on the test console, while a test call tries another voice. */
  trying: (name: string) => `Trying ${name}. Your settings still say another voice.`,
} as const;
