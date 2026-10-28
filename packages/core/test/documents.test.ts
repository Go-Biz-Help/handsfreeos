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
 *   - a person changes a document only by voiding it, and the proof trail never changes;
 *   - someone signing in person gets no link, and Sign now hands it over on their turn only, noting who did (13a);
 *   - a customer's portal shows them their own documents, whose turn it is, and checks their code (10b).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { asCustomer, asUser, rows, sql } from '@hfos/db/client';
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
  documentSignNow,
  documentTemplateBeginUpload,
  documentTemplateCreate,
  documentTemplateDuplicate,
  documentTemplateGet,
  documentTemplateSave,
  documentTemplateSetSource,
  documentVoid,
  executeQuery,
  fileConfirm,
  fileDelete,
  fileStore,
  personCreate,
  personDelete,
  portalAccessGive,
  portalCheckCode,
  portalDocuments,
  portalHome,
  portalSendCode,
  storedFilePath,
  timelineList,
  type CustomerActor,
} from '../src/server';
import {
  consentWording,
  documentStepText,
  signerStatusLabel,
  type DocumentDefinitionInput,
} from '../src';
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

/** A device signed in to this person's portal: the way the worker does it. */
async function portalOf(personId: string): Promise<CustomerActor> {
  const { accessId } = await run(portalAccessGive, { workspaceId: t.wsId, personId }, t.owner);
  const sent = await runSystem(portalSendCode, { workspaceId: t.wsId, accessId }, t.scope);
  const hit = await runSystem(
    portalCheckCode,
    {
      workspaceId: t.wsId,
      accessId,
      code: sent.code,
      tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
    },
    t.scope,
  );
  return { type: 'customer', ...t.scope, personId, sessionId: hit.sessionId! };
}

const asCustomerAsk = <O>(q: Parameters<typeof executeQuery>[1], who: CustomerActor) =>
  executeQuery(testDbs().worker.db, q, { workspaceId: t.wsId }, who, {
    correlationId: randomUUID(),
    channel: 'portal',
  }) as Promise<O>;

describe('signing in person', () => {
  it('sends no link, and Sign now hands it over on their turn, checking the code', async () => {
    const gus = await customerWith('Gus', { email: 'gus@example.com' });
    const sent = await run(
      documentSend,
      {
        workspaceId: t.wsId,
        templateId,
        about: { personId: gus },
        signers: [
          { roleKey: 'customer', personId: gus, inPerson: true },
          { roleKey: 'us', userId: t.owner.id },
        ],
        values: { f_price: { kind: 'text', text: '$1,450' } },
        settings: { askCode: true },
      },
      t.member,
    );
    const [customer, us] = sent.signers;
    let got = await ask(
      documentGet,
      { workspaceId: t.wsId, documentId: sent.documentId },
      t.member,
    );
    expect(got.signers[0]).toMatchObject({ inPerson: true, status: 'waiting' });
    expect(signerStatusLabel(got.signers[0]!, got.signers)).toBe('Signs with you in person');

    await expectHfos(
      () => run(documentSignNow, { workspaceId: t.wsId, signerId: us!.signerId }, t.member),
      'document_not_their_turn',
      409,
    );
    expect(
      await run(documentSignNow, { workspaceId: t.wsId, signerId: customer!.signerId }, t.member),
    ).toEqual({ documentId: sent.documentId, signerId: customer!.signerId, codeChecked: true });
    got = await ask(documentGet, { workspaceId: t.wsId, documentId: sent.documentId }, t.member);
    const step = got.steps.find((s) => s.kind === 'in_person');
    expect(step).toMatchObject({ signerId: customer!.signerId, byUserId: t.member.id });
    expect(documentStepText(step as never)).toBe('Handed over to sign in person by Mike Member');
    expect(await events(sent.documentId, 'document.handed_over')).toHaveLength(1);

    // No code to type: whoever handed it over says it's them.
    await runSystem(
      documentSign,
      {
        workspaceId: t.wsId,
        signerId: customer!.signerId,
        agreedWording: 'I agree',
        values: {
          f_name: { kind: 'text', text: 'Gus Renter' },
          f_email: { kind: 'text', text: 'gus@example.com' },
          f_sign: signature('Gus'),
        },
      },
      t.scope,
    );
    await expectHfos(
      () => run(documentSignNow, { workspaceId: t.wsId, signerId: customer!.signerId }, t.member),
      'document_signer_done',
      409,
    );
  });

  it('goes out to someone with no way to reach them, and Remind sends a link only when there is one', async () => {
    const hal = await customerWith('Hal', {});
    const unreachable = () =>
      run(
        documentSend,
        {
          workspaceId: t.wsId,
          templateId,
          about: { personId: hal },
          signers: [
            { roleKey: 'customer', personId: hal },
            { roleKey: 'us', userId: t.owner.id },
          ],
          values: { f_price: { kind: 'text', text: '$1,450' } },
        },
        t.member,
      );
    await expectHfos(unreachable, 'document_signer_unreachable', 409);
    const sent = await run(
      documentSend,
      {
        workspaceId: t.wsId,
        templateId,
        about: { personId: hal },
        signers: [
          { roleKey: 'customer', personId: hal, inPerson: true },
          { roleKey: 'us', userId: t.owner.id },
        ],
        values: { f_price: { kind: 'text', text: '$1,450' } },
      },
      t.member,
    );
    const e = await expectHfos(
      () => run(documentRemind, { workspaceId: t.wsId, documentId: sent.documentId }, t.member),
      'document_signer_unreachable',
      409,
    );
    expect(e.message).toContain('Use Sign now when you’re together');

    const ida = await customerWith('Ida', { email: 'ida@example.com' });
    const withEmail = await run(
      documentSend,
      {
        workspaceId: t.wsId,
        templateId,
        about: { personId: ida },
        signers: [
          { roleKey: 'customer', personId: ida, inPerson: true },
          { roleKey: 'us', userId: t.owner.id },
        ],
        values: { f_price: { kind: 'text', text: '$1,450' } },
      },
      t.member,
    );
    await run(documentRemind, { workspaceId: t.wsId, documentId: withEmail.documentId }, t.member);
    const [asked] = await events(withEmail.documentId, 'document.reminder_asked');
    expect(asked!.payload['signerIds']).toEqual([withEmail.signers[0]!.signerId]);
  });

  it('lets a person note only a hand-over, on a signer whose turn it may be', async () => {
    const jo = await customerWith('Jo', { email: 'jo@example.com' });
    const sent = await send(jo);
    const asMember = (q: ReturnType<typeof sql>) =>
      asUser(testDbs().api.db, t.member.claims, (tx) => rows(tx, q));
    const signed = await expectPgError(() =>
      asMember(
        sql`update app.document_signers set status = 'signed', signed_at = now() where id = ${sent.signers[0]!.signerId}`,
      ),
    );
    expect(signed.code).toBe('42501');
    const step = await expectPgError(() =>
      asMember(
        sql`insert into app.document_steps (workspace_id, document_id, signer_id, kind, by_user_id)
            values (${t.wsId}, ${sent.documentId}, ${sent.signers[0]!.signerId}, 'signed', ${t.member.id})`,
      ),
    );
    expect(step.code).toBe('42501');
  });
});

describe('the customer’s portal', () => {
  it('shows them their own documents, and whose turn it is', async () => {
    const kay = await customerWith('Kay', { email: 'kay@example.com' });
    const lou = await customerWith('Lou', { email: 'lou@example.com' });
    const kays = await portalOf(kay);
    expect(
      (await asCustomerAsk<{ documents: unknown[] }>(portalDocuments, kays)).documents,
    ).toEqual([]);
    expect(
      (await asCustomerAsk<{ documents: { total: number } }>(portalHome, kays)).documents,
    ).toEqual({ total: 0, toSign: 0 });

    const first = await send(kay);
    const voided = await send(kay);
    await run(documentVoid, { workspaceId: t.wsId, documentId: voided.documentId }, t.owner);
    // Someone else's isn't theirs to see.
    await send(lou);

    const { documents } = await asCustomerAsk<{
      documents: { documentId: string; yourTurn: boolean; status: string; kind: string }[];
    }>(portalDocuments, kays);
    expect(documents).toEqual([
      expect.objectContaining({
        documentId: first.documentId,
        yourTurn: true,
        status: 'out',
        kind: 'signer',
      }),
    ]);
    expect((await asCustomerAsk<{ documents: unknown }>(portalHome, kays)).documents).toEqual({
      total: 1,
      toSign: 1,
    });

    // The database shows them their own place, and nobody's contact details.
    const seen = await asCustomer(testDbs().worker.db, kays.sessionId!, (tx) =>
      rows<{ id: string }>(tx, sql`select id from app.document_signers order by id`),
    );
    expect(seen.map((s) => s.id).sort()).toEqual(first.signers.map((s) => s.signerId).sort());
    const email = await expectPgError(() =>
      asCustomer(testDbs().worker.db, kays.sessionId!, (tx) =>
        rows(tx, sql`select email from app.document_signers`),
      ),
    );
    expect(email.code).toBe('42501');

    // Once they've signed, it's the team's turn, not theirs.
    await runSystem(
      documentSign,
      {
        workspaceId: t.wsId,
        signerId: first.signers[0]!.signerId,
        agreedWording: 'I agree',
        values: {
          f_name: { kind: 'text', text: 'Kay Renter' },
          f_email: { kind: 'text', text: 'kay@example.com' },
          f_sign: signature('Kay'),
        },
      },
      t.scope,
    );
    const after = await asCustomerAsk<{
      documents: { yourTurn: boolean; signerStatus: string }[];
    }>(portalDocuments, kays);
    expect(after.documents).toEqual([
      expect.objectContaining({ yourTurn: false, signerStatus: 'signed' }),
    ]);
  });

  it('checks their code when they open it from there', async () => {
    const max = await customerWith('Max', { email: 'max@example.com' });
    const sent = await send(max, { settings: { askCode: true } });
    const signerId = sent.signers[0]!.signerId;
    await runSystem(
      documentOpen,
      { workspaceId: t.wsId, signerId, channel: 'portal', ip: '203.0.113.9', device: null },
      t.scope,
    );
    const got = await ask(
      documentGet,
      { workspaceId: t.wsId, documentId: sent.documentId },
      t.owner,
    );
    expect(got.signers[0]).toMatchObject({ status: 'opened' });
    const texts = got.steps
      .filter((s) => s.signerId === signerId)
      .map((s) => documentStepText(s as never));
    expect(texts).toEqual(
      expect.arrayContaining([
        'Code not needed: signed in to their portal',
        'Opened from their portal',
      ]),
    );
    await runSystem(
      documentSign,
      {
        workspaceId: t.wsId,
        signerId,
        agreedWording: 'I agree',
        values: {
          f_name: { kind: 'text', text: 'Max Renter' },
          f_email: { kind: 'text', text: 'max@example.com' },
          f_sign: signature('Max'),
        },
      },
      t.scope,
    );
  });
});
