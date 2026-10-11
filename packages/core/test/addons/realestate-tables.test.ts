/**
 * Real Estate Agent's own tables (step 6), on the database: the Drizzle mirror matches the live columns and the
 * manifest names every table; a deal's rows are seen only by the people who see the deal (its record is kept to
 * them, step 4); a deal row is about one of the add-on's deal records; only someone on a deal has a part in it;
 * links never cross businesses; history can't be rewritten; and none of it shows while the add-on is off.
 */
import { randomUUID } from 'node:crypto';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { asUser, rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddonOfflineTable } from '../../src/addons/manifest';
import { realestateAddon } from '../../src/addons/realestate/manifest';
import { REALESTATE_TABLES_ALL } from '../../src/addons/realestate/tables';
import {
  customRecordCreate,
  executeCommand,
  organizationCreate,
  type HumanActor,
} from '../../src/server';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const as =
  (u: TestUser) =>
  <T>(q: ReturnType<typeof sql>) =>
    asUser(api(), u.claims, (tx) => rows<T & Record<string, unknown>>(tx, q));
async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const cause = (e as { cause?: { detail?: string; code?: string } }).cause;
    return cause?.detail || cause?.code || String(e);
  }
  throw new Error('It was allowed.');
}

let owner: TestUser;
let agent: TestUser;
let other: TestUser;
let ws: string;
let elsewhere: { id: string; deal: string };
let dealKind: string;
let propertyKind: string;

async function business(u: TestUser, name: string) {
  const made = await executeCommand(
    api(),
    organizationCreate,
    { businessName: name },
    human(u),
    meta(),
  );
  const id = made.output.workspaceId;
  await rows(
    admin(),
    sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
        values (${id}, 'realestate', 'enabled', ${realestateAddon.version})`,
  );
  const kinds = await rows<{ id: string; key: string }>(
    admin(),
    sql`insert into app.custom_record_types (workspace_id, key, singular, plural, addon_id, write_permission,
          kept_to_team, see_all_permission, position)
        values (${id}, 'realestate_deal', 'Deal', 'Deals', 'realestate', 'realestate.use', true,
                'realestate.all_deals', 900),
               (${id}, 'realestate_property', 'Property', 'Properties', 'realestate', 'realestate.use', false,
                null, 901)
        returning id, key`,
  );
  return {
    id,
    deal: kinds.find((k) => k.key === 'realestate_deal')!.id,
    property: kinds.find((k) => k.key === 'realestate_property')!.id,
  };
}

const newRecord = (who: TestUser, typeId: string, name: string, workspaceId = ws) =>
  executeCommand(api(), customRecordCreate, { workspaceId, typeId, name }, human(who), meta()).then(
    (r) => r.output.customRecordId,
  );

const openDeal = async (who: TestUser, name: string) => {
  const id = await newRecord(who, dealKind, name);
  await as(who)(
    sql`insert into addon_realestate.deals (record_id, workspace_id, side, stage, created_by)
        values (${id}, ${ws}, 'buyer', 'onboarding', ${who.id})`,
  );
  return id;
};

beforeAll(async () => {
  [owner, agent, other] = await Promise.all([
    createTestUser('re-owner'),
    createTestUser('re-agent'),
    createTestUser('re-other'),
  ]);
  const here = await business(owner, 'Lakeside Realty');
  ws = here.id;
  dealKind = here.deal;
  propertyKind = here.property;
  await admin()
    .insert(workspaceMemberships)
    .values([
      { workspaceId: ws, userId: agent.id, role: 'member' },
      { workspaceId: ws, userId: other.id, role: 'member' },
    ]);
  elsewhere = await business(owner, 'Hilltop Homes');
}, 60_000);

afterAll(closeTestDbs);

describe('Real Estate Agent’s tables', () => {
  it('are mirrored in Drizzle exactly, and named in the manifest', async () => {
    for (const table of Object.values(REALESTATE_TABLES_ALL)) {
      const live = await rows<{ column_name: string }>(
        admin(),
        sql`select column_name from information_schema.columns
            where table_schema = 'addon_realestate' and table_name = ${getTableName(table)}`,
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
          where c.relnamespace = 'addon_realestate'::regnamespace and c.relkind = 'r' order by 1`,
    );
    expect(tables.map((t) => t.name)).toEqual([...(realestateAddon.tables ?? [])].sort());
  });

  it('are kept on phones exactly as the manifest’s offline says (round six)', async () => {
    const [addon] = await rows<{ permission: string; settings_keys: string[] }>(
      admin(),
      sql`select permission, settings_keys from app.addon_phone_addons where addon_id = 'realestate'`,
    );
    expect(addon?.permission).toBe(realestateAddon.offline?.permission);
    expect(addon?.settings_keys).toEqual(realestateAddon.offline?.settings ?? []);
    const registered = await rows<{
      source: string;
      key_column: string;
      record_column: string | null;
      columns: string[];
      reach: string;
      owner_column: string | null;
      keep_column: string | null;
      keep_values: string[] | null;
    }>(
      admin(),
      sql`select source, key_column, record_column, columns, reach, owner_column, keep_column, keep_values
          from app.addon_phone_tables where addon_id = 'realestate' order by source collate "C"`,
    );
    expect(registered).toEqual(
      [...((realestateAddon.offline?.tables ?? []) as readonly AddonOfflineTable[])]
        .sort((a, b) => (a.table < b.table ? -1 : 1))
        .map((t) => ({
          source: t.table,
          key_column: t.key ?? 'id',
          record_column: t.record ?? null,
          columns: [...t.columns],
          reach: t.reach ?? 'team',
          owner_column: t.owner ?? null,
          keep_column: t.keep?.column ?? null,
          keep_values: t.keep ? [...t.keep.values] : null,
        })),
    );
  });

  it('keep a deal’s rows to the people who see the deal', async () => {
    const deal = await openDeal(agent, 'Moreno purchase');
    const seen = (u: TestUser) =>
      as(u)<{ record_id: string }>(
        sql`select record_id from addon_realestate.deals where record_id = ${deal}`,
      );
    expect(await seen(agent)).toHaveLength(1);
    expect(await seen(owner)).toHaveLength(1);
    expect(await seen(other)).toHaveLength(0);
    // Nor can they write about it.
    expect(
      await as(other)(
        sql`update addon_realestate.deals set stage = 'searching' where record_id = ${deal} returning record_id`,
      ),
    ).toEqual([]);
  });

  it('are only about the add-on’s own deal records', async () => {
    const property = await newRecord(agent, propertyKind, '14 Lake Rd');
    expect(
      await refusal(
        as(agent)(
          sql`insert into addon_realestate.deals (record_id, workspace_id, side, stage)
              values (${property}, ${ws}, 'listing', 'preparing')`,
        ),
      ),
    ).toBe('realestate_not_a_deal');
  });

  it('give a part in a deal only to someone on it', async () => {
    const deal = await openDeal(agent, 'Okafor purchase');
    await as(agent)(
      sql`insert into addon_realestate.deal_roles (workspace_id, deal_record_id, user_id, role)
          values (${ws}, ${deal}, ${agent.id}, 'agent')`,
    );
    expect(
      await refusal(
        as(owner)(
          sql`insert into addon_realestate.deal_roles (workspace_id, deal_record_id, user_id, role)
              values (${ws}, ${deal}, ${other.id}, 'coordinator')`,
        ),
      ),
    ).toBe('realestate_role_not_on_deal');
  });

  it('never link a deal to another business’s', async () => {
    const deal = await openDeal(agent, 'Lee listing');
    const theirs = await newRecord(owner, elsewhere.deal, 'Far away', elsewhere.id);
    await as(owner)(
      sql`insert into addon_realestate.deals (record_id, workspace_id, side, stage)
          values (${theirs}, ${elsewhere.id}, 'listing', 'preparing')`,
    );
    expect(
      await refusal(
        as(owner)(
          sql`insert into addon_realestate.deal_links (workspace_id, deal_record_id, other_record_id, kind)
              values (${ws}, ${deal}, ${theirs}, 'same_home')`,
        ),
      ),
      // The pair (this business, their deal) isn't a deal here.
    ).toMatch(/is not present in table "deals"/);
  });

  it('keep what happened as it happened', async () => {
    const deal = await openDeal(agent, 'Nakamura purchase');
    const [line] = await as(agent)<{ id: string }>(
      sql`insert into addon_realestate.deal_history (workspace_id, deal_record_id, actor_type, actor_user_id, what, after)
          values (${ws}, ${deal}, 'person', ${agent.id}, 'opened', '{"stage": "onboarding"}'::jsonb)
          returning id`,
    );
    expect(
      await refusal(
        as(agent)(
          sql`update addon_realestate.deal_history set what = 'stage' where id = ${line!.id}`,
        ),
      ),
    ).toBe('42501');
  });

  it('show nothing while the add-on is off', async () => {
    const deal = await openDeal(agent, 'Silva purchase');
    await rows(
      admin(),
      sql`update app.addon_installations set state = 'disabled'
          where workspace_id = ${ws} and addon_id = 'realestate'`,
    );
    try {
      expect(
        await as(owner)(
          sql`select record_id from addon_realestate.deals where record_id = ${deal}`,
        ),
      ).toEqual([]);
    } finally {
      await rows(
        admin(),
        sql`update app.addon_installations set state = 'enabled'
            where workspace_id = ${ws} and addon_id = 'realestate'`,
      );
    }
  });
});
