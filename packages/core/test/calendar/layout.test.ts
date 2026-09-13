import { describe, expect, it } from 'vitest';
import {
  closedStretches,
  instantAt,
  localInstant,
  mergeMinuteSpans,
  minutesToClock,
  overlapLanes,
  placeOnDay,
  snapMinutes,
  visibleHours,
  wallMinutes,
  weekOf,
} from '../../src/calendar/index';

const CHI = 'America/Chicago';
const at = (iso: string) => Date.parse(iso);
const item = (id: string, start: number, end: number) => ({ id, start, end });
const lanes = (items: ReturnType<typeof item>[]) =>
  Object.fromEntries([...overlapLanes(items)].map(([id, p]) => [id, [p.lane, p.lanes]]));

describe('overlap lanes', () => {
  it('gives items that never overlap the full width', () => {
    expect(lanes([item('a', 0, 10), item('b', 10, 20), item('c', 30, 40)])).toEqual({
      a: [0, 1],
      b: [0, 1],
      c: [0, 1],
    });
  });

  it('puts overlapping items side by side', () => {
    expect(lanes([item('a', 0, 60), item('b', 30, 90)])).toEqual({ a: [0, 2], b: [1, 2] });
  });

  it('shares a chained group’s width and reuses a lane once it frees up', () => {
    // a overlaps b, b overlaps c, but a has ended when c starts: c takes a's lane.
    expect(lanes([item('a', 0, 60), item('b', 30, 120), item('c', 60, 90)])).toEqual({
      a: [0, 2],
      b: [1, 2],
      c: [0, 2],
    });
  });

  it('opens a third lane when three overlap at once, and starts fresh after the group', () => {
    expect(
      lanes([item('a', 0, 60), item('b', 10, 60), item('c', 20, 60), item('d', 60, 70)]),
    ).toEqual({ a: [0, 3], b: [1, 3], c: [2, 3], d: [0, 1] });
  });

  it('orders ties longest first, then by id, whatever the input order', () => {
    const one = lanes([item('b', 0, 30), item('a', 0, 30), item('c', 0, 60)]);
    const two = lanes([item('c', 0, 60), item('a', 0, 30), item('b', 0, 30)]);
    expect(one).toEqual({ c: [0, 3], a: [1, 3], b: [2, 3] });
    expect(two).toEqual(one);
  });
});

describe('wall-clock placement in America/Chicago', () => {
  it('reads minutes past midnight in the zone, not the machine’s', () => {
    expect(wallMinutes(at('2026-09-17T14:30:00Z'), CHI)).toBe(9 * 60 + 30);
    expect(wallMinutes(at('2026-01-15T15:00:00Z'), CHI)).toBe(9 * 60);
  });

  it('places an appointment on its day and clips across midnight', () => {
    const start = at('2026-09-17T14:30:00Z'); // 9:30 AM CDT
    const end = at('2026-09-17T15:30:00Z');
    expect(placeOnDay(start, end, '2026-09-17', CHI)).toEqual({ top: 570, bottom: 630 });
    expect(placeOnDay(start, end, '2026-09-18', CHI)).toBeNull();
    const late = at('2026-09-18T04:00:00Z'); // 11 PM CDT on the 17th
    const early = at('2026-09-18T06:00:00Z'); // 1 AM on the 18th
    expect(placeOnDay(late, early, '2026-09-17', CHI)).toEqual({ top: 1380, bottom: 1440 });
    expect(placeOnDay(late, early, '2026-09-18', CHI)).toEqual({ top: 0, bottom: 60 });
  });

  it('keeps wall times on the 23-hour and 25-hour days', () => {
    // Spring forward: 8 AM CDT on 2026-03-08 is still 8 AM on the grid.
    const spring = localInstant('2026-03-08', '08:00', CHI);
    expect(placeOnDay(spring, spring + 3_600_000, '2026-03-08', CHI)).toEqual({
      top: 480,
      bottom: 540,
    });
    // Fall back: the second 1:00 AM (CST) to 2:00 AM CST is an hour long and still an hour tall.
    const second = localInstant('2026-11-01', '01:00', CHI);
    expect(placeOnDay(second, second + 3_600_000, '2026-11-01', CHI)).toEqual({
      top: 60,
      bottom: 120,
    });
    // 1:45 AM CDT to 1:15 AM CST is 30 minutes, but its wall end reads earlier than its start.
    const quarterTo = second - 15 * 60_000;
    expect(placeOnDay(quarterTo, quarterTo + 30 * 60_000, '2026-11-01', CHI)).toEqual({
      top: 105,
      bottom: 135,
    });
  });

  it('turns grid minutes back into instants in the zone', () => {
    expect(new Date(instantAt('2026-09-17', 570, CHI)).toISOString()).toBe(
      '2026-09-17T14:30:00.000Z',
    );
    expect(new Date(instantAt('2026-12-01', 570, CHI)).toISOString()).toBe(
      '2026-12-01T15:30:00.000Z',
    );
    expect(instantAt('2026-09-17', 1440, CHI)).toBe(localInstant('2026-09-18', '00:00', CHI));
    expect(minutesToClock(570)).toBe('09:30');
    expect(minutesToClock(1440)).toBe('24:00');
  });
});

describe('grid helpers', () => {
  it('snaps to 15 minutes by default and stays inside the day', () => {
    expect(snapMinutes(577)).toBe(570);
    expect(snapMinutes(578)).toBe(585);
    expect(snapMinutes(-20)).toBe(0);
    expect(snapMinutes(1500)).toBe(1440);
    expect(snapMinutes(47, 30)).toBe(60);
  });

  it('lists a Monday-first week, across a month end and the fall change', () => {
    expect(weekOf('2026-09-17')).toEqual([
      '2026-09-14',
      '2026-09-15',
      '2026-09-16',
      '2026-09-17',
      '2026-09-18',
      '2026-09-19',
      '2026-09-20',
    ]);
    expect(weekOf('2026-11-01')).toEqual([
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
    ]);
    expect(weekOf('2026-09-14', 0)[0]).toBe('2026-09-13');
  });

  it('widens the visible hours to whatever is on the grid', () => {
    expect(visibleHours([])).toEqual({ from: 7, to: 19 });
    expect(visibleHours([{ top: 6 * 60 + 30, bottom: 8 * 60 }])).toEqual({ from: 6, to: 19 });
    expect(visibleHours([{ top: 20 * 60, bottom: 21 * 60 + 15 }], { from: 8, to: 18 })).toEqual({
      from: 8,
      to: 22,
    });
    expect(visibleHours([{ top: 0, bottom: 1440 }])).toEqual({ from: 0, to: 24 });
  });

  it('merges open spans and shades what is left of the day', () => {
    expect(
      mergeMinuteSpans([
        { top: 780, bottom: 1080 },
        { top: 480, bottom: 720 },
        { top: 700, bottom: 760 },
        { top: 900, bottom: 900 },
      ]),
    ).toEqual([
      { top: 480, bottom: 760 },
      { top: 780, bottom: 1080 },
    ]);
    // 8–12 and 1–6 with a lunch break: closed before, at lunch and after.
    expect(
      closedStretches([
        { top: 480, bottom: 720 },
        { top: 780, bottom: 1080 },
      ]),
    ).toEqual([
      { top: 0, bottom: 480 },
      { top: 720, bottom: 780 },
      { top: 1080, bottom: 1440 },
    ]);
    expect(closedStretches([])).toEqual([{ top: 0, bottom: 1440 }]);
    expect(closedStretches([{ top: 0, bottom: 1440 }])).toEqual([]);
  });
});
