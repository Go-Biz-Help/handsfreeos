/**
 * Half-open interval algebra on numbers (epoch milliseconds in the engine, minutes-of-week in the rules).
 * An interval is [start, end): back-to-back intervals touch but never overlap.
 * Every list-returning function returns a normalized list: sorted, non-empty, merged when overlapping or touching.
 */

export interface Interval {
  readonly start: number;
  readonly end: number;
}

export type IntervalList = readonly Interval[];

export function interval(start: number, end: number): Interval {
  return { start, end };
}

/** Sort, drop empty intervals, and merge any that overlap or touch. */
export function normalize(list: IntervalList): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) {
      if (i.end > last.end) out[out.length - 1] = { start: last.start, end: i.end };
    } else out.push({ start: i.start, end: i.end });
  }
  return out;
}

export function union(a: IntervalList, b: IntervalList): Interval[] {
  return normalize([...a, ...b]);
}

export function intersect(a: IntervalList, b: IntervalList): Interval[] {
  const x = normalize(a);
  const y = normalize(b);
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    const p = x[i]!;
    const q = y[j]!;
    const start = Math.max(p.start, q.start);
    const end = Math.min(p.end, q.end);
    if (end > start) out.push({ start, end });
    if (p.end < q.end) i++;
    else j++;
  }
  return out;
}

/** Everything in `a` that is not in `b`. */
export function subtract(a: IntervalList, b: IntervalList): Interval[] {
  const x = normalize(a);
  const y = normalize(b);
  const out: Interval[] = [];
  let j = 0;
  for (const p of x) {
    let cursor = p.start;
    while (j < y.length && y[j]!.end <= cursor) j++;
    let k = j;
    while (k < y.length && y[k]!.start < p.end) {
      const q = y[k]!;
      if (q.start > cursor) out.push({ start: cursor, end: q.start });
      cursor = Math.max(cursor, q.end);
      if (cursor >= p.end) break;
      k++;
    }
    if (cursor < p.end) out.push({ start: cursor, end: p.end });
  }
  return out;
}

/** True when two intervals share any time. Touching ends do not overlap. */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Index of the last interval starting at or before `at` in a normalized list, or -1. */
function lastStartingBy(list: IntervalList, at: number): number {
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.start <= at) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** True when any interval of a normalized list overlaps `x`. */
export function overlapsAny(list: IntervalList, x: Interval): boolean {
  if (x.end <= x.start) return false;
  const i = lastStartingBy(list, x.end - 1);
  return i >= 0 && list[i]!.end > x.start;
}

/** True when one interval of a normalized list holds all of `x`. */
export function containsInterval(list: IntervalList, x: Interval): boolean {
  const i = lastStartingBy(list, x.start);
  return i >= 0 && list[i]!.end >= x.end;
}

/** True when a point lies inside a normalized list. */
export function containsPoint(list: IntervalList, at: number): boolean {
  const i = lastStartingBy(list, at);
  return i >= 0 && list[i]!.end > at;
}

/** Keep only the parts of a list inside [from, to). */
export function clip(list: IntervalList, from: number, to: number): Interval[] {
  return intersect(list, [{ start: from, end: to }]);
}

export function totalLength(list: IntervalList): number {
  return normalize(list).reduce((sum, i) => sum + (i.end - i.start), 0);
}

export function longest(list: IntervalList): number {
  return normalize(list).reduce((max, i) => Math.max(max, i.end - i.start), 0);
}
