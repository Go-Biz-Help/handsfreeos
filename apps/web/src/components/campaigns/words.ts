/** The words the campaigns pages use for a campaign's state and for why someone was left out. */
export const CAMPAIGN_STATUS_WORDS: Record<string, string> = {
  drafting: 'Writing texts',
  review: 'Ready to review',
  sending: 'Sending',
  paused: 'Paused',
  done: 'Done',
  cancelled: 'Stopped',
};

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
};

export const skipWords = (reason: string | null): string =>
  (reason && SKIP_REASON_WORDS[reason]) || 'Left out';

export const people = (n: number): string => `${n} ${n === 1 ? 'person' : 'people'}`;
