/** The words the campaigns pages use for a campaign's state and for why someone was left out. */
export const CAMPAIGN_STATUS_WORDS: Record<string, string> = {
  drafting: 'Writing texts',
  review: 'Ready to review',
  sending: 'Sending',
  paused: 'Paused',
  done: 'Done',
  cancelled: 'Stopped',
};

/** The same, for an email campaign where it reads differently. */
export const statusWords = (status: string, channel: string): string =>
  channel === 'email' && status === 'drafting'
    ? 'Writing the email'
    : (CAMPAIGN_STATUS_WORDS[status] ?? status);

export const CAMPAIGN_STATUS_BADGE: Record<string, 'accent' | 'pending' | 'ok' | 'gray'> = {
  drafting: 'gray',
  review: 'pending',
  sending: 'accent',
  paused: 'pending',
  done: 'ok',
  cancelled: 'gray',
};

export const SKIP_REASON_WORDS: Record<string, string> = {
  no_phone: 'No mobile number',
  not_opted_in: 'Hasn’t agreed to texts',
  texted_recently: 'Texted in the last 14 days',
  in_conversation: 'In a conversation or has an open card',
  booked_soon: 'Booked in the next 30 days',
  no_draft: 'The AI couldn’t write one',
  not_sent: 'Not sent',
  no_email: 'No email address',
  unsubscribed: 'Unsubscribed from your emails',
  email_stopped: 'Email to them bounced or was marked as spam',
  emailed_recently: 'Sent another campaign email in the last 14 days',
};

/** Why HandsFreeOS paused a campaign, and what to do about it. */
export const PAUSED_REASON_WORDS: Record<string, string> = {
  email_campaigns_not_ready:
    'Paused: email campaigns aren’t set up on HandsFreeOS yet. Resume once support says they’re on.',
  no_postal_address:
    'Paused: every campaign email has to show your business address. Add it in Settings → Payments, then resume.',
  no_email_address:
    'Paused: this business has no address to send email from. Set one up in Settings → Email, then resume.',
  email_domain_unverified:
    'Paused: your email domain isn’t verified yet. Finish it in Settings → Email, then resume.',
  texting_not_ready:
    'Paused: texting isn’t set up yet. Finish it in Settings → Texting & calls, then resume.',
  messaging_not_ready:
    'Paused: texting isn’t set up yet. Finish it in Settings → Texting & calls, then resume.',
  no_number: 'Paused: this business has no phone number to text from. Add one, then resume.',
};

export const skipWords = (reason: string | null): string =>
  (reason && SKIP_REASON_WORDS[reason]) || 'Left out';

export const people = (n: number): string => `${n} ${n === 1 ? 'person' : 'people'}`;
