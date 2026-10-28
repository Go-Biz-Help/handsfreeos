/**
 * Discount and trial codes (20261027014300, HANDSFREEOS_AFFILIATES_IMPLEMENTATION_PLAN.md part 3), said once for the
 * web, the phone and the emails. Browser-safe.
 *
 * A code takes a percent or dollars off each payment, for some months or for good (decision 11), gives 7, 14 or 30
 * days free (decision 16), or a trial then a discount (decision 18). Each one has its own link that fills it in on
 * the plan page (decision 20).
 */
import { money } from '../money/format';
import { AFFILIATE_SITE, affiliateRateWords } from './words';

/** A code's link carries it as `handsfreeos.com/?code=<code>`; the website hands it on to sign-up and the plan page. */
export const AFFILIATE_CODE_PARAM = 'code';
/** How long a free trial can be (decision 16). The database checks it too. */
export const AFFILIATE_TRIAL_DAYS = [7, 14, 30] as const;
/** How many codes an affiliate may have on at once. The database checks it too (private.affiliate_make_code). */
export const AFFILIATE_MAX_CODES = 20;

/** A code's link: it opens the website, and the plan page fills the code in. */
export const affiliateCodeLink = (code: string): string =>
  `${AFFILIATE_SITE}/?${AFFILIATE_CODE_PARAM}=${encodeURIComponent(code)}`;

/** What a code gives, as it was made. */
export interface AffiliateCodeDeal {
  readonly percentOffBp: number | null;
  readonly amountOffCents: number | null;
  /** Null with a discount: for good. */
  readonly discountMonths: number | null;
  readonly trialDays: number | null;
}

const monthsWords = (n: number): string => (n === 1 ? '1 month' : `${n} months`);

/** "20% off for 3 months", "$10 off for good", "14 days free", "14 days free, then 20% off for 3 months". */
export function affiliateCodeDealWords(d: AffiliateCodeDeal): string {
  const parts: string[] = [];
  if (d.trialDays) parts.push(`${d.trialDays} days free`);
  const off = d.percentOffBp
    ? `${affiliateRateWords(d.percentOffBp)} off`
    : d.amountOffCents
      ? `${money(d.amountOffCents)} off`
      : null;
  if (off)
    parts.push(`${off} ${d.discountMonths ? `for ${monthsWords(d.discountMonths)}` : 'for good'}`);
  return parts.join(', then ');
}

/** What a code takes off one plan, as `founding.code_preview` says it. */
export interface AffiliateCodePrice {
  readonly fullCents: number;
  /** Off each payment while the discount lasts. */
  readonly discountCents: number;
  readonly discountMonths: number | null;
  readonly trialDays: number | null;
  readonly billing: 'monthly' | 'yearly' | 'once';
}

/**
 * How many payments a discount comes off: each month in its months, each year that starts in them, or the one
 * payment of a spot paid once. Null for good, 0 with no discount. The database counts the same way
 * (`private.founding_charge_cents`).
 */
export function affiliateDiscountedPayments(p: AffiliateCodePrice): number | null {
  if (p.discountCents <= 0) return 0;
  if (p.billing === 'once') return 1;
  if (p.discountMonths === null) return null;
  return p.billing === 'monthly' ? p.discountMonths : Math.ceil(p.discountMonths / 12);
}

const perWords = (billing: AffiliateCodePrice['billing']): string =>
  billing === 'monthly' ? 'a month' : billing === 'yearly' ? 'a year' : 'once';

/**
 * A plan's price with a code, for the plan page: "14 days free, then $77.60 a month for the first 3 months, then $97
 * a month", "$397.60 a year for the first year, then $497 a year", "$48.50 a month".
 */
export function affiliateCodePriceWords(p: AffiliateCodePrice): string {
  const per = perWords(p.billing);
  const full = `${money(p.fullCents)} ${per}`;
  const cut = `${money(p.fullCents - p.discountCents)} ${per}`;
  const n = affiliateDiscountedPayments(p);
  const unit = p.billing === 'monthly' ? 'month' : 'year';
  const price =
    p.discountCents <= 0
      ? full
      : n === null || p.billing === 'once'
        ? cut
        : `${cut} for the first ${n === 1 ? unit : `${n} ${unit}s`}, then ${full}`;
  return p.trialDays ? `${p.trialDays} days free, then ${price}` : price;
}

/** What the plan page charges today: nothing for a trial, else the first payment with its discount. */
export const affiliateCodeFirstCharge = (p: AffiliateCodePrice): number =>
  p.trialDays ? 0 : p.fullCents - p.discountCents;

/** A code, as the plan page and the code lists say it. */
export const AFFILIATE_CODE_WORDS = {
  // The plan page.
  have: 'Have a code?',
  label: 'Code',
  apply: 'Apply',
  remove: 'Remove',
  checking: 'Checking…',
  applied: (code: string, deal: string) => `“${code}”: ${deal}`,
  notForPlan: 'This code isn’t for this plan.',
  notForAny: (code: string) =>
    `“${code}” isn’t for the plans on sale now. Take it off to pay the full price.`,
  startTrial: (days: number) => `Start your ${days}-day free trial`,
  /** `when` is the day the trial ends, as the page says dates. */
  trialFine: (when: string) =>
    `Nothing is charged today. Your card is charged when the trial ends, on ${when}, unless you stop it renewing first in Settings → Usage & balance. That gives your spot back when the trial ends.`,

  // The lists of codes, the affiliate's own and staff's.
  codes: 'Your codes',
  staffCodes: 'Their codes',
  houseCodes: 'House codes',
  houseHelp:
    'Codes that belong to no affiliate, for HandsFreeOS’s own promotions. They can take up to 90% off, and earn nobody a share.',
  intro: (limit: string) =>
    `Make codes for the people you send: up to ${limit} off, for some months or for good, a free trial, or a trial then a discount. Each code has its own link that fills it in.`,
  none: 'No codes yet.',
  make: 'Make a code',
  making: 'Making…',
  code: 'Code',
  codeShape: 'Letters, digits and dashes, like SPRING20',
  plan: 'For',
  anyPlan: 'Any plan',
  kind: 'What it gives',
  percent: 'Percent off',
  dollars: 'Dollars off',
  trialOnly: 'A free trial only',
  amount: 'How much off',
  percentHelp: (limit: string) => `Up to ${limit}.`,
  dollarsHelp: (most: string) => `Up to ${most} on the cheapest plan it’s for.`,
  howLong: 'For how long',
  forGood: 'For good',
  forMonths: 'For some months',
  months: 'Months',
  monthsHelp:
    'Counted from the first payment. On a yearly plan, each year that starts in them is discounted.',
  trial: 'Free trial',
  noTrial: 'No trial',
  trialDays: (days: number) => `${days} days`,
  link: 'Link',
  copyLink: 'Copy link',
  copied: 'Copied the code’s link',
  on: 'On',
  off: 'Off',
  offByStaff: 'Turned off by HandsFreeOS',
  turnOff: 'Turn off',
  turnOn: 'Turn on',
  uses: (n: number) => `${n} ${n === 1 ? 'business' : 'businesses'} bought with it`,
  limit: 'Most a code takes off',
  limitHelp:
    'For every affiliate’s codes, unless you give one their own. Lowering it counts at once on codes already made, but never on what a business already bought.',
  ownLimit: 'Their own limit',
  everyonesLimit: (limit: string) => `Everyone’s (${limit})`,
  useEveryones: 'Use everyone’s',
  setOwnLimit: 'Give them their own',
  limitProblem: 'Type a percent between 1 and 90, like 50.',
  percentProblem: (limit: string) => `Type a percent between 1 and ${limit}, like 20.`,
  dollarsProblem: 'Type an amount in dollars, like 10.',
  monthsProblem: 'Type how many months, from 1 to 36.',
  pickSomething: 'Pick a discount, a free trial, or both.',
} as const;
