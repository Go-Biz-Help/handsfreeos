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
 * **Superseded by `optInDescriptionFor`, and kept only for callers that have no path to pass yet.** It
 * describes a booking page and web forms whether or not the business has either, and a description that
 * promises a box a reviewer cannot find is how a registration gets turned down. The wizard asks which way
 * the business actually collects consent and calls `optInDescriptionFor` with the answer.
 *
 * @deprecated Use `optInDescriptionFor(business, path, surfaces)`.
 */
export function optInDescriptionDefault(business: string): string {
  return optInDescriptionFor(business, 'hosted');
}

// ---------- which way this business actually collects consent (the A2P wizard) ----------

/**
 * How a business collects permission to text. **The whole registration turns on this answer**, because a
 * 10DLC campaign is not approved on the strength of the sentence we send — a reviewer opens the business's
 * website and looks for the box the sentence describes. A description that promises a tick box on a page
 * that has none is the single most common way one of these is turned down.
 *
 * - `hosted` — HandsFreeOS collects it: the website chat widget and a public contact form, both carrying
 *   `smsConsentWords` already. We can turn these on in one click and give the carrier a URL that loads,
 *   which is why the wizard recommends it and why it is first here.
 * - `own_site` — the business adds the box to its own forms. Honest, and sometimes the only option for a
 *   business with a real marketing site, but it is work somebody has to actually do before we submit.
 * - `in_person` — collected on paper, at the counter or over the phone. No URL exists to check, so the
 *   description has to carry its own weight and the reviewer is likelier to ask for proof.
 */
export type OptInPath = 'hosted' | 'own_site' | 'in_person';

/** The public places a hosted opt-in can live. Each is a URL a carrier can open. */
export interface OptInSurfaces {
  /** The website chat widget's public page, when one is live. */
  readonly chatUrl?: string | null;
  /** A public form carrying the consent box, when one is live. */
  readonly formUrl?: string | null;
  /** The online booking page, when the business takes bookings. */
  readonly bookingUrl?: string | null;
}

/** Surfaces that are actually live, in the order a reviewer is most likely to accept them. */
export function liveSurfaces(s: OptInSurfaces): string[] {
  return [s.formUrl, s.bookingUrl, s.chatUrl].filter(
    (u): u is string => typeof u === 'string' && u.trim().length > 0,
  );
}

/** Joins URLs the way the description reads them: "a, b and c". */
function listUrls(urls: readonly string[]): string {
  if (urls.length <= 1) return urls[0] ?? '';
  return `${urls.slice(0, -1).join(', ')} and ${urls[urls.length - 1]}`;
}

/** What the six disclosures say, as one clause. Every path's description ends with this. */
function disclosureClause(who: string): string {
  return (
    `Beside the box they are told that ${who} will be texting them and what about, that agreeing is not a ` +
    'condition of buying anything, that how many messages they get varies, that message and data rates may ' +
    'apply, and that they can reply STOP to stop or HELP for help. The box is never ticked for them and is ' +
    'never required. The date and time of each agreement is kept against that customer.'
  );
}

/**
 * The sentence the carrier reads, describing **the way this business actually collects consent** rather
 * than a way it might.
 *
 * This is the replacement for `optInDescriptionDefault`, which described booking pages and web forms
 * whether or not the business had either. Pass the path the wizard settled on and the surfaces that are
 * live, and what comes back is checkable: every URL in it is one a reviewer can open.
 */
export function optInDescriptionFor(
  business: string,
  path: OptInPath,
  surfaces: OptInSurfaces = {},
): string {
  const who = business.trim() || 'The business';
  const urls = liveSurfaces(surfaces);
  switch (path) {
    case 'hosted': {
      const where = urls.length
        ? `at ${listUrls(urls)}`
        : "on the business's own public contact form and website chat";
      return (
        `Customers tick a box giving ${who} permission to text them, ${where}. ` +
        disclosureClause(who)
      );
    }
    case 'own_site': {
      const where = urls.length ? `at ${listUrls(urls)}` : `on ${who}'s own website`;
      return (
        `Customers tick a box giving ${who} permission to text them, on the contact and enquiry forms ` +
        `${where}. ` +
        disclosureClause(who)
      );
    }
    case 'in_person':
      return (
        `Customers give ${who} permission to text them in person or over the phone, when they ask for work ` +
        `to be done. They are told that ${who} will be texting them and what about, that agreeing is not a ` +
        'condition of buying anything, that how many messages they get varies, that message and data rates ' +
        'may apply, and that they can reply STOP to stop or HELP for help. Whoever takes the permission ' +
        'records it against that customer, with the date and time.'
      );
  }
}
