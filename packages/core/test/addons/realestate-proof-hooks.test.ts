/**
 * Real Estate Agent, round two, step 13: the duty hooks. Round two's records add proof to the catalog duties they
 * answer, once, and never finish one: a tour is B-05's appointment (taken back when the tour is canceled), a client's
 * feedback is B-08's note, an offer is linked to B-11 and its loss is B-13's note, and the client's signed
 * agreement is X-01's document.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realestateAddonServer } from '../../src/addons/realestate/server';
import {
  executeCommand,
  personCreate,
  scheduleSet,
  type CommandDef,
  type HumanActor,
} from '../../src/server';
import { isoAt, makeCalendar, nextWeekday, WEEKDAYS, type Team } from '../calendar-helpers';
import { realestateBusiness } from './realestate-fixture';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const op = (name: string) => realestateAddonServer.commands!.find((x) => x.name === name)!;
const run = (name: string, input: Record<string, unknown>, who: TestUser = agent): Promise<Any> =>
  executeCommand(
    api(),
    op(name) as CommandDef,
    { workspaceId: ws, ...input },
    human(who),
    meta(),
  ).then((r) => r.output);

let owner: TestUser;
let agent: TestUser;
let ws: string;
let client: string;
let deal: string;
let home: string;

/** The proof on a duty, by its key: what kind, still counting or taken back, and what it says. */
const proofOn = (key: string) =>
  rows<{
    kind: string;
    withdrawn: boolean;
    body: string | null;
    ref: string | null;
    appointment: string | null;
  }>(
    admin(),
    sql`select e.kind, e.withdrawn_at is not null as withdrawn, e.body, e.ref_kind as ref,
          e.appointment_id as appointment
        from addon_realestate.duty_evidence e join addon_realestate.duties d on d.id = e.duty_id
        where d.deal_record_id = ${deal} and d.duty_key = ${key} order by e.added_at`,
  );
const statusOf = async (key: string) =>
  (
    await rows<{ status: string }>(
      admin(),
      sql`select status from addon_realestate.duties where deal_record_id = ${deal} and duty_key = ${key}
          order by pass desc limit 1`,
    )
  )[0]?.status;

beforeAll(async () => {
  [owner, agent] = await Promise.all([
    createTestUser('rph-owner'),
    createTestUser('rph-agent', { fullName: 'Sam Rivera' }),
  ]);
  ws = await realestateBusiness(owner, 'Proof Realty');
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
  client = (
    await executeCommand(
      api(),
      personCreate,
      { workspaceId: ws, firstName: 'Linh', lastName: 'Nguyen' },
      human(agent),
      meta(),
    )
  ).output.personId;
  deal = (
    await run('realestate.deal.open', {
      side: 'buyer',
      name: 'Nguyen purchase',
      clientPersonId: client,
      stage: 'touring',
    })
  ).dealId;
  home = (await run('realestate.home.add', { dealId: deal, address: '418 Maple Ave, Austin, TX' }))
    .homeId;
}, 120_000);

afterAll(closeTestDbs);

describe('round two’s records as proof', () => {
  it('a tour is B-05’s appointment, once, and taken back when it’s canceled', async () => {
    const tour = await run(
      'realestate.tour.plan',
      {
        dealId: deal,
        homeIds: [home],
        startsAt: isoAt(nextWeekday(2), '10:00'),
        agentUserId: agent.id,
        notifyClient: false,
        exception: { reason: 'Signed on paper' },
      },
      owner,
    );
    expect(await proofOn('B-05')).toEqual([
      expect.objectContaining({
        kind: 'appointment',
        withdrawn: false,
        appointment: tour.appointmentId,
      }),
    ]);
    // Proof never finishes a duty on its own.
    expect(await statusOf('B-05')).toBe('not_started');
    await run('realestate.tour.cancel', { tourId: tour.tourId, notifyClient: false });
    expect(await proofOn('B-05')).toEqual([
      expect.objectContaining({ kind: 'appointment', withdrawn: true }),
    ]);
  });

  it('a client’s feedback on a home seen is B-08’s note', async () => {
    const [t] = await rows<{ id: string }>(
      admin(),
      sql`insert into addon_realestate.tours (workspace_id, deal_record_id, starts_at, ends_at, status)
          values (${ws}, ${deal}, now() - interval '2 hours', now() - interval '1 hour', 'done') returning id`,
    );
    const [s] = await rows<{ id: string }>(
      admin(),
      sql`insert into addon_realestate.tour_stops (workspace_id, deal_record_id, tour_id, home_id, position, status,
            visited_at)
          values (${ws}, ${deal}, ${t!.id}, ${home}, 1, 'visited', now()) returning id`,
    );
    await run('realestate.tour.feedback', {
      stopId: s!.id,
      personId: client,
      interest: 'love',
      words: 'The kitchen!',
    });
    await run('realestate.tour.feedback', {
      stopId: s!.id,
      personId: client,
      interest: 'love',
      words: 'The kitchen!',
    });
    expect(await proofOn('B-08')).toEqual([
      expect.objectContaining({
        kind: 'note',
        body: 'Linh Nguyen on 418 Maple Ave, Austin, TX: Loved it. “The kitchen!”',
      }),
    ]);
  });

  it('an offer is linked to B-11, and its loss is B-13’s note', async () => {
    await run('realestate.deal.move_stage', { dealId: deal, stage: 'offer' });
    const { offerId } = await run('realestate.offer.start', {
      dealId: deal,
      homeId: home,
      terms: { priceCents: 40_100_000 },
    });
    expect(await proofOn('B-11')).toEqual([
      expect.objectContaining({
        kind: 'record',
        ref: 'offer',
        body: 'Offer 1 on 418 Maple Ave, Austin, TX at $401,000',
      }),
    ]);
    await run('realestate.offer.record_response', { offerId, outcome: 'declined' });
    expect(await proofOn('B-13')).toEqual([
      expect.objectContaining({
        kind: 'note',
        body: 'The seller declined the offer on 418 Maple Ave, Austin, TX. Last version 1: $401,000.',
      }),
    ]);
  });

  it('the client’s signed agreement is X-01’s document', async () => {
    const { taskId } = await run('realestate.client_task.add', {
      dealId: deal,
      preset: 'buyer_agreement',
    });
    const [f] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.files (workspace_id, record_type, record_id, name, mime_type, size_bytes, status,
            object_path, uploaded_by_person_id)
          values (${ws}, 'custom_record', ${deal}, 'letter.pdf', 'application/pdf', 2048, 'ready',
            ${`${ws}/${randomUUID()}`}, ${client})
          returning id`,
    );
    await run('realestate.client_task.mark_done', {
      taskId,
      personId: client,
      fileId: f!.id,
      note: 'She emailed it',
    });
    expect(await proofOn('X-01')).toEqual([
      expect.objectContaining({ kind: 'document', withdrawn: false }),
    ]);
    expect(await statusOf('X-01')).not.toBe('completed');
  });
});
