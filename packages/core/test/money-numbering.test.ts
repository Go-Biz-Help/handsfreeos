/** Document numbers, and the one rule that matters: a number never comes round again. */
import { describe, expect, it } from 'vitest';
import {
  formatDocumentNumber,
  NUMBER_PREFIX_MAX,
  nextNumberProblem,
  normalizePrefix,
  numberingChangeProblem,
  numberPreview,
  prefixProblem,
} from '../src/money/index';

describe('a document number', () => {
  it('is the prefix and the counter, padded', () => {
    expect(formatDocumentNumber('LS-', 1_042, 4)).toBe('LS-1042');
    expect(formatDocumentNumber('INV-', 7, 4)).toBe('INV-0007');
    expect(formatDocumentNumber('EST-', 1_001, 4)).toBe('EST-1001');
  });

  it('pads nothing at 0, and never chops a number that outgrew its padding', () => {
    expect(formatDocumentNumber('', 7, 0)).toBe('7');
    expect(formatDocumentNumber('LS-', 123_456, 4)).toBe('LS-123456');
  });

  it('previews what the next document sent will be called', () => {
    expect(numberPreview({ prefix: 'LS-', next: 1_042, pad: 4 })).toBe('LS-1042');
  });

  it('trims a prefix and keeps it within what the counter row holds', () => {
    expect(normalizePrefix('  LS-  ')).toBe('LS-');
    expect(normalizePrefix('X'.repeat(30))).toHaveLength(NUMBER_PREFIX_MAX);
  });
});

describe('what a business may change', () => {
  it('takes any prefix of letters, numbers and hyphens — including none', () => {
    expect(prefixProblem('')).toBeNull();
    expect(prefixProblem('LS-')).toBeNull();
    expect(prefixProblem('2026-')).toBeNull();
    expect(prefixProblem('INV')).toBeNull();
  });

  it('refuses a prefix the counter row couldn’t hold', () => {
    expect(prefixProblem('LS 1')).toBe('A prefix can have letters, numbers and hyphens.');
    expect(prefixProblem('EST_')).toBe('A prefix can have letters, numbers and hyphens.');
    expect(prefixProblem('INV/')).toBe('A prefix can have letters, numbers and hyphens.');
    expect(prefixProblem('A'.repeat(13))).toBe('Keep the prefix under 13 characters.');
  });

  it('moves the next number forward, never back', () => {
    expect(nextNumberProblem(1_042, 1_042)).toBeNull();
    expect(nextNumberProblem(1_042, 2_000)).toBeNull();
    expect(nextNumberProblem(1_042, 1_041)).toBe(
      'The next number only moves forward (it’s at 1042).',
    );
    expect(nextNumberProblem(1_042, 0)).toBe('Enter a whole number, 1 or more.');
    expect(nextNumberProblem(1_042, 1_042.5)).toBe('Enter a whole number, 1 or more.');
    expect(nextNumberProblem(1, 2_000_000_000)).toBe('That number is too long.');
  });

  it('checks a whole change at once: the prefix is free, the number only climbs', () => {
    const current = { prefix: 'INV-', next: 1_042, pad: 4 };
    expect(numberingChangeProblem(current, { ...current, prefix: 'LS-' })).toBeNull();
    expect(numberingChangeProblem(current, { ...current, prefix: 'LS-', pad: 6 })).toBeNull();
    expect(numberingChangeProblem(current, { ...current, next: 900 })).toBe(
      'The next number only moves forward (it’s at 1042).',
    );
    expect(numberingChangeProblem(current, { ...current, prefix: 'LS 1' })).toBe(
      'A prefix can have letters, numbers and hyphens.',
    );
  });
});
