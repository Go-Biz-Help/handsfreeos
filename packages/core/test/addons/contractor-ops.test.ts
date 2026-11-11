/**
 * Contractor Operations on the database (docs/contractor.md): its tables are mirrored exactly; a job is a service
 * call or a project at a property, for a customer; a project starts with its starter phases and its % done is their
 * average; adding a phase makes a service call a project; on hold and cancelled need a reason; a job's price and
 * budget are seen and set only by people who may see job costs (the owner's decision 11); a visit on a job moves it
 * along; an estimate's costs stay with people who may see them, one under the lowest margin waits for an owner's or
 * admin's OK (decision 6), and an approved one fills its job's budget at the option picked (decision 5); crews are
 * set up by the people who set the add-on up, a visit's work order starts with its trade's checklist, a crew on a
 * visit books its people and brings its subcontractors (decision 7), and a job isn't Done while a required item is
 * left unless an owner or admin says why (decision 8); a job's materials are kept by everyone on it, what one costs
 * stays with people who may see job costs, an approved estimate fills them once, and each visit says what it's
 * still missing (decision 9); a visit's buttons start and stop the time of the people on it, a break pauses one
 * person, fixing time takes someone who may and a reason, what an hour cost is kept as it was and seen only by
 * people who may see job costs, a job's costs are set against its plan with what it's heading for, and the profit
 * page adds the jobs up (decisions 10 and 11); and none of it works while the add-on is off.
 */
import { randomUUID } from 'node:crypto';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { asUser, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { STARTER_CHECKLISTS } from '../../src/addons/contractor/checklists';
import { contractorAddon } from '../../src/addons/contractor/manifest';
import { contractorAddonServer } from '../../src/addons/contractor/server';
import { CONTRACTOR_TABLES } from '../../src/addons/contractor/tables';
import { STARTER_PHASES } from '../../src/addons/contractor/trades';
import type { AddonManifest } from '../../src/addons/manifest';
import {
  addonRef,
  estimateAcceptOnline,
  estimateCreate,
  estimateSend,
  executeCommand,
  executeQuery,
  organizationCreate,
  productCreate,
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
/** As the worker, acting for the add-on: on its own, or for the person who asked. */
function worker(name: string, input: Record<string, unknown>, forUser?: TestUser): Promise<Any> {
  const actor: SystemActor = {
    type: 'system',
    workspaceId: ws,
    organizationId: orgId,
    addon: addonRef(contractorAddon),
    ...(forUser ? { onBehalfOf: forUser.id } : {}),
  };
  const found = op(name);
  return found.kind === 'command'
    ? executeCommand(
        testDbs().worker.db,
        found as CommandDef<z.ZodType, z.ZodType>,
        { workspaceId: ws, ...input },
        actor,
        meta(),
      ).then((r) => r.output)
    : executeQuery(
        testDbs().worker.db,
        found as QueryDef,
        { workspaceId: ws, ...input },
        actor,
        meta(),
      );
}
const refused = (p: Promise<unknown>) =>
  p.then(
    () => 'went through',
    (e: { rule?: string; code?: string }) => e.rule ?? e.code,
  );

let owner: TestUser;
let member: TestUser;
/** A member who may see job costs and bill, and so write estimates, but not OK one under the lowest margin. */
let estimator: TestUser;
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
  [owner, member, estimator] = await Promise.all([
    createTestUser('contractor-owner', { fullName: 'Olive Owner' }),
    createTestUser('contractor-member'),
    createTestUser('contractor-estimator', { fullName: 'Eli Estimator' }),
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
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${ws}, ${member.id}, 'member'), (${ws}, ${estimator.id}, 'member')`,
  );
  await install(ws);
  await rows(
    admin(),
    sql`insert into app.member_permission_overrides (workspace_id, user_id, permission, allowed)
        values (${ws}, ${estimator.id}, 'contractor.costs', true), (${ws}, ${estimator.id}, 'money.bill', true)`,
  );
  const [p] = await rows<{ id: string }>(
    admin(),
    // Eli and the member are on the customer: someone who doesn't manage money bills, and sees the estimates of,
    // only the customers they're on.
    sql`insert into app.people (workspace_id, first_name, last_name, owner_user_id, team_user_ids)
        values (${ws}, 'Dana', 'Reyes', ${estimator.id}, array[${member.id}]::uuid[]) returning id`,
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

describe('costs and estimates (the owner’s decisions 5, 6 and 11)', () => {
  const hours = (over: Record<string, unknown> = {}) => ({
    name: 'Electrician',
    quantity: 4,
    unitLabel: 'hour',
    unitPriceCents: 100_00,
    kind: 'labor',
    unitCostCents: 40_00,
    ...over,
  });
  const part = (over: Record<string, unknown> = {}) => ({
    name: '200A panel',
    quantity: 1,
    unitPriceCents: 200_00,
    kind: 'material',
    unitCostCents: 100_00,
    ...over,
  });
  /** How many rows of one of the add-on's cost tables a person can read, whatever asks. */
  const seen = (u: TestUser, table: 'item_costs' | 'estimate_costs' | 'estimating') =>
    asUser(api(), u.claims, (tx) =>
      rows<{ n: number }>(
        tx,
        sql`select count(*)::int as n from ${sql.raw(`addon_contractor.${table}`)}`,
      ),
    ).then((r) => r[0]!.n);
  const core = <C extends CommandDef<Any, Any>>(
    cmd: C,
    input: Record<string, unknown>,
    u: TestUser,
  ) =>
    executeCommand(api(), cmd, { workspaceId: ws, ...input }, human(u), meta()).then(
      (r) => r.output as Any,
    );
  /** The customer's own yes, the way their page records it. */
  const customerApproves = (estimateId: string, option?: number) =>
    executeCommand(
      testDbs().worker.db,
      estimateAcceptOnline,
      { workspaceId: ws, estimateId, name: 'Dana R.', wording: 'I approve this estimate.', option },
      { type: 'system', workspaceId: ws, organizationId: orgId } satisfies SystemActor,
      { correlationId: randomUUID(), channel: 'worker' },
    ).then((r) => r.output);

  it('starts at a 20% lowest margin, which only an owner or admin moves', async () => {
    expect(await as(estimator, 'contractor.estimate.get')).toMatchObject({
      estimate: null,
      check: null,
      estimating: { minMarginBp: 2_000, markupBp: 5_000, laborRateCents: 0, laborCostCents: 0 },
      may: { approve: false, bill: true },
    });
    expect(await refused(as(estimator, 'contractor.estimating.save', { minMarginBp: 500 }))).toBe(
      'forbidden',
    );
    expect(
      await as(owner, 'contractor.estimating.save', {
        laborRateCents: 95_00,
        laborCostCents: 40_00,
      }),
    ).toEqual({
      minMarginBp: 2_000,
      markupBp: 5_000,
      laborRateCents: 95_00,
      laborCostCents: 40_00,
    });
    expect((await as(owner, 'contractor.overview')).estimating).toMatchObject({
      laborRateCents: 95_00,
    });
    // What labor costs the business is a cost like any other.
    expect((await as(member, 'contractor.overview')).estimating).toBeNull();
    expect(await seen(estimator, 'estimating')).toBe(1);
    expect(await seen(member, 'estimating')).toBe(0);
  });

  it('keeps what a price list item costs with people who may see job costs', async () => {
    const { productId } = await core(
      productCreate,
      { name: 'Service call', kind: 'service', unitPriceCents: 95_00, unitLabel: 'hour' },
      owner,
    );
    const set = (costCents: number | null) =>
      as(estimator, 'contractor.item_cost.set', { productId, costCents });
    const read = () =>
      as(estimator, 'contractor.item_cost.list').then((r) =>
        r.items.find((i: Any) => i.productId === productId),
      );
    // Nobody has said yet: a service is costed as labor.
    expect(await read()).toMatchObject({ kind: 'labor', costCents: null, marginBp: null });
    expect(await set(40_00)).toEqual({ productId, changed: true });
    expect(await set(40_00)).toEqual({ productId, changed: false });
    expect(await read()).toMatchObject({
      name: 'Service call',
      unitPriceCents: 95_00,
      kind: 'labor',
      costCents: 40_00,
      marginBp: 5_789,
    });
    expect(await refused(as(member, 'contractor.item_cost.list'))).toBe('forbidden');
    expect(await seen(estimator, 'item_costs')).toBe(1);
    expect(await seen(member, 'item_costs')).toBe(0);
    expect(await set(null)).toEqual({ productId, changed: true });
    expect(await read()).toMatchObject({ costCents: null, marginBp: null });
    expect(
      await refused(
        as(estimator, 'contractor.item_cost.set', { productId: randomUUID(), costCents: 1 }),
      ),
    ).toBe('not_found');
  });

  it('writes an ordinary estimate for a job’s customer, and sends one that clears the margin', async () => {
    const job = await as(owner, 'contractor.job.open', {
      name: 'Panel swap',
      customerPersonId: customerId,
    });
    const saved = await as(estimator, 'contractor.estimate.save', {
      jobId: job.jobId,
      title: 'Panel swap',
      options: [
        {
          lines: [
            hours(),
            part(),
            { name: 'Permit', quantity: 1, unitPriceCents: 75_00, kind: 'other' },
          ],
        },
      ],
    });
    expect(saved).toMatchObject({
      created: true,
      check: {
        options: [
          {
            position: 1,
            name: null,
            priceCents: 675_00,
            laborCents: 160_00,
            materialsCents: 100_00,
            otherCents: 0,
            costCents: 260_00,
            profitCents: 415_00,
            marginBp: 6_148,
            laborHours: 4,
            uncosted: 0,
          },
        ],
        needsOk: null,
        ok: null,
        asked: null,
        canSend: true,
      },
    });
    const { estimateId } = saved;
    const got = await as(estimator, 'contractor.estimate.get', { estimateId });
    expect(got).toMatchObject({
      estimate: {
        id: estimateId,
        status: 'draft',
        builtBy: { addonId: 'contractor', running: true },
      },
      job: { id: job.jobId, name: 'Panel swap' },
      person: { id: customerId },
      may: { approve: false, bill: true },
    });
    expect(got.costs).toEqual([
      { option: 1, line: 0, kind: 'labor', unitCostCents: 40_00 },
      { option: 1, line: 1, kind: 'material', unitCostCents: 100_00 },
      { option: 1, line: 2, kind: 'other', unitCostCents: null },
    ]);
    // Someone on the job sees that it has an estimate, and none of what it costs.
    const mine = await as(member, 'contractor.estimate.list', { jobId: job.jobId });
    expect(mine.estimates).toMatchObject([
      { id: estimateId, status: 'draft', optionCount: 0, job: { id: job.jobId }, asked: null },
    ]);
    expect(await refused(as(member, 'contractor.estimate.get', { estimateId }))).toBe('forbidden');
    expect(await seen(estimator, 'estimate_costs')).toBeGreaterThan(0);
    expect(await seen(member, 'estimate_costs')).toBe(0);
    // Core sends it nowhere but through the builder, which checks the margin first.
    expect(await refused(core(estimateSend, { estimateId }, owner))).toBe(
      'estimate_built_elsewhere',
    );
    expect(await as(estimator, 'contractor.estimate.ask_ok', { estimateId })).toEqual({
      estimateId,
      changed: false,
    });
    const sent = await as(estimator, 'contractor.estimate.send', { estimateId });
    expect(sent.status).toBe('sent');
    expect(sent.number).toBeTruthy();
    expect(
      await refused(
        as(estimator, 'contractor.estimate.save', { estimateId, options: [{ lines: [hours()] }] }),
      ),
    ).toBe('contractor_estimate_sent');
  });

  it('holds an estimate under the lowest margin for an owner’s or admin’s OK, as it stands', async () => {
    const job = await as(owner, 'contractor.job.open', {
      name: 'Rewire the garage',
      customerPersonId: customerId,
    });
    const options = [
      // $100 for $90 of work: a 10% margin, under the 20% the business starts with.
      {
        name: 'Good',
        lines: [hours({ quantity: 2, unitPriceCents: 50_00, unitCostCents: 45_00 })],
      },
      {
        name: 'Better',
        lines: [
          hours({ quantity: 10, unitPriceCents: 60_00, unitCostCents: 30_00 }),
          part({ unitPriceCents: 400_00, unitCostCents: 200_00 }),
        ],
      },
      { name: 'Best', lines: [part({ unitPriceCents: 2_000_00, unitCostCents: 800_00 })] },
    ];
    const saved = await as(estimator, 'contractor.estimate.save', { jobId: job.jobId, options });
    const { estimateId } = saved;
    expect(saved.check).toMatchObject({
      lowest: { name: 'Good', marginBp: 1_000 },
      minMarginBp: 2_000,
      needsOk: 'margin',
      canSend: false,
    });
    expect(saved.check.options.map((o: Any) => [o.name, o.marginBp])).toEqual([
      ['Good', 1_000],
      ['Better', 5_000],
      ['Best', 6_000],
    ]);
    const send = (u: TestUser) => refused(as(u, 'contractor.estimate.send', { estimateId }));
    expect(await send(estimator)).toBe('contractor_margin_needs_ok');
    // Whoever may OK it is held to the same step: nothing goes out unchecked by a slip.
    expect(await send(owner)).toBe('contractor_margin_needs_ok');
    expect(await refused(as(estimator, 'contractor.estimate.ok', { estimateId }))).toBe(
      'forbidden',
    );

    const ask = () => as(estimator, 'contractor.estimate.ask_ok', { estimateId });
    expect(await ask()).toEqual({ estimateId, changed: true });
    expect(await ask()).toEqual({ estimateId, changed: false });
    const waiting = await as(owner, 'contractor.estimate.list', { waitingOk: true });
    expect(waiting.estimates).toMatchObject([
      { id: estimateId, optionCount: 3, asked: { by: 'Eli Estimator' }, okStands: false },
    ]);
    expect((await as(owner, 'contractor.overview')).estimatesWaitingOk).toBe(1);

    const ok = (note?: string) => as(owner, 'contractor.estimate.ok', { estimateId, note });
    expect(await ok('Repeat customer')).toEqual({ estimateId, changed: true });
    expect(await ok()).toEqual({ estimateId, changed: false });
    const okayed = await as(estimator, 'contractor.estimate.get', { estimateId });
    expect(okayed.check).toMatchObject({
      needsOk: 'margin',
      ok: { by: 'Olive Owner', note: 'Repeat customer' },
      asked: null,
      canSend: true,
    });
    expect((await as(owner, 'contractor.estimate.list', { waitingOk: true })).estimates).toEqual(
      [],
    );
    expect(
      (await as(owner, 'contractor.estimate.list', { jobId: job.jobId })).estimates,
    ).toMatchObject([{ id: estimateId, okStands: true }]);

    // The OK was for the estimate as it stood: a save since then is a different estimate.
    const again = await as(estimator, 'contractor.estimate.save', {
      estimateId,
      baseRevision: okayed.estimate.revision,
      options,
    });
    expect(again).toMatchObject({ created: false, check: { ok: null, canSend: false } });
    expect(await send(estimator)).toBe('contractor_margin_needs_ok');
    // Someone else's save in between is kept, and this one refused.
    expect(
      await refused(
        as(estimator, 'contractor.estimate.save', {
          estimateId,
          baseRevision: okayed.estimate.revision,
          options,
        }),
      ),
    ).not.toBe('went through');

    expect(await ok()).toEqual({ estimateId, changed: true });
    expect((await as(estimator, 'contractor.estimate.send', { estimateId })).status).toBe('sent');

    // The customer picks Better: the job's price and budget are that option's (decision 5).
    await customerApproves(estimateId, 2);
    expect(await worker('contractor.estimate.fill_job', { estimateId })).toEqual({
      jobId: job.jobId,
      estimates: 1,
      materials: 1,
    });
    expect((await as(owner, 'contractor.job.get', { jobId: job.jobId })).money).toMatchObject({
      priceCents: 1_000_00,
      laborCents: 300_00,
      materialsCents: 200_00,
      otherCents: 0,
      laborHours: 10,
      totalCents: 500_00,
      profitCents: 500_00,
      marginBp: 5_000,
    });
    expect(
      (await as(member, 'contractor.estimate.list', { jobId: job.jobId })).estimates,
    ).toMatchObject([{ id: estimateId, status: 'accepted', optionCount: 3, optionName: 'Better' }]);
    // Better's material line is on the job's materials, with its cost for people who may see it (decision 9).
    const filled = await as(owner, 'contractor.material.list', { jobId: job.jobId });
    expect(filled.materials).toMatchObject([
      {
        name: '200A panel',
        unitLabel: 'each',
        needed: 1,
        state: 'to_order',
        fromEstimate: true,
        unitCostCents: 200_00,
      },
    ]);
    expect(filled.costing).toEqual({ plannedCents: 200_00, takenCents: 0, uncosted: 0 });
    expect(
      (await as(member, 'contractor.material.list', { jobId: job.jobId })).materials,
    ).toMatchObject([{ name: '200A panel', unitCostCents: null }]);
    // Once each: the worker hearing of the yes again adds nothing.
    expect(await worker('contractor.estimate.fill_job', { estimateId })).toEqual({
      jobId: job.jobId,
      estimates: 1,
      materials: 0,
    });
  });

  it('holds one whose labor or materials have no cost, and asks who a loose one is for', async () => {
    const bare = { options: [{ lines: [part({ unitCostCents: null })] }] };
    expect(await refused(as(estimator, 'contractor.estimate.save', bare))).toBe(
      'contractor_estimate_customer',
    );
    const saved = await as(estimator, 'contractor.estimate.save', {
      ...bare,
      personId: customerId,
    });
    expect(saved.check).toMatchObject({ needsOk: 'uncosted', uncosted: 1, canSend: false });
    expect(
      await refused(as(estimator, 'contractor.estimate.send', { estimateId: saved.estimateId })),
    ).toBe('contractor_margin_needs_ok');
    await as(estimator, 'contractor.estimate.ask_ok', { estimateId: saved.estimateId });
    // Costed, it has nothing left to OK, so nobody is left waiting on it.
    const costed = await as(estimator, 'contractor.estimate.save', {
      estimateId: saved.estimateId,
      options: [{ lines: [part()] }],
    });
    expect(costed.check).toMatchObject({ needsOk: null, asked: null, canSend: true });
    // Two options need names the customer can tell apart.
    expect(
      await refused(
        as(estimator, 'contractor.estimate.save', {
          personId: customerId,
          options: [{ lines: [part()] }, { lines: [hours()] }],
        }),
      ),
    ).toBe('estimate_options');
    // Not on a job, so there's nothing to fill.
    expect(
      await worker('contractor.estimate.fill_job', { estimateId: saved.estimateId }),
    ).toBeNull();
  });

  it('leaves an estimate written in Money to Money', async () => {
    const made = await core(
      estimateCreate,
      { personId: customerId, lines: [{ name: 'Outlet', quantity: 1, unitPriceCents: 150_00 }] },
      owner,
    );
    expect(
      await refused(as(owner, 'contractor.estimate.get', { estimateId: made.estimateId })),
    ).toBe('contractor_estimate_not_here');
    expect(
      await refused(as(owner, 'contractor.estimate.send', { estimateId: made.estimateId })),
    ).toBe('contractor_estimate_not_here');
  });
});

describe('crews, work orders and dispatch (the owner’s decisions 7 and 8)', () => {
  let calendarId: string;
  let subId: string;
  /** A visit on a job (or on nothing): an ordinary appointment whose record is the job. */
  async function visit(jobId: string | null, starts = '1 hour'): Promise<string> {
    const [a] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, title, starts_at, ends_at,
            custom_record_id, owner_user_id)
          values (${ws}, ${calendarId}, 1, 'Site visit', now() + ${starts}::interval,
            now() + ${starts}::interval + interval '1 hour', ${jobId}, ${owner.id})
          returning id`,
    );
    return a!.id;
  }
  const job = (name: string) =>
    as(owner, 'contractor.job.open', {
      name,
      customerPersonId: customerId,
      newPropertyAddress: `${name}, 9 Elm St`,
      trade: 'electrical',
    }).then((o) => o.jobId as string);
  const staff = (appointmentId: string) =>
    rows<{ user_id: string }>(
      admin(),
      sql`select user_id from app.appointment_staff where appointment_id = ${appointmentId} and active
          order by user_id`,
    ).then((list) => list.map((s) => s.user_id));

  beforeAll(async () => {
    const [c] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.calendars (workspace_id, name, slug)
          values (${ws}, 'Jobs', ${`jobs-${randomUUID().slice(0, 8)}`}) returning id`,
    );
    calendarId = c!.id;
    const [p] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.people (workspace_id, first_name, last_name) values (${ws}, 'Sam', 'Sparks') returning id`,
    );
    subId = p!.id;
  });

  it('keeps crews to the people who set the add-on up, in the database too', async () => {
    expect(await refused(as(member, 'contractor.crew.save', { name: 'Install crew' }))).toBe(
      'forbidden',
    );
    expect(await refused(as(owner, 'contractor.crew.save', { userIds: [member.id] }))).toBe(
      'contractor_crew_name_needed',
    );
    const made = await as(owner, 'contractor.crew.save', {
      name: 'Install crew',
      userIds: [member.id],
      subPersonIds: [subId],
    });
    expect(made).toMatchObject({ name: 'Install crew', created: true });
    expect(await refused(as(owner, 'contractor.crew.save', { name: ' install CREW ' }))).toBe(
      'contractor_crew_name_taken',
    );
    // Everyone who uses the add-on sees them.
    const seen = await as(member, 'contractor.crew.list');
    expect(seen.crews).toEqual([
      expect.objectContaining({
        id: made.crewId,
        name: 'Install crew',
        archived: false,
        people: [expect.objectContaining({ userId: member.id })],
        subs: [expect.objectContaining({ personId: subId, name: 'Sam Sparks', canText: false })],
      }),
    ]);
    // Row security, not only the command: a member writes none.
    await expect(
      asUser(api(), member.claims, (tx) =>
        rows(
          tx,
          sql`insert into addon_contractor.crews (workspace_id, name) values (${ws}, 'Sneaked in')`,
        ),
      ),
    ).rejects.toThrow();
    // Archived, it's out of the list and its name is free again; brought back, it's there.
    await as(owner, 'contractor.crew.archive', { crewId: made.crewId });
    expect((await as(owner, 'contractor.crew.list')).crews).toEqual([]);
    expect((await as(owner, 'contractor.crew.list', { includeArchived: true })).crews).toEqual([
      expect.objectContaining({ id: made.crewId, archived: true }),
    ]);
    await as(owner, 'contractor.crew.archive', { crewId: made.crewId, archived: false });
    expect((await as(owner, 'contractor.crew.list')).crews).toHaveLength(1);
  });

  it('starts a visit’s work order with its trade’s checklist, once', async () => {
    const jobId = await job('Rewire the garage');
    const appointmentId = await visit(jobId);
    const started = await worker('contractor.work_order.start', { appointmentId });
    expect(started).toMatchObject({
      jobId,
      started: true,
      items: STARTER_CHECKLISTS.electrical.length,
    });
    expect(await worker('contractor.work_order.start', { appointmentId })).toMatchObject({
      started: false,
    });
    const order = await as(member, 'contractor.work_order.get', { appointmentId });
    expect(order).toMatchObject({
      started: true,
      visit: { title: 'Site visit', stage: 'scheduled' },
      job: { id: jobId, name: 'Rewire the garage', customer: { personId: customerId } },
      crew: null,
      subs: [],
    });
    expect(order.items.map((i: Any) => [i.label, i.kind, i.required])).toEqual(
      STARTER_CHECKLISTS.electrical.map((i) => [i.label, i.kind, i.required]),
    );
    const requiredLeft = STARTER_CHECKLISTS.electrical.filter((i) => i.required).length;
    expect(order.progress).toEqual({
      total: STARTER_CHECKLISTS.electrical.length,
      done: 0,
      requiredLeft,
    });
    // The job's page reads the same.
    const page = await as(member, 'contractor.job.get', { jobId });
    expect(page.visits).toEqual([
      expect.objectContaining({
        appointmentId,
        stage: 'scheduled',
        crew: null,
        checklist: { total: STARTER_CHECKLISTS.electrical.length, done: 0, requiredLeft },
      }),
    ]);
    // A visit that isn't on a job has none: the worker moves on, and a person is told.
    const loose = await visit(null);
    expect(await worker('contractor.work_order.start', { appointmentId: loose })).toBeNull();
    expect(await worker('contractor.work_order.start', { appointmentId: randomUUID() })).toBeNull();
    expect(await refused(as(owner, 'contractor.work_order.start', { appointmentId: loose }))).toBe(
      'contractor_visit_not_on_job',
    );
    expect(await refused(as(owner, 'contractor.work_order.get', { appointmentId: loose }))).toBe(
      'not_found',
    );
  });

  it('keeps a work order’s instructions and checklist, and a photo item wants a photo', async () => {
    const jobId = await job('Swap the meter base');
    const appointmentId = await visit(jobId);
    // A change starts the work order when it has none yet.
    await as(member, 'contractor.work_order.update', {
      appointmentId,
      instructions: 'Park on the street.',
      bring: 'A 200A meter base',
    });
    const box = await as(member, 'contractor.work_order.item_add', {
      appointmentId,
      label: 'Torque the lugs',
      required: true,
    });
    const photo = await as(member, 'contractor.work_order.item_add', {
      appointmentId,
      label: 'Photo of the meter base',
      kind: 'photo',
      required: true,
    });
    expect(
      await as(member, 'contractor.work_order.item_set', { itemId: box.itemId, done: true }),
    ).toMatchObject({ done: true, jobId });
    // A photo item is done with a picture among the job's files, and nothing else.
    expect(
      await refused(
        as(member, 'contractor.work_order.item_set', { itemId: photo.itemId, done: true }),
      ),
    ).toBe('contractor_photo_needed');
    const file = (name: string, mime: string, record = jobId) =>
      rows<{ id: string }>(
        admin(),
        sql`insert into app.files (workspace_id, record_type, record_id, object_path, name, mime_type, status,
              created_by)
            values (${ws}, 'custom_record', ${record}, ${`${ws}/${randomUUID()}`}, ${name}, ${mime}, 'ready',
              ${owner.id})
            returning id`,
      ).then((f) => f[0]!.id);
    const set = (fileId: string) =>
      as(member, 'contractor.work_order.item_set', { itemId: photo.itemId, done: true, fileId });
    expect(await refused(set(await file('Permit.pdf', 'application/pdf')))).toBe(
      'contractor_not_a_photo',
    );
    const elsewhere = await job('Another job');
    expect(await refused(set(await file('Meter.jpg', 'image/jpeg', elsewhere)))).toBe(
      'contractor_photo_not_on_job',
    );
    const picture = await file('Meter.jpg', 'image/jpeg');
    expect(await set(picture)).toMatchObject({ done: true, requiredLeft: expect.any(Number) });
    const order = await as(member, 'contractor.work_order.get', { appointmentId });
    expect(order).toMatchObject({
      instructions: 'Park on the street.',
      bring: 'A 200A meter base',
    });
    expect(order.items.find((i: Any) => i.id === photo.itemId)).toMatchObject({
      done: true,
      file: { id: picture, name: 'Meter.jpg' },
    });
    // Made optional, unticked and removed.
    await as(member, 'contractor.work_order.item_update', { itemId: box.itemId, required: false });
    await as(member, 'contractor.work_order.item_set', { itemId: box.itemId, done: false });
    await as(member, 'contractor.work_order.item_remove', { itemId: box.itemId });
    const after = await as(member, 'contractor.work_order.get', { appointmentId });
    expect(after.items.some((i: Any) => i.id === box.itemId)).toBe(false);
    expect(
      await refused(
        as(member, 'contractor.work_order.item_set', { itemId: box.itemId, done: true }),
      ),
    ).toBe('not_found');
  });

  it('books a crew’s people on the visit and brings its subcontractors', async () => {
    const jobId = await job('Service upgrade');
    const appointmentId = await visit(jobId, '2 days');
    const [crew] = (await as(owner, 'contractor.crew.list')).crews;
    const out = await as(owner, 'contractor.work_order.set_crew', {
      appointmentId,
      crewId: crew.id,
      acknowledgeWarnings: true,
    });
    expect(out).toMatchObject({ crewId: crew.id, userIds: [member.id], subsAdded: 1 });
    // Core's own list of who's going.
    expect(await staff(appointmentId)).toEqual([member.id]);
    const order = await as(member, 'contractor.work_order.get', { appointmentId });
    expect(order).toMatchObject({
      crew: { id: crew.id, name: 'Install crew' },
      people: [expect.objectContaining({ userId: member.id })],
      subs: [expect.objectContaining({ personId: subId, done: false, toldAt: null })],
    });
    // Put on again, nobody is added twice.
    expect(
      await as(owner, 'contractor.work_order.set_crew', {
        appointmentId,
        crewId: crew.id,
        acknowledgeWarnings: true,
      }),
    ).toMatchObject({ subsAdded: 0 });
    // The crew's name comes off; the people stay.
    await as(owner, 'contractor.work_order.set_crew', { appointmentId, crewId: null });
    expect(await staff(appointmentId)).toEqual([member.id]);
    expect((await as(member, 'contractor.work_order.get', { appointmentId })).crew).toBeNull();

    // A subcontractor doesn't sign in: the office marks their work, and a text needs a mobile number.
    const told = await as(owner, 'contractor.work_order.tell_subs', {
      appointmentId,
      acknowledgeQuietHours: true,
    });
    expect(told.told).toEqual([]);
    expect(told.notTold).toEqual([
      expect.objectContaining({ personId: subId, name: 'Sam Sparks' }),
    ]);
    expect(told.notTold[0].why).toContain('mobile');
    await as(owner, 'contractor.work_order.sub_set', {
      appointmentId,
      personId: subId,
      done: true,
    });
    expect((await as(member, 'contractor.work_order.get', { appointmentId })).subs).toEqual([
      expect.objectContaining({ personId: subId, done: true }),
    ]);
    await as(owner, 'contractor.work_order.sub_remove', { appointmentId, personId: subId });
    expect(await refused(as(owner, 'contractor.work_order.tell_subs', { appointmentId }))).toBe(
      'contractor_no_subs',
    );
    expect(
      await refused(
        as(owner, 'contractor.work_order.sub_set', { appointmentId, personId: subId, done: true }),
      ),
    ).toBe('contractor_sub_not_on_visit');
  });

  it('holds Done while a required item is left, unless an owner or admin says why', async () => {
    const jobId = await job('Panel change-out');
    const appointmentId = await visit(jobId);
    const item = await as(member, 'contractor.work_order.item_add', {
      appointmentId,
      label: 'Inspection sticker on the panel',
      required: true,
    });
    const done = (who: TestUser, more: Record<string, unknown> = {}) =>
      as(who, 'contractor.job.set_status', { jobId, status: 'done', ...more });
    // The refusal names what's left, and whether this person may pass it over.
    const error = await done(member).then(
      () => null,
      (e: Any) => e,
    );
    expect(error).toMatchObject({ rule: 'contractor_job_not_ready', status: 409 });
    // Its words name the first few; what the page lists is every one.
    expect(error.message).toContain(STARTER_CHECKLISTS.electrical.find((i) => i.required)!.label);
    expect(error.details).toMatchObject({ maySkip: false });
    expect(error.details.left.map((l: Any) => l.label)).toContain(
      'Inspection sticker on the panel',
    );
    // Only an owner or admin marks it done anyway, and only with a reason.
    expect(await refused(done(member, { skipReason: 'They said it’s fine' }))).toBe(
      'contractor_skip_not_allowed',
    );
    const asked = await done(owner).then(
      () => null,
      (e: Any) => e,
    );
    expect(asked).toMatchObject({ rule: 'contractor_job_not_ready' });
    expect(asked.details).toMatchObject({ maySkip: true });
    expect(await done(owner, { skipReason: 'Inspector comes Monday' })).toMatchObject({
      status: 'done',
      changed: true,
    });
    const order = await as(member, 'contractor.work_order.get', { appointmentId });
    for (const i of order.items.filter((x: Any) => x.required))
      expect(i.skipped).toMatchObject({ reason: 'Inspector comes Monday' });
    expect(order.progress.requiredLeft).toBe(0);
    // A done job's work orders are read-only, as the job is.
    expect(
      await refused(
        as(member, 'contractor.work_order.item_set', { itemId: item.itemId, done: true }),
      ),
    ).toBe('contractor_job_closed');
    // The reason is on the job's timeline, in words.
    const lines = await rows<{ body: string | null }>(
      admin(),
      sql`select body from app.activities where custom_record_id = ${jobId} and body is not null`,
    );
    expect(lines.map((l) => l.body)).toContain('Inspector comes Monday');
  });

  it('lets a job be Done once its required items are, and leaves a cancelled visit out', async () => {
    const jobId = await job('Add a circuit');
    const first = await visit(jobId);
    const second = await visit(jobId, '3 days');
    const a = await as(member, 'contractor.work_order.item_add', {
      appointmentId: first,
      label: 'Label the breaker',
      required: true,
    });
    await as(member, 'contractor.work_order.item_add', {
      appointmentId: second,
      label: 'Final walkthrough with the customer',
      required: true,
    });
    const done = () => as(member, 'contractor.job.set_status', { jobId, status: 'done' });
    // Everything required on the first visit is done; the second visit still holds it.
    const firstOrder = await as(member, 'contractor.work_order.get', { appointmentId: first });
    for (const i of firstOrder.items.filter((x: Any) => x.required && x.kind === 'check'))
      await as(member, 'contractor.work_order.item_set', { itemId: i.id, done: true });
    // Required photos on a starter list would need pictures: made optional here.
    for (const i of firstOrder.items.filter((x: Any) => x.required && x.kind === 'photo'))
      await as(member, 'contractor.work_order.item_update', { itemId: i.id, required: false });
    expect(a.itemId).toBeTruthy();
    expect(await refused(done())).toBe('contractor_job_not_ready');
    // The second visit is cancelled: what was left on it no longer counts.
    await rows(admin(), sql`update app.appointments set status = 'cancelled' where id = ${second}`);
    expect(await done()).toMatchObject({ status: 'done', changed: true });
  });

  it('shows a day’s visits by who’s on them, and the jobs with nothing booked', async () => {
    const waiting = await job('Needs a visit');
    const today = await job('On today');
    const mine = await visit(today, '1 minute');
    const nobody = await visit(today, '2 minutes');
    await rows(
      admin(),
      sql`insert into app.appointment_staff (workspace_id, appointment_id, user_id)
          values (${ws}, ${mine}, ${member.id})`,
    );
    const day = await as(member, 'contractor.dispatch');
    expect(day.day).toBe(day.today);
    const byId = new Map<string, Any>(day.visits.map((v: Any) => [v.appointmentId, v]));
    // Booked a minute or two from now, they're on today or, run at midnight, tomorrow: ask for the day they're on.
    const shown = byId.has(mine)
      ? day
      : await as(member, 'contractor.dispatch', {
          day: new Date(Date.parse(`${day.today}T00:00:00Z`) + 86_400_000)
            .toISOString()
            .slice(0, 10),
        });
    const visits = new Map<string, Any>(shown.visits.map((v: Any) => [v.appointmentId, v]));
    expect(visits.get(mine)).toMatchObject({
      job: { id: today, name: 'On today' },
      stage: 'scheduled',
      userIds: [member.id],
      checklist: null,
    });
    expect(visits.get(nobody)).toMatchObject({ userIds: [], subs: { total: 0, done: 0 } });
    expect(shown.people).toEqual([expect.objectContaining({ userId: member.id })]);
    const needs = shown.needsVisit.map((j: Any) => j.id);
    expect(needs).toContain(waiting);
    expect(needs).not.toContain(today);
  });
});

describe('materials (the owner’s decision 9)', () => {
  let calendarId: string;
  /** A visit on a job: an ordinary appointment whose record is the job. */
  async function visit(jobId: string, starts = '1 hour'): Promise<string> {
    const [a] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, title, starts_at, ends_at,
            custom_record_id, owner_user_id)
          values (${ws}, ${calendarId}, 1, 'Site visit', now() + ${starts}::interval,
            now() + ${starts}::interval + interval '1 hour', ${jobId}, ${owner.id})
          returning id`,
    );
    return a!.id;
  }
  const job = (name: string) =>
    as(owner, 'contractor.job.open', {
      name,
      customerPersonId: customerId,
      newPropertyAddress: `${name}, 4 Birch Rd`,
      trade: 'electrical',
    }).then((o) => o.jobId as string);
  const list = (u: TestUser, jobId: string, more: Record<string, unknown> = {}) =>
    as(u, 'contractor.material.list', { jobId, ...more });
  /** How many of a job's material costs a person can read, whatever asks. */
  const costsSeen = (u: TestUser, jobId: string) =>
    asUser(api(), u.claims, (tx) =>
      rows<{ n: number }>(
        tx,
        sql`select count(*)::int as n from addon_contractor.material_costs where record_id = ${jobId}`,
      ),
    ).then((r) => r[0]!.n);

  beforeAll(async () => {
    const [c] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.calendars (workspace_id, name, slug)
          values (${ws}, 'Materials', ${`materials-${randomUUID().slice(0, 8)}`}) returning id`,
    );
    calendarId = c!.id;
  });

  it('keeps what a job needs, and how much is ordered, delivered, used, wasted and returned', async () => {
    const jobId = await job('Kitchen circuits');
    const added = await as(member, 'contractor.material.add', {
      jobId,
      name: '12/2 wire',
      unitLabel: 'ft',
      needed: 100,
      supplier: 'Graybar',
    });
    expect(added).toMatchObject({ jobId, name: '12/2 wire' });
    const { materialId } = added;
    const set = (change: Record<string, unknown>) =>
      as(member, 'contractor.material.update', { materialId, ...change });
    expect(await list(member, jobId)).toMatchObject({
      jobId,
      missing: 1,
      canChange: true,
      costing: null,
      materials: [
        {
          id: materialId,
          name: '12/2 wire',
          unitLabel: 'ft',
          appointmentId: null,
          needed: 100,
          ordered: 0,
          delivered: 0,
          short: 100,
          left: 0,
          state: 'to_order',
          supplier: 'Graybar',
          fromEstimate: false,
          unitCostCents: null,
        },
      ],
    });
    expect(await set({ ordered: 100 })).toEqual({
      materialId,
      jobId,
      changed: true,
      state: 'ordered',
    });
    // The same again changes nothing.
    expect(await set({ ordered: 100 })).toMatchObject({ changed: false, state: 'ordered' });
    // Each count is the total so far: part of it arrived, some was used and some cut wrong.
    await set({ delivered: 60, used: 20, wasted: 5, expectedOn: '2026-12-01' });
    expect((await list(member, jobId)).materials[0]).toMatchObject({
      delivered: 60,
      used: 20,
      wasted: 5,
      short: 40,
      left: 35,
      state: 'ordered',
      expectedOn: '2026-12-01',
    });
    expect(await set({ delivered: 100, supplier: null })).toMatchObject({ state: 'here' });
    expect(await list(member, jobId)).toMatchObject({
      missing: 0,
      materials: [{ short: 0, supplier: null }],
    });
    expect(await refused(set({ used: -1 }))).not.toBe('went through');
    expect(await refused(set({ needed: 1.23456 }))).not.toBe('went through');
    // What happened is in the job's history, in amounts of the material and never of money.
    const events = await rows<{ type: string; payload: Any }>(
      admin(),
      sql`select event_type as type, payload from app.events
          where workspace_id = ${ws} and entity_id = ${jobId} and event_type like 'contractor.material.%'
          order by created_at, id`,
    );
    expect(events.map((e) => e.type)).toEqual([
      'contractor.material.added',
      'contractor.material.updated',
      'contractor.material.updated',
      'contractor.material.updated',
    ]);
    expect(JSON.stringify(events)).not.toMatch(/cents/i);

    expect(await as(member, 'contractor.material.remove', { materialId })).toEqual({
      materialId,
      jobId,
      changed: true,
      state: null,
    });
    expect((await list(member, jobId)).materials).toEqual([]);
    expect(await refused(as(member, 'contractor.material.remove', { materialId }))).toBe(
      'not_found',
    );
    expect(await refused(as(member, 'contractor.material.add', { jobId }))).toBe(
      'contractor_material_name_needed',
    );
  });

  it('keeps what a material costs with people who may see job costs, in the database too', async () => {
    const jobId = await job('Service upgrade');
    const { productId } = await executeCommand(
      api(),
      productCreate,
      {
        workspaceId: ws,
        name: '20A breaker',
        kind: 'product',
        unitPriceCents: 18_00,
        unitLabel: 'each',
      },
      human(owner),
      meta(),
    ).then((r) => r.output as Any);
    await as(owner, 'contractor.item_cost.set', { productId, costCents: 7_50, kind: 'material' });

    // Someone who may see costs picks it from the price list: its name, unit and cost come with it.
    const theirs = await as(estimator, 'contractor.material.add', { jobId, productId, needed: 4 });
    expect(theirs.name).toBe('20A breaker');
    // Someone who may not gets the same material and no cost: the worker fills it in a moment later.
    const mine = await as(member, 'contractor.material.add', { jobId, productId, needed: 2 });
    expect(
      await refused(
        as(member, 'contractor.material.add', { jobId, name: 'Wire nuts', unitCostCents: 5 }),
      ),
    ).toBe('contractor_material_cost_not_allowed');
    expect(await costsSeen(estimator, jobId)).toBe(1);
    expect(await worker('contractor.material.stamp_cost', { materialId: mine.materialId })).toEqual(
      { materialId: mine.materialId, stamped: true },
    );
    // Safe to run again, and one typed by hand has no price list item to take a cost from.
    expect(await worker('contractor.material.stamp_cost', { materialId: mine.materialId })).toEqual(
      { materialId: mine.materialId, stamped: false },
    );
    const typed = await as(member, 'contractor.material.add', {
      jobId,
      name: 'Conduit',
      needed: 3,
    });
    expect(
      await worker('contractor.material.stamp_cost', { materialId: typed.materialId }),
    ).toEqual({ materialId: typed.materialId, stamped: false });

    const withCosts = await list(estimator, jobId);
    expect(withCosts.materials.map((m: Any) => [m.name, m.needed, m.unitCostCents])).toEqual([
      ['20A breaker', 4, 7_50],
      ['20A breaker', 2, 7_50],
      ['Conduit', 3, null],
    ]);
    expect(withCosts.costing).toEqual({ plannedCents: 45_00, takenCents: 0, uncosted: 1 });
    // The job has taken what arrived and wasn't sent back.
    await as(member, 'contractor.material.update', {
      materialId: theirs.materialId,
      delivered: 4,
      returned: 1,
    });
    expect((await list(estimator, jobId)).costing).toMatchObject({ takenCents: 22_50 });

    const without = await list(member, jobId);
    expect(without.costing).toBeNull();
    expect(without.materials.every((m: Any) => m.unitCostCents === null)).toBe(true);
    expect(await costsSeen(estimator, jobId)).toBe(2);
    expect(await costsSeen(member, jobId)).toBe(0);

    const cost = (u: TestUser, unitCostCents: number | null) =>
      as(u, 'contractor.material.set_cost', { materialId: typed.materialId, unitCostCents });
    expect(await refused(cost(member, 2_00))).toBe('forbidden');
    expect(await cost(estimator, 2_00)).toEqual({
      materialId: typed.materialId,
      jobId,
      changed: true,
    });
    expect(await cost(estimator, 2_00)).toMatchObject({ changed: false });
    expect((await list(estimator, jobId)).costing).toMatchObject({
      plannedCents: 51_00,
      uncosted: 0,
    });
    expect(await cost(estimator, null)).toMatchObject({ changed: true });
    // Removing a material takes its cost with it, whoever removes it.
    await as(member, 'contractor.material.remove', { materialId: theirs.materialId });
    expect(await costsSeen(estimator, jobId)).toBe(1);
  });

  it('ties a material to a visit of its own job, and says what each visit is still missing', async () => {
    const jobId = await job('Panel upgrade');
    const other = await job('Another job');
    const first = await visit(jobId, '1 hour');
    const second = await visit(jobId, '2 days');
    const elsewhere = await visit(other, '1 hour');
    const add = (input: Record<string, unknown>) =>
      as(member, 'contractor.material.add', { jobId, ...input }).then(
        (o) => o.materialId as string,
      );
    const panel = await add({ name: '200A panel', appointmentId: first });
    await add({ name: '2/0 wire', unitLabel: 'ft', needed: 50, delivered: 50 });
    const breaker = await add({ name: '20A breaker', needed: 2, appointmentId: second });
    expect(
      await refused(
        as(member, 'contractor.material.add', { jobId, name: 'Lugs', appointmentId: elsewhere }),
      ),
    ).toBe('contractor_material_visit_elsewhere');
    expect(
      await refused(
        as(member, 'contractor.material.update', { materialId: panel, appointmentId: elsewhere }),
      ),
    ).toBe('contractor_material_visit_elsewhere');

    const missing = async () => {
      const got = await as(member, 'contractor.job.get', { jobId });
      return new Map<string, number>(
        got.visits.map((v: Any) => [v.appointmentId, v.materialsMissing]),
      );
    };
    expect((await missing()).get(first)).toBe(1);
    expect((await missing()).get(second)).toBe(1);
    // A visit's work order has what it needs: its own, and what's for any visit. Never a cost.
    const order = await as(owner, 'contractor.work_order.get', { appointmentId: first });
    expect(order.materials.map((m: Any) => [m.name, m.short])).toEqual([
      ['200A panel', 1],
      ['2/0 wire', 0],
    ]);
    expect(order.materials[0]).not.toHaveProperty('unitCostCents');
    expect(
      (await list(member, jobId, { appointmentId: second })).materials.map((m: Any) => m.name),
    ).toEqual(['2/0 wire', '20A breaker']);

    await as(member, 'contractor.material.update', { materialId: panel, delivered: 1 });
    expect((await missing()).get(first)).toBe(0);
    // Moved to any visit, the breakers are missing on both.
    await as(member, 'contractor.material.update', { materialId: breaker, appointmentId: null });
    expect([...(await missing()).values()].sort()).toEqual([1, 1]);
  });

  it('leaves a closed job’s materials as they are', async () => {
    const jobId = await job('All done');
    const { materialId } = await as(member, 'contractor.material.add', { jobId, name: 'Outlet' });
    await as(owner, 'contractor.job.set_status', { jobId, status: 'done' });
    expect(await list(member, jobId)).toMatchObject({ canChange: false, missing: 1 });
    expect(
      await refused(as(member, 'contractor.material.add', { jobId, name: 'Cover plate' })),
    ).toBe('contractor_job_closed');
    expect(
      await refused(as(member, 'contractor.material.update', { materialId, delivered: 1 })),
    ).toBe('contractor_job_closed');
    expect(await refused(as(member, 'contractor.material.remove', { materialId }))).toBe(
      'contractor_job_closed',
    );
    expect(
      await refused(
        as(estimator, 'contractor.material.set_cost', { materialId, unitCostCents: 1 }),
      ),
    ).toBe('contractor_job_closed');
  });
});

describe('time and job costing (the owner’s decisions 10 and 11)', () => {
  let calendarId: string;
  /** A visit on a job, some days out: nobody's two visits ever overlap. */
  async function visit(jobId: string, daysOut: number): Promise<string> {
    const [a] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, title, starts_at, ends_at,
            custom_record_id, owner_user_id)
          values (${ws}, ${calendarId}, 1, 'Site visit', now() + make_interval(days => ${daysOut}),
            now() + make_interval(days => ${daysOut}, hours => 1), ${jobId}, ${owner.id})
          returning id`,
    );
    return a!.id;
  }
  /** Puts people on a visit, as booking them does. */
  async function onVisit(appointmentId: string, ...people: TestUser[]): Promise<void> {
    for (const p of people)
      await rows(
        admin(),
        sql`insert into app.appointment_staff (workspace_id, appointment_id, user_id)
            values (${ws}, ${appointmentId}, ${p.id})`,
      );
  }
  const job = (name: string) =>
    as(owner, 'contractor.job.open', {
      name,
      customerPersonId: customerId,
      newPropertyAddress: `${name}, 6 Cedar Ct`,
      trade: 'electrical',
    }).then((o) => o.jobId as string);
  /**
   * A clock for one test: moments so many minutes before now (to the second), some days back, so each test's
   * time is on a day of its own and the sums come out exact.
   */
  const clock = (daysBack = 0) => {
    const base = Math.floor(Date.now() / 1000) * 1000 - daysBack * 86_400_000;
    return (minutesAgo: number) => new Date(base - minutesAgo * 60_000).toISOString();
  };
  /** The worker passing on a visit's button, pressed at a moment, by someone or by nobody. */
  const press = (appointmentId: string, status: string, at: string, by?: TestUser) =>
    worker('contractor.time.follow_status', {
      appointmentId,
      status,
      at,
      byUserId: by?.id ?? null,
    });
  const time = (u: TestUser, jobId: string, more: Record<string, unknown> = {}) =>
    as(u, 'contractor.time.list', { jobId, ...more });
  const costing = (jobId: string) => as(estimator, 'contractor.job.costing', { jobId });
  /** How many rows of one of part 5's tables a person can read, whatever asks. */
  const seen = (
    u: TestUser,
    table: 'time_entries' | 'time_costs' | 'labor_rates' | 'other_costs',
  ) =>
    asUser(api(), u.claims, (tx) =>
      rows<{ n: number }>(
        tx,
        sql`select count(*)::int as n from ${sql.raw(`addon_contractor.${table}`)}`,
      ),
    ).then((r) => r[0]!.n);

  beforeAll(async () => {
    const [c] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.calendars (workspace_id, name, slug)
          values (${ws}, 'Time', ${`time-${randomUUID().slice(0, 8)}`}) returning id`,
    );
    calendarId = c!.id;
  });

  it('starts and stops everyone’s time from the visit’s buttons, safely twice and for old news', async () => {
    const jobId = await job('Panel swap');
    const v = await visit(jobId, 20);
    await onVisit(v, member, estimator);
    const t = clock();

    // On the way: travel time for everyone on the visit, from the moment it was pressed.
    expect(await press(v, 'on_the_way', t(180))).toEqual({
      jobId,
      appointmentId: v,
      started: 2,
      stopped: 0,
    });
    // The same news again changes nothing.
    expect(await press(v, 'on_the_way', t(180))).toMatchObject({ started: 0, stopped: 0 });
    // Started: travel stops and work starts.
    expect(await press(v, 'in_progress', t(150))).toMatchObject({ started: 2, stopped: 2 });
    // News that arrives late, from before what's already known, changes nothing either.
    expect(await press(v, 'on_the_way', t(170))).toMatchObject({ started: 0, stopped: 0 });

    let list = await time(member, jobId);
    expect(list.totals).toMatchObject({ travelSeconds: 2 * 30 * 60, running: 2 });
    expect(list.mine).toMatchObject({ appointmentId: v, kind: 'work' });
    // A tech sees the hours, and can't fix them.
    expect(list.may.fix).toBe(false);

    // A break pauses one person's work. Taking it twice is taking it once.
    expect(
      await as(member, 'contractor.time.set_break', { appointmentId: v, onBreak: true }),
    ).toMatchObject({ jobId, userId: member.id, onBreak: true, changed: true });
    expect(
      await as(member, 'contractor.time.set_break', { appointmentId: v, onBreak: true }),
    ).toMatchObject({ changed: false });
    list = await time(member, jobId, { appointmentId: v });
    expect(list.mine).toMatchObject({ kind: 'break' });
    expect(list.totals.running).toBe(2);
    // Someone else's break takes “Fix time on jobs”.
    expect(
      await refused(
        as(member, 'contractor.time.set_break', {
          appointmentId: v,
          onBreak: true,
          userId: estimator.id,
        }),
      ),
    ).toBe('contractor_time_someone_else');
    expect(
      await as(owner, 'contractor.time.set_break', {
        appointmentId: v,
        onBreak: true,
        userId: estimator.id,
      }),
    ).toMatchObject({ name: 'Eli Estimator', onBreak: true, changed: true });
    await as(owner, 'contractor.time.set_break', {
      appointmentId: v,
      onBreak: false,
      userId: estimator.id,
    });
    expect(
      await as(member, 'contractor.time.set_break', { appointmentId: v, onBreak: false }),
    ).toMatchObject({ onBreak: false, changed: true });
    // The owner isn't on the clock here: no break to take, and none to come back from.
    expect(
      await refused(as(owner, 'contractor.time.set_break', { appointmentId: v, onBreak: true })),
    ).toBe('contractor_time_not_working');
    expect(
      await refused(as(owner, 'contractor.time.set_break', { appointmentId: v, onBreak: false })),
    ).toBe('contractor_time_not_on_break');

    // Done stops everything.
    expect(await press(v, 'done', new Date().toISOString())).toMatchObject({
      started: 0,
      stopped: 2,
    });
    list = await time(owner, jobId);
    expect(list.totals.running).toBe(0);
    expect(list.mine).toBeNull();
    expect(list.may.fix).toBe(true);
    // Each of the two: travel, work, a break, work again.
    expect(list.entries).toHaveLength(8);
    expect(list.entries.filter((e: Any) => e.kind === 'break')).toHaveLength(2);
    expect(list.entries.every((e: Any) => e.endedAt !== null)).toBe(true);
    expect(new Set(list.entries.map((e: Any) => e.name))).toEqual(
      new Set(['Eli Estimator', member.fullName]),
    );
    // The time never says what it cost, and neither does its news.
    expect(JSON.stringify(list)).not.toMatch(/cents/i);
    const events = await rows<{ type: string; payload: Any }>(
      admin(),
      sql`select event_type as type, payload from app.events
          where workspace_id = ${ws} and entity_id = ${jobId} and event_type like 'contractor.time.%'
          order by created_at, id`,
    );
    expect(events.map((e) => e.type)).toEqual([
      'contractor.time.tracked',
      'contractor.time.tracked',
      'contractor.time.break_set',
      'contractor.time.break_set',
      'contractor.time.break_set',
      'contractor.time.break_set',
      'contractor.time.tracked',
    ]);
    expect(JSON.stringify(events)).not.toMatch(/cents/i);
  });

  it('gives the time to whoever pressed the button when nobody is on the visit, one clock each', async () => {
    const first = await job('Leak check');
    const second = await job('Second stop');
    const a = await visit(first, 21);
    const b = await visit(second, 22);
    const t = clock(2);

    // Nobody is on the visit and nobody pressed it: there's no one to track.
    expect(await press(a, 'in_progress', t(120))).toMatchObject({ started: 0, stopped: 0 });
    expect(await press(a, 'in_progress', t(110), member)).toMatchObject({
      started: 1,
      stopped: 0,
    });
    // Nobody is in two places: starting on another visit stops their time on the first.
    expect(await press(b, 'on_the_way', t(50), member)).toMatchObject({ started: 1 });
    expect((await time(owner, first)).totals).toMatchObject({ workSeconds: 3600, running: 0 });
    // A cancelled visit stops its time.
    expect(await press(b, 'cancelled', t(20))).toMatchObject({ started: 0, stopped: 1 });
    expect((await time(owner, second)).totals).toMatchObject({
      travelSeconds: 1800,
      workSeconds: 0,
      paidSeconds: 1800,
      running: 0,
    });
    // Someone who isn't on the team gets no time, and a visit that isn't on a job is none of its business.
    expect(
      await worker('contractor.time.follow_status', {
        appointmentId: a,
        status: 'in_progress',
        at: t(10),
        byUserId: randomUUID(),
      }),
    ).toMatchObject({ started: 0, stopped: 0 });
    expect(
      await worker('contractor.time.follow_status', {
        appointmentId: randomUUID(),
        status: 'in_progress',
        at: t(5),
      }),
    ).toBeNull();
  });

  it('lets only people who may fix time change, add or remove it, with a reason that’s kept', async () => {
    const jobId = await job('Rewire');
    const v = await visit(jobId, 23);
    const t = clock(3);
    await press(v, 'in_progress', t(240), member);
    await press(v, 'done', t(120), member);
    const [entry] = (await time(owner, jobId)).entries;
    expect(entry).toMatchObject({
      userId: member.id,
      appointmentId: v,
      kind: 'work',
      seconds: 7200,
      source: 'status',
      autoStopped: false,
      fixed: null,
    });

    // A tech can't, and neither can someone who only sees job costs.
    const tries: [string, Record<string, unknown>][] = [
      ['contractor.time.fix', { entryId: entry.id, endedAt: t(60), reason: 'Stayed late' }],
      [
        'contractor.time.add',
        { jobId, userId: member.id, startedAt: t(60), endedAt: t(30), reason: 'Forgot' },
      ],
      ['contractor.time.remove', { entryId: entry.id, reason: 'Wrong job' }],
    ];
    for (const who of [member, estimator])
      for (const [name, input] of tries)
        expect(await refused(as(who, name, input))).toBe('forbidden');

    // An owner fixes it: it ran an hour longer. Who, when and why stay on it.
    expect(
      await as(owner, 'contractor.time.fix', {
        entryId: entry.id,
        endedAt: t(60),
        reason: 'Stayed to clean up',
      }),
    ).toMatchObject({ entryId: entry.id, jobId, name: member.fullName, changed: true });
    expect((await time(member, jobId)).entries[0]).toMatchObject({
      seconds: 3 * 3600,
      fixed: { by: 'Olive Owner', reason: 'Stayed to clean up' },
    });
    // A reason is needed.
    expect(
      await refused(
        as(owner, 'contractor.time.fix', { entryId: entry.id, endedAt: t(90), reason: ' ' }),
      ),
    ).not.toBe('went through');

    // What can't be: it ends before it starts, runs over a day, or hasn't happened yet.
    expect(
      await refused(
        as(owner, 'contractor.time.fix', { entryId: entry.id, endedAt: t(300), reason: 'Typo' }),
      ),
    ).toBe('contractor_time_ends_first');
    expect(
      await refused(
        as(owner, 'contractor.time.fix', {
          entryId: entry.id,
          startedAt: t(240 + 24 * 60),
          reason: 'Typo',
        }),
      ),
    ).toBe('contractor_time_too_long');
    expect(
      await refused(
        as(owner, 'contractor.time.add', {
          jobId,
          userId: member.id,
          startedAt: new Date(Date.now() - 600_000).toISOString(),
          endedAt: new Date(Date.now() + 600_000).toISOString(),
          reason: 'Later today',
        }),
      ),
    ).toBe('contractor_time_in_future');

    // Time the buttons didn't track is added, on one of the job's own visits.
    const added = await as(owner, 'contractor.time.add', {
      jobId,
      appointmentId: v,
      userId: member.id,
      kind: 'travel',
      startedAt: t(270),
      endedAt: t(240),
      reason: 'Drove from the shop',
    });
    expect(added).toMatchObject({ jobId, name: member.fullName, changed: true });
    expect((await time(owner, jobId)).totals).toMatchObject({
      workSeconds: 3 * 3600,
      travelSeconds: 1800,
      paidSeconds: 3 * 3600 + 1800,
    });
    // Never over the same person's other time, on a visit of another job, or for someone who isn't on the team.
    expect(
      await refused(
        as(owner, 'contractor.time.add', {
          jobId,
          userId: member.id,
          startedAt: t(250),
          endedAt: t(200),
          reason: 'Twice',
        }),
      ),
    ).toBe('contractor_time_overlaps');
    const elsewhere = await visit(await job('Elsewhere'), 24);
    expect(
      await refused(
        as(owner, 'contractor.time.add', {
          jobId,
          appointmentId: elsewhere,
          userId: member.id,
          startedAt: t(30),
          endedAt: t(20),
          reason: 'Wrong visit',
        }),
      ),
    ).toBe('contractor_time_visit_elsewhere');
    expect(
      await refused(
        as(owner, 'contractor.time.add', {
          jobId,
          userId: randomUUID(),
          startedAt: t(30),
          endedAt: t(20),
          reason: 'Nobody',
        }),
      ),
    ).toBe('contractor_not_on_team');

    // Time still running needs an end to be fixed; with one, it stops there.
    await press(v, 'in_progress', t(50), estimator);
    const running = (await time(owner, jobId)).entries.find((e: Any) => e.endedAt === null);
    expect(running).toMatchObject({ userId: estimator.id, kind: 'work' });
    expect(
      await refused(
        as(owner, 'contractor.time.fix', { entryId: running.id, kind: 'travel', reason: 'Drive' }),
      ),
    ).toBe('contractor_time_still_running');
    await as(owner, 'contractor.time.fix', {
      entryId: running.id,
      endedAt: t(20),
      kind: 'travel',
      reason: 'He was driving back',
    });

    // Removed, it's off the job's hours, and gone.
    expect(
      await as(owner, 'contractor.time.remove', {
        entryId: added.entryId,
        reason: 'He rode with Eli',
      }),
    ).toMatchObject({ entryId: added.entryId, jobId, changed: true });
    expect(
      await refused(
        as(owner, 'contractor.time.remove', { entryId: added.entryId, reason: 'Again' }),
      ),
    ).toBe('not_found');
    const list = await time(owner, jobId);
    expect(list.entries).toHaveLength(2);
    expect(list.totals).toMatchObject({
      workSeconds: 3 * 3600,
      travelSeconds: 1800,
      breakSeconds: 0,
      running: 0,
    });
    // Each reason is on the job's timeline, in words.
    const lines = await rows<{ body: string | null }>(
      admin(),
      sql`select body from app.activities where custom_record_id = ${jobId} and body is not null`,
    );
    expect(lines.map((l) => l.body)).toEqual(
      expect.arrayContaining([
        'Stayed to clean up',
        'Drove from the shop',
        'He was driving back',
        'He rode with Eli',
      ]),
    );
  });

  it('turns hours into labor cost at what each hour cost then, seen only by people who may see job costs', async () => {
    // Nobody has a cost per hour and Estimating has no labor cost: time has no cost yet.
    await as(owner, 'contractor.estimating.save', { laborCostCents: 0 });
    await as(owner, 'contractor.labor_rate.set', { userId: member.id, costCents: null });
    const rates = await as(estimator, 'contractor.labor_rate.list');
    expect(rates).toMatchObject({ fallbackCents: 0, canChange: false });
    expect(rates.people.find((p: Any) => p.userId === member.id)).toMatchObject({
      name: member.fullName,
      costCents: null,
    });
    // Seeing costs isn't setting them, and a tech does neither.
    expect(
      await refused(
        as(estimator, 'contractor.labor_rate.set', { userId: member.id, costCents: 40_00 }),
      ),
    ).toBe('forbidden');
    expect(await refused(as(member, 'contractor.labor_rate.list'))).toBe('forbidden');

    const jobId = await job('Meter base');
    const v = await visit(jobId, 25);
    await onVisit(v, member, estimator);
    const t = clock(4);
    await press(v, 'in_progress', t(300));
    await press(v, 'done', t(180));
    let c = await costing(jobId);
    expect(c.hours.actual).toBe(4);
    expect(c.labor.actualCents).toBe(0);
    expect(c.uncostedHours).toBe(4);

    // An owner says what an hour of one of them costs. Their time that had no cost gets it; saying it twice is once.
    expect(
      await as(owner, 'contractor.labor_rate.set', { userId: member.id, costCents: 40_00 }),
    ).toMatchObject({ userId: member.id, name: member.fullName, changed: true });
    expect(
      await as(owner, 'contractor.labor_rate.set', { userId: member.id, costCents: 40_00 }),
    ).toMatchObject({ changed: false });
    expect(
      (await worker('contractor.time.stamp_costs', { userId: member.id })).stamped,
    ).toBeGreaterThanOrEqual(1);
    expect(await worker('contractor.time.stamp_costs', { userId: member.id })).toEqual({
      stamped: 0,
    });
    c = await costing(jobId);
    expect(c.labor.actualCents).toBe(2 * 40_00);
    expect(c.uncostedHours).toBe(2);
    expect(c.people).toHaveLength(2);
    expect(c.people).toEqual(
      expect.arrayContaining([
        { userId: member.id, name: member.fullName, hours: 2, costCents: 80_00 },
        { userId: estimator.id, name: 'Eli Estimator', hours: 2, costCents: 0 },
      ]),
    );

    // Estimating's labor cost counts for anyone with no cost of their own.
    await as(owner, 'contractor.estimating.save', { laborCostCents: 30_00 });
    expect((await as(owner, 'contractor.labor_rate.list')).fallbackCents).toBe(30_00);
    await worker('contractor.time.stamp_costs', {});
    c = await costing(jobId);
    expect(c.labor.actualCents).toBe(2 * 40_00 + 2 * 30_00);
    expect(c.uncostedHours).toBe(0);

    // A raise later never changes what past time cost. New time costs the new amount, from when it's tracked.
    await as(owner, 'contractor.labor_rate.set', { userId: member.id, costCents: 55_00 });
    await worker('contractor.time.stamp_costs', { userId: member.id });
    expect((await costing(jobId)).labor.actualCents).toBe(140_00);
    await press(v, 'in_progress', t(120));
    await press(v, 'done', t(60));
    c = await costing(jobId);
    expect(c.hours.actual).toBe(6);
    expect(c.labor.actualCents).toBe(140_00 + 55_00 + 30_00);

    // Row security, not only the commands: the hours are everyone's, what they cost isn't.
    expect(await seen(member, 'time_entries')).toBeGreaterThan(0);
    for (const table of ['time_costs', 'labor_rates'] as const) {
      expect(await seen(owner, table)).toBeGreaterThan(0);
      expect(await seen(estimator, table)).toBeGreaterThan(0);
      expect(await seen(member, table)).toBe(0);
    }
    // Seeing what an hour costs isn't setting it, whatever asks.
    await asUser(api(), estimator.claims, (tx) =>
      rows(
        tx,
        sql`update addon_contractor.labor_rates set cost_cents = 1 where user_id = ${member.id}`,
      ),
    ).catch(() => undefined);
    const kept = (await as(owner, 'contractor.labor_rate.list')).people;
    expect(kept.find((p: Any) => p.userId === member.id)).toMatchObject({ costCents: 55_00 });
    expect(await refused(as(member, 'contractor.job.costing', { jobId }))).toBe('forbidden');
    expect(await refused(as(member, 'contractor.profit'))).toBe('forbidden');
    expect(JSON.stringify(await time(member, jobId))).not.toMatch(/cents/i);
    // What an hour costs stays off the news of it.
    const events = await rows<{ payload: Any }>(
      admin(),
      sql`select payload from app.events
          where workspace_id = ${ws} and event_type = 'contractor.labor_rate.set' and entity_id = ${member.id}`,
    );
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.every((e) => e.payload.userId === member.id)).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/cents|cost/i);
  });

  it('says what a job has cost against its plan and where it’s heading, and what the jobs made', async () => {
    await as(owner, 'contractor.labor_rate.set', { userId: member.id, costCents: 50_00 });
    const jobId = await job('Kitchen circuits');
    const v = await visit(jobId, 26);
    await as(owner, 'contractor.job.set_money', {
      jobId,
      priceCents: 1_000_00,
      laborCents: 200_00,
      materialsCents: 100_00,
      laborHours: 5,
    });
    const t = clock(5);
    // Two hours of work at $50 an hour.
    await press(v, 'in_progress', t(240), member);
    await press(v, 'done', t(120), member);
    // Ten feet of wire at $3 a foot, six of them here so far.
    await as(owner, 'contractor.material.add', {
      jobId,
      name: '12/2 wire',
      unitLabel: 'ft',
      needed: 10,
      delivered: 6,
      unitCostCents: 3_00,
    });
    // And a permit. A tech doesn't add costs.
    const permit = await as(estimator, 'contractor.other_cost.add', {
      jobId,
      name: 'Permit',
      amountCents: 25_00,
    });
    expect(permit).toMatchObject({ jobId, name: 'Permit' });
    expect(await seen(estimator, 'other_costs')).toBeGreaterThan(0);
    expect(await seen(member, 'other_costs')).toBe(0);
    expect(
      await refused(
        as(member, 'contractor.other_cost.add', { jobId, name: 'Lunch', amountCents: 1 }),
      ),
    ).toBe('forbidden');
    await as(member, 'contractor.job.set_percent', { jobId, percentDone: 50 });

    // Half done with 2 of its 5 hours spent, labor heads for its plan; the permit nobody planned puts it over.
    const c = await costing(jobId);
    expect(c).toMatchObject({
      jobId,
      name: 'Kitchen circuits',
      percentDone: 50,
      finished: false,
      labor: { budgetCents: 200_00, actualCents: 100_00, headingCents: 200_00 },
      materials: { budgetCents: 100_00, actualCents: 18_00, headingCents: 100_00 },
      other: { budgetCents: null, actualCents: 25_00, headingCents: 25_00 },
      total: { budgetCents: 300_00, actualCents: 143_00, headingCents: 325_00 },
      hours: { budget: 5, actual: 2, heading: 4 },
      priceCents: 1_000_00,
      profit: {
        plannedCents: 700_00,
        plannedMarginBp: 7000,
        soFarCents: 857_00,
        headingCents: 675_00,
        headingMarginBp: 6750,
      },
      overCents: 25_00,
      uncostedHours: 0,
      uncostedMaterials: 0,
      underMargin: false,
    });
    expect(c.people).toEqual([
      { userId: member.id, name: member.fullName, hours: 2, costCents: 100_00 },
    ]);
    expect(c.otherCosts).toEqual([
      expect.objectContaining({
        id: permit.costId,
        name: 'Permit',
        amountCents: 25_00,
        note: null,
      }),
    ]);

    // Open jobs count at what they're heading for.
    const open = await as(estimator, 'contractor.profit', { period: 'open' });
    expect(open).toMatchObject({
      period: 'open',
      by: 'job',
      from: null,
      to: null,
      truncated: false,
    });
    const row = (p: Any, key: string) => p.rows.find((r: Any) => r.key === key);
    expect(row(open, jobId)).toEqual({
      key: jobId,
      name: 'Kitchen circuits',
      jobs: 1,
      priceCents: 1_000_00,
      costCents: 325_00,
      profitCents: 675_00,
      marginBp: 6750,
      laborHours: 4,
    });
    expect(row(await as(estimator, 'contractor.profit'), jobId)).toBeUndefined();

    // Done, it cost what it cost, and it's among the jobs done this month.
    await as(owner, 'contractor.job.set_status', { jobId, status: 'done' });
    expect(await costing(jobId)).toMatchObject({
      finished: true,
      total: { budgetCents: 300_00, actualCents: 143_00, headingCents: 143_00 },
      hours: { actual: 2, heading: 2 },
      profit: { headingCents: 857_00, headingMarginBp: 8570 },
      overCents: 0,
    });
    const month = await as(estimator, 'contractor.profit');
    expect(month).toMatchObject({ period: 'month', by: 'job', truncated: false });
    expect(month.from <= month.to).toBe(true);
    expect(row(month, jobId)).toEqual({
      key: jobId,
      name: 'Kitchen circuits',
      jobs: 1,
      priceCents: 1_000_00,
      costCents: 143_00,
      profitCents: 857_00,
      marginBp: 8570,
      laborHours: 2,
    });
    expect(
      row(await as(estimator, 'contractor.profit', { period: 'open' }), jobId),
    ).toBeUndefined();
    expect(row(await as(estimator, 'contractor.profit', { period: 'year' }), jobId)).toBeDefined();
    expect(row(await as(estimator, 'contractor.profit', { period: 'all' }), jobId)).toBeDefined();
    const last = await as(estimator, 'contractor.profit', { period: 'last_month' });
    expect(row(last, jobId)).toBeUndefined();
    expect(last.to < month.from).toBe(true);

    // Split by customer, crew or service, every job counts once: the rows add up to the same total.
    for (const by of ['customer', 'crew', 'trade'] as const) {
      const split = await as(estimator, 'contractor.profit', { by });
      expect(split.total).toEqual(month.total);
      for (const k of ['jobs', 'priceCents', 'costCents', 'profitCents'] as const)
        expect(split.rows.reduce((n: number, r: Any) => n + r[k], 0)).toBe(month.total[k]);
      if (by === 'customer') expect(row(split, customerId)).toMatchObject({ name: 'Dana Reyes' });
      if (by === 'trade') expect(row(split, 'electrical')).toMatchObject({ name: 'Electrical' });
    }

    // A cost comes off a finished job too: that's when the numbers get checked. Gone is gone.
    expect(await as(estimator, 'contractor.other_cost.remove', { costId: permit.costId })).toEqual({
      costId: permit.costId,
      jobId,
      name: 'Permit',
    });
    expect(
      await refused(as(estimator, 'contractor.other_cost.remove', { costId: permit.costId })),
    ).toBe('not_found');
    expect((await costing(jobId)).total.actualCents).toBe(118_00);
    // What it came to stays off the news of it.
    const events = await rows<{ type: string; payload: Any }>(
      admin(),
      sql`select event_type as type, payload from app.events
          where workspace_id = ${ws} and entity_id = ${jobId} and event_type like 'contractor.other_cost.%'
          order by created_at, id`,
    );
    expect(events.map((e) => e.type)).toEqual([
      'contractor.other_cost.added',
      'contractor.other_cost.removed',
    ]);
    expect(events.every((e) => e.payload.costId === permit.costId)).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/cents|amount/i);
  });

  it('stops time left running for 12 hours, and says so until someone has looked', async () => {
    const jobId = await job('Forgotten Done');
    const v = await visit(jobId, 27);
    await onVisit(v, member);
    const base = Math.floor(Date.now() / 1000) * 1000;
    const hoursAgo = (h: number) => new Date(base - h * 3_600_000).toISOString();
    await press(v, 'in_progress', hoursAgo(13));

    const out = await worker('contractor.time.stop_overrun', { appointmentId: v });
    expect(out).toEqual({
      jobId,
      job: 'Forgotten Done',
      stopped: [member.fullName],
      flagged: [member.fullName],
      nextAt: null,
    });
    const [entry] = (await time(owner, jobId)).entries;
    expect(entry).toMatchObject({
      endedAt: hoursAgo(1),
      seconds: 12 * 3600,
      autoStopped: true,
      fixed: null,
    });
    // Looked at again, there's nothing more to stop, and it still waits for someone.
    expect(await worker('contractor.time.stop_overrun', { appointmentId: v })).toMatchObject({
      stopped: [],
      flagged: [member.fullName],
    });
    // Fixed, it's been looked at.
    await as(owner, 'contractor.time.fix', {
      entryId: entry.id,
      endedAt: hoursAgo(9),
      reason: 'Left at noon',
    });
    expect((await time(owner, jobId)).entries[0]).toMatchObject({
      seconds: 4 * 3600,
      autoStopped: false,
    });
    expect(await worker('contractor.time.stop_overrun', { appointmentId: v })).toMatchObject({
      stopped: [],
      flagged: [],
      nextAt: null,
    });

    // Time still inside the limit: when to look again. Time on a visit deleted for good stops at the limit too.
    await press(v, 'in_progress', hoursAgo(0.5));
    await rows(
      admin(),
      sql`insert into addon_contractor.time_entries (workspace_id, record_id, user_id, kind, started_at)
          values (${ws}, ${jobId}, ${estimator.id}, 'work', now() - interval '13 hours')`,
    );
    expect(await worker('contractor.time.stop_overrun', { appointmentId: v })).toMatchObject({
      stopped: [],
      flagged: [],
      nextAt: new Date(base + 11.5 * 3_600_000).toISOString(),
    });
    const list = await time(owner, jobId);
    expect(list.entries.find((e: Any) => e.userId === estimator.id)).toMatchObject({
      appointmentId: null,
      seconds: 12 * 3600,
      autoStopped: true,
    });
    expect(list.totals.running).toBe(1);
    await press(v, 'done', new Date(base).toISOString());
    expect((await time(owner, jobId)).totals.running).toBe(0);
    // A visit that isn't on a job is none of its business.
    expect(await worker('contractor.time.stop_overrun', { appointmentId: randomUUID() })).toEqual({
      jobId: null,
      job: null,
      stopped: [],
      flagged: [],
      nextAt: null,
    });
  });
});

describe('the AI helpers (part 7; the owner’s rule, and decisions 6 and 11)', () => {
  const job = (name: string, more: Record<string, unknown> = {}) =>
    as(owner, 'contractor.job.open', {
      name,
      customerPersonId: customerId,
      newPropertyAddress: `${name}, 8 Elm St`,
      trade: 'electrical',
      ...more,
    }).then((o) => o.jobId as string);
  /** A price list item. */
  const product = (name: string, unitPriceCents: number) =>
    executeCommand(
      api(),
      productCreate,
      { workspaceId: ws, name, kind: 'product', unitPriceCents, unitLabel: 'each' },
      human(owner),
      meta(),
    ).then((r) => (r.output as Any).productId as string);
  const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
    (await rows<T>(admin(), q))[0]!;
  /** How many rows of one of part 7's tables a person can read, whatever asks. */
  const seen = (u: TestUser, table: 'estimate_drafts' | 'budget_watch' | 'daily_reports') =>
    asUser(api(), u.claims, (tx) =>
      rows<{ n: number }>(
        tx,
        sql`select count(*)::int as n from ${sql.raw(`addon_contractor.${table}`)}`,
      ),
    ).then((r) => r[0]!.n);
  const labor = {
    productId: null,
    name: 'Install labor',
    description: null,
    quantity: 6,
    unitLabel: 'hour',
    unitPriceCents: 95_00,
    taxable: false,
    kind: 'labor',
    unitCostCents: 40_00,
    guessed: false,
  };
  const panel = {
    productId: null,
    name: '200A panel',
    description: 'Square D, 40 spaces',
    quantity: 1,
    unitLabel: 'each',
    unitPriceCents: 300_00,
    taxable: true,
    kind: 'material',
    unitCostCents: 200_00,
    guessed: true,
  };
  const drafted = (over: Record<string, unknown> = {}) => ({
    title: 'Panel swap',
    options: [{ name: '', lines: [labor, panel] }],
    assumptions: ['The meter base is sound'],
    questions: ['Does the city need a permit for this?'],
    ...over,
  });
  /** The worker keeping what the AI drafted, for the person who pressed Draft with AI. */
  const keep = (jobId: string, over: Record<string, unknown> = {}, by: TestUser = estimator) =>
    worker(
      'contractor.estimate_draft.keep',
      { jobId, brief: 'Swap the panel', draft: drafted(over), notesRead: 2, photosRead: 1 },
      by,
    );
  const drafts = (u: TestUser, jobId: string) =>
    as(u, 'contractor.estimate_draft.list', { jobId }).then((r) => r.drafts as Any[]);
  const costing = (jobId: string) => as(estimator, 'contractor.job.costing', { jobId });
  const check = (jobId: string) => worker('contractor.budget.check', { jobId });
  const reports = (u: TestUser, jobId: string) => as(u, 'contractor.report.list', { jobId });
  const words = (over: Record<string, unknown> = {}) => ({
    summary: 'The old panel is out and the new one is mounted.',
    done: ['Pulled the Zinsco panel', 'Mounted the new 200A panel'],
    issues: ['Two circuits have no ground'],
    materials: ['Used 12 breakers'],
    next: ['Land the circuits tomorrow'],
    forCustomer: 'The new panel is mounted. We’ll finish the wiring tomorrow.',
    ...over,
  });
  /** The worker keeping the report the AI wrote for a day: on its own, or for the person who pressed Write. */
  const write = (jobId: string, day: string, more: Record<string, unknown> = {}, by?: TestUser) =>
    worker(
      'contractor.report.keep',
      { jobId, day, body: words(), notesRead: 2, photosRead: 0, ...more },
      by,
    );

  describe('an estimate the AI drafts', () => {
    it('gives the AI the job, its notes and the price list with costs', async () => {
      const jobId = await job('Zinsco panel', { details: 'Breakers keep tripping.' });
      await as(member, 'contractor.note.add', {
        jobId,
        body: 'Panel is a Zinsco. Needs a 200A replacement.',
      });
      const productId = await product('P7 200A panel', 300_00);
      await as(estimator, 'contractor.item_cost.set', { productId, costCents: 200_00 });
      const source = await worker(
        'contractor.estimate_draft.source',
        { jobId, brief: '  Swap the panel  ', options: 3 },
        estimator,
      );
      expect(source.job).toMatchObject({
        name: 'Zinsco panel',
        kind: 'Service call',
        trade: 'Electrical',
        details: 'Breakers keep tripping.',
      });
      expect(source.job.property).toContain('8 Elm St');
      expect(source.brief).toBe('Swap the panel');
      expect(source.notes).toEqual([
        expect.objectContaining({
          text: 'Panel is a Zinsco. Needs a 200A replacement.',
          photos: 0,
        }),
      ]);
      expect(source.photoFileIds).toEqual([]);
      expect(source.items.find((i: Any) => i.productId === productId)).toMatchObject({
        name: 'P7 200A panel',
        unitLabel: 'each',
        unitPriceCents: 300_00,
        kind: 'material',
        costCents: 200_00,
      });
      expect(source.estimating).toEqual({
        markupBp: expect.any(Number),
        laborRateCents: expect.any(Number),
        laborCostCents: expect.any(Number),
      });
      expect(source.options).toBe(3);
    });

    it('keeps the draft beside the job for people who may see job costs, and makes no estimate', async () => {
      const jobId = await job('Draft kept');
      const kept = await keep(jobId);
      expect(kept).toEqual({
        draftId: expect.any(String),
        jobId,
        optionCount: 1,
        lines: 2,
        guessed: 1,
        questions: 1,
      });
      const list = await drafts(estimator, jobId);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        id: kept.draftId,
        jobId,
        state: 'ready',
        title: 'Panel swap',
        brief: 'Swap the panel',
        askedBy: 'Eli Estimator',
        notesRead: 2,
        photosRead: 1,
        optionCount: 1,
        lines: 2,
        guessed: 1,
        questions: 1,
        estimateId: null,
      });
      // A list has no lines: they open in the builder.
      expect(list[0].draft).toBeUndefined();
      // A draft holds costs, so a tech is shown none: not by the query, and not by the database.
      expect(await refused(drafts(member, jobId))).toBe('forbidden');
      expect(await seen(member, 'estimate_drafts')).toBe(0);
      expect(await seen(estimator, 'estimate_drafts')).toBeGreaterThan(0);
      // A draft is never an estimate.
      expect(
        await one<{ n: number }>(
          sql`select count(*)::int as n from addon_contractor.estimates where record_id = ${jobId}`,
        ),
      ).toEqual({ n: 0 });
      // The job's history says a draft waits, with no amounts.
      const event = await one<{ payload: Any }>(
        sql`select payload from app.events
            where workspace_id = ${ws} and entity_id = ${jobId}
              and event_type = 'contractor.estimate_draft.ready'`,
      );
      expect(event.payload).toEqual({ draftId: kept.draftId, jobId, options: 1, lines: 2 });
      // Only the worker keeps one: a person writes an estimate in the builder.
      expect(
        await refused(
          as(owner, 'contractor.estimate_draft.keep', { jobId, brief: null, draft: drafted() }),
        ),
      ).toBe('forbidden');
    });

    it('keeps five waiting drafts on a job, and sets the oldest aside', async () => {
      const jobId = await job('Many drafts');
      const ids: string[] = [];
      for (let i = 1; i <= 6; i += 1)
        ids.push((await keep(jobId, { title: `Draft ${i}` })).draftId as string);
      const list = await drafts(estimator, jobId);
      expect(list.map((d) => d.title)).toEqual([
        'Draft 6',
        'Draft 5',
        'Draft 4',
        'Draft 3',
        'Draft 2',
      ]);
      expect(
        await one<{ state: string }>(
          sql`select state from addon_contractor.estimate_drafts where id = ${ids[0]!}`,
        ),
      ).toEqual({ state: 'dismissed' });
    });

    it('is set aside by someone who may see job costs, once', async () => {
      const jobId = await job('Set aside');
      const { draftId } = await keep(jobId);
      expect(await refused(as(member, 'contractor.estimate_draft.dismiss', { draftId }))).toBe(
        'forbidden',
      );
      expect(await as(estimator, 'contractor.estimate_draft.dismiss', { draftId })).toEqual({
        draftId,
        jobId,
        changed: true,
      });
      expect(await as(estimator, 'contractor.estimate_draft.dismiss', { draftId })).toEqual({
        draftId,
        jobId,
        changed: false,
      });
      expect(await drafts(estimator, jobId)).toEqual([]);
      expect(
        await one<{ state: string; settled_by: string }>(
          sql`select state, settled_by from addon_contractor.estimate_drafts where id = ${draftId}`,
        ),
      ).toEqual({ state: 'dismissed', settled_by: estimator.id });
      expect(
        await refused(
          as(estimator, 'contractor.estimate_draft.dismiss', { draftId: randomUUID() }),
        ),
      ).toBe('not_found');
    });

    it('opens in the builder, and only a person’s save makes it an estimate', async () => {
      const jobId = await job('From a draft');
      const { draftId } = await keep(jobId);
      const opened = await as(estimator, 'contractor.estimate.get', { jobId, draftId });
      expect(opened.estimate).toBeNull();
      expect(opened.draft).toMatchObject({
        id: draftId,
        state: 'ready',
        askedBy: 'Eli Estimator',
        draft: {
          title: 'Panel swap',
          options: [{ name: '', lines: [labor, panel] }],
          assumptions: ['The meter base is sound'],
          questions: ['Does the city need a permit for this?'],
        },
      });
      // A draft opens for its own job only.
      const elsewhere = await job('Another job');
      expect(
        await refused(as(estimator, 'contractor.estimate.get', { jobId: elsewhere, draftId })),
      ).toBe('not_found');
      // A tech can't open the builder at all.
      expect(await refused(as(member, 'contractor.estimate.get', { jobId, draftId }))).toBe(
        'forbidden',
      );

      // The person checks the lines and saves: the estimate is theirs, written like any other.
      const line = (l: typeof labor | typeof panel) => ({
        name: l.name,
        quantity: l.quantity,
        unitLabel: l.unitLabel,
        unitPriceCents: l.unitPriceCents,
        kind: l.kind,
        unitCostCents: l.unitCostCents,
      });
      const saved = await as(estimator, 'contractor.estimate.save', {
        jobId,
        draftId,
        title: 'Panel swap',
        options: [{ name: '', lines: [line(labor), line(panel)] }],
      });
      expect(saved.created).toBe(true);
      // $870 for $440 of costs: above the lowest margin, so it needs nobody's OK.
      expect(saved.check.needsOk).toBeNull();
      expect(await drafts(estimator, jobId)).toEqual([]);
      expect(
        await one<{ state: string; estimate_id: string; settled_by: string }>(
          sql`select state, estimate_id, settled_by from addon_contractor.estimate_drafts
              where id = ${draftId}`,
        ),
      ).toEqual({ state: 'used', estimate_id: saved.estimateId, settled_by: estimator.id });
      // The saved estimate says where it started, and a used draft doesn't open a second one.
      const again = await as(estimator, 'contractor.estimate.get', {
        estimateId: saved.estimateId,
      });
      expect(again.draft).toMatchObject({
        id: draftId,
        state: 'used',
        estimateId: saved.estimateId,
      });
      expect(await refused(as(estimator, 'contractor.estimate.get', { jobId, draftId }))).toBe(
        'not_found',
      );
      // The job's timeline says both, in words and never in amounts.
      const lines = await rows<{ words: string }>(
        admin(),
        sql`select meta->>'words' as words from app.activities
            where custom_record_id = ${jobId} and meta->>'words' is not null order by created_at, id`,
      );
      const said = lines.map((l) => l.words).join('\n');
      expect(said).toContain('had the AI draft an estimate for this job');
      expect(said).toContain('checked the AI’s draft and saved it as an estimate for this job');
      expect(said).not.toMatch(/\$|cents/i);
    });
  });

  describe('a job heading over its budget', () => {
    const cost = (jobId: string, name: string, amountCents: number) =>
      as(estimator, 'contractor.other_cost.add', { jobId, name, amountCents });
    const watched = (jobId: string) =>
      one<{ level: string; band: number; why: string | null; warned: boolean }>(
        sql`select level, band, why, warned_at is not null as warned
            from addon_contractor.budget_watch where record_id = ${jobId}`,
      );

    it('tells people who may see job costs once, and again only when it gets worse', async () => {
      const jobId = await job('Over budget');
      await as(owner, 'contractor.job.set_money', {
        jobId,
        priceCents: 5_000_00,
        otherCents: 1_000_00,
      });
      // On plan: nothing to tell, and nothing kept.
      expect(await check(jobId)).toEqual({
        jobId,
        level: 'ok',
        alert: null,
        clear: true,
        ask: null,
      });
      // 4% over isn't worth telling.
      await cost(jobId, 'Permit', 1_040_00);
      expect(await check(jobId)).toMatchObject({ level: 'ok', alert: null });

      // 20% over: told, with the costs and the profit it's now heading for.
      await cost(jobId, 'Dump fee', 160_00);
      const told = await check(jobId);
      expect(told).toMatchObject({ jobId, level: 'over', clear: false });
      expect(told.alert.title).toBe('“Over budget” is heading over budget');
      expect(told.alert.title).not.toMatch(/\$/);
      expect(told.alert.detail).toContain('$1,200 in costs against $1,000 planned (20% over)');
      expect(told.alert.detail).toContain('Profit is heading for $3,800');
      expect(told.ask).toContain('Other costs so far: Permit $1,040; Dump fee $160');
      expect(await watched(jobId)).toEqual({ level: 'over', band: 2, why: null, warned: true });

      // Looked at again with nothing changed: said once.
      expect(await check(jobId)).toEqual({
        jobId,
        level: 'over',
        alert: null,
        clear: false,
        ask: null,
      });

      // What the AI said is kept for the people who may see job costs, and shown with the job's costs.
      expect(
        await worker('contractor.budget.advise', {
          jobId,
          why: 'Other costs are $200 over the $1,000 planned.',
          suggestions: ['Check whether the dump fee belongs on this job'],
        }),
      ).toEqual({ jobId, kept: true });
      expect((await costing(jobId)).watch).toEqual({
        level: 'over',
        overPercent: 20,
        why: 'Other costs are $200 over the $1,000 planned.',
        suggestions: ['Check whether the dump fee belongs on this job'],
        warnedAt: expect.any(String),
      });
      // Where a job's money stands is for people who may see job costs only.
      expect(await refused(as(member, 'contractor.job.costing', { jobId }))).toBe('forbidden');
      expect(await seen(member, 'budget_watch')).toBe(0);
      expect(await seen(estimator, 'budget_watch')).toBeGreaterThan(0);

      // Another step over is news again, and what the AI said about how things stood is asked afresh.
      await cost(jobId, 'Second permit', 100_00);
      const worse = await check(jobId);
      expect(worse).toMatchObject({ level: 'over', clear: false });
      expect(worse.alert.detail).toContain('(30% over)');
      expect(await watched(jobId)).toMatchObject({ level: 'over', band: 3, why: null });
      expect((await costing(jobId)).watch).toMatchObject({ why: null, suggestions: [] });

      // Back within its plan: any alert goes.
      await as(owner, 'contractor.job.set_money', { jobId, otherCents: 2_000_00 });
      expect(await check(jobId)).toEqual({
        jobId,
        level: 'ok',
        alert: null,
        clear: true,
        ask: null,
      });
      expect(await watched(jobId)).toMatchObject({ level: 'ok', band: 0, why: null });
      expect((await costing(jobId)).watch).toMatchObject({ level: 'ok', why: null });

      // None of it is on the job's history, which everyone on the job reads.
      const events = await rows<{ type: string }>(
        admin(),
        sql`select event_type as type from app.events
            where workspace_id = ${ws} and entity_id = ${jobId} and event_type like 'contractor.budget%'`,
      );
      expect(events).toEqual([]);
    });

    it('says a loss as a loss, and nothing while warnings are off', async () => {
      const jobId = await job('Losing job');
      await as(owner, 'contractor.job.set_money', {
        jobId,
        priceCents: 1_000_00,
        otherCents: 800_00,
      });
      await cost(jobId, 'Subcontractor', 1_500_00);
      const setWarnings = (on: boolean) =>
        rows(
          admin(),
          sql`update app.addon_installations
              set settings = coalesce(settings, '{}'::jsonb) || ${JSON.stringify({ budgetWarnings: on })}::jsonb
              where workspace_id = ${ws} and addon_id = 'contractor'`,
        );
      await setWarnings(false);
      try {
        expect(await check(jobId)).toEqual({
          jobId,
          level: 'ok',
          alert: null,
          clear: true,
          ask: null,
        });
      } finally {
        await setWarnings(true);
      }
      const told = await check(jobId);
      expect(told.level).toBe('loss');
      expect(told.alert.title).toBe('“Losing job” is heading for a loss');
      expect(told.alert.detail).toContain('that’s a loss of $500');
      // The card still shows where it stands, whatever the setting.
      expect((await costing(jobId)).watch).toMatchObject({ level: 'loss', overPercent: 87 });
      // A job that's gone has nothing to watch.
      expect(await check(randomUUID())).toBeNull();
    });
  });

  describe('a daily report', () => {
    it('gives the AI one day of a job, and never a cost', async () => {
      const jobId = await job('Report source');
      await as(member, 'contractor.note.add', { jobId, body: 'Pulled the old panel.' });
      const source = await worker('contractor.report.source', { jobId });
      expect(source).toMatchObject({
        jobId,
        job: { name: 'Report source', kind: 'Service call', trade: 'Electrical', percentDone: 0 },
        business: 'Bright Line Electric',
        ticked: [],
        photoFileIds: [],
        waitingWords: 0,
        existing: null,
        onItsOwn: true,
      });
      expect(source.job.customerFirstName).toBe('Dana');
      expect(source.notes).toEqual([
        expect.objectContaining({ text: 'Pulled the old panel.', photos: 0, visit: null }),
      ]);
      expect(source.dayWords).toMatch(/^\w+day, \w+ \d+$/);
      expect(JSON.stringify(source)).not.toMatch(/cents|cost|price/i);
      // Another day has none of it.
      const before = await worker('contractor.report.source', { jobId, day: '2026-01-05' });
      expect(before).toMatchObject({ day: '2026-01-05', notes: [], dayWords: 'Monday, January 5' });
    });

    it('keeps one report a day, written again in place, and leaves a person’s words alone', async () => {
      const jobId = await job('Reported job');
      const { today } = await reports(member, jobId);
      // Written on its own.
      const first = await write(jobId, today);
      expect(first).toEqual({ reportId: expect.any(String), jobId, day: today, kept: true });
      let list = await reports(member, jobId);
      expect(list).toMatchObject({
        jobId,
        today,
        onItsOwn: true,
        customer: { name: 'Dana Reyes' },
        canChange: true,
        truncated: false,
      });
      expect(list.reports).toEqual([
        {
          id: first.reportId,
          day: today,
          ...words(),
          crew: [],
          photoFileIds: [],
          notesRead: 2,
          photosRead: 0,
          writtenAt: expect.any(String),
          askedBy: null,
          edited: null,
          sent: null,
        },
      ]);
      // A report has no money in it, so a tech reads it; and the worker alone keeps one.
      expect(await seen(member, 'daily_reports')).toBeGreaterThan(0);
      expect(
        await refused(as(owner, 'contractor.report.keep', { jobId, day: today, body: words() })),
      ).toBe('forbidden');

      // Written again for someone who pressed Write: the same report, with the new words.
      const again = await write(
        jobId,
        today,
        { body: words({ summary: 'Circuits are landed.' }), crew: [{ name: 'Sam', hours: 6.5 }] },
        estimator,
      );
      expect(again).toEqual({ reportId: first.reportId, jobId, day: today, kept: true });
      list = await reports(member, jobId);
      expect(list.reports).toHaveLength(1);
      expect(list.reports[0]).toMatchObject({
        summary: 'Circuits are landed.',
        crew: [{ name: 'Sam', hours: 6.5 }],
        askedBy: 'Eli Estimator',
      });

      // Someone changes its words: it's theirs now.
      expect(
        await as(member, 'contractor.report.update', {
          reportId: first.reportId,
          summary: 'Circuits are landed, by hand.',
          done: ['- Landed 12 circuits', 'landed 12 CIRCUITS'],
          forCustomer: null,
        }),
      ).toEqual({ reportId: first.reportId, jobId, day: today });
      list = await reports(member, jobId);
      expect(list.reports[0]).toMatchObject({
        summary: 'Circuits are landed, by hand.',
        done: ['Landed 12 circuits'],
        issues: [],
        forCustomer: null,
        edited: { by: expect.any(String), at: expect.any(String) },
      });
      // The AI doesn't write over it on its own.
      expect(await write(jobId, today)).toEqual({
        reportId: first.reportId,
        jobId,
        day: today,
        kept: false,
      });
      expect((await reports(member, jobId)).reports[0].summary).toBe(
        'Circuits are landed, by hand.',
      );
      // Unless the person says to write it again.
      expect(await write(jobId, today, { replace: true }, member)).toMatchObject({ kept: true });
      list = await reports(member, jobId);
      expect(list.reports[0]).toMatchObject({ summary: words().summary, edited: null });

      // A report needs a summary, from the AI or from a person.
      expect(await refused(write(jobId, today, { body: words({ summary: '   ' }) }))).toBe(
        'validation',
      );
      expect(
        await refused(
          as(member, 'contractor.report.update', { reportId: first.reportId, summary: '  ' }),
        ),
      ).toBe('validation');

      // Another day is another report, and the newest day comes first.
      await write(jobId, '2026-01-05', { body: words({ summary: 'An earlier day.' }) });
      expect((await reports(member, jobId)).reports.map((r: Any) => r.day)).toEqual([
        today,
        '2026-01-05',
      ]);
      // Written twice, said once on the job's history.
      const events = await rows<{ payload: { again: boolean } }>(
        admin(),
        sql`select payload from app.events
            where workspace_id = ${ws} and entity_id = ${jobId} and event_type = 'contractor.report.written'
            order by created_at, id`,
      );
      expect(events.map((e) => e.payload.again)).toEqual([false, true, true, false]);
      const lines = await rows<{ words: string }>(
        admin(),
        sql`select meta->>'words' as words from app.activities
            where custom_record_id = ${jobId} and meta->>'words' is not null`,
      );
      expect(lines.filter((l) => /wrote the daily report/.test(l.words))).toHaveLength(2);
    });

    it('sends the customer only their update, once, when a person says so', async () => {
      const [riley] = await rows<{ id: string }>(
        admin(),
        sql`insert into app.people (workspace_id, first_name, last_name, email, owner_user_id)
            values (${ws}, 'Riley', 'Stone', ${`riley-${randomUUID().slice(0, 8)}@example.com`}, ${owner.id})
            returning id`,
      );
      const jobId = await job('Kitchen rewire', { customerPersonId: riley!.id });
      const { today } = await reports(owner, jobId);
      const { reportId } = await write(jobId, today, { body: words({ forCustomer: null }) });
      const send = (more: Record<string, unknown> = {}) =>
        as(owner, 'contractor.report.send', { reportId, channel: 'email', ...more });
      expect((await reports(owner, jobId)).customer).toEqual({
        name: 'Riley Stone',
        email: true,
        sms: false,
      });
      // Nothing written for the customer: nothing to send.
      expect(await refused(send())).toBe('contractor_report_nothing_to_send');
      // No phone number: not by text.
      expect(await refused(send({ channel: 'sms', body: 'The panel is in.' }))).toBe(
        'contractor_report_cant_reach',
      );
      expect((await reports(owner, jobId)).reports[0].sent).toBeNull();

      // What the person sends is what's kept as the customer's update.
      expect(await send({ body: 'The panel is in. We’ll be back tomorrow.' })).toEqual({
        reportId,
        jobId,
        day: today,
        channel: 'email',
        customer: 'Riley Stone',
      });
      const report = (await reports(owner, jobId)).reports[0];
      expect(report).toMatchObject({
        forCustomer: 'The panel is in. We’ll be back tomorrow.',
        sent: { by: 'Olive Owner', channel: 'email', at: expect.any(String) },
      });
      const [message] = await rows<{ subject: string | null; body: string }>(
        admin(),
        sql`select m.subject, m.body_text as body from app.messages m
            join app.conversations c on c.id = m.conversation_id
            where m.workspace_id = ${ws} and c.person_id = ${riley!.id}`,
      );
      expect(message).toEqual({
        subject: 'Today on your job: Kitchen rewire',
        body: 'The panel is in. We’ll be back tomorrow.',
      });
      // Once: saying more is a message of their own. And what went stays as it went.
      expect(await refused(send())).toBe('contractor_report_sent');
      await as(owner, 'contractor.report.update', {
        reportId,
        summary: 'Changed after sending.',
        forCustomer: 'Something else entirely.',
      });
      expect((await reports(owner, jobId)).reports[0]).toMatchObject({
        summary: 'Changed after sending.',
        forCustomer: 'The panel is in. We’ll be back tomorrow.',
      });
    });
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
