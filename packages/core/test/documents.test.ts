/**
 * Documents to sign (docs/documents.md) on the real database: a template made from a PDF, sent to a customer and
 * someone from the team in order, signed, and finished; voided, declined and out of time; and the database keeping
 * each side to its own part.
 *
 * What's worth holding:
 *   - owners and admins make templates, members don't, and a template's PDF can't be deleted from under it;
 *   - a template with someone who has nothing to sign doesn't go out, and the business's own fields must be filled;
 *   - one role at a time in order: the first link goes to the customer, the team's when they've signed;
 *   - a signer must fill in their required fields, their date fills itself, and a code first when it's asked for;
 *   - what the customer typed fills their blanks, and never writes over anything (answer 7a);
 *   - voided, declined and out of time stop signing; a customer with a document out can't be deleted;
 *   - a person changes a document only by voiding it, and the proof trail never changes.
 */
import { createHash, randomUUID } from 'node:crypto';
import { asUser, rows, sql } from '@hfos/db/client';
import { closeTestDbs, expectPgError, testDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentCodeCheck,
  documentCodeSent,
  documentDecline,
  documentExpire,
  documentFinish,
  documentGet,
  documentLinkSent,
  documentList,
  documentOpen,
  documentPrefill,
  documentRemind,
  documentSend,
  documentSign,
  documentTemplateBeginUpload,
  documentTemplateCreate,
  documentTemplateDuplicate,
  documentTemplateGet,
  documentTemplateSave,
  documentTemplateSetSource,
  documentVoid,
  fileConfirm,
  fileDelete,
  fileStore,
  personCreate,
  personDelete,
  storedFilePath,
  timelineList,
} from '../src/server';
import { consentWording, type DocumentDefinitionInput } from '../src';
import { admin, ask, expectHfos, run, runSystem, setupTeam, type Team } from './calendar-helpers';

let t: Team;
let templateId: string;
let revision: number;

const SIG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const signature = (name: string) => ({
  kind: 'signature' as const,
  how: 'typed' as const,
  image: SIG,
  name,
  style: 'caveat' as const,
});
const hash = (code: string) => createHash('sha256').update(code).digest('hex');

const putObject = (path: string, size: number, mimetype: string) =>
  rows(
    admin(),
    sql`insert into storage.objects (bucket_id, name, metadata)
        values ('attachments', ${path}, ${JSON.stringify({ size, mimetype })}::jsonb)`,
  );

const definition = (): DocumentDefinitionInput => ({
  roles: [
    { key: 'customer', label: 'Customer', kind: 'customer' },
    { key: 'us', label: 'Us', kind: 'team' },
  ],
  fields: [
    {
      id: 'f_business',
      type: 'text',
      role: 'sender',
      page: 0,
      x: 0.1,
      y: 0.05,
      w: 0.3,
      h: 0.03,
      fillFrom: 'business.name',
    },
    {
      id: 'f_price',
      type: 'text',
      role: 'sender',
      page: 0,
      x: 0.1,
      y: 0.1,
      w: 0.3,
      h: 0.03,
      label: 'Price',
    },
    {
      id: 'f_name',
      type: 'name',
      role: 'customer',
      page: 0,
      x: 0.1,
      y: 0.5,
      w: 0.3,
      h: 0.03,
      fillFrom: 'customer.name',
    },
    {
      id: 'f_email',
      type: 'email',
      role: 'customer',
      page: 0,
      x: 0.1,
      y: 0.55,
      w: 0.3,
      h: 0.03,
      fillFrom: 'customer.email',
    },
    { id: 'f_sign', type: 'signature', role: 'customer', page: 1, x: 0.1, y: 0.8, w: 0.3, h: 0.06 },
    {
      id: 'f_date',
      type: 'date_signed',
      role: 'customer',
      page: 1,
      x: 0.5,
      y: 0.8,
      w: 0.2,
      h: 0.03,
    },
    {
      id: 'f_pets',
      type: 'checkbox',
      role: 'customer',
      page: 1,
      x: 0.1,
      y: 0.7,
      w: 0.03,
      h: 0.03,
      required: false,
    },
    { id: 'f_ours', type: 'signature', role: 'us', page: 1, x: 0.5, y: 0.9, w: 0.3, h: 0.06 },
  ],
  edits: [
    {
      id: 'e_rent',
      page: 0,
      x: 0.2,
      y: 0.3,
      w: 0.2,
      h: 0.02,
      text: '$1,450 a month',
      original: '$1,400 a month',
    },
  ],
  settings: { order: 'order' },
});

async function customerWith(first: string, contact: { email?: string; phone?: string }) {
  const out = await run(
    personCreate,
    {
      workspaceId: t.wsId,
      firstName: first,
      lastName: 'Renter',
      ignoreDuplicates: true,
      ...contact,
    },
    t.owner,
  );
  return out.personId;
}

async function send(personId: string, extra: Record<string, unknown> = {}) {
  return run(
    documentSend,
    {
      workspaceId: t.wsId,
      templateId,
      about: { personId },
      signers: [
        { roleKey: 'customer', personId },
        { roleKey: 'us', userId: t.owner.id },
      ],
      values: { f_price: { kind: 'text', text: '$1,450' } },
      ...extra,
    },
    t.member,
  );
}

async function events(documentId: string, type: string) {
  return rows<{ payload: Record<string, unknown> }>(
    admin(),
    sql`select payload from app.events where entity_id = ${documentId} and event_type = ${type} order by occurred_at`,
  );
}

beforeAll(async () => {
  t = await setupTeam('docs');
  const made = await run(documentTemplateCreate, { workspaceId: t.wsId, name: 'Lease' }, t.owner);
  templateId = made.templateId;
  const begun = await run(
    documentTemplateBeginUpload,
    {
      workspaceId: t.wsId,
      templateId,
      name: 'Lease 2026.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 4096,
    },
    t.owner,
  );
  expect(begun.objectPath).toBe(`${t.wsId}/document/${templateId}/${begun.fileId}/Lease-2026.pdf`);
  await putObject(begun.objectPath, 4096, 'application/pdf');
  await run(fileConfirm, { workspaceId: t.wsId, fileId: begun.fileId }, t.owner);
  const set = await run(
    documentTemplateSetSource,
    {
      workspaceId: t.wsId,
      templateId,
      fileId: begun.fileId,
      pages: [
        { width: 612, height: 792 },
        { width: 612, height: 792 },
      ],
      baseRevision: made.revision,
    },
    t.owner,
  );
  const saved = await run(
    documentTemplateSave,
    { workspaceId: t.wsId, templateId, baseRevision: set.revision, definition: definition() },
    t.owner,
  );
  expect(saved).toMatchObject({ changed: true, issues: [] });
  revision = saved.revision;
});
afterAll(closeTestDbs);

describe('templates', () => {
  it('are made by owners and admins, and members only read them', async () => {
    await expectHfos(
      () => run(documentTemplateCreate, { workspaceId: t.wsId, name: 'Mine' }, t.member),
      'forbidden',
      403,
    );
    const got = await ask(documentTemplateGet, { workspaceId: t.wsId, templateId }, t.member);
    expect(got).toMatchObject({ name: 'Lease', revision, issues: [], documentsOut: 0 });
    expect(got.source?.name).toBe('Lease 2026.pdf');
  });

  it('keep the pages their PDF has, and refuse a stale save', async () => {
    const d = definition();
    await expectHfos(
      () =>
        run(
          documentTemplateSave,
          { workspaceId: t.wsId, templateId, baseRevision: revision - 1, definition: d },
          t.owner,
        ),
      'revision_conflict',
      409,
    );
    const same = await run(
      documentTemplateSave,
      {
        workspaceId: t.wsId,
        templateId,
        baseRevision: revision,
        definition: {
          ...d,
          pages: [
            { width: 100, height: 100 },
            { width: 100, height: 100 },
            { width: 100, height: 100 },
          ],
        },
      },
      t.owner,
    );
    expect(same.changed).toBe(false);
  });

  it('say who has nothing to sign', async () => {
    const copy = await run(documentTemplateDuplicate, { workspaceId: t.wsId, templateId }, t.owner);
    const got = await ask(
      documentTemplateGet,
      { workspaceId: t.wsId, templateId: copy.templateId },
      t.owner,
    );
    expect(got.name).toBe('Lease (copy)');
    expect(got.source?.name).toBe('Lease 2026.pdf');
    const d = definition();
    const saved = await run(
      documentTemplateSave,
      {
        workspaceId: t.wsId,
        templateId: copy.templateId,
        baseRevision: got.revision,
        definition: { ...d, fields: d.fields!.filter((f) => f.role !== 'us') },
      },
      t.owner,
    );
    expect(saved.issues.map((i) => i.rule)).toEqual(['document_role_empty']);
    const who = await customerWith('Nell', { email: 'nell@example.com' });
    await expectHfos(
      () =>
        run(
          documentSend,
          {
            workspaceId: t.wsId,
            templateId: copy.templateId,
            about: { personId: who },
            signers: [
              { roleKey: 'customer', personId: who },
              { roleKey: 'us', userId: t.owner.id },
            ],
          },
          t.owner,
        ),
      'document_template_not_ready',
      409,
    );
  });

  it('keep their PDF', async () => {
    const got = await ask(documentTemplateGet, { workspaceId: t.wsId, templateId }, t.owner);
    await expectHfos(
      () => run(fileDelete, { workspaceId: t.wsId, fileId: got.source!.fileId }, t.owner),
      'document_file_kept',
      409,
    );
  });
});

describe('sending and signing', () => {
  it('goes to the customer first, then the team, and files the signed copy', async () => {
    const pat = await customerWith('Pat', { phone: '+17135550101' });
    const pre = await ask(
      documentPrefill,
      { workspaceId: t.wsId, templateId, about: { personId: pat } },
      t.member,
    );
    expect(pre.presets).toMatchObject({
      f_business: { kind: 'text', text: 'docs HVAC' },
      f_name: { kind: 'text', text: 'Pat Renter' },
    });
    expect(pre.signers).toMatchObject([
      { roleKey: 'customer', personId: pat },
      { roleKey: 'us', userId: t.member.id },
    ]);
    await expectHfos(
      () =>
        run(
          documentSend,
          {
            workspaceId: t.wsId,
            templateId,
            about: { personId: pat },
            signers: [
              { roleKey: 'customer', personId: pat },
              { roleKey: 'us', userId: t.owner.id },
            ],
          },
          t.member,
        ),
      'validation',
      400,
    );

    const sent = await send(pat);
    expect(sent.signers.map((s) => [s.roleKey, s.status])).toEqual([
      ['customer', 'waiting'],
      ['us', 'waiting'],
    ]);
    const [customer, us] = sent.signers;
    const [first] = await events(sent.documentId, 'document.sent');
    expect(first!.payload['signerIds']).toEqual([customer!.signerId]);

    await runSystem(
      documentLinkSent,
      { workspaceId: t.wsId, signerId: customer!.signerId, channels: ['sms'] },
      t.scope,
    );
    expect(
      await runSystem(
        documentOpen,
        { workspaceId: t.wsId, signerId: customer!.signerId, ip: '203.0.113.9', device: 'Safari' },
        t.scope,
      ),
    ).toEqual({ signerId: customer!.signerId, first: true });

    // The team's turn hasn't come.
    await expectHfos(
      () =>
        runSystem(
          documentSign,
          {
            workspaceId: t.wsId,
            signerId: us!.signerId,
            agreedWording: 'I agree',
            values: { f_ours: signature('Dale') },
          },
          t.scope,
        ),
      'document_not_your_turn',
      409,
    );
    // Their signature is required; their email is checked.
    await expectHfos(
      () =>
        runSystem(
          documentSign,
          {
            workspaceId: t.wsId,
            signerId: customer!.signerId,
            agreedWording: consentWording('docs HVAC'),
            values: {
              f_name: { kind: 'text', text: 'Pat Renter' },
              f_email: { kind: 'text', text: 'pat@example.com' },
            },
          },
          t.scope,
        ),
      'document_fields_missing',
      400,
    );
    await expectHfos(
      () =>
        runSystem(
          documentSign,
          {
            workspaceId: t.wsId,
            signerId: customer!.signerId,
            agreedWording: consentWording('docs HVAC'),
            values: {
              f_name: { kind: 'text', text: 'Pat Renter' },
              f_email: { kind: 'text', text: 'pat at example' },
              f_sign: signature('Pat Renter'),
            },
          },
          t.scope,
        ),
      'document_fields_missing',
      400,
    );
    const signed = await runSystem(
      documentSign,
      {
        workspaceId: t.wsId,
        signerId: customer!.signerId,
        agreedWording: consentWording('docs HVAC'),
        values: {
          f_name: { kind: 'text', text: 'Pat Renter' },
          f_email: { kind: 'text', text: 'pat@example.com' },
          f_sign: signature('Pat Renter'),
          // Not theirs: left out.
          f_ours: signature('Pat Renter'),
        },
        ip: '203.0.113.9',
        device: 'Safari',
      },
      t.scope,
    );
    expect(signed).toEqual({
      signerId: customer!.signerId,
      allSigned: false,
      next: [us!.signerId],
    });
    expect((await events(sent.documentId, 'document.turn'))[0]!.payload['signerIds']).toEqual([
      us!.signerId,
    ]);
    // Answer 7a: the blank email is filled; the name they already had stays.
    const [person] = await rows<{ email: string; first_name: string }>(
      admin(),
      sql`select email, first_name from app.people where id = ${pat}`,
    );
    expect(person).toEqual({ email: 'pat@example.com', first_name: 'Pat' });

    const done = await runSystem(
      documentSign,
      {
        workspaceId: t.wsId,
        signerId: us!.signerId,
        agreedWording: 'I agree',
        values: { f_ours: signature('Dale Owner') },
      },
      t.scope,
    );
    expect(done).toEqual({ signerId: us!.signerId, allSigned: true, next: [] });
    expect(await events(sent.documentId, 'document.all_signed')).toHaveLength(1);

    const got = await ask(
      documentGet,
      { workspaceId: t.wsId, documentId: sent.documentId },
      t.member,
    );
    expect(got).toMatchObject({ status: 'out', finishing: true, canSend: true });
    expect(got.values['f_business']).toEqual({ kind: 'text', text: 'docs HVAC' });
    expect(got.values['f_date']).toMatchObject({ kind: 'date' });
    expect(got.values['f_ours']).toMatchObject({ name: 'Dale Owner' });
    expect(got.valuesBy['f_sign']).toBe(customer!.signerId);
    expect(got.steps.map((s) => s.kind)).toEqual([
      'prepared',
      'sent',
      'opened',
      'agreed',
      'signed',
      'agreed',
      'signed',
    ]);

    // The worker files the signed copy on the customer, locked, and finishes it.
    const fileId = randomUUID();
    const path = storedFilePath(t.wsId, 'person', pat, fileId, 'Lease (signed).pdf');
    await putObject(path, 9000, 'application/pdf');
    await runSystem(
      fileStore,
      {
        workspaceId: t.wsId,
        id: fileId,
        recordType: 'person',
        recordId: pat,
        name: 'Lease (signed).pdf',
        mimeType: 'application/pdf',
      },
      t.scope,
    );
    await runSystem(
      documentFinish,
      {
        workspaceId: t.wsId,
        documentId: sent.documentId,
        signedFileId: fileId,
        sourceSha256: hash('a'),
        signedSha256: hash('b'),
      },
      t.scope,
    );
    const finished = await ask(
      documentGet,
      { workspaceId: t.wsId, documentId: sent.documentId },
      t.owner,
    );
    expect(finished).toMatchObject({
      status: 'completed',
      finishing: false,
      signedSha256: hash('b'),
    });
    expect(finished.signed?.fileId).toBe(fileId);
    const { items } = await ask(
      timelineList,
      { workspaceId: t.wsId, recordType: 'person', recordId: pat },
      t.owner,
    );
    expect(items.map((e) => e.subtype)).toEqual(
      expect.arrayContaining(['document_sent', 'document_signed', 'document_completed']),
    );
  });

  it('asks for the code first when the template says so', async () => {
    const cy = await customerWith('Cy', { email: 'cy@example.com' });
    const sent = await send(cy, { settings: { askCode: true } });
    const customer = sent.signers[0]!;
    await runSystem(
      documentCodeSent,
      {
        workspaceId: t.wsId,
        signerId: customer.signerId,
        codeHash: hash('123456'),
        channel: 'email',
      },
      t.scope,
    );
    const values = {
      f_name: { kind: 'text', text: 'Cy Renter' },
      f_email: { kind: 'text', text: 'cy@example.com' },
      f_sign: signature('Cy'),
    };
    await expectHfos(
      () =>
        runSystem(
          documentSign,
          { workspaceId: t.wsId, signerId: customer.signerId, agreedWording: 'I agree', values },
          t.scope,
        ),
      'document_code_needed',
      403,
    );
    expect(
      await runSystem(
        documentCodeCheck,
        { workspaceId: t.wsId, signerId: customer.signerId, codeHash: hash('000000') },
        t.scope,
      ),
    ).toEqual({ ok: false, triesLeft: 4 });
    expect(
      await runSystem(
        documentCodeCheck,
        { workspaceId: t.wsId, signerId: customer.signerId, codeHash: hash('123456') },
        t.scope,
      ),
    ).toEqual({ ok: true, triesLeft: 5 });
    await runSystem(
      documentSign,
      { workspaceId: t.wsId, signerId: customer.signerId, agreedWording: 'I agree', values },
      t.scope,
    );
  });

  it('stops when voided, declined or out of time', async () => {
    const di = await customerWith('Di', { email: 'di@example.com' });
    const voided = await send(di);
    await expectHfos(
      () => run(documentRemind, { workspaceId: t.wsId, documentId: voided.documentId }, t.member),
      'document_nobody_to_remind',
      409,
    );
    await run(
      documentVoid,
      { workspaceId: t.wsId, documentId: voided.documentId, reason: 'Wrong rent' },
      t.member,
    );
    await expectHfos(
      () =>
        runSystem(
          documentSign,
          {
            workspaceId: t.wsId,
            signerId: voided.signers[0]!.signerId,
            agreedWording: 'I agree',
            values: {},
          },
          t.scope,
        ),
      'document_voided',
      409,
    );
    const declined = await send(di);
    await runSystem(
      documentDecline,
      { workspaceId: t.wsId, signerId: declined.signers[0]!.signerId, reason: 'Rent is too high' },
      t.scope,
    );
    const got = await ask(
      documentGet,
      { workspaceId: t.wsId, documentId: declined.documentId },
      t.owner,
    );
    expect(got).toMatchObject({ status: 'declined' });
    expect(got.signers[0]).toMatchObject({ status: 'declined', declineReason: 'Rent is too high' });

    const late = await send(di);
    // Its day passes: the guard lets only the worker change a document, so the clock is moved past it here.
    await admin().transaction(async (tx) => {
      await rows(tx, sql`set local session_replication_role = replica`);
      await rows(
        tx,
        sql`update app.documents set expires_at = sent_at + interval '1 millisecond' where id = ${late.documentId}`,
      );
    });
    expect(
      await runSystem(
        documentExpire,
        { workspaceId: t.wsId, documentId: late.documentId },
        t.scope,
      ),
    ).toEqual({ documentId: late.documentId, changed: true });
    const { documents } = await ask(documentList, { workspaceId: t.wsId, personId: di }, t.member);
    expect(documents.map((d) => d.status)).toEqual(['expired', 'declined', 'voided']);
  });

  it('keeps a customer with a document out from being deleted', async () => {
    const ed = await customerWith('Ed', { email: 'ed@example.com' });
    const sent = await send(ed);
    const e = await expectHfos(
      () => run(personDelete, { workspaceId: t.wsId, personIds: [ed] }, t.owner),
      'bin_document_out',
      409,
    );
    expect(e.message).toBe(
      'Ed Renter has a document out for signing, Lease. Void it on Documents first, then delete them.',
    );
    await run(documentVoid, { workspaceId: t.wsId, documentId: sent.documentId }, t.owner);
    await run(personDelete, { workspaceId: t.wsId, personIds: [ed] }, t.owner);
    const { documents } = await ask(documentList, { workspaceId: t.wsId, personId: ed }, t.owner);
    expect(documents).toEqual([]);
  });
});

describe('the database', () => {
  it('lets a person only void a document, and never change its history', async () => {
    const fay = await customerWith('Fay', { email: 'fay@example.com' });
    const sent = await send(fay);
    const asMember = (q: ReturnType<typeof sql>) =>
      asUser(testDbs().api.db, t.member.claims, (tx) => rows(tx, q));
    const changed = await expectPgError(() =>
      asMember(
        sql`update app.documents set status = 'completed', completed_at = now() where id = ${sent.documentId}`,
      ),
    );
    expect(changed.code).toBe('42501');
    const history = await expectPgError(() =>
      asMember(
        sql`update app.document_steps set kind = 'signed' where document_id = ${sent.documentId}`,
      ),
    );
    expect(history.code).toBe('42501');
    await asMember(sql`update app.document_templates set name = 'Mine' where id = ${templateId}`);
    const [still] = await rows<{ name: string }>(
      admin(),
      sql`select name from app.document_templates where id = ${templateId}`,
    );
    expect(still!.name).toBe('Lease');
  });
});
