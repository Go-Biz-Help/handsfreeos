/**
 * One person on several calendars of a business: a booking on any of them takes that time on all the others,
 * and a calendar with other people still offers it with whoever is free.
 */
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { appointmentCreate, calendarAvailability } from '../src/server';
import {
  ask,
  bookOnline,
  expectHfos,
  isoAt,
  makeCalendar,
  nextWeekday,
  run,
  setupTeam,
  type Team,
} from './calendar-helpers';

let t: Team;
beforeAll(async () => {
  t = await setupTeam('calshare');
});
afterAll(closeTestDbs);

/** Each start time that day with the people free then. */
const openOn = async (calendarId: string, day: string) => {
  const { slots } = await ask(
    calendarAvailability,
    { workspaceId: t.wsId, calendarId, from: isoAt(day, '00:00'), to: isoAt(day, '23:59') },
    t.owner,
  );
  return new Map(slots.map((s) => [s.startsAt, [...s.userIds].sort()]));
};

it('a booking on one calendar takes that time on every other calendar the person is on', async () => {
  const day = nextWeekday(2);
  const P = t.priya.id;
  const M = t.marco.id;
  const visits = await makeCalendar(t, 'Priya’s visits', {
    public: true,
    team: { members: [{ userId: P }], assignment: 'fixed' },
  });
  const calls = await makeCalendar(t, 'Priya’s calls', {
    public: true,
    team: { members: [{ userId: P }], assignment: 'fixed' },
  });
  const team = await makeCalendar(t, 'Team visits', {
    public: true,
    team: { members: [{ userId: P }, { userId: M }], assignment: 'round_robin' },
  });
  const together = await makeCalendar(t, 'Both of us', {
    public: true,
    team: { members: [{ userId: P }, { userId: M }], assignment: 'collective' },
  });

  const before = await openOn(team.id, day);
  expect(before.get(isoAt(day, '10:00'))).toEqual([P, M].sort());

  // A customer books Priya on her visits calendar from 10 to 11.
  expect((await bookOnline(t, visits.id, isoAt(day, '10:00'))).userIds).toEqual([P]);

  // Her other calendar no longer offers anything that overlaps it, and keeps the rest.
  const callTimes = await openOn(calls.id, day);
  for (const clock of ['09:30', '10:00', '10:30'])
    expect(callTimes.has(isoAt(day, clock))).toBe(false);
  for (const clock of ['09:00', '11:00']) expect(callTimes.get(isoAt(day, clock))).toEqual([P]);
  await expectHfos(() => bookOnline(t, calls.id, isoAt(day, '10:00')), 'slot_taken', 409);

  // A calendar she shares still offers 10:00, with Marco only; one that needs both of them doesn't.
  expect((await openOn(team.id, day)).get(isoAt(day, '10:00'))).toEqual([M]);
  expect((await openOn(together.id, day)).has(isoAt(day, '10:00'))).toBe(false);
  expect((await bookOnline(t, team.id, isoAt(day, '10:00'))).userIds).toEqual([M]);

  // Now both are taken at 10:00, so the shared calendar has nobody left then.
  expect((await openOn(team.id, day)).has(isoAt(day, '10:00'))).toBe(false);
  expect((await openOn(team.id, day)).get(isoAt(day, '11:00'))).toEqual([P, M].sort());
});

it('a booking made by hand counts on the person’s other calendars too', async () => {
  const day = nextWeekday(3);
  const P = t.priya.id;
  const M = t.marco.id;
  const office = await makeCalendar(t, 'Office', {
    team: { members: [{ userId: P }], assignment: 'fixed' },
  });
  const online = await makeCalendar(t, 'Online booking', {
    public: true,
    team: { members: [{ userId: P }, { userId: M }], assignment: 'first_available' },
  });
  await run(
    appointmentCreate,
    { workspaceId: t.wsId, calendarId: office.id, startsAt: isoAt(day, '14:00'), userIds: [P] },
    t.owner,
  );
  const open = await openOn(online.id, day);
  expect(open.get(isoAt(day, '13:00'))).toEqual([P, M].sort());
  expect(open.get(isoAt(day, '14:00'))).toEqual([M]);
  // First available would pick Priya, but she's busy then, so Marco gets it.
  expect((await bookOnline(t, online.id, isoAt(day, '14:00'))).userIds).toEqual([M]);
});
