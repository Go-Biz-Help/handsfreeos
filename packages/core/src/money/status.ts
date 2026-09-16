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
 * - **refunded** is the refunds against it. A refunded invoice stays paid and its balance says the rest.
 *
 * `invoiceState` and `estimateState` work those out for the screen; `invoiceIsOverdue` is what the overdue job
 * and the Action Center's detector both run on.
 */
import { addDays, startOfLocalDay } from '../calendar/engine/zoned';
import { balanceCents } from './totals';

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
 * Where an invoice may go from each state. A paid invoice is refunded, never voided: the money moved, and the
 * ledger has to say so — the refund rows carry that, and the balance follows them.
 */
export const INVOICE_TRANSITIONS: Readonly<Record<InvoiceStatus, readonly InvoiceStatus[]>> = {
  draft: ['sent', 'void'],
  sent: ['partly_paid', 'paid', 'overdue', 'void'],
  partly_paid: ['paid', 'overdue', 'void'],
  overdue: ['partly_paid', 'paid', 'void'],
  paid: [],
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
 * `succeeded` and `failed` are the end of it. (The database guard keeps a late callback quietly rather than
 * raising; this is the same rule for the code that decides what to send it.)
 */
export const PAYMENT_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  requires_payment: ['processing', 'succeeded', 'failed'],
  processing: ['succeeded', 'failed'],
  succeeded: [],
  failed: [],
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
  readonly paidCents: number;
  readonly refundedCents: number;
}

/**
 * What an open invoice becomes once money lands: paid when nothing is owed, partly paid while something is. An
 * overdue invoice stays overdue until it's settled — a dollar on account doesn't make it current — and a draft,
 * paid or voided invoice is left where it is.
 */
export function invoiceStatusForPayments(f: PaymentRollup): InvoiceStatus {
  if (!invoiceIsOpen(f.status)) return f.status;
  const owed = balanceCents(f.totalCents, f.paidCents, f.refundedCents);
  if (owed <= 0 && f.paidCents > 0) return 'paid';
  if (f.paidCents <= 0) return f.status;
  return f.status === 'overdue' ? 'overdue' : 'partly_paid';
}

// ---- Overdue, opened, and paying ----

/** What an invoice looks like on screen: its status, or the state worked out from the day and its payments. */
export type InvoiceState = InvoiceStatus | 'viewed' | 'paying';

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
}

/** The moment an invoice due on `dueDate` becomes late: the end of that day where the business is. */
export function overdueFrom(dueDate: string, timeZone: string): number {
  return startOfLocalDay(addDays(dueDate, 1), timeZone);
}

/** Past its due day with money still owed, and nothing settling. */
export function invoiceIsOverdue(f: InvoiceStateFacts, now: Date | number): boolean {
  if (!invoiceIsOpen(f.status) || !f.dueDate) return false;
  if (f.balanceCents <= 0 || f.hasProcessingPayment === true) return false;
  const at = typeof now === 'number' ? now : now.getTime();
  return at >= overdueFrom(f.dueDate, f.timeZone);
}

/** What the invoice is called right now: paying beats overdue, and both beat what's stored. */
export function invoiceState(f: InvoiceStateFacts, now: Date | number): InvoiceState {
  if (!invoiceIsOpen(f.status)) return f.status;
  if (f.hasProcessingPayment === true && f.balanceCents > 0) return 'paying';
  if (invoiceIsOverdue(f, now)) return 'overdue';
  if (f.status !== 'sent') return f.status;
  return f.viewedAt ? 'viewed' : 'sent';
}

/** When an estimate sent at `sentAt` stops being good. */
export function estimateExpiresAt(sentAt: string, goodForDays: number): string {
  const days = Math.max(0, Math.round(goodForDays));
  return new Date(Date.parse(sentAt) + days * 86_400_000).toISOString();
}

export interface EstimateStateFacts {
  readonly status: EstimateStatus;
  /** When it stops being good; null when it never does. */
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
