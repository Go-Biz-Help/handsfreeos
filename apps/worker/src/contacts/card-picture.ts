/**
 * A business card's picture, straightened (Contacts → + → Scan a business card; core's `crm/business-card.ts`).
 *
 * The AI says roughly where the card's four corners are. Each edge is then found exactly: across the AI's edge, at
 * points along it, the strongest change from card to background is picked, and a line is fitted through those that
 * agree (so a word or a shadow near the edge doesn't pull it off). Where two edges meet is the corner. The card is
 * then pulled flat, as if seen from straight above, at its true shape (worked out from the way the photo's
 * perspective squeezes it), and only the card is kept.
 *
 * Plain arithmetic on the pixels sharp decodes: no image library beyond sharp, so nothing new to install anywhere.
 */
import sharp from 'sharp';
import type { CardCorners } from '@hfos/core';

export interface Pt {
  readonly x: number;
  readonly y: number;
}
export type Quad = readonly [Pt, Pt, Pt, Pt];

/** A grey picture: one value per pixel, row by row. */
export interface Gray {
  readonly data: Float32Array;
  readonly width: number;
  readonly height: number;
}

/** The longest side the edges are looked for at: plenty to find an edge, quick to search. */
export const FIND_EDGE = 1000;
/** The longest side of the straightened card, at most: sharp enough to read, small enough to keep. */
export const CARD_MAX_EDGE = 1600;
/** …and at least, so a small card in a big picture is still readable. */
export const CARD_MIN_EDGE = 900;
/** The JPEG quality the card is kept at. */
export const CARD_QUALITY = 88;
/** How far inside its edges the card is cut, as a share of its size. */
const INSET = 0.005;

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const len = (a: Pt): number => Math.hypot(a.x, a.y);
const dist = (a: Pt, b: Pt): number => len(sub(a, b));
const cross = (a: Pt, b: Pt): number => a.x * b.y - a.y * b.x;

// ---------- straight lines ----------

/** A line as a point on it and its direction (length 1). */
interface Line {
  readonly p: Pt;
  readonly d: Pt;
}

const lineThrough = (a: Pt, b: Pt): Line => {
  const v = sub(b, a);
  const l = len(v) || 1;
  return { p: a, d: { x: v.x / l, y: v.y / l } };
};

/** Where two lines cross, or null when they run (nearly) side by side. */
export function intersect(a: Line, b: Line): Pt | null {
  const den = cross(a.d, b.d);
  if (Math.abs(den) < 1e-6) return null;
  const t = cross(sub(b.p, a.p), b.d) / den;
  return { x: a.p.x + a.d.x * t, y: a.p.y + a.d.y * t };
}

/** The line closest to all the points (total least squares). */
function fitLine(points: readonly Pt[]): Line {
  const n = points.length;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of points) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { p: { x: mx, y: my }, d: { x: Math.cos(angle), y: Math.sin(angle) } };
}

const offLine = (line: Line, p: Pt): number => Math.abs(cross(line.d, sub(p, line.p)));

/** The same random picks every time, so a card straightens the same way twice. */
function picker(seed: number): (below: number) => number {
  let s = seed >>> 0 || 1;
  return (below) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s % below;
  };
}

/**
 * The line most of the points agree on (RANSAC), refitted through just those, or null when too few agree. It may
 * lean at most `maxTurn` radians from `along`.
 */
function agreedLine(
  points: readonly Pt[],
  along: Pt,
  tolerance: number,
  maxTurn: number,
): Line | null {
  if (points.length < 6) return null;
  const pick = picker(points.length * 7919);
  let best: Pt[] = [];
  for (let i = 0; i < 160; i++) {
    const a = points[pick(points.length)]!;
    const b = points[pick(points.length)]!;
    if (dist(a, b) < 4) continue;
    const line = lineThrough(a, b);
    if (Math.abs(cross(line.d, along)) > Math.sin(maxTurn)) continue;
    const near = points.filter((p) => offLine(line, p) <= tolerance);
    if (near.length > best.length) best = near;
  }
  if (best.length < Math.max(6, points.length * 0.4)) return null;
  const fitted = fitLine(best);
  return Math.abs(cross(fitted.d, along)) > Math.sin(maxTurn) ? null : fitted;
}

// ---------- the edges ----------

/** Brightness change across and down: Sobel on a lightly blurred copy. */
export function gradients(gray: Gray): { gx: Float32Array; gy: Float32Array } {
  const { width: w, height: h } = gray;
  const blurred = blur(blur(gray.data, w, h), w, h);
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const tl = blurred[i - w - 1]!;
      const t = blurred[i - w]!;
      const tr = blurred[i - w + 1]!;
      const l = blurred[i - 1]!;
      const r = blurred[i + 1]!;
      const bl = blurred[i + w - 1]!;
      const b = blurred[i + w]!;
      const br = blurred[i + w + 1]!;
      gx[i] = tr + 2 * r + br - (tl + 2 * l + bl);
      gy[i] = bl + 2 * b + br - (tl + 2 * t + tr);
    }
  }
  return { gx, gy };
}

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
 * Each edge of the card found exactly near where the AI put it, and the corners where they meet. An edge that can't
 * be found keeps the AI's line; a corner that moves further than the search could reach, or a shape that stops being
 * a card, keeps the AI's corners.
 */
export function refineCorners(gray: Gray, rough: Quad): Quad {
  const { width: w, height: h } = gray;
  const { gx, gy } = gradients(gray);
  const band = Math.max(10, Math.round(0.06 * Math.max(w, h)));
  const tolerance = Math.max(1.5, 0.004 * Math.max(w, h));
  const centre = {
    x: rough.reduce((s, p) => s + p.x, 0) / 4,
    y: rough.reduce((s, p) => s + p.y, 0) / 4,
  };

  const lines: Line[] = [];
  for (let k = 0; k < 4; k++) {
    const a = rough[k]!;
    const b = rough[(k + 1) % 4]!;
    const aiLine = lineThrough(a, b);
    const edgeLength = dist(a, b);
    if (edgeLength < 20) {
      lines.push(aiLine);
      continue;
    }
    // The normal pointing into the card.
    let n = { x: -aiLine.d.y, y: aiLine.d.x };
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if ((centre.x - mid.x) * n.x + (centre.y - mid.y) * n.y < 0) n = { x: -n.x, y: -n.y };

    // Along the edge, the strongest rise and the strongest fall in brightness across it.
    const rises: { p: Pt; v: number }[] = [];
    const falls: { p: Pt; v: number }[] = [];
    const samples = 48;
    for (let i = 0; i <= samples; i++) {
      const t = 0.12 + (0.76 * i) / samples;
      const base = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      let rise: { p: Pt; v: number } | null = null;
      let fall: { p: Pt; v: number } | null = null;
      for (let s = -band; s <= band; s++) {
        const x = Math.round(base.x + n.x * s);
        const y = Math.round(base.y + n.y * s);
        if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
        const gxi = gx[y * w + x]!;
        const gyi = gy[y * w + x]!;
        const across = gxi * n.x + gyi * n.y;
        const strength = Math.hypot(gxi, gyi);
        // Only a change that runs along the edge, not across it.
        if (strength < 1e-3 || Math.abs(across) < 0.8 * strength) continue;
        if (across > 0 && (!rise || across > rise.v)) rise = { p: { x, y }, v: across };
        if (across < 0 && (!fall || -across > fall.v)) fall = { p: { x, y }, v: -across };
      }
      if (rise) rises.push(rise);
      if (fall) falls.push(fall);
    }
    // A card is lighter or darker than what it lies on all along an edge: the side whose changes are stronger.
    const total = (list: readonly { v: number }[]) => list.reduce((s, c) => s + c.v, 0);
    const chosen = total(rises) >= total(falls) ? rises : falls;
    const strongest = Math.max(0, ...chosen.map((c) => c.v));
    const points = chosen.filter((c) => c.v >= strongest * 0.2).map((c) => c.p);
    const found = agreedLine(points, aiLine.d, tolerance, (20 * Math.PI) / 180);
    lines.push(found ?? aiLine);
  }

  const refined = rough.map((corner, k) => {
    const met = intersect(lines[(k + 3) % 4]!, lines[k]!);
    return met && dist(met, corner) <= band * 2 ? met : corner;
  }) as unknown as Quad;
  return isCardShaped(refined, w, h) ? refined : rough;
}

/** Four corners that go round one way, with no edge folded back and a sensible size. */
export function isCardShaped(q: Quad, width: number, height: number): boolean {
  let sign = 0;
  for (let k = 0; k < 4; k++) {
    const a = q[k]!;
    const b = q[(k + 1) % 4]!;
    const c = q[(k + 2) % 4]!;
    const turn = cross(sub(b, a), sub(c, b));
    if (Math.abs(turn) < 1e-6) return false;
    const s = Math.sign(turn);
    if (sign && s !== sign) return false;
    sign = s;
  }
  const area = Math.abs(q.reduce((sum, p, i) => sum + cross(p, q[(i + 1) % 4]!), 0)) / 2;
  return area >= 0.02 * width * height;
}

// ---------- pulling it flat ----------

/** The 3×3 map (h33 = 1) taking each `from` point to its `to` point. */
export function homography(from: Quad, to: Quad): number[] {
  // Eight equations in the eight unknowns, solved by elimination.
  const m: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i]!;
    const { x: u, y: v } = to[i]!;
    m.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    m.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++)
      if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    const p = m[col]![col]!;
    if (Math.abs(p) < 1e-12)
      throw new Error('The corners don’t make a shape that can be straightened.');
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = m[r]![col]! / p;
      for (let c = col; c < 9; c++) m[r]![c]! -= f * m[col]![c]!;
    }
  }
  return [...m.map((row, i) => row[8]! / row[i]!), 1];
}

export function project(hm: readonly number[], p: Pt): Pt {
  const z = hm[6]! * p.x + hm[7]! * p.y + hm[8]!;
  return {
    x: (hm[0]! * p.x + hm[1]! * p.y + hm[2]!) / z,
    y: (hm[3]! * p.x + hm[4]! * p.y + hm[5]!) / z,
  };
}

/**
 * The card's true width over its height, from how the photo's perspective squeezes it (Zhang and He, "Whiteboard
 * scanning and image enhancement", 2007), taking the lens's centre as the picture's. Null when it can't be told
 * (a corner placed oddly), and the measured shape is used instead.
 */
export function trueShape(q: Quad, width: number, height: number): number | null {
  const u0 = width / 2;
  const v0 = height / 2;
  // m1 top-left, m2 top-right, m3 bottom-left, m4 bottom-right, as the method numbers them.
  const m1 = [q[0].x, q[0].y, 1];
  const m2 = [q[1].x, q[1].y, 1];
  const m3 = [q[3].x, q[3].y, 1];
  const m4 = [q[2].x, q[2].y, 1];
  const x3 = (a: number[], b: number[]) => [
    a[1]! * b[2]! - a[2]! * b[1]!,
    a[2]! * b[0]! - a[0]! * b[2]!,
    a[0]! * b[1]! - a[1]! * b[0]!,
  ];
  const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  const d2 = dot(x3(m2, m4), m3);
  const d3 = dot(x3(m3, m4), m2);
  if (Math.abs(d2) < 1e-9 || Math.abs(d3) < 1e-9) return null;
  const k2 = dot(x3(m1, m4), m3) / d2;
  const k3 = dot(x3(m1, m4), m2) / d3;
  const n2 = [k2 * m2[0]! - m1[0]!, k2 * m2[1]! - m1[1]!, k2 * m2[2]! - m1[2]!];
  const n3 = [k3 * m3[0]! - m1[0]!, k3 * m3[1]! - m1[1]!, k3 * m3[2]! - m1[2]!];
  const [a1, a2, a3] = n2 as [number, number, number];
  const [b1, b2, b3] = n3 as [number, number, number];
  let ratio: number;
  // Seen almost straight on: no perspective to undo, the shape is as measured along those edges.
  if (Math.abs(a3 * b3) < 1e-9 * Math.max(1, Math.abs(a1 * b1))) {
    ratio = Math.sqrt((a1 * a1 + a2 * a2) / (b1 * b1 + b2 * b2));
  } else {
    const f2 = -((a1 - u0 * a3) * (b1 - u0 * b3) + (a2 - v0 * a3) * (b2 - v0 * b3)) / (a3 * b3);
    if (!(f2 > 0)) return null;
    const norm = (n: readonly number[]) =>
      ((n[0]! - u0 * n[2]!) ** 2 + (n[1]! - v0 * n[2]!) ** 2) / f2 + n[2]! ** 2;
    ratio = Math.sqrt(norm(n2) / norm(n3));
  }
  return Number.isFinite(ratio) && ratio > 0.25 && ratio < 4 ? ratio : null;
}

/** The straightened card's size in pixels: its true shape, about as big as it was in the photo. */
export function cardSize(
  q: Quad,
  width: number,
  height: number,
): { width: number; height: number } {
  const across = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
  const down = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  const measured = across / down;
  const estimated = trueShape(q, width, height);
  // Trusted only when close to what the photo shows: a poor estimate would stretch the card.
  const ratio =
    estimated && estimated / measured < 1.35 && measured / estimated < 1.35 ? estimated : measured;
  const longest = Math.min(CARD_MAX_EDGE, Math.max(CARD_MIN_EDGE, Math.max(across, down)));
  return ratio >= 1
    ? { width: Math.round(longest), height: Math.max(1, Math.round(longest / ratio)) }
    : { width: Math.max(1, Math.round(longest * ratio)), height: Math.round(longest) };
}

/** The card pulled flat into a `out` picture, from RGB pixels; outside the photo is white. */
export function warp(
  rgb: Buffer,
  size: { width: number; height: number },
  corners: Quad,
  out: { width: number; height: number },
): Buffer {
  const { width: w, height: h } = size;
  // A hair inside the edges, so no sliver of the table shows along them.
  const mx = INSET * out.width;
  const my = INSET * out.height;
  const hm = homography(
    [
      { x: -mx, y: -my },
      { x: out.width - 1 + mx, y: -my },
      { x: out.width - 1 + mx, y: out.height - 1 + my },
      { x: -mx, y: out.height - 1 + my },
    ],
    corners,
  );
  const dst = Buffer.alloc(out.width * out.height * 3, 255);
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const z = hm[6]! * x + hm[7]! * y + hm[8]!;
      const sx = (hm[0]! * x + hm[1]! * y + hm[2]!) / z;
      const sy = (hm[3]! * x + hm[4]! * y + hm[5]!) / z;
      if (sx < 0 || sy < 0 || sx > w - 1 || sy > h - 1) continue;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(w - 1, x0 + 1);
      const y1 = Math.min(h - 1, y0 + 1);
      const fx = sx - x0;
      const fy = sy - y0;
      const o = (y * out.width + x) * 3;
      for (let c = 0; c < 3; c++) {
        const top = rgb[(y0 * w + x0) * 3 + c]! * (1 - fx) + rgb[(y0 * w + x1) * 3 + c]! * fx;
        const bottom = rgb[(y1 * w + x0) * 3 + c]! * (1 - fx) + rgb[(y1 * w + x1) * 3 + c]! * fx;
        dst[o + c] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return dst;
}

// ---------- the whole of it ----------

export interface Straightened {
  readonly picture: Buffer;
  readonly width: number;
  readonly height: number;
  /** Where the card's corners ended up, as shares of the picture; null when it wasn't cropped. */
  readonly corners: CardCorners | null;
  readonly cropped: boolean;
}

/** The photo the right way up, as sharp reads it (an iPhone's turn flag applied). */
export async function uprightJpeg(photo: Buffer, longest: number): Promise<Buffer> {
  return sharp(photo, { failOn: 'error' })
    .rotate()
    .resize({ width: longest, height: longest, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
}

/**
 * The card alone, straightened, from the photo and roughly where its corners are (shares of the picture). `refine`
 * finds the edges exactly first: off for corners a person placed by hand, which are kept where they put them. With no
 * corners, the photo comes back as it is.
 */
export async function straightenCard(
  photo: Buffer,
  rough: CardCorners | null,
  options: { readonly refine: boolean },
): Promise<Straightened> {
  const upright = sharp(photo, { failOn: 'error' }).rotate().removeAlpha().toColourspace('srgb');
  const { data: rgb, info } = await upright.clone().raw().toBuffer({ resolveWithObject: true });
  const size = { width: info.width, height: info.height };
  if (!rough) {
    const picture = await sharp(rgb, {
      raw: { width: size.width, height: size.height, channels: 3 },
    })
      .resize({
        width: CARD_MAX_EDGE,
        height: CARD_MAX_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: CARD_QUALITY })
      .toBuffer({ resolveWithObject: true });
    return {
      picture: picture.data,
      width: picture.info.width,
      height: picture.info.height,
      corners: null,
      cropped: false,
    };
  }

  let corners = rough.map((p) => ({
    x: p.x * (size.width - 1),
    y: p.y * (size.height - 1),
  })) as unknown as Quad;
  if (options.refine) {
    const scale = Math.min(1, FIND_EDGE / Math.max(size.width, size.height));
    const small = await upright
      .clone()
      .resize({
        width: Math.round(size.width * scale),
        height: Math.round(size.height * scale),
        fit: 'fill',
      })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const gray: Gray = {
      data: Float32Array.from(small.data),
      width: small.info.width,
      height: small.info.height,
    };
    const sx = (gray.width - 1) / (size.width - 1);
    const sy = (gray.height - 1) / (size.height - 1);
    const found = refineCorners(
      gray,
      corners.map((p) => ({ x: p.x * sx, y: p.y * sy })) as unknown as Quad,
    );
    corners = found.map((p) => ({ x: p.x / sx, y: p.y / sy })) as unknown as Quad;
  }

  const out = cardSize(corners, size.width, size.height);
  const flat = warp(rgb, size, corners, out);
  const picture = await sharp(flat, { raw: { width: out.width, height: out.height, channels: 3 } })
    .jpeg({ quality: CARD_QUALITY })
    .toBuffer();
  const share = (v: number, of: number) => Math.min(1, Math.max(0, v / (of - 1)));
  return {
    picture,
    width: out.width,
    height: out.height,
    corners: corners.map((p) => ({
      x: share(p.x, size.width),
      y: share(p.y, size.height),
    })) as unknown as CardCorners,
    cropped: true,
  };
}
