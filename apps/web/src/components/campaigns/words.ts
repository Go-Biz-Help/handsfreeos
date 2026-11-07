/** The words the campaigns pages use for a campaign's state and for why someone was left out. */
import { CAMPAIGN_STATUS_WORDS, campaignCallWords, campaignStatusWords } from '@hfos/core';

// A campaign's state and its calls are core's, so the Assistant says them as these pages do.
export { CAMPAIGN_STATUS_WORDS };
export const statusWords = campaignStatusWords;
export const callWords = campaignCallWords;

/** How a campaign reaches people, on its badge. */
export const CHANNEL_WORDS: Record<string, string> = {
  sms: 'Texts',
  email: 'Email',
  call: 'Calls',
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
  no_email: 'No email address',
  unsubscribed: 'Unsubscribed from your emails',
  email_stopped: 'Email to them bounced or was marked as spam',
  emailed_recently: 'Sent another campaign email in the last 14 days',
  no_call_consent: 'Hasn’t agreed to calls in writing',
  called_recently: 'Called by another campaign in the last 14 days',
  not_business_landline: 'No yes to calls, and not a business landline',
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
  ai_calls_not_ready:
    'Paused: your AI teammate isn’t taking calls. Turn it on with its phone on (AI team → Phone), then resume.',
};

export const skipWords = (reason: string | null): string =>
  (reason && SKIP_REASON_WORDS[reason]) || 'Left out';

export const people = (n: number): string => `${n} ${n === 1 ? 'person' : 'people'}`;
