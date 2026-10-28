'use client';
/**
 * Reading and drawing a document's PDF in the browser (docs/documents.md), with pdf.js.
 *
 * - **Loaded only where a PDF is shown**: the editor, the Send screen, a document's page and the signing page import
 *   it when they open one, so no other page carries it.
 * - **Its legacy build**, which still runs on the older phones customers sign on.
 * - **On the page's own thread**: pdf.js's worker code is imported and handed over, so nothing has to be served
 *   from a separate address. The PDFs here are contracts of a few pages, which it reads in a moment.
 * - **Pages are measured the way the worker draws them**: in points, turned as the PDF says (`getViewport` at
 *   scale 1), so a field placed here lands in the same spot on the signed copy.
 */
import type { DocumentFont } from '@hfos/core';
import type * as PdfJsModule from 'pdfjs-dist/legacy/build/pdf.mjs';

type PdfJs = typeof PdfJsModule;
export type PdfDocument = Awaited<ReturnType<PdfJs['getDocument']>['promise']>;
export type PdfPage = Awaited<ReturnType<PdfDocument['getPage']>>;

let loading: Promise<PdfJs> | null = null;

/** pdf.js, once, with its worker code on this thread. */
export function loadPdfJs(): Promise<PdfJs> {
  loading ??= (async () => {
    const [pdfjs, worker] = await Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('pdfjs-dist/legacy/build/pdf.worker.min.mjs'),
    ]);
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
    return pdfjs;
  })().catch((e: unknown) => {
    loading = null;
    throw e;
  });
  return loading;
}

/** The fonts, character maps and image decoders a PDF can ask for, from the copy of pdf.js this page runs. */
const assetsAt = (version: string, folder: string) =>
  `https://cdn.jsdelivr.net/npm/pdfjs-dist@${version}/${folder}/`;

/** Opens a PDF from an address (a short-lived signed link) or from bytes just picked. */
export async function openPdf(source: string | ArrayBuffer): Promise<PdfDocument> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({
    ...(typeof source === 'string' ? { url: source } : { data: new Uint8Array(source) }),
    cMapUrl: assetsAt(pdfjs.version, 'cmaps'),
    cMapPacked: true,
    standardFontDataUrl: assetsAt(pdfjs.version, 'standard_fonts'),
    wasmUrl: assetsAt(pdfjs.version, 'wasm'),
  });
  return task.promise;
}

/** Each page's size in points, turned as the PDF says: what `document_template.set_source` keeps. */
export async function pageSizes(doc: PdfDocument): Promise<{ width: number; height: number }[]> {
  const out: { width: number; height: number }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const vp = (await doc.getPage(i)).getViewport({ scale: 1 });
    out.push({
      width: Math.round(vp.width * 100) / 100,
      height: Math.round(vp.height * 100) / 100,
    });
  }
  return out;
}

/**
 * Draws one page into a canvas `cssWidth` pixels wide, sharp on the screen it's on. Resolves once it's drawn;
 * `cancel` stops a drawing nobody is waiting for.
 */
export function renderPage(
  page: PdfPage,
  canvas: HTMLCanvasElement,
  cssWidth: number,
): { done: Promise<void>; cancel: () => void } {
  const base = page.getViewport({ scale: 1 });
  const ratio = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  // Big pages on big screens stop at about 4,000 pixels across: past that a phone runs out of canvas.
  const scale = Math.min((cssWidth / base.width) * ratio, 4096 / base.width);
  const viewport = page.getViewport({ scale });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const task = page.render({ canvas, viewport });
  return {
    done: task.promise.catch((e: unknown) => {
      if ((e as { name?: string } | null)?.name === 'RenderingCancelledException') return;
      throw e;
    }),
    cancel: () => task.cancel(),
  };
}

/** A line of words on a page, where it sits (fractions of the page, from the top left) and how it's written. */
export interface TextRun {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** In points. */
  readonly size: number;
  readonly font: DocumentFont;
  readonly bold: boolean;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function fontOf(family: string, name: string): DocumentFont {
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

/** The words of one page as the PDF wrote them, in points. Words set at an angle are left out. */
async function piecesOf(page: PdfPage): Promise<Piece[]> {
  const pdfjs = await loadPdfJs();
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const pieces: Piece[] = [];
  for (const item of content.items) {
    if (!('str' in item) || !item.str.trim()) continue;
    const tx = pdfjs.Util.transform(viewport.transform, item.transform) as number[];
    const [a, b, c, d, e, f] = tx as [number, number, number, number, number, number];
    if (Math.abs(b) > 0.01 * Math.abs(a) || Math.abs(c) > 0.01 * Math.abs(d)) continue;
    const size = Math.hypot(c, d);
    if (size < 3) continue;
    const style = content.styles[item.fontName];
    const ascent = style?.ascent && style.ascent > 0.4 ? style.ascent : 0.85;
    const descent = style?.descent && style.descent < 0 ? style.descent : -0.2;
    let fontName = '';
    try {
      // Known once the page is drawn: "ABCDEF+Arial-BoldMT".
      const objs = page.commonObjs as {
        has: (id: string) => boolean;
        get: (id: string) => { name?: string };
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
      font: fontOf(style?.fontFamily ?? '', fontName),
      bold: /bold|black|heavy|semibold|demi/i.test(fontName),
    });
  }
  return pieces;
}

/** The words of one page as the PDF wrote them, in pieces, where each sits (fractions of the page). */
export async function textPieces(
  page: PdfPage,
): Promise<{ text: string; x: number; y: number; w: number; h: number }[]> {
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
export async function textRuns(page: PdfPage): Promise<TextRun[]> {
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

const hex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/**
 * The colours under a box of a drawn page: the paper behind the words (the commonest colour around its edge) and
 * the ink (the colour inside furthest from it). What a word change covers the old words with, and writes in.
 */
export function coloursUnder(
  canvas: HTMLCanvasElement,
  box: { x: number; y: number; w: number; h: number },
): { background: string; color: string } {
  const fallback = { background: '#ffffff', color: '#000000' };
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (!g || !canvas.width || !canvas.height) return fallback;
  const x0 = Math.max(0, Math.floor(box.x * canvas.width) - 2);
  const y0 = Math.max(0, Math.floor(box.y * canvas.height) - 2);
  const x1 = Math.min(canvas.width, Math.ceil((box.x + box.w) * canvas.width) + 2);
  const y1 = Math.min(canvas.height, Math.ceil((box.y + box.h) * canvas.height) + 2);
  if (x1 - x0 < 3 || y1 - y0 < 3) return fallback;
  let data: Uint8ClampedArray;
  try {
    data = g.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  } catch {
    return fallback;
  }
  const width = x1 - x0;
  const height = y1 - y0;
  const at = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    // An empty corner of a canvas is see-through: that's the white page.
    if (data[i + 3]! < 16) return [255, 255, 255] as const;
    return [data[i]!, data[i + 1]!, data[i + 2]!] as const;
  };
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

/** How a word change's font is drawn on screen, close to the PDF's own Helvetica, Times and Courier. */
export const EDIT_FONT_FAMILIES: Readonly<Record<DocumentFont, string>> = {
  sans: 'Helvetica, Arial, "Liberation Sans", sans-serif',
  serif: '"Times New Roman", Times, "Liberation Serif", serif',
  mono: '"Courier New", Courier, "Liberation Mono", monospace',
};
