/**
 * Social Outreach's own tables, on the database: the Drizzle mirror matches the live columns and the manifest names
 * every table; a member reads the playbooks but only owners and admins write them; nobody deletes a step noted or a
 * group; a find outlives its post, and a comment waits only with one; and none of it shows while the add-on is off.
 */
import { getTableColumns, getTableName } from 'drizzle-orm';
import { asUser, rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outreachAddon } from '../../src/addons/outreach/manifest';
import { blankPlaybook } from '../../src/addons/outreach/playbooks';
import { OUTREACH_TABLES } from '../../src/addons/outreach/tables';
import { outreachBusiness, setOutreach } from './outreach-fixture';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const as =
  (u: TestUser) =>
  <T>(q: ReturnType<typeof sql>) =>
    asUser(api(), u.claims, (tx) => rows<T & Record<string, unknown>>(tx, q));
async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause;
    return cause?.code || (e as { code?: string }).code || String(e);
  }
  throw new Error('It was allowed.');
}

let owner: TestUser;
let member: TestUser;
let ws: string;

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('outt-owner'),
    createTestUser('outt-member'),
  ]);
  ws = await outreachBusiness(owner, 'Outreach Tables Co');
  await testDbs()
    .admin.db.insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: member.id, role: 'member' });
}, 60_000);

afterAll(closeTestDbs);

describe('Social Outreach’s tables', () => {
  it('are mirrored in Drizzle exactly, and named in the manifest', async () => {
    for (const table of Object.values(OUTREACH_TABLES)) {
      const live = await rows<{ column_name: string }>(
        admin(),
        sql`select column_name from information_schema.columns
            where table_schema = 'addon_outreach' and table_name = ${getTableName(table)}`,
      );
      expect(
        Object.values(getTableColumns(table))
          .map((c) => c.name)
          .sort(),
        getTableName(table),
      ).toEqual(live.map((c) => c.column_name).sort());
    }
    const tables = await rows<{ name: string }>(
      admin(),
      sql`select c.relname::text as name from pg_class c
          where c.relnamespace = 'addon_outreach'::regnamespace and c.relkind = 'r' order by 1`,
    );
    expect(tables.map((t) => t.name)).toEqual([...(outreachAddon.tables ?? [])].sort());
  });

  it('let a member read the playbooks, and only owners and admins write them', async () => {
    const details = JSON.stringify(blankPlaybook());
    const [made] = await as(owner)<{ id: string }>(
      sql`insert into addon_outreach.playbooks (workspace_id, name, details)
          values (${ws}, 'Roofing estimates', ${details}::jsonb) returning id`,
    );
    expect(
      await as(member)(sql`select id from addon_outreach.playbooks where id = ${made!.id}`),
    ).toHaveLength(1);
    expect(
      await refusal(
        as(member)(
          sql`insert into addon_outreach.playbooks (workspace_id, name, details)
              values (${ws}, 'Mine', ${details}::jsonb)`,
        ),
      ),
    ).toBe('42501');
    // Nobody deletes one: it's archived.
    expect(
      await refusal(as(owner)(sql`delete from addon_outreach.playbooks where id = ${made!.id}`)),
    ).toBe('42501');
  });

  it('keep every step noted, and the groups they came from: nobody deletes one', async () => {
    const [profile] = await as(member)<{ id: string }>(
      sql`insert into addon_outreach.profiles (workspace_id, platform, username, url, name)
          values (${ws}, 'facebook', 'morgan.ellis.2', 'https://www.facebook.com/morgan.ellis.2', 'Morgan Ellis')
          returning id`,
    );
    const [group] = await as(member)<{ id: string }>(
      sql`insert into addon_outreach.groups (workspace_id, platform, slug, url)
          values (${ws}, 'facebook', 'lakeway.neighbors', 'https://www.facebook.com/groups/lakeway.neighbors/')
          returning id`,
    );
    const [touch] = await as(member)<{ id: string }>(
      sql`insert into addon_outreach.touches (workspace_id, profile_id, user_id, kind, group_id, at)
          values (${ws}, ${profile!.id}, ${member.id}, 'like', ${group!.id}, now()) returning id`,
    );
    expect(
      await refusal(as(owner)(sql`delete from addon_outreach.touches where id = ${touch!.id}`)),
    ).toBe('42501');
    expect(
      await refusal(as(owner)(sql`delete from addon_outreach.groups where id = ${group!.id}`)),
    ).toBe('42501');
    // Only a message has a place in the outreach.
    expect(
      await refusal(
        as(member)(
          sql`insert into addon_outreach.touches (workspace_id, profile_id, kind, step, at)
              values (${ws}, ${profile!.id}, 'like', 'first_message', now())`,
        ),
      ),
    ).toBe('23514');
  });

  it('keep a find when its post goes, and a comment waits only with its post (decision 92)', async () => {
    const [writer] = await rows<{ id: string }>(
      admin(),
      sql`insert into addon_outreach.profiles (workspace_id, platform, username, url, name)
          values (${ws}, 'instagram', 'quinn.roofs', 'https://www.instagram.com/quinn.roofs/', 'Quinn Harlow')
          returning id`,
    );
    const [liker] = await rows<{ id: string }>(
      admin(),
      sql`insert into addon_outreach.profiles (workspace_id, platform, username, url, name)
          values (${ws}, 'instagram', 'sage.builds', 'https://www.instagram.com/sage.builds/', 'Sage Whitfield')
          returning id`,
    );
    const [post] = await rows<{ id: string; words: string | null; people_read_at: Date | null }>(
      admin(),
      sql`insert into addon_outreach.posts
            (workspace_id, user_id, profile_id, url, body, found, check_state, words, seen_at)
          values (${ws}, ${member.id}, ${writer!.id}, 'https://www.instagram.com/p/Cq1Roof/',
            'Who fixes hail damage around here?', 'search', 'good', 'austinroofing', now())
          returning id, words, people_read_at`,
    );
    expect(post).toMatchObject({ words: 'austinroofing', people_read_at: null });
    const [find] = await rows<{ id: string; how: string }>(
      admin(),
      sql`insert into addon_outreach.finds
            (workspace_id, user_id, profile_id, platform, how, post_id, words, said, found_at)
          values (${ws}, ${member.id}, ${liker!.id}, 'instagram', 'commented', ${post!.id}, 'austinroofing',
            'Same thing happened to us last spring.', now())
          returning id, how`,
    );
    expect(find!.how).toBe('commented');
    // Only the five ways someone is found.
    expect(
      await refusal(
        rows(
          admin(),
          sql`insert into addon_outreach.finds (workspace_id, user_id, profile_id, platform, how, found_at)
              values (${ws}, ${owner.id}, ${liker!.id}, 'instagram', 'followed', now())`,
        ),
      ),
    ).toBe('23514');
    // A check is of someone known unless the server says it's of someone found.
    const [check] = await rows<{ via: string }>(
      admin(),
      sql`insert into addon_outreach.checks (workspace_id, user_id, profile_id, looked_at)
          values (${ws}, ${member.id}, ${liker!.id}, now()) returning via`,
    );
    expect(check!.via).toBe('known');
    expect(
      await refusal(
        rows(
          admin(),
          sql`update addon_outreach.checks set via = 'stranger'
              where workspace_id = ${ws} and profile_id = ${liker!.id}`,
        ),
      ),
    ).toBe('23514');

    // A comment needs its post; a message has none.
    const sendOf = (kind: string, postId: string | null) =>
      rows(
        admin(),
        sql`insert into addon_outreach.sends (workspace_id, user_id, profile_id, kind, text, drafted, post_id)
            values (${ws}, ${member.id}, ${writer!.id}, ${kind}, 'Hail is rough. Glad you asked.',
              'Hail is rough. Glad you asked.', ${postId})`,
      );
    expect(await refusal(sendOf('comment', null))).toBe('23514');
    expect(await refusal(sendOf('opener', post!.id))).toBe('23514');
    await sendOf('comment', post!.id);

    // The post going lets go of the find's post, never the find or its business, and takes the comment with it.
    await rows(admin(), sql`delete from addon_outreach.posts where id = ${post!.id}`);
    const [kept] = await rows<{ workspace_id: string; post_id: string | null }>(
      admin(),
      sql`select workspace_id, post_id from addon_outreach.finds where id = ${find!.id}`,
    );
    expect(kept).toEqual({ workspace_id: ws, post_id: null });
    expect(
      await rows(
        admin(),
        sql`select id from addon_outreach.sends where workspace_id = ${ws} and kind = 'comment'`,
      ),
    ).toEqual([]);
  });

  it('show nothing while the add-on is off', async () => {
    await setOutreach(ws, 'disabled');
    try {
      expect(await as(owner)(sql`select id from addon_outreach.playbooks`)).toEqual([]);
    } finally {
      await setOutreach(ws, 'enabled');
    }
  });
});
