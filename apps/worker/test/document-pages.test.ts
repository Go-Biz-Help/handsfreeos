/**
 * A document's PDF drawn for the phone (docs/documents.md, part 3): each page a picture, its lines of words with
 * the colours under them, kept beside the PDF so it's drawn once; a PDF just uploaded read for its page sizes; and
 * "Place fields for me" finding the spots on the template's own PDF when the phone sends none.
 */
import { randomInt } from 'node:crypto';
import {
  documentTemplateBeginUpload,
  documentTemplateCreate,
  documentTemplateSetSource,
  fileConfirm,
  type DocumentField,
} from '@hfos/core/server';
import { closeTestDbs, signInTestUser } from '@hfos/db/testing';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { scriptedAi } from '../src/ai/scripted';
import { drawPdfPages, removeDrawnPages } from '../src/documents/pages';
import { makeWorld, run, type World } from './booking-world';

let w: World;
let bearer: string;

/** A one-page agreement: a title, a line to sign on with its label, and a box to tick. */
async function agreement(pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage(i === 1 ? [792, 612] : [612, 792]);
    page.drawText(i ? `Page ${i + 1}` : 'Service agreement', { x: 72, y: 540, size: 12, font });
    page.drawText('Client signature:', { x: 72, y: 200, size: 11, font });
    page.drawLine({
      start: { x: 170, y: 198 },
      end: { x: 370, y: 198 },
      thickness: 1,
      color: rgb(0, 0, 0),
    });
    page.drawRectangle({
      x: 72,
      y: 150,
      width: 12,
      height: 12,
      borderWidth: 1,
      borderColor: rgb(0, 0, 0),
    });
    page.drawText('I have pets', { x: 92, y: 152, size: 11, font });
  }
  return doc.save();
}

async function upload(templateId: string, pdf: Uint8Array) {
  const begun = (await run(w, documentTemplateBeginUpload, {
    workspaceId: w.workspaceId,
    templateId,
    name: 'Agreement.pdf',
    mimeType: 'application/pdf',
    sizeBytes: pdf.byteLength,
  })) as { fileId: string; objectPath: string };
  await w.s.store.upload('attachments', begun.objectPath, Buffer.from(pdf), 'application/pdf');
  await run(w, fileConfirm, { workspaceId: w.workspaceId, fileId: begun.fileId });
  return begun;
}

async function template(): Promise<{ templateId: string; objectPath: string }> {
  const made = (await run(w, documentTemplateCreate, {
    workspaceId: w.workspaceId,
    name: 'Service agreement',
  })) as { templateId: string; revision: number };
  const begun = await upload(made.templateId, await agreement());
  await run(w, documentTemplateSetSource, {
    workspaceId: w.workspaceId,
    templateId: made.templateId,
    fileId: begun.fileId,
    pages: [{ width: 612, height: 792 }],
    baseRevision: made.revision,
  });
  return { templateId: made.templateId, objectPath: begun.objectPath };
}

const post = (url: string, body: unknown, auth: string | null = bearer) =>
  w.app.inject({
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `198.51.100.${randomInt(1, 250)}`,
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
    },
    payload: JSON.stringify(body),
  });

type PagesOut = {
  pageCount: number;
  sizes?: { width: number; height: number }[];
  pages: {
    page: number;
    width: number;
    height: number;
    picture: string;
    pixelWidth: number;
    pixelHeight: number;
    lines: { text: string; x: number; y: number; background: string; color: string }[];
  }[];
};

beforeAll(async () => {
  w = await makeWorld('docpages', { ai: { provider: scriptedAi() } });
  bearer = await signInTestUser(w.owner);
}, 120_000);

afterAll(async () => {
  await w?.app.close();
  await closeTestDbs();
});

describe('drawing a PDF', () => {
  it('draws each page and reads its lines, the colours under them, and the lines and boxes on it', async () => {
    const { pageCount, pages } = await drawPdfPages(await agreement(2), [0, 1, 5]);
    expect(pageCount).toBe(2);
    expect(pages.map((p) => [p.meta.page, p.meta.width, p.meta.height])).toEqual([
      [0, 612, 792],
      [1, 792, 612],
    ]);
    const first = pages[0]!.meta;
    // Two pixels to a point, and a real PNG.
    expect([first.pixelWidth, first.pixelHeight]).toEqual([1224, 1584]);
    expect(pages[0]!.png.subarray(1, 4).toString()).toBe('PNG');
    expect(first.lines.map((l) => l.text)).toEqual([
      'Service agreement',
      'Client signature:',
      'I have pets',
    ]);
    expect(first.lines[0]).toMatchObject({ font: 'sans', background: '#ffffff', color: '#000000' });
    expect(first.ink.rules).toHaveLength(1);
    expect(first.ink.rules[0]!.x).toBeCloseTo(170 / 612, 2);
    // The box to tick, where it's drawn.
    expect(first.ink.boxes.some((b) => Math.abs(b.x * 612 - 72) < 1.5)).toBe(true);
  }, 30_000);

  it('turns away what isn’t a PDF', async () => {
    await expect(drawPdfPages(Buffer.from('not a pdf'), [0])).rejects.toMatchObject({
      rule: 'pdf_unreadable',
    });
  });
});

describe('the pages for the phone', () => {
  it('sends each page’s picture and lines, drawn once and kept beside the PDF', async () => {
    const { templateId, objectPath } = await template();
    const res = await post('/v1/documents/pages', { workspaceId: w.workspaceId, templateId });
    expect(res.statusCode, res.body).toBe(200);
    const out = res.json() as PagesOut;
    expect(out.pageCount).toBe(1);
    expect(out.sizes).toBeUndefined();
    expect(out.pages[0]).toMatchObject({ page: 0, width: 612, height: 792, pixelWidth: 1224 });
    expect(out.pages[0]!.picture).toMatch(/^http/);
    expect(out.pages[0]!.lines[0]!.text).toBe('Service agreement');

    const folder = `${objectPath.split('/').slice(0, -1).join('/')}/pages-v1`;
    expect((await w.s.store.list('attachments', folder)).sort()).toEqual(['0.json', '0.png']);

    // Asked again, the kept page answers: the PDF isn't fetched.
    const fetched = vi.spyOn(w.s.store, 'download');
    const again = await post('/v1/documents/pages', { workspaceId: w.workspaceId, templateId });
    expect((again.json() as PagesOut).pages[0]!.lines).toEqual(out.pages[0]!.lines);
    expect(fetched.mock.calls.map(([, path]) => path)).not.toContain(objectPath);
    fetched.mockRestore();

    // Past the end: nothing, and the PDF isn't fetched to say so.
    const looked = vi.spyOn(w.s.store, 'download');
    const past = await post('/v1/documents/pages', {
      workspaceId: w.workspaceId,
      templateId,
      from: 3,
    });
    expect(past.json()).toEqual({ pageCount: 1, pages: [] });
    expect(looked.mock.calls.map(([, path]) => path)).not.toContain(objectPath);
    looked.mockRestore();

    await removeDrawnPages(w.s.store, { bucket: 'attachments', objectPath });
    expect(await w.s.store.list('attachments', folder)).toEqual([]);
  }, 30_000);

  it('reads a PDF just uploaded for its page sizes, before it’s the template’s', async () => {
    const { templateId } = await template();
    const begun = await upload(templateId, await agreement(2));
    const res = await post('/v1/documents/pages', {
      workspaceId: w.workspaceId,
      templateId,
      fileId: begun.fileId,
      count: 1,
    });
    expect(res.statusCode, res.body).toBe(200);
    const out = res.json() as PagesOut;
    expect(out.sizes).toEqual([
      { width: 612, height: 792 },
      { width: 792, height: 612 },
    ]);
    expect(out.pages.map((p) => p.page)).toEqual([0]);
  }, 30_000);

  it('refuses without a sign-in, a template that isn’t there, and someone else’s file', async () => {
    const { templateId } = await template();
    expect(
      (await post('/v1/documents/pages', { workspaceId: w.workspaceId, templateId }, null))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await post('/v1/documents/pages', {
          workspaceId: w.workspaceId,
          templateId: '00000000-0000-4000-8000-000000000000',
        })
      ).statusCode,
    ).toBe(404);
    const other = await template();
    const theirs = await upload(other.templateId, await agreement());
    const res = await post('/v1/documents/pages', {
      workspaceId: w.workspaceId,
      templateId,
      fileId: theirs.fileId,
    });
    expect(res.statusCode).toBe(404);
    expect((await post('/v1/documents/pages', { workspaceId: w.workspaceId })).statusCode).toBe(
      400,
    );
  }, 30_000);
});

describe('placing the fields from the phone', () => {
  it('finds the spots on the template’s own PDF when none are sent', async () => {
    const { templateId } = await template();
    const res = await post('/v1/documents/place-fields', {
      workspaceId: w.workspaceId,
      templateId,
      roles: [{ key: 'customer', label: 'Client', kind: 'customer' }],
    });
    expect(res.statusCode, res.body).toBe(200);
    const { fields } = res.json() as { fields: DocumentField[] };
    expect(fields.map((f) => [f.type, f.role])).toEqual([
      ['signature', 'customer'],
      ['checkbox', 'customer'],
    ]);
    // On the line drawn after the label.
    expect(fields[0]!.x).toBeCloseTo(170 / 612, 2);
  }, 30_000);
});
