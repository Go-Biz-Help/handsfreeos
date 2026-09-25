/**
 * The on-device self-test's cases (Settings → Test tools → Self-test), run here on Node, whose V8 gives the values the
 * cases expect. A phone's own time-zone data can be older than core's: the Android 14 image the Maestro flows run on
 * still has Asia/Qostanay on UTC+6, which Kazakhstan left for UTC+5 in 2024 (tzdb 2024b). That is simulated below by
 * handing Intl Asia/Omsk, UTC+6 all year, whenever it is asked for Asia/Qostanay.
 */
import type { Case, CaseResult } from '../runner';

const PROBE =
  'every zone on core’s list formats on this phone, and older names keep their zone’s clock';

/** Runs the named case with a fresh copy of core, so no formatter made before the swap below is reused. */
function run(name: string): CaseResult {
  let result: CaseResult | undefined;
  jest.isolateModules(() => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { CASES } = require('../cases') as { CASES: readonly Case[] };
    const { runCase } = require('../runner') as { runCase: (c: Case) => CaseResult };
    /* eslint-enable @typescript-eslint/no-require-imports */
    result = runCase(CASES.find((c) => c.name === name)!);
  });
  return result!;
}

describe('the self-test', () => {
  it('passes the zone probe on Node', () => {
    const result = run(PROBE);
    expect(result.error).toBeNull();
    expect(result.failures).toEqual([]);
  });

  it('passes on a phone whose own data has a zone on its old clock, and says which', () => {
    const Real = Intl.DateTimeFormat;
    const Older = function DateTimeFormat(
      locales?: string | string[],
      options?: Intl.DateTimeFormatOptions,
    ) {
      return new Real(
        locales,
        options?.timeZone === 'Asia/Qostanay' ? { ...options, timeZone: 'Asia/Omsk' } : options,
      );
    } as unknown as typeof Intl.DateTimeFormat;
    Older.supportedLocalesOf = Real.supportedLocalesOf;
    Intl.DateTimeFormat = Older;
    try {
      const result = run(PROBE);
      expect(result.error).toBeNull();
      expect(result.failures).toEqual([]);
      expect(result.notes.join('\n')).toContain('Asia/Aqtobe for Asia/Qostanay');
    } finally {
      Intl.DateTimeFormat = Real;
    }
  });
});
