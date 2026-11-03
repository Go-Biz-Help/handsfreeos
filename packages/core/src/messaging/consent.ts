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
  /**
   * Where the privacy policy is, when the page knows. Given back rather than written into `detail` so the
   * caller renders a real link: the sixth disclosure is that the terms are findable, and a URL a customer
   * has to retype is not findable.
   */
  readonly policyUrl: string | null;
  /** Where the terms are, when the page knows. A link beside the policy's, for the same reason. */
  readonly termsUrl: string | null;
}

/**
 * The words for one business, in one place.
 *
 * `business` is the business's own name as its customers know it, never "HandsFreeOS" — the business is the
 * sender, and a customer who agreed to hear from us rather than from them has agreed to the wrong thing.
 */
export function smsConsentWords(
  business: string,
  place: ConsentPlace,
  policyUrl: string | null = null,
  termsUrl: string | null = null,
): SmsConsentWords {
  const who = business.trim() || 'this business';
  return {
    title: place === 'booking' ? 'Text me about this appointment' : `Text me, ${who}`,
    detail:
      `${who} may text you ${ABOUT[place]}. Agreeing is not a condition of buying anything. ` +
      'How many messages you get varies, and message and data rates may apply. ' +
      'Reply STOP to stop and HELP for help.',
    policyUrl: policyUrl?.trim() || null,
    termsUrl: termsUrl?.trim() || null,
  };
}

/**
 * The second, separate box a business that also sends offers shows under the first (M17).
 *
 * **Offers get their own box because the carriers want the two kept apart.** Agreeing to hear about the job
 * you asked for is not agreeing to hear about a spring special, so a campaign registered for "customer care
 * and occasional promotions" is checked for a page where a customer can say yes to one and no to the other.
 * Never ticked for them and never required, like the first.
 */
export function offersConsentWords(business: string): { title: string; detail: string } {
  const who = business.trim() || 'this business';
  return {
    title: `Also text me offers from ${who}`,
    detail:
      `${who} may also text you now and then about offers and services that are due. This is separate ` +
      'from the box above and never required. How many messages you get varies, and message and data ' +
      'rates may apply. Reply STOP to stop and HELP for help.',
  };
}

/**
 * The "OK to call" box a business that asks for it shows under the text boxes (Settings → Automations → AI calls).
 *
 * **Its own box, because a call is its own permission.** AI calls use an artificial voice, and the law asks for a
 * customer's written yes before one about the business's services or offers: a yes to texts isn't a yes to calls. So
 * the words say who calls (the business, never HandsFreeOS), that it may be an AI assistant or a recorded voice, what
 * about, that it isn't a condition of buying, that calls may be recorded and how to stop. Never ticked for them and
 * never required, like the others. Drafted 2026-10-28 for the owner's lawyer to approve; one change here is every page.
 */
export function callConsentWords(business: string): { title: string; detail: string } {
  const who = business.trim() || 'this business';
  return {
    title: 'OK to call me, including with an AI assistant',
    detail:
      `${who} may call the number you gave, including with an AI assistant or a recorded voice, about what ` +
      'you asked for and about its services and offers. Agreeing is not a condition of buying anything. ' +
      `Calls may be recorded. Say stop on any call, or tell ${who}, and the calls stop.`,
  };
}

/** True when this use case has the business sending offers as well as customer care, so it needs the second box. */
export const sendsOffers = (useCase: string | null | undefined): boolean =>
  useCase === 'mixed' || useCase === 'marketing';

/**
 * What a business adding the box to its own website puts beside it: the same words our own pages show,
 * as plain text to copy, with the offers box under it when the business sends offers.
 */
export function ownSiteBoxText(business: string, offers: boolean): string {
  const care = smsConsentWords(business, 'form');
  const parts = [
    `☐ ${care.title}`,
    `${care.detail} Privacy policy · Terms (link both to your own pages).`,
  ];
  if (offers) {
    const extra = offersConsentWords(business);
    parts.push('', `☐ ${extra.title}`, extra.detail);
  }
  return parts.join('\n');
}

/**
 * The one address the agreement box links to, for a business with a public site.
 *
 * Always ours, even for a business using its own policy: `/legal/<site>/privacy` redirects to theirs when
 * they have set one. One canonical link means the consent records all point at something that resolves,
 * and a business that later changes where its policy lives does not leave old boxes pointing at nothing.
 */
export const consentPolicyPath = (siteSlug: string): string => `/legal/${siteSlug}/privacy`;

/** The terms beside it, on the same terms: ours, redirecting to the business's own when it has some. */
export const consentTermsPath = (siteSlug: string): string => `/legal/${siteSlug}/terms`;

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
 * - `hosted` — HandsFreeOS collects it: the website chat, pasted into the footer of the business's own site,
 *   asks for the visitor's details right after their first message, with the box carrying `smsConsentWords`
 *   (and the offers box, and links to the privacy policy and terms). We set it up in one click and give the
 *   carrier a page that shows exactly what the chat asks, which is why the wizard recommends it and why it is
 *   first here. (It used to make a contact form on a page of ours instead; a form already live still counts.)
 * - `own_site` — the business adds the box to its own forms. Honest, and sometimes the only option for a
 *   business with a real marketing site, but it is work somebody has to actually do before we submit.
 * - `in_person` — collected on paper, at the counter or over the phone. No URL exists to check, so the
 *   description has to carry its own weight and the reviewer is likelier to ask for proof.
 */
export type OptInPath = 'hosted' | 'own_site' | 'in_person';

/** The public places a hosted opt-in can live. Each is a URL a carrier can open. */
export interface OptInSurfaces {
  /**
   * The page showing what the website chat asks (`/chat/<key>` opened on its own), when one is live. A reviewer
   * rarely starts a chat to find the box, so this is where they see it.
   */
  readonly chatUrl?: string | null;
  /** The business's own website, where the chat's code is pasted. */
  readonly siteUrl?: string | null;
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

/** What the six disclosures say, as one clause. Every web path's description ends with this. */
function disclosureClause(who: string): string {
  return (
    `Beside the box they are told that ${who} will be texting them and what about, that agreeing is not a ` +
    'condition of buying anything, that how many messages they get varies, that message and data rates may ' +
    'apply, and that they can reply STOP to stop or HELP for help, with links to the privacy policy and the ' +
    'terms. The box is never ticked for them and is never required. The date and time of each agreement is ' +
    'kept against that customer.'
  );
}

/** The offers box, said to the carrier, for a business that sends offers as well. */
const offersClause = (who: string): string =>
  `Offers from ${who} have a second, separate box that is also never ticked for them or required, so a ` +
  'customer can agree to texts about their own work without agreeing to offers.';

/** What the description can say beyond the path and the surfaces. */
export interface OptInDetails {
  /** The business's own page carrying the box (`own_site`). */
  readonly pageUrl?: string | null;
  /** A picture or page showing what customers see or hear before they agree (`in_person`, mostly). */
  readonly proofUrl?: string | null;
  /** The business sends offers too, so there is a second box for them. */
  readonly offers?: boolean;
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
  details: OptInDetails = {},
): string {
  const who = business.trim() || 'The business';
  const urls = liveSurfaces(surfaces);
  const page = details.pageUrl?.trim() || null;
  const proof = details.proofUrl?.trim() || null;
  const offers = details.offers ? ` ${offersClause(who)}` : '';
  const shown = proof ? ` What they see is shown at ${proof}.` : '';
  switch (path) {
    case 'hosted': {
      // The chat on the business's own site, which asks for their details after their first message; any form or
      // booking page carrying the same box is said after it.
      const site = surfaces.siteUrl?.trim() || null;
      const chat = surfaces.chatUrl?.trim() || null;
      const others = liveSurfaces({ formUrl: surfaces.formUrl, bookingUrl: surfaces.bookingUrl });
      return (
        `Customers agree in the chat on ${site ?? `${who}'s website`}. After a visitor sends their first ` +
        'message, the chat asks for their name, mobile number and email, and they can tick a box giving ' +
        `${who} permission to text them. ` +
        disclosureClause(who) +
        offers +
        (chat ? ` A page showing exactly what the chat asks is at ${chat}.` : '') +
        (others.length ? ` The same box is on ${listUrls(others)}.` : '')
      );
    }
    case 'own_site': {
      const where = page
        ? `at ${page}`
        : urls.length
          ? `at ${listUrls(urls)}`
          : `on ${who}'s own website`;
      return (
        `Customers tick a box giving ${who} permission to text them, on the contact and enquiry forms ` +
        `${where}. ` +
        disclosureClause(who) +
        offers +
        shown
      );
    }
    case 'in_person':
      return (
        `Customers give ${who} permission to text them in person or over the phone, when they ask for work ` +
        `to be done. They are told that ${who} will be texting them and what about, that agreeing is not a ` +
        'condition of buying anything, that how many messages they get varies, that message and data rates ' +
        'may apply, and that they can reply STOP to stop or HELP for help. Whoever takes the permission ' +
        'records it against that customer, with the date and time.' +
        (details.offers
          ? ' Offers are asked about separately, and only customers who say yes to them get them.'
          : '') +
        (proof ? ` The sign-up sheet or the words used are shown at ${proof}.` : '')
      );
  }
}
