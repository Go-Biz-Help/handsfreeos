/**
 * Real Estate Agent, round two, step 8, in the worker: a tour is an appointment on the calendar, so moving or
 * canceling the appointment there moves or cancels the tour, with a line in the deal's history saying so. A change
 * the tour made itself comes back to the worker and changes nothing more.
 */
import { randomUUID } from 'node:crypto';
import {
  ADDON_SERVER_MODULES,
  appointmentCancel,
  appointmentReschedule,
  executeCommand,
  executeQuery,
  personCreate,
  scheduleSet,
  type CommandDef,
  type HumanActor,
  type QueryDef,
} from '@hfos/core/server';
import { addDays } from '@hfos/core';
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isoAt,
  makeCalendar,
  nextWeekday,
  WEEKDAYS,
  type Team,
} from '../../../packages/core/test/calendar-helpers';
import { realestateBusiness } from '../../../packages/core/test/addons/realestate-fixture';
import { addonJobs, withAddons } from '../src/addons/index';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
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
const op = (name: string) =>
  [...realestate.commands!, ...realestate.queries!].find((c) => c.name === name)!;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const run = (who: TestUser, name: string, input: Record<string, unknown>): Promise<Any> =>
  executeCommand(
    api(),
    op(name) as CommandDef,
    { workspaceId: ws, ...input },
    human(who),
    meta(),
  ).then((r) => r.output);
const ask = (name: string, input: Record<string, unknown>): Promise<Any> =>
  executeQuery(api(), op(name) as QueryDef, { workspaceId: ws, ...input }, human(agent), meta());

const handlers = withAddons({});
const jobs = { ...addonJobs };

let s: TestServices;
let owner: TestUser;
let agent: TestUser;
let ws: string;
let deal: string;
let home: string;
const day = nextWeekday(3);

async function drain() {
  for (let i = 0; i < 30; i++) {
    const runner = `vitest-tours-${randomUUID().slice(0, 8)}`;
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
          where status = 'pending' and workspace_id = ${ws} and run_at <= now()
            and kind <> 'realestate.sweep'`,
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

const lines = async (what: string) =>
  rows<{ after: Record<string, unknown> }>(
    admin(),
    sql`select after from addon_realestate.deal_history
        where deal_record_id = ${deal} and what = ${what} order by at`,
  );

/** A tour the owner lets through (no agreement on file), led by the agent. */
const plan = (startsAt: string) =>
  run(owner, 'realestate.tour.plan', {
    dealId: deal,
    homeIds: [home],
    startsAt,
    agentUserId: agent.id,
    notifyClient: false,
    exception: { reason: 'Signed on paper at the office' },
  });

beforeAll(async () => {
  s = testServices();
  [owner, agent] = await Promise.all([
    createTestUser('rtw-owner', { fullName: 'Dana Owner' }),
    createTestUser('rtw-agent', { fullName: 'Sam Rivera' }),
  ]);
  ws = await realestateBusiness(owner, 'Tour Follow Realty');
  await admin()
    .insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: agent.id, role: 'member' });
  await executeCommand(
    api(),
    scheduleSet,
    { workspaceId: ws, ownerId: agent.id, weekly: WEEKDAYS },
    human(owner),
    meta(),
  );
  const [w] = await rows<{ org: string }>(
    admin(),
    sql`select organization_id as org from app.workspaces where id = ${ws}`,
  );
  await makeCalendar(
    { owner, wsId: ws, scope: { workspaceId: ws, organizationId: w!.org } } as unknown as Team,
    'Showings',
    { team: { members: [{ userId: agent.id }] } },
  );
  const client = (
    await executeCommand(
      api(),
      personCreate,
      { workspaceId: ws, firstName: 'Linh', lastName: 'Nguyen' },
      human(agent),
      meta(),
    )
  ).output.personId;
  deal = (
    await run(agent, 'realestate.deal.open', {
      side: 'buyer',
      name: 'Nguyen purchase',
      clientPersonId: client,
    })
  ).dealId;
  home = (
    await run(agent, 'realestate.home.add', { dealId: deal, address: '418 Maple Ave, Austin, TX' })
  ).homeId;
  await drain();
}, 120_000);

afterAll(closeTestDbs);

describe('a tour’s appointment changed on the calendar', () => {
  it('moves the tour with it, and says so in the deal’s history', async () => {
    const out = await plan(isoAt(day, '10:00'));
    await drain();
    const later = isoAt(addDays(day, 1), '13:00');
    await executeCommand(
      api(),
      appointmentReschedule,
      { workspaceId: ws, appointmentId: out.appointmentId, startsAt: later, notify: false },
      human(agent),
      meta(),
    );
    await drain();
    const tour = (await ask('realestate.tours', { dealId: deal })).tours.find(
      (t: { id: string }) => t.id === out.tourId,
    );
    expect(tour.startsAt).toBe(later);
    const moved = await lines('tour_moved');
    expect(moved).toHaveLength(1);
    expect(moved[0]!.after).toMatchObject({ by: 'the calendar' });
  });

  it('changes nothing more when the tour moved it itself', async () => {
    const tour = (await ask('realestate.tours', { dealId: deal })).tours[0];
    await run(agent, 'realestate.tour.reschedule', {
      tourId: tour.id,
      startsAt: isoAt(addDays(day, 1), '15:00'),
      notifyClient: false,
    });
    await drain();
    const moved = await lines('tour_moved');
    expect(moved).toHaveLength(2);
    expect(moved[1]!.after.by).toBeUndefined();
  });

  it('cancels the tour with it', async () => {
    const tour = (await ask('realestate.tours', { dealId: deal })).tours[0];
    await executeCommand(
      api(),
      appointmentCancel,
      {
        workspaceId: ws,
        appointmentId: tour.appointmentId,
        reason: 'Seller asked to move it',
        notify: false,
      },
      human(agent),
      meta(),
    );
    await drain();
    const all = (await ask('realestate.tours', { dealId: deal, includeCanceled: true })).tours;
    expect(all.find((t: { id: string }) => t.id === tour.id)).toMatchObject({
      status: 'canceled',
      canceledReason: 'Seller asked to move it',
    });
    const gone = await lines('tour_canceled');
    expect(gone).toHaveLength(1);
    expect(gone[0]!.after).toMatchObject({ by: 'the calendar' });
  });
});
