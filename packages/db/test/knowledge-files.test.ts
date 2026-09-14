import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import { workspaceMemberships } from '../src/schema/index';
import {
  as,
  bootstrapOrganization,
  closeAll,
  createTestUser,
  dbs,
  expectPgError,
  signInTestUser,
  testEnv,
  type TestUser,
} from './harness';

/**
 * Knowledge files (record type 'knowledge'): owners and admins reserve, upload and confirm them; everyone
 * in the workspace reads them; they belong to the workspace itself and never carry tags.
 */

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

let owner: TestUser;
let admin: TestUser;
let member: TestUser;
let outsider: TestUser;
let ws: string;

const clientFor = async (user: TestUser): Promise<SupabaseClient> => {
  const token = await signInTestUser(user);
  return createClient(testEnv.supabaseUrl, testEnv.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
};
const code = async (fn: () => Promise<unknown>) => (await expectPgError(fn)).code;
const knowledgePath = () => `${ws}/knowledge/${randomUUID()}/price-list.pdf`;

/** A knowledge upload reserved by `user`, as knowledge_document.begin_upload does. */
const reserve = (user: TestUser, path: string, recordId = ws) =>
  as(user)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.files (workspace_id, record_type, record_id, object_path, name, mime_type, size_bytes, created_by)
          values (${ws}, 'knowledge', ${recordId}, ${path}, 'Price list.pdf', 'application/pdf', ${PDF.length}, ${user.id})
          returning id`,
    ),
  ).then((r) => r[0]!.id);

beforeAll(async () => {
  [owner, admin, member, outsider] = await Promise.all([
    createTestUser('kf-owner'),
    createTestUser('kf-admin'),
    createTestUser('kf-member'),
    createTestUser('kf-outsider'),
  ]);
  ws = (await bootstrapOrganization(owner, 'Knowledge Files Org', 'Knowledge Files')).wsId;
  await bootstrapOrganization(outsider, 'Knowledge Files Org B', 'Knowledge Files B');
  await dbs.admin.db.insert(workspaceMemberships).values([
    { workspaceId: ws, userId: admin.id, role: 'admin' },
    { workspaceId: ws, userId: member.id, role: 'member' },
  ]);
});
afterAll(closeAll);

describe('knowledge files', () => {
  it('owners and admins reserve a knowledge upload; members can’t', async () => {
    expect(await reserve(owner, knowledgePath())).toMatch(/^[0-9a-f-]{36}$/);
    expect(await reserve(admin, knowledgePath())).toMatch(/^[0-9a-f-]{36}$/);
    expect(await code(() => reserve(member, knowledgePath()))).toBe('42501');
  });

  it('a knowledge file belongs to the workspace itself, and tags stay off it', async () => {
    expect(await code(() => reserve(owner, knowledgePath(), randomUUID()))).toBe('23514');
    const [tag] = await as(owner)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.tags (workspace_id, name, created_by) values (${ws}, 'Docs', ${owner.id}) returning id`,
      ),
    );
    expect(
      await code(() =>
        as(owner)((tx) =>
          tx.execute(
            sql`insert into app.record_tags (workspace_id, tag_id, record_type, record_id, created_by)
                values (${ws}, ${tag!.id}, 'knowledge', ${ws}, ${owner.id})`,
          ),
        ),
      ),
    ).toBe('23514');
  });

  it('only a knowledge manager confirms it; everyone in the workspace reads it once ready', async () => {
    const path = knowledgePath();
    const fileId = await reserve(owner, path);
    const up = await (
      await clientFor(owner)
    ).storage
      .from('attachments')
      .upload(path, PDF, { contentType: 'application/pdf', upsert: false });
    expect(up.error).toBeNull();

    // A member (who has records.write) can't mark a knowledge file ready: its row is out of their reach.
    const touched = await as(member)((tx) =>
      rows(tx, sql`update app.files set status = 'ready' where id = ${fileId} returning id`),
    );
    expect(touched).toHaveLength(0);
    await as(owner)((tx) =>
      tx.execute(sql`update app.files set status = 'ready' where id = ${fileId}`),
    );

    const seen = await as(member)((tx) =>
      rows<{ id: string }>(tx, sql`select id from app.files where id = ${fileId}`),
    );
    expect(seen).toHaveLength(1);
    const read = await (
      await clientFor(member)
    ).storage
      .from('attachments')
      .createSignedUrl(path, 60);
    expect(read.error).toBeNull();
    const foreign = await (
      await clientFor(outsider)
    ).storage
      .from('attachments')
      .createSignedUrl(path, 60);
    expect(foreign.error).not.toBeNull();
  });

  it('an upload needs knowledge.manage when it happens, not only when it was reserved', async () => {
    const demoted = await createTestUser('kf-demoted');
    await dbs.admin.db
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: demoted.id, role: 'admin' });
    const path = knowledgePath();
    await reserve(demoted, path);
    await rows(
      dbs.admin.db,
      sql`update app.workspace_memberships set role = 'member'
          where workspace_id = ${ws} and user_id = ${demoted.id}`,
    );
    const up = await (
      await clientFor(demoted)
    ).storage
      .from('attachments')
      .upload(path, PDF, { contentType: 'application/pdf' });
    expect(up.error).not.toBeNull();
  });
});
