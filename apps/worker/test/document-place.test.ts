/**
 * "Place fields for me" through the worker (docs/documents.md, answer 4a), with the scripted stand-in model: the
 * spots the editor found go to the model with who signs, and what comes back are fields on those spots, counted as
 * `documents` usage for the person asking. Nothing is saved: the editor adds them as one change it can undo.
 */
import { randomInt } from 'node:crypto';
import {
  documentTemplateArchive,
  documentTemplateBeginUpload,
  documentTemplateCreate,
  documentTemplateSetSource,
  fileConfirm,
  type DocumentField,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, signInTestUser } from '@hfos/db/testing';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scriptedAi } from '../src/ai/scripted';
import { needsThePdf } from '../src/documents/place';
import { admin, makeWorld, run, type World } from './booking-world';

let w: World;
let bearer: string;

const roles = [
  { key: 'customer', label: 'Client', kind: 'customer' },
  { key: 'us', label: 'Contractor', kind: 'team' },
];
const spot = (
  id: string,
  kind: 'line' | 'box' | 'after',
  y: number,
  near: Record<string, string>,
) => ({
  id,
  page: 0,
  kind,
  x: 0.12,
  y,
  w: kind === 'box' ? 0.016 : 0.33,
  h: kind === 'box' ? 0.013 : 0.002,
  left: '',
  right: '',
  above: '',
  below: '',
  ...near,
});
const START =
  'SERVICE AGREEMENT\nThis agreement is between the Contractor and the Client named below, for the work described.';

async function template(): Promise<string> {
  const made = (await run(w, documentTemplateCreate, {
    workspaceId: w.workspaceId,
    name: 'Service agreement',
  })) as { templateId: string; revision: number };
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText('Client signature: ______________', { x: 72, y: 200, font });
  const pdf = await doc.save();
  const begun = (await run(w, documentTemplateBeginUpload, {
    workspaceId: w.workspaceId,
    templateId: made.templateId,
    name: 'Agreement.pdf',
    mimeType: 'application/pdf',
    sizeBytes: pdf.byteLength,
  })) as { fileId: string; objectPath: string };
  await w.s.store.upload('attachments', begun.objectPath, Buffer.from(pdf), 'application/pdf');
  await run(w, fileConfirm, { workspaceId: w.workspaceId, fileId: begun.fileId });
  await run(w, documentTemplateSetSource, {
    workspaceId: w.workspaceId,
    templateId: made.templateId,
    fileId: begun.fileId,
    pages: [{ width: 612, height: 792 }],
    baseRevision: made.revision,
  });
  return made.templateId;
}

const place = (body: unknown, auth: string | null = bearer) =>
  w.app.inject({
    method: 'POST',
    url: '/v1/documents/place-fields',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `198.51.100.${randomInt(1, 250)}`,
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
    },
    payload: JSON.stringify(body),
  });

beforeAll(async () => {
  w = await makeWorld('docplace', { ai: { provider: scriptedAi() } });
  bearer = await signInTestUser(w.owner);
}, 120_000);

afterAll(async () => {
  await w?.app.close();
  await closeTestDbs();
});

describe('placing the fields', () => {
  it('labels the spots and puts a field on each that is one', async () => {
    const templateId = await template();
    const res = await place({
      workspaceId: w.workspaceId,
      templateId,
      roles,
      start: START,
      spots: [
        spot('s1', 'line', 0.3, { left: 'Client signature:' }),
        spot('s2', 'line', 0.34, { left: 'Date' }),
        spot('s3', 'line', 0.4, { left: 'Print name' }),
        spot('s4', 'box', 0.5, { right: 'I have pets' }),
        // A rule between sections: no words, no field.
        spot('s5', 'line', 0.6, {}),
        spot('s6', 'line', 0.8, { left: 'Contractor signature:' }),
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    const { fields } = res.json() as { fields: DocumentField[] };
    expect(fields.map((f) => [f.type, f.role, f.fillFrom])).toEqual([
      ['signature', 'customer', null],
      ['date_signed', 'customer', null],
      ['name', 'customer', 'customer.name'],
      ['checkbox', 'customer', null],
      ['signature', 'us', null],
    ]);
    // On its line, as a pen would be.
    expect(fields[0]!.y + fields[0]!.h).toBeCloseTo(0.3 + 1 / 792, 4);
    const usage = await rows<{ user_id: string }>(
      admin(),
      sql`select user_id from app.ai_usage where workspace_id = ${w.workspaceId} and source = 'documents'`,
    );
    expect(usage).toEqual([{ user_id: w.owner.id }]);
  });

  it('refuses without a sign-in, and on an archived template', async () => {
    const templateId = await template();
    const body = {
      workspaceId: w.workspaceId,
      templateId,
      roles,
      start: START,
      spots: [spot('s1', 'line', 0.3, { left: 'Signature' })],
    };
    expect((await place(body, null)).statusCode).toBe(401);
    await run(w, documentTemplateArchive, { workspaceId: w.workspaceId, templateId });
    const res = await place(body);
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { rule: string } }).error.rule).toBe(
      'document_template_archived',
    );
  });

  it('shows the model the PDF itself when there are few words to go on', () => {
    const labelled = [spot('s1', 'line', 0.3, { left: 'Signature' })];
    expect(needsThePdf({ start: START, spots: labelled })).toBe(false);
    expect(needsThePdf({ start: '', spots: labelled })).toBe(true);
    expect(
      needsThePdf({
        start: START,
        spots: [spot('s1', 'line', 0.3, {}), spot('s2', 'box', 0.4, {}), ...labelled],
      }),
    ).toBe(false);
    expect(
      needsThePdf({
        start: START,
        spots: [1, 2, 3, 4].map((n) => spot(`s${n}`, 'line', n / 10, {})).concat(labelled),
      }),
    ).toBe(true);
  });
});
