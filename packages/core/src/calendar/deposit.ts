/**
 * What a calendar asks a customer for before it will hold a time, worked out from its settings and the price
 * of the visit. Pure: the worker's booking routes read the price from the catalogue and call this.
 *
 * Chris's rule, which every part of this follows: **the card is held, not charged, until the time is
 * confirmed**, so nothing here decides anything about money that has already moved — only how much to ask for.
 * A calendar with `payments.deposit` set keeps its own figure; one without follows whatever the business asks
 * for in Settings → Payments, so changing it there changes it everywhere.
 */
import type { CalendarConfig } from './config';
import { depositCentsOf, type DepositTerms } from '../money/totals';

/** How long a time is held while a customer pays for it (the plan's figure). */
export const DEPOSIT_HOLD_MINUTES = 15;
export const DEPOSIT_HOLD_MS = DEPOSIT_HOLD_MINUTES * 60_000;

export interface BookingCharge {
  /** 'deposit': part now and the rest on the invoice for the job. 'full': the whole price now. */
  readonly mode: 'deposit' | 'full';
  /** What the visit costs, where the catalogue says; 0 when nothing has a price. */
  readonly priceCents: number;
  /** What is due before the time is held. Always at least 1 cent — a charge of nothing is no charge. */
  readonly amountCents: number;
  /** What is left for the invoice after the visit. */
  readonly dueAfterCents: number;
}

/**
 * What is due now, or null when this booking asks for nothing: payment is off, or the figures work out to
 * nothing (a percentage of a price nobody has set). **A booking that asks for nothing goes through as it
 * always has** — holding a time for a charge of $0 would be a worse answer than not asking at all.
 */
export function bookingCharge(
  config: CalendarConfig,
  businessDeposit: DepositTerms,
  priceCents: number,
): BookingCharge | null {
  const mode = config.payments.mode;
  if (mode === 'none') return null;
  const price = Math.max(0, Math.round(priceCents || 0));
  if (mode === 'full') {
    if (price < 1) return null;
    return { mode, priceCents: price, amountCents: price, dueAfterCents: 0 };
  }
  const terms: DepositTerms = config.payments.deposit ?? businessDeposit;
  // A set amount stands even where the price is unknown ("$99 to book"); a share of nothing is nothing.
  const asked =
    terms.kind === 'amount' && price < 1
      ? Math.max(0, Math.round(terms.amountCents ?? 0))
      : depositCentsOf(terms, price);
  if (asked < 1) return null;
  return {
    mode,
    priceCents: price,
    amountCents: asked,
    dueAfterCents: Math.max(0, price - asked),
  };
}
