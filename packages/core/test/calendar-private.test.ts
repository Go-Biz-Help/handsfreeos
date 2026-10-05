/**
 * A private record's appointments show only as busy (Real Estate round two, step 1), through the calendar's own
 * queries: a member who isn't on a deal doesn't get its tour in the calendar, sees only that the agent is busy then,
 * isn't offered that time, and can't book the agent over it. The people on the deal, and owners, see the tour.
 */
import { createTestUser, closeTestDbs, type TestUser } from '@hfos/db/testing';
import { rows, sql } from '@hfos/db/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '../src/calendar/index';
import {
  appointmentCreate,
  appointmentList,
  calendarAvailability,
  customRecordCreate,
  scheduleSet,
  scheduleTeam,
} from '../src/server';
import {
  admin,
  ask,
  expectHfos,
  isoAt,
  makeCalendar,
  nextWeekday,
  run,
  WEEKDAYS,
  type Team,
} from './calendar-helpers';
import { realestateBusiness } from './addons/realestate-fixture';

let owner: TestUser;
let agent: TestUser;
let member: TestUser;
let wsId: string;
let calendarId: string;
let deal: string;
let tour: string;
const day = nextWeekday(2);
const span = { from: isoAt(day, '00:00'), to: isoAt(addDays(day, 1), '00:00') };

beforeAll(async () => {
  [owner, agent, member] = await Promise.all([
    createTestUser('tour-owner', { fullName: 'Dana Owner' }),
    createTestUser('tour-agent', { fullName: 'Sam Agent' }),
    createTestUser('tour-member', { fullName: 'Mia Member' }),
  ]);
  wsId = await realestateBusiness(owner, 'Hill Country Realty');
  for (const u of [agent, member])
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${wsId}, ${u.id}, 'member')`,
    );
  for (const u of [owner, agent, member])
    await run(scheduleSet, { workspaceId: wsId, ownerId: u.id, weekly: WEEKDAYS }, owner);
  const [w] = await rows<{ org: string }>(
    admin(),
    sql`select organization_id as org from app.workspaces where id = ${wsId}`,
  );
  const org = w!.org;
  const team = {
    owner,
    wsId,
    scope: { workspaceId: wsId, organizationId: org },
  } as unknown as Team;
  calendarId = (
    await makeCalendar(team, 'Showings', {
      team: { members: [{ userId: agent.id }, { userId: member.id }] },
    })
  ).id;
  const [kind] = await rows<{ id: string }>(
    admin(),
    sql`select id from app.custom_record_types where workspace_id = ${wsId} and key = 'realestate_deal'`,
  );
  deal = (
    await run(
      customRecordCreate,
      { workspaceId: wsId, typeId: kind!.id, name: 'Nguyen purchase' },
      agent,
    )
  ).customRecordId;
  tour = (
    await run(
      appointmentCreate,
      {
        workspaceId: wsId,
        calendarId,
        startsAt: isoAt(day, '10:00'),
        durationMinutes: 120,
        userIds: [agent.id],
        customRecordId: deal,
        title: 'Home tour',
        acknowledgeWarnings: true,
      },
      agent,
    )
  ).appointmentId;
});
afterAll(closeTestDbs);

describe('a tour on a private deal', () => {
  it('is in the calendar of the people on the deal, and of owners', async () => {
    for (const u of [agent, owner]) {
      const { items } = await ask(appointmentList, { workspaceId: wsId, ...span }, u);
      expect(items.map((a) => a.id)).toContain(tour);
    }
  });

  it('is only busy time to a member who isn’t on the deal', async () => {
    const { items } = await ask(appointmentList, { workspaceId: wsId, ...span }, member);
    expect(items.map((a) => a.id)).not.toContain(tour);
    const team = await ask(
      scheduleTeam,
      { workspaceId: wsId, ...span, userIds: [agent.id] },
      member,
    );
    expect(team.people[0]!.privateBusy).toEqual([
      { startsAt: isoAt(day, '10:00'), endsAt: isoAt(day, '12:00') },
    ]);
    // The people on the deal see the tour itself, so no busy block is drawn for them.
    const ours = await ask(
      scheduleTeam,
      { workspaceId: wsId, ...span, userIds: [agent.id] },
      agent,
    );
    expect(ours.people[0]!.privateBusy).toEqual([]);
  });

  it('isn’t offered as open time, and can’t be booked over', async () => {
    const open = await ask(
      calendarAvailability,
      { workspaceId: wsId, calendarId, ...span, durationMinutes: 60, chosenUserId: agent.id },
      member,
    );
    const starts = open.slots.map((s) => s.startsAt);
    expect(starts).toContain(isoAt(day, '08:00'));
    expect(starts).not.toContain(isoAt(day, '10:00'));
    expect(starts).not.toContain(isoAt(day, '11:00'));
    await expectHfos(
      () =>
        run(
          appointmentCreate,
          {
            workspaceId: wsId,
            calendarId,
            startsAt: isoAt(day, '10:30'),
            durationMinutes: 60,
            userIds: [agent.id],
            title: 'Estimate walkthrough',
            acknowledgeWarnings: true,
          },
          member,
        ),
      'slot_taken',
    );
  });
});
