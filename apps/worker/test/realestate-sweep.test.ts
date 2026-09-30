/**
 * Real Estate Agent's sweep (step 10): each open duty's alert where the ladder says (a Home card a week out, a push
 * days out, at risk and asking to be acknowledged once late, critical at any hour), the deal's health kept, a rung
 * reached before the add-on was turned on caught up as a Home card only, an acknowledged duty's card quiet, and a
 * finished duty's card gone.
 */
import { randomUUID } from 'node:crypto';
import {
  ADDON_SERVER_MODULES,
  executeCommand,
  type CommandDef,
  type HumanActor,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realestateBusiness } from '../../../packages/core/test/addons/realestate-fixture';
import { addonJobs, withAddons } from '../src/addons/index';
import { scheduleAddonJob } from '../src/addons/queue';
import { attentionJobs, withAttention } from '../src/attention/index';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { pushJobs } from '../src/push/send';
import { testServices, type TestServices } from './helpers';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const realestate = ADDON_SERVER_MODULES.find((m) => m.manifest.id === 'realestate')!;
const run = (who: TestUser, name: string, input: Record<string, unknown>) =>
  executeCommand(
    api(),
    realestate.commands!.find((c) => c.name === name) as CommandDef,
    { workspaceId: ws, ...input },
    human(who),
    { correlationId: randomUUID(), channel: 'test' },
  ).then((r) => r.output as Record<string, string>);

const handlers = withAddons(withAttention({}));
const jobs = { ...attentionJobs, ...pushJobs, ...addonJobs };
const DAY = 86_400_000;
/** A date n days from today where the business is (Chicago, the default). */
const dayFromToday = (n: number) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(Date.now() + n * DAY);

let s: TestServices;
let owner: TestUser;
let agent: TestUser;
let ws: string;
let org: string;
let deal: string;

async function drain() {
  for (let i = 0; i < 30; i++) {
    const runner = `vitest-sweep-${randomUUID().slice(0, 8)}`;
    await rows(
      admin(),
      sql`update app.outbox set locked_at = now(), locked_by = ${runner}
          where status = 'pending' and workspace_id = ${ws}`,
    );
    const outbox = await processOnce({
      ...s,
      handlers,
      workerId: runner,
      batchSize: 100,
      reservedOnly: true,
    });
    await rows(
      admin(),
      sql`update app.scheduled_jobs set locked_at = now(), locked_by = ${runner}
          where status = 'pending' and workspace_id = ${ws} and run_at <= now()`,
    );
    const done = await processJobs({
      ...s,
      jobs,
      workerId: runner,
      batchSize: 100,
      reservedOnly: true,
    });
    if (outbox.claimed === 0 && done.claimed === 0) return;
  }
  throw new Error('the worker never settled');
}

/** Arms the sweep as turning the add-on on does, as of `armedAt`, and runs everything due. */
async function sweepNow(armedAt: number) {
  await rows(
    admin(),
    sql`delete from app.scheduled_jobs where workspace_id = ${ws} and kind = 'realestate.sweep'`,
  );
  const [inst] = await rows<{ generation: number }>(
    admin(),
    sql`select generation from app.addon_installations where workspace_id = ${ws} and addon_id = 'realestate'`,
  );
  await asWorker(s.db, { workspaceId: ws, organizationId: org }, (tx) =>
    scheduleAddonJob(
      tx,
      { id: 'realestate', generation: inst!.generation },
      {
        kind: 'realestate.sweep',
        dedupeKey: `realestate.sweep:${ws}`,
        runAt: new Date(),
        payload: { armedAt },
        workspaceId: ws,
        organizationId: org,
      },
    ),
  );
  await drain();
}

const add = (title: string, dueIn: number, materiality = 'standard') =>
  run(agent, 'realestate.duty.add', {
    dealId: deal,
    title,
    materiality,
    dueDate: dayFromToday(dueIn),
  }).then((o) => o.dutyId!);

const alertOf = (dutyId: string) =>
  rows<{
    severity: string;
    needs_ack: boolean;
    cleared: boolean;
    notified: boolean;
    acknowledged: boolean;
    audience_user_ids: string[];
  }>(
    admin(),
    sql`select severity, needs_ack, cleared_at is not null as cleared, notified_at is not null as notified,
          acknowledged_at is not null as acknowledged, audience_user_ids
        from app.addon_alerts
        where workspace_id = ${ws} and addon_id = 'realestate' and key = ${`duty:${dutyId}`}`,
  ).then((r) => r[0]);

beforeAll(async () => {
  s = testServices();
  [owner, agent] = await Promise.all([
    createTestUser('sweep-owner'),
    createTestUser('sweep-agent'),
  ]);
  ws = await realestateBusiness(owner, 'Lagoon Realty');
  const [w] = await rows<{ organization_id: string }>(
    admin(),
    sql`select organization_id from app.workspaces where id = ${ws}`,
  );
  org = w!.organization_id;
  await admin()
    .insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: agent.id, role: 'member' });
  deal = (await run(agent, 'realestate.deal.open', { side: 'buyer', name: 'Lagoon purchase' }))
    .dealId!;
}, 90_000);

afterAll(closeTestDbs);

describe('The sweep', () => {
  let week: string;
  let days: string;
  let late: string;
  let critical: string;

  it('raises each duty’s alert on its rung, and keeps the deal’s health', async () => {
    week = await add('Order the survey', 5);
    days = await add('Book the appraisal', 2, 'material');
    late = await add('Send the buyer the HOA packet', -10);
    critical = await add('Get the loan approval letter', -10, 'material');
    await sweepNow(0);
    expect(await alertOf(week)).toMatchObject({
      severity: 'info',
      notified: false,
      cleared: false,
    });
    expect(await alertOf(days)).toMatchObject({ severity: 'attention', needs_ack: false });
    const lateAlert = await alertOf(late);
    expect(lateAlert).toMatchObject({ severity: 'at_risk', needs_ack: true });
    expect(lateAlert!.audience_user_ids).toContain(agent.id);
    // Critical is told at once, at any hour, to everyone who sees the deal.
    expect(await alertOf(critical)).toMatchObject({
      severity: 'critical',
      needs_ack: true,
      notified: true,
      audience_user_ids: [],
    });
    const [d] = await rows<{ health: string }>(
      admin(),
      sql`select health from addon_realestate.deals where record_id = ${deal}`,
    );
    expect(d!.health).toBe('red');
    const [next] = await rows<{ later: boolean }>(
      admin(),
      sql`select run_at > now() + interval '10 minutes' as later from app.scheduled_jobs
          where workspace_id = ${ws} and kind = 'realestate.sweep' and status = 'pending'`,
    );
    expect(next!.later).toBe(true);
  });

  it('catches up quietly what came due before it was turned on', async () => {
    const whileOff = await add('Confirm the title search', -10, 'critical');
    await sweepNow(Date.now());
    expect(await alertOf(whileOff)).toMatchObject({ severity: 'critical', notified: false });
  });

  it('quiets a card when the duty is acknowledged, and clears it when the duty is done', async () => {
    await run(agent, 'realestate.duty.acknowledge', { dutyId: late });
    expect(await alertOf(late)).toMatchObject({ acknowledged: true, cleared: false });
    await run(agent, 'realestate.duty.complete', { dutyId: days });
    await drain();
    expect(await alertOf(days)).toMatchObject({ cleared: true });
    // The next sweep leaves the acknowledged one as it was, and the finished one gone.
    await sweepNow(0);
    expect(await alertOf(late)).toMatchObject({ acknowledged: true, cleared: false });
    expect(await alertOf(days)).toMatchObject({ cleared: true });
  });
});
