/**
 * Everything about the company, the product's addresses and the plans, in one file.
 *
 * Change a price or a line here and the pricing page, the home page's plan strip and the FAQ
 * all follow.
 */

export const company = {
  /** Twilio, Stripe, Square and both app stores check the site names the legal company. */
  legalName: 'Go Biz Help LLC',
  product: 'HandsFreeOS',
  /**
   * Mail here becomes a ticket inside HandsFreeOS (M13) rather than landing in a mailbox anybody signs
   * into. Postmark receives it on the bare domain; the businesses' own mail keeps mail.handsfreeos.com.
   */
  supportEmail: 'support@handsfreeos.com',
  /**
   * The postal address, one line per line as it should print. Twilio's A2P registration and
   * Stripe's platform profile ask for the same address, so keep all three in step.
   */
  mailingAddress: ['8000 Madison Blvd Ste D102 # 287', 'Madison, AL 35758', 'US'],
  /** The state whose law the terms run under, and whose courts hear a dispute. */
  governingState: 'Colorado',
  /** The year the copyright line starts from. */
  founded: 2026,
} as const;

export const urls = {
  site: 'https://handsfreeos.com',
  app: 'https://app.handsfreeos.com',
  signUp: 'https://app.handsfreeos.com/sign-up',
  signIn: 'https://app.handsfreeos.com/sign-in',
  deleteAccount: 'https://app.handsfreeos.com/delete-account',
  /**
   * Each store's link goes on the app page once it's set; until then that page says "coming soon" for it.
   * Google Play's carries `pcampaignid=site`; the app's onboarding link carries `pcampaignid=onboarding`.
   */
  appStore: '',
  playStore:
    'https://play.google.com/store/apps/details?id=com.gobizhelp.handsfreeos&pcampaignid=site',
} as const;

/**
 * The plan.
 *
 * **One plan, and everything is in it.** Three tiers were three conversations to have before somebody could
 * buy: which one am I, what am I missing, will I have to move later. A business with four people and a
 * business with twenty need the same software, and charging the second one more for the same thing is a
 * conversation nobody enjoys. So: one price, every feature, as many people as work there.
 *
 * What is *not* in it is usage — texts, calls, numbers and AI — because that is what actually costs us money
 * and it varies tenfold between a quiet plumber and a busy clinic. Folding it in would mean charging the
 * quiet one for the busy one.
 */
export const plan = {
  id: 'handsfreeos',
  name: 'HandsFreeOS',
  price: 97,
  blurb: 'Everything HandsFreeOS does, for one business.',
  seats: 'As many people as work there. No per-person charge.',
  includes: [
    'Your own business number for texts and calls',
    'One inbox for texts, calls, voicemail and email',
    'Customers, leads and a pipeline that shows what is where',
    'Calendar with a public booking page customers book themselves on',
    'Estimates, invoices, deposits and plans, paid through your own Stripe or Square',
    'An AI teammate that answers new leads by text, email and website chat',
    'It books them straight into the calendar, and hands over to you when it should',
    'Follow-up workflows that chase quotes and unpaid invoices on their own',
    'The Action Center: one ranked list of what needs you, money first',
    'The Assistant: ask it anything about your business, it drafts and fills things in',
    'Your customers and history moved over from the system you use now',
    'The phone app, working with no signal',
    'Unlimited people and unlimited customers',
  ],
} as const;

/**
 * The founding offers.
 *
 * These are the *marketing* copy for two rows that live in `platform.founding_offers`. The **numbers** —
 * how many seats, how many are left — never come from here: they are read live from the database, because a
 * page that says "7 left" while the database says none is worse than a page that says nothing. `id` is what
 * ties the two together, and it has to match the row.
 */
export const foundingOffers = [
  {
    id: 'founding_partner',
    name: 'Founding Partner',
    price: 0,
    priceLabel: 'Free, for life',
    blurb: 'For twenty-five businesses who will tell us the truth about what is missing.',
    includes: [
      'Everything in HandsFreeOS, free for as long as it exists',
      'We set it up with you, in a group of five, so you are never the only one going first',
      '$10 of texts, calls and AI to start with',
      'A say in what gets built next, because you are the reason we know',
    ],
    asks: [
      'Let it run your real business, not a trial account',
      'Tell us when it gets something wrong, and every time you had to step in on something it should have handled — that is the whole trade',
      'Let us write up what it did for you, if it does anything worth writing up',
    ],
    // What /founding says while this is the offer on sale.
    headline: 'Twenty-five founding partners.',
    sub: 'Not a beta, and not a discount. Twenty-five real businesses letting it do the real work — answering, booking, chasing — and telling us what is wrong, for as long as HandsFreeOS exists.',
    afterwards:
      'When these are gone, a yearly seat opens on its own: $497 a year, a hundred of them.',
    softwareLine: 'The software is free for life. The phone company is not.',
  },
  {
    id: 'founding_lifetime',
    name: 'Founding Customer',
    price: 497,
    priceLabel: '$497 a year',
    blurb: 'One payment a year for all of HandsFreeOS.',
    includes: [
      'Everything in HandsFreeOS, for $497 a year, with no monthly bill',
      'Every feature we add to the core product, at no extra cost',
      'About five months of the monthly price, for the whole year',
      'Renews each year on its own, and you can stop it any time',
    ],
    asks: [],
    headline: 'A hundred founding customers.',
    sub: 'The free seats are gone. The next hundred businesses pay $497 a year for a CRM that does the work for them — about five months of the monthly price, for the whole year.',
    afterwards: 'Partway through these, HandsFreeOS also goes on sale month to month, at $97.',
    softwareLine: 'The software is one payment a year. The phone company is not.',
  },
] as const;

export type FoundingOfferContent = (typeof foundingOffers)[number];

/** The page copy for an offer the database names, or the first offer's when it names one this file lacks. */
export const foundingContent = (offerId: string | null | undefined): FoundingOfferContent =>
  foundingOffers.find((o) => o.id === offerId) ?? foundingOffers[0];

/**
 * What sits on top of every offer here, founding ones included: texts, calls, numbers and AI, billed for
 * what you use. Saying it in the same breath as "free for life" is the point — a founding partner who finds
 * out about it afterwards has been misled, however technically accurate the page was.
 */
export const usageNote =
  'Texts, calls, phone numbers and AI replies are billed for what you use, on top of the plan. Most businesses spend about $30–$60 a month. This is the same on every offer, founding seats included — it is what the phone companies charge us, passed through.';

export const annualNote = 'Pay for the year and get two months free.';
