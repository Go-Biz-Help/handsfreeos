/**
 * Google Meet transcripts (HANDSFREEOS_MEETINGS_IMPLEMENTATION_PLAN.md, step 7). Reading them needs one Google
 * permission beyond the calendar's, asked for only when a person turns Meet transcripts on.
 */
export const GOOGLE_MEET_TRANSCRIPT_SCOPE =
  'https://www.googleapis.com/auth/meetings.space.readonly';

/** Whether a Google calendar connection's granted scopes include reading Meet transcripts. */
export const hasMeetTranscripts = (scopes: readonly string[]): boolean =>
  scopes.includes(GOOGLE_MEET_TRANSCRIPT_SCOPE);

/** The meeting code in a Meet link ("abc-defg-hij"), or null. */
export function meetCodeOf(url: string | null | undefined): string | null {
  const m = /^https:\/\/meet\.google\.com\/([a-z]{3,4}-[a-z]{4}-[a-z]{3,4})(?:[/?#]|$)/i.exec(
    url ?? '',
  );
  return m ? m[1]!.toLowerCase() : null;
}
