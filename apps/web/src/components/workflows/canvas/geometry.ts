/**
 * The shapes of the canvas's edges, from their end points alone: the route, where its "+" (and label) sits,
 * and its arrowhead. Pure, so the drawn edges and the drop targets agree on where every "+" is.
 */
import type { EdgeShape } from './graph';

export interface Pt {
  readonly x: number;
  readonly y: number;
}

export interface EdgeGeometry {
  /** The SVG path, with rounded corners. */
  readonly path: string;
  /** The corners the path runs through, for hit tests. */
  readonly points: readonly Pt[];
  /** Where the edge's "+" and label sit. */
  readonly slot: Pt;
  readonly arrow: string | null;
}

const RADIUS = 8;
/** How far below a split (or above a join) the paths turn. */
const BEND = 18;
const ARROW = { half: 4.5, length: 7 };

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const toward = (from: Pt, to: Pt, by: number): Pt => {
  const d = dist(from, to) || 1;
  return { x: from.x + ((to.x - from.x) * by) / d, y: from.y + ((to.y - from.y) * by) / d };
};
const r1 = (n: number) => Math.round(n * 10) / 10;

/** A polyline as a path with rounded corners. */
export function roundedPath(points: readonly Pt[], radius = RADIUS): string {
  const [first] = points;
  if (!first) return '';
  let d = `M${r1(first.x)},${r1(first.y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]!;
    const corner = points[i]!;
    const next = points[i + 1]!;
    const r = Math.min(radius, dist(prev, corner) / 2, dist(corner, next) / 2);
    const a = toward(corner, prev, r);
    const b = toward(corner, next, r);
    d += ` L${r1(a.x)},${r1(a.y)} Q${r1(corner.x)},${r1(corner.y)} ${r1(b.x)},${r1(b.y)}`;
  }
  const last = points.at(-1)!;
  return `${d} L${r1(last.x)},${r1(last.y)}`;
}

/** An arrowhead whose tip is at `tip`, pointing down (into the top of a node). */
export const arrowDown = (tip: Pt): string =>
  `M${r1(tip.x - ARROW.half)},${r1(tip.y - ARROW.length)} L${r1(tip.x + ARROW.half)},${r1(tip.y - ARROW.length)} L${r1(tip.x)},${r1(tip.y)} Z`;

/** An arrowhead whose tip is at `tip`, pointing left (into the right side of a node). */
export const arrowLeft = (tip: Pt): string =>
  `M${r1(tip.x + ARROW.length)},${r1(tip.y - ARROW.half)} L${r1(tip.x + ARROW.length)},${r1(tip.y + ARROW.half)} L${r1(tip.x)},${r1(tip.y)} Z`;

/**
 * A flow edge from the bottom of its source (`s`) to the top of its target (`t`). Paths leaving a split turn
 * just below it and carry their label on the last stretch; paths running into a join turn just above it and
 * carry their "+" just under their last step.
 */
export function flowGeometry(shape: EdgeShape, s: Pt, t: Pt, arrow = true): EdgeGeometry {
  let points: Pt[];
  let slot: Pt;
  if (Math.abs(s.x - t.x) < 1) {
    points = [s, { x: s.x, y: t.y }];
    slot = { x: s.x, y: (s.y + t.y) / 2 };
  } else {
    const y = shape === 'split' ? s.y + BEND : shape === 'join' ? t.y - BEND : (s.y + t.y) / 2;
    points = [s, { x: s.x, y }, { x: t.x, y }, t];
    slot =
      shape === 'split'
        ? { x: t.x, y: (y + t.y) / 2 }
        : shape === 'join'
          ? { x: s.x, y: s.y + Math.min(22, (y - s.y) / 2) }
          : { x: (s.x + t.x) / 2, y };
  }
  return {
    path: roundedPath(points),
    points,
    slot,
    arrow: arrow ? arrowDown(t) : null,
  };
}

/**
 * A go-to's dashed edge: out of the right side of the go-to, along its own track down the right-hand side
 * of the flow (`trackX`), and back into the right side of the step it goes back to.
 */
export function gotoGeometry(s: Pt, t: Pt, trackX: number): EdgeGeometry {
  const x = Math.max(trackX, s.x + 16, t.x + 16);
  const points = [s, { x, y: s.y }, { x, y: t.y }, t];
  return {
    path: roundedPath(points, 10),
    points,
    slot: { x, y: (s.y + t.y) / 2 },
    arrow: arrowLeft(t),
  };
}

/** How far a point is from a polyline. */
export function distanceToPolyline(p: Pt, points: readonly Pt[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    const k = len2
      ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / len2))
      : 0;
    best = Math.min(best, dist(p, { x: a.x + k * (b.x - a.x), y: a.y + k * (b.y - a.y) }));
  }
  if (points.length === 1) best = dist(p, points[0]!);
  return best;
}

export const distance = dist;

/** Where a mouse or touch event happened, on screen. */
export function clientPoint(event: MouseEvent | TouchEvent): Pt | null {
  if ('changedTouches' in event) {
    const t = event.changedTouches[0] ?? event.touches[0];
    return t ? { x: t.clientX, y: t.clientY } : null;
  }
  return { x: event.clientX, y: event.clientY };
}
