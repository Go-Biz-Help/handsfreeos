/**
 * The privacy policy and terms a carrier opens before it approves a campaign.
 *
 * **This is not legal boilerplate for its own sake.** A 10DLC reviewer follows the website link on the
 * registration, looks for a privacy policy, and reads it for one thing in particular: a sentence saying
 * that phone numbers collected for texting are not shared or sold. A business whose site has no policy, or
 * a policy that never mentions texting, is turned down — and the businesses HandsFreeOS serves mostly have
 * a one-page site built by somebody's nephew, with no policy at all.
 *
 * So we generate one from what the business already told us and host it, and the opt-in box links to it.
 * A business that already has a real policy points at its own instead (`policyUrl`), because replacing a
 * lawyer's page with a generated one would be worse than useless.
 *
 * **The clause carriers look for is `MOBILE_DATA_CLAUSE`, and it is reproduced close to verbatim.** The
 * wording is close to an industry-standard sentence that reviewers are known to scan for, so this is one
 * place where saying it our own way is a real cost. Everything around it may be rewritten freely.
 *
 * Browser-safe: the wizard previews the policy before the business turns it on.
 */

/** What a policy needs to know about the business. All of it is already on the registration form. */
export interface PolicyBusiness {
  readonly name: string;
  readonly legalName?: string;
  readonly website?: string;
  readonly email?: string;
  readonly phone?: string;
  /** The business also texts offers, with a separate box for them, so the policy and terms say so. */
  readonly offers?: boolean;
  readonly address?: {
    readonly line1?: string;
    readonly city?: string;
    readonly state?: string;
    readonly postalCode?: string;
  };
}

/**
 * The sentence a 10DLC reviewer is looking for, near enough to the industry wording to be recognised.
 *
 * Do not paraphrase this. A policy that says the same thing in different words is a policy a reviewer has
 * to read carefully instead of one they can tick, and some of them do not read carefully.
 */
export const MOBILE_DATA_CLAUSE =
  'No mobile information will be shared with third parties or affiliates for marketing or promotional ' +
  'purposes. Information sharing to subcontractors in support services, such as customer service, is ' +
  'permitted. All other use case categories exclude text messaging originator opt-in data and consent; ' +
  'this information will not be shared with any third parties.';

const addressLine = (b: PolicyBusiness): string => {
  const a = b.address;
  if (!a) return '';
  return [a.line1, a.city, [a.state, a.postalCode].filter(Boolean).join(' ')]
    .filter((p) => p && p.trim())
    .join(', ');
};

/** How to reach the business, as a policy has to say somewhere. */
function contactBlock(b: PolicyBusiness): string {
  const lines = [b.legalName?.trim() || b.name.trim()];
  const address = addressLine(b);
  if (address) lines.push(address);
  if (b.email?.trim()) lines.push(b.email.trim());
  if (b.phone?.trim()) lines.push(b.phone.trim());
  return lines.join('\n');
}

/** A section of a generated policy: a heading and its paragraphs, so a page can render it as it likes. */
export interface PolicySection {
  readonly heading: string;
  readonly paragraphs: readonly string[];
}

export interface GeneratedPolicy {
  readonly title: string;
  readonly intro: string;
  readonly sections: readonly PolicySection[];
  /** Shown at the foot of the page, so a reviewer can see it is current. */
  readonly updated: string;
}

const isoDay = (on: Date) => on.toISOString().slice(0, 10);

/**
 * The privacy policy, written around the texting clause rather than with it bolted on.
 *
 * `on` is passed rather than read from the clock so the same business renders the same page twice, and so
 * a test can assert the date.
 */
export function privacyPolicy(business: PolicyBusiness, on: Date = new Date()): GeneratedPolicy {
  const who = business.name.trim() || 'This business';
  const legal = business.legalName?.trim() || who;
  return {
    title: `${who} — Privacy Policy`,
    intro:
      `${legal} ("we", "us") collects and uses personal information to do the work customers ask us to ` +
      'do, and to keep in touch with them about it. This policy says what we collect, why, and what we ' +
      'never do with it.',
    updated: isoDay(on),
    sections: [
      {
        heading: 'What we collect',
        paragraphs: [
          'We collect the details you give us: your name, phone number, email address, service address, ' +
            'and whatever you tell us about the work you need doing. We keep a record of the appointments, ' +
            'estimates and invoices between us, and of the messages and calls we exchange.',
          'When you use our website we collect the ordinary technical information a website receives, such ' +
            'as which pages were opened and the browser used.',
        ],
      },
      {
        heading: 'Text messages',
        paragraphs: [
          `If you give ${who} permission to text you, we use your mobile number to send you messages about ` +
            'your appointments, estimates and the work we are doing for you.' +
            (business.offers
              ? ' If you also tick the separate box for offers, we text you now and then about offers and ' +
                'services that are due.'
              : '') +
            ' Agreeing is never a condition ' +
            "of buying anything from us. How many messages you get varies, and your carrier's message and " +
            'data rates may apply.',
          'You can stop the messages at any time by replying STOP, and get help by replying HELP.',
          MOBILE_DATA_CLAUSE,
        ],
      },
      {
        heading: 'Who else sees it',
        paragraphs: [
          'We use service providers to run our business — to send our messages and email, to take payments, ' +
            'and to keep our records. They may only handle your information to do that work for us.',
          'We do not sell your personal information. We share it otherwise only when the law requires it, ' +
            'or to establish or defend a legal claim.',
        ],
      },
      {
        heading: 'How long we keep it',
        paragraphs: [
          'We keep customer records for as long as we are working together and afterwards for as long as ' +
            'our tax and legal obligations require. Records of consent to be texted, and of any withdrawal ' +
            'of it, are kept for as long as we hold your number.',
        ],
      },
      {
        heading: 'Your choices',
        paragraphs: [
          'You can ask us what we hold about you, ask us to correct it, or ask us to delete it. Write to us ' +
            'at the address below and we will answer.',
        ],
      },
      { heading: 'Contact us', paragraphs: [contactBlock(business)] },
    ],
  };
}

/** The terms a reviewer expects to find beside the policy. Short on purpose: a local trade is not a SaaS. */
export function termsOfService(business: PolicyBusiness, on: Date = new Date()): GeneratedPolicy {
  const who = business.name.trim() || 'This business';
  const legal = business.legalName?.trim() || who;
  return {
    title: `${who} — Terms of Service`,
    intro: `These terms cover your use of ${legal}'s website, booking pages and text messages.`,
    updated: isoDay(on),
    sections: [
      {
        heading: 'Booking and quotes',
        paragraphs: [
          'A booking or an estimate made through this site is a request, and becomes an agreement when we ' +
            'confirm it. Prices quoted before we have seen the work may change once we have; we will tell ' +
            'you before doing anything that costs more than you agreed.',
        ],
      },
      {
        heading: 'Text messages',
        paragraphs: [
          `By giving ${who} permission to text you, you agree to receive messages about your appointments, ` +
            'estimates and work' +
            (business.offers
              ? ', and, if you also tick the separate box for them, about offers and services that are due'
              : '') +
            '. Agreeing is not a condition of buying anything. Message frequency varies ' +
            "and your carrier's message and data rates may apply.",
          'Reply STOP at any time to stop the messages; we will send one text to confirm, and none after ' +
            'it. Reply START to get them again. Reply HELP for help' +
            (business.phone?.trim() ? `, or call us at ${business.phone.trim()}` : '') +
            (business.email?.trim() ? `, or email ${business.email.trim()}` : '') +
            '.',
          'Mobile carriers are not liable for delayed or undelivered messages. How we handle your number ' +
            'is set out in our privacy policy: we never share or sell it for anyone else’s marketing.',
        ],
      },
      {
        heading: 'Cancelling',
        paragraphs: [
          'Tell us as early as you can if you need to cancel or move an appointment. Where a deposit was ' +
            'taken, what happens to it is whatever we told you when you paid it.',
        ],
      },
      {
        heading: 'Our liability',
        paragraphs: [
          'We do the work with reasonable care and skill. Nothing in these terms limits liability that the ' +
            'law does not allow us to limit.',
        ],
      },
      { heading: 'Contact us', paragraphs: [contactBlock(business)] },
    ],
  };
}

/** Flattens a generated policy to plain text, for a business pasting it into its own website. */
export function policyAsText(policy: GeneratedPolicy): string {
  const parts = [policy.title, '', policy.intro];
  for (const section of policy.sections) {
    parts.push('', section.heading, ...section.paragraphs);
  }
  parts.push('', `Last updated: ${policy.updated}`);
  return parts.join('\n');
}
