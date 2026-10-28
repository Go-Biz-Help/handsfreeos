/**
 * What's read off a document's PDF (docs/documents.md): its words a line at a time, for typing over them (26c), and
 * the lines and small boxes drawn on its pages, for the AI placing the fields (4a).
 *
 * pdf.js does the reading wherever it runs: the browser's copy on the web, and the worker's for the phone, which
 * draws the pages the phone shows (apps/worker/src/documents/pages.ts). What's done with what it reads is here, once,
 * so both find the same lines and spots. Browser-safe.
 */
import type { DocumentFont } from './definition';
import type { DocumentPageBox, DocumentPageText } from './place';

// ---------- the words ----------

/** As much of a pdf.js page as reading its words needs: the browser's build and the worker's both fit it. */
export interface PdfTextPage {
  getViewport(params: { scale: number }): {
    readonly width: number;
    readonly height: number;
    readonly transform: number[];
  };
  getTextContent(): Promise<{
    readonly items: readonly object[];
    readonly styles: Readonly<
      Record<string, { ascent?: number; descent?: number; fontFamily?: string }>
    >;
  }>;
  /** The fonts, once the page is drawn: "ABCDEF+Arial-BoldMT". */
  readonly commonObjs: unknown;
}

/** A line of words on a page, where it sits (fractions of the page, from the top left) and how it's written. */
export interface DocumentTextLine extends DocumentPageText {
  /** In points. */
  readonly size: number;
  readonly font: DocumentFont;
  readonly bold: boolean;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Two of pdf.js's transforms, one after the other (its `Util.transform`). */
function transform(m1: readonly number[], m2: readonly number[]): number[] {
  const [a1 = 1, b1 = 0, c1 = 0, d1 = 1, e1 = 0, f1 = 0] = m1;
  const [a2 = 1, b2 = 0, c2 = 0, d2 = 1, e2 = 0, f2 = 0] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

/** The closest of the three fonts a word change can be written in. */
export function documentFontOf(family: string, name: string): DocumentFont {
  const f = `${family} ${name}`.toLowerCase();
  if (/mono|courier|consol/.test(f)) return 'mono';
  if (/sans|arial|helvetica|calibri|verdana|grotesk/.test(f)) return 'sans';
  if (/serif|times|georgia|garamond|cambria|roman|book/.test(f)) return 'serif';
  return 'sans';
}

type Piece = {
  text: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
  size: number;
  font: DocumentFont;
  bold: boolean;
};

type TextItem = { str: string; transform: number[]; width: number; fontName: string };
const isTextItem = (item: object): item is TextItem => 'str' in item && 'transform' in item;

/** The words of one page as the PDF wrote them, in points. Words set at an angle are left out. */
async function piecesOf(page: PdfTextPage): Promise<Piece[]> {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const pieces: Piece[] = [];
  for (const item of content.items) {
    if (!isTextItem(item) || !item.str.trim()) continue;
    const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = transform(
      viewport.transform,
      item.transform,
    );
    if (Math.abs(b) > 0.01 * Math.abs(a) || Math.abs(c) > 0.01 * Math.abs(d)) continue;
    const size = Math.hypot(c, d);
    if (size < 3) continue;
    const style = content.styles[item.fontName];
    const ascent = style?.ascent && style.ascent > 0.4 ? style.ascent : 0.85;
    const descent = style?.descent && style.descent < 0 ? style.descent : -0.2;
    let fontName = '';
    try {
      // Known once the page is drawn.
      const objs = page.commonObjs as {
        has: (id: string) => boolean;
        get: (id: string) => { name?: string } | null;
      };
      if (objs.has(item.fontName)) fontName = objs.get(item.fontName)?.name ?? '';
    } catch {
      fontName = '';
    }
    pieces.push({
      text: item.str,
      left: e,
      right: e + item.width,
      top: f - size * ascent,
      bottom: f - size * descent,
      size,
      font: documentFontOf(style?.fontFamily ?? '', fontName),
      bold: /bold|black|heavy|semibold|demi/i.test(fontName),
    });
  }
  return pieces;
}

/** The words of one page as the PDF wrote them, in pieces, where each sits (fractions of the page). */
export async function pdfTextPieces(page: PdfTextPage): Promise<DocumentPageText[]> {
  const viewport = page.getViewport({ scale: 1 });
  return (await piecesOf(page)).map((p) => {
    const x = clamp01(p.left / viewport.width);
    const y = clamp01(p.top / viewport.height);
    return {
      text: p.text,
      x,
      y,
      w: Math.max(0.001, Math.min(1 - x, (p.right - p.left) / viewport.width)),
      h: Math.max(0.001, Math.min(1 - y, (p.bottom - p.top) / viewport.height)),
    };
  });
}

/**
 * The words of one page as lines that can be typed over (answer 26c): pieces on one line, close together and the
 * same size, become one. Words set at an angle are left out.
 */
export async function pdfTextLines(page: PdfTextPage): Promise<DocumentTextLine[]> {
  const viewport = page.getViewport({ scale: 1 });
  const pieces = await piecesOf(page);
  pieces.sort((p, q) => Math.round(p.bottom - q.bottom) || p.left - q.left);
  const lines: Piece[] = [];
  for (const p of pieces) {
    const last = lines[lines.length - 1];
    if (
      last &&
      Math.abs(last.bottom - p.bottom) < p.size * 0.3 &&
      Math.abs(last.size - p.size) < 0.6 &&
      p.left >= last.right - p.size * 0.2 &&
      p.left - last.right < p.size * 0.9
    ) {
      const gap =
        p.left - last.right > p.size * 0.15 && !last.text.endsWith(' ') && !p.text.startsWith(' ');
      last.text = `${last.text}${gap ? ' ' : ''}${p.text}`;
      last.right = Math.max(last.right, p.right);
      last.top = Math.min(last.top, p.top);
      last.bottom = Math.max(last.bottom, p.bottom);
      last.bold = last.bold && p.bold;
      continue;
    }
    lines.push({ ...p });
  }
  return lines.map((l) => {
    const pad = l.size * 0.08;
    const x = clamp01((l.left - pad) / viewport.width);
    const y = clamp01((l.top - pad) / viewport.height);
    return {
      text: l.text.trim(),
      x,
      y,
      w: Math.max(0.005, Math.min(1 - x, (l.right - l.left + pad * 2) / viewport.width)),
      h: Math.max(0.005, Math.min(1 - y, (l.bottom - l.top + pad * 2) / viewport.height)),
      size: Math.round(l.size * 10) / 10,
      font: l.font,
      bold: l.bold,
    };
  });
}

// ---------- what's drawn ----------

/** A page drawn into pixels: four bytes each (red, green, blue, see-through), a row at a time. */
export interface PagePixels {
  readonly data: Uint8ClampedArray | Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** Pixels to a point a page is drawn at to find its lines: a hairline still shows. */
const INK_SCALE = 2;
/** The most pixels a page is drawn with, so a poster-sized page doesn't run a phone or the worker out of memory. */
const INK_MAX_PIXELS = 8_000_000;
/** Darker than this (0 to 255) is ink. Form lines are often grey. */
const INK = 185;

/** How big a page is drawn, in pixels to a point, to find the lines and boxes on it. */
export const inkScale = (size: { width: number; height: number }): number =>
  Math.min(INK_SCALE, Math.sqrt(INK_MAX_PIXELS / (size.width * size.height)));

/** The lines drawn across a page, thin and wide enough to write on, and the empty small squares on it. */
export interface PageInk {
  readonly rules: DocumentPageBox[];
  readonly boxes: DocumentPageBox[];
}

/** The lines and empty small squares drawn on a page, from its pixels drawn at `scale` pixels to a point. */
export function inkOnPage(pixels: PagePixels, scale: number): PageInk {
  const W = pixels.width;
  const H = pixels.height;
  const px = pixels.data;
  const dark = new Uint8Array(W * H);
  for (let i = 0, j = 0; j < dark.length; i += 4, j++)
    dark[j] =
      px[i + 3]! >= 128 && 0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]! < INK ? 1 : 0;
  const at = (x: number, y: number) => dark[y * W + x] === 1;
  const box = (x0: number, y0: number, x1: number, y1: number): DocumentPageBox => ({
    x: x0 / W,
    y: y0 / H,
    w: (x1 - x0) / W,
    h: (y1 - y0) / H,
  });

  // Lines: runs of ink at least 40 points long (a pixel's gap allowed), stacked no more than 3 points thick.
  const minRule = Math.round(40 * scale);
  const maxThick = Math.max(2, Math.round(3 * scale));
  type Rule = { x0: number; x1: number; y0: number; y1: number };
  const open: Rule[] = [];
  const rules: Rule[] = [];
  for (let y = 0; y < H; y++) {
    const runs: [number, number][] = [];
    let start = -1;
    let last = -1;
    for (let x = 0; x < W; x++) {
      if (at(x, y)) {
        if (start < 0) start = x;
        last = x;
      } else if (start >= 0 && x - last > 1) {
        if (last + 1 - start >= minRule) runs.push([start, last + 1]);
        start = -1;
      }
    }
    if (start >= 0 && last + 1 - start >= minRule) runs.push([start, last + 1]);
    for (let i = open.length - 1; i >= 0; i--) {
      const r = open[i]!;
      const k = runs.findIndex(
        ([a, b]) => Math.min(b, r.x1) - Math.max(a, r.x0) > 0.8 * Math.max(b - a, r.x1 - r.x0),
      );
      if (k >= 0) {
        const [a, b] = runs[k]!;
        r.x0 = Math.min(r.x0, a);
        r.x1 = Math.max(r.x1, b);
        r.y1 = y + 1;
        runs.splice(k, 1);
      } else {
        open.splice(i, 1);
        if (r.y1 - r.y0 <= maxThick) rules.push(r);
      }
    }
    for (const [a, b] of runs) open.push({ x0: a, x1: b, y0: y, y1: y + 1 });
  }
  for (const r of open) if (r.y1 - r.y0 <= maxThick) rules.push(r);

  // Small squares, 6 to 20 points a side, drawn as an outline with nothing inside.
  const minSide = Math.round(6 * scale);
  const maxSide = Math.round(20 * scale);
  /** The share of the area that's ink. */
  const inkShare = (x0: number, y0: number, x1: number, y1: number) => {
    let n = 0;
    let all = 0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        all++;
        if (at(x, y)) n++;
      }
    return all ? n / all : 0;
  };
  /** The share of rows from y0 to y1 with ink somewhere from x0 to x1: a line down, a pixel or two wide. */
  const down = (x0: number, x1: number, y0: number, y1: number) => {
    let n = 0;
    for (let y = y0; y < y1; y++)
      for (let x = Math.max(0, x0); x < Math.min(W, x1); x++)
        if (at(x, y)) {
          n++;
          break;
        }
    return y1 > y0 ? n / (y1 - y0) : 0;
  };
  /** The share of columns from x0 to x1 with ink somewhere from y0 to y1: a line across. */
  const across = (x0: number, x1: number, y0: number, y1: number) => {
    let n = 0;
    for (let x = x0; x < x1; x++)
      for (let y = Math.max(0, y0); y < Math.min(H, y1); y++)
        if (at(x, y)) {
          n++;
          break;
        }
    return x1 > x0 ? n / (x1 - x0) : 0;
  };
  const boxes: Rule[] = [];
  for (let y = 0; y < H - minSide; y++) {
    let x = 0;
    while (x < W) {
      if (!at(x, y)) {
        x++;
        continue;
      }
      const x0 = x;
      while (x < W && at(x, y)) x++;
      const side = x - x0;
      if (side < minSide || side > maxSide) continue;
      if (boxes.some((b) => x0 < b.x1 && x > b.x0 && y < b.y1 && y >= b.y0 - 1)) continue;
      for (let h = Math.round(side * 0.75); h <= Math.round(side * 1.25) && y + h < H; h++) {
        const y1 = y + h;
        const t = Math.max(1, Math.round(scale / 2));
        if (!at(x0 + (side >> 1), y1) || across(x0, x, y1, y1 + t) < 0.85) continue;
        if (down(x0, x0 + t + 1, y, y1) < 0.85 || down(x - t - 1, x, y, y1) < 0.85) continue;
        const pad = t + 2;
        if (inkShare(x0 + pad, y + pad, x - pad, y1 - pad) > 0.15) continue;
        boxes.push({ x0, x1: x, y0: y, y1: y1 + 1 });
        break;
      }
    }
  }
  return {
    rules: rules.map((r) => box(r.x0, r.y0, r.x1, r.y1)),
    boxes: boxes.map((b) => box(b.x0, b.y0, b.x1, b.y1)),
  };
}

const hex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/**
 * The colours under a box of a drawn page: the paper behind the words (the commonest colour around its edge) and
 * the ink (the colour inside furthest from it). What a word change covers the old words with, and writes in.
 */
export function coloursOnPage(
  pixels: PagePixels,
  box: DocumentPageBox,
): { background: string; color: string } {
  const fallback = { background: '#ffffff', color: '#000000' };
  const W = pixels.width;
  const H = pixels.height;
  if (!W || !H) return fallback;
  const x0 = Math.max(0, Math.floor(box.x * W) - 2);
  const y0 = Math.max(0, Math.floor(box.y * H) - 2);
  const x1 = Math.min(W, Math.ceil((box.x + box.w) * W) + 2);
  const y1 = Math.min(H, Math.ceil((box.y + box.h) * H) + 2);
  if (x1 - x0 < 3 || y1 - y0 < 3) return fallback;
  const data = pixels.data;
  const at = (x: number, y: number) => {
    const i = ((y0 + y) * W + x0 + x) * 4;
    // An empty corner of a drawing is see-through: that's the white page.
    if (data[i + 3]! < 16) return [255, 255, 255] as const;
    return [data[i]!, data[i + 1]!, data[i + 2]!] as const;
  };
  const width = x1 - x0;
  const height = y1 - y0;
  const counts = new Map<string, { n: number; rgb: readonly [number, number, number] }>();
  const edge = (x: number, y: number) => {
    const rgb = at(x, y);
    const key = rgb.map((v) => v >> 3).join(',');
    const was = counts.get(key);
    counts.set(key, { n: (was?.n ?? 0) + 1, rgb });
  };
  for (let x = 0; x < width; x++) {
    edge(x, 0);
    edge(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    edge(0, y);
    edge(width - 1, y);
  }
  const paper = [...counts.values()].sort((p, q) => q.n - p.n)[0]?.rgb ?? [255, 255, 255];
  let ink: readonly [number, number, number] = [0, 0, 0];
  let far = -1;
  for (let y = 2; y < height - 2; y++)
    for (let x = 2; x < width - 2; x++) {
      const rgb = at(x, y);
      const dist =
        Math.abs(rgb[0] - paper[0]) + Math.abs(rgb[1] - paper[1]) + Math.abs(rgb[2] - paper[2]);
      if (dist > far) {
        far = dist;
        ink = rgb;
      }
    }
  return {
    background: hex(...paper),
    color: far > 60 ? hex(...ink) : paper[0] + paper[1] + paper[2] > 384 ? '#000000' : '#ffffff',
  };
}
