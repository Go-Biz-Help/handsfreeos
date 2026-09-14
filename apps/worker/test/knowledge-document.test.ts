import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  executeCommand,
  knowledgeDocumentAdd,
  knowledgeDocumentSaveText,
  organizationCreate,
  personCreate,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, testEnv, type TestUser } from '@hfos/db/testing';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handlers } from '../src/handlers/index';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { jobs } from '../src/scheduled';
import { systemActor, workerMeta } from '../src/services';
import { testServices } from './helpers';

/** Documents: an uploaded PDF or text file becomes a draft document item with its text. */

const env = testEnv();
const WORKER_ID = `vitest-knowledge-document-${process.pid}`;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const bucket = () =>
  createClient(env.supabaseUrl, env.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).storage.from('attachments');
const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../fixtures/knowledge-docs/${name}`, import.meta.url)));

let owner: TestUser;
let ws: string;
let org: string;
let personId: string;
const s = testServices();

beforeAll(async () => {
  owner = await createTestUser('kb-doc-owner');
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Document Test HVAC' },
    actor(owner),
    meta(),
  );
  ws = output.workspaceId;
  org = output.organizationId;
  personId = (
    await executeCommand(
      api(),
      personCreate,
      { workspaceId: ws, firstName: 'Paula', lastName: 'Customer', ignoreDuplicates: true },
      actor(owner),
      meta(),
    )
  ).output.personId;
});
afterAll(closeTestDbs);

/** Uploads a file (with the worker's key), records it, and adds it to the knowledge base as its owner would. */
async function addDocument(
  name: string,
  mime: string,
  data: Buffer,
  sizeBytes = data.length,
): Promise<string> {
  const objectPath = `${ws}/person/${personId}/${randomUUID()}/${name.replace(/\s+/g, '-')}`;
  const { error } = await bucket().upload(objectPath, data, { contentType: mime });
  if (error) throw error;
  const [file] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.files (workspace_id, record_type, record_id, bucket, object_path, name, mime_type,
          size_bytes, status, created_by)
        values (${ws}, 'person', ${personId}, 'attachments', ${objectPath}, ${name}, ${mime}, ${sizeBytes},
          'ready', ${owner.id})
        returning id`,
  );
  await executeCommand(
    api(),
    knowledgeDocumentAdd,
    { workspaceId: ws, fileId: file!.id },
    actor(owner),
    meta(),
  );
  return file!.id;
}

interface ItemRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  status: string;
  source: string;
  created_by: string | null;
}

const itemOf = async (fileId: string) =>
  (
    await rows<ItemRow & Record<string, unknown>>(
      admin(),
      sql`select id, kind::text as kind, title, body, status::text as status, source::text as source, created_by
          from app.knowledge_items where file_id = ${fileId}`,
    )
  )[0];

/** Runs this business's outbox and jobs until the file's draft exists. */
async function readDocument(fileId: string): Promise<ItemRow> {
  const deps = { ...s, workerId: WORKER_ID, batchSize: 50, reservedOnly: true };
  const deadline = Date.now() + 30_000;
  for (;;) {
    for (const table of ['outbox', 'scheduled_jobs'])
      await rows(
        admin(),
        sql`update ${sql.raw(`app.${table}`)} set locked_at = now(), locked_by = ${WORKER_ID}
            where status = 'pending' and workspace_id = ${ws}`,
      );
    const passes = [await processOnce({ ...deps, handlers }), await processJobs({ ...deps, jobs })];
    if (passes.some((p) => p.retried + p.failed > 0))
      throw new Error(
        `worker work failed: ${JSON.stringify(
          await rows(
            admin(),
            sql`select kind, last_error from app.scheduled_jobs where workspace_id = ${ws} and last_error is not null`,
          ),
        )}`,
      );
    const item = await itemOf(fileId);
    if (item) return item;
    if (Date.now() > deadline) throw new Error('the document was not read in time');
  }
}

/** The event that announced the draft, and what the audit log says about it. */
async function createdEvent(itemId: string) {
  const [event] = await rows<{
    id: string;
    actor_type: string;
    payload: Record<string, unknown>;
  }>(
    admin(),
    sql`select id, actor_type::text as actor_type, payload from app.events
        where event_type = 'knowledge_item.created' and entity_id = ${itemId}`,
  );
  const [audit] = await rows<{ after: Record<string, unknown> }>(
    admin(),
    sql`select after from app.audit_logs where event_id = ${event!.id}`,
  );
  return { ...event!, after: audit!.after };
}

describe('documents in the knowledge base', () => {
  it('reads a PDF’s text into a draft document item for a person to review', async () => {
    const fileId = await addDocument(
      'Price list.pdf',
      'application/pdf',
      fixture('price-list.pdf'),
    );
    const item = await readDocument(fileId);
    expect(item).toMatchObject({
      kind: 'document',
      title: 'Price list',
      status: 'draft',
      source: 'manual',
      created_by: owner.id,
    });
    expect(item.body).toContain('AC tune-up: $89 per system.');
    expect(item.body).toContain('Prices valid through December 2026.');
    expect(await createdEvent(item.id)).toMatchObject({
      actor_type: 'system',
      payload: { kind: 'document', status: 'draft', fileId, note: null },
      after: { title: 'Price list', kind: 'document', status: 'draft' },
    });
  });

  it('reads text and markdown files as written', async () => {
    // The attachments bucket takes text/plain (not text/markdown); a .md name is still read as text.
    const fileId = await addDocument(
      'Warranty.md',
      'text/plain',
      Buffer.from('# Warranty\r\n\r\nTen years on parts, one year on labor.\r\n'),
    );
    expect((await readDocument(fileId)).body).toBe(
      '# Warranty\n\nTen years on parts, one year on labor.',
    );
  });

  it('gives a scanned PDF an empty draft and a clear note', async () => {
    const fileId = await addDocument('Old flyer.pdf', 'application/pdf', fixture('scanned.pdf'));
    const item = await readDocument(fileId);
    expect(item).toMatchObject({ kind: 'document', title: 'Old flyer', body: '', status: 'draft' });
    expect(await createdEvent(item.id)).toMatchObject({
      payload: { note: 'no_text', chars: 0 },
      after: { note: 'No text found: it may be a scanned image' },
    });
  });

  it('doesn’t read a file over 5 MB', async () => {
    const fileId = await addDocument(
      'Catalog.pdf',
      'application/pdf',
      fixture('price-list.pdf'),
      6 * 1024 * 1024,
    );
    const item = await readDocument(fileId);
    expect(item.body).toBe('');
    expect((await createdEvent(item.id)).payload).toMatchObject({ note: 'too_large' });
  });

  it('makes one item per file, however often its text is saved', async () => {
    const fileId = await addDocument('Hours.txt', 'text/plain', Buffer.from('Open 7 to 6.'));
    const item = await readDocument(fileId);
    const again = await executeCommand(
      s.db,
      knowledgeDocumentSaveText,
      { workspaceId: ws, fileId, title: 'Hours', text: 'Open 7 to 6.' },
      systemActor({ workspaceId: ws, organizationId: org }, owner.id),
      workerMeta(),
    );
    expect(again.output).toEqual({ itemId: item.id, created: false });
    expect(
      await rows(admin(), sql`select 1 from app.knowledge_items where file_id = ${fileId}`),
    ).toHaveLength(1);
  });
});
