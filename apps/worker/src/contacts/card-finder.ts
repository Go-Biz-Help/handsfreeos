/**
 * Finding a business card in a photo by its own edges (Contacts → + → Scan a business card; card-picture.ts
 * straightens what this finds).
 *
 * A card is four straight edges that meet at four corners. So: every clear change of colour in the picture is marked,
 * the straight lines those changes lie along are found (each change votes for the lines through it that run its way:
 * a Hough transform), and every four of them that make a card-shaped outline are tried. The outline whose sides lie
 * on an edge almost all the way round wins, the bigger the better: a card's own outline rather than a logo's box or
 * a band of colour printed on it.
 *
 * Nothing here needs to be told where the card is. The AI's corners only choose between outlines (a card lying on a
 * notebook: which of the two is the card) and say which way up the card reads. Where the AI points is never the crop
 * itself: on the owner's first two cards (17 November 2026) its corners came back on another scale than asked for, a
 * whole card's height too low, and the crop followed them onto the car seat.
 *
 * An outline the AI doesn't point at has to be a clear one, and with none the photo is left as it is: a crop in the
 * wrong place is worse than none.
 *
 * Plain arithmetic on the pixels sharp decodes, like card-picture.ts.
 */
import type { Pt, Quad } from './card-picture';

/** A colour picture: red, green and blue for each pixel, row by row. */
export interface Colour {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** Where the picture's colour changes, and how sharply. */
export interface EdgeMap {
  readonly width: number;
  readonly height: number;
  /** The change across and down, in the colour that changes most there. */
  readonly gx: Float32Array;
  readonly gy: Float32Array;
  readonly mag: Float32Array;
  /** The picture's red, green and blue, each slightly blurred. */
  readonly soft: readonly [Float32Array, Float32Array, Float32Array];
  /** How strong a change counts as an edge in this picture: clear of its grain. */
  readonly level: number;
}

export interface FoundCard {
  /** The corners, going round clockwise, at the edge map's size. */
  readonly corners: Quad;
  /** How much of each side lies on an edge, 0 to 1, for the sides in order. */
  readonly support: readonly number[];
  readonly score: number;
  /** Whether it is the same patch of the picture as the hint. */
  readonly agrees: boolean;
}

/** The longest side the card is looked for at: enough to see its edges, small enough to try every outline. */
export const FIND_CARD_EDGE = 640;

/** The least of a side that has to lie on an edge: a thumb hides up to this much of one. */
const SIDE_MIN = 0.5;
/** …and the least across all four sides. */
const SIDES_MEAN = 0.7;
/** …and what an outline needs when the hint doesn't point at it: no side under this, and this across the four. */
const CLEAR_SIDE = 0.7;
const CLEAR_MEAN = 0.85;
/** The smallest card worth finding, as a share of the picture. */
const AREA_MIN = 0.05;
/** How much of an outline and the hint have to be the same patch of the picture for the hint to choose it. */
const HINT_AGREES = 0.7;
/** The least and the most an edge's strength has to be, whatever the picture's grain. */
const LEVEL_MIN = 3;
const LEVEL_MAX = 14;
/** How far either side of an edge its two colours are compared, in pixels: wider than a pen line or a seam. */
const STEP_REACH = 4;
/** The least the two colours have to differ by: this, or this many times the picture's edge level if that is more. */
const STEP_MIN = 6;
const STEP_LEVELS = 1.6;
/** The breaks in a side's edge a card may have: a thumb or two over it. A row of keys or tiles has more. */
const SIDE_BREAKS = 2;
/** The most of a side that a corner is let off, as a share of the side: a rounded corner, and one hidden corner. */
const CORNER_ROUNDED = 0.12;
const CORNER_HIDDEN = 0.35;
/** How long a stretch with no edge counts as a break, in pixels. */
const BREAK_LENGTH = 6;
/** What an outline loses when it is lighter than its surroundings on some sides and darker on others. */
const ONE_WAY_MISSING = 0.9;
/** The straight lines looked at, most edge pixels first… */
const LINES_TRIED = 160;
/** …and the ones kept to make outlines from, longest unbroken edge first. */
const MAX_LINES = 44;

const cross = (a: Pt, b: Pt): number => a.x * b.y - a.y * b.x;
const dot = (a: Pt, b: Pt): number => a.x * b.x + a.y * b.y;
const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

// ---------- the edges ----------

/** A 3×3 box blur, edges kept. */
function blur(src: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(src);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      out[i] =
        (src[i - w - 1]! +
          src[i - w]! +
          src[i - w + 1]! +
          src[i - 1]! +
          src[i]! +
          src[i + 1]! +
          src[i + w - 1]! +
          src[i + w]! +
          src[i + w + 1]!) /
        9;
    }
  }
  return out;
}

/**
 * The picture's edges: for each pixel, the change in whichever of red, green and blue changes most there (a purple
 * band on a black seat is one grey to a black-and-white eye, and plain in blue).
 */
export function edgeMap(img: Colour): EdgeMap {
  const { width: w, height: h } = img;
  const n = w * h;
  const gx = new Float32Array(n);
  const gy = new Float32Array(n);
  const mag = new Float32Array(n);
  const plane = new Float32Array(n);
  const planes: Float32Array[] = [];
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < n; i++) plane[i] = img.data[i * 3 + c]!;
    const soft = blur(blur(plane, w, h), w, h);
    planes.push(soft);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const sx =
          (soft[i - w + 1]! +
            2 * soft[i + 1]! +
            soft[i + w + 1]! -
            soft[i - w - 1]! -
            2 * soft[i - 1]! -
            soft[i + w - 1]!) /
          4;
        const sy =
          (soft[i + w - 1]! +
            2 * soft[i + w]! +
            soft[i + w + 1]! -
            soft[i - w - 1]! -
            2 * soft[i - w]! -
            soft[i - w + 1]!) /
          4;
        const m = Math.hypot(sx, sy);
        if (m > mag[i]!) {
          gx[i] = sx;
          gy[i] = sy;
          mag[i] = m;
        }
      }
    }
  }
  // An edge is a change that stands clear of the picture's grain: a few times its usual change from pixel to pixel.
  const counts = new Uint32Array(512);
  for (let i = 0; i < n; i++) counts[Math.min(511, Math.round(mag[i]! * 4))]!++;
  let seen = 0;
  let usual = 0;
  for (let b = 0; b < 512; b++) {
    seen += counts[b]!;
    if (seen >= n / 2) {
      usual = b / 4;
      break;
    }
  }
  return {
    width: w,
    height: h,
    gx,
    gy,
    mag,
    soft: planes as unknown as [Float32Array, Float32Array, Float32Array],
    level: Math.max(LEVEL_MIN, Math.min(LEVEL_MAX, 3 * usual + 1)),
  };
}

// ---------- the straight lines ----------

/** A straight line through the picture: a point on it, its direction, and the side that is lighter. */
export interface Line {
  readonly p: Pt;
  readonly d: Pt;
  /** Across the line, pointing at its lighter side. */
  readonly n: Pt;
  /** How far along `d` from `p` its edge was seen, from and to. */
  readonly from: number;
  readonly to: number;
  /** Its longest unbroken stretch of edge, in pixels. */
  readonly unbroken: number;
}

/**
 * Whether an edge crosses the point, running across `n`: 1 when the picture gets lighter along `n`, -1 when darker,
 * 0 with no edge there. An edge is a step from one colour to another, so the colours a little way either side have to
 * differ too: a pen line, a seam or a thin stripe has the same colour both sides and is no edge of a card.
 */
function edgeAt(edges: EdgeMap, bx: number, by: number, n: Pt): number {
  const { width: w, height: h, gx, gy, mag, soft, level } = edges;
  let best = 0;
  let at = 0;
  for (let s = -2; s <= 2; s++) {
    const x = Math.round(bx + n.x * s);
    const y = Math.round(by + n.y * s);
    if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
    const i = y * w + x;
    const m = mag[i]!;
    if (m < level * 0.8) continue;
    const across = gx[i]! * n.x + gy[i]! * n.y;
    if (Math.abs(across) < 0.85 * m) continue;
    if (Math.abs(across) > Math.abs(best)) {
      best = across;
      at = s;
    }
  }
  if (!best) return 0;
  const pixel = (reach: number): number => {
    const x = Math.min(w - 1, Math.max(0, Math.round(bx + n.x * (at + reach))));
    const y = Math.min(h - 1, Math.max(0, Math.round(by + n.y * (at + reach))));
    return y * w + x;
  };
  const ahead = pixel(STEP_REACH);
  const behind = pixel(-STEP_REACH);
  let step = 0;
  for (const plane of soft) step = Math.max(step, Math.abs(plane[ahead]! - plane[behind]!));
  if (step < Math.max(STEP_MIN, STEP_LEVELS * level)) return 0;
  return best > 0 ? 1 : -1;
}

/** The pixels on an edge, thinned to the middle of each. */
function edgePixels(edges: EdgeMap): { xs: Uint16Array; ys: Uint16Array; count: number } {
  const { width: w, height: h, gx, gy, mag, level } = edges;
  const xs = new Uint16Array(w * h);
  const ys = new Uint16Array(w * h);
  let count = 0;
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      const m = mag[i]!;
      if (m < level) continue;
      const dx = Math.round(gx[i]! / m);
      const dy = Math.round(gy[i]! / m);
      if (m < mag[i + dy * w + dx]! || m <= mag[i - dy * w - dx]!) continue;
      xs[count] = x;
      ys[count] = y;
      count++;
    }
  }
  return { xs, ys, count };
}

const SIN: number[] = [];
const COS: number[] = [];
for (let t = 0; t < 360; t++) {
  SIN.push(Math.sin((t * Math.PI) / 180));
  COS.push(Math.cos((t * Math.PI) / 180));
}

/**
 * The straight lines the edge pixels lie along, each fitted through its own pixels, the longest unbroken ones first.
 *
 * Every pixel votes for the lines through it that run its edge's way; the line with the most votes is taken, fitted,
 * and its pixels' votes withdrawn, so the next most-voted line is a different one (and two lines close together are
 * never taken for one).
 */
export function straightLines(edges: EdgeMap): Line[] {
  const { width: w, height: h, gx, gy, mag } = edges;
  const { xs, ys, count } = edgePixels(edges);
  const reach = Math.ceil(Math.hypot(w, h));
  const span = 2 * reach + 1;
  const votes = new Uint16Array(360 * span);
  const turns = new Uint16Array(count);
  const voting = new Uint8Array(count).fill(1);
  const vote = (k: number, by: number): void => {
    for (let o = -3; o <= 3; o++) {
      const t = (turns[k]! + o + 360) % 360;
      votes[t * span + Math.round(xs[k]! * COS[t]! + ys[k]! * SIN[t]!) + reach]! += by;
    }
  };
  for (let k = 0; k < count; k++) {
    const i = ys[k]! * w + xs[k]!;
    turns[k] = (Math.round((Math.atan2(gy[i]!, gx[i]!) * 180) / Math.PI) + 360) % 360;
    vote(k, 1);
  }
  const least = Math.max(20, Math.round(0.07 * Math.min(w, h)));
  let hot: number[] = [];
  for (let at = 0; at < votes.length; at++) if (votes[at]! >= least) hot.push(at);

  const fitted: { p: Pt; d: Pt; n: Pt }[] = [];
  while (fitted.length < LINES_TRIED && hot.length) {
    let top = -1;
    let most = 0;
    const still: number[] = [];
    for (const at of hot) {
      const v = votes[at]!;
      if (v < least) continue;
      still.push(at);
      if (v > most) {
        most = v;
        top = at;
      }
    }
    hot = still;
    if (top < 0) break;
    const t = Math.floor(top / span);
    const r = (top % span) - reach;
    // The pixels on that line whose edge runs its way.
    const on = (nx: number, ny: number, off: number, within: number, agree: number): number[] => {
      const found: number[] = [];
      for (let k = 0; k < count; k++) {
        if (!voting[k]) continue;
        const x = xs[k]!;
        const y = ys[k]!;
        if (Math.abs(x * nx + y * ny - off) > within) continue;
        const i = y * w + x;
        if (gx[i]! * nx + gy[i]! * ny < agree * mag[i]!) continue;
        found.push(k);
      }
      return found;
    };
    const first = on(COS[t]!, SIN[t]!, r, 2.5, 0.97);
    let members = first;
    if (first.length >= least) {
      // Fitted through them, so it lies on the edge to a fraction of a pixel.
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let sxy = 0;
      let syy = 0;
      for (const k of first) {
        const x = xs[k]!;
        const y = ys[k]!;
        sx += x;
        sy += y;
        sxx += x * x;
        sxy += x * y;
        syy += y * y;
      }
      const n0 = first.length;
      const mx = sx / n0;
      const my = sy / n0;
      const angle =
        0.5 * Math.atan2(2 * (sxy / n0 - mx * my), sxx / n0 - mx * mx - (syy / n0 - my * my));
      const d = { x: Math.cos(angle), y: Math.sin(angle) };
      let n = { x: -d.y, y: d.x };
      if (n.x * COS[t]! + n.y * SIN[t]! < 0) n = { x: -n.x, y: -n.y };
      fitted.push({ p: { x: mx, y: my }, d, n });
      members = [...first, ...on(n.x, n.y, mx * n.x + my * n.y, 2, 0.95)];
    }
    for (const k of members) {
      if (!voting[k]) continue;
      voting[k] = 0;
      vote(k, -1);
    }
    // Too few pixels really on it: not a line, and not to be picked again.
    if (first.length < least) votes[top] = 0;
  }

  // Each line walked from one side of the picture to the other: where its edge starts and stops, and its longest
  // stretch that is one unbroken step in colour, lighter side either way (a white card's coloured band keeps the
  // card's edge going). A card's edge is one long stretch; a wood grain's thin stripes are no step at all, and a row
  // of keys or tiles is many short ones.
  const far = Math.hypot(w, h);
  const lines: Line[] = [];
  for (const line of fitted) {
    let from = Infinity;
    let to = -Infinity;
    let longest = 0;
    let run = 0;
    let gap = 0;
    for (let along = -far; along <= far; along += 2) {
      const x = line.p.x + line.d.x * along;
      const y = line.p.y + line.d.y * along;
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
      if (edgeAt(edges, x, y, line.n)) {
        if (gap >= BREAK_LENGTH) run = 0;
        run += 2;
        gap = 0;
        if (run > longest) longest = run;
        if (along < from) from = along;
        to = along;
      } else gap += 2;
    }
    if (longest >= least) lines.push({ ...line, from, to, unbroken: longest });
  }
  lines.sort((a, b) => b.unbroken - a.unbroken);
  // One line for an edge that is lighter on one side along part of it and on the other along the rest.
  const kept: Line[] = [];
  for (const line of lines) {
    if (kept.length >= MAX_LINES) break;
    const middle = (line.from + line.to) / 2;
    const mid = { x: line.p.x + line.d.x * middle, y: line.p.y + line.d.y * middle };
    const twin = kept.some(
      (k) => Math.abs(cross(k.d, line.d)) < 0.035 && Math.abs(dot(sub(mid, k.p), k.n)) < 2,
    );
    if (!twin) kept.push(line);
  }
  return kept;
}

function meet(a: Line, b: Line): Pt | null {
  const den = cross(a.d, b.d);
  if (Math.abs(den) < 1e-6) return null;
  const t = cross(sub(b.p, a.p), b.d) / den;
  return { x: a.p.x + a.d.x * t, y: a.p.y + a.d.y * t };
}

// ---------- the outline ----------

/**
 * How the side from `a` to `b` lies on an edge, at points along it: how many there are and how far apart, at how many
 * the colour gets lighter going in (`n` points into the card) and at how many darker, how many at each end come
 * before the edge starts and after it stops, and how many times the edge breaks off in between.
 */
function sideOnEdge(
  edges: EdgeMap,
  a: Pt,
  b: Pt,
  n: Pt,
): {
  steps: number;
  apart: number;
  lighter: number;
  darker: number;
  lead: number;
  trail: number;
  breaks: number;
} {
  const length = dist(a, b);
  const steps = Math.max(8, Math.floor(length / 2));
  const apart = length / steps;
  let lighter = 0;
  let darker = 0;
  let breaks = 0;
  let gap = 0;
  let lead = steps;
  for (let k = 0; k < steps; k++) {
    const t = (k + 0.5) / steps;
    const way = edgeAt(edges, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, n);
    if (way > 0) lighter++;
    else if (way < 0) darker++;
    if (way) {
      if (lead === steps) lead = k;
      else if (gap * apart >= BREAK_LENGTH) breaks++;
      gap = 0;
    } else gap++;
  }
  return { steps, apart, lighter, darker, lead, trail: lead === steps ? 0 : gap, breaks };
}

/**
 * How much of each side of an outline lies on an edge (0 to 1, the sides in order), and whether the outline is lighter
 * than what's around it on every side or darker on every side. Null when it doesn't lie on edges the way a card's
 * outline does: a side on too little of an edge, or on one that keeps breaking off, or the four together on too
 * little.
 *
 * A corner is let off what both of its sides stop short of it by: that is the corner's own shape, rounded, or for one
 * corner cut off or under a thumb. What one side stops short by on its own counts against it: that side runs on past
 * the card to a line beyond it (a stripe in the table, the edge of a desk), which would otherwise make a bigger
 * outline and win.
 */
function sidesOnEdges(edges: EdgeMap, q: Quad): { support: number[]; oneWay: boolean } | null {
  const centre = {
    x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4,
    y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4,
  };
  const sides = q.map((a, k) => {
    const b = q[(k + 1) % 4]!;
    const along = sub(b, a);
    const length = Math.hypot(along.x, along.y) || 1;
    let n = { x: -along.y / length, y: along.x / length };
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (dot(sub(centre, mid), n) < 0) n = { x: -n.x, y: -n.y };
    return sideOnEdge(edges, a, b, n);
  });
  // What each corner is let off, in pixels. Corner k is where side k starts and the side before it ends.
  const own = sides.map((after, k) => {
    const before = sides[(k + 3) % 4]!;
    return Math.min(before.trail * before.apart, after.lead * after.apart);
  });
  // One corner may be hidden a long way; the others only as far as a rounded corner goes.
  const hidden = own.indexOf(Math.max(...own));
  const support: number[] = [];
  let lighterSides = 0;
  let total = 0;
  for (let k = 0; k < 4; k++) {
    const side = sides[k]!;
    if (side.breaks > SIDE_BREAKS) return null;
    const end = (k + 1) % 4;
    const most = (corner: number) =>
      Math.floor((corner === hidden ? CORNER_HIDDEN : CORNER_ROUNDED) * side.steps);
    const lead = Math.min(side.lead, most(k), Math.floor(own[k]! / side.apart));
    const trail = Math.min(side.trail, most(end), Math.floor(own[end]! / side.apart));
    const on = Math.min(1, (side.lighter + side.darker) / (side.steps - lead - trail));
    if (on < SIDE_MIN) return null;
    support.push(on);
    total += on;
    if (side.lighter >= side.darker) lighterSides++;
  }
  if (total / 4 < SIDES_MEAN) return null;
  return { support, oneWay: lighterSides === 4 || lighterSides === 0 };
}

/** Whether sides lie on edges clearly enough for an outline to be trusted with nothing else pointing at it. */
function clear(support: readonly number[]): boolean {
  const mean = support.reduce((sum, v) => sum + v, 0) / support.length;
  return Math.min(...support) >= CLEAR_SIDE && mean >= CLEAR_MEAN;
}

/** Whether an outline lies clearly on edges, the way a card's does: the finder's own test, for corners from elsewhere. */
export function liesOnEdges(edges: EdgeMap, q: Quad): boolean {
  const sides = sidesOnEdges(edges, q);
  return sides !== null && clear(sides.support);
}

function areaOf(q: readonly Pt[]): number {
  let twice = 0;
  for (let k = 0; k < q.length; k++) twice += cross(q[k]!, q[(k + 1) % q.length]!);
  return Math.abs(twice) / 2;
}

/** The area two outlines share (both convex). */
function shared(a: Quad, b: Quad): number {
  // `a` clipped by each side of `b` in turn (Sutherland–Hodgman).
  const turnsRight = cross(sub(b[1], b[0]), sub(b[2], b[1])) > 0;
  let shape: Pt[] = [...a];
  for (let k = 0; k < 4 && shape.length; k++) {
    const p = b[k]!;
    const side = sub(b[(k + 1) % 4]!, p);
    const inside = (v: Pt) => cross(side, sub(v, p)) >= 0 === turnsRight;
    const next: Pt[] = [];
    for (let i = 0; i < shape.length; i++) {
      const from = shape[i]!;
      const to = shape[(i + 1) % shape.length]!;
      const fromIn = inside(from);
      const toIn = inside(to);
      if (fromIn) next.push(from);
      if (fromIn !== toIn) {
        const step = sub(to, from);
        const den = cross(side, step);
        if (Math.abs(den) > 1e-9) {
          const t = cross(sub(p, from), side) / -den;
          next.push({ x: from.x + step.x * t, y: from.y + step.y * t });
        }
      }
    }
    shape = next;
  }
  return shape.length >= 3 ? areaOf(shape) : 0;
}

/** The part of the outline `a` that outline `b` covers too, as a share of the two together. */
export function overlap(a: Quad, b: Quad): number {
  const both = shared(a, b);
  const either = areaOf(a) + areaOf(b) - both;
  return either > 0 ? both / either : 0;
}

/** How card-like a shape's width over its height is: full marks from a square-ish card to a long thin one. */
function shapeFits(q: Quad): number {
  const across = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2;
  const down = (dist(q[1], q[2]) + dist(q[0], q[3])) / 2;
  const ratio = Math.max(across, down) / Math.max(1, Math.min(across, down));
  if (ratio > 3.2) return 0;
  if (ratio >= 1.25 && ratio <= 2.1) return 1;
  return ratio < 1.25 ? 0.8 : ratio <= 2.6 ? 0.8 : 0.55;
}

/**
 * The card in the picture, or null when no outline is clear enough to trust. `hint` is roughly where something else
 * (the AI) put it, at the edge map's size: the best outline on that patch of the picture is the card, and with none
 * there, the best clear outline anywhere (`agrees` says which it was).
 */
export function findCard(edges: EdgeMap, hint: Quad | null): FoundCard | null {
  const { width: w, height: h } = edges;
  const lines = straightLines(edges);
  const whole = w * h;
  const shortest = 0.06 * Math.min(w, h);
  const outX = 0.08 * w;
  const outY = 0.08 * h;

  // Two lines that could be a card's opposite sides: running nearly the same way.
  const pairs: { i: number; j: number; d: Pt }[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i]!;
      const b = lines[j]!;
      const same = dot(a.d, b.d) >= 0 ? 1 : -1;
      if (Math.abs(cross(a.d, b.d)) > 0.5) continue;
      const sum = { x: a.d.x + same * b.d.x, y: a.d.y + same * b.d.y };
      const l = Math.hypot(sum.x, sum.y) || 1;
      pairs.push({ i, j, d: { x: sum.x / l, y: sum.y / l } });
    }
  }

  let best: FoundCard | null = null;
  let agreed: FoundCard | null = null;
  for (let a = 0; a < pairs.length; a++) {
    for (let b = a + 1; b < pairs.length; b++) {
      const one = pairs[a]!;
      const two = pairs[b]!;
      if (Math.abs(cross(one.d, two.d)) < 0.8) continue;
      if (one.i === two.i || one.i === two.j || one.j === two.i || one.j === two.j) continue;
      const li = lines[one.i]!;
      const lj = lines[one.j]!;
      const lk = lines[two.i]!;
      const ll = lines[two.j]!;
      const c1 = meet(li, lk);
      const c2 = meet(li, ll);
      const c3 = meet(lj, ll);
      const c4 = meet(lj, lk);
      if (!c1 || !c2 || !c3 || !c4) continue;
      const q: Quad = [c1, c2, c3, c4];
      if (q.some((p) => p.x < -outX || p.y < -outY || p.x > w - 1 + outX || p.y > h - 1 + outY))
        continue;
      // Going round one way, no side folded back.
      let turn = 0;
      let folded = false;
      for (let k = 0; k < 4; k++) {
        const t = cross(sub(q[(k + 1) % 4]!, q[k]!), sub(q[(k + 2) % 4]!, q[(k + 1) % 4]!));
        if (Math.abs(t) < 1e-6 || (turn && Math.sign(t) !== turn)) {
          folded = true;
          break;
        }
        turn = Math.sign(t);
      }
      if (folded) continue;
      const side = [dist(c1, c2), dist(c2, c3), dist(c3, c4), dist(c4, c1)];
      if (Math.min(...side) < shortest) continue;
      if (side[0]! / side[2]! > 2 || side[2]! / side[0]! > 2) continue;
      if (side[1]! / side[3]! > 2 || side[3]! / side[1]! > 2) continue;
      const area = areaOf(q);
      if (area < AREA_MIN * whole || area > 0.97 * whole) continue;
      const fits = shapeFits(q);
      if (!fits) continue;
      // Quick first: each side has to run along the part of its line where an edge was seen.
      const onLine = [li, ll, lj, lk];
      let seen = true;
      for (let k = 0; k < 4 && seen; k++) {
        const line = onLine[k]!;
        const s0 = dot(sub(q[k]!, line.p), line.d);
        const s1 = dot(sub(q[(k + 1) % 4]!, line.p), line.d);
        const covered = Math.min(Math.max(s0, s1), line.to) - Math.max(Math.min(s0, s1), line.from);
        if (covered < SIDE_MIN * side[k]!) seen = false;
      }
      if (!seen) continue;

      const sides = sidesOnEdges(edges, q);
      if (!sides) continue;
      const mean =
        (sides.support[0]! + sides.support[1]! + sides.support[2]! + sides.support[3]!) / 4;
      // The bigger the better (a card rather than a box printed on it), on edges all the way round, card-shaped.
      const score =
        mean * mean * Math.sqrt(area / whole) * fits * (sides.oneWay ? 1 : ONE_WAY_MISSING);
      // With nothing pointing at it, an outline has to be a clear one.
      const better = clear(sides.support) && (!best || score > best.score);
      // The hint says which thing in the picture is the card, when an outline bears it out.
      const sameThing =
        hint && (!agreed || score > agreed.score) ? overlap(q, hint) >= HINT_AGREES : false;
      if (!better && !sameThing) continue;
      // Clockwise, as the picture is seen.
      const clockwise = turn > 0;
      const corners: Quad = clockwise ? q : [c1, c4, c3, c2];
      const support = clockwise
        ? sides.support
        : [sides.support[3]!, sides.support[2]!, sides.support[1]!, sides.support[0]!];
      if (better) best = { corners, support, score, agrees: false };
      if (sameThing) agreed = { corners, support, score, agrees: true };
    }
  }
  return agreed ?? best;
}

/**
 * The corners in the order the card reads: top-left, top-right, bottom-right, bottom-left. `like` says which way up
 * that is (the AI's corners, which are in reading order even when they're off the card); with nothing to go by, the
 * card reads the way the picture does.
 */
export function inReadingOrder(
  q: Quad,
  like: Quad | null,
  picture: { width: number; height: number },
): Quad {
  let round: Pt[] = [...q];
  if (cross(sub(round[1]!, round[0]!), sub(round[2]!, round[1]!)) < 0)
    round = [round[0]!, round[3]!, round[2]!, round[1]!];
  const guide: Pt[] = like
    ? [...like]
    : [
        { x: 0, y: 0 },
        { x: picture.width, y: 0 },
        { x: picture.width, y: picture.height },
        { x: 0, y: picture.height },
      ];
  // Each as a shape about its own middle, at its own size, so a guide that's off to one side still says which way up.
  const shape = (pts: readonly Pt[]): Pt[] => {
    const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
    const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
    const size = Math.sqrt(pts.reduce((s, p) => s + (p.x - cx) ** 2 + (p.y - cy) ** 2, 0) / 4) || 1;
    return pts.map((p) => ({ x: (p.x - cx) / size, y: (p.y - cy) / size }));
  };
  const mine = shape(round);
  const theirs = shape(guide);
  let bestTurn = 0;
  let bestOff = Infinity;
  for (let r = 0; r < 4; r++) {
    let off = 0;
    for (let k = 0; k < 4; k++) off += dist(mine[(k + r) % 4]!, theirs[k]!) ** 2;
    if (off < bestOff) {
      bestOff = off;
      bestTurn = r;
    }
  }
  return [0, 1, 2, 3].map((k) => round[(k + bestTurn) % 4]!) as unknown as Quad;
}
