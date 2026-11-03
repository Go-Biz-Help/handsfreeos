/**
 * What a HandsFreeOS video call really used (docs/video-calls.md, "What a call used"), on the real database: every
 * connection LiveKit bills, and what each person's screen says it downloaded on it.
 *
 * What's worth holding:
 *   - every connection LiveKit tells of is kept once, a reload's and the AI listener's included, and closed when it
 *     leaves or the room closes;
 *   - what a screen downloaded is kept as the most it has said, only for its own connection, never past what that
 *     connection could have carried, and only until a few minutes after it left;
 *   - only the worker writes it, and only the call's business sees it.
 */
import { asUser, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, expectPgError, testDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mostDownloadable, VIDEO_CALL_DATA_LATE_MS } from '../src/meetings/call-data';
import {
  videoCallData,
  videoCallEnter,
  videoCallFinished,
  videoCallJoin,
  videoCallJoined,
  videoCallLeft,
  videoCallListener,
  videoCallOpen,
} from '../src/server';
import {
  admin,
  bookOnline,
  isoAt,
  makeCalendar,
  nextWeekday,
  run,
  runSystem,
  setupTeam,
  type Team,
} from './calendar-helpers';

const api = () => testDbs().api.db;

let t: Team;
let callId: string;
let priyaRow: string;
let anaRow: string;
const t0 = Date.now();
const at = (seconds: number) => new Date(t0 + seconds * 1000).toISOString();

const connections = async () =>
  rows<{
    kind: string;
    person_row_id: string | null;
    room_sid: string;
    participant_sid: string;
    left_at: string | null;
    bytes_received: string;
    reported_at: string | null;
  }>(
    admin(),
    sql`select kind, person_row_id, room_sid, participant_sid, left_at, bytes_received::text, reported_at
        from app.video_call_connections where video_call_id = ${callId} order by joined_at, participant_sid`,
  );

/** A time as the database gives it back, compared as the moment it is. */
const iso = (d: string | Date | null) => (d ? new Date(d).toISOString() : null);

const presence = (personId: string, participantSid: string, seconds: number) => ({
  workspaceId: t.wsId,
  callId,
  personId,
  roomSid: 'RM_data',
  participantSid,
  at: at(seconds),
});

const data = (personId: string, participantSid: string, bytes: number, seconds: number) =>
  runSystem(
    videoCallData,
    { workspaceId: t.wsId, callId, personId, participantSid, bytes, at: at(seconds) },
    t.scope,
  );

beforeAll(async () => {
  t = await setupTeam('vdata');
  await rows(admin(), sql`update app.workspaces set video_calls = true where id = ${t.wsId}`);
  const cal = await makeCalendar(t, 'Video consults', {
    public: true,
    team: { members: [{ userId: t.priya.id }] },
    locations: { options: [{ kind: 'virtual', video: 'handsfree' }] },
  });
  const b = await bookOnline(t, cal.id, isoAt(nextWeekday(3, 4), '10:00'));
  callId = (
    await runSystem(videoCallOpen, { workspaceId: t.wsId, appointmentId: b.appointmentId }, t.scope)
  ).callId;
  anaRow = (
    await runSystem(
      videoCallEnter,
      { workspaceId: t.wsId, attendeeId: b.attendeeId, name: 'Ana Customer' },
      t.scope,
    )
  ).personId!;
  priyaRow = (await run(videoCallJoin, { workspaceId: t.wsId, callId }, t.priya)).personId;
});
afterAll(closeTestDbs);

describe('a call’s connections', () => {
  it('keeps every one LiveKit tells of once, a reload’s and the AI listener’s included', async () => {
    await runSystem(videoCallJoined, presence(priyaRow, 'PA_priya', 0), t.scope);
    await runSystem(videoCallJoined, presence(priyaRow, 'PA_priya', 1), t.scope);
    await runSystem(
      videoCallListener,
      {
        workspaceId: t.wsId,
        callId,
        event: 'joined',
        roomSid: 'RM_data',
        participantSid: 'PA_listener',
        at: at(5),
      },
      t.scope,
    );
    await runSystem(videoCallJoined, presence(anaRow, 'PA_ana_1', 10), t.scope);
    // Ana reloads: a new connection takes over, and the old one leaving closes only that one.
    await runSystem(videoCallJoined, presence(anaRow, 'PA_ana_2', 40), t.scope);
    await runSystem(videoCallLeft, presence(anaRow, 'PA_ana_1', 41), t.scope);
    const list = await connections();
    expect(list.map((c) => [c.kind, c.person_row_id, c.participant_sid, !!c.left_at])).toEqual([
      ['person', priyaRow, 'PA_priya', false],
      ['listener', null, 'PA_listener', false],
      ['person', anaRow, 'PA_ana_1', true],
      ['person', anaRow, 'PA_ana_2', false],
    ]);
    expect(iso(list[2]!.left_at)).toBe(at(41));
  });

  it('keeps what each screen downloaded: the most it said, only on its own connection', async () => {
    expect(await data(priyaRow, 'PA_priya', 5_000_000, 60)).toEqual({
      kept: true,
      bytes: 5_000_000,
    });
    // Counts only go up: an older report arriving late changes nothing.
    expect(await data(priyaRow, 'PA_priya', 4_000_000, 61)).toEqual({
      kept: false,
      bytes: 5_000_000,
    });
    // Priya's ticket can't speak for Ana's connection, or for one LiveKit never told of.
    expect(await data(priyaRow, 'PA_ana_2', 9_000_000, 62)).toEqual({ kept: false, bytes: 0 });
    expect(await data(priyaRow, 'PA_made_up', 9_000_000, 62)).toEqual({ kept: false, bytes: 0 });
    const priya = (await connections()).find((c) => c.participant_sid === 'PA_priya')!;
    expect(priya.bytes_received).toBe('5000000');
    expect(iso(priya.reported_at)).toBe(at(60));
  });

  it('never keeps more than the connection could have carried in the time', async () => {
    // Ana's second connection has been in a minute: two minutes' worth at most, with the grace.
    expect(await data(anaRow, 'PA_ana_2', 1e12, 100)).toEqual({
      kept: true,
      bytes: mostDownloadable(60_000),
    });
  });

  it('closes every connection still open when the room closes, and takes a last report a few minutes after', async () => {
    await runSystem(
      videoCallFinished,
      { workspaceId: t.wsId, callId, roomSid: 'RM_data', at: at(600) },
      t.scope,
    );
    const list = await connections();
    expect(list.every((c) => c.left_at)).toBe(true);
    expect(iso(list.find((c) => c.participant_sid === 'PA_priya')!.left_at)).toBe(at(600));
    // The page's report as it closed comes in just after.
    expect(await data(priyaRow, 'PA_priya', 6_000_000, 620)).toEqual({
      kept: true,
      bytes: 6_000_000,
    });
    // Much later is too late.
    expect(
      await data(priyaRow, 'PA_priya', 7_000_000, 600 + VIDEO_CALL_DATA_LATE_MS / 1000 + 1),
    ).toEqual({ kept: false, bytes: 6_000_000 });
    // A closing told late doesn't move one already closed.
    await runSystem(videoCallLeft, presence(priyaRow, 'PA_priya', 700), t.scope);
    expect(iso((await connections()).find((c) => c.participant_sid === 'PA_priya')!.left_at)).toBe(
      at(600),
    );
  });
});

describe('the database', () => {
  it('is written by the worker alone', async () => {
    const e = await expectPgError(() =>
      asUser(api(), t.owner.claims, (tx) =>
        rows(
          tx,
          sql`update app.video_call_connections set bytes_received = 1 where video_call_id = ${callId}`,
        ),
      ),
    );
    expect(e.code).toBe('42501');
  });

  it('shows a call’s connections to its business, and to nobody else', async () => {
    const seen = await asUser(api(), t.owner.claims, (tx) =>
      rows(tx, sql`select id from app.video_call_connections where video_call_id = ${callId}`),
    );
    expect(seen).toHaveLength(4);
    const stranger = await createTestUser('vdata-stranger');
    const not = await asUser(api(), stranger.claims, (tx) =>
      rows(tx, sql`select id from app.video_call_connections where video_call_id = ${callId}`),
    );
    expect(not).toEqual([]);
  });
});
