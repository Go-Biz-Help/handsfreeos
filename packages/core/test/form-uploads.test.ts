/**
 * Files on a public form, on the local database (product sellers, 5a): a customer adds their design while they fill
 * the form in, it's checked as it arrives, and on sending it's copied onto them while the answers keep their own.
 * Only the sheet that uploaded a file can send it, and files taken back are removed.
 */
import { eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { events, files, forms } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  formCreate,
  formPublish,
  formResponseDelete,
  formResponseGet,
  formResponseStart,
  formResponseSubmit,
  formResponseUploadBegin,
  formResponseUploadConfirm,
  formSaveDraft,
  organizationCreate,
} from '../src/server';
import { admin, ask, expectHfos, run, runSystem, type Scope } from './calendar-helpers';

let owner: TestUser;
let wsId: string;
let scope: Scope;

beforeAll(async () => {
  owner = await createTestUser('form-upload-owner', { fullName: 'Sherri Owner' });
  const org = await run(organizationCreate, { businessName: 'Crafts and Things' }, owner);
  wsId = org.workspaceId;
  scope = { workspaceId: wsId, organizationId: org.organizationId };
});
afterAll(closeTestDbs);

const qid = (name: string) => `q_${name.padEnd(8, '0').slice(0, 8)}`;

/** A live order form: a name, a phone, and a design upload (photos and PDFs, two at most, 5 MB each). */
async function orderForm(fileConfig: Record<string, unknown> = {}) {
  const created = await run(formCreate, { workspaceId: wsId, name: 'Custom order' }, owner);
  const [row] = await admin().select().from(forms).where(eq(forms.id, created.formId));
  const pageId = (row!.definition as { pages: { id: string }[] }).pages[0]!.id;
  const add = (question: Record<string, unknown>) => ({
    op: 'add_question',
    pageId,
    index: null,
    question: { config: {}, ...question },
  });
  const saved = await run(
    formSaveDraft,
    {
      workspaceId: wsId,
      formId: created.formId,
      baseRevision: 1,
      ops: [
        add({
          id: qid('name'),
          type: 'short_text',
          title: 'Name',
          required: true,
          mapTo: 'person.first_name',
        }),
        add({ id: qid('phone'), type: 'phone', title: 'Phone', mapTo: 'person.phone' }),
        add({
          id: qid('design'),
          type: 'file',
          title: 'Your design',
          config: { maxFiles: 2, maxMb: 5, accept: 'document', ...fileConfig },
        }),
      ],
    },
    owner,
  );
  await run(
    formPublish,
    { workspaceId: wsId, formId: created.formId, baseRevision: saved.revision },
    owner,
  );
  return created.formId;
}

const start = (formId: string) =>
  runSystem(formResponseStart, { workspaceId: wsId, formId, source: 'link' }, scope);

type Sheet = Awaited<ReturnType<typeof start>>;

const begin = (sheet: Sheet, name: string, mimeType: string, sizeBytes: number, token?: string) =>
  runSystem(
    formResponseUploadBegin,
    {
      workspaceId: wsId,
      responseId: sheet.responseId,
      token: token ?? sheet.token,
      questionId: qid('design'),
      name,
      mimeType,
      sizeBytes,
    },
    scope,
  );

/** What the browser's PUT leaves behind: the stored object, as Storage measured it. */
const arrive = (objectPath: string, size: number, mimetype: string) =>
  rows(
    admin(),
    sql`insert into storage.objects (bucket_id, name, metadata)
        values ('attachments', ${objectPath}, ${JSON.stringify({ size, mimetype })}::jsonb)`,
  );

const confirm = (sheet: Sheet, fileId: string) =>
  runSystem(
    formResponseUploadConfirm,
    { workspaceId: wsId, responseId: sheet.responseId, token: sheet.token, fileId },
    scope,
  );

/** Begins, arrives and confirms: a file the page now holds. */
async function uploaded(sheet: Sheet, name: string, mimeType = 'image/png', size = 2048) {
  const begun = await begin(sheet, name, mimeType, size);
  await arrive(begun.objectPath, size, mimeType);
  const done = await confirm(sheet, begun.fileId);
  expect(done.accepted).toBe(true);
  return { fileId: done.fileId, name: done.name, bytes: done.bytes, objectPath: begun.objectPath };
}

const fileRow = async (fileId: string) => {
  const [r] = await admin().select().from(files).where(eq(files.id, fileId));
  return r!;
};

describe('adding a file while filling it in', () => {
  it('keeps its place on the sheet, in the sheet’s own folder on the form', async () => {
    const formId = await orderForm();
    const sheet = await start(formId);
    const begun = await begin(sheet, 'front design.png', 'image/png', 4096);
    expect(begun.objectPath).toBe(
      `${wsId}/form/${formId}/responses/${sheet.responseId}/${qid('design')}/${begun.fileId}/front-design.png`,
    );
    const row = await fileRow(begun.fileId);
    expect(row).toMatchObject({ recordType: 'form', recordId: formId, status: 'pending' });
  });

  it('turns away what the question doesn’t take, too many, and a stranger without the key', async () => {
    const formId = await orderForm({ accept: 'image', maxFiles: 1 });
    const sheet = await start(formId);
    await expectHfos(
      () => begin(sheet, 'quote.pdf', 'application/pdf', 100),
      'form_file_type',
      422,
    );
    await expectHfos(
      () => begin(sheet, 'huge.jpg', 'image/jpeg', 6 * 1024 * 1024),
      'form_file_too_big',
      422,
    );
    await uploaded(sheet, 'one.png');
    await expectHfos(() => begin(sheet, 'two.png', 'image/png', 100), 'form_too_many_files', 409);
    await expectHfos(
      () => begin(sheet, 'sneaky.png', 'image/png', 100, 'not-the-key-0000000000'),
      'not_found',
      404,
    );
  });

  it('removes what arrived when it isn’t what the browser said', async () => {
    const formId = await orderForm({ accept: 'image' });
    const sheet = await start(formId);
    const begun = await begin(sheet, 'photo.png', 'image/png', 1000);
    await arrive(begun.objectPath, 1000, 'application/pdf');
    const done = await confirm(sheet, begun.fileId);
    expect(done.accepted).toBe(false);
    expect(done.refusal?.rule).toBe('form_file_type');
    expect((await fileRow(begun.fileId)).deletedAt).not.toBeNull();
  });

  it('says so when nothing arrived', async () => {
    const formId = await orderForm();
    const sheet = await start(formId);
    const begun = await begin(sheet, 'never.png', 'image/png', 1000);
    await expectHfos(() => confirm(sheet, begun.fileId), 'file_not_uploaded', 409);
  });
});

describe('sending it with files', () => {
  it('copies the files onto the customer and keeps the sheet’s own, dropping any taken back', async () => {
    const formId = await orderForm();
    const sheet = await start(formId);
    const front = await uploaded(sheet, 'front.png');
    const back = await uploaded(sheet, 'back.pdf', 'application/pdf', 9000);
    const sent = await runSystem(
      formResponseSubmit,
      {
        workspaceId: wsId,
        responseId: sheet.responseId,
        token: sheet.token,
        // The page's names and sizes don't count; Storage's do.
        answers: {
          [qid('name')]: 'Sherri',
          [qid('phone')]: '(512) 555-0188',
          [qid('design')]: [
            { ...front, name: 'renamed.png', bytes: 1 },
            { fileId: back.fileId, name: back.name, bytes: back.bytes },
          ],
        },
      },
      scope,
    );
    expect(sent.personId).toBeTruthy();

    // The answer sheet keeps its own copies, on the form, with what was stored.
    const [answer] = await rows<{ value: unknown; text_value: string }>(
      admin(),
      sql`select value, text_value from app.form_answers
          where response_id = ${sheet.responseId} and question_id = ${qid('design')}`,
    );
    expect(answer!.value).toEqual([
      { fileId: front.fileId, name: 'front.png', bytes: 2048 },
      { fileId: back.fileId, name: 'back.pdf', bytes: 9000 },
    ]);
    expect(answer!.text_value).toBe('2 files: front.png, back.pdf');
    expect((await fileRow(front.fileId)).recordType).toBe('form');

    // The customer gets copies, waiting for the worker to put them in place (file.received).
    const copies = await admin().select().from(files).where(eq(files.recordId, sent.personId!));
    expect(copies.map((f) => f.name).sort()).toEqual(['back.pdf', 'front.png']);
    expect(copies.every((f) => f.recordType === 'person' && f.status === 'pending')).toBe(true);
    const [received] = await admin()
      .select()
      .from(events)
      .where(eq(events.eventType, 'file.received'))
      .orderBy(sql`${events.createdAt} desc`)
      .limit(1);
    const payload = received!.payload as {
      personId: string;
      notify: unknown;
      files: { fileId: string; from: { objectPath: string } }[];
    };
    expect(payload.personId).toBe(sent.personId);
    expect(payload.notify).toBeNull();
    expect(payload.files.map((f) => f.from.objectPath).sort()).toEqual(
      [back.objectPath, front.objectPath].sort(),
    );

    // The business opens them from the answers.
    const got = await ask(
      formResponseGet,
      { workspaceId: wsId, responseId: sheet.responseId },
      owner,
    );
    expect(got.files.map((f) => f.name).sort()).toEqual(['back.pdf', 'front.png']);
  });

  it('removes a file they added and took back', async () => {
    const formId = await orderForm();
    const sheet = await start(formId);
    const kept = await uploaded(sheet, 'keep.png');
    const dropped = await uploaded(sheet, 'drop.png');
    await runSystem(
      formResponseSubmit,
      {
        workspaceId: wsId,
        responseId: sheet.responseId,
        token: sheet.token,
        answers: {
          [qid('name')]: 'Pat',
          [qid('phone')]: '(512) 555-0101',
          [qid('design')]: [kept],
        },
      },
      scope,
    );
    expect((await fileRow(dropped.fileId)).deletedAt).not.toBeNull();
    expect((await fileRow(kept.fileId)).deletedAt).toBeNull();
  });

  it('won’t send a file another sheet uploaded, or one that never finished', async () => {
    const formId = await orderForm();
    const mine = await start(formId);
    const theirs = await start(formId);
    const theirFile = await uploaded(theirs, 'theirs.png');
    const unfinished = await begin(mine, 'half.png', 'image/png', 100);
    const sending = (answer: unknown[]) =>
      runSystem(
        formResponseSubmit,
        {
          workspaceId: wsId,
          responseId: mine.responseId,
          token: mine.token,
          answers: {
            [qid('name')]: 'Lee',
            [qid('phone')]: '(512) 555-0103',
            [qid('design')]: answer,
          },
        },
        scope,
      );
    const stolen = await expectHfos(() => sending([theirFile]), 'form_answers_invalid', 400);
    expect(JSON.stringify(stolen.details)).toMatch(/didn’t finish uploading/);
    await expectHfos(
      () => sending([{ fileId: unfinished.fileId, name: 'half.png', bytes: 100 }]),
      'form_answers_invalid',
      400,
    );
  });
});

describe('deleting the answers', () => {
  it('takes the sheet’s own files with it and leaves the customer’s', async () => {
    const formId = await orderForm();
    const sheet = await start(formId);
    const design = await uploaded(sheet, 'logo.png');
    const sent = await runSystem(
      formResponseSubmit,
      {
        workspaceId: wsId,
        responseId: sheet.responseId,
        token: sheet.token,
        answers: {
          [qid('name')]: 'Jo',
          [qid('phone')]: '(512) 555-0102',
          [qid('design')]: [design],
        },
      },
      scope,
    );
    await run(formResponseDelete, { workspaceId: wsId, responseId: sheet.responseId }, owner);
    expect((await fileRow(design.fileId)).deletedAt).not.toBeNull();
    const copies = await admin().select().from(files).where(eq(files.recordId, sent.personId!));
    expect(copies).toHaveLength(1);
    expect(copies[0]!.deletedAt).toBeNull();
  });
});
