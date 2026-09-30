/**
 * Staff handing one business an add-on still being built, to try it (Real Estate, step 2): only a staff member who
 * manages add-ons can, the business then sees it as Testing and adds it itself, nobody else is offered it, and
 * taking the grant back stops new installs while one already added keeps running.
 */
import { randomUUID } from 'node:crypto';
import { asUser, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HfosError } from '../src/errors';
import {
  addonGrantCommands,
  addonLifecycleCommands,
  addonQueries,
  executeCommand,
  executeQuery,
  organizationCreate,
  platformBusinessGet,
  type HumanActor,
} from '../src/server';
import { FIXTURE_CATALOG } from './addons/fixtures';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});

const grants = addonGrantCommands(FIXTURE_CATALOG);
const lifecycle = addonLifecycleCommands(FIXTURE_CATALOG);
const queries = addonQueries(FIXTURE_CATALOG);

let staffAdmin: TestUser;
let staffAgent: TestUser;
let owner: TestUser;
let otherOwner: TestUser;
let workspaceId: string;
let otherWorkspaceId: string;

const beStaff = (u: TestUser, role: 'admin' | 'agent') =>
  admin().execute(
    sql`insert into platform.staff (user_id, role) values (${u.id}, ${role})
        on conflict (user_id) do update set role = ${role}, status = 'active'`,
  );

const give = (who: TestUser, ws: string, addonId: string, note?: string) =>
  executeCommand(api(), grants.give, { workspaceId: ws, addonId, note }, human(who), meta()).then(
    (r) => r.output,
  );
const takeBack = (who: TestUser, ws: string, addonId: string) =>
  executeCommand(api(), grants.takeBack, { workspaceId: ws, addonId }, human(who), meta()).then(
    (r) => r.output,
  );
const list = (who: TestUser, ws: string) =>
  executeQuery(api(), queries.list, { workspaceId: ws }, human(who), meta());
const install = (who: TestUser, ws: string, addonId: string) =>
  executeCommand(
    api(),
    lifecycle.install,
    { workspaceId: ws, addonId, include: [] },
    human(who),
    meta(),
  ).then((r) => r.output);

async function refusedWith(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    return e instanceof HfosError ? (e.rule ?? e.code) : String(e);
  }
  throw new Error('It was allowed.');
}

beforeAll(async () => {
  [staffAdmin, staffAgent, owner, otherOwner] = await Promise.all([
    createTestUser('grant-staff-admin'),
    createTestUser('grant-staff-agent'),
    createTestUser('grant-owner'),
    createTestUser('grant-other-owner'),
  ]);
  const made = await Promise.all(
    [
      [owner, 'Hill Country Realty'],
      [otherOwner, 'Bayou Homes'],
    ].map(([u, businessName]) =>
      executeCommand(
        api(),
        organizationCreate,
        { businessName: businessName as string },
        human(u as TestUser),
        meta(),
      ),
    ),
  );
  workspaceId = made[0]!.output.workspaceId;
  otherWorkspaceId = made[1]!.output.workspaceId;
  await Promise.all([beStaff(staffAdmin, 'admin'), beStaff(staffAgent, 'agent')]);
});
afterAll(closeTestDbs);

describe('handing out an add-on to try', () => {
  it('is for staff who manage add-ons, never a support agent or the business itself', async () => {
    expect(await refusedWith(give(staffAgent, workspaceId, 'fxbeta'))).toMatch(
      /^(forbidden|not_found)$/,
    );
    expect(await refusedWith(give(owner, workspaceId, 'fxbeta'))).toMatch(
      /^(forbidden|not_found)$/,
    );
    const [row] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from platform.addon_grants where workspace_id = ${workspaceId}::uuid`,
    );
    expect(row?.n).toBe(0);
  });

  it('refuses one that is only planned, or on its way out', async () => {
    expect(await refusedWith(give(staffAdmin, workspaceId, 'fxinflu'))).toBe('addon_not_grantable');
    expect(await refusedWith(give(staffAdmin, workspaceId, 'fxold'))).toBe('addon_not_grantable');
    expect(await refusedWith(give(staffAdmin, workspaceId, 'nosuch'))).toBe('addon_unknown');
  });

  it('shows the business it as Testing, and lets its owner add it', async () => {
    expect(await refusedWith(install(owner, workspaceId, 'fxbeta'))).toBe('addon_not_available');
    const given = await give(staffAdmin, workspaceId, 'fxbeta', 'Trying loyalty points');
    expect(given).toMatchObject({ granted: true, changed: true });
    // A second press changes nothing and says so.
    expect(await give(staffAdmin, workspaceId, 'fxbeta')).toMatchObject({ changed: false });

    const seen = await list(owner, workspaceId);
    expect(seen.catalog.find((c) => c.addonId === 'fxbeta')).toMatchObject({
      status: 'beta',
      testing: true,
    });
    expect(seen.capabilities.installable.some((c) => c.provider === 'fxbeta')).toBe(true);

    const detail = await executeQuery(
      api(),
      platformBusinessGet,
      { workspaceId },
      human(staffAdmin),
      meta(),
    );
    expect(detail.addonGrants).toEqual([
      expect.objectContaining({ addonId: 'fxbeta', note: 'Trying loyalty points' }),
    ]);

    const moved = await install(owner, workspaceId, 'fxbeta');
    expect(moved.moved.map((m) => `${m.action} ${m.addonId}`)).toEqual(['install fxbeta']);
  });

  it('offers it to nobody else', async () => {
    const seen = await list(otherOwner, otherWorkspaceId);
    expect(seen.catalog.some((c) => c.addonId === 'fxbeta')).toBe(false);
    expect(await refusedWith(install(otherOwner, otherWorkspaceId, 'fxbeta'))).toBe(
      'addon_not_available',
    );
    // And the other business can't read this one's grants.
    const theirs = await asUser(api(), otherOwner.claims, (tx) =>
      rows(tx, sql`select * from platform.addon_grants where workspace_id = ${workspaceId}::uuid`),
    );
    expect(theirs).toEqual([]);
  });

  it('taken back, stops being offered but leaves one already added in place', async () => {
    expect(await takeBack(staffAdmin, workspaceId, 'fxbeta')).toMatchObject({
      granted: false,
      changed: true,
    });
    const seen = await list(owner, workspaceId);
    expect(seen.catalog.some((c) => c.addonId === 'fxbeta')).toBe(false);
    expect(seen.installed.some((i) => i.addonId === 'fxbeta')).toBe(true);
    const events = await rows<{ event_type: string }>(
      admin(),
      sql`select event_type from app.events where entity_id = ${workspaceId}::uuid
            and event_type like 'addon_grant.%' order by created_at`,
    );
    expect(events.map((e) => e.event_type)).toEqual([
      'addon_grant.given',
      'addon_grant.taken_back',
    ]);
  });

  it('writes nothing straight into the table for anyone', async () => {
    await expect(
      asUser(api(), staffAdmin.claims, (tx) =>
        rows(
          tx,
          sql`insert into platform.addon_grants (workspace_id, addon_id) values (${otherWorkspaceId}::uuid, 'fxbeta')`,
        ),
      ),
    ).rejects.toThrow();
  });
});
