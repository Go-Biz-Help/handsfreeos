/**
 * Every state a document can be in, every move it may make, and the states that are worked out rather than
 * stored: overdue, the bank transfer that is on its way and therefore isn't late, and money given back on a
 * paid invoice — which never makes it owe again.
 */
import { describe, expect, it } from 'vitest';
import {
  canEstimateMove,
  canInvoiceMove,
  canPaymentMove,
  canRefundMove,
  ESTIMATE_STATUSES,
  ESTIMATE_TRANSITIONS,
  estimateExpiresOn,
  estimateIsOpen,
  estimateMoveProblem,
  estimateState,
  INVOICE_STATUSES,
  INVOICE_TRANSITIONS,
  INVOICE_WORDS,
  invoiceIsOpen,
  invoiceIsOverdue,
  invoiceMoveProblem,
  invoiceState,
  invoiceStatusForPayments,
  invoiceVoidBlock,
  isManualPaymentMethod,
  overdueFrom,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  paymentMoveProblem,
  type EstimateStatus,
  type InvoiceStateFacts,
  type InvoiceStatus,
} from '../src/money/index';
import { at, iso, TZ } from './attention-fixtures';

const pairs = <T extends string>(all: readonly T[]): [T, T][] =>
  all.flatMap((from) => all.filter((to) => to !== from).map((to) => [from, to] as [T, T]));

describe('estimate states', () => {
  it('matches app.estimate_status, in order', () => {
    expect(ESTIMATE_STATUSES).toEqual(['draft', 'sent', 'accepted', 'declined', 'expired', 'void']);
  });

  it('allows exactly the legal moves and refuses every other one in words', () => {
    const legal = pairs(ESTIMATE_STATUSES).filter(([from, to]) => canEstimateMove(from, to));
    expect(legal).toEqual([
      ['draft', 'sent'],
      ['draft', 'void'],
      ['sent', 'accepted'],
      ['sent', 'declined'],
      ['sent', 'expired'],
      ['sent', 'void'],
      ['accepted', 'void'],
      ['declined', 'void'],
      ['expired', 'void'],
    ]);
    for (const [from, to] of pairs(ESTIMATE_STATUSES)) {
      const problem = estimateMoveProblem(from, to);
      if (canEstimateMove(from, to)) expect(problem).toBeNull();
      else expect(problem).toMatch(/^A[n]? .+ can’t be .+\.$/);
    }
  });

  it('never goes back to draft, and never leaves void', () => {
    expect(estimateMoveProblem('sent', 'draft')).toBe(
      'A sent estimate can’t be put back to draft.',
    );
    for (const to of ESTIMATE_STATUSES) expect(canEstimateMove('void', to)).toBe(false);
    expect(ESTIMATE_TRANSITIONS.void).toEqual([]);
  });

  it('counts only a sent estimate as waiting on the customer', () => {
    expect(ESTIMATE_STATUSES.filter(estimateIsOpen)).toEqual(['sent']);
  });

  it('does nothing when a move is to where it already is', () => {
    for (const status of ESTIMATE_STATUSES) expect(estimateMoveProblem(status, status)).toBeNull();
  });
});

describe('invoice states', () => {
  it('matches app.invoice_status, in order', () => {
    expect(INVOICE_STATUSES).toEqual(['draft', 'sent', 'partly_paid', 'paid', 'overdue', 'void']);
  });

  it('allows exactly the legal moves', () => {
    const legal = pairs(INVOICE_STATUSES).filter(([from, to]) => canInvoiceMove(from, to));
    expect(legal).toEqual([
      ['draft', 'sent'],
      ['draft', 'void'],
      ['sent', 'partly_paid'],
      ['sent', 'paid'],
      ['sent', 'overdue'],
      ['sent', 'void'],
      ['partly_paid', 'paid'],
      ['partly_paid', 'overdue'],
      ['partly_paid', 'void'],
      ['paid', 'void'],
      ['overdue', 'partly_paid'],
      ['overdue', 'paid'],
      ['overdue', 'void'],
    ]);
  });

  it('never unpays an invoice: a paid one only ever goes to void, and only once the money is back', () => {
    expect(INVOICE_TRANSITIONS.paid).toEqual(['void']);
    expect(invoiceMoveProblem('paid', 'sent')).toBe('A paid invoice can’t be sent again.');
    expect(invoiceMoveProblem('paid', 'partly_paid')).toBe(
      'A paid invoice can’t be marked partly paid.',
    );
    // The move exists; whether the money allows it is the void rule's to say.
    expect(invoiceVoidBlock({ paidCents: 10_000, refundedCents: 0 })).toBe('money_held');
    expect(invoiceVoidBlock({ paidCents: 10_000, refundedCents: 10_000 })).toBeNull();
  });

  it('counts sent, partly paid and overdue as money still expected', () => {
    expect(INVOICE_STATUSES.filter(invoiceIsOpen)).toEqual(['sent', 'partly_paid', 'overdue']);
  });
});

describe('a payment’s status', () => {
  it('only ever moves forward', () => {
    expect(canPaymentMove('requires_payment', 'processing')).toBe(true);
    expect(canPaymentMove('requires_payment', 'succeeded')).toBe(true);
    expect(canPaymentMove('processing', 'succeeded')).toBe(true);
    expect(canPaymentMove('processing', 'requires_payment')).toBe(false);
    expect(canPaymentMove('succeeded', 'failed')).toBe(false);
    expect(paymentMoveProblem('succeeded', 'processing')).toBe(
      'A payment’s status only moves forward.',
    );
  });

  // A bank transfer can soft-fail and settle days later, so failed is not the end of it: the database's
  // rank in 0047 puts succeeded above failed for exactly this, and core says the same.
  it('lets a soft-failed bank transfer still settle', () => {
    expect(canPaymentMove('failed', 'succeeded')).toBe(true);
    expect(canPaymentMove('failed', 'processing')).toBe(false);
    expect(canPaymentMove('failed', 'requires_payment')).toBe(false);
  });

  it('ends at succeeded', () => {
    for (const to of PAYMENT_STATUSES) {
      expect(canPaymentMove('succeeded', to)).toBe(false);
      expect(canPaymentMove('failed', to)).toBe(to === 'succeeded');
    }
    expect(canRefundMove('pending', 'succeeded')).toBe(true);
    expect(canRefundMove('succeeded', 'pending')).toBe(false);
  });

  it('knows which methods a person records by hand', () => {
    expect(PAYMENT_METHODS).toEqual(['card', 'ach', 'cash', 'check', 'other']);
    expect(PAYMENT_METHODS.filter(isManualPaymentMethod)).toEqual(['cash', 'check', 'other']);
  });
});

describe('what a payment does to an invoice', () => {
  const rollup = (over: Partial<Parameters<typeof invoiceStatusForPayments>[0]> = {}) =>
    invoiceStatusForPayments({
      status: 'sent' as InvoiceStatus,
      totalCents: 10_000,
      paidCents: 0,
      refundedCents: 0,
      ...over,
    });

  it('marks it paid when nothing is owed, and partly paid while something is', () => {
    expect(rollup({ paidCents: 10_000 })).toBe('paid');
    expect(rollup({ paidCents: 10_500 })).toBe('paid');
    expect(rollup({ paidCents: 2_500 })).toBe('partly_paid');
    expect(rollup()).toBe('sent');
  });

  // The roll-up in 0053, arm for arm. An overdue invoice with part of it paid is stored as partly paid there,
  // and still reads as overdue on screen: `invoiceState` works lateness out from the day, not from the status.
  it('stores an overdue invoice with part of it paid as partly paid, and paid once it is settled', () => {
    expect(rollup({ status: 'overdue', paidCents: 2_500 })).toBe('partly_paid');
    expect(rollup({ status: 'overdue', paidCents: 10_000 })).toBe('paid');
  });

  it('leaves a draft and a voided invoice alone', () => {
    expect(rollup({ status: 'draft', paidCents: 10_000 })).toBe('draft');
    expect(rollup({ status: 'void', paidCents: 10_000 })).toBe('void');
    // Only if what was paid ever fell, which payments that only move forward can't do.
    expect(rollup({ status: 'paid', paidCents: 0 })).toBe('sent');
  });

  it('never owes again after a refund: paid stays paid, and part paid stays part paid', () => {
    expect(rollup({ status: 'paid', paidCents: 10_000, refundedCents: 2_500 })).toBe('paid');
    expect(rollup({ status: 'paid', paidCents: 10_000, refundedCents: 10_000 })).toBe('paid');
    expect(rollup({ status: 'partly_paid', paidCents: 4_000, refundedCents: 4_000 })).toBe(
      'partly_paid',
    );
  });
});

describe('money given back', () => {
  const paid = (over: Partial<InvoiceStateFacts> = {}): InvoiceStateFacts => ({
    status: 'paid',
    dueDate: '2026-09-20',
    timeZone: TZ,
    balanceCents: 0,
    viewedAt: null,
    hasProcessingPayment: false,
    totalCents: 10_000,
    paidCents: 10_000,
    refundedCents: 0,
    ...over,
  });
  const now = at('2026-10-15', '09:00');

  it('reads as refunded once every paid cent went back, and partly refunded while some of it is kept', () => {
    expect(invoiceState(paid(), now)).toBe('paid');
    expect(invoiceState(paid({ refundedCents: 10_000 }), now)).toBe('refunded');
    expect(invoiceState(paid({ refundedCents: 2_500 }), now)).toBe('partly_refunded');
    expect(INVOICE_WORDS.refunded).toBe('Refunded');
    expect(INVOICE_WORDS.partly_refunded).toBe('Partly refunded');
  });

  it('is still just paid when only an overpayment went back', () => {
    const over = paid({ paidCents: 12_000 });
    expect(invoiceState({ ...over, balanceCents: -2_000 }, now)).toBe('paid');
    expect(invoiceState({ ...over, refundedCents: 2_000 }, now)).toBe('paid');
    // Beyond the overpayment is money the business gave back from the bill itself.
    expect(invoiceState({ ...over, refundedCents: 3_000 }, now)).toBe('partly_refunded');
    expect(invoiceState({ ...over, refundedCents: 12_000 }, now)).toBe('refunded');
  });

  it('leaves an open invoice its own state, and a void one void', () => {
    // Part paid, and that part given back: still waiting on the rest, so it is still what it was.
    const part = paid({ status: 'partly_paid', paidCents: 4_000, refundedCents: 4_000 });
    expect(invoiceState({ ...part, balanceCents: 6_000 }, at('2026-09-18', '09:00'))).toBe(
      'partly_paid',
    );
    expect(invoiceState({ ...part, balanceCents: 6_000 }, now)).toBe('overdue');
    expect(invoiceState(paid({ status: 'void', refundedCents: 10_000 }), now)).toBe('void');
    // Without the figures there is nothing to say but paid.
    expect(
      invoiceState(
        { status: 'paid', dueDate: null, timeZone: TZ, balanceCents: 0, refundedCents: 500 },
        now,
      ),
    ).toBe('paid');
  });

  it('is never overdue once refunded in full, however late the day', () => {
    const refunded = paid({ refundedCents: 10_000 });
    expect(invoiceIsOverdue(refunded, now)).toBe(false);
    expect(invoiceIsOverdue(refunded, at('2027-01-01', '09:00'))).toBe(false);
  });
});

describe('voiding an invoice money has touched', () => {
  it('is allowed once everything paid has gone back, and not while any of it is kept', () => {
    expect(invoiceVoidBlock({ paidCents: 0, refundedCents: 0 })).toBeNull();
    expect(invoiceVoidBlock({ paidCents: 10_000, refundedCents: 10_000 })).toBeNull();
    expect(invoiceVoidBlock({ paidCents: 10_000, refundedCents: 9_999 })).toBe('money_held');
    expect(invoiceVoidBlock({ paidCents: 4_000, refundedCents: 0 })).toBe('money_held');
  });

  it('waits while money is still moving either way', () => {
    expect(invoiceVoidBlock({ paidCents: 0, refundedCents: 0, hasProcessingPayment: true })).toBe(
      'money_moving',
    );
    expect(invoiceVoidBlock({ paidCents: 10_000, refundedCents: 0, hasPendingRefund: true })).toBe(
      'money_moving',
    );
    expect(
      invoiceVoidBlock({ paidCents: 10_000, refundedCents: 10_000, hasPendingRefund: false }),
    ).toBeNull();
  });
});

describe('overdue', () => {
  const invoice = (over: Partial<InvoiceStateFacts> = {}): InvoiceStateFacts => ({
    status: 'sent',
    dueDate: '2026-09-20',
    timeZone: TZ,
    balanceCents: 42_000,
    viewedAt: null,
    hasProcessingPayment: false,
    ...over,
  });

  it('starts at the end of the due day where the business is', () => {
    expect(overdueFrom('2026-09-20', TZ)).toBe(at('2026-09-21', '00:00').getTime());
    expect(invoiceIsOverdue(invoice(), at('2026-09-20', '23:59'))).toBe(false);
    expect(invoiceIsOverdue(invoice(), at('2026-09-21', '00:01'))).toBe(true);
  });

  it('is not overdue while a bank transfer is settling', () => {
    const settling = invoice({ hasProcessingPayment: true });
    expect(invoiceIsOverdue(settling, at('2026-10-01', '09:00'))).toBe(false);
    expect(invoiceState(settling, at('2026-10-01', '09:00'))).toBe('paying');
  });

  it('is not overdue when nothing is owed, or when there is no due date', () => {
    expect(invoiceIsOverdue(invoice({ balanceCents: 0 }), at('2026-10-01', '09:00'))).toBe(false);
    expect(invoiceIsOverdue(invoice({ dueDate: null }), at('2026-10-01', '09:00'))).toBe(false);
    expect(invoiceIsOverdue(invoice({ status: 'paid' }), at('2026-10-01', '09:00'))).toBe(false);
  });

  it('shows what it is called: opened, overdue, paying', () => {
    const now = at('2026-09-18', '09:00');
    expect(invoiceState(invoice(), now)).toBe('sent');
    expect(invoiceState(invoice({ viewedAt: at('2026-09-17', '10:00').toISOString() }), now)).toBe(
      'viewed',
    );
    expect(invoiceState(invoice(), at('2026-09-21', '09:00'))).toBe('overdue');
    expect(invoiceState(invoice({ status: 'partly_paid' }), now)).toBe('partly_paid');
    expect(invoiceState(invoice({ status: 'paid', balanceCents: 0 }), now)).toBe('paid');
    // Marked overdue by the job, with a transfer now on its way: it's paying.
    expect(
      invoiceState(
        invoice({ status: 'overdue', hasProcessingPayment: true }),
        at('2026-10-01', '09:00'),
      ),
    ).toBe('paying');
  });
});

describe('an estimate’s expiry', () => {
  it('is a day, so many days after it went out — the business’s default or the document’s own', () => {
    // estimates.expires_on: a date, like an invoice's due_on, not a moment fourteen days later to the minute.
    expect(estimateExpiresOn('2026-09-16', 14)).toBe('2026-09-30');
    expect(estimateExpiresOn('2026-09-16', 30)).toBe('2026-10-16');
    expect(estimateExpiresOn('2026-09-16', 0)).toBe('2026-09-16');
  });

  it('stays good until that day is over where the business is', () => {
    // The same bridge from a stored day to a moment that an invoice's due day uses.
    const expiresAt = new Date(overdueFrom('2026-09-30', TZ)).toISOString();
    const facts = { status: 'sent' as EstimateStatus, expiresAt, viewedAt: null };
    expect(estimateState(facts, at('2026-09-30', '23:59'))).toBe('sent');
    expect(estimateState(facts, at('2026-10-01', '00:00'))).toBe('expired');
  });

  it('reads as opened once they have looked, and leaves an answered one alone', () => {
    const expiresAt = new Date(overdueFrom('2026-09-30', TZ)).toISOString();
    const facts = { status: 'sent' as EstimateStatus, expiresAt, viewedAt: null };
    expect(
      estimateState(
        { ...facts, viewedAt: iso(at('2026-09-20', '08:00')) },
        at('2026-09-21', '09:00'),
      ),
    ).toBe('viewed');
    expect(estimateState({ ...facts, status: 'accepted' }, at('2026-11-01', '09:00'))).toBe(
      'accepted',
    );
    expect(estimateState({ ...facts, expiresAt: null }, at('2027-01-01', '09:00'))).toBe('sent');
  });
});
