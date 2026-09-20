/**
 * What a customer is actually agreeing to when they tick the box (M17).
 *
 * **One place, because three screens ask and a carrier reads all three.** The public form, the booking page
 * and the website chat each collect the same permission, and until this file they each said something
 * different — the form said only "It's OK to text me about this", which names nobody, mentions no cost and
 * offers no way out. A 10DLC campaign registration is checked against what the opt-in actually said, so a
 * box that under-discloses is a registration that fails, and an opt-in record that would not hold up.
 *
 * The six things a compliant opt-in has to carry, all of them here:
 *
 *   1. who is sending — the business's name, not ours
 *   2. what the messages are about
 *   3. that it is not a condition of buying anything
 *   4. that how many they get varies, and their own rates may apply
 *   5. STOP to stop, HELP for help
 *   6. where the terms and the privacy policy are
 *
 * Browser-safe: the public form and the booking page are both rendered for signed-out visitors, and the
 * phone will want the same words the day it grows a form screen.
 */

/** Where the box was ticked. Each reads a little differently, because each is about something different. */
export type ConsentPlace = 'form' | 'booking' | 'chat';

export { HELP_KEYWORDS, STOP_KEYWORDS } from './sms';

const ABOUT: Readonly<Record<ConsentPlace, string>> = {
  form: 'about what you have asked us',
  booking: 'about this appointment',
  chat: 'about what you have asked us',
};

export interface SmsConsentWords {
  /** The line beside the tick box. Short enough to read, specific enough to mean something. */
  readonly title: string;
  /** The fine print under it. This is the part a carrier reads. */
  readonly detail: string;
}

/**
 * The words for one business, in one place.
 *
 * `business` is the business's own name as its customers know it, never "HandsFreeOS" — the business is the
 * sender, and a customer who agreed to hear from us rather than from them has agreed to the wrong thing.
 */
export function smsConsentWords(business: string, place: ConsentPlace): SmsConsentWords {
  const who = business.trim() || 'this business';
  return {
    title: place === 'booking' ? 'Text me about this appointment' : `Text me, ${who}`,
    detail:
      `${who} may text you ${ABOUT[place]}. Agreeing is not a condition of buying anything. ` +
      'How many messages you get varies, and message and data rates may apply. ' +
      'Reply STOP to stop and HELP for help.',
  };
}

/**
 * The same thing said backwards, for the carrier: how this business collects consent.
 *
 * Offered as the starting point for the registration wizard's "how do customers agree to get texts", so the
 * sentence we send a carrier describes the box we actually show rather than whatever somebody typed. A
 * business that collects consent some other way — on paper, over the counter — edits it, which is why this
 * is a default and not a fixed value.
 */
export function optInDescriptionDefault(business: string): string {
  const who = business.trim() || 'The business';
  return (
    `Customers tick a box giving ${who} permission to text them, on ${who}'s online booking page and on ` +
    'its web forms. The box is never ticked for them and is never required to book or to send the form. ' +
    'Beside it they are told who will be texting them, what about, that message frequency varies, that ' +
    'message and data rates may apply, and that they can reply STOP to stop or HELP for help. The date and ' +
    'time of each agreement is kept against that customer.'
  );
}
