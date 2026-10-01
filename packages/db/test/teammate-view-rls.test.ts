import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, rows, sql } from '../src/client';
import {
  as,
  bootstrapOrganization,
  closeAll,
  createTestUser,
  dbs,
  expectPgError,
  type TestUser,
} from './harness';

/**
 * Viewing the app as a teammate (20261018000100), held by the database rather than by the API: who may open a view
 * (private.may_view_as, in the insert's own policy), that a view is only ever ended, that nobody reads anyone
 * else's views, and that a request read through a view never shows the teammate's own mail.
 */
let owner: TestUser;
let admin: TestUser;
let member: TestUser;
let stranger: TestUser;
let wsId: string;
let orgId: string;
let privateThread: string;
let teamThread: string;

const code = async (fn: () => Promise<unknown>) => (await expectPgError(fn)).code;
const mayViewAs = (viewer: TestUser, person: TestUser) =>
  as(viewer)(async (tx) => {
    const [r] = await rows<{ ok: boolean }>(
      tx,
      sql`select private.may_view_as(${wsId}::uuid, ${person.id}::uuid) as ok`,
    );
    return r!.ok;
  });
const openView = (viewer: TestUser, person: TestUser) =>
  as(viewer)(async (tx) => {
    const [r] = await rows<{ id: string }>(
      tx,
      sql`insert into app.teammate_views (workspace_id, organization_id, viewer_id, person_id)
          values (${wsId}, ${orgId}, ${viewer.id}, ${person.id}) returning id`,
    );
    return r!.id;
  });

beforeAll(async () => {
  [owner, admin, member, stranger] = await Promise.all([
    createTestUser('tv-rls-owner'),
    createTestUser('tv-rls-admin'),
    createTestUser('tv-rls-member'),
    createTestUser('tv-rls-stranger'),
  ]);
  const b = await bootstrapOrganization(owner, 'Viewed Org', 'Viewed Business');
  wsId = b.wsId;
  orgId = b.orgId;
  await dbs.admin.db.execute(
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${wsId}, ${admin.id}, 'admin'), (${wsId}, ${member.id}, 'member')`,
  );
  // A thread of the member's own mail (M19), and one of the team's.
  const [domain] = await rows<{ id: string }>(
    dbs.admin.db,
    sql`insert into app.email_domains (workspace_id, domain, status, receiving, ownership_proved_at)
        values (${wsId}, ${`tv-${Date.now()}.example.com`}, 'verified', 'on', now()) returning id`,
  );
  const [address] = await rows<{ id: string }>(
    dbs.admin.db,
    sql`insert into app.email_addresses (workspace_id, email_domain_id, local_part, address, display_name, owner_user_id)
        values (${wsId}, ${domain!.id}, 'member', ${`member@tv-${Date.now()}.example.com`}, 'Member', ${member.id})
        returning id`,
  );
  [privateThread, teamThread] = (
    await rows<{ id: string }>(
      dbs.admin.db,
      sql`insert into app.conversations (workspace_id, channel, counterpart, email_address_id, private_to)
          values (${wsId}, 'email', 'friend@example.com', ${address!.id}, ${member.id}),
                 (${wsId}, 'sms', '+15125550199', null, null)
          returning id`,
    )
  ).map((r) => r.id) as [string, string];
});
afterAll(closeAll);

describe('who may view as whom', () => {
  it('down the roles, never across or up, and never as yourself or a stranger', async () => {
    expect(await mayViewAs(owner, admin)).toBe(true);
    expect(await mayViewAs(owner, member)).toBe(true);
    expect(await mayViewAs(admin, member)).toBe(true);
    expect(await mayViewAs(admin, owner)).toBe(false);
    expect(await mayViewAs(member, admin)).toBe(false);
    expect(await mayViewAs(owner, owner)).toBe(false);
    expect(await mayViewAs(owner, stranger)).toBe(false);
    expect(await mayViewAs(stranger, member)).toBe(false);
  });

  it('not by someone shown only their own threads, as someone who has some', async () => {
    await dbs.admin.db.execute(
      sql`insert into app.role_permission_overrides (workspace_id, role, permission, allowed)
          values (${wsId}, 'admin', 'channels.manage', false)`,
    );
    await dbs.admin.db.execute(
      sql`update app.workspaces set settings = jsonb_set(settings, '{inbox}', '{"perPerson": true}')
          where id = ${wsId}`,
    );
    try {
      expect(await mayViewAs(admin, member)).toBe(false);
      expect(await mayViewAs(owner, member)).toBe(true);
    } finally {
      await dbs.admin.db.execute(
        sql`update app.workspaces set settings = settings - 'inbox' where id = ${wsId}`,
      );
      await dbs.admin.db.execute(
        sql`delete from app.role_permission_overrides where workspace_id = ${wsId} and role = 'admin'`,
      );
    }
    expect(await mayViewAs(admin, member)).toBe(true);
  });

  it('a view the rule refuses can’t be written, whatever the request says', async () => {
    expect(await code(() => openView(admin, owner))).toBe('42501');
    expect(await code(() => openView(stranger, member))).toBe('42501');
    // Nor one in someone else's name.
    expect(
      await code(() =>
        as(admin)((tx) =>
          tx.execute(
            sql`insert into app.teammate_views (workspace_id, organization_id, viewer_id, person_id)
                values (${wsId}, ${orgId}, ${owner.id}, ${member.id})`,
          ),
        ),
      ),
    ).toBe('42501');
  });
});

describe('a view', () => {
  let viewId: string;

  beforeAll(async () => {
    viewId = await openView(owner, member);
  });

  it('is its viewer’s alone to read', async () => {
    const read = (u: TestUser) =>
      as(u)((tx) => rows(tx, sql`select id from app.teammate_views where id = ${viewId}`));
    expect(await read(owner)).toHaveLength(1);
    expect(await read(admin)).toHaveLength(0);
    expect(await read(member)).toHaveLength(0);
  });

  it('says whether it holds, to its viewer only', async () => {
    const look = (u: TestUser) =>
      as(u)((tx) =>
        rows<{ live: boolean; person_id: string }>(
          tx,
          sql`select live, person_id from private.teammate_view(${viewId}::uuid)`,
        ),
      );
    expect(await look(owner)).toEqual([{ live: true, person_id: member.id }]);
    expect(await look(admin)).toEqual([]);
  });

  it('is only ever ended', async () => {
    expect(
      await code(() =>
        as(owner)((tx) =>
          tx.execute(
            sql`update app.teammate_views set person_id = ${admin.id} where id = ${viewId}`,
          ),
        ),
      ),
    ).toBe('42501');
    await as(owner)((tx) =>
      tx.execute(sql`update app.teammate_views set ended_at = now() where id = ${viewId}`),
    );
    expect(
      await code(() =>
        as(owner)((tx) =>
          tx.execute(sql`update app.teammate_views set ended_at = null where id = ${viewId}`),
        ),
      ),
    ).toBe('42501');
  });
});

describe('read through a view', () => {
  /** As the member, the way the API reads once a view holds: their claims, naming who is looking. */
  const throughView = <T>(fn: Parameters<typeof asUser<T>>[2]) =>
    asUser(dbs.api.db, { ...member.claims, hfos_viewer: owner.id }, fn);

  it('their own mail is theirs alone: the thread and its messages', async () => {
    const threads = (read: typeof throughView) =>
      read((tx) =>
        rows<{ id: string }>(
          tx,
          sql`select id from app.conversations where id in (${privateThread}, ${teamThread})`,
        ),
      );
    const asThemselves = <T>(fn: Parameters<typeof asUser<T>>[2]) =>
      asUser(dbs.api.db, member.claims, fn);
    expect((await threads(asThemselves)).map((r) => r.id).sort()).toEqual(
      [privateThread, teamThread].sort(),
    );
    expect((await threads(throughView)).map((r) => r.id)).toEqual([teamThread]);
  });

  it('even where the business shows each person only their own threads', async () => {
    await dbs.admin.db.execute(
      sql`update app.workspaces set settings = jsonb_set(settings, '{inbox}', '{"perPerson": true}')
          where id = ${wsId}`,
    );
    try {
      const [narrowed] = await throughView((tx) =>
        rows<{ n: boolean }>(tx, sql`select private.inbox_narrowed(${wsId}::uuid) as n`),
      );
      const seen = await throughView((tx) =>
        rows<{ id: string }>(tx, sql`select id from app.conversations where id = ${privateThread}`),
      );
      // The member arm (0083) answers for a private thread's person; through a view it doesn't.
      expect(narrowed?.n).toBe(true);
      expect(seen).toEqual([]);
    } finally {
      await dbs.admin.db.execute(
        sql`update app.workspaces set settings = settings - 'inbox' where id = ${wsId}`,
      );
    }
  });
});
