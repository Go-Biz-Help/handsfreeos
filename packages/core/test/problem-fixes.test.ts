/**
 * Problems fixed (support/problem-fixes.ts): each entry the problem check adds can clear what it says, and only reports
 * that need a fix: a version to clear before (or a time), and words a limit never starts with.
 */
import { describe, expect, it } from 'vitest';
import { PROBLEM_FIXES, problemFixReady } from '../src/support/problem-fixes';
import { problemKind } from '../src/support/problem-sort';

describe('the problems fixed', () => {
  it.each(PROBLEM_FIXES.map((fix) => [`${fix.area} ${fix.job} (#${fix.pr})`, fix] as const))(
    '%s names its version, the step, and words that need a fix',
    (_, fix) => {
      expect(problemFixReady(fix)).toBe(true);
      if (fix.fixedIn) expect(fix.fixedIn).toMatch(/^\d{1,6}(\.\d{1,6}){0,3}$/);
      expect(fix.area).toMatch(/^[a-z_]+$/);
      expect(fix.job).toMatch(/^[a-z_.]+$/);
      expect(fix.pr).toBeGreaterThan(0);
      expect(fix.said.length).toBeGreaterThan(10);
      if (fix.note) expect(problemKind({ note: fix.note, helper: null }).kind).toBe('fix');
    },
  );

  it('lists each problem once', () => {
    const keys = PROBLEM_FIXES.map(
      (f) => `${f.source ?? 'extension'} ${f.area} ${f.job} ${f.note ?? ''}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});
