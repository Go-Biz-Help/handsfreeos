/**
 * What money is called on screen: every state's name, the wording the customer's page and the messages share,
 * and the sentence a business reads back later ("Approved by Maria Lopez on Tue, Sep 22 at 4:12 PM").
 *
 * Browser-safe and in one place, so the estimate page, the invoice page, the emails, the texts and the audit log
 * all say the same thing. The acceptance sentence is stored with the acceptance word for word: what the customer
 * agreed to has to be readable a year later, even if we reword the page.
 */
import { dayLabel, whenLabel } from '../attention/wording';
import {
  daysBetween,
  localDateOf,
  localInstant,
  weekdayOf,
  zonedParts,
} from '../calendar/engine/zoned';
import { money } from './format';
import type { EstimateState, InvoiceState, PaymentMethod, PaymentStatus } from './status';
import { PAYMENT_TERMS, type PaymentTerms } from './settings';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const at = (now: Date | number | string): number =>
  typeof now === 'number' ? now : typeof now === 'string' ? Date.parse(now) : now.getTime();

/** "Fri" within the coming week, "Fri, Sep 25" beyond it: how people say a date that's soon. */
export function soonLabel(
  when: Date | number | string,
  now: Date | number,
  timeZone: string,
): string {
  const t = at(when);
  const days = daysBetween(localDateOf(at(now), timeZone), localDateOf(t, timeZone));
  if (days < 0 || days > 6) return dayLabel(t, timeZone);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return WEEKDAYS[zonedParts(t, timeZone).weekday] ?? dayLabel(t, timeZone);
}

// ---- What each state is called ----

/** Every state an estimate can be shown in, including the opened one that's worked out rather than stored. */
export const ESTIMATE_WORDS: Readonly<Record<EstimateState, string>> = {
  draft: 'Draft',
  sent: 'Sent',
  viewed: 'Opened',
  accepted: 'Approved',
  declined: 'Declined',
  expired: 'Expired',
  void: 'Void',
};

export const INVOICE_WORDS: Readonly<Record<InvoiceState, string>> = {
  draft: 'Draft',
  sent: 'Sent',
  viewed: 'Opened',
  partly_paid: 'Partly paid',
  paid: 'Paid',
  overdue: 'Overdue',
  paying: 'Paying',
  void: 'Void',
};

export const PAYMENT_STATUS_WORDS: Readonly<Record<PaymentStatus, string>> = {
  requires_payment: 'Not paid',
  processing: 'Paying',
  succeeded: 'Paid',
  failed: 'Failed',
};

/** In a sentence: "Paying — bank transfer". Nobody outside the code says "ACH". */
export const PAYMENT_METHOD_WORDS: Readonly<Record<PaymentMethod, string>> = {
  card: 'card',
  ach: 'bank transfer',
  cash: 'cash',
  check: 'check',
  other: 'another way',
};

/** On a button or in a list: "Bank transfer". */
export const PAYMENT_METHOD_LABELS: Readonly<Record<PaymentMethod, string>> = {
  card: 'Card',
  ach: 'Bank transfer',
  cash: 'Cash',
  check: 'Check',
  other: 'Other',
};

export const TERMS_WORDS: Readonly<Record<PaymentTerms, string>> = {
  due_on_receipt: 'Due on receipt',
  net_7: 'Net 7',
  net_14: 'Net 14',
  net_30: 'Net 30',
};

/** The terms in the order Settings offers them. */
export const TERMS_OPTIONS: readonly { readonly value: PaymentTerms; readonly label: string }[] =
  PAYMENT_TERMS.map((value) => ({ value, label: TERMS_WORDS[value] }));

// ---- The customer's page ----

export const APPROVE_LABEL = 'Approve';
export const DECLINE_LABEL = 'Decline';
export const PAY_LABEL = 'Pay now';
export const TYPED_NAME_LABEL = 'Type your full name';

/**
 * What the customer agrees to when they type their name. Stored with the acceptance, word for word, so the
 * business can show later exactly what was on screen. Change this and old acceptances keep their own wording.
 */
export const ACCEPTANCE_WORDING =
  'By typing your name and choosing Approve, you accept this estimate, the work described and the price shown.';

/** "Approved by Maria Lopez on Tue, Sep 22 at 4:12 PM". */
export function acceptedWording(
  name: string,
  acceptedAt: Date | number | string,
  timeZone: string,
): string {
  return `Approved by ${name.trim() || 'the customer'} on ${whenLabel(at(acceptedAt), timeZone)}`;
}

/** "Declined by Maria Lopez on Tue, Sep 22 at 4:12 PM". */
export function declinedWording(
  name: string,
  declinedAt: Date | number | string,
  timeZone: string,
): string {
  return `Declined by ${name.trim() || 'the customer'} on ${whenLabel(at(declinedAt), timeZone)}`;
}

export interface PayingInput {
  readonly method: PaymentMethod;
  /** When the money is expected to land (a bank transfer takes days); null when it's immediate. */
  readonly expectedAt: Date | number | string | null;
  readonly timeZone: string;
  readonly now: Date | number;
}

/** "Paying — bank transfer, expected by Fri", or "Paying — card" when nothing is being waited on. */
export function payingWording(i: PayingInput): string {
  const method = PAYMENT_METHOD_WORDS[i.method];
  if (i.expectedAt === null) return `Paying — ${method}`;
  return `Paying — ${method}, expected by ${soonLabel(i.expectedAt, i.now, i.timeZone)}`;
}

/** "Paid $1,240 by card on Tue, Sep 22 at 4:12 PM". */
export function paidWording(
  amountCents: number,
  method: PaymentMethod,
  paidAt: Date | number | string,
  timeZone: string,
): string {
  return `Paid ${money(amountCents)} by ${PAYMENT_METHOD_WORDS[method]} on ${whenLabel(at(paidAt), timeZone)}`;
}

/** "$1,240 refunded on Tue, Sep 22". */
export function refundedWording(
  amountCents: number,
  refundedAt: Date | number | string,
  timeZone: string,
): string {
  return `${money(amountCents)} refunded on ${dayLabel(at(refundedAt), timeZone)}`;
}

/** "Due today", "Due Fri", "Due Fri, Oct 24", "3 days overdue", "No due date". */
export function dueWording(dueDate: string | null, now: Date | number, timeZone: string): string {
  if (!dueDate) return 'No due date';
  const today = localDateOf(at(now), timeZone);
  const days = daysBetween(today, dueDate);
  if (days < 0) {
    const late = -days;
    return `${late} ${late === 1 ? 'day' : 'days'} overdue`;
  }
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  const midday = localInstant(dueDate, '12:00', timeZone);
  if (days <= 6) return `Due ${WEEKDAYS[weekdayOf(dueDate)] ?? dayLabel(midday, timeZone)}`;
  return `Due ${dayLabel(midday, timeZone)}`;
}

/** "Good through Fri, Oct 24", "Expires today", "Expired". */
export function expiryWording(
  expiresAt: string | null,
  now: Date | number,
  timeZone: string,
): string {
  if (!expiresAt) return 'No expiry';
  const today = localDateOf(at(now), timeZone);
  const days = daysBetween(today, localDateOf(at(expiresAt), timeZone));
  if (days < 0) return 'Expired';
  if (days === 0) return 'Expires today';
  if (days === 1) return 'Expires tomorrow';
  return `Good through ${dayLabel(at(expiresAt), timeZone)}`;
}

/** "$1,240 owed" — what the Action Center's card and the customer's page both say about a balance. */
export function owedWording(balanceCents: number): string {
  return `${money(balanceCents)} owed`;
}

/** "$8,400 quoted" — an estimate's amount, which isn't owed by anyone yet. */
export function quotedWording(totalCents: number): string {
  return `${money(totalCents)} quoted`;
}
