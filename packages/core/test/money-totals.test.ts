/**
 * The arithmetic everything else trusts. Every figure here was worked out by hand: if one of these changes, a
 * customer's invoice changed with it.
 */
import { describe, expect, it } from 'vitest';
import {
  allocateDiscount,
  balanceCents,
  computeTotals,
  depositCentsOf,
  depositProblem,
  discountCentsOf,
  lineAmountCents,
  lineSubtotalCents,
  quantityThousandths,
  roundHalfUp,
  taxCentsOf,
  type MoneyLine,
} from '../src/money/index';

const TEXAS = 825; // 8.25% in basis points

describe('rounding', () => {
  it('rounds halves away from zero, and never returns -0', () => {
    expect(roundHalfUp(2.5)).toBe(3);
    expect(roundHalfUp(2.4999)).toBe(2);
    expect(roundHalfUp(-2.5)).toBe(-3);
    expect(roundHalfUp(-0.4)).toBe(0);
    expect(Object.is(roundHalfUp(-0.4), -0)).toBe(false);
  });

  it('treats nothing, NaN and infinity as zero rather than throwing', () => {
    expect(roundHalfUp(Number.NaN)).toBe(0);
    expect(roundHalfUp(Number.POSITIVE_INFINITY)).toBe(0);
    expect(lineAmountCents(Number.NaN, 5_000)).toBe(0);
    expect(computeTotals({ lines: [] }).totalCents).toBe(0);
  });
});

describe('a line', () => {
  it('rounds the line once, not the pennies inside it', () => {
    // 3 × $3.33 is exactly $9.99: a per-penny rounding would drift.
    expect(lineAmountCents(3, 333)).toBe(999);
    expect(lineAmountCents(1.5, 1)).toBe(2);
    expect(lineAmountCents(0.5, 1)).toBe(1);
  });

  it('is exact at three decimal places, where multiplying doubles is not', () => {
    // 1.005 × 100 is 100.5 cents. In floating point 1.005 * 100 is 100.49999999999999.
    expect(lineAmountCents(1.005, 100)).toBe(101);
    expect(1.005 * 100).toBeLessThan(100.5);
    expect(lineAmountCents(2.125, 9_500)).toBe(20_188); // 20,187.5 → half up
    expect(lineAmountCents(0.333, 29_999)).toBe(9_990); // 9,989.667
  });

  it('takes quantities to the nearest thousandth and refuses negative ones', () => {
    expect(quantityThousandths(1.2345)).toBe(1_235);
    expect(quantityThousandths(-4)).toBe(0);
    expect(lineAmountCents(1.2345, 100)).toBe(124);
  });

  it('never lets a line discount take the line below zero', () => {
    expect(lineSubtotalCents({ quantity: 1, unitPriceCents: 1_000, discountCents: 250 })).toBe(750);
    expect(lineSubtotalCents({ quantity: 1, unitPriceCents: 1_000, discountCents: 5_000 })).toBe(0);
    const totals = computeTotals({
      lines: [{ quantity: 1, unitPriceCents: 1_000, discountCents: 5_000 }],
    });
    expect(totals.lines[0]).toMatchObject({
      amountCents: 1_000,
      discountCents: 1_000,
      subtotalCents: 0,
    });
    expect(totals.totalCents).toBe(0);
  });
});

describe('tax', () => {
  it('rounds once for the document, not once per line', () => {
    const lines: MoneyLine[] = [1, 2, 3].map(() => ({
      quantity: 1,
      unitPriceCents: 1_010,
      taxable: true,
    }));
    const perLine = lines.reduce((sum) => sum + taxCentsOf(1_010, TEXAS), 0);
    expect(perLine).toBe(249); // 83.325 → 83, three times
    expect(computeTotals({ lines, taxRateBp: TEXAS }).taxCents).toBe(250); // 249.975 → 250
  });

  it('taxes only the taxable lines', () => {
    const totals = computeTotals({
      lines: [
        { quantity: 2, unitPriceCents: 4_999, taxable: true }, // parts, $99.98
        { quantity: 3.5, unitPriceCents: 9_000, taxable: false }, // labour, $315.00
      ],
      taxRateBp: TEXAS,
    });
    expect(totals.lineSubtotalCents).toBe(41_498);
    expect(totals.taxableBaseCents).toBe(9_998);
    expect(totals.taxCents).toBe(825); // 824.835 → 825
    expect(totals.totalCents).toBe(42_323);
  });

  it('taxes a line unless it says otherwise, the way the database does', () => {
    const totals = computeTotals({
      lines: [{ quantity: 1, unitPriceCents: 10_000 }],
      taxRateBp: 1_000,
    });
    expect(totals.lines[0]?.taxable).toBe(true);
    expect(totals.taxCents).toBe(1_000);
  });

  it('taxes what is left after a line discount', () => {
    const totals = computeTotals({
      lines: [{ quantity: 1, unitPriceCents: 10_000, discountCents: 1_500, taxable: true }],
      taxRateBp: TEXAS,
    });
    expect(totals.subtotalCents).toBe(8_500);
    expect(totals.taxCents).toBe(701); // 701.25 → 701
    expect(totals.totalCents).toBe(9_201);
  });
});

describe('a document discount', () => {
  it('shares evenly when it can', () => {
    expect(allocateDiscount([1_000, 1_000], 200)).toEqual([100, 100]);
  });

  it('gives the odd penny to the largest line', () => {
    expect(allocateDiscount([1_000, 1_000, 1_000], 100)).toEqual([34, 33, 33]);
    expect(allocateDiscount([1_000, 2_000, 3_001], 1_000)).toEqual([166, 333, 501]);
  });

  it('always adds up to the discount', () => {
    for (const discount of [1, 7, 99, 100, 333, 1_000]) {
      const shares = allocateDiscount([1_234, 999, 5_678, 0], discount);
      expect(shares.reduce((a, b) => a + b, 0)).toBe(discount);
    }
  });

  it('gives nothing to a line worth nothing', () => {
    expect(allocateDiscount([0, 1_000], 100)).toEqual([0, 100]);
    expect(allocateDiscount([0, 0], 100)).toEqual([0, 0]);
  });

  it('is never more than the lines come to', () => {
    expect(discountCentsOf({ kind: 'amount', amountCents: 5_000 }, 1_000)).toBe(1_000);
    const totals = computeTotals({
      lines: [{ quantity: 1, unitPriceCents: 1_000 }],
      discount: { kind: 'amount', amountCents: 5_000 },
      taxRateBp: TEXAS,
    });
    expect(totals.discountCents).toBe(1_000);
    expect(totals.subtotalCents).toBe(0);
    expect(totals.taxCents).toBe(0);
  });

  it('comes off before tax, across taxable and non-taxable lines alike', () => {
    const totals = computeTotals({
      lines: [
        { quantity: 1, unitPriceCents: 1_000, taxable: true },
        { quantity: 1, unitPriceCents: 2_000, taxable: false },
      ],
      discount: { kind: 'percent', percentBp: 1_000 }, // 10% of $30.00
      taxRateBp: TEXAS,
    });
    expect(totals.discountCents).toBe(300);
    expect(totals.lines.map((l) => l.allocatedCents)).toEqual([100, 200]);
    expect(totals.lines.map((l) => l.netCents)).toEqual([900, 1_800]);
    expect(totals.taxableBaseCents).toBe(900);
    expect(totals.taxCents).toBe(74); // 74.25 → 74
    expect(totals.totalCents).toBe(2_774);
  });

  it('shares a percentage that does not divide evenly, remainder to the largest', () => {
    const totals = computeTotals({
      lines: [
        { quantity: 1, unitPriceCents: 3_333, taxable: true },
        { quantity: 1, unitPriceCents: 3_333, taxable: false },
        { quantity: 1, unitPriceCents: 3_334, taxable: true },
      ],
      discount: { kind: 'percent', percentBp: 1_500 }, // 15% of $100.00 = $15.00
    });
    expect(totals.discountCents).toBe(1_500);
    const shares = totals.lines.map((l) => l.allocatedCents);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(1_500);
    expect(shares).toEqual([499, 499, 502]);
    expect(totals.subtotalCents).toBe(8_500);
  });
});

describe('the deposit', () => {
  it('rounds a percentage of the total to the cent', () => {
    expect(depositCentsOf({ kind: 'percent', percentBp: 2_500 }, 10_033)).toBe(2_508); // 2,508.25
    expect(depositCentsOf({ kind: 'percent', percentBp: 3_333 }, 10_033)).toBe(3_344); // 3,343.9989
    expect(depositCentsOf({ kind: 'none' }, 10_033)).toBe(0);
  });

  it('refuses one larger than the total, and never charges more than it either way', () => {
    expect(depositProblem({ kind: 'amount', amountCents: 20_000 }, 10_033)).toBe(
      'A deposit can’t be more than the total.',
    );
    expect(depositCentsOf({ kind: 'amount', amountCents: 20_000 }, 10_033)).toBe(10_033);
    expect(depositProblem({ kind: 'amount', amountCents: 10_033 }, 10_033)).toBeNull();
    expect(depositProblem({ kind: 'percent', percentBp: 10_000 }, 10_033)).toBeNull();
    expect(depositProblem({ kind: 'percent', percentBp: 12_000 }, 10_033)).toBe(
      'A deposit can’t be more than the whole total.',
    );
  });

  it('refuses one with no figure in it', () => {
    expect(depositProblem({ kind: 'amount', amountCents: 0 }, 10_000)).toBe(
      'Set how much the deposit is.',
    );
    expect(depositProblem({ kind: 'percent', percentBp: 0 }, 10_000)).toBe(
      'Set how much of the total the deposit is.',
    );
    expect(depositProblem({ kind: 'none' }, 10_000)).toBeNull();
  });

  it('is worked out on the total, tax and all', () => {
    const totals = computeTotals({
      lines: [{ quantity: 1, unitPriceCents: 100_000, taxable: true }],
      taxRateBp: TEXAS,
      deposit: { kind: 'percent', percentBp: 2_500 },
    });
    expect(totals.totalCents).toBe(108_250);
    expect(totals.depositCents).toBe(27_063); // 27,062.5 → half up
  });
});

describe('the balance', () => {
  it('is what is owed after payments and refunds', () => {
    expect(balanceCents(10_000, 0, 0)).toBe(10_000);
    expect(balanceCents(10_000, 10_000, 0)).toBe(0);
    expect(balanceCents(10_000, 10_000, 2_500)).toBe(2_500);
    expect(balanceCents(10_000, 12_000, 0)).toBe(-2_000);
  });

  it('comes out of computeTotals with the payments on it', () => {
    const totals = computeTotals({
      lines: [{ quantity: 4, unitPriceCents: 12_500, taxable: false }],
      paidCents: 20_000,
      refundedCents: 5_000,
    });
    expect(totals.totalCents).toBe(50_000);
    expect(totals.balanceCents).toBe(35_000);
  });
});

describe('a whole document', () => {
  it('adds up: mixed lines, a deposit, a document discount and tax', () => {
    const totals = computeTotals({
      lines: [
        { quantity: 1, unitPriceCents: 489_900, taxable: true }, // the unit
        { quantity: 6.5, unitPriceCents: 12_500, taxable: false }, // labour, $812.50
        { quantity: 3, unitPriceCents: 333, taxable: true }, // sundries, $9.99
      ],
      discount: { kind: 'percent', percentBp: 1_000 },
      taxRateBp: TEXAS,
      deposit: { kind: 'percent', percentBp: 2_500 },
      paidCents: 100_000,
    });
    expect(totals.lineSubtotalCents).toBe(572_149); // 4,899.00 + 812.50 + 9.99
    expect(totals.discountCents).toBe(57_215); // 10% of it: 57,214.9 → half up
    expect(totals.lines.map((l) => l.allocatedCents)).toEqual([48_991, 8_125, 99]);
    expect(totals.lines.map((l) => l.netCents)).toEqual([440_909, 73_125, 900]);
    expect(totals.subtotalCents).toBe(514_934);
    expect(totals.taxableBaseCents).toBe(441_809); // the unit and the sundries, after their share
    expect(totals.taxCents).toBe(36_449); // 36,449.24 → 36,449
    expect(totals.totalCents).toBe(551_383);
    expect(totals.depositCents).toBe(137_846); // a quarter of the total
    expect(totals.balanceCents).toBe(451_383);
  });

  it('adds back up: every line’s net plus the tax is the total', () => {
    const totals = computeTotals({
      lines: [
        { quantity: 2.75, unitPriceCents: 7_777, taxable: true },
        { quantity: 1, unitPriceCents: 45, taxable: false },
        { quantity: 13, unitPriceCents: 101, taxable: true },
      ],
      discount: { kind: 'amount', amountCents: 999 },
      taxRateBp: 637,
    });
    const nets = totals.lines.reduce((sum, l) => sum + l.netCents, 0);
    expect(nets).toBe(totals.subtotalCents);
    expect(totals.subtotalCents + totals.taxCents).toBe(totals.totalCents);
  });
});
