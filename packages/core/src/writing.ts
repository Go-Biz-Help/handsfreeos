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
