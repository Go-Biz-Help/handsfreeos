/**
 * Concurrency on parallel connections: the advisory locks, the exclusion constraint, sorted staff rows and
 * the one retry keep every booking rule when many people press Book at once.
 */
import { rows, sql } from '@hfos/db/client';
import { createDb, type DbHandle } from '@hfos/db/client';
import { closeTestDbs, testEnv } from '@hfos/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { HfosError } from '../src/errors';
import { executeCommand } from '../src/kernel/execute';
import type { SlotOut } from '../src/schemas/calendar';
import { appointmentCreate, resourceCreate, sessionPublish } from '../src/server';
import {
  admin,
  at,
  bookOnline,
  human,
  isoAt,
  makeCalendar,
  meta,
  MIN,
  nextWeekday,
  run,
  setupTeam,
  type Team,
} from './calendar-helpers';

let t: Team;
let api: DbHandle;
let worker: DbHandle;
beforeAll(async () => {
  t = await setupTeam('calconc');
  api = createDb(testEnv().apiDbUrl, { max: 24, applicationName: 'hfos-test-calendar-api' });
  worker = createDb(testEnv().workerDbUrl, {
    max: 24,
    applicationName: 'hfos-test-calendar-worker',
  });
});
afterAll(async () => {
  await api?.close();
  await worker?.close();
  await closeTestDbs();
});

async function settle(jobs: Promise<unknown>[], rule = 'slot_taken') {
  const results = await Promise.allSettled(jobs);
  const failed = results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => r.reason as unknown);
  for (const e of failed) {
    // Nothing but "taken" (or "full"): no deadlock, no exclusion error, no 500 reaches the caller.
    expect(e).toBeInstanceOf(HfosError);
    expect((e as HfosError).rule, (e as Error).message).toBe(rule);
  }
  return { ok: results.filter((r) => r.status === 'fulfilled').length, failed };
}

/** A public calendar with no staff: 20-minute sessions every 10 minutes on a bed, 10 minutes' cleanup. */
const bedsOnly = (resourceId: string) => ({
  public: true,
  team: { members: [], assignment: 'none' as const },
  resources: { required: [{ resourceId }] },
  durations: { minutes: [20], step: 10 },
  buffers: { after: 10 },
});
const held = async (resourceId: string) =>
  (
    await rows<{ n: number; staff: number }>(
      admin(),
      sql`select coalesce(sum(r.quantity), 0)::int as n,
            (select count(*)::int from app.appointment_staff s
              join app.appointment_resources x on x.appointment_id = s.appointment_id
              where x.resource_id = ${resourceId}) as staff
          from app.appointment_resources r where r.resource_id = ${resourceId} and r.active`,
    )
  )[0]!;

it('20 customers booking the same time: exactly 1 gets it, the rest get nearby times', async () => {
  const cal = await makeCalendar(t, 'Race', {
    public: true,
    team: { members: [{ userId: t.priya.id }] },
  });
  const start = isoAt(nextWeekday(2), '09:00');
  const { ok, failed } = await settle(
    Array.from({ length: 20 }, () => bookOnline(t, cal.id, start, {}, worker.db)),
  );
  expect(ok).toBe(1);
  expect(failed).toHaveLength(19);
  const { slots } = (failed[0] as HfosError).details as { slots: SlotOut[] };
  expect(slots.length).toBeGreaterThan(0);
  expect(slots.length).toBeLessThanOrEqual(6);
  expect(slots.map((s) => s.startsAt)).not.toContain(start);
  const [count] = await rows<{ n: number }>(
    admin(),
    sql`select count(*)::int as n from app.appointments where calendar_id = ${cal.id}`,
  );
  expect(count!.n).toBe(1);
});

it('20 customers joining a session with 8 seats: exactly 8 get in', async () => {
  const cal = await makeCalendar(t, 'Eight seats', {
    public: true,
    team: { members: [{ userId: t.owner.id }] },
    schedule: { mode: 'sessions' },
    capacity: { seats: 8 },
  });
  const day = nextWeekday(3);
  const session = await run(
    sessionPublish,
    {
      workspaceId: t.wsId,
      calendarId: cal.id,
      startsAt: isoAt(day, '10:00'),
      userIds: [t.owner.id],
    },
    t.owner,
  );
  const { ok, failed } = await settle(
    Array.from({ length: 20 }, () =>
      bookOnline(t, cal.id, isoAt(day, '10:00'), { sessionId: session.appointmentId }, worker.db),
    ),
  );
  expect(ok).toBe(8);
  expect(failed).toHaveLength(12);
  const [row] = await rows<{ seats_taken: number; booked: number }>(
    admin(),
    sql`select a.seats_taken,
          (select count(*)::int from app.appointment_attendees x
            where x.appointment_id = a.id and x.status = 'booked') as booked
        from app.appointments a where a.id = ${session.appointmentId}`,
  );
  expect(row).toEqual({ seats_taken: 8, booked: 8 });
});

it('a quantity-2 resource shared by two calendars: exactly 2 bookings hold it', async () => {
  const lift = await run(
    resourceCreate,
    { workspaceId: t.wsId, name: 'Shared lift', quantity: 2 },
    t.owner,
  );
  const needs = { required: [{ resourceId: lift.resourceId }] };
  const a = await makeCalendar(t, 'Lift A', {
    public: true,
    team: { members: [{ userId: t.priya.id }, { userId: t.marco.id }], assignment: 'round_robin' },
    resources: needs,
  });
  const b = await makeCalendar(t, 'Lift B', {
    public: true,
    team: { members: [{ userId: t.owner.id }, { userId: t.member.id }], assignment: 'round_robin' },
    resources: needs,
  });
  const start = isoAt(nextWeekday(4), '13:00');
  const { ok } = await settle(
    Array.from({ length: 5 }).flatMap(() => [
      bookOnline(t, a.id, start, {}, worker.db),
      bookOnline(t, b.id, start, {}, worker.db),
    ]),
  );
  expect(ok).toBe(2);
  const [held] = await rows<{ n: number }>(
    admin(),
    sql`select coalesce(sum(quantity), 0)::int as n from app.appointment_resources
        where resource_id = ${lift.resourceId} and active`,
  );
  expect(held!.n).toBe(2);
});

it('10 customers booking one time on a calendar with no staff and four beds: exactly 4 get one', async () => {
  const beds = await run(
    resourceCreate,
    { workspaceId: t.wsId, name: 'Four beds', quantity: 4 },
    t.owner,
  );
  const cal = await makeCalendar(t, 'Beds alone', bedsOnly(beds.resourceId));
  const start = isoAt(nextWeekday(2), '10:00');
  const { ok, failed } = await settle(
    Array.from({ length: 10 }, () => bookOnline(t, cal.id, start, {}, worker.db)),
    'resource_full',
  );
  expect(ok).toBe(4);
  expect(failed).toHaveLength(6);
  expect(await held(beds.resourceId)).toEqual({ n: 4, staff: 0 });
});

it('two calendars with no staff sharing four beds: still 4 bookings between them', async () => {
  const beds = await run(
    resourceCreate,
    { workspaceId: t.wsId, name: 'Shared beds', quantity: 4 },
    t.owner,
  );
  const a = await makeCalendar(t, 'Beds A', bedsOnly(beds.resourceId));
  const b = await makeCalendar(t, 'Beds B', bedsOnly(beds.resourceId));
  const start = isoAt(nextWeekday(3), '10:00');
  const { ok } = await settle(
    Array.from({ length: 5 }).flatMap(() => [
      bookOnline(t, a.id, start, {}, worker.db),
      bookOnline(t, b.id, start, {}, worker.db),
    ]),
    'resource_full',
  );
  expect(ok).toBe(4);
  expect(await held(beds.resourceId)).toEqual({ n: 4, staff: 0 });
});

it('a staggered start is booked while a bed is free, and only then', async () => {
  const beds = await run(
    resourceCreate,
    { workspaceId: t.wsId, name: 'Staggered beds', quantity: 4 },
    t.owner,
  );
  const cal = await makeCalendar(t, 'Beds staggered', bedsOnly(beds.resourceId));
  const day = nextWeekday(4);
  for (let i = 0; i < 3; i++) await bookOnline(t, cal.id, isoAt(day, '10:00'), {}, worker.db);
  // At 10:10 three beds are in use: ten customers race for the fourth.
  const { ok } = await settle(
    Array.from({ length: 10 }, () => bookOnline(t, cal.id, isoAt(day, '10:10'), {}, worker.db)),
    'resource_full',
  );
  expect(ok).toBe(1);
  // At 10:20 all four are in use or being cleaned.
  await expect(bookOnline(t, cal.id, isoAt(day, '10:20'), {}, worker.db)).rejects.toMatchObject({
    rule: 'resource_full',
  });
  expect(await held(beds.resourceId)).toEqual({ n: 4, staff: 0 });
});

it(
  'opposite-order collective pairs 200 times: one wins each time and no deadlock surfaces',
  { timeout: 240_000 },
  async () => {
    const pair = (members: string[]) => ({
      public: true,
      team: {
        members: members.map((userId) => ({ userId, required: true })),
        assignment: 'collective' as const,
      },
    });
    const x = await makeCalendar(t, 'Pair one', pair([t.priya.id, t.marco.id]));
    const y = await makeCalendar(t, 'Pair two', pair([t.marco.id, t.priya.id]));
    const base = at(nextWeekday(1, 14), '00:00');
    const book = (calendarId: string, startsAt: string) =>
      executeCommand(
        api.db,
        appointmentCreate,
        {
          workspaceId: t.wsId,
          calendarId,
          startsAt,
          durationMinutes: 30,
          acknowledgeWarnings: true,
        },
        human(t.owner),
        meta(),
      );
    let won = 0;
    for (let i = 0; i < 200; i++) {
      const startsAt = new Date(base + i * 30 * MIN).toISOString();
      const [first, second] = i % 2 ? [y, x] : [x, y];
      const { ok } = await settle([book(first.id, startsAt), book(second.id, startsAt)]);
      expect(ok).toBe(1);
      won += ok;
    }
    expect(won).toBe(200);
  },
);
