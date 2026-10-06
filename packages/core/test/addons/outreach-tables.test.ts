/**
 * Social Outreach's own tables, on the database: the Drizzle mirror matches the live columns and the manifest names
 * every table; a member reads the playbooks but only owners and admins write them; nobody deletes a step noted or a
 * group; and none of it shows while the add-on is off.
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
    return cause?.code || String(e);
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

  it('show nothing while the add-on is off', async () => {
    await setOutreach(ws, 'disabled');
    try {
      expect(await as(owner)(sql`select id from addon_outreach.playbooks`)).toEqual([]);
    } finally {
      await setOutreach(ws, 'enabled');
    }
  });
});
