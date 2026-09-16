/**
 * Every state a document can be in, every move it may make, and the two states that are worked out rather than
 * stored: overdue, and the bank transfer that is on its way and therefore isn't late.
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
  invoiceIsOpen,
  invoiceIsOverdue,
  invoiceMoveProblem,
  invoiceState,
  invoiceStatusForPayments,
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
      ['overdue', 'partly_paid'],
      ['overdue', 'paid'],
      ['overdue', 'void'],
    ]);
  });

  it('refunds a paid invoice rather than voiding it', () => {
    expect(invoiceMoveProblem('paid', 'void')).toBe('A paid invoice can’t be voided.');
    expect(INVOICE_TRANSITIONS.paid).toEqual([]);
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

  it('leaves an overdue invoice overdue until it is settled', () => {
    expect(rollup({ status: 'overdue', paidCents: 2_500 })).toBe('overdue');
    expect(rollup({ status: 'overdue', paidCents: 10_000 })).toBe('paid');
  });

  it('leaves a draft, a paid or a voided invoice alone', () => {
    expect(rollup({ status: 'draft', paidCents: 10_000 })).toBe('draft');
    expect(rollup({ status: 'void', paidCents: 10_000 })).toBe('void');
    expect(rollup({ status: 'paid', paidCents: 0 })).toBe('paid');
  });

  it('owes again after a refund', () => {
    expect(rollup({ paidCents: 10_000, refundedCents: 2_500 })).toBe('partly_paid');
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
