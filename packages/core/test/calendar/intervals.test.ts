import { expect, it } from 'vitest';
import { intervals, type Interval } from '../../src/calendar/index';
import { forSeeds, type Rng } from './random';

const SIZE = 120;
const randomList = (r: Rng): Interval[] =>
  Array.from({ length: r.int(0, 6) }, () => {
    const start = r.int(0, SIZE - 1);
    return { start, end: Math.min(SIZE, start + r.int(0, 30)) };
  });
const bits = (list: readonly Interval[]) => {
  const out = new Array<boolean>(SIZE).fill(false);
  for (const i of list) for (let t = i.start; t < i.end; t++) out[t] = true;
  return out;
};
const isNormal = (list: readonly Interval[]) =>
  list.every((i, k) => i.end > i.start && (k === 0 || i.start > list[k - 1]!.end));

it('matches point sets for normalize, union, intersect and subtract (300 seeds)', () => {
  forSeeds(300, (r) => {
    const a = randomList(r);
    const b = randomList(r);
    const A = bits(a);
    const B = bits(b);
    const n = intervals.normalize(a);
    expect(isNormal(n)).toBe(true);
    expect(bits(n)).toEqual(A);
    for (const [out, want] of [
      [intervals.union(a, b), A.map((x, t) => x || B[t]!)],
      [intervals.intersect(a, b), A.map((x, t) => x && B[t]!)],
      [intervals.subtract(a, b), A.map((x, t) => x && !B[t]!)],
    ] as const) {
      expect(isNormal(out)).toBe(true);
      expect(bits(out)).toEqual(want);
    }
    const x = { start: r.int(0, SIZE - 1), end: 0 };
    x.end = Math.min(SIZE, x.start + r.int(1, 20));
    const span = Array.from({ length: x.end - x.start }, (_, k) => A[x.start + k]!);
    expect(intervals.overlapsAny(n, x)).toBe(span.some(Boolean));
    expect(intervals.containsInterval(n, x)).toBe(span.every(Boolean));
    expect(intervals.containsPoint(n, x.start)).toBe(A[x.start]);
  });
});

it('treats back-to-back as touching, not overlapping', () => {
  expect(intervals.overlaps({ start: 0, end: 10 }, { start: 10, end: 20 })).toBe(false);
  expect(intervals.overlaps({ start: 0, end: 11 }, { start: 10, end: 20 })).toBe(true);
  expect(intervals.normalize([{ start: 10, end: 20 }, { start: 0, end: 10 }])).toEqual([{ start: 0, end: 20 }]);
});
