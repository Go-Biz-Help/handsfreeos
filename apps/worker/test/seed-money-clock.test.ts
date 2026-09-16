/**
 * The money seed's clock check: every day and hour it could be run at, walked.
 *
 * A seed or a test that books at a fixed hour and reasons backwards from the start has broken this
 * milestone's CI three times. `moneyMoments` is the one place `scripts/seed-money.ts` decides a day or a
 * clock, and `checkMoneyMoments` says what has to be true of them for the story to hold — an invoice ten days
 * past due really being past due where the business is, an estimate out long enough to reach Home and still
 * good, no reminder firing the moment the seed finishes.
 *
 * So this walks **all 336 half-hour slots of a week** through both, and does it again across both daylight
 * saving changes and in every time zone the seeded businesses live in. The seed itself runs the same check
 * and refuses to finish if it fails, so a real `pnpm db:reset` at four in the morning says why rather than
 * quietly telling a different story.
 */
import { describe, expect, it } from 'vitest';
import { checkMoneyMoments, moneyMoments } from '../scripts/seed-money';

const HALF_HOUR = 30 * 60_000;
/** Seven days of half hours: the whole week, every hour and half hour of it. */
const SLOTS = 336;

/** Every slot of the week starting at `from`, and what was wrong at each. */
function walk(from: number, timeZone: string): { slots: number; broken: string[] } {
  const broken: string[] = [];
  for (let i = 0; i < SLOTS; i++) {
    const now = from + i * HALF_HOUR;
    const problems = checkMoneyMoments(moneyMoments(now, timeZone), now, timeZone);
    for (const problem of problems)
      broken.push(`${new Date(now).toISOString()} (${timeZone}): ${problem}`);
  }
  return { slots: SLOTS, broken };
}

/** Where the seeded businesses are, plus UTC and a zone east of it as a guard against a UTC-shaped bug. */
const ZONES = [
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/New_York',
  'UTC',
  'Pacific/Auckland',
];

/** A plain week, and the two weeks a US clock changes in. */
const WEEKS = {
  'an ordinary week': Date.parse('2026-09-14T00:00:00Z'),
  'the week the clocks go forward': Date.parse('2026-03-05T00:00:00Z'),
  'the week the clocks go back': Date.parse('2026-10-29T00:00:00Z'),
  'the week either side of New Year': Date.parse('2026-12-29T00:00:00Z'),
  'the week February ends in': Date.parse('2027-02-24T00:00:00Z'),
};

describe('the money seed holds at any hour', () => {
  for (const [name, from] of Object.entries(WEEKS))
    it(`${name}: all ${SLOTS} half-hour slots, in every seeded time zone`, () => {
      for (const timeZone of ZONES) {
        const { slots, broken } = walk(from, timeZone);
        expect(slots).toBe(SLOTS);
        expect(broken, `${broken.length} of ${SLOTS} slots break in ${timeZone}`).toEqual([]);
      }
    });

  it('says so when a moment really is wrong, rather than passing everything', () => {
    const now = Date.parse('2026-09-16T18:00:00Z');
    const tz = 'America/Chicago';
    const good = moneyMoments(now, tz);
    expect(checkMoneyMoments(good, now, tz)).toEqual([]);
    // An invoice due today is not overdue, whatever the hour: the check must notice.
    const wrong = checkMoneyMoments({ ...good, overdueDueOn: good.today }, now, tz);
    expect(wrong.join(' ')).toMatch(/due day .* has not ended yet/);
    // Nor is an estimate sent this morning one the Action Center would ask anybody about.
    const tooNew = checkMoneyMoments({ ...good, waitingSentDaysAgo: 0 }, now, tz);
    expect(tooNew.join(' ')).toMatch(/has not been out long enough/);
  });
});
