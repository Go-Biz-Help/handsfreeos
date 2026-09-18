/**
 * One document in words (M10 step 16): its lines, its totals block, the line beside its customer, where an estimate
 * stands, a plan's price and states, and the sheet that records cash or a check.
 */
import { describe, expect, it } from 'vitest';
import {
  BALANCE_AFTER_ROW_LABEL,
  DEPOSIT_ROW_LABEL,
  estimateStanding,
  HOW_MUCH_LABEL,
  HOW_PAID_LABEL,
  invoiceStanding,
  lineDiscountLabel,
  lineRateLabel,
  NO_TAX_ON_LINE,
  overBalanceProblem,
  percentLabel,
  planPriceLabel,
  RECORD_CASH_TITLE,
  recordCashNote,
  recordedToast,
  REFERENCE_HINT,
  REFUND_WORDS,
  SUBSCRIPTION_WORDS,
  totalsRows,
  unitWord,
  type TotalsShape,
} from '../src/index';

const TZ = 'America/Chicago';
const NOW = Date.parse('2026-09-22T13:25:00.000Z');

/** Bayou Bistro's invoice from the canvas: $870 labour, $410 refrigerant, 8.25% on the taxed part. */
const bayou: TotalsShape = {
  subtotalCents: 128_000,
  discountCents: 0,
  discountPercentBp: 0,
  taxableBaseCents: 41_000,
  taxRateBp: 825,
  taxLabel: 'TX sales tax',
  taxCents: 3_383,
  totalCents: 131_383,
};

describe('a document’s lines', () => {
  it('makes the unit agree with the quantity, and leaves the ones that never change', () => {
    expect(unitWord(1, 'hour')).toBe('hour');
    expect(unitWord(6, 'hour')).toBe('hours');
    expect(unitWord(16, 'each')).toBe('each');
    expect(unitWord(20, 'sq ft')).toBe('sq ft');
    expect(unitWord(3, 'hours')).toBe('hours');
  });

  it('reads a line’s rate as a sentence', () => {
    expect(lineRateLabel({ quantity: 6, unitLabel: 'hour', unitPriceCents: 14_500 })).toBe(
      '6 hours × $145',
    );
    expect(lineDiscountLabel(4_000)).toBe('−$40 off this line');
    expect(NO_TAX_ON_LINE).toBe('No tax');
  });
});

describe('the totals block', () => {
  it('writes percentages the way people do', () => {
    expect(percentLabel(825)).toBe('8.25%');
    expect(percentLabel(1000)).toBe('10%');
  });

  it('adds the canvas’s invoice up, row for row', () => {
    expect(totalsRows(bayou).map((r) => [r.label, r.value])).toEqual([
      ['Subtotal', '$1,280'],
      ['TX sales tax · 8.25% on $410', '$33.83'],
      ['Total', '$1,313.83'],
    ]);
    expect(totalsRows(bayou)[2]!.big).toBe(true);
  });

  it('names a discount by its percentage when it had one, and otherwise says what it was off', () => {
    expect(
      totalsRows({ ...bayou, discountCents: 5_000, discountPercentBp: 1000 })[1],
    ).toMatchObject({ key: 'discount', label: '10% off, before tax', value: '−$50', credit: true });
    expect(totalsRows({ ...bayou, discountCents: 5_000, discountPercentBp: 0 })[1]!.label).toBe(
      'Off the whole job, before tax',
    );
  });

  it('ends on what is owed once money has landed, and never puts a refund back on the bill', () => {
    const part = totalsRows(bayou, { paidCents: 50_000, balanceCents: 81_383 });
    expect(part.map((r) => r.key)).toEqual(['subtotal', 'tax', 'total', 'paid', 'balance']);
    expect(part.find((r) => r.key === 'paid')).toMatchObject({ value: '−$500', credit: true });
    expect(part.find((r) => r.key === 'balance')).toMatchObject({ value: '$813.83', big: true });
    // Paid in full, then some of it given back: the bill stays settled and the refund reads under it.
    const back = totalsRows(bayou, {
      paidCents: 131_383,
      balanceCents: 0,
      refundedCents: 2_900,
    });
    expect(back.find((r) => r.key === 'refunded')).toMatchObject({
      label: 'Refunded to the customer',
      value: '$29',
    });
    expect(back.find((r) => r.key === 'balance')!.value).toBe('$0');
  });

  it('shows an overpayment given back above what is owed, because it took a credit to nothing', () => {
    const over = totalsRows(bayou, { paidCents: 141_383, balanceCents: 0, refundedCents: 10_000 });
    const keys = over.map((r) => r.key);
    expect(keys.indexOf('overpayment')).toBeLessThan(keys.indexOf('balance'));
    expect(over.find((r) => r.key === 'overpayment')!.value).toBe('$100');
  });

  it('names an estimate’s two extra rows', () => {
    expect(DEPOSIT_ROW_LABEL).toBe('Deposit asked for up front');
    expect(BALANCE_AFTER_ROW_LABEL).toBe('Balance when the work is done');
  });
});

describe('where a document stands', () => {
  it('says when an invoice is due while something is owed, and otherwise how it ended', () => {
    const base = {
      status: 'sent',
      state: 'sent',
      dueOn: '2026-09-25',
      voidedAt: null,
      amountRefundedCents: 0,
    };
    expect(invoiceStanding(base, NOW, TZ)).toBe('Due Fri');
    expect(invoiceStanding({ ...base, status: 'paid', state: 'paid' }, NOW, TZ)).toBe(
      'Paid in full',
    );
    expect(invoiceStanding({ ...base, status: 'paid', state: 'refunded' }, NOW, TZ)).toBe(
      'Refunded in full',
    );
    expect(
      invoiceStanding(
        { ...base, status: 'paid', state: 'partly_refunded', amountRefundedCents: 2_900 },
        NOW,
        TZ,
      ),
    ).toBe('Paid in full · $29 refunded');
    expect(
      invoiceStanding({ ...base, status: 'void', voidedAt: '2026-09-20T15:00:00Z' }, NOW, TZ),
    ).toBe('Voided Sun, Sep 20');
  });

  it('says where an estimate stands in one sentence', () => {
    const base = {
      voidedAt: null,
      acceptedAt: null,
      declinedAt: null,
      sentAt: null,
      firstViewedAt: null,
      createdAt: '2026-09-11T15:00:00Z',
      expiresOn: '2026-09-25',
    };
    expect(estimateStanding(base, NOW, TZ)).toBe('Started Fri, Sep 11 · not sent');
    expect(estimateStanding({ ...base, sentAt: '2026-09-11T15:00:00Z' }, NOW, TZ)).toBe(
      'Sent Fri, Sep 11 · good until Fri, Sep 25',
    );
    expect(
      estimateStanding(
        { ...base, sentAt: '2026-09-11T15:00:00Z', firstViewedAt: '2026-09-12T15:00:00Z' },
        NOW,
        TZ,
      ),
    ).toBe('Sent Fri, Sep 11 · opened · good until Fri, Sep 25');
    expect(estimateStanding({ ...base, acceptedAt: '2026-09-15T15:00:00Z' }, NOW, TZ)).toBe(
      'Approved Tue, Sep 15',
    );
  });
});

describe('plans and refunds', () => {
  it('prices a plan the way it is sold', () => {
    expect(planPriceLabel(2_900, 'month', 1)).toBe('$29 a month');
    expect(planPriceLabel(29_000, 'year', 1)).toBe('$290 a year');
    expect(planPriceLabel(14_900, 'month', 3)).toBe('$149 every 3 months');
  });

  it('names a plan’s and a refund’s states', () => {
    expect(SUBSCRIPTION_WORDS.active).toBe('Billing');
    expect(SUBSCRIPTION_WORDS.past_due).toBe('Payment failed');
    expect(SUBSCRIPTION_WORDS.unmanaged).toBe('Not managed here');
    expect(REFUND_WORDS.pending).toBe('Refunding');
    expect(REFUND_WORDS.failed).toBe('Refund failed');
  });
});

describe('recording cash or a check', () => {
  it('says what it is and how much is owed', () => {
    expect(RECORD_CASH_TITLE).toBe('Record cash or a check');
    expect(recordCashNote(131_383)).toBe('Money taken off the system. $1,313.83 is owed.');
    expect(HOW_MUCH_LABEL).toBe('How much');
    expect(HOW_PAID_LABEL).toBe('How it was paid');
    expect(REFERENCE_HINT).toBe('A check number, say. Optional.');
  });

  it('stops more than is owed before it is ever sent, and says what was recorded', () => {
    expect(overBalanceProblem(131_383)).toBe('That is more than the $1,313.83 owed.');
    expect(recordedToast(131_383)).toBe('$1,313.83 recorded.');
  });
});
