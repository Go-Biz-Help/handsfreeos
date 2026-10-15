/**
 * Automations' "Learn from corrections": where a lesson from a correction can go against what the AI already knows,
 * and finding and swapping the words that say otherwise. The worker checks the AI's claim against the words really
 * there; teammate_lesson.apply swaps them when a person picks the new one. Browser-safe.
 */

/**
 * The profile's plain-text fields a lesson can go against, a knowledge item's text, and one of the AI teammate's
 * instructions (20261027006500).
 */
export const LESSON_PLACES = [
  'description',
  'serviceArea',
  'hours',
  'policies',
  'tone',
  'signature',
  'item',
  'instruction',
] as const;
export type LessonPlace = (typeof LESSON_PLACES)[number];
export type LessonProfilePlace = Exclude<LessonPlace, 'item' | 'instruction'>;

/** What the business calls each place on "What the AI knows". */
export const LESSON_PLACE_NAMES: Readonly<Record<LessonProfilePlace, string>> = {
  description: 'What you do',
  serviceArea: 'Service area',
  hours: 'Hours',
  policies: 'Policies',
  tone: 'Tone of voice',
  signature: 'Signature',
};

/** A lesson that goes against what the AI knows: the words there now, and what they'd become. */
export interface LessonConflict {
  readonly place: LessonPlace;
  /** The knowledge item or the instruction, when the words are in one. */
  readonly itemId: string | null;
  /** Where, as the business would say it: "Hours", the item's title, or "An instruction". */
  readonly where: string;
  /** The words there now that the correction goes against, as they are written. */
  readonly existing: string;
  /** What they'd say instead, so they agree with the correction (empty takes them out). */
  readonly replacement: string;
  /** The clash in plain words, for the card. */
  readonly explain: string;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `words` as a pattern that ignores case, spacing and curly or straight quotes. */
function patternOf(words: string): RegExp | null {
  const parts = words
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => escape(w).replace(/['’‘]/g, "['’‘]").replace(/["“”]/g, '["“”]'));
  return parts.length ? new RegExp(parts.join('\\s+'), 'i') : null;
}

/** Whether `text` still says `words` (case and spacing aside). */
export function saysWords(text: string, words: string): boolean {
  const p = patternOf(words);
  return !!p && p.test(text);
}

/** `text` with the first place it says `words` swapped for `replacement`, or null when it no longer says them. */
export function swapWords(text: string, words: string, replacement: string): string | null {
  const p = patternOf(words);
  if (!p) return null;
  const m = p.exec(text);
  if (!m) return null;
  const before = text.slice(0, m.index);
  const put = replacement.trim();
  const lines = `${before}${put}${text.slice(m.index + m[0].length)}`.split('\n');
  if (!put) {
    // Taking words out can leave a line with only its bullet, or a doubled space, behind.
    const at = before.split('\n').length - 1;
    const line = lines[at]!.replace(/[ \t]{2,}/g, ' ')
      .replace(/ ([.,;:!?])/g, '$1')
      .replace(/[,;:]+([.!?])/g, '$1')
      .trimEnd();
    if (/^[\s\-•*.,;:]*$/.test(line)) lines.splice(at, 1);
    else lines[at] = line;
  }
  return lines.join('\n').trim();
}
