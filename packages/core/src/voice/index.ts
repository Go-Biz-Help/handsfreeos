/**
 * Talking out loud: the Assistant's voice mode, and the AI teammate's test console on a call. The web and the
 * phone app record what the person says, the worker turns it into words, and the answer comes back as speech in
 * the same voices the AI teammate uses on real calls (Deepgram Nova-3 and Aura 2, the key the live calls use).
 * Browser-safe: the web, the phone app and the worker all read it.
 *
 *   POST {worker}/v1/speech/hear?workspaceId=<uuid>
 *   Authorization: Bearer <the session's access token>. Needs assistant.use or ai_team.manage.
 *   Content-Type: the recording's own (audio/webm, audio/mp4, audio/m4a, audio/ogg, audio/wav…)
 *   Body: the recording itself, at most SPEECH_CLIP_MAX_BYTES.
 *     → 200 { text, language }   text is '' when nothing was said
 *
 *   POST {worker}/v1/speech/say
 *   Body (JSON), SpeechSayInput: { workspaceId, text, voice, language }
 *     → 200 audio/mpeg (the stand-in answers audio/wav)
 *
 *   A refusal is the API's JSON error, { error: { code, message, rule } }: 401 or 403, 400 for an empty or
 *   unreadable recording, 413 when it's too long, and 503 with rule `speech_not_configured` when the worker has no
 *   one to listen and speak (production without a Deepgram key).
 */
import { z } from 'zod';
import { PHONE_VOICES, type PhoneVoice } from '../ai-team/config';

/** The longest recording the worker takes: about a minute of talking at the phone's quality. */
export const SPEECH_CLIP_MAX_BYTES = 4 * 1024 * 1024;
/** How long one turn may go on before it's sent anyway. */
export const SPEECH_TURN_MAX_MS = 60_000;
/** How much one clip may say; longer answers are said a piece at a time. */
export const SPEECH_SAY_MAX = 1000;
/** How much of an Assistant answer is read out; the rest is on the screen. */
export const SPOKEN_ANSWER_MAX = 700;

/** The Assistant's own voice, so it doesn't sound like the business's AI teammate. */
export const ASSISTANT_VOICE: PhoneVoice = 'calm';

export const SpeechSayInput = z.object({
  workspaceId: z.uuid(),
  text: z.string().trim().min(1).max(SPEECH_SAY_MAX),
  /** Which voice; null is the AI teammate's own phone voice (its saved settings). */
  voice: z.enum(PHONE_VOICES).nullable().default(null),
  /** The language to speak in ('en', 'es'…); a Spanish voice speaks Spanish. */
  language: z.string().trim().max(12).nullable().default(null),
});
export type SpeechSayInput = z.infer<typeof SpeechSayInput>;
export type SpeechSayBody = z.input<typeof SpeechSayInput>;

/** What the worker heard. */
export interface HeardSpeech {
  readonly text: string;
  readonly language: string | null;
}

/** The worker's answer to a recording, read defensively. */
export function heardSpeechOf(raw: unknown): HeardSpeech {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    text: typeof o.text === 'string' ? o.text.trim() : '',
    language: typeof o.language === 'string' && o.language ? o.language : null,
  };
}

/** A recording's content type without its parameters, as the worker reads it ("audio/webm;codecs=opus"). */
export function audioTypeOf(contentType: string | null | undefined): string | null {
  const bare = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  return /^audio\/[a-z0-9.+-]+$/.test(bare) ? bare : null;
}

// ---- Words to say ----

const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;
const ENDS_A_THOUGHT = /[.!?…:;]$/;

/**
 * Plain words to say out loud: markdown's marks, links' addresses, tables' pipes and emoji left out, and each
 * line or list item ended so the voice pauses between them.
 */
export function speakable(text: string): string {
  const lines: string[] = [];
  for (const raw of text.replace(/```[\s\S]*?```/g, ' ').split('\n')) {
    let line = raw.trim();
    if (!line) continue;
    // A table: its dividing row says nothing, and a row's cells are read with commas between them.
    if (/^\|?[\s:|-]+\|?$/.test(line) && line.includes('-')) continue;
    if (line.startsWith('|'))
      line = line
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean)
        .join(', ');
    line = line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^>\s*/, '')
      .replace(/^[-•*]\s+/, '')
      .replace(/^(\d+)[.)]\s+/, '$1. ')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,!?;:]|$)/g, '$1$2')
      .replace(/`([^`]*)`/g, '$1')
      .replace(EMOJI, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!line) continue;
    lines.push(ENDS_A_THOUGHT.test(line) ? line : `${line}.`);
  }
  return lines.join(' ');
}

/** Sentence ends: a stop, a question or an exclamation followed by a space, or the end of a line. */
const SENTENCE_END = /([.!?…]+["”’)]*)\s+|\n+/g;

/**
 * Splits text still arriving into the whole sentences so far and the rest, which waits for more. A voice reads each
 * sentence as soon as it's whole, so the first words play while the rest is still being written.
 */
export function takeSentences(buffer: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let from = 0;
  for (const m of buffer.matchAll(SENTENCE_END)) {
    const end = m.index + (m[1]?.length ?? 0);
    const sentence = buffer.slice(from, end).trim();
    if (sentence) sentences.push(sentence);
    from = m.index + m[0].length;
  }
  return { sentences, rest: buffer.slice(from) };
}

/**
 * Text split into pieces to say one after another: whole sentences, joined up to `max` characters, the first kept
 * short so the voice starts soon. A sentence longer than `max` is split at a comma, else at a space.
 */
export function speechChunks(text: string, max = 280): string[] {
  const { sentences, rest } = takeSentences(`${text}\n`);
  const pieces = [...sentences, ...(rest.trim() ? [rest.trim()] : [])].flatMap((s) =>
    splitLong(s, max),
  );
  const out: string[] = [];
  for (const piece of pieces) {
    const last = out[out.length - 1];
    if (last !== undefined && out.length > 1 && last.length + piece.length + 1 <= max)
      out[out.length - 1] = `${last} ${piece}`;
    else out.push(piece);
  }
  return out;
}

function splitLong(sentence: string, max: number): string[] {
  const out: string[] = [];
  let left = sentence.trim();
  while (left.length > max) {
    const window = left.slice(0, max);
    const comma = window.lastIndexOf(', ');
    const space = window.lastIndexOf(' ');
    const at = comma > max / 3 ? comma + 1 : space > max / 3 ? space : max;
    out.push(left.slice(0, at).trim());
    left = left.slice(at).trim();
  }
  if (left) out.push(left);
  return out;
}

/** At most `max` characters of an answer to read out, ending on a whole sentence, and whether any was left. */
export function spokenPart(text: string, max = SPOKEN_ANSWER_MAX): { text: string; cut: boolean } {
  const words = speakable(text);
  if (words.length <= max) return { text: words, cut: false };
  const { sentences } = takeSentences(`${words}\n`);
  let out = '';
  for (const s of sentences) {
    if (out && out.length + s.length + 1 > max) break;
    out = out ? `${out} ${s}` : s;
  }
  return { text: out.length > max ? splitLong(out, max)[0]! : out, cut: true };
}

// ---- Reading an answer out as it arrives ----

/** How much of an answer has been read out so far. */
export interface SpokenAnswer {
  /** Characters of the answer's text already taken. */
  readonly taken: number;
  /** Characters said. */
  readonly said: number;
  /** It got too long, and the rest is left for the screen. */
  readonly cut: boolean;
}

export const SPOKEN_START: SpokenAnswer = { taken: 0, said: 0, cut: false };

/**
 * What to say next of an answer still arriving: its whole sentences so far, or once it's finished, the rest. It
 * stops at `max` characters on a whole sentence; `cut` then says the rest is on the screen.
 */
export function nextSpoken(
  state: SpokenAnswer,
  text: string,
  finished: boolean,
  max = SPOKEN_ANSWER_MAX,
): { readonly say: string[]; readonly state: SpokenAnswer } {
  const fresh = text.slice(state.taken);
  const { sentences, rest } = takeSentences(finished ? `${fresh}\n` : fresh);
  let said = state.said;
  let cut = state.cut;
  const say: string[] = [];
  for (const sentence of sentences) {
    const words = speakable(sentence);
    if (!words || cut) continue;
    if (said + words.length > max) {
      cut = true;
      // One sentence longer than the whole allowance: its first part, rather than nothing.
      if (said === 0) {
        const part = spokenPart(words, max).text;
        say.push(part);
        said += part.length;
      }
      continue;
    }
    say.push(words);
    said += words.length + 1;
  }
  return { say, state: { taken: text.length - rest.length, said, cut } };
}

/**
 * What's said once an answer is finished: that there's more on the screen, why it stopped short, and, when one
 * card waits for an OK, the question a yes or a no answers.
 */
export function closingSpoken(input: {
  readonly state: SpokenAnswer;
  /** Why the answer stopped short, for people; null when it didn't. */
  readonly notice: string | null;
  /** The cards waiting for an OK (a card that needs a reason picked says so). */
  readonly waiting: readonly { readonly title: string; readonly needsReason: boolean }[];
}): string[] {
  const out: string[] = [];
  if (input.state.cut) out.push(VOICE_WORDS.more);
  if (input.notice) out.push(input.notice);
  const [only, ...others] = input.waiting;
  if (only && others.length) out.push(VOICE_WORDS.manyCards);
  else if (only?.needsReason) out.push(VOICE_WORDS.askOkReason);
  else if (only)
    out.push(
      input.state.said ? VOICE_WORDS.askOk : `${speakable(only.title)} ${VOICE_WORDS.askOk}`,
    );
  return out;
}

// ---- Yes and no, said out loud ----

const YES = new Set([
  'yes',
  'yeah',
  'yea',
  'yep',
  'yup',
  'sure',
  'ok',
  'okay',
  'go',
  'confirm',
  'confirmed',
  'approve',
  'approved',
  'correct',
  'right',
  'absolutely',
  'perfect',
  'good',
  'great',
  'fine',
  'send',
  'book',
  'do',
  'sí',
  'si',
  'claro',
  'dale',
  'vale',
]);
const YES_FILLER = new Set([
  'ahead',
  'it',
  'that',
  "that's",
  'thats',
  'is',
  'please',
  'thanks',
  'thank',
  'you',
  'sounds',
  'looks',
  'just',
  'and',
  'go',
  'por',
  'favor',
]);
const NO = new Set([
  'no',
  'nope',
  'nah',
  'cancel',
  "don't",
  'dont',
  'not',
  'stop',
  'never',
  'skip',
  'hold',
  'wait',
]);
const NO_FILLER = new Set([
  'it',
  'that',
  'do',
  'mind',
  'thanks',
  'thank',
  'you',
  'please',
  'now',
  'off',
  'on',
  'yet',
  'just',
  'gracias',
]);

/**
 * A spoken answer to "Should I go ahead?": yes, no, or neither. Only a plain yes or a plain no counts ("yes
 * please", "go ahead", "no thanks", "don't do that"): anything more ("yes, but make it 3") is a new question, and
 * the card is left for the buttons.
 */
export function spokenDecision(said: string): 'yes' | 'no' | null {
  const words = said
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length || words.length > 7) return null;
  const all = (core: Set<string>, filler: Set<string>) =>
    words.some((w) => core.has(w)) && words.every((w) => core.has(w) || filler.has(w));
  const yes = all(YES, YES_FILLER);
  const no = all(NO, NO_FILLER);
  return yes === no ? null : yes ? 'yes' : 'no';
}

// ---- When they've finished talking ----

export interface TurnDetectorOptions {
  /** Quieter than this (dBFS) is never talking, however quiet the room. */
  readonly floorDb?: number;
  /** How far above the room's own noise talking is. */
  readonly marginDb?: number;
  /** Louder than this (dBFS) is talking before the room's noise is known (someone already mid-word). */
  readonly talkingDb?: number;
  /** The room's noise is the quietest moment in this long a window. */
  readonly windowMs?: number;
  /** Loud for this long counts as talking (a cough or a click doesn't). */
  readonly speechMs?: number;
  /** Quiet for this long after talking ends the turn. */
  readonly silenceMs?: number;
  /** Nothing said for this long: give up listening. */
  readonly waitMs?: number;
  /** A turn this long is sent anyway. */
  readonly maxMs?: number;
}

/** waiting: nothing said yet; talking: they're saying something; done: they finished; nothing: they never spoke. */
export type TurnState = 'waiting' | 'talking' | 'done' | 'nothing';

export interface TurnDetector {
  /** One reading of how loud the microphone is (dBFS, 0 is the loudest) at `atMs`. */
  feed(levelDb: number, atMs: number): TurnState;
  /** 0 to 1: how far above the room's noise the last reading was, for a meter. */
  readonly level: number;
  readonly heard: boolean;
}

/**
 * Tells from the microphone's loudness when someone has started talking and when they've finished, so voice mode
 * sends what they said without a button. The room's own noise is the quietest moment of the last second and a
 * half: talking always has gaps between words, and a fan or a truck outside doesn't, so neither counts as talking.
 * Until that much has been heard, anything plainly as loud as talking is talking, so someone who starts the moment
 * it listens, or after complete silence, isn't missed. The web reads loudness from the microphone's samples, the phone from the recorder's
 * meter; both are dBFS.
 */
export function createTurnDetector(options: TurnDetectorOptions = {}): TurnDetector {
  const floorDb = options.floorDb ?? -52;
  const marginDb = options.marginDb ?? 12;
  const talkingDb = options.talkingDb ?? -30;
  const windowMs = options.windowMs ?? 1500;
  const speechMs = options.speechMs ?? 180;
  const silenceMs = options.silenceMs ?? 1100;
  const waitMs = options.waitMs ?? 10_000;
  const maxMs = options.maxMs ?? SPEECH_TURN_MAX_MS;
  let start: number | null = null;
  /** When the readings in `recent` began, unbroken by a whole window of nothing. */
  let knownFrom: number | null = null;
  const recent: { at: number; db: number }[] = [];
  let loudSince: number | null = null;
  let lastLoud = 0;
  let heard = false;
  let level = 0;
  return {
    get level() {
      return level;
    },
    get heard() {
      return heard;
    },
    feed(raw, at) {
      const db = Number.isFinite(raw) ? Math.min(0, Math.max(-120, raw)) : -120;
      if (start === null) start = at;
      while (recent.length && at - recent[0]!.at > windowMs) recent.shift();
      // A reading of nothing at all is a meter with nothing to say yet (Android's first), not a quiet room.
      if (db > -100) {
        // Nothing heard for a whole window (a meter that wasn't ready, or a microphone gone completely
        // silent) leaves the room unknown again, as when it started listening. Otherwise the first words
        // after it would be the room's noise, and talking that rises and falls less than the margin would
        // never count.
        if (!recent.length) knownFrom = at;
        recent.push({ at, db });
      }
      const noise = recent.length ? Math.min(...recent.map((r) => r.db)) : floorDb - marginDb;
      const young = knownFrom === null || at - knownFrom < windowMs;
      const loud = db >= Math.max(floorDb, noise + marginDb) || (young && db >= talkingDb);
      level = Math.min(1, Math.max(0, (db - Math.max(noise, floorDb - marginDb)) / 30));
      if (loud) {
        if (loudSince === null || at - lastLoud > 400) loudSince = at;
        lastLoud = at;
        if (at - loudSince >= speechMs) heard = true;
      }
      if (heard && at - lastLoud >= silenceMs) return 'done';
      if (at - start >= maxMs) return heard ? 'done' : 'nothing';
      if (!heard && at - start >= waitMs) return 'nothing';
      return heard ? 'talking' : 'waiting';
    },
  };
}

/** The loudness of some samples (−1 to 1), in dBFS. */
export function levelDb(samples: ArrayLike<number>): number {
  if (!samples.length) return -120;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  const rms = Math.sqrt(sum / samples.length);
  return rms > 0 ? 20 * Math.log10(rms) : -120;
}

// ---- The words voice mode says on screen, the same on the web and the phone ----

export const VOICE_WORDS = {
  talk: 'Talk',
  talkTitle: 'Talk out loud',
  stopTalking: 'Stop talking',
  listening: 'Listening…',
  hearing: 'Getting your words…',
  thinking: 'Thinking…',
  speaking: 'Speaking…',
  paused: 'Tap the mic to talk',
  interrupt: 'Tap to talk over it',
  noMic: 'Let HandsFreeOS use the microphone to talk out loud.',
  noMicWeb: 'Your browser blocked the microphone. Allow it for this site, then try again.',
  unsupported: 'Talking out loud doesn’t work in this browser.',
  notConfigured: 'Talking out loud isn’t set up yet.',
  heardNothing: 'Didn’t catch that. Tap the mic to try again.',
  failed: 'Couldn’t hear that. Try again.',
  needsSignal: 'Talking out loud needs signal.',
  /** Asked after an answer whose card waits for an OK. */
  askOk: 'Should I go ahead? Say yes or no.',
  askOkReason: 'Pick a reason on the card, then confirm it.',
  manyCards: 'Check the cards on the screen, or ask me something else.',
  more: 'There’s more on the screen.',
  done: 'Done.',
  cancelled: 'OK, I won’t.',
} as const;
