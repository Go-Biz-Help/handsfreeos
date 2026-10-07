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
 * A business's logo (20261027000100): a person uploads only to the place look.begin_upload reserved for them in
 * the business's look, while they may change the business, and only until it's handed over. Nobody but the worker
 * writes the public `brand` bucket, and the worker reads and writes only the look of the business it works for.
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

const clientFor = async (user: TestUser): Promise<SupabaseClient> => {
  const token = await signInTestUser(user);
  return createClient(testEnv.supabaseUrl, testEnv.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
};
const upload = async (user: TestUser, bucket: string, path: string) =>
  (await clientFor(user)).storage.from(bucket).upload(path, PNG, { contentType: 'image/png' });

/** A place reserved for `user`'s upload, as look.begin_upload keeps it. */
const reserve = async (user: TestUser, sent = false) => {
  const path = `${ws}/${randomUUID()}.png`;
  const upload = { path, name: 'logo.png', by: user.id, at: new Date().toISOString(), sent };
  await rows(
    dbs.admin.db,
    sql`update app.workspaces
        set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{look}', ${JSON.stringify({ upload })}::jsonb, true)
        where id = ${ws}`,
  );
  return path;
};

beforeAll(async () => {
  [owner, member, outsider] = await Promise.all([
    createTestUser('brand-owner'),
    createTestUser('brand-member'),
    createTestUser('brand-outsider'),
  ]);
  ({ wsId: ws, orgId: org } = await bootstrapOrganization(owner, 'Brand Org', 'Brand'));
  await bootstrapOrganization(outsider, 'Brand Org B', 'Brand B');
  await dbs.admin.db
    .insert(workspaceMemberships)
    .values([{ workspaceId: ws, userId: member.id, role: 'member' }]);
});
afterAll(closeAll);

describe('brand uploads', () => {
  it('admits the person the place was reserved for, there only, until it’s handed over', async () => {
    const path = await reserve(owner);
    expect(
      (await upload(owner, 'brand-uploads', `${ws}/${randomUUID()}.png`)).error,
    ).not.toBeNull();
    expect((await upload(owner, 'brand-uploads', path)).error).toBeNull();

    const sent = await reserve(owner, true);
    expect((await upload(owner, 'brand-uploads', sent)).error).not.toBeNull();
  });

  it('refuses someone else, and someone who may not change the business', async () => {
    const path = await reserve(owner);
    expect((await upload(outsider, 'brand-uploads', path)).error).not.toBeNull();
    const theirs = await reserve(member);
    expect((await upload(member, 'brand-uploads', theirs)).error).not.toBeNull();
  });

  it('keeps the public bucket the worker’s alone', async () => {
    expect((await upload(owner, 'brand', `${ws}/logo/${randomUUID()}.png`)).error).not.toBeNull();
  });
});

describe('the worker and a business’s look', () => {
  it('reads and keeps the look of the business it works for, and nothing else in its settings', async () => {
    const scope = { workspaceId: ws, organizationId: org };
    await rows(
      dbs.admin.db,
      sql`update app.workspaces set settings = settings || '{"website": "https://brand.example/"}'::jsonb where id = ${ws}`,
    );
    const [held] = await asService(scope)((tx) =>
      rows<{ settings: { website: string } }>(tx, sql`select private.lock_look() as settings`),
    );
    expect(held!.settings.website).toBe('https://brand.example/');

    const look = { color: { hex: '#b42318', from: 'logo', at: new Date().toISOString() } };
    await asService(scope)((tx) =>
      tx.execute(sql`select private.keep_look(${JSON.stringify(look)}::jsonb)`),
    );
    const [w] = await rows<{ settings: Record<string, unknown> }>(
      dbs.admin.db,
      sql`select settings from app.workspaces where id = ${ws}`,
    );
    expect(w!.settings['look']).toEqual(look);
    expect(w!.settings['website']).toBe('https://brand.example/');

    // Not an array, and never the whole settings by another way.
    expect(
      (
        await expectPgError(() =>
          asService(scope)((tx) => tx.execute(sql`select private.keep_look('[]'::jsonb)`)),
        )
      ).code,
    ).toBe('22023');
    // The worker still can't change a business's settings itself.
    expect(
      (
        await expectPgError(() =>
          asService(scope)((tx) =>
            tx.execute(sql`update app.workspaces set settings = '{}'::jsonb where id = ${ws}`),
          ),
        )
      ).code,
    ).toBe('42501');
  });

  it('is the worker’s alone', async () => {
    expect(
      (
        await expectPgError(() =>
          as(owner)((tx) => tx.execute(sql`select private.keep_look('{}'::jsonb)`)),
        )
      ).code,
    ).toBe('42501');
  });
});
