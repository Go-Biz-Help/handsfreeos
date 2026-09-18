/**
 * One document, in words: its lines, its totals block, the line beside its customer, where an estimate stands, and
 * the states a plan and a refund are in.
 *
 * Shared by the web's Money section (`components/money/totals.tsx`, `document-view.tsx`, `document-page.tsx`,
 * `estimates-list.tsx`, `plans-list.tsx`, `status-badge.tsx`) and the phone's document screen, so a total adds up
 * and reads the same on either. Pure and browser-safe; the arithmetic is `totals.ts` and the states `status.ts`.
 */
import { dayLabel } from '../attention/wording';
import { money } from './format';
import type { EstimateState, InvoiceState } from './status';
import { refundShares } from './totals';
import { dueWording, expiryPhrase } from './words';

const at = (iso: string | null | undefined): number | null => (iso ? Date.parse(iso) : null);

// ---- A line ----

/** Units that read the same however many there are: "16 hours", but "1 each" and "20 sq ft". */
const UNCOUNTED = new Set(['each', 'ft', 'sq ft', 'sq m', 'm', 'kg', 'lb', 'lbs']);

/** "16 hours", "1 each": the label a product carries, made to agree with the quantity beside it. */
export function unitWord(quantity: number, label: string): string {
  const word = label.trim();
  if (quantity === 1 || !word || UNCOUNTED.has(word.toLowerCase()) || /s$/i.test(word)) return word;
  return `${word}s`;
}

/** "1 each × $6,400" — how a line's quantity and price read in a sentence. */
export function lineRateLabel(line: {
  readonly quantity: number;
  readonly unitLabel: string;
  readonly unitPriceCents: number;
}): string {
  return `${line.quantity} ${unitWord(line.quantity, line.unitLabel)} × ${money(line.unitPriceCents)}`;
}

/** "−$40 off this line", and the note under a line no tax is charged on. */
export const lineDiscountLabel = (discountCents: number): string =>
  `−${money(discountCents)} off this line`;
export const NO_TAX_ON_LINE = 'No tax';

/** The four column headings over a document's lines. */
export const LINE_COLUMNS = ['Item', 'Qty', 'Price', 'Amount'] as const;

// ---- The totals block ----

/** Basis points as people write them: 825 → "8.25%", 1000 → "10%". */
export function percentLabel(bp: number): string {
  const value = (bp ?? 0) / 100;
  return `${Number.isInteger(value) ? value : Number(value.toFixed(2))}%`;
}

export interface TotalsShape {
  readonly subtotalCents: number;
  readonly discountCents: number;
  readonly discountPercentBp: number | null;
  readonly taxableBaseCents: number;
  readonly taxRateBp: number;
  readonly taxLabel: string | null;
  readonly taxCents: number;
  readonly totalCents: number;
}

export interface TotalsRow {
  readonly key:
    'subtotal' | 'discount' | 'tax' | 'total' | 'paid' | 'overpayment' | 'balance' | 'refunded';
  readonly label: string;
  readonly value: string;
  /** Money coming off the bill, drawn in the credit colour. */
  readonly credit: boolean;
  /** The line that matters: the total, or what is still owed. */
  readonly big: boolean;
}

export interface TotalsMoney {
  readonly paidCents?: number;
  /** Given, the block ends with what is still owed instead of the total. */
  readonly balanceCents?: number;
  readonly refundedCents?: number;
  /** "Paid" unless the screen has a better word for it. */
  readonly paidLabel?: string;
}

/**
 * The rows of the totals block, in order.
 *
 * On an invoice they still add up once money has gone back. A refund never puts money back on the bill, so what was
 * refunded sits under "Amount due" rather than inside the sum — except the part that used up an overpayment, which
 * is exactly what took a credit back to nothing, and so reads above it.
 */
export function totalsRows(t: TotalsShape, m: TotalsMoney = {}): readonly TotalsRow[] {
  const rows: TotalsRow[] = [
    {
      key: 'subtotal',
      label: 'Subtotal',
      value: money(t.subtotalCents + t.discountCents),
      credit: false,
      big: false,
    },
  ];
  if (t.discountCents > 0)
    rows.push({
      key: 'discount',
      label: t.discountPercentBp
        ? `${percentLabel(t.discountPercentBp)} off, before tax`
        : 'Off the whole job, before tax',
      value: `−${money(t.discountCents)}`,
      credit: true,
      big: false,
    });
  if (t.taxRateBp > 0)
    rows.push({
      key: 'tax',
      label: `${t.taxLabel ?? 'Sales tax'} · ${percentLabel(t.taxRateBp)} on ${money(t.taxableBaseCents)}`,
      value: money(t.taxCents),
      credit: false,
      big: false,
    });
  const owes = m.balanceCents !== undefined;
  rows.push({
    key: 'total',
    label: 'Total',
    value: money(t.totalCents),
    credit: false,
    big: !owes,
  });
  if (!owes) return rows;
  const refund = refundShares(t.totalCents, m.paidCents ?? 0, m.refundedCents ?? 0);
  if (m.paidCents)
    rows.push({
      key: 'paid',
      label: m.paidLabel ?? 'Paid',
      value: `−${money(m.paidCents)}`,
      credit: true,
      big: false,
    });
  if (refund.fromOverpaymentCents)
    rows.push({
      key: 'overpayment',
      label: 'Overpayment given back',
      value: money(refund.fromOverpaymentCents),
      credit: false,
      big: false,
    });
  rows.push({
    key: 'balance',
    label: 'Amount due',
    value: money(m.balanceCents ?? 0),
    credit: false,
    big: true,
  });
  if (refund.givenBackCents)
    rows.push({
      key: 'refunded',
      label: 'Refunded to the customer',
      value: money(refund.givenBackCents),
      credit: false,
      big: false,
    });
  return rows;
}

/** An estimate's two extra rows: what is asked for up front and what is left. */
export const DEPOSIT_ROW_LABEL = 'Deposit asked for up front';
export const BALANCE_AFTER_ROW_LABEL = 'Balance when the work is done';

// ---- The line beside a document's customer ----

export interface InvoiceStandingFacts {
  readonly status: string;
  readonly state: InvoiceState | string;
  readonly dueOn: string | null;
  readonly voidedAt: string | null;
  readonly amountRefundedCents: number;
}

/**
 * The line beside an invoice's customer: when it is due while something is owed, and otherwise how it ended. A
 * refund never reopens an invoice, so a refunded one says what went back rather than a due date.
 */
export function invoiceStanding(
  inv: InvoiceStandingFacts,
  now: number | Date,
  timeZone: string,
): string {
  const voided = at(inv.voidedAt);
  if (voided !== null) return `Voided ${dayLabel(voided, timeZone)}`;
  if (inv.state === 'refunded') return 'Refunded in full';
  if (inv.state === 'partly_refunded')
    return `Paid in full · ${money(inv.amountRefundedCents)} refunded`;
  if (inv.status === 'paid') return 'Paid in full';
  return dueWording(inv.dueOn, now, timeZone);
}

export interface EstimateStandingFacts {
  readonly voidedAt: string | null;
  readonly acceptedAt: string | null;
  readonly declinedAt: string | null;
  readonly sentAt: string | null;
  readonly firstViewedAt: string | null;
  readonly createdAt: string | null;
  readonly expiresOn: string | null;
}

/** Where an estimate stands, in one sentence: the column the canvas calls "Where it stands". */
export function estimateStanding(
  est: EstimateStandingFacts,
  now: number | Date,
  timeZone: string,
): string {
  const day = (iso: string | null) => {
    const t = at(iso);
    return t === null ? '' : dayLabel(t, timeZone);
  };
  if (est.voidedAt) return `Voided ${day(est.voidedAt)}`;
  if (est.acceptedAt) return `Approved ${day(est.acceptedAt)}`;
  if (est.declinedAt) return `Declined ${day(est.declinedAt)}`;
  if (!est.sentAt) return `Started ${day(est.createdAt)} · not sent`;
  const seen = est.firstViewedAt ? ' · opened' : '';
  return `Sent ${day(est.sentAt)}${seen} · ${expiryPhrase(est.expiresOn, now, timeZone)}`;
}

/** The word on an estimate's badge, for a state core already names. */
export type { EstimateState };

// ---- Plans and refunds ----

/** A plan's states, as the plan list and the plan page both name them. */
export const SUBSCRIPTION_WORDS: Readonly<Record<string, string>> = {
  draft: 'Draft',
  active: 'Billing',
  past_due: 'Payment failed',
  paused: 'Paused',
  cancelled: 'Cancelled',
  unmanaged: 'Not managed here',
};

/** A refund's own states. "Refunded" is money that has gone back; the invoice stays paid. */
export const REFUND_WORDS: Readonly<Record<string, string>> = {
  pending: 'Refunding',
  succeeded: 'Refunded',
  failed: 'Refund failed',
};

const EVERY: Readonly<Record<string, string>> = {
  week: 'a week',
  month: 'a month',
  quarter: 'a quarter',
  year: 'a year',
};

/** "$29 a month", "$290 a year", "$149 every 3 months". */
export function planPriceLabel(
  priceCents: number,
  interval: string,
  intervalCount: number,
): string {
  const every = intervalCount === 1 ? EVERY[interval] : `every ${intervalCount} ${interval}s`;
  return `${money(priceCents)} ${every ?? ''}`.trim();
}

// ---- Recording cash or a check ----

/** The sheet's own words. The phone leads with what actually happens at the door; the web's title is broader. */
export const RECORD_CASH_TITLE = 'Record cash or a check';
export const RECORD_PAYMENT_TITLE = 'Record a payment';

/** "Money taken off the system. $1,313.83 is owed." */
export const recordCashNote = (balanceCents: number): string =>
  `Money taken off the system. ${money(balanceCents)} is owed.`;

export const HOW_MUCH_LABEL = 'How much';
export const HOW_PAID_LABEL = 'How it was paid';
export const REFERENCE_LABEL = 'Reference';
export const REFERENCE_HINT = 'A check number, say. Optional.';

/** More than is owed: the same sentence the API refuses with, said before it is sent. */
export const overBalanceProblem = (balanceCents: number): string =>
  `That is more than the ${money(balanceCents)} owed.`;

/** "$1,313.83 recorded." */
export const recordedToast = (amountCents: number): string => `${money(amountCents)} recorded.`;
