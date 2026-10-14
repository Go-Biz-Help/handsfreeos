/**
 * How the AI writes for the person (docs/outreach.md, "How the AI writes"): plain words a 10-year-old knows, short
 * sentences, relaxed like a text to someone they know, and never a long dash. Each person picks their own voice on the
 * Settings tab (`AutomationSettings.voice`): short forms like "u", text acronyms like "lol", emoji, and whether a message
 * goes as a few short texts, a few seconds apart, the way people text. A chat that's been quiet a few days or more opens
 * with a greeting that fits the gap. Browser-safe: the extension, the web, the phone and the worker read it.
 */
import { z } from 'zod';

// Core's since the main offer's builder writes the same way (packages/core/src/writing.ts).
export { noDashes, PLAIN_WRITING } from '../../writing';

export const Voice = z.object({
  /** Short forms like u, ur, thx and pls. */
  shorthand: z.boolean().default(false),
  /** Text acronyms like lol, haha, btw and tbh. */
  acronyms: z.boolean().default(false),
  /** An emoji now and then. */
  emoji: z.boolean().default(false),
  /** A message goes as a few short texts, a few seconds apart, rather than one long one. */
  split: z.boolean().default(true),
});
export type Voice = z.output<typeof Voice>;

export const VOICE_DEFAULTS: Voice = {
  shorthand: false,
  acronyms: false,
  emoji: false,
  split: true,
};

/** The Settings tab's words for each choice, on the web and the phone. */
export const VOICE_WORDS = {
  title: 'How the AI writes for you',
  note: 'It always writes in plain, everyday words and short sentences, relaxed like a text to a friend, with no long dashes. Pick what sounds like you.',
  shorthand: 'Short forms like “u” and “thx”',
  acronyms: 'Text acronyms like “lol” and “btw”',
  emoji: 'An emoji now and then',
  split: 'Send a message as a few short texts, a few seconds apart',
} as const satisfies Record<'title' | 'note' | keyof Voice, string>;

/** A made-up message in a voice, as the texts it goes as, for the Settings tab to show beside the choices. */
export function voiceSample(voice: Voice): string[] {
  const greeting = `Hey Sam, it’s been a while${voice.acronyms ? ' lol' : '!'}${voice.emoji ? ' 😊' : ''}`;
  const point = voice.shorthand
    ? 'How r u doing? Saw ur new truck, looks great. Hope work’s good!'
    : 'How are you doing? Saw your new truck, looks great. Hope work’s good!';
  return voice.split ? [greeting, point] : [`${greeting} ${point}`];
}

/** What a message or comment is told about the person's own voice. `texts` when it can go as several texts. */
export function voiceLines(voice: Voice, texts: boolean): string {
  return [
    voice.shorthand
      ? 'Text like a friend would: short forms like u, ur, thx, pls and gonna are good.'
      : 'Spell words out (you, your, thanks): no text short forms.',
    voice.acronyms
      ? 'A text acronym like lol, haha, btw or tbh is fine now and then, where it fits.'
      : 'No text acronyms like lol or btw.',
    voice.emoji ? 'An emoji fits now and then: one at most.' : 'No emoji.',
    texts && voice.split
      ? `Write it the way people text: 1 to ${PARTS_MOST} short texts, with a blank line between texts. Each text is one thought, like a greeting, then the point.`
      : 'Write it as one message, with no blank lines.',
  ].join('\n');
}

const DAY = 86_400_000;
/** A chat quiet this many days or more opens with a greeting. */
export const GAP_GREETING_DAYS = 3;

/** How long since a moment, in words, when it's a few days or more: "4 days", "about a week", "3 months". */
export function gapWords(at: Date | string | null, now: number): string | null {
  if (at === null) return null;
  const days = Math.floor((now - new Date(at).getTime()) / DAY);
  if (!Number.isFinite(days) || days < GAP_GREETING_DAYS) return null;
  if (days < 7) return `${days} days`;
  if (days < 14) return 'about a week';
  if (days < 56) return `${Math.round(days / 7)} weeks`;
  if (days < 365) return `${Math.max(2, Math.round(days / 30))} months`;
  return 'over a year';
}

/**
 * What a message is told when the chat's been quiet a while: open with a greeting that fits the gap, as its own text
 * when the person sends a few. Null when the last message either way was in the last few days.
 */
export function gapLine(
  lastAt: Date | string | null,
  now: number,
  opts: { readonly split: boolean; readonly theyWroteLast: boolean },
): string | null {
  const gap = gapWords(lastAt, now);
  if (!gap) return null;
  return [
    `The last message between you was ${gap} ago. Don’t jump straight back in: open with a short, natural greeting that fits that gap, the way a friend would after ${gap}, then get to the point.`,
    opts.theyWroteLast ? 'They wrote last, so a quick sorry for the slow reply fits too.' : null,
    opts.split ? 'Make the greeting its own text, first.' : null,
  ]
    .filter(Boolean)
    .join(' ');
}

/** The most texts one message goes as. */
export const PARTS_MOST = 3;

/**
 * The texts a message goes as: each part between blank lines, when the person sends a few (`split`), with any past
 * the most joined to the last; else the whole message as one.
 */
export function messageParts(text: string, split: boolean): string[] {
  const whole = text.trim();
  if (!whole) return [];
  if (!split) return [whole];
  const parts = whole
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length <= PARTS_MOST) return parts;
  return [...parts.slice(0, PARTS_MOST - 1), parts.slice(PARTS_MOST - 1).join('\n\n')];
}

/** A message as the AI's texts make it: blank lines between them, each tidied, no more than the most. */
export function joinedParts(text: string, split: boolean): string {
  return split ? messageParts(text, true).join('\n\n') : text.trim().replace(/\n[ \t]*\n+/g, '\n');
}

/**
 * How long to wait before the next text: a few seconds, as long as typing it takes someone, between 2 and 8 seconds.
 * `random` is 0 to 1.
 */
export function partPauseMs(next: string, random: number): number {
  const typing = next.length * 60;
  return Math.round(Math.min(8_000, Math.max(2_000, typing)) * (0.85 + random * 0.3));
}
