/**
 * "Last active" on Admin → Businesses (20261027030300): the last time one of the business's own people did
 * something, never HandsFreeOS's own jobs and never staff. The owner, 20 Nov 2026: the daily attention digest made
 * every business look active today.
 *
 * The same rule decides "Active this week" and the gone_quiet flag, and a business nobody has done anything in
 * sorts last under Busiest and first under Quietest. Each person's own last active on the business's page comes
 * through a function too: staff read none of a business's events under the ordinary rules.
 */
import { randomUUID } from 'node:crypto';
import { asUser, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeQuery } from '../src/kernel/execute';
import type { HumanActor, RequestMeta } from '../src/kernel/types';
import { platformBusinessGet, platformBusinessList } from '../src/server';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'test' });

const tag = `Last Active ${randomUUID().slice(0, 8)}`;
let staffAgent: TestUser;
let member: TestUser;
let orgId: string;
let quiet: string;
let empty: string;

// A business made straight in the database, a month ago, so the only events in it are the ones written here.
const addBusiness = async (name: string) => {
  const [w] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.workspaces (organization_id, name, slug, created_at)
        values (${orgId}, ${name}, ${`last-active-${randomUUID().slice(0, 8)}`}, now() - interval '30 days')
        returning id`,
  );
  return w!.id;
};

const addEvent = (workspaceId: string, actorType: string, actorId: string | null, ago: string) =>
  rows(
    admin(),
    sql`insert into app.events (organization_id, workspace_id, event_type, actor_type, actor_id, entity_type,
          entity_id, payload, correlation_id, created_at)
        values (${orgId}, ${workspaceId}, 'test.happened', ${actorType}::app.actor_type, ${actorId}, 'workspace',
          ${workspaceId}, '{}'::jsonb, ${randomUUID()}, now() - ${ago}::interval)`,
  );

const detail = (workspaceId: string) =>
  executeQuery(api(), platformBusinessGet, { workspaceId }, human(staffAgent), meta());

const list = (sort: 'busiest' | 'quietest') =>
  executeQuery(
    api(),
    platformBusinessList,
    { search: tag, sort, limit: 25 },
    human(staffAgent),
    meta(),
  );

const activeThisWeek = async () => {
  const [t] = await asUser(api(), staffAgent.claims, (tx) =>
    rows<{ active: number }>(
      tx,
      sql`select active_this_week::int as active from private.admin_business_totals()`,
    ),
  );
  return t!.active;
};

beforeAll(async () => {
  [staffAgent, member] = await Promise.all([
    createTestUser('last-active-agent'),
    createTestUser('last-active-member'),
  ]);
  await admin().execute(
    sql`insert into platform.staff (user_id, role) values (${staffAgent.id}, 'agent')
        on conflict (user_id) do update set role = excluded.role, status = 'active'`,
  );
  const [o] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.organizations (name, slug) values (${tag}, ${`last-active-${randomUUID().slice(0, 8)}`})
        returning id`,
  );
  orgId = o!.id;
  quiet = await addBusiness(`${tag} Quiet`);
  empty = await addBusiness(`${tag} Empty`);
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${quiet}, ${member.id}, 'owner')`,
  );
  // Its owner last did something 20 days ago.
  await addEvent(quiet, 'human', member.id, '20 days');
});
afterAll(closeTestDbs);

describe('last active', () => {
  it('ignores HandsFreeOS’s own jobs and staff working in the business', async () => {
    const before = await activeThisWeek();
    // The morning's attention digest, and a staff member (in no standing there) changing something.
    await addEvent(quiet, 'system', null, '1 minute');
    await addEvent(quiet, 'human', staffAgent.id, '1 minute');
    await addEvent(empty, 'system', null, '1 minute');

    const got = await detail(quiet);
    const lastActive = Date.parse(got.business.lastActiveAt!);
    expect(Date.now() - lastActive).toBeGreaterThan(19 * 86_400_000);
    expect(Date.now() - lastActive).toBeLessThan(21 * 86_400_000);
    expect(got.business.attention).toContain('gone_quiet');
    // Each person's own line: the owner's 20 days, which staff couldn't read before (it said "never").
    expect(got.people.find((p) => p.userId === member.id)?.lastActiveAt).toBe(
      got.business.lastActiveAt,
    );

    const empt = await detail(empty);
    expect(empt.business.lastActiveAt).toBeNull();
    expect(empt.business.attention).toContain('gone_quiet');

    expect(await activeThisWeek()).toBe(before);
  });

  it('puts a business nobody has done anything in last under Busiest and first under Quietest', async () => {
    expect((await list('busiest')).businesses.map((b) => b.workspaceId)).toEqual([quiet, empty]);
    expect((await list('quietest')).businesses.map((b) => b.workspaceId)).toEqual([empty, quiet]);
  });

  it('moves when one of the business’s own people does something', async () => {
    const before = await activeThisWeek();
    await addEvent(quiet, 'human', member.id, '1 minute');

    const got = await detail(quiet);
    expect(Date.now() - Date.parse(got.business.lastActiveAt!)).toBeLessThan(10 * 60_000);
    expect(got.business.attention).not.toContain('gone_quiet');
    expect(await activeThisWeek()).toBe(before + 1);
  });
});
