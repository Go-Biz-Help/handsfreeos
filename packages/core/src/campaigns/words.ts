/**
 * A campaign's state and its calls, in the words the Campaigns pages show on their badges. The web shows them, and the
 * Assistant says them the same way (list_campaigns, get_campaign). Browser-safe.
 */

/** A campaign's state on its badge. */
export const CAMPAIGN_STATUS_WORDS: Readonly<Record<string, string>> = {
  drafting: 'Writing texts',
  review: 'Ready to review',
  sending: 'Sending',
  paused: 'Paused',
  done: 'Done',
  cancelled: 'Stopped',
};

/** The same, for an email or call campaign where it reads differently. */
export const campaignStatusWords = (status: string, channel: string): string =>
  channel === 'email' && status === 'drafting'
    ? 'Writing the email'
    : channel === 'call' && status === 'drafting'
      ? 'Planning the calls'
      : channel === 'call' && status === 'sending'
        ? 'Calling'
        : (CAMPAIGN_STATUS_WORDS[status] ?? status);

/** A try nobody answered, while the next waits for tomorrow. */
const RETRY_WORDS: Readonly<Record<string, string>> = {
  no_answer: 'No answer, trying again',
  busy: 'Busy, trying again',
  voicemail: 'Voicemail, trying again',
};

/** How one person's campaign call went, as the badge on their row says it. */
export function campaignCallWords(
  call: { status: string; outcome: string | null } | null,
): { text: string; tone: 'ok' | 'gray' | 'pending' | 'danger' } | null {
  if (!call) return null;
  if (call.status === 'queued') {
    // Nobody answered a try: it rings again tomorrow.
    const missed = call.outcome ? RETRY_WORDS[call.outcome] : undefined;
    return { text: missed ?? 'Calling soon', tone: 'pending' };
  }
  if (call.status === 'calling') return { text: 'Calling now', tone: 'pending' };
  if (call.status === 'skipped' || call.status === 'cancelled')
    return { text: 'Not called', tone: 'gray' };
  switch (call.outcome) {
    case 'talked':
      return { text: 'Talked', tone: 'ok' };
    case 'voicemail':
      return { text: 'Voicemail', tone: 'gray' };
    case 'no_answer':
      return { text: 'No answer', tone: 'gray' };
    case 'busy':
      return { text: 'Busy', tone: 'gray' };
    default:
      return { text: 'Didn’t go through', tone: 'danger' };
  }
}
