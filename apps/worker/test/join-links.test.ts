/**
 * Who joined the live session (funnels), through the worker's own routes and jobs on the real database.
 *
 * What's worth holding:
 *   - a customer's messages carry their own Join link, never the meeting's address, and a teammate's don't;
 *   - opening it from a browser records that person joined and sends them on; a link preview counts for nobody;
 *   - before an hour ahead it says when the session is, and a wrong link opens nothing;
 *   - when the session ends, who joined attended and who never did is a no-show, and a workflow on "Somebody
 *     missed a session" starts for that one person only;
 *   - marking the whole session done leaves a person marked on their own as they were.
 */
import { appointmentSetStatus, attendeeSetAttendance, sessionPublish } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attendanceClose } from '../src/booking/attendance';
import { loadBooking } from '../src/booking/visit';
import { RunData } from '../src/workflows/data';
import type { JobContext } from '../src/jobs';
import {
  addWorkflow,
  admin,
  attendeeByToken,
  bookOnline,
  customer,
  drain,
  flowWorld,
  makeCalendar,
  MIN,
  run,
  runsOf,
  sid,
  type World,
} from './workflow-world';

let w: World;
let calendar: { id: string; slug: string };

beforeAll(async () => {
  w = await flowWorld('joins');
  calendar = await makeCalendar(w, 'Live presentation', {
    schedule: { mode: 'sessions' },
    capacity: { seats: 5 },
  });
});
afterAll(async () => {
  await w.app.close();
  await closeTestDbs();
});

/** An online session starting `inMinutes` from now, with two people booked on it. */
async function session(inMinutes: number) {
  const startsAt = new Date(Date.now() + inMinutes * MIN);
  startsAt.setUTCSeconds(0, 0);
  const published = await run(w, sessionPublish, {
    workspaceId: w.workspaceId,
    calendarId: calendar.id,
    startsAt: startsAt.toISOString(),
    // Short, so each test's session has its own time with the same host.
    durationMinutes: 10,
    userIds: [w.owner.id],
    location: { kind: 'virtual', meetingUrl: 'https://zoom.us/j/5550001111' },
  });
  const book = async (first: string) => {
    const booked = await bookOnline(w, calendar.slug, startsAt.getTime(), {
      ...customer(first),
      sessionId: published.appointmentId,
    });
    return attendeeByToken(booked.manageToken);
  };
  return { appointmentId: published.appointmentId, ana: await book('Ana'), ben: await book('Ben') };
}

/** The Join link a customer's own message would carry. */
async function joinLinkOf(attendeeId: string): Promise<string> {
  const b = await asWorker(
    w.s.db,
    { workspaceId: w.workspaceId, organizationId: w.organizationId },
    (tx) => loadBooking(tx, w.s, attendeeId, { forCustomer: true }),
  );
  return b!.visit.meetingUrl!;
}

const join = (url: string, userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)') =>
  w.app.inject({
    method: 'POST',
    url: `/public/join/${url.split('/j/')[1]}`,
    headers: { 'content-type': 'application/json', 'user-agent': userAgent },
    payload: '{}',
  });

const seat = async (attendeeId: string) =>
  (
    await rows<{ status: string; joined_at: string | null; join_offered_at: string | null }>(
      admin(),
      sql`select status::text as status, joined_at, join_offered_at from app.appointment_attendees
          where id = ${attendeeId}`,
    )
  )[0]!;

describe('a Join link', () => {
  it('is in the customer’s messages, and the teammate’s keep the meeting’s address', async () => {
    const { ana } = await session(5);
    const link = await joinLinkOf(ana.id);
    expect(link).toMatch(/\/j\/[0-9A-Za-z]{18}$/);
    expect((await seat(ana.id)).join_offered_at).not.toBeNull();
    const staff = await asWorker(
      w.s.db,
      { workspaceId: w.workspaceId, organizationId: w.organizationId },
      (tx) => loadBooking(tx, w.s, ana.id),
    );
    expect(staff!.visit.meetingUrl).toBe('https://zoom.us/j/5550001111');
  });

  it('records who joined and sends them on; a link preview counts for nobody', async () => {
    const { ana, ben } = await session(20);
    const preview = await join(await joinLinkOf(ben.id), 'facebookexternalhit/1.1');
    expect(preview.json()).toMatchObject({ state: 'open', url: 'https://zoom.us/j/5550001111' });
    expect((await seat(ben.id)).joined_at).toBeNull();

    const opened = await join(await joinLinkOf(ana.id));
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toMatchObject({ state: 'open', url: 'https://zoom.us/j/5550001111' });
    expect((await seat(ana.id)).joined_at).not.toBeNull();
    // Their seat stays booked while the session runs.
    expect((await seat(ana.id)).status).toBe('booked');
  });

  it('is what a workflow’s {{appointment.join_url}} says, for the run’s own person', async () => {
    const { appointmentId, ana } = await session(65);
    const [person] = await rows<{ person_id: string }>(
      admin(),
      sql`select person_id from app.appointment_attendees where id = ${ana.id}`,
    );
    const url = await asWorker(
      w.s.db,
      { workspaceId: w.workspaceId, organizationId: w.organizationId },
      async (tx) => {
        const data = new RunData(
          tx,
          {
            workspaceId: w.workspaceId,
            personId: person!.person_id,
            leadId: null,
            appointmentId,
            conversationId: null,
          },
          {
            timeZone: 'America/Chicago',
            webUrl: w.s.webUrl,
            workflowName: 'Starting now',
            context: {},
            bookingLinks: w.s.bookingLinks,
          },
        );
        await data.need(['appointment.join_url']);
        return data.value('appointment.join_url');
      },
    );
    expect(url).toBe(await joinLinkOf(ana.id));
  });

  it('says when the session is before it opens, and a wrong link opens nothing', async () => {
    const { ana } = await session(3 * 60);
    const early = await join(await joinLinkOf(ana.id));
    expect(early.json()).toMatchObject({ state: 'early', title: 'Live presentation' });
    expect((await seat(ana.id)).joined_at).toBeNull();
    const link = await joinLinkOf(ana.id);
    const wrong = await w.app.inject({
      method: 'POST',
      url: `/public/join/${link.split('/j/')[1]!.slice(0, 8)}0000000000`,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(wrong.statusCode).toBe(404);
  });
});

describe('the end of a session', () => {
  it('marks who joined attended and who never did a no-show, and starts the workflow for them alone', async () => {
    const missed = await addWorkflow(w, 'Missed the presentation', {
      version: 1,
      trigger: { kind: 'event', event: 'attendee.no_show' },
      steps: [
        {
          id: sid('note'),
          type: 'action',
          action: 'add_note',
          config: { body: 'Missed {{appointment.title}}' },
        },
      ],
    });
    const { appointmentId, ana, ben } = await session(35);
    await joinLinkOf(ben.id);
    await join(await joinLinkOf(ana.id));
    // It ran, and ended a quarter of an hour ago.
    await admin().execute(
      sql`update app.appointments set starts_at = now() - interval '25 minutes', ends_at = now() - interval '15 minutes'
          where id = ${appointmentId}`,
    );
    await attendanceClose({ ...w.s, now: Date.now() } as unknown as JobContext);
    await drain(w);
    expect((await seat(ana.id)).status).toBe('attended');
    expect((await seat(ben.id)).status).toBe('no_show');
    const runs = await runsOf(missed.id);
    const [benPerson] = await rows<{ person_id: string }>(
      admin(),
      sql`select person_id from app.appointment_attendees where id = ${ben.id}`,
    );
    expect(runs.map((r) => r.person_id)).toEqual([benPerson!.person_id]);
  });

  it('leaves a person marked on their own when the whole session is marked done', async () => {
    const { appointmentId, ana, ben } = await session(50);
    await run(w, attendeeSetAttendance, {
      workspaceId: w.workspaceId,
      attendeeId: ben.id,
      attendance: 'no_show',
    });
    await admin().execute(
      sql`update app.appointments set starts_at = now() - interval '50 minutes', ends_at = now() - interval '40 minutes'
          where id = ${appointmentId}`,
    );
    await run(w, appointmentSetStatus, {
      workspaceId: w.workspaceId,
      appointmentId,
      status: 'completed',
    });
    expect((await seat(ana.id)).status).toBe('attended');
    expect((await seat(ben.id)).status).toBe('no_show');
  });
});
