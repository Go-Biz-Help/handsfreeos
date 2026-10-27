/**
 * HandsFreeOS video calls (docs/video-calls.md) on the real database: the call an online appointment gets, who may
 * come in and when, what LiveKit's reports do to it, and the database keeping each side to its own part.
 *
 * What's worth holding:
 *   - support turns calls on for one business, and nobody else can, by the command or the column;
 *   - a customer on their own link waits until someone from the team is in, then goes straight in, and the team
 *     hears about it once per wait;
 *   - anyone else asks to be let in, and the team lets them in or turns them away; someone taken out has to ask
 *     again;
 *   - when the room closes, everyone's minutes are added up once, and a later stretch of the call counts its own;
 *   - nothing opens while the business has calls off, and its appointments get no call.
 */
import { createHash, randomBytes } from 'node:crypto';
import { asUser, rows, sql } from '@hfos/db/client';
import {
  closeTestDbs,
  createTestUser,
  expectPgError,
  testDbs,
  type TestUser,
} from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HfosError } from '../src/errors';
import {
  platformBusinessGet,
  videoCallAdmit,
  videoCallEnd,
  videoCallEnter,
  videoCallFinished,
  videoCallGet,
  videoCallJoin,
  videoCallJoined,
  videoCallKnock,
  videoCallKnockStatus,
  videoCallLeft,
  videoCallMute,
  videoCallOpen,
  videoCallRemove,
  videoCallsSet,
  videoCallTurnAway,
  workspaceGet,
} from '../src/server';
import {
  admin,
  ask,
  bookOnline,
  expectHfos,
  isoAt,
  makeCalendar,
  nextWeekday,
  run,
  askSystem,
  runSystem,
  setupTeam,
  type Team,
} from './calendar-helpers';

const api = () => testDbs().api.db;

let t: Team;
let staff: TestUser;
let calendarId: string;

const knockKey = () => createHash('sha256').update(randomBytes(32)).digest('hex');
const at = (base: number, seconds: number) => new Date(base + seconds * 1000).toISOString();

async function booking(clock: string) {
  const day = nextWeekday(3, 4);
  const b = await bookOnline(t, calendarId, isoAt(day, clock));
  return b;
}

const place = async (appointmentId: string) =>
  (
    await rows<{ location: Record<string, unknown> }>(
      admin(),
      sql`select location from app.appointments where id = ${appointmentId}`,
    )
  )[0]!.location;

const person = async (id: string) =>
  (
    await rows<{ state: string; seconds: number; kind: string; person_id: string | null }>(
      admin(),
      sql`select state, seconds, kind, person_id from app.video_call_people where id = ${id}`,
    )
  )[0]!;

const call = async (id: string) =>
  (
    await rows<{
      state: string;
      room_sid: string | null;
      seconds_billed: number;
      ended_at: Date | null;
      host_user_id: string | null;
    }>(
      admin(),
      sql`select state, room_sid, seconds_billed, ended_at, host_user_id from app.video_calls where id = ${id}`,
    )
  )[0]!;

const events = async (type: string, callId: string) =>
  rows<{ payload: Record<string, unknown> }>(
    admin(),
    sql`select payload from app.events where event_type = ${type} and entity_id = ${callId} order by created_at`,
  );

const setCalls = (on: boolean) =>
  rows(admin(), sql`update app.workspaces set video_calls = ${on} where id = ${t.wsId}`);

/** The database's reason for refusing, however deep the driver wrapped it. */
function refusal(e: unknown): string | undefined {
  let err = e as { detail?: string; cause?: unknown } | undefined;
  while (err && !err.detail && err.cause) err = err.cause as typeof err;
  return err?.detail;
}

beforeAll(async () => {
  t = await setupTeam('vcall');
  staff = await createTestUser('vcall-staff-admin');
  await rows(
    admin(),
    sql`insert into platform.staff (user_id, role) values (${staff.id}, 'admin')
        on conflict (user_id) do update set role = 'admin', status = 'active'`,
  );
  const cal = await makeCalendar(t, 'Video consults', {
    public: true,
    team: { members: [{ userId: t.priya.id }] },
    locations: { options: [{ kind: 'virtual', video: 'handsfree' }] },
  });
  calendarId = cal.id;
});
afterAll(closeTestDbs);

describe('support’s switch', () => {
  it('turns video calls on for one business, and the business sees it', async () => {
    const on = await run(videoCallsSet, { workspaceId: t.wsId, on: true }, staff);
    expect(on).toEqual({ workspaceId: t.wsId, was: false, on: true, changed: true });
    expect((await run(videoCallsSet, { workspaceId: t.wsId, on: true }, staff)).changed).toBe(
      false,
    );
    const page = await ask(platformBusinessGet, { workspaceId: t.wsId }, staff);
    expect(page.videoCalls).toBe(true);
    const ws = await ask(workspaceGet, { workspaceId: t.wsId }, t.owner);
    expect(ws.workspace.videoCalls).toBe(true);
    const changes = await rows<{ payload: { on: boolean } }>(
      admin(),
      sql`select payload from app.events where event_type = 'video_calls.changed' and entity_id = ${t.wsId}`,
    );
    expect(changes.map((c) => c.payload.on)).toEqual([true]);
  });

  it('is refused to the business’s own owner, by the command, the column and the function', async () => {
    await expect(
      run(videoCallsSet, { workspaceId: t.wsId, on: false }, t.owner),
    ).rejects.toBeInstanceOf(HfosError);
    const direct = await asUser(api(), t.owner.claims, (tx) =>
      rows(tx, sql`update app.workspaces set video_calls = false where id = ${t.wsId}`),
    ).catch((e: unknown) => e);
    expect(refusal(direct)).toBe('video_calls_switch_is_ours');
    const viaFunction = await asUser(api(), t.owner.claims, (tx) =>
      rows(tx, sql`select * from private.set_video_calls(${t.wsId}::uuid, false)`),
    ).catch((e: unknown) => e);
    expect(refusal(viaFunction)).toBe('video_calls_switch_is_ours');
    const [w] = await rows<{ video_calls: boolean }>(
      admin(),
      sql`select video_calls from app.workspaces where id = ${t.wsId}`,
    );
    expect(w!.video_calls).toBe(true);
  });
});

describe('a customer on their own link', () => {
  let booked: Awaited<ReturnType<typeof booking>>;
  let callId: string;
  let customerRow: string;
  let priyaRow: string;
  let sam: string;
  const t0 = Date.now();

  beforeAll(async () => {
    booked = await booking('10:00');
  });

  it('books a HandsFreeOS call, and the worker makes it once', async () => {
    expect(await place(booked.appointmentId)).toMatchObject({
      kind: 'virtual',
      video: 'handsfree',
    });
    const first = await runSystem(
      videoCallOpen,
      { workspaceId: t.wsId, appointmentId: booked.appointmentId },
      t.scope,
    );
    expect(first.created).toBe(true);
    const again = await runSystem(
      videoCallOpen,
      { workspaceId: t.wsId, appointmentId: booked.appointmentId },
      t.scope,
    );
    expect(again).toEqual({ callId: first.callId, created: false });
    callId = first.callId;
    expect((await call(callId)).host_user_id).toBe(t.priya.id);
  });

  it('waits until someone from the team is in, and the team hears once per wait', async () => {
    const enter = () =>
      runSystem(
        videoCallEnter,
        { workspaceId: t.wsId, attendeeId: booked.attendeeId, name: 'Ana Customer' },
        t.scope,
      );
    const first = await enter();
    expect(first).toMatchObject({ status: 'waiting', callId, name: 'Ana Customer', host: 'Priya' });
    customerRow = first.personId!;
    expect((await enter()).status).toBe('waiting');
    expect(await events('video_call.waiting', callId)).toHaveLength(1);

    // Priya presses Join: she has a ticket, but she isn't in the room until LiveKit says so.
    const joined = await run(videoCallJoin, { workspaceId: t.wsId, callId }, t.priya);
    expect(joined).toMatchObject({ name: 'Priya Tech', call: { id: callId, state: 'open' } });
    priyaRow = joined.personId;
    expect((await enter()).status).toBe('waiting');

    expect(
      await runSystem(
        videoCallJoined,
        { workspaceId: t.wsId, callId, personId: priyaRow, roomSid: 'RM_first', at: at(t0, 0) },
        t.scope,
      ),
    ).toEqual({ changed: true, kick: false });
    expect(await call(callId)).toMatchObject({ state: 'live', room_sid: 'RM_first' });
    expect(await enter()).toMatchObject({ status: 'in', personId: customerRow });
  });

  it('counts them as joined once they’re really in the call', async () => {
    const presence = (participantSid: string, seconds: number) => ({
      workspaceId: t.wsId,
      callId,
      personId: customerRow,
      roomSid: 'RM_first',
      participantSid,
      at: at(t0, seconds),
    });
    expect(await runSystem(videoCallJoined, presence('PA_ana_1', 60), t.scope)).toEqual({
      changed: true,
      kick: false,
    });
    const [seat] = await rows<{ joined_at: Date | null }>(
      admin(),
      sql`select joined_at from app.appointment_attendees where id = ${booked.attendeeId}`,
    );
    expect(seat!.joined_at).not.toBeNull();
    // A repeated report changes nothing.
    expect(await runSystem(videoCallJoined, presence('PA_ana_1', 61), t.scope)).toEqual({
      changed: false,
      kick: false,
    });
    // She reloads the page: the new connection takes over, and the old one going is no leaving.
    expect(await runSystem(videoCallJoined, presence('PA_ana_2', 90), t.scope)).toEqual({
      changed: false,
      kick: false,
    });
    expect(await runSystem(videoCallLeft, presence('PA_ana_1', 91), t.scope)).toEqual({
      changed: false,
      seconds: 0,
    });
    expect(await person(customerRow)).toMatchObject({ state: 'in', seconds: 0 });
    expect(await events('video_call.person_joined', callId)).toHaveLength(2);
    const got = await ask(videoCallGet, { workspaceId: t.wsId, callId }, t.owner);
    expect(got.people.map((p) => [p.kind, p.state, p.connected])).toEqual([
      ['customer', 'in', true],
      ['team', 'in', true],
    ]);
    expect(got.appointment).toMatchObject({ id: booked.appointmentId });
    expect(got.host).toEqual({ userId: t.priya.id, name: 'Priya Tech' });
    const byAppointment = await ask(
      videoCallGet,
      { workspaceId: t.wsId, appointmentId: booked.appointmentId },
      t.member,
    );
    expect(byAppointment.call?.id).toBe(callId);
  });

  describe('anyone else', () => {
    let lee: string;

    it('asks to be let in, and the team lets them in or turns them away', async () => {
      const samKey = knockKey();
      const knocked = await runSystem(
        videoCallKnock,
        { workspaceId: t.wsId, callId, name: 'Sam Guest', knockKeyHash: samKey },
        t.scope,
      );
      sam = knocked.personId;
      const standing = (personId: string, knockKeyHash: string) =>
        askSystem(
          videoCallKnockStatus,
          { workspaceId: t.wsId, callId, personId, knockKeyHash },
          t.scope,
        );
      expect(await standing(sam, samKey)).toEqual({
        status: 'waiting',
        name: 'Sam Guest',
        host: 'Priya',
      });
      // Only the page that knocked can ask.
      await expectHfos(() => standing(sam, knockKey()), 'not_found', 404);
      expect(knocked.host).toBe('Priya');
      expect((await events('video_call.knocked', callId)).map((e) => e.payload.name)).toEqual([
        'Sam Guest',
      ]);
      expect(
        await run(videoCallAdmit, { workspaceId: t.wsId, callId, personId: sam }, t.member),
      ).toEqual({
        changed: true,
      });
      expect(
        await run(videoCallAdmit, { workspaceId: t.wsId, callId, personId: sam }, t.member),
      ).toEqual({
        changed: false,
      });
      expect((await person(sam)).state).toBe('admitted');
      expect((await standing(sam, samKey)).status).toBe('in');

      const leeKey = knockKey();
      lee = (
        await runSystem(
          videoCallKnock,
          { workspaceId: t.wsId, callId, name: 'Lee Guest', knockKeyHash: leeKey },
          t.scope,
        )
      ).personId;
      expect(
        await run(videoCallTurnAway, { workspaceId: t.wsId, callId, personId: lee }, t.member),
      ).toEqual({ changed: true });
      expect((await standing(lee, leeKey)).status).toBe('turned_away');
      await expectHfos(
        () => run(videoCallAdmit, { workspaceId: t.wsId, callId, personId: lee }, t.member),
        'video_call_not_waiting',
        409,
      );
      // Turned away and never in: not on the call page.
      const got = await ask(videoCallGet, { workspaceId: t.wsId, callId }, t.owner);
      expect(got.people.map((p) => p.id)).not.toContain(lee);
    });

    it('is muted only while they’re in the call', async () => {
      expect(
        await run(videoCallMute, { workspaceId: t.wsId, callId, personId: priyaRow }, t.member),
      ).toEqual({ requested: true });
      expect(
        await run(videoCallMute, { workspaceId: t.wsId, callId, personId: lee }, t.member),
      ).toEqual({
        requested: false,
      });
    });
  });

  it('can be taken out, and has to ask to come back', async () => {
    expect(
      await run(videoCallRemove, { workspaceId: t.wsId, callId, personId: customerRow }, t.priya),
    ).toEqual({ changed: true });
    await expectHfos(
      () => run(videoCallRemove, { workspaceId: t.wsId, callId, personId: priyaRow }, t.priya),
      'video_call_remove_self',
      409,
    );
    // LiveKit reports them gone: still taken out.
    const presence = (participantSid: string, seconds: number) => ({
      workspaceId: t.wsId,
      callId,
      personId: customerRow,
      roomSid: 'RM_first',
      participantSid,
      at: at(t0, seconds),
    });
    await runSystem(videoCallLeft, presence('PA_ana_2', 360), t.scope);
    expect(await person(customerRow)).toMatchObject({ state: 'removed', seconds: 300 });
    // Her old ticket gets her nowhere: the worker takes her straight out again.
    expect(await runSystem(videoCallJoined, presence('PA_ana_3', 365), t.scope)).toEqual({
      changed: false,
      kick: true,
    });
    const enter = (more: { ask?: boolean; knockKeyHash?: string } = {}) =>
      runSystem(
        videoCallEnter,
        { workspaceId: t.wsId, attendeeId: booked.attendeeId, name: 'Ana Customer', ...more },
        t.scope,
      );
    expect(await enter()).toMatchObject({ status: 'removed', personId: customerRow });
    await expectHfos(() => enter({ ask: true }), 'validation', 400);
    const back = await enter({ ask: true, knockKeyHash: knockKey() });
    expect(back.status).toBe('knocking');
    expect(await person(back.personId!)).toMatchObject({
      kind: 'guest',
      state: 'waiting',
      person_id: booked.personId,
    });
  });

  it('adds up everyone’s minutes once when the room closes, and a later stretch counts its own', async () => {
    const closed = await runSystem(
      videoCallFinished,
      { workspaceId: t.wsId, callId, roomSid: 'RM_first', at: at(t0, 600) },
      t.scope,
    );
    // Priya's 600 seconds and Ana's 300; Sam was let in and never came.
    expect(closed).toEqual({ changed: true, seconds: 900 });
    expect(await call(callId)).toMatchObject({
      state: 'ended',
      room_sid: null,
      seconds_billed: 900,
    });
    expect((await call(callId)).ended_at).not.toBeNull();
    expect(await person(priyaRow)).toMatchObject({ state: 'left', seconds: 600 });
    const [ended] = await events('video_call.ended', callId);
    expect(ended!.payload).toMatchObject({ roomSid: 'RM_first', seconds: 900, total: 900 });
    expect(
      await runSystem(
        videoCallFinished,
        { workspaceId: t.wsId, callId, roomSid: 'RM_first', at: at(t0, 601) },
        t.scope,
      ),
    ).toEqual({ changed: false, seconds: 0 });

    // Priya starts it again: a new room, its own stretch.
    const again = await run(videoCallJoin, { workspaceId: t.wsId, callId }, t.priya);
    expect(again.call.state).toBe('open');
    // The first room's closing, told late, doesn't end the call she's starting.
    expect(
      await runSystem(
        videoCallFinished,
        { workspaceId: t.wsId, callId, roomSid: 'RM_first', at: at(t0, 990) },
        t.scope,
      ),
    ).toEqual({ changed: false, seconds: 0 });
    expect((await call(callId)).state).toBe('open');
    await runSystem(
      videoCallJoined,
      { workspaceId: t.wsId, callId, personId: priyaRow, roomSid: 'RM_second', at: at(t0, 1000) },
      t.scope,
    );
    expect(
      await runSystem(
        videoCallFinished,
        { workspaceId: t.wsId, callId, roomSid: 'RM_first', at: at(t0, 1010) },
        t.scope,
      ),
    ).toEqual({ changed: false, seconds: 0 });
    expect(
      await runSystem(
        videoCallFinished,
        { workspaceId: t.wsId, callId, roomSid: 'RM_second', at: at(t0, 1060) },
        t.scope,
      ),
    ).toEqual({ changed: true, seconds: 60 });
    expect((await call(callId)).seconds_billed).toBe(960);
    expect(await events('video_call.ended', callId)).toHaveLength(2);
  });

  it('ends for everyone, and whoever is still asking is turned away', async () => {
    const kim = (
      await runSystem(
        videoCallKnock,
        { workspaceId: t.wsId, callId, name: 'Kim Guest', knockKeyHash: knockKey() },
        t.scope,
      )
    ).personId;
    await run(videoCallJoin, { workspaceId: t.wsId, callId }, t.priya);
    expect(await run(videoCallEnd, { workspaceId: t.wsId, callId }, t.priya)).toEqual({
      changed: true,
    });
    expect((await call(callId)).state).toBe('ended');
    expect((await person(kim)).state).toBe('turned_away');
    expect(await run(videoCallEnd, { workspaceId: t.wsId, callId }, t.priya)).toEqual({
      changed: false,
    });
    // Sam's old ticket doesn't open the ended call while nobody from the team is in it.
    expect(
      await runSystem(
        videoCallJoined,
        {
          workspaceId: t.wsId,
          callId,
          personId: sam,
          roomSid: 'RM_third',
          participantSid: 'PA_sam',
          at: at(t0, 2000),
        },
        t.scope,
      ),
    ).toEqual({ changed: false, kick: true });
  });
});

describe('a full call', () => {
  it('has no room for an eleventh person', async () => {
    const b = await booking('13:00');
    const { callId } = await runSystem(
      videoCallOpen,
      { workspaceId: t.wsId, appointmentId: b.appointmentId },
      t.scope,
    );
    for (let i = 0; i < 10; i++)
      await rows(
        admin(),
        sql`insert into app.video_call_people (workspace_id, video_call_id, kind, name, state, joined_at, last_joined_at)
            values (${t.wsId}, ${callId}, 'guest', ${`Guest ${i + 1}`}, 'in', now(), now())`,
      );
    await expectHfos(
      () => run(videoCallJoin, { workspaceId: t.wsId, callId }, t.marco),
      'video_call_full',
      409,
    );
    const full = await runSystem(
      videoCallEnter,
      { workspaceId: t.wsId, attendeeId: b.attendeeId, name: 'Late Customer' },
      t.scope,
    );
    expect(full).toMatchObject({ status: 'full', personId: null });
  });
});

describe('the database', () => {
  let callId: string;
  let customerRow: string;

  beforeAll(async () => {
    const b = await booking('15:00');
    callId = (
      await runSystem(
        videoCallOpen,
        { workspaceId: t.wsId, appointmentId: b.appointmentId },
        t.scope,
      )
    ).callId;
    customerRow = (
      await runSystem(
        videoCallEnter,
        { workspaceId: t.wsId, attendeeId: b.attendeeId, name: 'Rae Customer' },
        t.scope,
      )
    ).personId!;
  });

  it('leaves coming and going to the worker', async () => {
    const e = await asUser(api(), t.member.claims, (tx) =>
      rows(tx, sql`update app.video_call_people set state = 'in' where id = ${customerRow}`),
    ).catch((err: unknown) => err);
    expect(refusal(e)).toBe('video_call_state_transition');
    const bySomeoneElse = await asUser(api(), t.member.claims, (tx) =>
      rows(
        tx,
        sql`update app.video_call_people set state = 'admitted', admitted_by = ${t.priya.id}
            where id = ${customerRow}`,
      ),
    ).catch((err: unknown) => err);
    expect(refusal(bySomeoneElse)).toBe('video_call_state_transition');
    const live = await asUser(api(), t.member.claims, (tx) =>
      rows(tx, sql`update app.video_calls set state = 'live' where id = ${callId}`),
    ).catch((err: unknown) => err);
    expect(refusal(live)).toBe('video_call_state_transition');
  });

  it('lets a teammate add only themselves, and only as let in', async () => {
    const forPriya = await expectPgError(() =>
      asUser(api(), t.member.claims, (tx) =>
        rows(
          tx,
          sql`insert into app.video_call_people (workspace_id, video_call_id, kind, user_id, name, state, admitted_by)
              values (${t.wsId}, ${callId}, 'team', ${t.priya.id}, 'Priya', 'admitted', ${t.member.id})`,
        ),
      ),
    );
    expect(forPriya.code).toBe('42501');
    const alreadyIn = await expectPgError(() =>
      asUser(api(), t.member.claims, (tx) =>
        rows(
          tx,
          sql`insert into app.video_call_people (workspace_id, video_call_id, kind, user_id, name, state, last_joined_at)
              values (${t.wsId}, ${callId}, 'team', ${t.member.id}, 'Mike', 'in', now())`,
        ),
      ),
    );
    expect(alreadyIn.code).toBe('42501');
  });

  it('shows a call only to people in its business', async () => {
    const stranger = await createTestUser('vcall-stranger');
    const seen = await asUser(api(), stranger.claims, (tx) =>
      rows(tx, sql`select id from app.video_calls where id = ${callId}`),
    );
    expect(seen).toEqual([]);
  });
});

describe('a business with video calls off', () => {
  afterAll(() => setCalls(true));

  it('opens nothing, and its appointments get no call', async () => {
    const b = await booking('11:30');
    const { callId } = await runSystem(
      videoCallOpen,
      { workspaceId: t.wsId, appointmentId: b.appointmentId },
      t.scope,
    );
    await setCalls(false);
    await expectHfos(
      () =>
        runSystem(
          videoCallEnter,
          { workspaceId: t.wsId, attendeeId: b.attendeeId, name: 'Off Customer' },
          t.scope,
        ),
      'video_calls_off',
      409,
    );
    await expectHfos(
      () => run(videoCallJoin, { workspaceId: t.wsId, callId }, t.priya),
      'video_calls_off',
    );
    await expectHfos(
      () =>
        runSystem(
          videoCallKnock,
          { workspaceId: t.wsId, callId, name: 'Off Guest', knockKeyHash: knockKey() },
          t.scope,
        ),
      'video_calls_off',
    );
    const later = await booking('16:00');
    expect(await place(later.appointmentId)).toMatchObject({ kind: 'virtual', video: null });
  });
});
