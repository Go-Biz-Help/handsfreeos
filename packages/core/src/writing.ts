/**
 * How the AI writes for a person, wherever it writes: plain words a 10-year-old knows, short sentences, relaxed, and
 * never a long dash (Social Outreach's decisions 53 to 55, now core's so the main offer's builder writes the same way).
 * Browser-safe: the extension, the web, the phone and the worker read it.
 */

/** What every piece of writing for the person is told, whatever their voice. */
export const PLAIN_WRITING = [
  'Write the way people really talk: short, everyday words a 10-year-old knows, and short sentences. Relaxed and friendly, never stiff, formal or salesy.',
  'Never use a long dash (— or –) to join thoughts: use a comma, a period, or a new sentence.',
].join('\n');

/**
 * For anything written as a person or their business: nothing of the person themselves but what it's given, ever
 * (docs/outreach.md, decision 165; the owner, 14 Nov 2026, on a comment that made them one of a group they
 * aren't in: "im not hispanic lol"). Where what they said of themselves is given (About you), the fuller rule is
 * Social Outreach's (addons/outreach/about-owner.ts).
 */
export const OWNER_LIFE_UNKNOWN =
  'Of the owner as a person you know only what you’re given here: never make up where they’re from, their heritage, culture, faith, family, age, hobbies or past, and never say or hint that they share any of it with someone (no “same”, “me too”, “as a fellow …”) unless what you’re given says so. The owner’s business, its work and its customers are theirs to speak of, as you’re given them.';

/**
 * Writing with no long dashes: one between words becomes a comma, and one between numbers ("9–5") a hyphen. What
 * the AI writes is cleaned this way however it was asked.
 */
export function noDashes(text: string): string {
  if (!/[—–]/.test(text)) return text;
  return text
    .replace(/(\d)\s*[—–]\s*(\d)/g, '$1-$2')
    .replace(/[ \t]*[—–][ \t]*(?=\n|$)/g, '')
    .replace(/(^|\n)[ \t]*[—–][ \t]*/g, '$1')
    .replace(/[ \t]*[—–]+[ \t]*/g, ', ')
    .replace(/,\s*([,.!?;:])/g, '$1');
}
