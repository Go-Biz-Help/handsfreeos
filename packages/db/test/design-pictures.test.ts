import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import { workspaceMemberships } from '../src/schema/index';
import {
  as,
  asService,
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
 * Your pictures (20261027037100): anyone in the business sees its library; a person uploads only to the place
 * picture.begin_upload reserved for them, in the business's own folder, while they may add pictures (they may change
 * the business, its forms, calendars or channels) and only until it's handed over. Nobody but the worker writes the
 * public `pictures` bucket, and the worker sees only the pictures of the business it works for.
 */

// A 1×1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let owner: TestUser;
let member: TestUser;
let outsider: TestUser;
let ws: string;
let org: string;
let otherWs: string;

const clientFor = async (user: TestUser): Promise<SupabaseClient> => {
  const token = await signInTestUser(user);
  return createClient(testEnv.supabaseUrl, testEnv.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
};
const upload = async (user: TestUser, bucket: string, path: string) =>
  (await clientFor(user)).storage.from(bucket).upload(path, PNG, { contentType: 'image/png' });

/** A picture reserved for `user`'s upload, as picture.begin_upload keeps it. */
const reserve = async (user: TestUser, status = 'uploading', workspaceId = ws) => {
  const id = randomUUID();
  const path = `${workspaceId}/${id}.png`;
  await rows(
    dbs.admin.db,
    sql`insert into app.design_pictures (id, workspace_id, name, status, upload_path, created_by)
        values (${id}, ${workspaceId}, 'crew.png', ${status}, ${path}, ${user.id})`,
  );
  return { id, path };
};

beforeAll(async () => {
  [owner, member, outsider] = await Promise.all([
    createTestUser('pictures-owner'),
    createTestUser('pictures-member'),
    createTestUser('pictures-outsider'),
  ]);
  ({ wsId: ws, orgId: org } = await bootstrapOrganization(owner, 'Pictures Org', 'Pictures'));
  ({ wsId: otherWs } = await bootstrapOrganization(outsider, 'Pictures Org B', 'Pictures B'));
  await dbs.admin.db
    .insert(workspaceMemberships)
    .values([{ workspaceId: ws, userId: member.id, role: 'member' }]);
});
afterAll(closeAll);

describe('picture uploads', () => {
  it('admit the person the place was reserved for, there only, until it’s handed over', async () => {
    const { path } = await reserve(owner);
    expect(
      (await upload(owner, 'picture-uploads', `${ws}/${randomUUID()}.png`)).error,
    ).not.toBeNull();
    expect((await upload(owner, 'picture-uploads', path)).error).toBeNull();

    const handed = await reserve(owner, 'making');
    expect((await upload(owner, 'picture-uploads', handed.path)).error).not.toBeNull();
  });

  it('refuse someone else, and someone who may not add pictures', async () => {
    const { path } = await reserve(owner);
    expect((await upload(outsider, 'picture-uploads', path)).error).not.toBeNull();
    const theirs = await reserve(member);
    expect((await upload(member, 'picture-uploads', theirs.path)).error).not.toBeNull();
  });

  it('stay in the business’s own folder', async () => {
    // A row of this business naming another business's folder is refused, and couldn't be uploaded to anyway.
    const id = randomUUID();
    expect(
      (
        await expectPgError(() =>
          as(owner)((tx) =>
            tx.execute(
              sql`insert into app.design_pictures (id, workspace_id, name, upload_path, created_by)
                  values (${id}, ${ws}, 'sneaky.png', ${`${otherWs}/${id}.png`}, ${owner.id})`,
            ),
          ),
        )
      ).code,
    ).toBe('42501');
    await rows(
      dbs.admin.db,
      sql`insert into app.design_pictures (id, workspace_id, name, upload_path, created_by)
          values (${id}, ${ws}, 'sneaky.png', ${`${otherWs}/${id}.png`}, ${owner.id})`,
    );
    expect((await upload(owner, 'picture-uploads', `${otherWs}/${id}.png`)).error).not.toBeNull();
  });

  it('keep the public bucket the worker’s alone', async () => {
    expect((await upload(owner, 'pictures', `${ws}/${randomUUID()}.webp`)).error).not.toBeNull();
  });
});

describe('the library', () => {
  it('is seen by anyone in the business, and nobody outside it', async () => {
    const { id } = await reserve(owner);
    const seen = (user: TestUser) =>
      as(user)((tx) =>
        rows<{ id: string }>(tx, sql`select id from app.design_pictures where id = ${id}`),
      );
    expect(await seen(member)).toHaveLength(1);
    expect(await seen(outsider)).toHaveLength(0);
  });

  it('is changed only by those who may add pictures, and never its business or who added it', async () => {
    const { id } = await reserve(owner);
    const rename = (user: TestUser) =>
      as(user)((tx) =>
        rows<{ id: string }>(
          tx,
          sql`update app.design_pictures set name = 'renamed.png' where id = ${id} returning id`,
        ),
      );
    expect(await rename(member)).toHaveLength(0);
    expect(await rename(owner)).toHaveLength(1);
    // The path everyone sees is the worker's to set.
    expect(
      (
        await expectPgError(() =>
          as(owner)((tx) =>
            tx.execute(
              sql`update app.design_pictures set path = ${`${ws}/${id}.webp`} where id = ${id}`,
            ),
          ),
        )
      ).code,
    ).toBe('42501');
  });

  it('is the worker’s to make ready, for the business it works for only', async () => {
    const { id } = await reserve(owner, 'making');
    const ready = (workspaceId: string) =>
      asService({ workspaceId, organizationId: org })((tx) =>
        rows<{ id: string }>(
          tx,
          sql`update app.design_pictures
              set status = 'ready', path = ${`${ws}/${id}.webp`}, width = 10, height = 10, upload_path = null
              where id = ${id} returning id`,
        ),
      );
    expect(await ready(otherWs)).toHaveLength(0);
    expect(await ready(ws)).toHaveLength(1);
  });
});
