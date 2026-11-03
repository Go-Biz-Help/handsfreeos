'use client';
/**
 * Reading and drawing a document's PDF in the browser (docs/documents.md), with pdf.js.
 *
 * - **Loaded only where a PDF is shown**: the editor, the Send screen, a document's page and the signing page import
 *   it when they open one, so no other page carries it.
 * - **Its legacy build**, which still runs on the older phones customers sign on. Safari still can't loop over a
 *   stream, which even that build does to read a page's words, so streams are given the loop first (streams.ts).
 * - **On the page's own thread**: pdf.js's worker code is imported and handed over, so nothing has to be served
 *   from a separate address. The PDFs here are contracts of a few pages, which it reads in a moment.
 * - **Pages are measured the way the worker draws them**: in points, turned as the PDF says (`getViewport` at
 *   scale 1), so a field placed here lands in the same spot on the signed copy.
 */
import {
  coloursOnPage,
  pdfTextLines,
  pdfTextPieces,
  type DocumentFont,
  type DocumentTextLine,
} from '@hfos/core';
import type * as PdfJsModule from 'pdfjs-dist/legacy/build/pdf.mjs';
import { letStreamsBeLooped } from './streams';

type PdfJs = typeof PdfJsModule;
export type PdfDocument = Awaited<ReturnType<PdfJs['getDocument']>['promise']>;
export type PdfPage = Awaited<ReturnType<PdfDocument['getPage']>>;

let loading: Promise<PdfJs> | null = null;

/** pdf.js, once, with its worker code on this thread. */
export function loadPdfJs(): Promise<PdfJs> {
  letStreamsBeLooped();
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
export type TextRun = DocumentTextLine;

/** The words of one page as the PDF wrote them, in pieces, where each sits (fractions of the page). */
export const textPieces = (page: PdfPage) => pdfTextPieces(page);

/**
 * The words of one page as lines that can be typed over (answer 26c): pieces on one line, close together and the
 * same size, become one. Core reads them (`pdfTextLines`), so the phone's pages, read by the worker, agree.
 */
export const textRuns = (page: PdfPage): Promise<TextRun[]> => pdfTextLines(page);

/**
 * The colours under a box of a drawn page: the paper behind the words and the ink. What a word change covers the
 * old words with, and writes in (core's `coloursOnPage`).
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
  try {
    // Only the part around the box is read: the whole page is millions of pixels.
    const part = g.getImageData(x0, y0, x1 - x0, y1 - y0);
    return coloursOnPage(part, {
      x: (box.x * canvas.width - x0) / part.width,
      y: (box.y * canvas.height - y0) / part.height,
      w: (box.w * canvas.width) / part.width,
      h: (box.h * canvas.height) / part.height,
    });
  } catch {
    return fallback;
  }
}

/** How a word change's font is drawn on screen, close to the PDF's own Helvetica, Times and Courier. */
export const EDIT_FONT_FAMILIES: Readonly<Record<DocumentFont, string>> = {
  sans: 'Helvetica, Arial, "Liberation Sans", sans-serif',
  serif: '"Times New Roman", Times, "Liberation Serif", serif',
  mono: '"Courier New", Courier, "Liberation Mono", monospace',
};
