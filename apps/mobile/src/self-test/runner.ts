/**
 * A tiny assertion runner for the on-device self-test (no Jest). Each case keeps going after a failed check, so a
 * run records every mismatch with what was expected and what the phone produced.
 */

export interface Failure {
  readonly label: string;
  readonly expected: string;
  readonly actual: string;
}

export interface CaseResult {
  readonly group: string;
  readonly name: string;
  readonly source: string;
  readonly ok: boolean;
  readonly checks: number;
  readonly failures: readonly Failure[];
  readonly error: string | null;
  readonly ms: number;
}

export interface Tester {
  /** Strict equality (Object.is), like `toBe`. */
  is(actual: unknown, expected: unknown, label?: string): void;
  /** Deep equality, like `toEqual`. */
  equal(actual: unknown, expected: unknown, label?: string): void;
  /** Every key in `expected` matches, like `toMatchObject`. */
  match(actual: unknown, expected: Record<string, unknown>, label?: string): void;
}

export interface Case {
  readonly group: string;
  readonly name: string;
  /** Where the assertions come from, e.g. `packages/core/test/calendar/zoned.test.ts`. */
  readonly source: string;
  readonly run: (t: Tester) => void;
}

/** JSON with non-ASCII characters escaped, so a narrow no-break space (U+202F) is visible. */
export function show(value: unknown): string {
  const text =
    value === undefined
      ? 'undefined'
      : typeof value === 'number' && !Number.isFinite(value)
        ? String(value)
        : JSON.stringify(value);
  return (text ?? String(value)).replace(
    /[^\x20-\x7e]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

export function runCase(c: Case): CaseResult {
  const failures: Failure[] = [];
  let checks = 0;
  const record = (ok: boolean, label: string | undefined, expected: unknown, actual: unknown) => {
    checks += 1;
    if (!ok) {
      failures.push({
        label: label ?? `check ${checks}`,
        expected: show(expected),
        actual: show(actual),
      });
    }
  };
  const t: Tester = {
    is: (actual, expected, label) => record(Object.is(actual, expected), label, expected, actual),
    equal: (actual, expected, label) =>
      record(deepEqual(actual, expected), label, expected, actual),
    match: (actual, expected, label) => {
      const picked =
        typeof actual === 'object' && actual !== null
          ? Object.fromEntries(
              Object.keys(expected).map((k) => [k, (actual as Record<string, unknown>)[k]]),
            )
          : actual;
      record(deepEqual(picked, expected), label, expected, picked);
    },
  };
  const started = Date.now();
  let error: string | null = null;
  try {
    c.run(t);
  } catch (e) {
    error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  return {
    group: c.group,
    name: c.name,
    source: c.source,
    ok: error === null && failures.length === 0,
    checks,
    failures,
    error,
    ms: Date.now() - started,
  };
}
