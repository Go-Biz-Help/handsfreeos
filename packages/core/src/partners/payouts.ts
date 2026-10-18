/**
 * Paying partners (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 3): who a month's payout pays, what it charges
 * the business, and Stripe's fees on it (decision 16), each on its own line. A partner owed less than the smallest
 * payout (decision 17), or with no bank set up yet, isn't paid this month: what they're owed waits for the next.
 * The worker's commands (../commands/partner-payouts.ts) and the screens work it out the same way from these.
 *
 * Browser-safe.
 */
import { BASIS_POINTS } from '../money/totals';

/** Stripe's card fee on the month's charge, for a US card: 2.9% + 30¢. */
export const CARD_FEE_BP = 290;
export const CARD_FEE_FIXED_CENTS = 30;
/** Stripe's fee for each partner's account that's paid in a month. */
export const ACCOUNT_FEE_CENTS = 200;
/** Stripe's fee for each payout to a partner's bank: 0.25% + 25¢. */
export const PAYOUT_FEE_BP = 25;
export const PAYOUT_FEE_FIXED_CENTS = 25;

/** A share of an amount in basis points, rounded up to the cent so a fee is always covered. */
const bpUp = (cents: number, bp: number): number =>
  Math.floor((cents * bp + BASIS_POINTS - 1) / BASIS_POINTS);

/** Stripe's fee for paying one partner this amount: their account's month and their payout. */
export const payoutFeeCents = (amountCents: number): number =>
  bpUp(amountCents, PAYOUT_FEE_BP) + PAYOUT_FEE_FIXED_CENTS;

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
  /** Stripe's 0.25% + 25¢ for each payout to a partner's bank. */
  readonly payoutFeesCents: number;
  /** Stripe's 2.9% + 30¢ on the charge itself. */
  readonly cardFeeCents: number;
  /** All of it: what the business's card is charged. */
  readonly chargeCents: number;
}

/** What a month's payout charges for paying each of these amounts, with each line's own fees. */
export function payoutTotals(amounts: readonly number[]): PayoutTotals & {
  readonly lines: readonly PayoutLineAmounts[];
} {
  const lines = amounts.map((amountCents) => ({
    amountCents,
    accountFeeCents: ACCOUNT_FEE_CENTS,
    payoutFeeCents: payoutFeeCents(amountCents),
  }));
  const owedCents = lines.reduce((a, l) => a + l.amountCents, 0);
  const accountFeesCents = lines.reduce((a, l) => a + l.accountFeeCents, 0);
  const payoutFeesCents = lines.reduce((a, l) => a + l.payoutFeeCents, 0);
  const chargeCents = grossUpCents(owedCents + accountFeesCents + payoutFeesCents);
  return {
    lines,
    owedCents,
    accountFeesCents,
    payoutFeesCents,
    cardFeeCents: chargeCents - owedCents - accountFeesCents - payoutFeesCents,
    chargeCents,
  };
}

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
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'UTC',
      year: 'numeric',
      month: '2-digit',
    }).formatToParts(at);
  } catch {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
    }).formatToParts(at);
  }
  const year = parts.find((p) => p.type === 'year')?.value ?? String(at.getUTCFullYear());
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  return `${year}-${month}-01`;
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
