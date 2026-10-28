/**
 * A document's PDF drawn for the phone (docs/documents.md, part 3). The phone has no PDF reader of its own, so the
 * worker reads the PDF the way the web's pdf.js does in the browser: each page drawn as a picture, its words read a
 * line at a time with the colours under them (for typing over them, 26c), and the lines and small boxes on it (for
 * the AI placing fields, 4a). What's done with what's read is core's (read.ts), so the web and the phone agree.
 *
 * - **Drawn once.** A PDF never changes (a template's new PDF is a new file), so each page is kept beside its PDF,
 *   in `<the PDF's folder>/pages-v1/`: `<n>.png` and `<n>.json`. Deleting the PDF takes them too.
 * - **A few pages at a time**, as the phone comes to them, so a long contract opens at once.
 * - **As the person sees it**: the template or document is read as them, under row security; the pictures come back
 *   as links that work for an hour.
 *
 * POST /v1/documents/pages {workspaceId, templateId | documentId, fileId?, from?, count?}
 *   → {pageCount, pages: [{page, width, height, picture, pixelWidth, pixelHeight, lines}]}
 * `fileId` is a PDF just uploaded for the template (documents.manage), read for its page sizes before it's the
 * template's own (`document_template.set_source`). 404 when it isn't there; 409 `document_template_no_pdf`;
 * 422 `pdf_unreadable` for a PDF that doesn't open.
 */
import { randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import {
  coloursOnPage,
  documentGet,
  documentTemplateGet,
  executeQuery,
  findDocumentSpots,
  HfosError,
  inkOnPage,
  inkScale,
  MAX_DOCUMENT_PAGES,
  pdfTextLines,
  pdfTextPieces,
  type DocumentPageFindings,
  type DocumentPageText,
  type DocumentPlaceFind,
  type DocumentTextLine,
  type HumanActor,
  type PageInk,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import { createIsomorphicCanvasFactory, getDocumentProxy } from 'unpdf';
import { z } from 'zod';
import type { ObjectStore } from '../storage';
import { authenticate, parseBody, requirePermission, type HttpDeps } from '../http/common';

/** Pages drawn in one ask. */
export const PAGES_AT_ONCE = 4;
/** Asks one address may make a minute: a long contract is a few dozen. */
export const PAGES_PER_MINUTE = 60;
/** How long a page's picture link works. */
const PICTURE_SECONDS = 3600;
/** Where a PDF's drawn pages are kept, beside it. A new way of drawing them is a new folder. */
const FOLDER = 'pages-v1';
/** Pages drawn at once across the worker: each is a few million pixels. */
const DRAWING_AT_ONCE = 2;

/** A line of words on a page, with the paper's colour behind it and the ink's. */
export interface PageLine extends DocumentTextLine {
  readonly background: string;
  readonly color: string;
}

/** One page as it's kept beside the PDF. */
export interface DrawnPage {
  readonly page: number;
  /** How many pages the PDF has. */
  readonly of: number;
  /** In points, turned as the PDF says. */
  readonly width: number;
  readonly height: number;
  /** The picture's size. */
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly lines: readonly PageLine[];
  readonly pieces: readonly DocumentPageText[];
  readonly ink: PageInk;
}

/** Where a PDF is stored. */
export interface PdfSource {
  readonly bucket: string;
  readonly objectPath: string;
}

const folderOf = (source: PdfSource) =>
  `${source.objectPath.split('/').slice(0, -1).join('/')}/${FOLDER}`;
const pathOf = (source: PdfSource, page: number, ext: 'png' | 'json') =>
  `${folderOf(source)}/${page}.${ext}`;

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------- drawing ----------

let drawing = 0;
const waiting: (() => void)[] = [];
async function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  if (drawing >= DRAWING_AT_ONCE) await new Promise<void>((go) => waiting.push(go));
  drawing += 1;
  try {
    return await work();
  } finally {
    drawing -= 1;
    waiting.shift()?.();
  }
}

interface Drawing {
  readonly canvas: { encode(format: 'png'): Promise<Buffer>; width: number; height: number };
  readonly context: {
    getImageData(
      x: number,
      y: number,
      w: number,
      h: number,
    ): { data: Uint8ClampedArray; width: number; height: number };
  };
}
interface CanvasFactory {
  create(width: number, height: number): Drawing;
  destroy(drawing: Drawing): void;
}

/** A PDF that won't open: password-locked, damaged, or not a PDF at all. */
export const unreadablePdf = () =>
  HfosError.rule(
    'pdf_unreadable',
    422,
    'This PDF didn’t open. If it has a password, save a copy without one and add that.',
  );

/**
 * Draws the pages asked for (counted from 0) and reads each: its picture, its lines with their colours, its words in
 * pieces, and the lines and boxes drawn on it. Pages past the end are left out.
 */
export async function drawPdfPages(
  bytes: Uint8Array,
  wanted: readonly number[],
): Promise<{ pageCount: number; pages: { meta: DrawnPage; png: Buffer }[] }> {
  return oneAtATime(async () => {
    const Factory = (await createIsomorphicCanvasFactory(
      () => import('@napi-rs/canvas'),
    )) as unknown as new () => CanvasFactory;
    const pdf = await getDocumentProxy(new Uint8Array(bytes), {
      CanvasFactory: Factory,
    } as never).catch(() => {
      throw unreadablePdf();
    });
    try {
      const out: { meta: DrawnPage; png: Buffer }[] = [];
      for (const n of wanted) {
        if (n < 0 || n >= pdf.numPages) continue;
        const page = await pdf.getPage(n + 1);
        const base = page.getViewport({ scale: 1 });
        const scale = inkScale(base);
        const viewport = page.getViewport({ scale });
        const factory = new Factory();
        const drawn = factory.create(Math.floor(viewport.width), Math.floor(viewport.height));
        try {
          await page.render({
            canvas: drawn.canvas as never,
            canvasContext: drawn.context as never,
            viewport,
          }).promise;
          const pixels = drawn.context.getImageData(0, 0, drawn.canvas.width, drawn.canvas.height);
          // Read after it's drawn: a font's name is known once its page is.
          const [lines, pieces] = await Promise.all([pdfTextLines(page), pdfTextPieces(page)]);
          out.push({
            meta: {
              page: n,
              of: pdf.numPages,
              width: round2(base.width),
              height: round2(base.height),
              pixelWidth: pixels.width,
              pixelHeight: pixels.height,
              lines: lines.map((l) => ({ ...l, ...coloursOnPage(pixels, l) })),
              pieces,
              ink: inkOnPage(pixels, scale),
            },
            png: await drawn.canvas.encode('png'),
          });
        } finally {
          factory.destroy(drawn);
          page.cleanup();
        }
      }
      return { pageCount: pdf.numPages, pages: out };
    } finally {
      await pdf.loadingTask.destroy();
    }
  });
}

/** How many pages a PDF has, and each one's size in points: what `document_template.set_source` keeps. */
export async function pdfPageSizes(
  bytes: Uint8Array,
): Promise<{ width: number; height: number }[]> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes)).catch(() => {
    throw unreadablePdf();
  });
  try {
    const out: { width: number; height: number }[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const vp = (await pdf.getPage(i)).getViewport({ scale: 1 });
      out.push({ width: round2(vp.width), height: round2(vp.height) });
    }
    return out;
  } finally {
    await pdf.loadingTask.destroy();
  }
}

// ---------- kept beside the PDF ----------

async function keptPage(
  store: ObjectStore,
  source: PdfSource,
  page: number,
): Promise<DrawnPage | null> {
  try {
    return JSON.parse(
      (await store.download(source.bucket, pathOf(source, page, 'json'))).toString('utf8'),
    ) as DrawnPage;
  } catch {
    return null;
  }
}

/**
 * The pages from `from` (counted from 0), as many as `count`, drawn now or kept from before. The PDF is only fetched
 * when a page hasn't been drawn yet.
 */
export async function drawnPages(
  store: ObjectStore,
  source: PdfSource,
  from: number,
  count: number,
  /** The PDF, when it's already fetched. */
  bytes?: Buffer,
): Promise<{ pageCount: number; pages: DrawnPage[] }> {
  const range = Array.from({ length: count }, (_, i) => from + i);
  const kept = await Promise.all(range.map((n) => keptPage(store, source, n)));
  // Nothing kept from here on: the first page, when it's kept, says whether there's anything here at all.
  let pageCount =
    kept.find((k) => k)?.of ?? (from > 0 ? ((await keptPage(store, source, 0))?.of ?? null) : null);
  const pages = new Map<number, DrawnPage>();
  kept.forEach((k) => k && pages.set(k.page, k));
  const missing = range.filter((n) => !pages.has(n) && (pageCount === null || n < pageCount));
  if (missing.length) {
    const drawn = await drawPdfPages(
      bytes ?? (await store.download(source.bucket, source.objectPath)),
      missing,
    );
    pageCount = drawn.pageCount;
    for (const d of drawn.pages) {
      // The picture first: a page's JSON says both are there.
      await store.upload(source.bucket, pathOf(source, d.meta.page, 'png'), d.png, 'image/png', {
        upsert: true,
      });
      await store.upload(
        source.bucket,
        pathOf(source, d.meta.page, 'json'),
        Buffer.from(JSON.stringify(d.meta)),
        // The attachments bucket takes plain text, not JSON.
        'text/plain',
        { upsert: true },
      );
      pages.set(d.meta.page, d.meta);
    }
  }
  return {
    pageCount: pageCount ?? 0,
    pages: range.flatMap((n) => {
      const p = pages.get(n);
      return p ? [p] : [];
    }),
  };
}

/** Takes away the pages drawn of a PDF, as it's deleted (handlers/file-removed.ts). */
export async function removeDrawnPages(store: ObjectStore, source: PdfSource): Promise<void> {
  const folder = folderOf(source);
  for (const name of await store.list(source.bucket, folder))
    await store.remove(source.bucket, `${folder}/${name}`);
}

/**
 * Every spot on a template's PDF a field could go, with the words around each and the words it starts with, found
 * the way the web's editor finds them (apps/web/src/lib/documents/spots.ts): for "Place fields for me" on the phone.
 */
export async function findSpotsInStoredPdf(
  store: ObjectStore,
  source: PdfSource,
): Promise<DocumentPlaceFind> {
  const found: DocumentPageFindings[] = [];
  let pageCount = MAX_DOCUMENT_PAGES;
  for (let from = 0; from < Math.min(pageCount, MAX_DOCUMENT_PAGES); from += PAGES_AT_ONCE) {
    const got = await drawnPages(
      store,
      source,
      from,
      Math.min(PAGES_AT_ONCE, MAX_DOCUMENT_PAGES - from),
    );
    pageCount = got.pageCount;
    for (const p of got.pages)
      found.push({
        page: p.page,
        size: { width: p.width, height: p.height },
        lines: p.lines.map(({ text, x, y, w, h }) => ({ text, x, y, w, h })),
        pieces: p.pieces,
        ...p.ink,
      });
  }
  return findDocumentSpots(found);
}

// ---------- the route ----------

export const DocumentPagesBody = z
  .object({
    workspaceId: z.uuid(),
    templateId: z.uuid().optional(),
    documentId: z.uuid().optional(),
    /** A PDF just uploaded for the template, before it's the template's own. */
    fileId: z.uuid().optional(),
    from: z.number().int().min(0).max(MAX_DOCUMENT_PAGES).default(0),
    count: z.number().int().min(1).max(PAGES_AT_ONCE).default(PAGES_AT_ONCE),
  })
  .refine((b) => !!b.templateId !== !!b.documentId, {
    message: 'Say which template or document.',
    path: ['templateId'],
  })
  .refine((b) => !b.fileId || !!b.templateId, {
    message: 'A new PDF is for a template.',
    path: ['fileId'],
  });

export interface DocumentPagesOut {
  readonly pageCount: number;
  /** For a PDF just uploaded (`fileId`): every page's size in points, for `document_template.set_source`. */
  readonly sizes?: readonly { width: number; height: number }[];
  readonly pages: readonly {
    readonly page: number;
    readonly width: number;
    readonly height: number;
    /** A link to the page's picture, for an hour. */
    readonly picture: string;
    readonly pixelWidth: number;
    readonly pixelHeight: number;
    readonly lines: readonly PageLine[];
  }[];
}

const meta = () => ({ correlationId: randomUUID(), channel: 'web' as const });

const noPdf = (name: string) =>
  HfosError.rule(
    'document_template_no_pdf',
    409,
    `“${name}” has no PDF yet. Add one, then its pages show here.`,
  );

/** The PDF asked for, read as the person asking: they see it only where they see its template or document. */
async function sourceFor(
  deps: Pick<HttpDeps, 'httpDb'>,
  actor: HumanActor,
  input: z.output<typeof DocumentPagesBody>,
): Promise<PdfSource & { readonly uploaded?: boolean }> {
  const ws = input.workspaceId;
  if (input.documentId) {
    const doc = await executeQuery(
      deps.httpDb,
      documentGet,
      { workspaceId: ws, documentId: input.documentId },
      actor,
      meta(),
    );
    if (!doc.source) throw HfosError.notFound('This document’s PDF isn’t there anymore.');
    return doc.source;
  }
  const template = await executeQuery(
    deps.httpDb,
    documentTemplateGet,
    { workspaceId: ws, templateId: input.templateId! },
    actor,
    meta(),
  );
  if (!input.fileId || input.fileId === template.source?.fileId) {
    if (!template.source) throw noPdf(template.name);
    return template.source;
  }
  await requirePermission(deps, actor.userId, ws, 'documents.manage');
  const [file] = await asWorker(deps.httpDb, { workspaceId: ws }, (tx) =>
    rows<{ bucket: string; object_path: string; status: string; name: string }>(
      tx,
      sql`select bucket, object_path, status, name from app.files
          where id = ${input.fileId} and workspace_id = ${ws} and record_type = 'document'
            and record_id = ${template.id} and deleted_at is null`,
    ),
  );
  if (!file) throw HfosError.notFound('That PDF isn’t there anymore. Upload it again.');
  if (file.status !== 'ready')
    throw HfosError.rule(
      'file_not_uploaded',
      409,
      `${file.name} hasn’t finished uploading. Wait for it to finish, or upload it again.`,
    );
  return { bucket: file.bucket, objectPath: file.object_path, uploaded: true };
}

export async function documentPages(
  deps: Pick<HttpDeps, 'httpDb' | 'store'>,
  actor: HumanActor,
  input: z.output<typeof DocumentPagesBody>,
): Promise<DocumentPagesOut> {
  const source = await sourceFor(deps, actor, input);
  // A PDF just uploaded: its sizes, and its first pages drawn while it's here, ready for when it's the template's.
  const bytes = source.uploaded
    ? await deps.store.download(source.bucket, source.objectPath)
    : undefined;
  const sizes = bytes ? await pdfPageSizes(bytes) : undefined;
  const got = await drawnPages(deps.store, source, input.from, input.count, bytes);
  return {
    pageCount: got.pageCount,
    ...(sizes ? { sizes } : {}),
    pages: await Promise.all(
      got.pages.map(async (p) => ({
        page: p.page,
        width: p.width,
        height: p.height,
        picture: await deps.store.signedUrl(
          source.bucket,
          pathOf(source, p.page, 'png'),
          PICTURE_SECONDS,
        ),
        pixelWidth: p.pixelWidth,
        pixelHeight: p.pixelHeight,
        lines: p.lines,
      })),
    ),
  };
}

export async function registerDocumentPagesRoutes(
  app: FastifyInstance,
  deps: HttpDeps,
): Promise<void> {
  await app.register(async (scoped) => {
    await scoped.register(rateLimit, {
      global: false,
      errorResponseBuilder: () =>
        new HfosError(
          'rule_violation',
          429,
          'That’s a lot of pages in a row. Wait a minute and try again.',
          undefined,
          'rate_limited',
        ),
    });
    scoped.post(
      '/v1/documents/pages',
      { config: { rateLimit: { max: PAGES_PER_MINUTE, timeWindow: 60_000 } } },
      async (req) => {
        const actor = await authenticate(deps, req);
        return documentPages(deps, actor, parseBody(DocumentPagesBody, req.body));
      },
    );
  });
}
