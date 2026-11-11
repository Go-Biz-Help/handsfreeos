/**
 * Contractor Operations on the database (docs/contractor.md): its tables are mirrored exactly; a job is a service
 * call or a project at a property, for a customer; a project starts with its starter phases and its % done is their
 * average; adding a phase makes a service call a project; on hold and cancelled need a reason; a job's price and
 * budget are seen and set only by people who may see job costs (the owner's decision 11); a visit on a job moves it
 * along; an estimate's costs stay with people who may see them, one under the lowest margin waits for an owner's or
 * admin's OK (decision 6), and an approved one fills its job's budget at the option picked (decision 5); and none of
 * it works while the add-on is off.
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
