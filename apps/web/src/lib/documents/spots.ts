'use client';
/**
 * Where on a template's PDF a field could go, for "Place fields for me" (docs/documents.md, answer 4a). Each page's
 * words come from pdf.js; its lines and small boxes from the page drawn off screen, read pixel by pixel. Core turns
 * them into numbered spots with the words around each (`findDocumentSpots`), which the AI labels.
 */
import {
  findDocumentSpots,
  MAX_DOCUMENT_PAGES,
  type DocumentPageBox,
  type DocumentPageFindings,
  type DocumentPlaceFind,
} from '@hfos/core';
import { textPieces, textRuns, type PdfDocument, type PdfPage } from './pdf';

/** Pixels to a point the page is drawn at: a hairline still shows. */
const SCALE = 2;
/** The most pixels a page is drawn with, so a poster-sized page doesn't run a phone out of memory. */
const MAX_PIXELS = 8_000_000;
/** Darker than this (0 to 255) is ink. Form lines are often grey. */
const INK = 185;

interface Ink {
  readonly rules: DocumentPageBox[];
  readonly boxes: DocumentPageBox[];
}

/** The lines and empty small squares drawn on one page. */
async function inkOf(page: PdfPage, canvas: HTMLCanvasElement): Promise<Ink> {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(SCALE, Math.sqrt(MAX_PIXELS / (base.width * base.height)));
  const viewport = page.getViewport({ scale });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvas, viewport }).promise;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return { rules: [], boxes: [] };
  const W = canvas.width;
  const H = canvas.height;
  const px = ctx.getImageData(0, 0, W, H).data;
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

/** Every spot on the PDF a field could go, with the words around each, and the words it starts with. */
export async function findSpotsInPdf(doc: PdfDocument): Promise<DocumentPlaceFind> {
  const canvas = document.createElement('canvas');
  const pages: DocumentPageFindings[] = [];
  try {
    for (let i = 0; i < Math.min(doc.numPages, MAX_DOCUMENT_PAGES); i++) {
      const page = await doc.getPage(i + 1);
      const size = page.getViewport({ scale: 1 });
      // Drawn first: a font's name is known once its page is.
      const ink = await inkOf(page, canvas);
      const [lines, pieces] = await Promise.all([textRuns(page), textPieces(page)]);
      pages.push({
        page: i,
        size: { width: size.width, height: size.height },
        lines: lines.map(({ text, x, y, w, h }) => ({ text, x, y, w, h })),
        pieces,
        ...ink,
      });
    }
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
  return findDocumentSpots(pages);
}
