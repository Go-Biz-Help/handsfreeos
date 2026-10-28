/**
 * The affiliate program's page (`/affiliates`) and its terms (`/affiliates/terms`), for people who sell HandsFreeOS
 * for a share of what the businesses they send pay (HANDSFREEOS_AFFILIATES_IMPLEMENTATION_PLAN.md).
 *
 * The program's fixed rules are the owner's decisions, and match `@hfos/core`. The share and the most a code takes
 * off are staff's to change, so they're read live (`src/lib/affiliate-program.ts`), never written here.
 */
import { REF_DAYS } from '@/lib/affiliate';
import type { Faq } from './faqs';
import { foundingSpots, urls } from './site';

export const affiliateRules = {
  /** Each payment in a business's first 12 months counts (decision 2). Matches `AFFILIATE_MONTHS`. */
  months: 12,
  /** How long a click counts before sign-up (decision 4). */
  clickDays: REF_DAYS,
  /** Each share waits this long for refunds before it's paid (decision 8). Matches `AFFILIATE_WAIT_DAYS`. */
  waitDays: 30,
  /** The least sent in a payout (decision 9). Matches `AFFILIATE_MIN_PAYOUT_CENTS`. */
  minPayout: '$25',
  /** A code's free trial (decision 16). */
  trialDays: '7, 14 or 30',
} as const;

/** Where somebody applies: their affiliate page in the app, which asks them to sign in or make an account first. */
export const applyUrl = `${urls.app}/affiliate`;

/** What one business on each founding spot earns its affiliate in its first year, at this share. */
export function exampleEarnings(rateBp: number) {
  return foundingSpots.map((spot) => {
    const payments = spot.plan === 'monthly' ? affiliateRules.months : 1;
    const each = (spot.price * rateBp) / 10000;
    return {
      id: spot.id,
      name: spot.name,
      price: `${spot.priceLabel} ${spot.per}`,
      each: dollars(each),
      per: spot.plan === 'monthly' ? 'a month' : 'a year',
      /** A month at a time adds up over the year; a year's payment is the year. */
      firstYear: payments > 1 ? dollars(each * payments) : null,
    };
  });
}

const dollars = (n: number): string =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The questions, with the share filled in when it's known. */
export function affiliateFaqs(share: string, maxOff: string): readonly Faq[] {
  return [
    {
      q: 'Do I have to be a HandsFreeOS customer?',
      a: 'No. Anyone in the US can apply with a free HandsFreeOS sign-in. You don’t need a business on it or a plan of your own.',
    },
    {
      q: 'What counts as a sale?',
      a: `A business paying for its HandsFreeOS plan, by the year or by the month. You earn ${share} of each plan payment in its first ${affiliateRules.months} months. Texts, calls, phone numbers and AI, which businesses pay for as they use them, don’t count.`,
    },
    {
      q: 'How do you know a business came from me?',
      a: `It signs up within ${affiliateRules.clickDays} days of clicking your link, or pays for its plan with one of your codes. If somebody clicks more than one affiliate’s link, the last one counts. A business that was already on HandsFreeOS, or your own, doesn’t.`,
    },
    {
      q: 'Can I give people a discount?',
      a: `Yes. Make your own codes on your affiliate page: up to ${maxOff} off each payment, for a few months or for good, a free trial of ${affiliateRules.trialDays} days, or a trial and then a discount. Each code has its own link. You earn your share of what the business actually pays.`,
    },
    {
      q: 'When and how am I paid?',
      a: `Once a month, straight to your US bank account through Stripe. Each share waits ${affiliateRules.waitDays} days in case of a refund, then it goes out with the next payout, when you’re owed at least ${affiliateRules.minPayout}. We pay Stripe’s fees, so you get all of it.`,
    },
    {
      q: 'What if a business I sent gets a refund?',
      a: 'The same share of the refund comes off what you earned, from your next payout if it was already paid.',
    },
    {
      q: 'Can I sign up other affiliates under me?',
      a: 'No. There’s one level: you earn on the businesses you send yourself.',
    },
    {
      q: 'Is there anything I can’t do?',
      a: 'Tell people you earn from it, don’t spam anybody, don’t promise what HandsFreeOS doesn’t do, and don’t buy ads on the HandsFreeOS name. The affiliate terms say the rest in plain words.',
    },
  ];
}
