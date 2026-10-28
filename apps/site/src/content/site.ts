/**
 * Everything about the company, the product's addresses and the prices, in one file.
 *
 * Change a price or a line here and the pricing page, the home page's spots strip and the FAQ
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
   * Google Play's `referrer` holds UTM tags (`utm_source=website`, `utm_campaign=get_the_app`) for Play Console's
   * acquisition reports; the app's onboarding link says `utm_source=onboarding`.
   */
  appStore: '',
  playStore:
    'https://play.google.com/store/apps/details?id=com.gobizhelp.handsfreeos&referrer=utm_source%3Dwebsite%26utm_campaign%3Dget_the_app',
} as const;

/**
 * The plan: what every founding spot buys.
 *
 * **One plan, and everything is in it.** Three tiers were three conversations to have before somebody could
 * buy: which one am I, what am I missing, will I have to move later. A business with four people and a
 * business with twenty need the same software, and charging the second one more for the same thing is a
 * conversation nobody enjoys. So: one plan, every feature, as many people as work there, paid by the year or
 * by the month (`foundingSpots`).
 *
 * What is *not* in it is usage — texts, calls, numbers and AI — because that is what actually costs us money
 * and it varies tenfold between a quiet plumber and a busy clinic. Folding it in would mean charging the
 * quiet one for the busy one.
 */
export const plan = {
  id: 'handsfreeos',
  name: 'HandsFreeOS',
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
 * The founding spots: how a business buys HandsFreeOS (20261027012700). First come, first served — they sign up,
 * pick a spot and pay, straight after making their business. Nobody applies.
 *
 * These are the *marketing* copy for two rows that live in `platform.founding_offers`. The **numbers** — how
 * many spots, how many are left — never come from here: they are read live from the database, because a page
 * that says "7 left" while the database says none is worse than a page that says nothing. `id` is what ties
 * the two together, and it has to match the row. `plan` is what the app's sign-up is told to pick to start
 * with (`?plan=`), so a visitor who pressed the monthly one finds the monthly one picked.
 */
export const foundingSpots = [
  {
    id: 'founding_lifetime',
    plan: 'yearly',
    name: 'Founding Customer',
    price: 497,
    priceLabel: '$497',
    per: 'a year',
    blurb: 'One payment a year for all of HandsFreeOS.',
    includes: [
      'Everything in HandsFreeOS, with no monthly bill',
      'About five months of the monthly price, for the whole year',
      'Every feature we add to the core product, at no extra cost',
      'Renews each year on its own, and you can stop it any time',
      '30 days, or your money back',
    ],
  },
  {
    id: 'monthly',
    plan: 'monthly',
    name: 'Founding Monthly',
    price: 97,
    priceLabel: '$97',
    per: 'a month',
    blurb: 'All of HandsFreeOS, month to month.',
    includes: [
      'Everything in HandsFreeOS, paid a month at a time',
      'Every feature we add to the core product, at no extra cost',
      'Renews each month on its own, and you can stop it any time',
      '30 days, or your money back',
    ],
  },
] as const;

export type FoundingSpotContent = (typeof foundingSpots)[number];

/** The app's sign-up, told which spot to pick to start with. */
export const signUpFor = (spot: FoundingSpotContent): string => `${urls.signUp}?plan=${spot.plan}`;

/** "$497 a year or $97 a month": both prices, in the order above. */
export const spotPrices = foundingSpots.map((s) => `${s.priceLabel} ${s.per}`).join(' or ');

/** What most businesses spend on usage a month, in dollars: the range the usage note and the home page's bill quote. */
export const typicalUsage = { low: 30, high: 60 } as const;

/**
 * The money-back promise (the owner's call, 2026-10-28): within 30 days of the first plan payment, a business that
 * asks gets that payment back in full, monthly or yearly. Usage is not refunded, because the phone and AI
 * companies have already charged us for it. The terms page says the same in its billing section, and "The 30-day
 * money back" in docs/operations.md is how staff give it.
 */
export const moneyBack = {
  days: 30,
  short: '30-day money back',
  line: 'Use HandsFreeOS for 30 days. If it isn’t for you, ask, and we refund your plan payment in full, monthly or yearly. The texts, calls and AI you used are what the phone and AI companies charged us, so those aren’t refunded.',
} as const;

/**
 * What sits on top of every spot: texts, calls, numbers and AI, billed for what you use. Saying it in the same
 * breath as the price is the point — somebody who finds out about it afterwards has been misled, however
 * technically accurate the page was.
 */
export const usageNote = `Texts, calls, phone numbers and AI replies are billed for what you use, on top of the plan. Most businesses spend about $${typicalUsage.low}–$${typicalUsage.high} a month. This is the same on both founding spots — it is what the phone companies charge us, passed through.`;

/** What the pages say when no spot has room, or none is on sale. The app's plan page says much the same. */
export const noSpotsNote = `No founding spots are open right now. Email ${company.supportEmail} and we’ll tell you when more open.`;
