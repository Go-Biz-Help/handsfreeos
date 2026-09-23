/**
 * M18 step 4 on the local database: every booked visit starts a job; a job moves along (on the way with a rough
 * origin, started, waiting on parts, done) with a note the customer may see; visits gather into a project; and a
 * job whose visits are all cancelled is cancelled.
 */
import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { events, jobs } from '@hfos/db/schema';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appointmentCancel,
  appointmentCreate,
  appointmentGet,
  jobAddVisit,
  jobSetStatus,
} from '../src/server';
import {
  admin,
  ask,
  customer,
  expectHfos,
  isoAt,
  makeCalendar,
  nextWeekday,
  run,
  setupTeam,
  type Team,
} from './calendar-helpers';

let t: Team;
let cal: { id: string };
const day = nextWeekday(2);

beforeAll(async () => {
  t = await setupTeam('jobs');
  cal = await makeCalendar(t, 'Repairs', {
    team: { members: [{ userId: t.priya.id }], assignment: 'round_robin' },
  });
});
afterAll(closeTestDbs);

const book = (personId: string, clock: string, title = 'Furnace repair') =>
  run(
    appointmentCreate,
    { workspaceId: t.wsId, calendarId: cal.id, startsAt: isoAt(day, clock), personId, title },
    t.owner,
  );
const jobRow = async (appointmentId: string) => {
  const [r] = await rows<{ job_id: string | null }>(
    admin(),
    sql`select job_id from app.appointments where id = ${appointmentId}`,
  );
  if (!r?.job_id) return null;
  const [j] = await admin().select().from(jobs).where(eq(jobs.id, r.job_id));
  return j ?? null;
};

describe('jobs', () => {
  it('starts one with every booked visit, for its customer', async () => {
    const ann = await customer(t, 'Ann');
    const visit = await book(ann, '09:00');
    const job = await jobRow(visit.appointmentId);
    expect(job).toMatchObject({ personId: ann, title: 'Furnace repair', status: 'scheduled' });
    const got = await ask(
      appointmentGet,
      { workspaceId: t.wsId, appointmentId: visit.appointmentId },
      t.member,
    );
    expect(got.appointment.job).toMatchObject({
      status: 'scheduled',
      visits: [{ appointmentId: visit.appointmentId, title: 'Furnace repair' }],
    });
  });

  it('moves along with a note, keeps only a rough origin, and says when nothing changed', async () => {
    const ben = await customer(t, 'Ben');
    const visit = await book(ben, '10:00');
    // A tech (a member) taps On my way from where they are.
    const onWay = await run(
      jobSetStatus,
      {
        workspaceId: t.wsId,
        appointmentId: visit.appointmentId,
        status: 'on_the_way',
        origin: { lat: 32.776654, lng: -96.796989 },
      },
      t.priya,
    );
    expect(onWay).toMatchObject({ status: 'on_the_way', changed: true });
    const [said] = await admin()
      .select({ payload: events.payload })
      .from(events)
      .where(
        and(eq(events.eventType, 'job.status_changed'), eq(events.entityId, visit.appointmentId)),
      );
    expect(said!.payload).toMatchObject({
      status: 'on_the_way',
      from: 'scheduled',
      notify: true,
      origin: { lat: 32.777, lng: -96.797 },
    });
    const waiting = await run(
      jobSetStatus,
      {
        workspaceId: t.wsId,
        appointmentId: visit.appointmentId,
        status: 'waiting_on_parts',
        customerNote: 'The blower motor is ordered; due Friday.',
      },
      t.priya,
    );
    expect(waiting.changed).toBe(true);
    expect(await jobRow(visit.appointmentId)).toMatchObject({
      status: 'waiting_on_parts',
      customerNote: 'The blower motor is ordered; due Friday.',
      statusChangedBy: t.priya.id,
    });
    const again = await run(
      jobSetStatus,
      { workspaceId: t.wsId, appointmentId: visit.appointmentId, status: 'waiting_on_parts' },
      t.priya,
    );
    expect(again.changed).toBe(false);
  });

  it('gathers a customer’s visits into one project, and removes the job a visit leaves empty', async () => {
    const cy = await customer(t, 'Cy');
    const first = await book(cy, '11:00', 'Duct replacement');
    const second = await book(cy, '14:00', 'Duct replacement, day 2');
    const project = (await jobRow(first.appointmentId))!;
    const leaving = (await jobRow(second.appointmentId))!;
    const got = await ask(
      appointmentGet,
      { workspaceId: t.wsId, appointmentId: first.appointmentId },
      t.owner,
    );
    expect(got.appointment.job!.otherVisits.map((v) => v.appointmentId)).toContain(
      second.appointmentId,
    );
    await run(
      jobAddVisit,
      { workspaceId: t.wsId, jobId: project.id, appointmentId: second.appointmentId },
      t.owner,
    );
    expect((await jobRow(second.appointmentId))!.id).toBe(project.id);
    expect(await admin().select().from(jobs).where(eq(jobs.id, leaving.id))).toEqual([]);
    const after = await ask(
      appointmentGet,
      { workspaceId: t.wsId, appointmentId: second.appointmentId },
      t.owner,
    );
    expect(after.appointment.job!.visits).toHaveLength(2);

    // Someone else's visit can't join.
    const dee = await customer(t, 'Dee');
    const other = await book(dee, '15:30');
    await expectHfos(
      () =>
        run(
          jobAddVisit,
          { workspaceId: t.wsId, jobId: project.id, appointmentId: other.appointmentId },
          t.owner,
        ),
      'other_customer',
    );

    // Cancelling one visit of the project leaves it open; cancelling the last cancels it.
    await run(
      appointmentCancel,
      { workspaceId: t.wsId, appointmentId: first.appointmentId, notify: false },
      t.owner,
    );
    expect((await jobRow(second.appointmentId))!.status).toBe('scheduled');
    await run(
      appointmentCancel,
      { workspaceId: t.wsId, appointmentId: second.appointmentId, notify: false },
      t.owner,
    );
    expect((await jobRow(second.appointmentId))!.status).toBe('cancelled');
    await expectHfos(
      () =>
        run(
          jobSetStatus,
          { workspaceId: t.wsId, appointmentId: second.appointmentId, status: 'on_the_way' },
          t.priya,
        ),
      'visit_cancelled',
    );
  });
});
