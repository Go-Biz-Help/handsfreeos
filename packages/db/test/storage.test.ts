import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import {
  as,
  bootstrapOrganization,
  closeAll,
  createTestUser,
  dbs,
  signInTestUser,
  testEnv,
  type TestUser,
} from './harness';

// A 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let member: TestUser;
let outsider: TestUser;
let ws: string;
let wsB: string;
let personId: string;

const clientFor = async (user: TestUser): Promise<SupabaseClient> => {
  const token = await signInTestUser(user);
  return createClient(testEnv.supabaseUrl, testEnv.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
};

const reserve = (user: TestUser, workspaceId: string, path: string) =>
  as(user)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.files (workspace_id, record_type, record_id, object_path, name, mime_type, created_by)
          values (${workspaceId}, 'person', ${personId}, ${path}, 'photo.png', 'image/png', ${user.id}) returning id`,
    ).then((r) => r[0]!.id),
  );

beforeAll(async () => {
  [member, outsider] = await Promise.all([
    createTestUser('st-member'),
    createTestUser('st-outsider'),
  ]);
  ws = (await bootstrapOrganization(member, 'Storage Org', 'Storage Workspace')).wsId;
  wsB = (await bootstrapOrganization(outsider, 'Storage Org B', 'Storage Workspace B')).wsId;
  const [p] = await as(member)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.people (workspace_id, first_name, last_name, created_by) values (${ws}, 'Photo', 'Person', ${member.id}) returning id`,
    ),
  );
  personId = p!.id;
});
afterAll(closeAll);

describe('files live behind reserved paths', () => {
  it('uploads only to a path the server reserved for this user; unreserved and foreign paths are refused', async () => {
    const client = await clientFor(member);
    const good = `${ws}/person/${personId}/${randomUUID()}/photo.png`;
    await reserve(member, ws, good);
    const ok = await client.storage
      .from('attachments')
      .upload(good, PNG, { contentType: 'image/png', upsert: false });
    expect(ok.error).toBeNull();

    const unreserved = `${ws}/person/${personId}/${randomUUID()}/photo.png`;
    const denied = await client.storage
      .from('attachments')
      .upload(unreserved, PNG, { contentType: 'image/png' });
    expect(denied.error).not.toBeNull();

    const foreign = `${wsB}/person/${randomUUID()}/${randomUUID()}/photo.png`;
    await as(outsider)((tx) =>
      rows(
        tx,
        sql`insert into app.files (workspace_id, record_type, record_id, object_path, name, mime_type, created_by)
            values (${wsB}, 'person', ${randomUUID()}, ${foreign}, 'photo.png', 'image/png', ${outsider.id})`,
      ),
    );
    const crossTenant = await client.storage
      .from('attachments')
      .upload(foreign, PNG, { contentType: 'image/png' });
    expect(crossTenant.error).not.toBeNull();
  });

  it('reads need a ready row in an accessible workspace; nobody deletes from the browser', async () => {
    const client = await clientFor(member);
    const path = `${ws}/person/${personId}/${randomUUID()}/photo.png`;
    const fileId = await reserve(member, ws, path);
    await client.storage.from('attachments').upload(path, PNG, { contentType: 'image/png' });

    const beforeReady = await client.storage.from('attachments').createSignedUrl(path, 60);
    expect(beforeReady.error).not.toBeNull();

    const [info] = await as(member)((tx) =>
      rows<{ size_bytes: number; mime_type: string }>(
        tx,
        sql`select size_bytes::int as size_bytes, mime_type from private.storage_object_info('attachments', ${path})`,
      ),
    );
    expect(info).toEqual({ size_bytes: PNG.length, mime_type: 'image/png' });

    await as(member)((tx) =>
      rows(
        tx,
        sql`update app.files set status = 'ready', size_bytes = ${PNG.length} where id = ${fileId}`,
      ),
    );
    const signed = await client.storage.from('attachments').createSignedUrl(path, 60);
    expect(signed.error).toBeNull();
    expect(signed.data?.signedUrl).toContain('/object/sign/attachments/');

    const outsiderClient = await clientFor(outsider);
    const foreignRead = await outsiderClient.storage.from('attachments').createSignedUrl(path, 60);
    expect(foreignRead.error).not.toBeNull();

    await client.storage.from('attachments').remove([path]);
    const still = await rows(
      dbs.admin.db,
      sql`select 1 from storage.objects where bucket_id = 'attachments' and name = ${path}`,
    );
    expect(still).toHaveLength(1);
  });

  it('the imports bucket accepts only the importer’s own reserved CSV', async () => {
    const importId = randomUUID();
    const path = `${ws}/${importId}.csv`;
    await as(member)((tx) =>
      rows(
        tx,
        sql`insert into app.imports (id, workspace_id, kind, file_name, object_path, created_by) values (${importId}, ${ws}, 'people', 'customers.csv', ${path}, ${member.id})`,
      ),
    );
    const client = await clientFor(member);
    const ok = await client.storage
      .from('imports')
      .upload(path, Buffer.from('first,last\nMike,Johnson\n'), { contentType: 'text/csv' });
    expect(ok.error).toBeNull();
    const read = await client.storage.from('imports').download(path);
    expect(read.error).not.toBeNull();
    const outsiderClient = await clientFor(outsider);
    const stranger = await outsiderClient.storage
      .from('imports')
      .upload(`${ws}/${randomUUID()}.csv`, Buffer.from('x'), { contentType: 'text/csv' });
    expect(stranger.error).not.toBeNull();
  });
});
