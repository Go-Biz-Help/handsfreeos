/**
 * Documents to sign, through the worker (docs/documents.md): the links going out by email and text, the signing
 * page with its code, signing in turn, the signed copy with its proof page filed and locked, copies to everyone,
 * reminders, running out of time and being taken back.
 *
 * What's worth holding:
 *   - a customer's link goes by email and by text from the business (answer 10b), the team's by email, each in turn;
 *   - nothing of the document shows until the code is right (11a), and a forged or cut-short link is a 404;
 *   - the signed copy is the original with the typed-over words, the fields and signatures on it, and a proof page;
 *     it's filed on the customer, locked, and its fingerprints are kept (16a, 17a);
 *   - everyone gets the signed copy, attached; the signing page downloads it;
 *   - a reminder after the document's days, and a document past its day stops (14a); taking it back tells everyone
 *     who had a link (15a);
 *   - someone signing in person gets no link at their turn, until Remind sends their first (13a);
 *   - from their portal, a customer opens their own document at its signing page with no code to type (10b).
 */
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import {
  documentRemind,
  documentSend,
  documentTemplateBeginUpload,
  documentTemplateCreate,
  documentTemplateSave,
  documentTemplateSetSource,
  documentVoid,
  executeCommand,
  fileConfirm,
  personCreate,
  portalAccessGive,
  portalCheckCode,
  portalSendCode,
  type DocumentDefinitionInput,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, signInTestUser, testDbs } from '@hfos/db/testing';
import { degrees, PDFDocument, StandardFonts } from 'pdf-lib';
import { extractText, getDocumentProxy } from 'unpdf';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { documentsSweep } from '../src/documents/jobs';
import { resolveSignerToken, signerToken } from '../src/documents/links';
import type { JobContext, JobRow } from '../src/jobs';
import {
  admin,
  drain,
  emailsTo,
  makeWorld,
  nextPhone,
  readyTexting,
  run,
  textsTo,
  waitForMail,
  type World,
} from './booking-world';

let w: World;
let templateId: string;
const SIG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const signature = (name: string) => ({
  kind: 'signature',
  how: 'typed',
  image: SIG,
  name,
  style: 'caveat',
});

/** Each call from an address of its own, so the per-address limits never decide a test. */
const ip = () => `198.51.100.${randomInt(1, 250)}`;
const get = (url: string) =>
  w.app.inject({ method: 'GET', url, headers: { 'x-forwarded-for': ip() } });
const post = (url: string, body: unknown = {}) =>
  w.app.inject({
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': ip(),
      'user-agent': 'Vitest Browser',
    },
    payload: JSON.stringify(body),
  });

/** A two-page lease: the second page is turned sideways, the way a scanned page often is. */
async function leasePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const one = doc.addPage([612, 792]);
  one.drawText('Residential lease', { x: 72, y: 720, size: 18, font });
  one.drawText('Monthly rent: $1,400 a month', { x: 72, y: 680, size: 11, font });
  const two = doc.addPage([612, 792]);
  two.drawText('Signatures', { x: 72, y: 720, size: 14, font });
  two.setRotation(degrees(90));
  return doc.save();
}

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
      w: 0.4,
      h: 0.03,
      fillFrom: 'business.name',
    },
    {
      id: 'f_name',
      type: 'name',
      role: 'customer',
      page: 0,
      x: 0.1,
      y: 0.5,
      w: 0.4,
      h: 0.03,
      fillFrom: 'customer.name',
    },
    { id: 'f_sign', type: 'signature', role: 'customer', page: 1, x: 0.1, y: 0.7, w: 0.3, h: 0.08 },
    {
      id: 'f_date',
      type: 'date_signed',
      role: 'customer',
      page: 1,
      x: 0.5,
      y: 0.75,
      w: 0.2,
      h: 0.03,
    },
    {
      id: 'f_pets',
      type: 'checkbox',
      role: 'customer',
      page: 1,
      x: 0.1,
      y: 0.6,
      w: 0.03,
      h: 0.04,
      required: false,
    },
    { id: 'f_ours', type: 'signature', role: 'us', page: 1, x: 0.5, y: 0.85, w: 0.3, h: 0.08 },
  ],
  edits: [
    {
      id: 'e_rent',
      page: 0,
      x: 0.11,
      y: 0.13,
      w: 0.45,
      h: 0.03,
      text: 'Monthly rent: $1,450 a month',
      original: 'Monthly rent: $1,400 a month',
    },
  ],
  settings: { order: 'order' },
});

async function customer(first: string): Promise<{ id: string; email: string; phone: string }> {
  const email = `${first.toLowerCase()}-${randomUUID().slice(0, 8)}@example.com`;
  const phone = nextPhone();
  const out = (await run(w, personCreate, {
    workspaceId: w.workspaceId,
    firstName: first,
    lastName: 'Renter',
    email,
    phone,
  })) as { personId: string };
  return { id: out.personId, email, phone };
}

async function send(personId: string, settings: Record<string, unknown> = {}) {
  return (await run(w, documentSend, {
    workspaceId: w.workspaceId,
    templateId,
    about: { personId },
    signers: [
      { roleKey: 'customer', personId },
      { roleKey: 'us', userId: w.owner.id },
    ],
    settings,
  })) as { documentId: string };
}

const signerOf = async (documentId: string, role: string) => {
  const [s] = await rows<{
    id: string;
    status: string;
    reminders: number;
    public_ref: string;
    link_version: number;
  }>(
    admin(),
    sql`select id, status, reminders, public_ref, link_version from app.document_signers
        where document_id = ${documentId} and role_key = ${role}`,
  );
  return s!;
};

const docRow = async (documentId: string) => {
  const [d] = await rows<{
    status: string;
    signed_file_id: string | null;
    source_sha256: string | null;
    signed_sha256: string | null;
  }>(
    admin(),
    sql`select status, signed_file_id, source_sha256, signed_sha256 from app.documents where id = ${documentId}`,
  );
  return d!;
};

/** The token at the end of the newest /d/ link in some words. */
const tokenIn = (words: string): string => {
  const all = [...words.matchAll(/\/d\/([0-9A-Za-z]{18})/g)];
  expect(all.length, words).toBeGreaterThan(0);
  return all[all.length - 1]![1]!;
};

/** Moves a document's clock back without its guards (sent_at never changes for a person). */
async function backdate(change: ReturnType<typeof sql>): Promise<void> {
  await admin().transaction(async (tx) => {
    await tx.execute(sql`set local session_replication_role = replica`);
    await tx.execute(change);
  });
}

const sweepCtx = (): JobContext =>
  ({
    ...w.s,
    job: { id: randomUUID(), kind: 'documents.sweep', payload: {} } as unknown as JobRow,
    scope: {},
    attempt: 1,
    now: Date.now(),
  }) as JobContext;

beforeAll(async () => {
  w = await makeWorld('docs');
  await readyTexting(w);
  const made = (await run(w, documentTemplateCreate, {
    workspaceId: w.workspaceId,
    name: 'Lease',
  })) as {
    templateId: string;
  };
  templateId = made.templateId;
  const pdf = await leasePdf();
  const begun = (await run(w, documentTemplateBeginUpload, {
    workspaceId: w.workspaceId,
    templateId,
    name: 'Lease.pdf',
    mimeType: 'application/pdf',
    sizeBytes: pdf.byteLength,
  })) as { fileId: string; objectPath: string };
  await w.s.store.upload('attachments', begun.objectPath, Buffer.from(pdf), 'application/pdf');
  await run(w, fileConfirm, { workspaceId: w.workspaceId, fileId: begun.fileId });
  const set = (await run(w, documentTemplateSetSource, {
    workspaceId: w.workspaceId,
    templateId,
    fileId: begun.fileId,
    pages: [
      { width: 612, height: 792 },
      { width: 792, height: 612 },
    ],
    baseRevision: 1,
  })) as { revision: number };
  await run(w, documentTemplateSave, {
    workspaceId: w.workspaceId,
    templateId,
    definition: definition(),
    baseRevision: set.revision,
  });
}, 120_000);

afterAll(async () => {
  await w?.app.close();
  await closeTestDbs();
});

describe('signing, start to finish', () => {
  it('sends in turn, asks for the code, signs, and files a locked signed copy with its proof page', async () => {
    const maria = await customer('Maria');
    const { documentId } = await send(maria.id, { askCode: true });
    await drain(w);

    // The customer's link, by text and by email from the business.
    const texts = textsTo(w, maria.phone);
    expect(texts.map((t) => t.body).join('\n')).toContain('is ready for you to sign');
    const token = tokenIn(texts.map((t) => t.body).join('\n'));
    expect(await emailsTo(w, maria.email)).toContain('Please sign: Lease');
    expect((await signerOf(documentId, 'customer')).status).toBe('sent');
    // Not the team's turn yet.
    expect((await signerOf(documentId, 'us')).status).toBe('waiting');

    // A forged or cut-short link is nothing at all.
    expect((await get(`/public/sign/${token.slice(0, 8)}0000000000`)).statusCode).toBe(404);
    expect((await get(`/public/sign/${token.slice(0, 12)}`)).statusCode).toBe(404);

    // Locked until the code is right.
    const locked = (await get(`/public/sign/${token}`)).json() as {
      content: unknown;
      signer: { askCode: boolean; codeTo: string; yourTurn: boolean };
    };
    expect(locked.content).toBeNull();
    expect(locked.signer.yourTurn).toBe(true);
    expect(locked.signer.codeTo).toBe(`your phone ending in ${maria.phone.slice(-4)}`);
    const early = await post(`/public/sign/${token}/sign`, { agreed: true, values: {} });
    expect(early.statusCode).toBe(403);
    expect((early.json() as { error: { rule: string } }).error.rule).toBe('document_code_needed');

    expect((await post(`/public/sign/${token}/code`)).statusCode).toBe(200);
    // A second one straight after is refused: nobody can flood their phone.
    expect((await post(`/public/sign/${token}/code`)).statusCode).toBe(429);
    await drain(w);
    const codeText = textsTo(w, maria.phone)
      .map((t) => t.body)
      .find((b) => b.includes('is your code'))!;
    const code = /\b(\d{6})\b/.exec(codeText)![1]!;
    const wrong = await post(`/public/sign/${token}/code/check`, {
      code: code === '000000' ? '111111' : '000000',
    });
    expect((wrong.json() as { error: { rule: string } }).error.rule).toBe('document_code_wrong');
    const opened = await post(`/public/sign/${token}/code/check`, { code });
    expect(opened.statusCode, opened.body).toBe(200);
    const view = opened.json() as {
      content: {
        sourceUrl: string;
        pages: unknown[];
        edits: unknown[];
        fields: { id: string; mine: boolean }[];
        values: Record<string, { kind: string; text?: string }>;
      };
      consent: string;
    };
    expect(view.content.pages).toHaveLength(2);
    expect(view.content.sourceUrl).toMatch(/^http/);
    expect(
      view.content.fields
        .filter((f) => f.mine)
        .map((f) => f.id)
        .sort(),
    ).toEqual(['f_date', 'f_name', 'f_pets', 'f_sign']);
    // What HandsFreeOS filled in: the business's own words, and the customer's name, theirs to change.
    expect(view.content.values['f_business']?.text).toContain('Booking HVAC');
    expect(view.content.values['f_name']?.text).toBe('Maria Renter');
    expect(view.consent).toContain('sign this document electronically');
    expect((await post(`/public/sign/${token}/opened`)).statusCode).toBe(200);

    // Their own fields only; and agreeing is a must.
    const missing = await post(`/public/sign/${token}/sign`, {
      agreed: true,
      values: { f_name: { kind: 'text', text: 'Maria Renter' } },
    });
    expect((missing.json() as { error: { rule: string } }).error.rule).toBe(
      'document_fields_missing',
    );
    const unagreed = await post(`/public/sign/${token}/sign`, { agreed: false, values: {} });
    expect(unagreed.statusCode).toBe(400);
    const signed = await post(`/public/sign/${token}/sign`, {
      agreed: true,
      values: {
        f_name: { kind: 'text', text: 'Maria Renter' },
        f_sign: signature('Maria Renter'),
        f_pets: { kind: 'check', checked: true },
        // Not hers: dropped.
        f_ours: signature('Someone Else'),
      },
    });
    expect(signed.statusCode, signed.body).toBe(200);
    expect((signed.json() as { signer: { status: string } }).signer.status).toBe('signed');

    // The team's turn: an email from HandsFreeOS with their own link.
    await drain(w);
    const mail = await waitForMail(w.owner.email, 'Please sign: Lease');
    const ourToken = tokenIn(mail.text);
    const ours = (await get(`/public/sign/${ourToken}`)).json() as {
      signer: { yourTurn: boolean };
      content: { fields: { id: string; mine: boolean }[] };
    };
    expect(ours.signer.yourTurn).toBe(true);
    expect(ours.content.fields.filter((f) => f.mine).map((f) => f.id)).toEqual(['f_ours']);
    const done = await post(`/public/sign/${ourToken}/sign`, {
      agreed: true,
      values: { f_ours: signature('Dale Owner') },
    });
    expect(done.statusCode, done.body).toBe(200);

    // Everyone signed: the signed copy is made, filed on Maria, locked, and sent to everyone.
    await drain(w);
    const d = await docRow(documentId);
    expect(d.status).toBe('completed');
    expect(d.source_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(d.signed_sha256).toMatch(/^[0-9a-f]{64}$/);
    const [file] = await rows<{
      record_type: string;
      record_id: string;
      locked_at: Date | null;
      object_path: string;
      name: string;
    }>(
      admin(),
      sql`select record_type, record_id, locked_at, object_path, name from app.files where id = ${d.signed_file_id}`,
    );
    expect(file).toMatchObject({
      record_type: 'person',
      record_id: maria.id,
      name: 'Lease (signed).pdf',
    });
    expect(file!.locked_at).not.toBeNull();

    const bytes = await w.s.store.download('attachments', file!.object_path);
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(3);
    // The sideways page stays the shape it showed.
    expect(pdf.getPage(1).getSize()).toEqual({ width: 792, height: 612 });
    const { text } = await extractText(await getDocumentProxy(new Uint8Array(bytes)), {
      mergePages: true,
    });
    expect(text).toContain('Monthly rent: $1,450 a month');
    expect(text).toContain('Maria Renter');
    expect(text).toContain('Proof of signing');
    expect(text).toContain(documentId);
    expect(text).toContain(d.source_sha256!);
    expect(text).toContain('Code checked');
    expect(text).toContain('from 198.51.100.');

    // Copies: Maria by email (attached) and text, the team by email.
    expect(await emailsTo(w, maria.email)).toContain('Signed: Lease');
    const [attached] = await rows<{ media: unknown }>(
      admin(),
      sql`select m.media from app.messages m join app.conversations c on c.id = m.conversation_id
          where c.workspace_id = ${w.workspaceId} and c.counterpart = ${maria.email} and m.subject = 'Signed: Lease'`,
    );
    expect(JSON.stringify(attached!.media)).toContain(d.signed_file_id!);
    expect(
      textsTo(w, maria.phone)
        .map((t) => t.body)
        .join('\n'),
    ).toContain('everyone has signed');
    await waitForMail(w.owner.email, 'Signed: Lease');

    // The signing page now downloads it.
    const after = (await get(`/public/sign/${token}`)).json() as {
      document: { status: string; signedCopy: boolean };
    };
    expect(after.document).toMatchObject({ status: 'completed', signedCopy: true });
    const download = await get(`/public/sign/${token}/download`);
    expect(download.statusCode).toBe(302);
    expect(download.headers.location).toMatch(/^http/);
  });

  it('gives the team a signer’s link to copy, the same one that was sent', async () => {
    const pat = await customer('Pat');
    const { documentId } = await send(pat.id);
    await drain(w);
    const s = await signerOf(documentId, 'customer');
    const bearer = await signInTestUser(w.owner);
    const res = await w.app.inject({
      method: 'POST',
      url: '/v1/documents/link',
      headers: { authorization: `Bearer ${bearer}` },
      payload: { workspaceId: w.workspaceId, signerId: s.id },
    });
    expect(res.statusCode, res.body).toBe(200);
    const url = (res.json() as { url: string }).url;
    expect(
      url.endsWith(
        `/d/${signerToken(w.s.moneyLinks, { publicRef: s.public_ref, signerId: s.id, linkVersion: s.link_version })}`,
      ),
    ).toBe(true);
    expect(
      textsTo(w, pat.phone)
        .map((t) => t.body)
        .join('\n'),
    ).toContain(url.slice(url.indexOf('/d/')));
    const anon = await w.app.inject({
      method: 'POST',
      url: '/v1/documents/link',
      payload: { workspaceId: w.workspaceId, signerId: s.id },
    });
    expect(anon.statusCode).toBe(401);
  });

  it('an old link, after a newer one was sent, says so', async () => {
    const lee = await customer('Lee');
    const { documentId } = await send(lee.id);
    const s = await signerOf(documentId, 'customer');
    const old = signerToken(w.s.moneyLinks, {
      publicRef: s.public_ref,
      signerId: s.id,
      linkVersion: s.link_version,
    });
    await backdate(
      sql`update app.document_signers set link_version = link_version + 1 where id = ${s.id}`,
    );
    expect((await resolveSignerToken(testDbs().worker.db, w.s.moneyLinks, old)).status).toBe(
      'stale',
    );
    expect((await get(`/public/sign/${old}`)).statusCode).toBe(410);
  });
});

describe('reminders, running out of time, and taking it back', () => {
  it('reminds after the document’s days, then stops it when its time is up', async () => {
    const sam = await customer('Sam');
    const { documentId } = await send(sam.id, {
      remindAfterDays: 2,
      remindEveryDays: 3,
      expireDays: 30,
    });
    await drain(w);
    await backdate(
      sql`update app.document_signers set sent_at = now() - interval '3 days', last_sent_at = now() - interval '3 days'
          where document_id = ${documentId} and role_key = 'customer'`,
    );
    await documentsSweep(sweepCtx());
    await drain(w);
    expect(
      textsTo(w, sam.phone)
        .map((t) => t.body)
        .join('\n'),
    ).toContain('a reminder that');
    expect((await signerOf(documentId, 'customer')).reminders).toBe(1);
    // Not again until three more days.
    await documentsSweep(sweepCtx());
    await drain(w);
    expect(textsTo(w, sam.phone).filter((t) => t.body.includes('a reminder that'))).toHaveLength(1);

    await backdate(
      sql`update app.documents set sent_at = now() - interval '31 days', expires_at = now() - interval '1 minute'
          where id = ${documentId}`,
    );
    await documentsSweep(sweepCtx());
    await drain(w);
    expect((await docRow(documentId)).status).toBe('expired');
    const s = await signerOf(documentId, 'customer');
    const token = signerToken(w.s.moneyLinks, {
      publicRef: s.public_ref,
      signerId: s.id,
      linkVersion: s.link_version,
    });
    const page = (await get(`/public/sign/${token}`)).json() as {
      document: { status: string };
      content: unknown;
    };
    expect(page.document.status).toBe('expired');
    expect(page.content).toBeNull();
  });

  it('taking it back tells everyone who had a link, and the link stops working for signing', async () => {
    const kim = await customer('Kim');
    const { documentId } = await send(kim.id);
    await drain(w);
    const token = tokenIn(
      textsTo(w, kim.phone)
        .map((t) => t.body)
        .join('\n'),
    );
    await run(w, documentVoid, {
      workspaceId: w.workspaceId,
      documentId,
      reason: 'The rent was wrong.',
    });
    await drain(w);
    expect(await emailsTo(w, kim.email)).toContain('No longer needs signing: Lease');
    const signing = await post(`/public/sign/${token}/sign`, { agreed: true, values: {} });
    expect((signing.json() as { error: { rule: string } }).error.rule).toBe('document_voided');
    const declined = await post(`/public/sign/${token}/decline`, { reason: 'No' });
    expect(declined.statusCode).toBe(409);
  });

  it('a signer can decline, with their reason', async () => {
    const jo = await customer('Jo');
    const { documentId } = await send(jo.id);
    await drain(w);
    const token = tokenIn(
      textsTo(w, jo.phone)
        .map((t) => t.body)
        .join('\n'),
    );
    const res = await post(`/public/sign/${token}/decline`, { reason: 'I found another place.' });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { document: { status: string } }).document.status).toBe('declined');
    expect((await docRow(documentId)).status).toBe('declined');
    await drain(w);
  });
});

/** Lets them in to their portal and signs a device in, as the worker does; the device's bearer. */
async function portalBearer(personId: string): Promise<string> {
  const given = (await run(w, portalAccessGive, { workspaceId: w.workspaceId, personId })) as {
    accessId: string;
  };
  const system = {
    type: 'system' as const,
    workspaceId: w.workspaceId,
    organizationId: w.organizationId,
  };
  const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
  const { output: sent } = await executeCommand(
    testDbs().worker.db,
    portalSendCode,
    { workspaceId: w.workspaceId, accessId: given.accessId },
    system,
    meta(),
  );
  const bearer = randomBytes(32).toString('base64url');
  await executeCommand(
    testDbs().worker.db,
    portalCheckCode,
    {
      workspaceId: w.workspaceId,
      accessId: given.accessId,
      code: sent.code,
      tokenHash: createHash('sha256').update(bearer).digest('hex'),
    },
    system,
    meta(),
  );
  return bearer;
}

describe('in person, and from the portal', () => {
  it('sends no link to someone signing in person, until Remind sends their first', async () => {
    const ned = await customer('Ned');
    const { documentId } = (await run(w, documentSend, {
      workspaceId: w.workspaceId,
      templateId,
      about: { personId: ned.id },
      signers: [
        { roleKey: 'customer', personId: ned.id, inPerson: true },
        { roleKey: 'us', userId: w.owner.id },
      ],
    })) as { documentId: string };
    await drain(w);
    expect(textsTo(w, ned.phone)).toEqual([]);
    expect(await emailsTo(w, ned.email)).toEqual([]);
    expect((await signerOf(documentId, 'customer')).status).toBe('waiting');

    await run(w, documentRemind, { workspaceId: w.workspaceId, documentId });
    await drain(w);
    const texts = textsTo(w, ned.phone).map((t) => t.body);
    expect(texts.join('\n')).toContain('is ready for you to sign');
    expect(texts.join('\n')).not.toContain('a reminder that');
    expect(await signerOf(documentId, 'customer')).toMatchObject({ status: 'sent', reminders: 0 });
  });

  it('opens their own document from their portal, with no code to type', async () => {
    const ola = await customer('Ola');
    const ray = await customer('Ray');
    const { documentId } = await send(ola.id, { askCode: true });
    await drain(w);
    const s = await signerOf(documentId, 'customer');
    const open = (bearer: string | null, signerId = s.id) =>
      w.app.inject({
        method: 'POST',
        url: `/public/portal/documents/${signerId}/open`,
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': ip(),
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        payload: '{}',
      });
    expect((await open(null)).statusCode).toBe(401);
    // Someone else's isn't there for them.
    expect((await open(await portalBearer(ray.id))).statusCode).toBe(404);

    const res = await open(await portalBearer(ola.id));
    expect(res.statusCode, res.body).toBe(200);
    const token = tokenIn((res.json() as { url: string }).url);
    const page = (await get(`/public/sign/${token}`)).json() as {
      signer: { codeChecked: boolean; yourTurn: boolean };
      content: unknown;
    };
    expect(page.signer).toMatchObject({ codeChecked: true, yourTurn: true });
    expect(page.content).not.toBeNull();
    const steps = await rows<{ kind: string; channel: string | null }>(
      admin(),
      sql`select kind, channel from app.document_steps where signer_id = ${s.id} order by at, id`,
    );
    expect(steps).toEqual(
      expect.arrayContaining([
        { kind: 'code_checked', channel: 'portal' },
        { kind: 'opened', channel: 'portal' },
      ]),
    );
  });
});
