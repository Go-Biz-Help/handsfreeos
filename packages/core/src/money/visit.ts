/**
 * The money on one visit: the deposit that booked it and the bill for the job itself, as the web's appointment
 * sheet (`components/calendar/visit-money.tsx`) and the phone's appointment screen both show them.
 *
 * Two things it exists to say, in the order they matter:
 *
 * 1. **A time held while a customer pays its deposit is not a booking.** Without saying so, it reads to staff
 *    exactly like a confirmed one — somebody rings to confirm a visit nobody has paid for, or works around a slot
 *    that is about to free itself. `calendar/agenda.ts`'s `holdWords` says the hold; this says the money.
 * 2. **Once the deposit is paid**, the same block says what was paid, when, and what is left for after the visit —
 *    the same three figures the customer saw on the booking page, so the two agree.
 *
 * Browser-safe and pure. Which invoices a person may see is decided before this is called (`money.for_record`
 * carries the member rule, and the phone's copy only holds what they may see).
 */
import { money } from './format';

/**
 * The deposit a booking raised: its own invoice, from the booking page, not voided. (`depositOf` on the server is a
 * different question — how much deposit an estimate asks for.)
 */
export const depositInvoiceOf = <T extends { readonly origin: string; readonly status: string }>(
  invoices: readonly T[],
): T | null => invoices.find((i) => i.origin === 'booking' && i.status !== 'void') ?? null;

/** The bill for the job itself: anything on this visit that isn't the deposit that booked it. */
export const jobInvoiceOf = <T extends { readonly origin: string; readonly status: string }>(
  invoices: readonly T[],
): T | null => invoices.find((i) => i.origin !== 'booking' && i.status !== 'void') ?? null;

/** What is left to pay after the visit, once the deposit is off the price. Never below nothing. */
export function dueAfterCents(priceCents: number | null, depositTotalCents: number | null): number {
  if (!priceCents || depositTotalCents === null) return 0;
  return Math.max(0, priceCents - depositTotalCents);
}

export interface DepositFacts {
  /** What the deposit invoice asks for. */
  readonly askedCents: number;
  /** What has actually landed on it. */
  readonly paidCents: number;
  /** `invoiceState`'s answer for that invoice. */
  readonly state: string;
  /** When it was paid, as an ISO instant; null while it hasn't been. */
  readonly paidAt: string | null;
  /** The visit's own price, for "left to pay after the visit". */
  readonly priceCents: number | null;
}

export interface DepositWords {
  /** The little heading over the block. */
  readonly section: string;
  /** "Deposit paid", or "Deposit on its way" while a bank transfer settles. */
  readonly badge: string;
  /** How much, under the badge's own label. */
  readonly amountLabel: string;
  readonly amount: string;
  /** What is left for after the visit, or null when nothing is. */
  readonly afterLabel: string | null;
  readonly after: string | null;
  /** Where to find the deposit's own invoice. */
  readonly invoiceLabel: string;
}

/** A bank transfer can be in without the money having landed: the deposit is taken, and it is still on its way. */
export const depositSettling = (d: DepositFacts): boolean =>
  d.state === 'paying' && d.paidCents === 0;

/**
 * The deposit block's words. `heldNote` says the sentence that goes with a time still being paid for; this one is
 * for a deposit that is in.
 */
export function depositWords(d: DepositFacts): DepositWords {
  const settling = depositSettling(d);
  const after = dueAfterCents(d.priceCents, d.askedCents);
  return {
    section: 'Deposit',
    badge: settling ? 'Deposit on its way' : 'Deposit paid',
    amountLabel: settling ? 'On its way' : 'Paid',
    amount: money(settling ? d.askedCents : d.paidCents),
    afterLabel: after > 0 ? 'Left to pay after the visit' : null,
    after: after > 0 ? money(after) : null,
    invoiceLabel: 'Deposit invoice',
  };
}

/** The grey line beside the badge: when it was paid, or why the money isn't in yet. */
export function depositWhen(d: DepositFacts, paidLongDay: string | null): string {
  if (depositSettling(d)) return 'A bank transfer takes a day or two to land.';
  return paidLongDay ? paidLongDay : 'Paid at booking.';
}

/**
 * The sentence under a time that is still being paid for. Says plainly that nothing has been charged and nobody
 * has been promised the slot, because the mistake it prevents is a phone call.
 */
export function heldNote(customerName: string, askedCents: number): string {
  const who = customerName.trim() || 'The customer';
  const what = askedCents
    ? `paying ${money(askedCents)} to book this time`
    : 'paying the deposit that books this time';
  return (
    `${who} is on the payment page now, ${what}. Nothing has been charged and nobody has been told the time ` +
    'is theirs. Don’t call to confirm it — if the deposit doesn’t land, the slot goes back on its own.'
  );
}

/** The heading over that block: a held time is not a deposit yet. */
export const heldSection = 'Not booked yet';

// ---- The bill for the job itself ----

export interface JobInvoiceWords {
  readonly title: string;
  readonly invoicedLabel: string;
  readonly paidLabel: string;
  readonly balanceLabel: string;
  readonly openLabel: string;
}

export function jobInvoiceWords(balanceCents: number): JobInvoiceWords {
  return {
    title: 'This visit’s invoice',
    invoicedLabel: 'Invoiced',
    paidLabel: 'Paid',
    balanceLabel: balanceCents > 0 ? 'Still owed' : 'Nothing owed',
    openLabel: 'Open the invoice',
  };
}
