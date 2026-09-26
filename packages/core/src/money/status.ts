/**
 * What state a document is in and where it may go next. Pure and browser-safe: the commands, the customer's
 * page, Home and the Assistant all read the same rules.
 *
 * Estimates and invoices are separate documents with separate lives. Both freeze when they're sent: a mistake is
 * voided and reissued, never edited, so nothing here ever goes back to draft, and a voided number is never used
 * again.
 *
 * The stored statuses are `app.estimate_status` and `app.invoice_status`, to the word. Three things people talk
 * about are **not** statuses, because they're facts about a document rather than states of it:
 * - **opened** is `first_viewed_at`: a sent document the customer has looked at.
 * - **paying** is a payment in `processing`. A bank transfer takes days to settle, so an invoice with one is
 *   never overdue — it's paying.
 * - **refunded** and **partly refunded** are money given back on a paid invoice. **A refund gives money back;
 *   it never puts it back on the bill.** The invoice stays paid, nothing is owed again and nothing chases it,
 *   exactly as Stripe, Square and QuickBooks keep one. To bill again, the business gives everything back, voids
 *   it and sends a new one.
 *
 * `invoiceState` and `estimateState` work those out for the screen; `invoiceIsOverdue` is what the overdue job
 * and the Action Center's detector both run on.
 */
import { addDays, startOfLocalDay } from '../calendar/engine/zoned';

// ---- Estimates ----

export const ESTIMATE_STATUSES = [
  'draft',
  'sent',
  'accepted',
  'declined',
  'expired',
  'void',
] as const;
export type EstimateStatus = (typeof ESTIMATE_STATUSES)[number];

/**
 * Where an estimate may go from each state. Sending freezes it; the customer's page accepts or declines it; a
 * job expires it. Anything else is voided and reissued.
 */
export const ESTIMATE_TRANSITIONS: Readonly<Record<EstimateStatus, readonly EstimateStatus[]>> = {
  draft: ['sent', 'void'],
  sent: ['accepted', 'declined', 'expired', 'void'],
  accepted: ['void'],
  declined: ['void'],
  expired: ['void'],
  void: [],
};

// ---- Invoices ----

export const INVOICE_STATUSES = [
  'draft',
  'sent',
  'partly_paid',
  'paid',
  'overdue',
  'void',
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * Where an invoice may go from each state. Money that moved is never voided away: the ledger has to say so, so
 * a paid invoice is refunded first, and only once everything paid on it has gone back may it be voided and a
 * new one sent. That is a rule about money rather than about states, so `invoiceVoidBlock` says it and
 * `invoice.void` enforces it; this map says only that the move exists.
 */
export const INVOICE_TRANSITIONS: Readonly<Record<InvoiceStatus, readonly InvoiceStatus[]>> = {
  draft: ['sent', 'void'],
  sent: ['partly_paid', 'paid', 'overdue', 'void'],
  partly_paid: ['paid', 'overdue', 'void'],
  overdue: ['partly_paid', 'paid', 'void'],
  paid: ['void'],
  void: [],
};

// ---- Payments and refunds ----

/** A payment's states (`app.payment_status`). `processing` covers the days a bank transfer takes. */
export const PAYMENT_STATUSES = ['requires_payment', 'processing', 'succeeded', 'failed'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const REFUND_STATUSES = ['pending', 'succeeded', 'failed'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/**
 * How money arrived (`app.payment_method`). `ach` is a bank transfer — the cheap rail we offer first; cash,
 * cheques and anything else are recorded by a person, not a provider.
 */
export const PAYMENT_METHODS = ['card', 'ach', 'cash', 'check', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Methods a person records by hand: no provider is involved, so there's nothing to confirm later. */
export const MANUAL_PAYMENT_METHODS = ['cash', 'check', 'other'] as const;

export function isManualPaymentMethod(method: PaymentMethod): boolean {
  return (MANUAL_PAYMENT_METHODS as readonly string[]).includes(method);
}

/**
 * A payment's status only ever moves forward, so a webhook delivered out of order can never un-pay an invoice.
 * `succeeded` is the end of it.
 *
 * **`failed` is not.** A bank transfer can soft-fail — the bank returns it, the customer's bank retries, and days
 * later it settles — so `failed → succeeded` is allowed and nothing else leaves `failed`. This matches
 * `private.payment_status_rank` in 0047 exactly (requires_payment 0, processing 1, failed 2, succeeded 3); the
 * database keeps a backwards callback quietly rather than raising, and this is the same rule for the code that
 * decides what to send it.
 */
export const PAYMENT_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  requires_payment: ['processing', 'succeeded', 'failed'],
  processing: ['succeeded', 'failed'],
  succeeded: [],
  failed: ['succeeded'],
};

export const REFUND_TRANSITIONS: Readonly<Record<RefundStatus, readonly RefundStatus[]>> = {
  pending: ['succeeded', 'failed'],
  succeeded: [],
  failed: [],
};

// ---- Moving ----

/** How a refusal names the document it's about ("A paid invoice can’t be voided."). */
const ESTIMATE_SUBJECT: Readonly<Record<EstimateStatus, string>> = {
  draft: 'A draft estimate',
  sent: 'A sent estimate',
  accepted: 'An approved estimate',
  declined: 'A declined estimate',
  expired: 'An expired estimate',
  void: 'A voided estimate',
};

const INVOICE_SUBJECT: Readonly<Record<InvoiceStatus, string>> = {
  draft: 'A draft invoice',
  sent: 'A sent invoice',
  partly_paid: 'A partly paid invoice',
  paid: 'A paid invoice',
  overdue: 'An overdue invoice',
  void: 'A voided invoice',
};

/** And what it refused to become. */
const ESTIMATE_PAST: Readonly<Record<EstimateStatus, string>> = {
  draft: 'put back to draft',
  sent: 'sent again',
  accepted: 'approved',
  declined: 'declined',
  expired: 'expired',
  void: 'voided',
};

const INVOICE_PAST: Readonly<Record<InvoiceStatus, string>> = {
  draft: 'put back to draft',
  sent: 'sent again',
  partly_paid: 'marked partly paid',
  paid: 'marked paid',
  overdue: 'marked overdue',
  void: 'voided',
};

export function canEstimateMove(from: EstimateStatus, to: EstimateStatus): boolean {
  return ESTIMATE_TRANSITIONS[from].includes(to);
}

export function canInvoiceMove(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return INVOICE_TRANSITIONS[from].includes(to);
}

/** A payment only moves forward: requires payment → processing → succeeded or failed. */
export function canPaymentMove(from: PaymentStatus, to: PaymentStatus): boolean {
  return PAYMENT_TRANSITIONS[from].includes(to);
}

export function canRefundMove(from: RefundStatus, to: RefundStatus): boolean {
  return REFUND_TRANSITIONS[from].includes(to);
}

/** Why an estimate can't move there, in a sentence the screen can show, or null. */
export function estimateMoveProblem(from: EstimateStatus, to: EstimateStatus): string | null {
  if (from === to || canEstimateMove(from, to)) return null;
  return `${ESTIMATE_SUBJECT[from]} can’t be ${ESTIMATE_PAST[to]}.`;
}

/**
 * Why an estimate can't be turned into an invoice, or null when it can (sent, or approved). estimate.convert and
 * the Assistant say the same.
 */
export function estimateInvoiceProblem(status: EstimateStatus): string | null {
  if (status === 'sent' || status === 'accepted') return null;
  if (status === 'draft') return 'Send the estimate before invoicing it.';
  return `${ESTIMATE_SUBJECT[status]} can’t be invoiced. Make a new one instead.`;
}

/** Why an invoice can't move there, in a sentence the screen can show, or null. */
export function invoiceMoveProblem(from: InvoiceStatus, to: InvoiceStatus): string | null {
  if (from === to || canInvoiceMove(from, to)) return null;
  return `${INVOICE_SUBJECT[from]} can’t be ${INVOICE_PAST[to]}.`;
}

/** Why a payment can't move there, or null. */
export function paymentMoveProblem(from: PaymentStatus, to: PaymentStatus): string | null {
  if (from === to || canPaymentMove(from, to)) return null;
  return 'A payment’s status only moves forward.';
}

// ---- Open, and what a payment does ----

/** Waiting on the customer: the estimate is out and unanswered. */
export function estimateIsOpen(status: EstimateStatus): boolean {
  return status === 'sent';
}

/** Money still expected: the invoice is out and neither settled nor voided. */
export function invoiceIsOpen(status: InvoiceStatus): boolean {
  return status === 'sent' || status === 'partly_paid' || status === 'overdue';
}

export interface PaymentRollup {
  readonly status: InvoiceStatus;
  readonly totalCents: number;
  /** What succeeded, gross. */
  readonly paidCents: number;
  /** What went back. It plays no part in the status: a refund never unpays an invoice. */
  readonly refundedCents: number;
}

/**
 * The stored status the roll-up gives an invoice when money lands — `private.money_roll_up_invoice()` (0053),
 * arm for arm, so the two can't disagree:
 * - a draft or a voided invoice keeps its status;
 * - **paid** once what was paid, gross, reaches a total above nothing. Refunds are ignored: giving money back
 *   never reopens it;
 * - **partly paid** while something short of that was paid — an overdue invoice too. It still reads as overdue
 *   on screen, because `invoiceState` works lateness out from the day, and the overdue job marks it again;
 * - back to **sent** only if what was paid ever fell, which it can't while payments only move forward.
 */
export function invoiceStatusForPayments(f: PaymentRollup): InvoiceStatus {
  if (f.status === 'draft' || f.status === 'void') return f.status;
  if (f.totalCents > 0 && f.paidCents >= f.totalCents) return 'paid';
  if (f.paidCents > 0) return 'partly_paid';
  if (f.status === 'paid' || f.status === 'partly_paid') return 'sent';
  return f.status;
}

// ---- Voiding ----

export interface InvoiceVoidFacts {
  /** What succeeded, gross. */
  readonly paidCents: number;
  /** What has gone back. */
  readonly refundedCents: number;
  /** A payment on its way (a bank transfer settling). */
  readonly hasProcessingPayment?: boolean;
  /** A refund asked for that hasn't gone through yet. */
  readonly hasPendingRefund?: boolean;
}

/**
 * What stops an invoice being voided, or null when nothing does. Money moved is never voided away:
 * - `money_moving` — a payment is still arriving or a refund is still going back, so what the invoice holds
 *   isn't known yet;
 * - `money_held` — something paid on it hasn't been given back. Refund it first.
 *
 * Once everything paid has gone back it can be voided, and that is how a business bills again (the wrong card
 * was charged, say): refund, void, send a new one. The status move itself is `canInvoiceMove`'s.
 */
export function invoiceVoidBlock(f: InvoiceVoidFacts): 'money_moving' | 'money_held' | null {
  if (f.hasProcessingPayment === true || f.hasPendingRefund === true) return 'money_moving';
  if (f.paidCents - f.refundedCents > 0) return 'money_held';
  return null;
}

// ---- Overdue, opened, and paying ----

/**
 * What an invoice looks like on screen: its status, or the state worked out from the day, its payments and its
 * refunds. `refunded` and `partly_refunded` are a paid invoice's only: an open one's own state leads.
 */
export type InvoiceState = InvoiceStatus | 'viewed' | 'paying' | 'refunded' | 'partly_refunded';

/** What an estimate looks like on screen. */
export type EstimateState = EstimateStatus | 'viewed';

export interface InvoiceStateFacts {
  readonly status: InvoiceStatus;
  /** The day it's due, as a local date (`2026-09-25`); null when it has none. */
  readonly dueDate: string | null;
  /** The business's time zone: a due day ends there, not in UTC. */
  readonly timeZone: string;
  /** What's still owed. */
  readonly balanceCents: number;
  /** When the customer first opened it; null when they haven't. */
  readonly viewedAt?: string | null;
  /** A payment is on its way (a bank transfer settling): never overdue while one is. */
  readonly hasProcessingPayment?: boolean;
  /** The total, what was paid (gross) and what went back: whether a paid invoice reads as refunded. */
  readonly totalCents?: number;
  readonly paidCents?: number;
  readonly refundedCents?: number;
}

/** The moment an invoice due on `dueDate` becomes late: the end of that day where the business is. */
export function overdueFrom(dueDate: string, timeZone: string): number {
  return startOfLocalDay(addDays(dueDate, 1), timeZone);
}

/**
 * The start of the due day where the business is — **what "days overdue" is counted from**.
 *
 * Not the same instant as `overdueFrom`, and the difference is a whole day. An invoice becomes late when its
 * due day *ends*, but a person counting says "due on the 6th, it's the 16th, that's ten days" — they count
 * from the date on the invoice, not from midnight after it. Counting elapsed time from `overdueFrom` gives
 * nine, and nine is what a business reads as a bug in our arithmetic. `dueWording` has always counted the
 * person's way; this is the same sum for anything that ticks.
 */
export function dueDayStart(dueDate: string, timeZone: string): number {
  return startOfLocalDay(dueDate, timeZone);
}

/** Past its due day with money still owed, and nothing settling. */
export function invoiceIsOverdue(f: InvoiceStateFacts, now: Date | number): boolean {
  if (!invoiceIsOpen(f.status) || !f.dueDate) return false;
  if (f.balanceCents <= 0 || f.hasProcessingPayment === true) return false;
  const at = typeof now === 'number' ? now : now.getTime();
  return at >= overdueFrom(f.dueDate, f.timeZone);
}

/**
 * What the invoice is called right now: paying beats overdue, and both beat what's stored. A paid invoice
 * whose every paid cent went back is `refunded`; one with money given back beyond anything overpaid is
 * `partly_refunded`. A draft and a voided invoice are what they are.
 */
export function invoiceState(f: InvoiceStateFacts, now: Date | number): InvoiceState {
  if (f.status === 'paid') return paidInvoiceState(f);
  if (!invoiceIsOpen(f.status)) return f.status;
  if (f.hasProcessingPayment === true && f.balanceCents > 0) return 'paying';
  if (invoiceIsOverdue(f, now)) return 'overdue';
  if (f.status !== 'sent') return f.status;
  return f.viewedAt ? 'viewed' : 'sent';
}

/** A paid invoice, and what went back on it. Without the figures there is nothing to say but paid. */
function paidInvoiceState(f: InvoiceStateFacts): 'paid' | 'refunded' | 'partly_refunded' {
  const paid = f.paidCents ?? 0;
  const refunded = f.refundedCents ?? 0;
  if (paid > 0 && refunded >= paid) return 'refunded';
  // Giving back only what was overpaid leaves the bill paid exactly: that's still just paid.
  if (refunded > 0 && f.totalCents !== undefined && paid - refunded < f.totalCents)
    return 'partly_refunded';
  return 'paid';
}

/**
 * The day an estimate sent on `issuedDate` (a local date) stays good through — `estimates.expires_on`, the
 * business's own default unless the document says otherwise. It's a day, not a moment, exactly as an invoice's
 * due day is: the estimate is good until that day is over where the business is (`overdueFrom` gives that
 * instant, and it's how a stored date becomes the `expiresAt` the rules compare).
 */
export function estimateExpiresOn(issuedDate: string, goodForDays: number): string {
  return addDays(issuedDate, Math.max(0, Math.round(goodForDays)));
}

export interface EstimateStateFacts {
  readonly status: EstimateStatus;
  /** When it stops being good, as an instant; null when it never does. */
  readonly expiresAt: string | null;
  /** When the customer first opened it; null when they haven't. */
  readonly viewedAt?: string | null;
}

/** What the estimate is called right now: one past its date reads as expired before the job gets to it. */
export function estimateState(f: EstimateStateFacts, now: Date | number): EstimateState {
  if (!estimateIsOpen(f.status)) return f.status;
  const at = typeof now === 'number' ? now : now.getTime();
  if (f.expiresAt && at >= Date.parse(f.expiresAt)) return 'expired';
  return f.viewedAt ? 'viewed' : f.status;
}
