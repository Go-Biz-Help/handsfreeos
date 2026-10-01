/**
 * 20261018000200: a video link is the conversation's, and its key is the worker's.
 * - A member who can open the thread sees its links and may make one, in their own name and fresh; someone in
 *   another business sees none and can make none.
 * - Nobody but the worker reads the token's hash, changes a link's counts, or deletes one.
 * - The worker finds a link by its hash, holding no business, and never one in a business being deleted.
 * - The `telephony` bucket takes a whole video now: 250 MB.
 */
import { createHash, randomBytes } from 'node:crypto';
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
  type TestUser,
} from './harness';

let owner: TestUser;
let member: TestUser;
let stranger: TestUser;
let ws: string;
let org: string;
let thread: string;
let linkId: string;
const hash = createHash('sha256').update(randomBytes(24).toString('base64url')).digest();

const worker = () => asService({ workspaceId: ws, organizationId: org });
const randomE164 = (): string =>
  `+1${2 + Math.floor(Math.random() * 8)}${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
const weekOut = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

beforeAll(async () => {
  [owner, member, stranger] = await Promise.all([
    createTestUser('video-owner'),
    createTestUser('video-member'),
    createTestUser('video-stranger'),
  ]);
  const a = await bootstrapOrganization(owner, 'Video Org', 'Video');
  ws = a.wsId;
  org = a.orgId;
  await bootstrapOrganization(stranger, 'Other Org', 'Other');
  await dbs.admin.db
    .insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: member.id, role: 'member' });
  thread = (
    await worker()((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.conversations (workspace_id, channel, counterpart)
            values (${ws}, 'sms', ${randomE164()}) returning id`,
      ),
    )
  )[0]!.id;
  linkId = (
    await as(member)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.video_links (workspace_id, conversation_id, token_hash, created_by, expires_at)
            values (${ws}, ${thread}, ${hash}, ${member.id}, ${weekOut()}) returning id`,
      ),
    )
  )[0]!.id;
});
afterAll(closeAll);

describe('who sees and makes a link', () => {
  it('shows a thread’s links to the team, and none to another business', async () => {
    const seen = (u: TestUser) =>
      as(u)((tx) =>
        rows<{ id: string }>(tx, sql`select id from app.video_links where id = ${linkId}`),
      );
    expect(await seen(owner)).toHaveLength(1);
    expect(await seen(member)).toHaveLength(1);
    expect(await seen(stranger)).toHaveLength(0);
  });

  it('lets a person make one only in their own name, fresh, in a business they belong to', async () => {
    const make = (u: TestUser, over: { createdBy?: string; started?: number; ws?: string } = {}) =>
      as(u)((tx) =>
        rows(
          tx,
          sql`insert into app.video_links (workspace_id, conversation_id, token_hash, created_by, expires_at, uploads_started)
              values (${over.ws ?? ws}, ${thread}, ${randomBytes(32)}, ${over.createdBy ?? u.id}, ${weekOut()}, ${over.started ?? 0})`,
        ),
      );
    expect((await expectPgError(() => make(member, { createdBy: owner.id }))).code).toBe('42501');
    expect((await expectPgError(() => make(member, { started: 3 }))).code).toBe('42501');
    expect((await expectPgError(() => make(stranger))).code).toBe('42501');
    await make(owner);
  });
});

describe('what only the worker does', () => {
  it('keeps the token’s hash from people', async () => {
    const err = await expectPgError(() =>
      as(owner)((tx) => rows(tx, sql`select token_hash from app.video_links where id = ${linkId}`)),
    );
    expect(err.code).toBe('42501');
  });

  it('lets no person change a link’s counts or delete one', async () => {
    await expectPgError(() =>
      as(owner)((tx) =>
        rows(tx, sql`update app.video_links set uploads_received = 3 where id = ${linkId}`),
      ),
    );
    await expectPgError(() =>
      as(owner)((tx) => rows(tx, sql`delete from app.video_links where id = ${linkId}`)),
    );
    const [row] = await rows<{ uploads_received: number }>(
      dbs.admin.db,
      sql`select uploads_received from app.video_links where id = ${linkId}`,
    );
    expect(row?.uploads_received).toBe(0);
  });

  it('finds a link by its hash, and never one in a business being deleted', async () => {
    const lookup = () =>
      asService({})((tx) =>
        rows<{ video_link_id: string; workspace_id: string; organization_id: string }>(
          tx,
          sql`select * from private.video_link_lookup(${hash})`,
        ),
      );
    expect(await lookup()).toEqual([
      { video_link_id: linkId, workspace_id: ws, organization_id: org },
    ]);
    await rows(
      dbs.admin.db,
      sql`update app.workspaces set deletion_requested_at = now() where id = ${ws}`,
    );
    expect(await lookup()).toEqual([]);
    await rows(
      dbs.admin.db,
      sql`update app.workspaces set deletion_requested_at = null where id = ${ws}`,
    );
    await expectPgError(() =>
      as(owner)((tx) => rows(tx, sql`select * from private.video_link_lookup(${hash})`)),
    );
  });

  it('gives the telephony bucket room for a whole video', async () => {
    const [bucket] = await rows<{ file_size_limit: string }>(
      dbs.admin.db,
      sql`select file_size_limit from storage.buckets where id = 'telephony'`,
    );
    expect(Number(bucket?.file_size_limit)).toBe(250 * 1024 * 1024);
  });
});
