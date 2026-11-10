/**
 * Contractor Operations on the database (docs/contractor.md): its tables are mirrored exactly; a job is a service
 * call or a project at a property, for a customer; a project starts with its starter phases and its % done is their
 * average; adding a phase makes a service call a project; on hold and cancelled need a reason; a job's price and
 * budget are seen and set only by people who may see job costs (the owner's decision 11); a visit on a job moves it
 * along; and none of it works while the add-on is off.
 */
import { randomUUID } from 'node:crypto';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { asUser, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { contractorAddon } from '../../src/addons/contractor/manifest';
import { contractorAddonServer } from '../../src/addons/contractor/server';
import { CONTRACTOR_TABLES } from '../../src/addons/contractor/tables';
import { STARTER_PHASES } from '../../src/addons/contractor/trades';
import type { AddonManifest } from '../../src/addons/manifest';
import {
  addonRef,
  executeCommand,
  executeQuery,
  organizationCreate,
  type CommandDef,
  type HumanActor,
  type QueryDef,
  type SystemActor,
} from '../../src/server';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const ops = [...(contractorAddonServer.commands ?? []), ...(contractorAddonServer.queries ?? [])];
const op = (name: string) => {
  const found = ops.find((o) => o.name === name);
  if (!found) throw new Error(`no ${name}`);
  return found;
};

/** As a person, in the business. */
function as(u: TestUser, name: string, input: Record<string, unknown> = {}): Promise<Any> {
  const found = op(name);
  return found.kind === 'command'
    ? executeCommand(
        api(),
        found as CommandDef,
        { workspaceId: ws, ...input },
        human(u),
        meta(),
      ).then((r) => r.output)
    : executeQuery(api(), found as QueryDef, { workspaceId: ws, ...input }, human(u), meta());
}
/** As the worker, acting for the add-on. */
function worker(name: string, input: Record<string, unknown>): Promise<Any> {
  const actor: SystemActor = {
    type: 'system',
    workspaceId: ws,
    organizationId: orgId,
    addon: addonRef(contractorAddon),
  };
  return executeCommand(
    testDbs().worker.db,
    op(name) as CommandDef<z.ZodType, z.ZodType>,
    { workspaceId: ws, ...input },
    actor,
    meta(),
  ).then((r) => r.output);
}
const refused = (p: Promise<unknown>) =>
  p.then(
    () => 'went through',
    (e: { rule?: string; code?: string }) => e.rule ?? e.code,
  );

let owner: TestUser;
let member: TestUser;
let ws: string;
let orgId: string;
let customerId: string;

/** The add-on on, set up the way the worker sets it up when it arrives: its kinds of records and relationships. */
async function install(id: string): Promise<void> {
  const manifest: AddonManifest = contractorAddon;
  await rows(
    admin(),
    sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
        values (${id}, 'contractor', 'enabled', ${contractorAddon.version})`,
  );
  const kinds = new Map<string, string>();
  for (const [i, k] of (manifest.recordKinds ?? []).entries()) {
    const [row] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.custom_record_types (workspace_id, key, singular, plural, name_label, icon, position,
            addon_id, write_permission, kept_to_team, see_all_permission)
          values (${id}, ${k.key}, ${k.singular}, ${k.plural}, ${k.nameLabel ?? 'Name'}, ${k.icon ?? 'box'},
            ${900 + i}, 'contractor', ${k.writePermission}, ${k.keptToTeam !== undefined},
            ${k.keptToTeam?.seeAllPermission ?? null})
          returning id`,
    );
    kinds.set(k.key, row!.id);
  }
  for (const [i, t] of (manifest.relationshipTypes ?? []).entries()) {
    const end = (e: typeof t.a) =>
      e.kind === 'record'
        ? { end: 'custom_record', kind: kinds.get(e.recordKind)! }
        : { end: e.kind, kind: null };
    const a = end(t.a);
    const b = end(t.b);
    await rows(
      admin(),
      sql`insert into app.relationship_types (workspace_id, a_end, a_record_type_id, a_label, b_end,
            b_record_type_id, b_label, cardinality, position, addon_id, addon_key, portal_visible)
          values (${id}, ${a.end}::app.relationship_end, ${a.kind}, ${t.aLabel}, ${b.end}::app.relationship_end,
            ${b.kind}, ${t.bLabel}, ${t.cardinality ?? 'many_to_many'}::app.relationship_cardinality, ${900 + i},
            'contractor', ${t.key}, ${t.portal === true})`,
    );
  }
}

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('contractor-owner'),
    createTestUser('contractor-member'),
  ]);
  const made = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Bright Line Electric' },
    human(owner),
    meta(),
  );
  ws = made.output.workspaceId;
  orgId = made.output.organizationId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${ws}, ${member.id}, 'member')`,
  );
  await install(ws);
  const [p] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.people (workspace_id, first_name, last_name) values (${ws}, 'Dana', 'Reyes') returning id`,
  );
  customerId = p!.id;
}, 60_000);
afterAll(closeTestDbs);

describe('Contractor Operations’ tables', () => {
  it('are mirrored in Drizzle exactly, and named in the manifest', async () => {
    for (const table of Object.values(CONTRACTOR_TABLES)) {
      const live = await rows<{ column_name: string }>(
        admin(),
        sql`select column_name from information_schema.columns
            where table_schema = 'addon_contractor' and table_name = ${getTableName(table)}`,
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
          where c.relnamespace = 'addon_contractor'::regnamespace and c.relkind = 'r' order by 1`,
    );
    expect(tables.map((t) => t.name)).toEqual([...(contractorAddon.tables ?? [])].sort());
  });
});

describe('jobs', () => {
  it('opens a service call for a customer at a new address, which becomes their property', async () => {
    const out = await as(owner, 'contractor.job.open', {
      name: 'Replace the panel',
      customerPersonId: customerId,
      newPropertyAddress: '12 Oak St, Springfield',
      trade: 'electrical',
      dueOn: '2030-01-15',
    });
    expect(out).toMatchObject({ name: 'Replace the panel', phases: 0 });
    expect(out.propertyId).toBeTruthy();
    const job = await as(member, 'contractor.job.get', { jobId: out.jobId });
    expect(job).toMatchObject({
      kind: 'service',
      status: 'new',
      percentDone: 0,
      customer: { personId: customerId, name: 'Dana Reyes' },
      property: { recordId: out.propertyId, name: '12 Oak St, Springfield' },
      lead: { userId: owner.id },
      // A member without "See job costs and profit" sees no money at all.
      money: null,
    });
    const props = await as(member, 'contractor.property.list', { customerPersonId: customerId });
    expect(props.properties[0]).toMatchObject({ recordId: out.propertyId, jobs: 1 });
    const list = await as(member, 'contractor.job.list', { search: 'oak st' });
    expect(list.jobs.map((j: Any) => j.id)).toEqual([out.jobId]);
  });

  it('starts a project with its trade’s starter phases, and keeps its % done as their average', async () => {
    const out = await as(owner, 'contractor.job.open', {
      name: 'Kitchen remodel',
      kind: 'project',
      trade: 'remodeling',
      customerPersonId: customerId,
    });
    expect(out.phases).toBe(STARTER_PHASES.remodeling.length);
    const job = await as(owner, 'contractor.job.get', { jobId: out.jobId });
    expect(job.phaseList.map((p: Any) => p.name)).toEqual([...STARTER_PHASES.remodeling]);
    const [first, second] = job.phaseList;
    await as(member, 'contractor.phase.update', { phaseId: first.id, status: 'done' });
    const half = await as(member, 'contractor.phase.update', {
      phaseId: second.id,
      percentDone: 50,
    });
    const n = STARTER_PHASES.remodeling.length;
    expect(half.jobPercentDone).toBe(Math.round(150 / n));
    // A project's % comes from its phases, never set by hand.
    expect(
      await refused(
        as(member, 'contractor.job.set_percent', { jobId: out.jobId, percentDone: 80 }),
      ),
    ).toBe('contractor_percent_on_project');
    // Every phase once, in the new order.
    const ids = job.phaseList.map((p: Any) => p.id);
    expect(
      await refused(
        as(member, 'contractor.phase.reorder', { jobId: out.jobId, phaseIds: ids.slice(1) }),
      ),
    ).toBe('contractor_phase_order');
    await as(member, 'contractor.phase.reorder', {
      jobId: out.jobId,
      phaseIds: [ids[1], ids[0], ...ids.slice(2)],
    });
    const again = await as(member, 'contractor.job.get', { jobId: out.jobId });
    expect(again.phaseList[0].id).toBe(ids[1]);
    expect(
      await refused(as(member, 'contractor.phase.add', { jobId: out.jobId, name: 'permit ' })),
    ).toBe('contractor_phase_name_taken');
  });

  it('makes a service call a project when it gets its first phase', async () => {
    const out = await as(member, 'contractor.job.open', { name: 'Add an outlet' });
    const added = await as(member, 'contractor.phase.add', {
      jobId: out.jobId,
      name: 'Rough-in',
      startsOn: '2030-02-01',
      dueOn: '2030-02-03',
    });
    expect(added.madeProject).toBe(true);
    const job = await as(member, 'contractor.job.get', { jobId: out.jobId });
    expect(job.kind).toBe('project');
    expect(job.phaseList).toMatchObject([
      { name: 'Rough-in', startsOn: '2030-02-01', dueOn: '2030-02-03', status: 'not_started' },
    ]);
    expect(
      await refused(
        as(member, 'contractor.phase.add', {
          jobId: out.jobId,
          name: 'Trim-out',
          startsOn: '2030-02-05',
          dueOn: '2030-02-04',
        }),
      ),
    ).toBe('contractor_dates_backwards');
  });

  it('asks why a job is on hold or cancelled, and keeps a done job done', async () => {
    const out = await as(member, 'contractor.job.open', { name: 'Fix the flicker' });
    expect(
      await refused(
        as(member, 'contractor.job.set_status', { jobId: out.jobId, status: 'on_hold' }),
      ),
    ).toBe('contractor_reason_needed');
    await as(member, 'contractor.job.set_status', {
      jobId: out.jobId,
      status: 'on_hold',
      reason: 'Waiting on the part',
    });
    expect(await as(member, 'contractor.job.get', { jobId: out.jobId })).toMatchObject({
      status: 'on_hold',
      statusReason: 'Waiting on the part',
    });
    await as(member, 'contractor.job.set_status', { jobId: out.jobId, status: 'done' });
    const done = await as(member, 'contractor.job.get', { jobId: out.jobId });
    expect(done).toMatchObject({ status: 'done', percentDone: 100, statusReason: null });
    expect(done.doneAt).toBeTruthy();
    expect(
      await refused(
        as(member, 'contractor.job.set_percent', { jobId: out.jobId, percentDone: 40 }),
      ),
    ).toBe('contractor_job_closed');
  });

  it('lets only an owner or admin put someone else in charge', async () => {
    expect(
      await refused(
        as(member, 'contractor.job.open', { name: 'Hang lights', leadUserId: owner.id }),
      ),
    ).toBe('contractor_lead_only');
    const out = await as(owner, 'contractor.job.open', {
      name: 'Hang lights',
      leadUserId: member.id,
    });
    await as(member, 'contractor.job.team_add', { jobId: out.jobId, userId: owner.id });
    const mine = await as(member, 'contractor.job.list', { filter: 'mine' });
    expect(mine.jobs.map((j: Any) => j.name)).toContain('Hang lights');
  });
});

describe('a job’s price and budget (the owner’s decision 11)', () => {
  it('is set and seen only by people who may see job costs, in the database too', async () => {
    const out = await as(owner, 'contractor.job.open', { name: 'Service upgrade' });
    expect(
      await refused(
        as(member, 'contractor.job.set_money', { jobId: out.jobId, priceCents: 100_00 }),
      ),
    ).toBe('forbidden');
    await as(owner, 'contractor.job.set_money', {
      jobId: out.jobId,
      priceCents: 1_000_00,
      laborCents: 400_00,
      materialsCents: 300_00,
      laborHours: 8.5,
    });
    const seen = await as(owner, 'contractor.job.get', { jobId: out.jobId });
    expect(seen.money).toMatchObject({
      priceCents: 1_000_00,
      totalCents: 700_00,
      profitCents: 300_00,
      marginBp: 3000,
      laborHours: 8.5,
    });
    expect((await as(member, 'contractor.job.get', { jobId: out.jobId })).money).toBeNull();
    // Row security keeps the rows from anyone without the permission, whatever asks.
    const count = (u: TestUser) =>
      asUser(api(), u.claims, (tx) =>
        rows<{ n: number }>(tx, sql`select count(*)::int as n from addon_contractor.money`),
      ).then((r) => r[0]!.n);
    expect(await count(owner)).toBeGreaterThan(0);
    expect(await count(member)).toBe(0);
  });
});

describe('the worker', () => {
  it('does nothing for a visit that isn’t on a job', async () => {
    expect(
      await worker('contractor.job.follow_visit', { appointmentId: randomUUID(), what: 'booked' }),
    ).toBeNull();
  });
});

describe('while it’s off', () => {
  it('refuses its work', async () => {
    await rows(
      admin(),
      sql`update app.addon_installations set state = 'disabled' where workspace_id = ${ws} and addon_id = 'contractor'`,
    );
    try {
      expect(await refused(as(owner, 'contractor.job.open', { name: 'Anything' }))).not.toBe(
        'went through',
      );
      expect(await refused(as(owner, 'contractor.job.list'))).not.toBe('went through');
    } finally {
      await rows(
        admin(),
        sql`update app.addon_installations set state = 'enabled' where workspace_id = ${ws} and addon_id = 'contractor'`,
      );
    }
  });
});
