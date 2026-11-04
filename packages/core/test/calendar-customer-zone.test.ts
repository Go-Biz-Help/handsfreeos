/**
 * A customer's own time zone, kept on their booking (20261027023000), on the real database. The owner's answer of
 * 2026-11-03: what a customer sees should "always show in the viewer's timezone but if it doesn't know it it defaults
 * to the one set by the business".
 *
 * What's worth holding:
 *   - the booking page keeps the zone it showed the visitor;
 *   - a teammate booking on another zone's clock (the Time zone pick) keeps that zone for the customer, and one on
 *     the calendar's own keeps nothing, so the customer's address, then the calendar, decide;
 *   - a repeat set on another zone's clock keeps it on every visit.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appointmentCreate, seriesCreate } from '../src/server';
import {
  admin,
  bookOnline,
  customer,
  isoAt,
  makeCalendar,
  nextWeekday,
  run,
  setupTeam,
  type Team,
} from './calendar-helpers';

let t: Team;
let calendarId: string;

const zoneOf = async (where: string, id: string) =>
  (
    await rows<{ timezone: string | null }>(
      admin(),
      where === 'attendee'
        ? sql`select timezone from app.appointment_attendees where id = ${id}`
        : sql`select timezone from app.appointment_attendees where appointment_id = ${id}`,
    )
  ).map((r) => r.timezone);

beforeAll(async () => {
  t = await setupTeam('customer-zone');
  calendarId = (
    await makeCalendar(t, 'Visits', {
      public: true,
      team: {
        members: [{ userId: t.priya.id }, { userId: t.marco.id }],
        assignment: 'round_robin',
      },
    })
  ).id;
});
afterAll(closeTestDbs);

describe('the customer’s zone on their booking', () => {
  it('keeps the zone the booking page showed them', async () => {
    const booked = await bookOnline(t, calendarId, isoAt(nextWeekday(2), '09:00'), {
      timezone: 'US/Pacific',
    });
    expect(await zoneOf('attendee', booked.attendeeId)).toEqual(['America/Los_Angeles']);
  });

  it('keeps a teammate’s pick when it isn’t the calendar’s own zone', async () => {
    const maria = await customer(t, 'Maria');
    const away = await run(
      appointmentCreate,
      {
        workspaceId: t.wsId,
        calendarId,
        startsAt: isoAt(nextWeekday(3), '10:00'),
        personId: maria,
        timezone: 'America/Denver',
        acknowledgeWarnings: true,
      },
      t.owner,
    );
    expect(await zoneOf('appointment', away.appointmentId)).toEqual(['America/Denver']);

    const here = await run(
      appointmentCreate,
      {
        workspaceId: t.wsId,
        calendarId,
        startsAt: isoAt(nextWeekday(3), '13:00'),
        personId: maria,
        timezone: 'America/Chicago',
        acknowledgeWarnings: true,
      },
      t.owner,
    );
    expect(await zoneOf('appointment', here.appointmentId)).toEqual([null]);
  });

  it('keeps it on every visit of a repeat set on another zone’s clock', async () => {
    const ann = await customer(t, 'Ann');
    const out = await run(
      seriesCreate,
      {
        workspaceId: t.wsId,
        calendarId,
        personId: ann,
        firstDate: nextWeekday(4, 7),
        timezone: 'America/Phoenix',
        rule: { freq: 'weekly', count: 3, localTime: '09:00' },
        acknowledgeWarnings: true,
      },
      t.owner,
    );
    const zones = await rows<{ timezone: string | null }>(
      admin(),
      sql`select a.timezone from app.appointment_attendees a
          join app.appointments p on p.id = a.appointment_id
          where p.series_id = ${out.seriesId}`,
    );
    expect(zones.map((z) => z.timezone)).toEqual([
      'America/Phoenix',
      'America/Phoenix',
      'America/Phoenix',
    ]);
  });
});
