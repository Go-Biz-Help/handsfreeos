/**
 * How often a plan bills, in Square's words. Square names only a few rhythms; every Square plan that wasn't yearly
 * used to be made monthly, so a quarterly plan would have billed every month.
 */
import { describe, expect, it } from 'vitest';
import { planMonths, squareCadenceOf } from '../src/money/plan-cadence';

describe('a plan’s rhythm at Square', () => {
  it('names monthly, quarterly and yearly plans as Square does', () => {
    expect(squareCadenceOf('month', 1)).toBe('MONTHLY');
    expect(squareCadenceOf('quarter', 1)).toBe('QUARTERLY');
    expect(squareCadenceOf('month', 3)).toBe('QUARTERLY');
    expect(squareCadenceOf('year', 1)).toBe('ANNUAL');
  });

  it('names the other whole-month rhythms Square has', () => {
    expect(squareCadenceOf('month', 2)).toBe('EVERY_TWO_MONTHS');
    expect(squareCadenceOf('month', 4)).toBe('EVERY_FOUR_MONTHS');
    expect(squareCadenceOf('quarter', 2)).toBe('EVERY_SIX_MONTHS');
    expect(squareCadenceOf('month', 12)).toBe('ANNUAL');
    expect(squareCadenceOf('year', 2)).toBe('EVERY_TWO_YEARS');
  });

  it('has no name for a rhythm Square can’t bill, rather than the nearest one', () => {
    expect(squareCadenceOf('month', 5)).toBeNull();
    expect(squareCadenceOf('quarter', 3)).toBeNull();
    expect(squareCadenceOf('year', 3)).toBeNull();
  });

  it('counts a cycle in months', () => {
    expect(planMonths('quarter', 2)).toBe(6);
    expect(planMonths('year', 1)).toBe(12);
    expect(planMonths('month', 0)).toBe(1);
  });
});
