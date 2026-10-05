/**
 * Records kept to the people on them, through the kernel (Real Estate step 4): making one names its maker as its
 * main person, custom_record.assign and custom_record.unassign follow who may change who is on it, the record's
 * timeline says so, a relationship to a private record stays off the other end's timeline, and support is let in
 * and out with support_access.*.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HfosError } from '../src/errors';
import {
  customRecordAssign,
  customRecordCreate,
  customRecordGet,
  customRecordUnassign,
  executeCommand,
  executeQuery,
  organizationCreate,
  relationshipCreate,
  supportAccessGrant,
  supportAccessList,
  supportAccessRequest,
  type HumanActor,
} from '../src/server';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const letters = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(97 + randomInt(26))).join('');
const ADDON = `fx${letters(8)}`;

let owner: TestUser;
let agent: TestUser;
let coordinator: TestUser;
let member: TestUser;
let support: TestUser;
let ws: string;
let org: string;
let kind: string;
let propertyKind: string;

const run = <T>(p: Promise<{ output: T }>) => p.then((r) => r.output);
async function refused(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    return e instanceof HfosError ? (e.rule ?? e.code) : String(e);
  }
  throw new Error('It was allowed.');
}

beforeAll(async () => {
  [owner, agent, coordinator, member, support] = await Promise.all([
    createTestUser('kept-owner'),
    createTestUser('kept-agent'),
    createTestUser('kept-coordinator'),
    createTestUser('kept-member'),
    createTestUser('kept-support'),
  ]);
  const made = await run(
    executeCommand(
      api(),
      organizationCreate,
      { businessName: 'Hill Country Realty' },
      human(owner),
      meta(),
    ),
  );
  ws = made.workspaceId;
  org = made.organizationId;
  await admin()
    .insert(workspaceMemberships)
    .values([
      { workspaceId: ws, userId: agent.id, role: 'member' },
      { workspaceId: ws, userId: coordinator.id, role: 'member' },
      { workspaceId: ws, userId: member.id, role: 'member' },
    ]);
  await rows(
    admin(),
    sql`select private.register_addon_permissions(${ADDON}, ${JSON.stringify([
      { key: `${ADDON}.use`, defaultRoles: ['admin', 'member'], requires: [] },
      { key: `${ADDON}.all_deals`, defaultRoles: ['admin'], requires: [`${ADDON}.use`] },
    ])}::jsonb)`,
  );
  await rows(
    admin(),
    sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
        values (${ws}, ${ADDON}, 'enabled', '1.0.0')`,
  ).catch(async () => {
    // The guard allows only the worker's moves; the database owner writes past it here, as the worker would.
    throw new Error('could not turn the fixture add-on on');
  });
  const kinds = await rows<{ id: string }>(
    admin(),
    sql`insert into app.custom_record_types (workspace_id, key, singular, plural, addon_id, write_permission,
          kept_to_team, see_all_permission, position)
        values (${ws}, ${`${ADDON}_deal`}, 'Deal', 'Deals', ${ADDON}, ${`${ADDON}.use`}, true, ${`${ADDON}.all_deals`}, 900),
               (${ws}, ${`${ADDON}_property`}, 'Property', 'Properties', ${ADDON}, ${`${ADDON}.use`}, false, null, 901)
        returning id`,
  );
  kind = kinds[0]!.id;
  propertyKind = kinds[1]!.id;
  await rows(
    admin(),
    sql`insert into platform.staff (user_id, role, status) values (${support.id}, 'agent', 'active')`,
  );
});
afterAll(closeTestDbs);

const newDeal = (who: TestUser, name: string, extra: Record<string, unknown> = {}) =>
  run(
    executeCommand(
      api(),
      customRecordCreate,
      { workspaceId: ws, typeId: kind, name, ...extra },
      human(who),
      meta(),
    ),
  ).then((o) => o.customRecordId);
const get = (who: TestUser, id: string) =>
  executeQuery(api(), customRecordGet, { workspaceId: ws, customRecordId: id }, human(who), meta());

describe('a record kept to its people', () => {
  it('belongs to its maker, who alone (with owners and admins) sees it', async () => {
    const deal = await newDeal(agent, 'Smith purchase');
    const seen = await get(agent, deal);
    expect(seen.record).toMatchObject({
      keptToTeam: true,
      owner: { id: agent.id },
      team: [],
    });
    expect((await get(owner, deal)).record.name).toBe('Smith purchase');
    expect(await refused(get(member, deal))).toBe('not_found');
  });

  it('refuses naming people on a record everyone already sees', async () => {
    expect(
      await refused(
        run(
          executeCommand(
            api(),
            customRecordCreate,
            {
              workspaceId: ws,
              typeId: propertyKind,
              name: '123 Main St',
              teamUserIds: [member.id],
            },
            human(agent),
            meta(),
          ),
        ),
      ),
    ).toBe('record_not_private');
  });

  it('lets its main person put people on it and take them off, and says so on its timeline', async () => {
    const deal = await newDeal(agent, 'Nguyen purchase');
    const put = await run(
      executeCommand(
        api(),
        customRecordAssign,
        { workspaceId: ws, customRecordId: deal, userId: coordinator.id },
        human(agent),
        meta(),
      ),
    );
    expect(put.team.map((t) => t.id)).toEqual([coordinator.id]);
    expect((await get(coordinator, deal)).record.name).toBe('Nguyen purchase');

    // Someone else on it can't change who is on it, and only an owner or admin picks the main person.
    expect(
      await refused(
        run(
          executeCommand(
            api(),
            customRecordAssign,
            { workspaceId: ws, customRecordId: deal, userId: member.id },
            human(coordinator),
            meta(),
          ),
        ),
      ),
    ).toBe('record_team_not_yours');
    expect(
      await refused(
        run(
          executeCommand(
            api(),
            customRecordAssign,
            { workspaceId: ws, customRecordId: deal, userId: coordinator.id, main: true },
            human(agent),
            meta(),
          ),
        ),
      ),
    ).toBe('record_team_not_yours');
    const handed = await run(
      executeCommand(
        api(),
        customRecordAssign,
        { workspaceId: ws, customRecordId: deal, userId: coordinator.id, main: true },
        human(owner),
        meta(),
      ),
    );
    expect(handed.owner?.id).toBe(coordinator.id);
    expect(handed.team.map((t) => t.id)).toEqual([agent.id]);

    const off = await run(
      executeCommand(
        api(),
        customRecordUnassign,
        { workspaceId: ws, customRecordId: deal, userId: agent.id },
        human(coordinator),
        meta(),
      ),
    );
    expect(off.team).toEqual([]);
    expect(await refused(get(agent, deal))).toBe('not_found');

    const lines = await rows<{ meta: { added: string[]; removed: string[]; main: string | null } }>(
      admin(),
      sql`select meta from app.activities where custom_record_id = ${deal} and subtype = 'team_changed'
          order by occurred_at, created_at`,
    );
    expect(lines).toHaveLength(3);
  });

  it('keeps a relationship line off a shared record that points at it', async () => {
    const deal = await newDeal(agent, 'Patel purchase');
    const [propertyRow] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.custom_records (workspace_id, type_id, name) values (${ws}, ${propertyKind}, '88 Elm Dr')
          returning id`,
    );
    const property = propertyRow!.id;
    const [typeRow] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.relationship_types (workspace_id, a_end, a_record_type_id, a_label, b_end,
            b_record_type_id, b_label, cardinality, addon_id, addon_key)
          values (${ws}, 'custom_record', ${kind}, 'Deal', 'custom_record', ${propertyKind}, 'Property',
            'many_to_one', ${ADDON}, ${`${ADDON}_property`})
          returning id`,
    );
    const type = typeRow!.id;
    await run(
      executeCommand(
        api(),
        relationshipCreate,
        { workspaceId: ws, relationshipTypeId: type, aId: deal, bId: property },
        human(agent),
        meta(),
      ),
    );
    const lines = await rows<{ custom_record_id: string }>(
      admin(),
      sql`select custom_record_id from app.activities where subtype = 'related'
            and custom_record_id in (${deal}::uuid, ${property}::uuid)`,
    );
    expect(lines.map((l) => l.custom_record_id)).toEqual([deal]);
  });
});

describe('support access', () => {
  it('is asked for from a look, answered by someone who may, and listed', async () => {
    await newDeal(agent, 'Garcia purchase');
    await rows(
      admin(),
      sql`insert into platform.view_as_sessions (staff_user_id, workspace_id, organization_id, reason, expires_at)
          values (${support.id}, ${ws}, ${org}, 'Ticket 2291', now() + interval '1 hour')`,
    );
    const { requestId } = await run(
      executeCommand(
        api(),
        supportAccessRequest,
        { workspaceId: ws, note: 'The closing date looks wrong on one deal' },
        human(support),
        meta(),
      ),
    );
    const listed = await executeQuery(
      api(),
      supportAccessList,
      { workspaceId: ws },
      human(agent),
      meta(),
    );
    expect(listed.canLetIn).toBe(true);
    expect(listed.items[0]).toMatchObject({ id: requestId, status: 'requested' });
    expect(
      (await executeQuery(api(), supportAccessList, { workspaceId: ws }, human(member), meta()))
        .canLetIn,
    ).toBe(false);
    expect(
      await refused(
        run(
          executeCommand(
            api(),
            supportAccessGrant,
            { workspaceId: ws, requestId },
            human(member),
            meta(),
          ),
        ),
      ),
    ).toBe('support_access_not_yours');
    const granted = await run(
      executeCommand(
        api(),
        supportAccessGrant,
        { workspaceId: ws, requestId },
        human(agent),
        meta(),
      ),
    );
    expect(Date.parse(granted.expiresAt) - Date.now()).toBeGreaterThan(23 * 3600 * 1000);
  });
});
