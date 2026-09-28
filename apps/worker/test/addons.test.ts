/**
 * Add-ons in the worker, end to end (0108): the lifecycle's slow half and the guards on queued work, over the
 * made-up catalogue (packages/core/test/addons/fixtures.ts) and worker modules made here that write down what
 * they're asked to do.
 *
 * - Installing sets an add-on up (its kinds of records, its own hooks) and proves it. What happens in a business
 *   reaches it in a job of its own, as the system acting for it, and its trouble stays its own.
 * - Turning it off stops its work (even what was already queued, before the worker gets to it), hides its records,
 *   and nothing goes out late when it's back.
 * - Uninstalling lets go of what it holds outside, and isn't finished until it has. Installing a newer version
 *   brings its data up and restores its records. Deleting its data keeps core's records, the records' names and
 *   the history lines.
 * - Business A has no add-ons, B is where they come and go, C has thirteen.
 */
import { randomUUID } from 'node:crypto';
import {
  addonLifecycleCommands,
  customRecordCreate,
  defineAddonCommand,
  executeCommand,
  organizationCreate,
  personCreate,
  personUpdate,
  relationshipCreate,
  taskCreate,
  workspaceCreate,
  type AddonManifest,
  type Catalog,
  type HumanActor,
} from '@hfos/core/server';
import { asUser, asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  FIXTURE_CATALOG,
  TWELVE,
  fxprop,
  fxrent,
} from '../../../packages/core/test/addons/fixtures';
import { addonWorker, scheduleAddonJob, type AddonWorkerModule } from '../src/addons/index';
import { processDeliveries } from '../src/deliveries';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { testServices, type TestServices } from './helpers';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const cmds = addonLifecycleCommands(FIXTURE_CATALOG);
const run = <T>(cmd: Parameters<typeof executeCommand>[1], input: unknown, u: TestUser) =>
  executeCommand(api(), cmd, input, human(u), meta()).then((r) => r.output as T);
const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
  (await rows<T>(admin(), q))[0];
const count = async (q: ReturnType<typeof sql>) =>
  Number((await one<{ n: number | string }>(q))?.n ?? 0);

let owner: TestUser;
let member: TestUser;
let s: TestServices;
let orgId: string;
let wsA: string;
let wsB: string;
let wsC: string;

// ---------- what the made-up add-ons do in the worker ----------

/** Everything the add-ons were asked to do, in order. */
const calls: string[] = [];
const said = (what: string) => calls.push(what);
let releaseFailures = 0;
const released: string[] = [];
let rentBreaks = false;
let propInstallFailures = 0;

/** Property Management doing something through the kernel, as itself. */
const touch = defineAddonCommand(fxprop, {
  name: 'fxprop.touch',
  description: 'Test: the add-on doing something through the kernel.',
  risk: 0,
  input: z.object({ workspaceId: z.uuid(), why: z.string() }),
  output: z.object({ ok: z.literal(true) }),
  permission: null,
  actors: ['system'],
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['fxprop.touched'],
  async handler(ctx, input) {
    await ctx.emit({
      type: 'fxprop.touched',
      entityType: 'workspace',
      entityId: ctx.scope.workspaceId,
      payload: { why: input.why },
    });
    return { ok: true as const };
  },
});

function propModule(manifest: AddonManifest): AddonWorkerModule {
  return {
    manifest,
    subscribers: {
      'person.updated': async (ctx) => {
        said(`fxprop saw ${ctx.event.entityId}`);
        await executeCommand(
          ctx.db,
          touch,
          { workspaceId: ctx.scope.workspaceId, why: 'a person changed' },
          ctx.actor,
          ctx.meta,
        );
      },
    },
    jobs: {
      'fxprop.rent_check': async (ctx) => {
        said(`fxprop rent check ${String(ctx.job.payload['n'])}`);
        if (ctx.job.payload['n'] !== 'mid-run') return;
        // Turned off while it runs: what it does through the kernel after that is refused.
        await run(
          cmds.disable,
          { workspaceId: ctx.scope.workspaceId, addonId: 'fxprop', include: ['fxrent'] },
          owner,
        );
        await executeCommand(
          ctx.db,
          touch,
          { workspaceId: ctx.scope.workspaceId, why: 'after it was turned off' },
          ctx.actor,
          ctx.meta,
        );
      },
    },
    onInstall: async (ctx) => {
      if (propInstallFailures > 0) {
        propInstallFailures--;
        throw new Error('the property service was down');
      }
      said(`fxprop installed at generation ${ctx.generation}`);
    },
    onEnable: async (ctx) => {
      said('fxprop on');
      // Its daily check, armed from now every time it comes on.
      await asWorker(ctx.db, ctx.scope, (tx) =>
        scheduleAddonJob(
          tx,
          { id: manifest.id, generation: ctx.generation },
          {
            kind: 'fxprop.rent_check',
            dedupeKey: 'daily',
            runAt: new Date(Date.now() + 3_600_000),
            payload: { n: 'daily' },
            ...ctx.scope,
          },
        ),
      );
    },
    onDisable: async () => {
      said('fxprop off');
    },
    onUninstall: async () => {
      said('fxprop uninstalled');
    },
  };
}

const rentModule: AddonWorkerModule = {
  manifest: fxrent,
  subscribers: {
    'fxprop.lease.signed': async () => {
      said('fxrent saw a lease');
    },
    'invoice.paid': async () => {
      if (rentBreaks) throw new Error('rent subscriber broke');
      said('fxrent saw a payment');
    },
  },
  // What it makes at a provider as it arrives: a bank feed, to let go of when it leaves.
  onInstall: async (ctx) => {
    await asWorker(ctx.db, ctx.scope, (tx) =>
      tx.execute(
        sql`insert into app.addon_resources (workspace_id, addon_id, generation, kind, external_id, label)
            values (${ctx.scope.workspaceId}, 'fxrent', ${ctx.generation}, 'fxrent.bank_feed',
              ${`feed-${ctx.scope.workspaceId}`}, 'Bank feed')
            on conflict do nothing`,
      ),
    );
  },
  releaseResource: async (_ctx, r) => {
    if (releaseFailures > 0) {
      releaseFailures--;
      throw new Error('the bank said try later');
    }
    released.push(r.externalId);
  },
  onUninstall: async () => {
    said('fxrent uninstalled');
  },
};

/** A version on: its data changed shape, and a step brings each business's up. */
const fxpropV2: AddonManifest = { ...fxprop, version: '1.1.0', dataVersion: 2 };
const catalogV2: Catalog = FIXTURE_CATALOG.map((m) => (m.id === fxprop.id ? fxpropV2 : m));
const cmdsV2 = addonLifecycleCommands(catalogV2);

const v1 = addonWorker(FIXTURE_CATALOG, [propModule(fxprop), rentModule]);
const v2 = addonWorker(catalogV2, [
  {
    ...propModule(fxpropV2),
    dataMigrations: {
      2: async (ctx) => {
        said('fxprop data brought to 2');
        await ctx.tx.execute(
          sql`update app.custom_records set notes = coalesce(notes || ' ', '') || '(checked)'
              where workspace_id = ${ctx.scope.workspaceId}
                and type_id in (select id from app.custom_record_types where addon_id = 'fxprop')`,
        );
      },
    },
  },
  rentModule,
]);
type Worker = {
  readonly handlers: ReturnType<typeof v1.withAddons>;
  readonly jobs: typeof v1.jobs;
};
const W1: Worker = { handlers: v1.withAddons({}), jobs: v1.jobs };
const W2: Worker = { handlers: v2.withAddons({}), jobs: v2.jobs };

// ---------- running the worker for one business ----------

/** One pass over one business: its events, then its due jobs (add-ons' own are pulled forward). */
async function pass(ws: string, w: Worker = W1) {
  const runner = `vitest-addons-${randomUUID().slice(0, 8)}`;
  await rows(
    admin(),
    sql`update app.outbox set locked_at = now(), locked_by = ${runner}
        where status = 'pending' and workspace_id = ${ws}`,
  );
  const outbox = await processOnce({
    ...s,
    handlers: w.handlers,
    workerId: runner,
    batchSize: 100,
    reservedOnly: true,
  });
  await rows(
    admin(),
    sql`update app.scheduled_jobs set run_at = least(run_at, now()), locked_at = now(), locked_by = ${runner}
        where status = 'pending' and workspace_id = ${ws} and (kind like 'addon.%' or run_at <= now())`,
  );
  const jobs = await processJobs({
    ...s,
    jobs: w.jobs,
    workerId: runner,
    batchSize: 100,
    reservedOnly: true,
  });
  return { outbox, jobs };
}

/** Passes until there's nothing left to do. */
async function drain(ws: string, w: Worker = W1) {
  for (let i = 0; i < 30; i++) {
    const r = await pass(ws, w);
    if (r.outbox.claimed === 0 && r.jobs.claimed === 0) return;
  }
  throw new Error('the worker never settled');
}

const installation = (ws: string, addonId: string) =>
  one<{
    state: string;
    generation: number;
    installed_version: string;
    data_version: number;
    verified: boolean;
    last_error: string | null;
    failed: string[];
  }>(
    sql`select state, generation, installed_version, data_version, verified_at is not null as verified, last_error,
          coalesce((select array_agg(c ->> 'name') from jsonb_array_elements(verification -> 'checks') c
                    where (c ->> 'ok')::boolean = false), '{}') as failed
        from app.addon_installations where workspace_id = ${ws} and addon_id = ${addonId}`,
  );

/** Proved: in the state, every check passed, nothing wrong. */
async function expectSettled(ws: string, addonId: string, state: string) {
  expect(await installation(ws, addonId)).toMatchObject({
    state,
    verified: true,
    last_error: null,
    failed: [],
  });
}

/** What a member can see of a record, through row security. */
const memberSees = async (recordId: string) =>
  (
    await asUser(api(), member.claims, (tx) =>
      rows<{ name: string }>(tx, sql`select name from app.custom_records where id = ${recordId}`),
    )
  ).map((r) => r.name);

let personId: string;
let propertyId: string;
let taskId: string;

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('addons-worker-owner'),
    createTestUser('addons-worker-member'),
  ]);
  const org = await run<{ workspaceId: string; organizationId: string }>(
    organizationCreate,
    { businessName: 'Add-ons Worker A' },
    owner,
  );
  orgId = org.organizationId;
  wsA = org.workspaceId;
  wsB = (
    await run<{ workspaceId: string }>(
      workspaceCreate,
      { organizationId: orgId, name: 'Add-ons Worker B', joinAsOwner: true },
      owner,
    )
  ).workspaceId;
  wsC = (
    await run<{ workspaceId: string }>(
      workspaceCreate,
      { organizationId: orgId, name: 'Add-ons Worker C', joinAsOwner: true },
      owner,
    )
  ).workspaceId;
  for (const ws of [wsA, wsB, wsC])
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${ws}, ${member.id}, 'member')`,
    );
  for (const m of FIXTURE_CATALOG)
    if (m.permissions.length > 0)
      await rows(
        admin(),
        sql`select private.register_addon_permissions(${m.id}, ${JSON.stringify(m.permissions)}::jsonb)`,
      );
  s = testServices();
  personId = (
    await run<{ personId: string }>(
      personCreate,
      { workspaceId: wsB, firstName: 'Tess', lastName: 'Tenant' },
      member,
    )
  ).personId;
}, 60_000);

afterAll(closeTestDbs);

describe('a business with no add-ons (A)', () => {
  it('hands its events to no add-on and queues nothing for one', async () => {
    const tessInA = (
      await run<{ personId: string }>(
        personCreate,
        { workspaceId: wsA, firstName: 'Andy', lastName: 'Alone' },
        member,
      )
    ).personId;
    await run(
      personUpdate,
      { workspaceId: wsA, personId: tessInA, lastName: 'Still Alone' },
      member,
    );
    await drain(wsA);
    expect(
      await count(
        sql`select count(*) as n from app.scheduled_jobs where workspace_id = ${wsA} and (addon_id is not null or kind like 'addon.%')`,
      ),
    ).toBe(0);
  });
});

describe('installing (B)', () => {
  it('sets Property Management up, and proves it', async () => {
    await run(cmds.install, { workspaceId: wsB, addonId: 'fxprop' }, owner);
    await drain(wsB);
    await expectSettled(wsB, 'fxprop', 'enabled');
    expect(calls).toEqual(['fxprop installed at generation 1', 'fxprop on']);
    const kinds = await rows<{ key: string; write_permission: string; archived: boolean }>(
      admin(),
      sql`select key, write_permission, archived_at is not null as archived from app.custom_record_types
          where workspace_id = ${wsB} and addon_id = 'fxprop' order by key`,
    );
    expect(kinds).toEqual([
      { key: 'fxprop_lease', write_permission: 'fxprop.write', archived: false },
      { key: 'fxprop_property', write_permission: 'fxprop.write', archived: false },
    ]);
    expect(
      await count(
        sql`select count(*) as n from app.relationship_types where workspace_id = ${wsB} and addon_id = 'fxprop'
            and archived_at is null`,
      ),
    ).toBe(2);
    // Its daily check, armed from now, carrying the add-on and the generation it was queued for.
    expect(
      await one(
        sql`select dedupe_key, addon_id, addon_generation from app.scheduled_jobs
            where workspace_id = ${wsB} and kind = 'fxprop.rent_check' and status = 'pending'`,
      ),
    ).toEqual({ dedupe_key: `${wsB}:daily`, addon_id: 'fxprop', addon_generation: 1 });
    expect(
      await count(
        sql`select count(*) as n from app.events where workspace_id = ${wsB} and event_type = 'addon.installed'
            and payload ->> 'addonId' = 'fxprop'`,
      ),
    ).toBe(1);
  });

  it('lets people keep their things as records of its kinds, tied to core’s', async () => {
    const kind = await one<{ id: string }>(
      sql`select id from app.custom_record_types where workspace_id = ${wsB} and key = 'fxprop_property'`,
    );
    const owns = await one<{ id: string }>(
      sql`select id from app.relationship_types where workspace_id = ${wsB} and addon_key = 'fxprop_owner'`,
    );
    propertyId = (
      await run<{ customRecordId: string }>(
        customRecordCreate,
        { workspaceId: wsB, typeId: kind!.id, name: '12 Main St', notes: 'Blue door' },
        member,
      )
    ).customRecordId;
    await run(
      relationshipCreate,
      { workspaceId: wsB, relationshipTypeId: owns!.id, aId: personId, bId: propertyId },
      member,
    );
    taskId = (
      await run<{ taskId: string }>(
        taskCreate,
        { workspaceId: wsB, title: 'Fix the gutter', customRecordId: propertyId },
        member,
      )
    ).taskId;
    expect(await memberSees(propertyId)).toEqual(['12 Main St']);
  });
});

describe('what happens in a business, delivered to the add-ons that subscribe', () => {
  it('reaches Property Management in a job of its own, which acts as it', async () => {
    calls.length = 0;
    await run(personUpdate, { workspaceId: wsB, personId, lastName: 'Tenant-Smith' }, member);
    await drain(wsB);
    expect(calls).toEqual([`fxprop saw ${personId}`]);
    const delivered = await one<{ status: string; addon_id: string }>(
      sql`select status, addon_id from app.scheduled_jobs where workspace_id = ${wsB} and kind = 'addon.deliver'
          order by created_at desc limit 1`,
    );
    expect(delivered).toEqual({ status: 'done', addon_id: 'fxprop' });
    // What it did through the kernel is its own in history.
    expect(
      await one(
        sql`select addon_id, actor_type, payload -> '_addon' ->> 'name' as name from app.events
            where workspace_id = ${wsB} and event_type = 'fxprop.touched' order by created_at desc limit 1`,
      ),
    ).toEqual({ addon_id: 'fxprop', actor_type: 'system', name: 'Property Management' });
  });

  it('keeps one add-on’s trouble its own', async () => {
    await run(cmds.install, { workspaceId: wsB, addonId: 'fxrent' }, owner);
    await drain(wsB);
    await expectSettled(wsB, 'fxrent', 'enabled');
    rentBreaks = true;
    calls.length = 0;
    // A payment (as core records one) and a person changing, together.
    const eventId = randomUUID();
    await rows(
      admin(),
      sql`insert into app.events (id, organization_id, workspace_id, event_type, actor_type, entity_type, payload,
            correlation_id)
          values (${eventId}, ${orgId}, ${wsB}, 'invoice.paid', 'system', 'invoice', '{}', ${randomUUID()})`,
    );
    await rows(
      admin(),
      sql`insert into app.outbox (event_id, organization_id, workspace_id, event_type)
          values (${eventId}, ${orgId}, ${wsB}, 'invoice.paid')`,
    );
    await run(personUpdate, { workspaceId: wsB, personId, firstName: 'Tessa' }, member);
    await drain(wsB);
    rentBreaks = false;
    // The payment's own work finished; Rent Collection's delivery failed on its own, after its retries.
    expect(await one(sql`select status from app.outbox where event_id = ${eventId}`)).toEqual({
      status: 'done',
    });
    expect(
      await one(
        sql`select status, attempts, last_error from app.scheduled_jobs
            where kind = 'addon.deliver' and payload ->> 'eventId' = ${eventId}`,
      ),
    ).toEqual({ status: 'failed', attempts: 5, last_error: 'rent subscriber broke' });
    // Property Management heard about the person all the same.
    expect(calls).toEqual([`fxprop saw ${personId}`]);
  });
});

describe('turning off (B)', () => {
  it('stops work already queued before the worker catches up, and sets aside what arrives', async () => {
    // Due now, and queued while it was on.
    await asWorker(testDbs().worker.db, { workspaceId: wsB, organizationId: orgId }, (tx) =>
      scheduleAddonJob(
        tx,
        { id: 'fxprop' },
        {
          kind: 'fxprop.rent_check',
          dedupeKey: 'now',
          runAt: new Date(),
          payload: { n: 'now' },
          workspaceId: wsB,
          organizationId: orgId,
        },
      ),
    );
    const deliveryId = randomUUID();
    await rows(
      admin(),
      sql`insert into app.webhook_deliveries (id, provider, kind, dedupe_key, workspace_id, organization_id, addon_id)
          values (${deliveryId}, 'fake', 'fxprop_lease', ${randomUUID()}, ${wsB}, ${orgId}, 'fxprop')`,
    );
    await run(cmds.disable, { workspaceId: wsB, addonId: 'fxprop', include: ['fxrent'] }, owner);

    // The worker hasn't looked at the move yet: the job runner and the webhook runner refuse on their own.
    const runner = `vitest-addons-${randomUUID().slice(0, 8)}`;
    await rows(
      admin(),
      sql`update app.scheduled_jobs set locked_at = now(), locked_by = ${runner}
          where workspace_id = ${wsB} and kind = 'fxprop.rent_check' and dedupe_key = ${`${wsB}:now`}`,
    );
    calls.length = 0;
    const ran = await processJobs({
      ...s,
      jobs: W1.jobs,
      workerId: runner,
      batchSize: 5,
      reservedOnly: true,
    });
    expect(ran).toMatchObject({ claimed: 1, cancelled: 1, done: 0 });
    expect(calls).toEqual([]);
    await rows(
      admin(),
      sql`update app.webhook_deliveries set locked_at = now(), locked_by = ${runner} where id = ${deliveryId}`,
    );
    const heard: string[] = [];
    const took = await processDeliveries({
      ...s,
      processors: { 'fake:fxprop_lease': async () => void heard.push('lease') },
      workerId: runner,
      batchSize: 5,
      reservedOnly: true,
    });
    expect(took).toMatchObject({ claimed: 1, ignored: 1 });
    expect(heard).toEqual([]);
    expect(
      await one(
        sql`select status, last_error from app.webhook_deliveries where id = ${deliveryId}`,
      ),
    ).toEqual({ status: 'ignored', last_error: 'addon_inactive' });
  });

  it('then cancels the rest, hides its records, and proves it', async () => {
    await drain(wsB);
    expect(calls).toEqual(['fxprop off']);
    await expectSettled(wsB, 'fxprop', 'disabled');
    await expectSettled(wsB, 'fxrent', 'disabled');
    expect(
      await count(
        sql`select count(*) as n from app.scheduled_jobs where workspace_id = ${wsB} and addon_id = 'fxprop'
            and status = 'pending'`,
      ),
    ).toBe(0);
    expect(await memberSees(propertyId)).toEqual([]);
    // Core's records stay as they were: the person, and the task about the property.
    expect(await count(sql`select count(*) as n from app.people where id = ${personId}`)).toBe(1);
    expect(await count(sql`select count(*) as n from app.tasks where id = ${taskId}`)).toBe(1);
  });

  it('comes back with its records, and nothing that came due while it was off goes out late', async () => {
    calls.length = 0;
    await run(cmds.enable, { workspaceId: wsB, addonId: 'fxrent', include: ['fxprop'] }, owner);
    await drain(wsB);
    await expectSettled(wsB, 'fxprop', 'enabled');
    expect(calls).toEqual(['fxprop on']);
    expect(await memberSees(propertyId)).toEqual(['12 Main St']);
    expect(
      await rows(
        admin(),
        sql`select dedupe_key, status from app.scheduled_jobs where workspace_id = ${wsB}
            and kind = 'fxprop.rent_check' order by created_at`,
      ),
    ).toEqual([
      { dedupe_key: `${wsB}:daily`, status: 'cancelled' },
      { dedupe_key: `${wsB}:now`, status: 'cancelled' },
      { dedupe_key: `${wsB}:daily`, status: 'pending' },
    ]);
  });

  it('refuses what a job does through the kernel once it’s turned off mid-run, and never runs it again', async () => {
    await asWorker(testDbs().worker.db, { workspaceId: wsB, organizationId: orgId }, (tx) =>
      scheduleAddonJob(
        tx,
        { id: 'fxprop' },
        {
          kind: 'fxprop.rent_check',
          dedupeKey: 'mid-run',
          runAt: new Date(),
          payload: { n: 'mid-run' },
          workspaceId: wsB,
          organizationId: orgId,
        },
      ),
    );
    await drain(wsB);
    expect(
      await one(
        sql`select status, last_error from app.scheduled_jobs where dedupe_key = ${`${wsB}:mid-run`}`,
      ),
    ).toMatchObject({ status: 'cancelled' });
    expect(
      await count(
        sql`select count(*) as n from app.events where workspace_id = ${wsB} and event_type = 'fxprop.touched'
            and payload ->> 'why' = 'after it was turned off'`,
      ),
    ).toBe(0);
    await expectSettled(wsB, 'fxprop', 'disabled');
    await run(cmds.enable, { workspaceId: wsB, addonId: 'fxrent', include: ['fxprop'] }, owner);
    await drain(wsB);
    await expectSettled(wsB, 'fxrent', 'enabled');
  });

  it('cancels an add-on job this version has no code for, instead of failing it', async () => {
    const [row] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, run_at, payload, addon_id, addon_generation)
          values (${orgId}, ${wsB}, 'fxprop.gone', now(), '{}', 'fxprop',
            (select generation from app.addon_installations where workspace_id = ${wsB} and addon_id = 'fxprop'))
          returning id`,
    );
    await drain(wsB);
    expect(
      await one(sql`select status, last_error from app.scheduled_jobs where id = ${row!.id}`),
    ).toEqual({ status: 'cancelled', last_error: 'no handler for fxprop.gone' });
  });
});

describe('uninstalling (B)', () => {
  it('isn’t finished until everything it holds outside is let go of', async () => {
    releaseFailures = 1;
    calls.length = 0;
    await run(cmds.uninstall, { workspaceId: wsB, addonId: 'fxrent' }, owner);
    // One pass: the bank refuses, so it stays uninstalling and says why.
    await pass(wsB);
    expect(await installation(wsB, 'fxrent')).toMatchObject({
      state: 'uninstalling',
      verified: false,
      last_error: 'It still holds 1 thing outside HandsFreeOS it couldn’t let go of.',
    });
    expect(
      await one(
        sql`select status, attempts from app.addon_resources where workspace_id = ${wsB} and addon_id = 'fxrent'`,
      ),
    ).toEqual({ status: 'failed', attempts: 1 });
    // The next try lets go of it, and then it's uninstalled, proved.
    await drain(wsB);
    await expectSettled(wsB, 'fxrent', 'uninstalled');
    expect(released).toEqual([`feed-${wsB}`]);
    expect(calls).toEqual(['fxrent uninstalled']);
    expect(
      await one(
        sql`select status from app.addon_resources where workspace_id = ${wsB} and addon_id = 'fxrent'`,
      ),
    ).toEqual({ status: 'released' });
  });

  it('uninstalls Property Management, keeping its data hidden and core’s records as they were', async () => {
    await run(cmds.uninstall, { workspaceId: wsB, addonId: 'fxprop' }, owner);
    await drain(wsB);
    await expectSettled(wsB, 'fxprop', 'uninstalled');
    expect(await memberSees(propertyId)).toEqual([]);
    expect(
      await count(sql`select count(*) as n from app.custom_records where id = ${propertyId}`),
    ).toBe(1);
    expect(await count(sql`select count(*) as n from app.tasks where id = ${taskId}`)).toBe(1);
  });
});

describe('installing a newer version (B)', () => {
  it('brings its data up, restores its records, and leaves work from before the reinstall behind', async () => {
    const kindBefore = await one<{ id: string }>(
      sql`select id from app.custom_record_types where workspace_id = ${wsB} and key = 'fxprop_property'`,
    );
    // The business had called its properties rentals; reinstalling keeps its name (the owner's decision).
    await rows(
      admin(),
      sql`update app.custom_record_types set singular = 'Rental', plural = 'Rentals', name_label = 'Street',
            icon = 'key' where id = ${kindBefore!.id}`,
    );
    calls.length = 0;
    await run(cmdsV2.install, { workspaceId: wsB, addonId: 'fxprop' }, owner);
    // Queued under the old generation, as if in a race with the reinstall.
    const [stale] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, run_at, payload, addon_id, addon_generation)
          values (${orgId}, ${wsB}, 'fxprop.rent_check', now(), '{"n":"stale"}', 'fxprop', 1) returning id`,
    );
    await drain(wsB, W2);
    await expectSettled(wsB, 'fxprop', 'enabled');
    expect(await installation(wsB, 'fxprop')).toMatchObject({
      generation: 2,
      installed_version: '1.1.0',
      data_version: 2,
    });
    expect(calls).toEqual([
      'fxprop data brought to 2',
      'fxprop installed at generation 2',
      'fxprop on',
    ]);
    // The same kind as before, under the business's name, and the record back, relationship and all.
    expect(
      await one(
        sql`select id, singular, plural, name_label, icon from app.custom_record_types
            where workspace_id = ${wsB} and key = 'fxprop_property'`,
      ),
    ).toEqual({
      ...kindBefore,
      singular: 'Rental',
      plural: 'Rentals',
      name_label: 'Street',
      icon: 'key',
    });
    expect(await memberSees(propertyId)).toEqual(['12 Main St']);
    expect(await one(sql`select notes from app.custom_records where id = ${propertyId}`)).toEqual({
      notes: 'Blue door (checked)',
    });
    expect(
      await count(
        sql`select count(*) as n from app.relationships where workspace_id = ${wsB} and b_custom_record_id = ${propertyId}`,
      ),
    ).toBe(1);
    expect(
      await one(sql`select status, last_error from app.scheduled_jobs where id = ${stale!.id}`),
    ).toEqual({ status: 'cancelled', last_error: 'addon_inactive' });
  });
});

describe('deleting its data (B)', () => {
  it('keeps core’s records and each record’s name, drops the rest, and keeps history’s lines without the details', async () => {
    await run(cmdsV2.uninstall, { workspaceId: wsB, addonId: 'fxprop' }, owner);
    await drain(wsB, W2);
    const touchedBefore = await count(
      sql`select count(*) as n from app.events where workspace_id = ${wsB} and addon_id = 'fxprop'`,
    );
    expect(touchedBefore).toBeGreaterThan(0);
    await run(
      cmdsV2.purge,
      { workspaceId: wsB, addonId: 'fxprop', confirmName: 'Property Management' },
      owner,
    );
    await drain(wsB, W2);
    await expectSettled(wsB, 'fxprop', 'purged');
    expect(
      await one(
        sql`select name, notes, purged_at is not null as purged, archived_at is not null as archived
            from app.custom_records where id = ${propertyId}`,
      ),
    ).toEqual({ name: '12 Main St', notes: null, purged: true, archived: true });
    expect(
      await count(
        sql`select count(*) as n from app.relationships r join app.relationship_types t on t.id = r.type_id
            where r.workspace_id = ${wsB} and t.addon_id = 'fxprop'`,
      ),
    ).toBe(0);
    // Core's: the person and the task about the property stay, and the task still says what it was about.
    expect(await count(sql`select count(*) as n from app.people where id = ${personId}`)).toBe(1);
    expect(await one(sql`select custom_record_id from app.tasks where id = ${taskId}`)).toEqual({
      custom_record_id: propertyId,
    });
    // History: every line kept, the add-on's details gone.
    expect(
      await count(
        sql`select count(*) as n from app.events where workspace_id = ${wsB} and addon_id = 'fxprop'`,
      ),
    ).toBe(touchedBefore);
    expect(
      await count(
        sql`select count(*) as n from app.events where workspace_id = ${wsB} and addon_id = 'fxprop'
            and not (payload ? '_redacted')`,
      ),
    ).toBe(0);
    expect(
      await count(
        sql`select count(*) as n from app.events where workspace_id = ${wsB} and event_type = 'addon.purged'`,
      ),
    ).toBe(1);
  });
});

describe('thirteen add-ons (C)', () => {
  it('sets them all up in one go, and an event reaches only the one that subscribes', async () => {
    // Property Management's setting up fails once: it, and Rent Collection that needs it, still end up on.
    propInstallFailures = 1;
    const started = performance.now();
    for (const addonId of [...TWELVE, 'fxrent'])
      await run(cmds.install, { workspaceId: wsC, addonId }, owner);
    await drain(wsC);
    const took = performance.now() - started;
    for (const addonId of [...TWELVE, 'fxrent']) await expectSettled(wsC, addonId, 'enabled');
    expect(propInstallFailures).toBe(0);
    expect(took).toBeLessThan(60_000);
    const tessInC = (
      await run<{ personId: string }>(
        personCreate,
        { workspaceId: wsC, firstName: 'Cleo', lastName: 'Busy' },
        member,
      )
    ).personId;
    await run(personUpdate, { workspaceId: wsC, personId: tessInC, lastName: 'Busier' }, member);
    await drain(wsC);
    expect(
      await rows(
        admin(),
        sql`select addon_id from app.scheduled_jobs where workspace_id = ${wsC} and kind = 'addon.deliver'`,
      ),
    ).toEqual([{ addon_id: 'fxprop' }]);
  });

  it('is put right by the hourly sweep when a move was never proved', async () => {
    await rows(
      admin(),
      sql`update app.addon_installations set verified_at = null where workspace_id = ${wsC} and addon_id = 'fxseo'`,
    );
    const runner = `vitest-addons-${randomUUID().slice(0, 8)}`;
    const [sweep] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.scheduled_jobs (kind, run_at, payload, locked_at, locked_by)
          values ('addon.sweep', now(), '{}', now(), ${runner}) returning id`,
    );
    await processJobs({ ...s, jobs: W1.jobs, workerId: runner, batchSize: 5, reservedOnly: true });
    expect(
      await count(
        sql`select count(*) as n from app.scheduled_jobs where kind = 'addon.reconcile' and status = 'pending'
            and dedupe_key = ${`addon:${wsC}:fxseo`}`,
      ),
    ).toBe(1);
    await drain(wsC);
    await expectSettled(wsC, 'fxseo', 'enabled');
    await rows(admin(), sql`delete from app.scheduled_jobs where id = ${sweep!.id}`);
  });

  it('lets an add-on whose code is gone leave, and deletes its data, all proved', async () => {
    // SEO Tools is retired: this version of HandsFreeOS has no code for it, and the business still has it on.
    const without: Catalog = FIXTURE_CATALOG.filter((m) => m.id !== 'fxseo');
    const gone = addonLifecycleCommands(without);
    const v3 = addonWorker(without, [propModule(fxprop), rentModule]);
    const W3: Worker = { handlers: v3.withAddons({}), jobs: v3.jobs };
    await run(gone.uninstall, { workspaceId: wsC, addonId: 'fxseo' }, owner);
    await drain(wsC, W3);
    await expectSettled(wsC, 'fxseo', 'uninstalled');
    await run(gone.purge, { workspaceId: wsC, addonId: 'fxseo', confirmName: 'fxseo' }, owner);
    await drain(wsC, W3);
    await expectSettled(wsC, 'fxseo', 'purged');
    // History says so, by the only name it has here now.
    expect(
      await rows(
        admin(),
        sql`select event_type, payload ->> 'name' as name from app.events
            where workspace_id = ${wsC} and event_type in ('addon.uninstalled', 'addon.purged')
              and payload ->> 'addonId' = 'fxseo' order by created_at`,
      ),
    ).toEqual([
      { event_type: 'addon.uninstalled', name: 'fxseo' },
      { event_type: 'addon.purged', name: 'fxseo' },
    ]);
  });
});
