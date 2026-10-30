/**
 * Webinars, part 1 (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md) on the real database: a session's HandsFreeOS call
 * is a webinar, the link anyone can use saves seats, and the team decides who may talk and be seen.
 *
 * What's worth holding:
 *   - a session's call is made a webinar, with its calendar's camera choice and a link anyone can use; a one-on-one
 *     booking's stays a meeting;
 *   - the link saves one seat per person, says whether they're a new customer, and refuses a cancelled webinar;
 *   - the team presents and attendees watch, by the rights their tickets carry;
 *   - the camera choice and the stage are the team's, only in a webinar, three on stage at most and never the team;
 *   - "starting now" goes once, from the sweep that finds webinars starting.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appointmentCancel,
  sessionPublish,
  videoCallEnter,
  videoCallJoin,
  videoCallJoined,
  videoCallOpen,
  videoCallSetAttendeeVideo,
  videoCallStage,
  videoCallStartingTold,
  webinarRegister,
} from '../src/server';
import {
  admin,
  bookOnline,
  expectHfos,
  isoAt,
  makeCalendar,
  nextPhone,
  nextWeekday,
  run,
  runSystem,
  setupTeam,
  type Team,
} from './calendar-helpers';

let t: Team;
let calendarId: string;

const publish = async (clock: string, weekday = 2) => {
  const s = await run(
    sessionPublish,
    {
      workspaceId: t.wsId,
      calendarId,
      startsAt: isoAt(nextWeekday(weekday, 5), clock),
      userIds: [t.priya.id],
      capacity: 8,
    },
    t.owner,
  );
  const open = await runSystem(
    videoCallOpen,
    { workspaceId: t.wsId, appointmentId: s.appointmentId },
    t.scope,
  );
  return { appointmentId: s.appointmentId, callId: open.callId };
};

const callRow = async (id: string) =>
  (
    await rows<{
      format: string;
      attendee_video: string;
      door_key: string | null;
      starting_now_at: Date | null;
    }>(
      admin(),
      sql`select format, attendee_video, door_key, starting_now_at from app.video_calls where id = ${id}`,
    )
  )[0]!;

const register = (callId: string, firstName: string, phone = nextPhone()) =>
  runSystem(
    webinarRegister,
    {
      workspaceId: t.wsId,
      callId,
      customer: { firstName, lastName: 'Watcher', phone },
      smsConsent: true,
    },
    t.scope,
  );

const events = (type: string, entityId: string) =>
  rows<{ payload: Record<string, unknown> }>(
    admin(),
    sql`select payload from app.events where event_type = ${type} and entity_id = ${entityId} order by created_at`,
  );

beforeAll(async () => {
  t = await setupTeam('webinar');
  await rows(admin(), sql`update app.workspaces set video_calls = true where id = ${t.wsId}`);
  const cal = await makeCalendar(t, 'Live demos', {
    public: true,
    team: { members: [{ userId: t.priya.id }] },
    schedule: { mode: 'sessions' },
    locations: {
      options: [{ kind: 'virtual', video: 'handsfree' }],
      webinar: { attendeeVideo: 'team' },
    },
  });
  calendarId = cal.id;
});
afterAll(closeTestDbs);

describe('a session’s call', () => {
  it('is a webinar, with its calendar’s camera choice and a link anyone can use', async () => {
    const { callId } = await publish('09:00');
    const c = await callRow(callId);
    expect(c).toMatchObject({ format: 'webinar', attendee_video: 'team' });
    expect(c.door_key).toMatch(/^[0-9A-Za-z]{24}$/);
    const [found] = await rows<{ call_id: string; workspace_id: string }>(
      admin(),
      sql`select * from private.video_call_by_door(${c.door_key})`,
    );
    expect(found).toMatchObject({ call_id: callId, workspace_id: t.wsId });
  });

  it('stays a meeting for a one-on-one booking', async () => {
    const consults = await makeCalendar(t, 'Video consults', {
      public: true,
      team: { members: [{ userId: t.marco.id }] },
      locations: { options: [{ kind: 'virtual', video: 'handsfree' }] },
    });
    const b = await bookOnline(t, consults.id, isoAt(nextWeekday(3, 5), '11:00'));
    const open = await runSystem(
      videoCallOpen,
      { workspaceId: t.wsId, appointmentId: b.appointmentId },
      t.scope,
    );
    expect(await callRow(open.callId)).toMatchObject({ format: 'meeting', door_key: null });
    await expectHfos(
      () =>
        run(
          videoCallSetAttendeeVideo,
          { workspaceId: t.wsId, callId: open.callId, attendeeVideo: 'everyone' },
          t.owner,
        ),
      'not_a_webinar',
      409,
    );
  });
});

describe('the link anyone can use', () => {
  it('saves one seat per person, and says whether they’re new', async () => {
    const { appointmentId, callId } = await publish('10:00');
    const phone = nextPhone();
    const first = await register(callId, 'Wendy', phone);
    expect(first).toMatchObject({ appointmentId, duplicate: false, personCreated: true });
    const again = await register(callId, 'Wendy', phone);
    expect(again).toMatchObject({
      attendeeId: first.attendeeId,
      duplicate: true,
      personCreated: false,
    });
    expect(await events('appointment.booked', appointmentId)).toHaveLength(1);
    const [seat] = await rows<{ status: string; sms_ok: boolean }>(
      admin(),
      sql`select status, sms_ok from app.appointment_attendees where id = ${first.attendeeId}`,
    );
    expect(seat).toEqual({ status: 'booked', sms_ok: true });
  });

  it('refuses a cancelled webinar', async () => {
    const { appointmentId, callId } = await publish('11:00');
    await run(
      appointmentCancel,
      { workspaceId: t.wsId, appointmentId, reason: null, notify: false },
      t.owner,
    );
    await expectHfos(() => register(callId, 'Late'), 'webinar_cancelled', 409);
  });
});

describe('in the room', () => {
  let callId: string;
  let priyaRow: string;
  const rowsOf: Record<string, string> = {};
  const t0 = Date.now();
  const at = (s: number) => new Date(t0 + s * 1000).toISOString();

  const enter = (attendeeId: string, name: string) =>
    runSystem(videoCallEnter, { workspaceId: t.wsId, attendeeId, name }, t.scope);
  const joined = (personId: string, s: number) =>
    runSystem(
      videoCallJoined,
      {
        workspaceId: t.wsId,
        callId,
        personId,
        roomSid: 'RM_webinar',
        participantSid: `PA_${personId.slice(0, 8)}_${s}`,
        at: at(s),
      },
      t.scope,
    );

  beforeAll(async () => {
    ({ callId } = await publish('13:00'));
  });

  it('lets the team present, and attendees watch with the camera the presenter allows', async () => {
    const priya = await run(videoCallJoin, { workspaceId: t.wsId, callId }, t.priya);
    priyaRow = priya.personId;
    expect(priya.rights).toEqual({
      format: 'webinar',
      maxPeople: 500,
      publish: { camera: true, microphone: true, screen: true },
      attributes: { 'hfos.format': 'webinar', 'hfos.video': 'team', 'hfos.stage': '' },
    });
    await joined(priyaRow, 0);

    for (const name of ['Ann', 'Ben', 'Cat', 'Dan', 'Eve']) {
      const seat = await register(callId, name);
      const inside = await enter(seat.attendeeId, name);
      expect(inside).toMatchObject({ status: 'in', format: 'webinar' });
      expect(inside.rights?.publish).toEqual({ camera: true, microphone: false, screen: false });
      rowsOf[name] = inside.personId!;
    }
  });

  it('changes attendees’ cameras, once per change', async () => {
    const off = await run(
      videoCallSetAttendeeVideo,
      { workspaceId: t.wsId, callId, attendeeVideo: 'off' },
      t.priya,
    );
    expect(off).toEqual({ changed: true, attendeeVideo: 'off' });
    expect(
      (
        await run(
          videoCallSetAttendeeVideo,
          { workspaceId: t.wsId, callId, attendeeVideo: 'off' },
          t.priya,
        )
      ).changed,
    ).toBe(false);
    expect(await events('video_call.attendee_video_changed', callId)).toHaveLength(1);
    const inside = await enter(
      (
        await rows<{ attendee_id: string }>(
          admin(),
          sql`select attendee_id from app.video_call_people where id = ${rowsOf.Ann!}`,
        )
      )[0]!.attendee_id,
      'Ann',
    );
    expect(inside.rights?.publish).toEqual({ camera: false, microphone: false, screen: false });
  });

  it('brings attendees on stage, three at most, only once they’re in, and never the team', async () => {
    const stage = (personId: string, on: boolean) =>
      run(videoCallStage, { workspaceId: t.wsId, callId, personId, on }, t.priya);
    await expectHfos(() => stage(priyaRow, true), 'video_call_team_on_stage', 409);
    // Let in, but LiveKit hasn't said they're in the room yet.
    await expectHfos(() => stage(rowsOf.Ann!, true), 'video_call_not_in', 409);

    for (const [i, name] of ['Ann', 'Ben', 'Cat', 'Dan'].entries())
      await joined(rowsOf[name]!, 10 + i);
    for (const name of ['Ann', 'Ben', 'Cat'])
      expect(await stage(rowsOf[name]!, true)).toEqual({ changed: true, onStage: true });
    await expectHfos(() => stage(rowsOf.Dan!, true), 'video_call_stage_full', 409);

    expect(await stage(rowsOf.Cat!, false)).toEqual({ changed: true, onStage: false });
    expect(await stage(rowsOf.Dan!, true)).toEqual({ changed: true, onStage: true });
    const changes = await events('video_call.stage_changed', callId);
    expect(changes.map((c) => [c.payload['personRowId'], c.payload['onStage']])).toEqual([
      [rowsOf.Ann, true],
      [rowsOf.Ben, true],
      [rowsOf.Cat, true],
      [rowsOf.Cat, false],
      [rowsOf.Dan, true],
    ]);
  });
});

describe('starting now', () => {
  it('is found by the sweep at the start, and goes once', async () => {
    const { appointmentId, callId } = await publish('15:00', 4);
    // The session starts a minute ago.
    await rows(
      admin(),
      sql`update app.appointments set starts_at = now() - interval '1 minute', ends_at = now() + interval '59 minutes'
          where id = ${appointmentId}`,
    );
    const due = async () =>
      (
        await rows<{ call_id: string }>(admin(), sql`select * from private.webinars_starting(200)`)
      ).map((r) => r.call_id);
    expect(await due()).toContain(callId);
    const told = () =>
      runSystem(videoCallStartingTold, { workspaceId: t.wsId, callId, sent: 3 }, t.scope);
    expect(await told()).toEqual({ changed: true });
    expect(await told()).toEqual({ changed: false });
    expect((await callRow(callId)).starting_now_at).not.toBeNull();
    expect(await due()).not.toContain(callId);
  });
});
