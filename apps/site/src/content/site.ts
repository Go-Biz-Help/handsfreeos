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
  supportEmail: 'support@gobizhelp.com',
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
  /** Both store links go live with the first release; until then the app page says "coming soon". */
  appStore: '',
  playStore: '',
} as const;

/** Growth includes eight people. Past that it is this much a month each. Pro has no per-person charge. */
export const extraSeatPrice = 15;

/** The number of people a Growth plan covers before `extraSeatPrice` starts. */
export const includedSeats = 8;

/**
 * The plans.
 *
 * The rule behind the split: **Growth has every feature HandsFreeOS has for one business.**
 * Nothing is held back from it except running more than one business, which is what Pro is.
 * Starter is the smaller plan for a one-person shop: it is missing the AI teammate answering
 * customers on its own, and the automatic follow-ups that go with it.
 */
export const plans = [
  {
    id: 'starter',
    name: 'Starter',
    price: 99,
    blurb: 'For the owner who answers their own phone.',
    seats: 'Up to 3 people',
    featured: false,
    includes: [
      'Your own business number for texts and calls',
      'One inbox for texts, calls, voicemail and email',
      'Customers, leads and a pipeline that shows what is where',
      'Calendar with a public booking page customers book themselves on',
      'Estimates, invoices, deposits and plans, paid through your own Stripe or Square',
      'Your customers and history moved over from the system you use now',
      'The phone app, working with no signal',
      'The Assistant: ask it anything about your business, it drafts and fills things in',
    ],
    missing: [
      'An AI teammate that answers your customers on its own',
      'Follow-up workflows and the Action Center',
    ],
  },
  {
    id: 'growth',
    name: 'Growth',
    price: 249,
    blurb: 'Everything HandsFreeOS does, for one business.',
    seats: 'Unlimited people — 8 included, then $15 each a month',
    featured: true,
    includes: [
      'Everything in Starter',
      'An AI teammate that answers new leads by text, email and website chat',
      'It books them straight into the calendar, and hands over to you when it should',
      'Follow-up workflows that chase quotes and unpaid invoices on their own',
      'The Action Center: one ranked list of what needs you, money first',
      'A morning email with what happened and what is waiting',
      'Every other feature HandsFreeOS has. Nothing is held back for a bigger plan',
    ],
    missing: ['More than one business under one login'],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: 499,
    blurb: 'For several locations, or an agency running this for its clients.',
    seats: 'Unlimited people, no per-person charge',
    featured: false,
    includes: [
      'Everything in Growth, for every business you run',
      'Several businesses or locations under one login, each with its own number and books',
      'Templates, knowledge and workflows shared across all of them at once',
      'We move you over from your old CRM ourselves, rather than you running it',
      'Priority support, and a person who sets the whole thing up with you',
    ],
    missing: [],
  },
] as const;

/** What sits on top of a plan, at cost. Texts, calls and AI are metered by the companies behind them. */
export const usageNote =
  'Texts, calls and AI replies are passed through at what they cost us, on one line of your bill. A typical Growth business spends about $20–$40 a month on top of the plan.';

export const annualNote = 'Pay for the year and get two months free.';
