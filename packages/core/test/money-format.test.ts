/**
 * `money` and `moneyRounded` against the five formatters they replace. The four "exact" copies are kept here as
 * they were written, so the test says plainly where the new one agrees with each and where it deliberately
 * doesn't.
 */
import { describe, expect, it } from 'vitest';
import { money, moneyRounded, parseMoney } from '../src/money/index';
import { moneyLabel } from '../src/attention/index';

/** apps/web/src/lib/format.ts */
const webFormatMoney = (cents: number | null | undefined): string => {
  const value = (cents ?? 0) / 100;
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  });
};

/** packages/core/src/attention/chips.ts, before it became a re-export */
const oldMoneyLabel = (cents: number): string => {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(cents / 100);
};

/** apps/web/src/components/booking/format.ts */
const bookingMoney = (cents: number): string => {
  const dollars = cents / 100;
  return Number.isInteger(dollars)
    ? `$${dollars.toLocaleString('en-US')}`
    : `$${dollars.toFixed(2)}`;
};

/** apps/worker/src/workflows/data.ts */
const workflowMoney = (cents: number): string =>
  `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: cents % 100 ? 2 : 0 })}`;

/** apps/worker/src/assistant/tools-read.ts — this one drops the cents on purpose */
const assistantMoney = (cents: number): string =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(cents / 100);

const AMOUNTS = [0, 1, 50, 99, 100, 555, 1_000, 8_900, 12_350, 50_000, 1_850_000, 1_850_050];

describe('money', () => {
  it('shows cents only when there are any', () => {
    expect(money(0)).toBe('$0');
    expect(money(4_000)).toBe('$40');
    expect(money(1_850_000)).toBe('$18,500');
    expect(money(1_850_050)).toBe('$18,500.50');
    expect(money(1)).toBe('$0.01');
  });

  it('reads nothing as $0 rather than $NaN', () => {
    expect(money(null)).toBe('$0');
    expect(money(undefined)).toBe('$0');
    expect(money(Number.NaN)).toBe('$0');
  });

  it('puts the minus in front of the dollar sign', () => {
    expect(money(-4_000)).toBe('-$40');
    expect(money(-8_950)).toBe('-$89.50');
  });

  it('is the Action Center chip formatter, under its old name', () => {
    expect(moneyLabel).toBe(money);
    for (const cents of AMOUNTS) expect(money(cents)).toBe(oldMoneyLabel(cents));
  });

  it('agrees with the web’s formatMoney', () => {
    for (const cents of AMOUNTS) expect(money(cents)).toBe(webFormatMoney(cents));
  });

  it('agrees with the booking page’s money, and groups the thousands it dropped', () => {
    // That copy only grouped whole dollars: anything with cents went through toFixed.
    for (const cents of AMOUNTS.filter((c) => c % 100 === 0 || c < 100_000))
      expect(money(cents)).toBe(bookingMoney(cents));
    expect(bookingMoney(1_850_050)).toBe('$18500.50');
    expect(money(1_850_050)).toBe('$18,500.50');
  });

  it('writes both cents where the workflow copy wrote one', () => {
    expect(workflowMoney(12_350)).toBe('$123.5');
    expect(money(12_350)).toBe('$123.50');
    // And it agrees with that copy everywhere the copy wasn't wrong.
    for (const cents of AMOUNTS.filter((c) => c % 10 !== 0 || c % 100 === 0))
      expect(money(cents)).toBe(workflowMoney(cents));
  });
});

describe('moneyRounded', () => {
  it('is whole dollars, halves up', () => {
    expect(moneyRounded(1_850_050)).toBe('$18,501');
    expect(moneyRounded(8_999)).toBe('$90');
    expect(moneyRounded(50)).toBe('$1');
    expect(moneyRounded(49)).toBe('$0');
    expect(moneyRounded(null)).toBe('$0');
  });

  it('is what the Assistant’s summaries already said', () => {
    for (const cents of [...AMOUNTS, 8_999, 123_456])
      expect(moneyRounded(cents)).toBe(assistantMoney(cents));
  });
});

describe('parseMoney', () => {
  it('reads what people type', () => {
    expect(parseMoney('')).toBe(0);
    expect(parseMoney('12')).toBe(1_200);
    expect(parseMoney('12.5')).toBe(1_250);
    expect(parseMoney('0.07')).toBe(7);
    expect(parseMoney('$1,234.56')).toBe(123_456);
    expect(parseMoney('  89 ')).toBe(8_900);
  });

  it('rounds a third decimal to the nearest cent', () => {
    expect(parseMoney('1234.565')).toBe(123_457);
    expect(parseMoney('1234.564')).toBe(123_456);
    expect(parseMoney('0.005')).toBe(1);
  });

  it('refuses what isn’t an amount', () => {
    expect(parseMoney('abc')).toBeNull();
    expect(parseMoney('1.2.3')).toBeNull();
    expect(parseMoney('-5')).toBeNull();
    expect(parseMoney('$')).toBeNull();
    expect(parseMoney('9'.repeat(13))).toBeNull();
  });
});
