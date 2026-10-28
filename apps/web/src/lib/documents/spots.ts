'use client';
/**
 * Where on a template's PDF a field could go, for "Place fields for me" (docs/documents.md, answer 4a). Each page's
 * words come from pdf.js; its lines and small boxes from the page drawn off screen, read pixel by pixel. Core reads
 * both (read.ts, which the worker uses too for the phone) and turns them into numbered spots with the words around
 * each (`findDocumentSpots`), which the AI labels.
 */
import {
  findDocumentSpots,
  inkOnPage,
  inkScale,
  MAX_DOCUMENT_PAGES,
  type DocumentPageFindings,
  type DocumentPlaceFind,
  type PageInk,
} from '@hfos/core';
import { textPieces, textRuns, type PdfDocument, type PdfPage } from './pdf';

/** The lines and empty small squares drawn on one page, from the page drawn off screen (core's `inkOnPage`). */
async function inkOf(page: PdfPage, canvas: HTMLCanvasElement): Promise<PageInk> {
  const base = page.getViewport({ scale: 1 });
  const scale = inkScale(base);
  const viewport = page.getViewport({ scale });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvas, viewport }).promise;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return { rules: [], boxes: [] };
  return inkOnPage(ctx.getImageData(0, 0, canvas.width, canvas.height), scale);
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
