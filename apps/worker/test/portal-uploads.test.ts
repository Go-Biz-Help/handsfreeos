/**
 * Files in a customer's portal (Real Estate round two, step 4), end to end against the local Storage: a client adds
 * a pre-approval letter to their deal through a one-time upload link, the business sees it on the deal's timeline,
 * the client sees it and opens it; a file the business shares appears for them and goes again when unshared; and
 * what isn't a PDF or a photo, or is too big, or isn't theirs, or is one too many today, is refused.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  executeCommand,
  fileShareToPortal,
  personCreate,
  portalAccessGive,
  portalCheckCode,
  portalSendCode,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realestateBusiness } from '../../../packages/core/test/addons/realestate-fixture';
import { buildHttpServer } from '../src/http/server';
import { testServices } from './helpers';

let owner: TestUser;
let app: FastifyInstance;
let ws: string;
let org: string;
let linh: string;
let omar: string;
let deal: string;
let omarsDeal: string;
let linhBearer: string;
let omarBearer: string;
let letter: string;

const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const system = () => ({ type: 'system' as const, workspaceId: ws, organizationId: org });
const errorOf = (res: LightMyRequestResponse) =>
  (res.json() as { error: { code: string; rule?: string; message: string } }).error;

function call(method: 'GET' | 'POST', url: string, bearer: string | null, body?: unknown) {
  return app.inject({
    method,
    url,
    headers: {
      'x-forwarded-for': '203.0.113.60',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    },
    ...(method === 'POST' ? { payload: JSON.stringify(body ?? {}) } : {}),
  });
}

async function person(first: string): Promise<string> {
  const { output } = await executeCommand(
    testDbs().api.db,
    personCreate,
    {
      workspaceId: ws,
      firstName: first,
      lastName: 'Client',
      email: `${first.toLowerCase()}-${randomUUID().slice(0, 6)}@example.com`,
    },
    human(owner),
    meta(),
  );
  return output.personId;
}

async function dealFor(personId: string, name: string): Promise<string> {
  const [r] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.custom_records (workspace_id, type_id, name, created_by, owner_user_id)
        select ${ws}, t.id, ${name}, ${owner.id}, ${owner.id} from app.custom_record_types t
        where t.workspace_id = ${ws} and t.key = 'realestate_deal' returning id`,
  );
  await rows(
    admin(),
    sql`insert into app.relationships (workspace_id, type_id, a_person_id, b_custom_record_id)
        select ${ws}, t.id, ${personId}, ${r!.id} from app.relationship_types t
        where t.workspace_id = ${ws} and t.addon_key = 'realestate_client'`,
  );
  return r!.id;
}

/** Lets them in and signs a device in, as the worker does; the device's bearer. */
async function signIn(personId: string): Promise<string> {
  const { output: given } = await executeCommand(
    testDbs().api.db,
    portalAccessGive,
    { workspaceId: ws, personId },
    human(owner),
    meta(),
  );
  const worker = testDbs().worker.db;
  const { output: sent } = await executeCommand(
    worker,
    portalSendCode,
    { workspaceId: ws, accessId: given.accessId },
    system(),
    meta(),
  );
  const bearer = randomBytes(32).toString('base64url');
  await executeCommand(
    worker,
    portalCheckCode,
    {
      workspaceId: ws,
      accessId: given.accessId,
      code: sent.code,
      tokenHash: createHash('sha256').update(bearer).digest('hex'),
    },
    system(),
    meta(),
  );
  return bearer;
}

/** Starts an upload and puts these bytes there, saying they're `contentType`. */
async function upload(
  bearer: string,
  file: {
    recordId?: string | null;
    name: string;
    mimeType: string;
    bytes: Buffer;
    sendAs?: string;
  },
): Promise<string> {
  const res = await call('POST', '/public/portal/uploads', bearer, {
    recordId: file.recordId ?? null,
    name: file.name,
    mimeType: file.mimeType,
    sizeBytes: file.bytes.length,
  });
  expect(res.statusCode, res.body).toBe(200);
  const { fileId, uploadUrl } = res.json() as { fileId: string; uploadUrl: string };
  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': file.sendAs ?? file.mimeType },
    body: new Uint8Array(file.bytes),
  });
  expect(put.ok, await put.clone().text()).toBe(true);
  return fileId;
}

const confirm = (bearer: string, fileId: string) =>
  call('POST', '/public/portal/op/portal.upload_confirm', bearer, { fileId });
const listed = async (bearer: string) =>
  (
    (await call('POST', '/public/portal/op/portal.files', bearer, {})).json() as {
      files: { id: string; name: string; fromYou: boolean; recordId: string | null }[];
    }
  ).files;

beforeAll(async () => {
  owner = await createTestUser('portal-uploads-owner', { fullName: 'Dana Reyes' });
  ws = await realestateBusiness(owner, 'Portal Uploads Realty');
  const [w] = await rows<{ organization_id: string }>(
    admin(),
    sql`select organization_id from app.workspaces where id = ${ws}`,
  );
  org = w!.organization_id;
  app = await buildHttpServer({
    ...testServices(),
    httpDb: testDbs().worker.db,
    verifyToken: null,
    webOrigins: ['http://localhost:3000'],
  });
  [linh, omar] = [await person('Linh'), await person('Omar')];
  deal = await dealFor(linh, 'Nguyen purchase');
  omarsDeal = await dealFor(omar, 'Haddad purchase');
  linhBearer = await signIn(linh);
  omarBearer = await signIn(omar);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('a client adding a file', () => {
  it('puts it on their deal through a one-time link, and the business sees it on the deal', async () => {
    const bytes = Buffer.from('%PDF-1.4\n% pre-approval\n');
    letter = await upload(linhBearer, {
      recordId: deal,
      name: 'Pre-approval.pdf',
      mimeType: 'application/pdf',
      bytes,
    });
    const res = await confirm(linhBearer, letter);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      fileId: letter,
      accepted: true,
      refusal: null,
      sizeBytes: bytes.length,
    });
    const [line] = await rows<{ actor_type: string; body: string }>(
      admin(),
      sql`select actor_type::text, body from app.activities
          where custom_record_id = ${deal} and subtype = 'file_added'`,
    );
    expect(line).toEqual({ actor_type: 'customer', body: 'Pre-approval.pdf' });
    const [f] = await rows<{
      status: string;
      uploaded_by_person_id: string;
      created_by: string | null;
    }>(
      admin(),
      sql`select status::text, uploaded_by_person_id, created_by from app.files where id = ${letter}`,
    );
    expect(f).toEqual({ status: 'ready', uploaded_by_person_id: linh, created_by: null });
  });

  it('shows it to them, and opens it with a short-lived link', async () => {
    expect(await listed(linhBearer)).toEqual([
      expect.objectContaining({
        id: letter,
        name: 'Pre-approval.pdf',
        fromYou: true,
        recordId: deal,
      }),
    ]);
    const res = await call('GET', `/public/portal/files/${letter}`, linhBearer);
    expect(res.statusCode, res.body).toBe(200);
    const { url } = res.json() as { url: string };
    const got = await fetch(url);
    expect(Buffer.from(await got.arrayBuffer()).toString()).toContain('pre-approval');
  });

  it('keeps it from anyone else', async () => {
    expect(await listed(omarBearer)).toEqual([]);
    expect((await call('GET', `/public/portal/files/${letter}`, omarBearer)).statusCode).toBe(404);
    expect((await call('GET', `/public/portal/files/${letter}`, null)).statusCode).toBe(401);
  });

  it('refuses what isn’t a PDF or a photo, what’s too big, and a deal that isn’t theirs', async () => {
    const start = (body: Record<string, unknown>) =>
      call('POST', '/public/portal/uploads', linhBearer, {
        name: 'x',
        mimeType: 'application/pdf',
        sizeBytes: 10,
        ...body,
      });
    const html = await start({ name: 'page.html', mimeType: 'text/html' });
    expect(html.statusCode).toBe(422);
    expect(errorOf(html).rule).toBe('portal_file_type');
    const big = await start({ name: 'Scan.pdf', sizeBytes: 25 * 1024 * 1024 });
    expect(big.statusCode).toBe(422);
    expect(errorOf(big)).toMatchObject({ rule: 'portal_file_too_big' });
    expect(errorOf(big).message).toContain('Scan.pdf is 25 MB');
    const notHers = await start({ recordId: omarsDeal });
    expect(notHers.statusCode).toBe(404);
  });

  it('removes what arrives as something else than it said', async () => {
    const id = await upload(linhBearer, {
      name: 'Statement.pdf',
      mimeType: 'application/pdf',
      // Storage itself refuses a web page outright; a GIF it takes, and the portal doesn't.
      bytes: Buffer.from('GIF89a'),
      sendAs: 'image/gif',
    });
    const res = await confirm(linhBearer, id);
    expect(res.json()).toMatchObject({ accepted: false, refusal: { rule: 'portal_file_type' } });
    const [f] = await rows<{ deleted: boolean }>(
      admin(),
      sql`select deleted_at is not null as deleted from app.files where id = ${id}`,
    );
    expect(f!.deleted).toBe(true);
    const [e] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.events where event_type = 'file.deleted' and payload ->> 'fileId' = ${id}`,
    );
    expect(e!.n).toBe(1);
  });

  it('says so when nothing arrived', async () => {
    const res = await call('POST', '/public/portal/uploads', linhBearer, {
      name: 'Never sent.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 100,
    });
    const { fileId } = res.json() as { fileId: string };
    const confirmed = await confirm(linhBearer, fileId);
    expect(confirmed.statusCode).toBe(409);
    expect(errorOf(confirmed).rule).toBe('file_not_uploaded');
  });
});

describe('files the business shares', () => {
  it('appear in the client’s portal once shared, and go when unshared', async () => {
    const [f] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.files (workspace_id, record_type, record_id, object_path, name, mime_type, size_bytes,
            status, created_by)
          values (${ws}, 'custom_record', ${deal}, ${`${ws}/custom_record/${deal}/${randomUUID()}/Inspection.pdf`},
            'Inspection.pdf', 'application/pdf', 2048, 'ready', ${owner.id})
          returning id`,
    );
    const share = (shared: boolean) =>
      executeCommand(
        testDbs().api.db,
        fileShareToPortal,
        { workspaceId: ws, fileId: f!.id, shared },
        human(owner),
        meta(),
      );
    expect((await listed(linhBearer)).map((x) => x.name)).not.toContain('Inspection.pdf');
    expect((await share(true)).output).toEqual({ fileId: f!.id, shared: true, changed: true });
    expect(await listed(linhBearer)).toContainEqual(
      expect.objectContaining({ name: 'Inspection.pdf', fromYou: false }),
    );
    await share(false);
    expect((await listed(linhBearer)).map((x) => x.name)).not.toContain('Inspection.pdf');
    // The client's own stay in their portal.
    await expect(
      executeCommand(
        testDbs().api.db,
        fileShareToPortal,
        { workspaceId: ws, fileId: letter, shared: false },
        human(owner),
        meta(),
      ),
    ).rejects.toMatchObject({ rule: 'portal_file_theirs' });
  });
});

describe('how many', () => {
  it('stops at 30 a day', async () => {
    await rows(
      admin(),
      sql`insert into app.files (workspace_id, record_type, record_id, object_path, name, status, uploaded_by_person_id,
            portal_visible)
          select ${ws}, 'person', ${linh}, ${`${ws}/person/${linh}/`} || gen_random_uuid() || '/x.pdf', 'x.pdf', 'ready',
            ${linh}, true
          from generate_series(1, 30)`,
    );
    const res = await call('POST', '/public/portal/uploads', linhBearer, {
      name: 'One more.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 100,
    });
    expect(res.statusCode).toBe(429);
    expect(errorOf(res).rule).toBe('too_many_uploads');
  });
});
