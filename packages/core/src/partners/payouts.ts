/**
 * Paying partners (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 3): who a month's payout pays, what it charges
 * the business, and Stripe's fees on it (decision 16), each on its own line. A partner owed less than the smallest
 * payout (decision 17), or with no bank set up yet, isn't paid this month: what they're owed waits for the next.
 * The worker's commands (../commands/partner-payouts.ts) and the screens work it out the same way from these.
 *
 * Browser-safe.
 */
import { zonedParts } from '../calendar/engine/zoned';
import { BASIS_POINTS } from '../money/totals';

/** Stripe's card fee on the month's charge, for a US card: 2.9% + 30¢. */
export const CARD_FEE_BP = 290;
export const CARD_FEE_FIXED_CENTS = 30;
/** Stripe's fee for each partner's account that's paid in a month. */
export const ACCOUNT_FEE_CENTS = 200;
/** Stripe's fee for each payout to a partner's bank: 0.25% + 25¢. */
export const PAYOUT_FEE_BP = 25;
export const PAYOUT_FEE_FIXED_CENTS = 25;
/** Stripe's fee on top for a payout to a bank outside the US (decision 118): 0.25%. */
export const CROSS_BORDER_FEE_BP = 25;

/**
 * Where a partner's bank can be (docs/outreach.md decision 118; the partners plan's decision 18): the countries
 * Stripe pays a US platform's Express accounts in, the US first. Canada, the UK, Switzerland and the EEA's, by name.
 * Anywhere else, Stripe can't pay them from HandsFreeOS yet.
 */
export const PAYOUT_COUNTRIES = {
  US: 'United States',
  AT: 'Austria',
  BE: 'Belgium',
  BG: 'Bulgaria',
  CA: 'Canada',
  HR: 'Croatia',
  CY: 'Cyprus',
  CZ: 'Czechia',
  DK: 'Denmark',
  EE: 'Estonia',
  FI: 'Finland',
  FR: 'France',
  DE: 'Germany',
  GR: 'Greece',
  HU: 'Hungary',
  IE: 'Ireland',
  IT: 'Italy',
  LV: 'Latvia',
  LI: 'Liechtenstein',
  LT: 'Lithuania',
  LU: 'Luxembourg',
  MT: 'Malta',
  NL: 'Netherlands',
  NO: 'Norway',
  PL: 'Poland',
  PT: 'Portugal',
  RO: 'Romania',
  SK: 'Slovakia',
  SI: 'Slovenia',
  ES: 'Spain',
  SE: 'Sweden',
  CH: 'Switzerland',
  GB: 'United Kingdom',
} as const;
export type PayoutCountry = keyof typeof PAYOUT_COUNTRIES;
export const PAYOUT_COUNTRY_KEYS = Object.keys(PAYOUT_COUNTRIES) as [
  PayoutCountry,
  ...PayoutCountry[],
];
/** A country's name, for a code that may be one Stripe pays or not. */
export const payoutCountryName = (code: string): string => {
  const ours = (PAYOUT_COUNTRIES as Record<string, string>)[code];
  if (ours) return ours;
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
};
/** Where a bank is, as a sentence ends: "in Canada", "in the United States". */
export const payoutCountryIn = (code: string): string => {
  const name = payoutCountryName(code);
  return ['US', 'GB', 'NL'].includes(code) ? `in the ${name}` : `in ${name}`;
};
/**
 * Stripe's fees for each partner's 1099 (stage 5): $2.99 to e-file it with the IRS and $1.49 to e-file it with their
 * state. Mailing a paper copy ($2.99) when a partner hasn't taken e-delivery stays HandsFreeOS's.
 */
export const TAX_FORM_FEE_CENTS = 448;

/**
 * What a business must have paid a partner in a calendar year for Stripe to file their 1099-NEC: $2,000 for payments
 * from 2026 (the One Big Beautiful Bill Act raised it from $600). It moves with inflation from 2027: check the IRS's
 * figure each year.
 */
export const taxFormThresholdCents = (taxYear: number): number =>
  taxYear >= 2026 ? 200_000 : 60_000;

/** A share of an amount in basis points, rounded up to the cent so a fee is always covered. */
const bpUp = (cents: number, bp: number): number =>
  Math.floor((cents * bp + BASIS_POINTS - 1) / BASIS_POINTS);

/** Stripe's fee for paying one partner this amount, with its cross-border part for a bank outside the US. */
export const payoutFeeCents = (amountCents: number, abroad = false): number =>
  bpUp(amountCents, PAYOUT_FEE_BP + (abroad ? CROSS_BORDER_FEE_BP : 0)) + PAYOUT_FEE_FIXED_CENTS;

/** Stripe's card fee on a charge of this much. */
export const cardFeeCents = (chargeCents: number): number =>
  bpUp(chargeCents, CARD_FEE_BP) + CARD_FEE_FIXED_CENTS;

/** The least the card is charged so that, once Stripe takes its card fee, what's left covers the rest. */
export function grossUpCents(subtotalCents: number): number {
  if (subtotalCents <= 0) return 0;
  let charge = Math.ceil(
    ((subtotalCents + CARD_FEE_FIXED_CENTS) * BASIS_POINTS) / (BASIS_POINTS - CARD_FEE_BP),
  );
  while (charge - cardFeeCents(charge) < subtotalCents) charge += 1;
  while (charge - 1 - cardFeeCents(charge - 1) >= subtotalCents) charge -= 1;
  return charge;
}

export interface PayoutLineAmounts {
  readonly amountCents: number;
  readonly accountFeeCents: number;
  readonly payoutFeeCents: number;
}

export interface PayoutTotals {
  /** What the partners are owed. */
  readonly owedCents: number;
  /** Stripe's $2 for each partner's account paid this month. */
  readonly accountFeesCents: number;
  /** Stripe's 0.25% + 25¢ for each payout to a partner's bank, and 0.25% more to a bank outside the US. */
  readonly payoutFeesCents: number;
  /** Stripe's fees for the partners' 1099s of a year that ended. */
  readonly taxFormsCents: number;
  /** Stripe's 2.9% + 30¢ on the charge itself. */
  readonly cardFeeCents: number;
  /** All of it: what the business's card is charged. */
  readonly chargeCents: number;
}

/** One partner's amount in a payout, and whether their bank is outside the US. */
export type PayoutAmount = number | { readonly amountCents: number; readonly abroad: boolean };

/**
 * What a month's payout charges for paying each of these amounts, with each line's own fees, and Stripe's fees for
 * this many 1099s of a year that ended.
 */
export function payoutTotals(
  amounts: readonly PayoutAmount[],
  taxForms = 0,
): PayoutTotals & {
  readonly lines: readonly PayoutLineAmounts[];
} {
  const lines = amounts.map((a) => {
    const { amountCents, abroad } = typeof a === 'number' ? { amountCents: a, abroad: false } : a;
    return {
      amountCents,
      accountFeeCents: ACCOUNT_FEE_CENTS,
      payoutFeeCents: payoutFeeCents(amountCents, abroad),
    };
  });
  const owedCents = lines.reduce((a, l) => a + l.amountCents, 0);
  const accountFeesCents = lines.reduce((a, l) => a + l.accountFeeCents, 0);
  const payoutFeesCents = lines.reduce((a, l) => a + l.payoutFeeCents, 0);
  const taxFormsCents = taxForms * TAX_FORM_FEE_CENTS;
  const fees = accountFeesCents + payoutFeesCents + taxFormsCents;
  const chargeCents = grossUpCents(owedCents + fees);
  return {
    lines,
    owedCents,
    accountFeesCents,
    payoutFeesCents,
    taxFormsCents,
    cardFeeCents: chargeCents - owedCents - fees,
    chargeCents,
  };
}

/** What's given back to a business's card for a line it was charged for and never paid out: it and its two fees. */
export const givenBackCents = (line: PayoutLineAmounts): number =>
  line.amountCents + line.accountFeeCents + line.payoutFeeCents;

/** Why a partner who's owed something isn't paid this month. */
export type PayoutWait = 'below_smallest' | 'no_bank';

export interface PartnerOwed {
  readonly partnerId: string;
  /** What no payout has taken yet that's free to pay out, less what was taken back. */
  readonly owedCents: number;
  /** Their Stripe account can take a transfer and pay it out to their bank. */
  readonly bankReady: boolean;
}

/**
 * Who a month's payout pays: everyone owed at least the smallest payout whose bank is set up. The rest wait, less
 * than the smallest carried to the next month and the rest kept until they set up their bank; nobody owed nothing,
 * or less than nothing after a refund, is listed.
 */
export function planPayout(input: {
  readonly partners: readonly PartnerOwed[];
  readonly smallestPayoutCents: number;
}): {
  readonly paid: readonly PartnerOwed[];
  readonly waiting: readonly (PartnerOwed & { readonly why: PayoutWait })[];
} {
  const paid: PartnerOwed[] = [];
  const waiting: (PartnerOwed & { why: PayoutWait })[] = [];
  for (const p of input.partners) {
    if (p.owedCents <= 0) continue;
    if (p.owedCents < input.smallestPayoutCents) waiting.push({ ...p, why: 'below_smallest' });
    else if (!p.bankReady) waiting.push({ ...p, why: 'no_bank' });
    else paid.push(p);
  }
  return { paid, waiting };
}

/** A date's month in a time zone, as its first day: "2026-11-01". An unknown time zone reads as UTC. */
export function payoutMonthOf(at: Date, timeZone: string | null | undefined): string {
  const { year, month } = zonedParts(at, timeZone || 'UTC');
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

/** The first day of the month after one: "2026-12-01" after "2026-11-01". */
export function monthAfter(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

/**
 * When the next payout is worked out: within the hour while this month's hasn't been, else the first of next
 * month. Either way only once payouts are open and there's a card.
 */
export function nextPayoutMonth(input: {
  readonly now: Date;
  readonly timeZone: string | null | undefined;
  readonly lastMonth: string | null;
}): { readonly month: string; readonly soon: boolean } {
  const month = payoutMonthOf(input.now, input.timeZone);
  if (!input.lastMonth || input.lastMonth < month) return { month, soon: true };
  return { month: monthAfter(input.lastMonth > month ? input.lastMonth : month), soon: false };
}
