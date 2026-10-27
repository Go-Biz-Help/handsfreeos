/**
 * AI Sales Coach in a HandsFreeOS video call (part 3, docs/video-calls.md "The coach in the call", video-calls/coach.ts),
 * on the real database, with LiveKit's stand-in and the scripted model.
 *
 * What's worth holding:
 *   - the person on the team in the call is coached, with the customer in it, and nobody claims anything;
 *   - each line goes to the coach in order, the team's people on the team's side, and a customer worried about price
 *     gets the playbook's answer on the rep's screen;
 *   - a listener that leaves doesn't end it: when the stretch of the call is over, the job that keeps its words
 *     finishes it from the lines kept, before they go, and it's written up and scored like a call;
 *   - the listener starts the coach itself as it joins, and the team turning AI notes off forgets it: no lines, no
 *     write-up.
 */
import { randomUUID } from 'node:crypto';
import { salescoachAddon } from '@hfos/core/addons/salescoach/manifest';
import { playbookSave } from '@hfos/core/addons/salescoach/ops/playbooks';
import {
  calendarAvailability,
  executeCommand,
  videoCallEnter,
  videoCallFinished,
  videoCallHeard,
  videoCallJoin,
  videoCallJoined,
  videoCallRoom,
  videoCallSetAi,
  type CommandDef,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { scriptedAi } from '../src/ai/scripted';
import { systemActor, workerMeta } from '../src/services';
import { CallCoach } from '../src/video-calls/coach';
import { readFakeListenerTicket } from '../src/video-calls/fake';
import type { JoinRoom, ListenerRoomEvents } from '../src/video-calls/hearing';
import { createListener } from '../src/video-calls/listener';
import { createFakeSpeech, FAKE_HEARD } from '../src/voice-agent/fake-speech';
import {
  admin,
  attendeeByToken,
  bookOnline,
  customer,
  drain,
  HOUR,
  iso,
  makeCalendar,
  makeWorld,
  MIN,
  query,
  run,
  runDue,
  type World,
} from './booking-world';
import { microphone, SAID } from './sound';

let w: World;
let calendar: { id: string; slug: string };
const log = pino({ level: 'silent' });
const scope = () => ({ workspaceId: w.workspaceId, organizationId: w.organizationId });

/** A command as the worker. */
const system = <I extends z.ZodType, O extends z.ZodType>(cmd: CommandDef<I, O>, input: unknown) =>
  executeCommand(w.s.db, cmd, input, systemActor(scope()), workerMeta()).then((r) => r.output);

beforeAll(async () => {
  w = await makeWorld('vcoach', { ai: { provider: scriptedAi() } });
  await rows(
    admin(),
    sql`update app.workspaces set video_calls = true where id = ${w.workspaceId}`,
  );
  await rows(
    admin(),
    sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
        values (${w.workspaceId}, 'salescoach', 'enabled', ${salescoachAddon.version})`,
  );
  await run(w, playbookSave, {
    workspaceId: w.workspaceId,
    name: 'Estimate review',
    details: {
      steps: [
        { id: 's1', title: 'Say hello', say: '' },
        { id: 's2', title: 'Walk through the estimate', say: '' },
      ],
      objections: [
        {
          id: 'o1',
          objection: 'It’s too expensive',
          answer: 'I hear you. We can spread it over three payments.',
        },
      ],
      points: [],
    },
  });
  calendar = await makeCalendar(w, 'Video consult', {
    durations: { minutes: [5], step: 5 },
    locations: { options: [{ kind: 'virtual', video: 'handsfree' }] },
  });
}, 120_000);
afterAll(async () => {
  await w.app.close();
  await closeTestDbs();
});

async function waitFor<T>(what: string, get: () => Promise<T | null | undefined | false>) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const v = await get();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Booked online, with the owner and the customer in the call's room, as LiveKit tells it. */
async function inCall(first: string) {
  const out = await query(w, calendarAvailability, {
    workspaceId: w.workspaceId,
    calendarId: calendar.id,
    from: iso(Date.now() + MIN),
    to: iso(Date.now() + HOUR),
  });
  const startsAt = Date.parse(out.slots[0]!.startsAt);
  const seat = await attendeeByToken(
    (await bookOnline(w, calendar.slug, startsAt, customer(first))).manageToken,
  );
  await drain(w);
  const [c] = await rows<{ id: string }>(
    admin(),
    sql`select id from app.video_calls where appointment_id = ${seat.appointment_id}`,
  );
  const callId = c!.id;
  const roomSid = `RM_${randomUUID().slice(0, 12)}`;
  const team = await run(w, videoCallJoin, { workspaceId: w.workspaceId, callId });
  const joined = (personId: string) =>
    system(videoCallJoined, {
      workspaceId: w.workspaceId,
      callId,
      personId,
      roomSid,
      participantSid: `PA_${randomUUID().slice(0, 8)}`,
      at: iso(Date.now()),
    });
  await joined(team.personId);
  const them = await system(videoCallEnter, {
    workspaceId: w.workspaceId,
    attendeeId: seat.id,
    name: `${first} Customer`,
  });
  await joined(them.personId!);
  const [p] = await rows<{ person_id: string }>(
    admin(),
    sql`select person_id from app.video_call_people where id = ${them.personId}`,
  );
  return {
    callId,
    appointmentId: seat.appointment_id,
    room: videoCallRoom(callId),
    roomSid,
    teamRow: team.personId,
    customerRow: them.personId!,
    personId: p!.person_id,
  };
}

/** The coached call for a stretch of a call, and its live meeting's state. */
const coachedOf = async (roomSid: string) =>
  (
    await rows<{
      id: string;
      state: string;
      user_id: string;
      person_id: string | null;
      lines: { speaker: string; text: string }[];
      meeting: string;
    }>(
      admin(),
      sql`select c.id, c.state, c.user_id, c.person_id, c.lines, m.state as meeting
            from addon_salescoach.calls c join app.live_meetings m on m.id = c.live_meeting_id
           where m.provider = 'handsfree' and m.meeting_uuid = ${roomSid}`,
    )
  )[0];

describe('a video call coached live', () => {
  it('coaches the person on the team in it, and writes it up once the stretch is over', async () => {
    const c = await inCall('Rosa');
    const coach = new CallCoach(w.s, scope(), c.callId, log);
    await coach.check();
    expect(coach.liveMeetingId).toEqual(expect.any(String));
    expect(await coachedOf(c.roomSid)).toMatchObject({
      state: 'live',
      user_id: w.owner.id,
      person_id: c.personId,
      meeting: 'live',
    });

    const t0 = Date.now();
    const line = (n: number, personId: string, text: string) => ({
      key: `rosa:${n}`,
      personId,
      text,
      saidAt: iso(t0 + n * 2_000),
      language: 'en',
    });
    const said = [
      line(0, c.teamRow, 'Hi Rosa, thanks for making time to go over the estimate.'),
      line(1, c.customerRow, 'Honestly the price is too expensive for us right now.'),
    ];
    for (const l of said) coach.heard(l);
    const card = await waitFor('the objection card', async () => {
      const [k] = await rows<{ kind: string; say: string }>(
        admin(),
        sql`select k.kind, k.say from addon_salescoach.cards k
              join addon_salescoach.calls c on c.id = k.coached_call_id
              join app.live_meetings m on m.id = c.live_meeting_id
             where m.meeting_uuid = ${c.roomSid}`,
      );
      return k;
    });
    expect(card).toEqual({
      kind: 'objection',
      say: 'I hear you. We can spread it over three payments.',
    });
    const promise = line(
      2,
      c.teamRow,
      'I hear you. We can spread it over three payments. I’ll send the plan today.',
    );
    coach.heard(promise);
    // What the listener's hearing keeps as it goes.
    await system(videoCallHeard, {
      workspaceId: w.workspaceId,
      callId: c.callId,
      lines: [...said, promise],
    });

    // The listener leaves (alone a while): the coaching carries on until the stretch is over.
    await coach.pause();
    expect((await coachedOf(c.roomSid))!.state).toBe('live');

    // The room closes, and its words are kept a moment on: the coach hears the end first, from the same lines.
    await system(videoCallFinished, {
      workspaceId: w.workspaceId,
      callId: c.callId,
      roomSid: c.roomSid,
      at: iso(t0 + 10_000),
    });
    await drain(w);
    await runDue(w, [`video_call.keep_words:${c.roomSid}`]);
    await drain(w);
    const done = await coachedOf(c.roomSid);
    expect(done).toMatchObject({ state: 'done', meeting: 'ended' });
    expect(done!.lines.map((l) => l.speaker)).toEqual(['team', 'customer', 'team']);
    const [timeline] = await rows<{ words: string }>(
      admin(),
      sql`select meta ->> 'words' as words from app.activities
          where person_id = ${c.personId} and subtype = 'addon_line'`,
    );
    expect(timeline?.words).toMatch(/^Dale’s video call was coached and scored \d+ out of 100$/);
    const [task] = await rows<{ title: string; notes: string }>(
      admin(),
      sql`select title, notes from app.tasks where workspace_id = ${w.workspaceId} and person_id = ${c.personId}`,
    );
    expect(task).toEqual({
      title: 'Send the plan today',
      notes: 'Promised on a coached video call.',
    });
    // And the words became the appointment's transcript, as without the coach.
    const transcripts = await rows(
      admin(),
      sql`select id from app.appointment_transcripts where appointment_id = ${c.appointmentId}`,
    );
    expect(transcripts).toHaveLength(1);
  });
});

interface HeardRoom {
  readonly room: string;
  readonly events: ListenerRoomEvents;
  readonly said: unknown[];
  left: boolean;
}

describe('the listener', () => {
  it('starts the coach as it joins, and the team turning AI notes off forgets the coaching', async () => {
    const c = await inCall('Mo');
    w.s.videoCalls.inRooms.set(c.room, { people: 2, listener: false });
    let clock = Date.now();
    const rooms: HeardRoom[] = [];
    const join: JoinRoom = async (ticket, events) => {
      const r: HeardRoom = {
        room: readFakeListenerTicket(ticket.token)!,
        events,
        said: [],
        left: false,
      };
      rooms.push(r);
      return {
        people: () => (r.left ? 0 : 2),
        say: async (_topic, payload) => {
          r.said.push(payload);
        },
        leave: async () => {
          r.left = true;
        },
      };
    };
    const listener = createListener({
      db: w.s.db,
      log,
      speech: createFakeSpeech(),
      video: w.s.videoCalls,
      join,
      now: () => clock,
      coach: w.s,
    });
    try {
      const inRoom = () => rooms.find((r) => r.room === c.room && !r.left);
      for (let i = 0; i < 20 && !inRoom(); i++) await listener.pass();
      const room = inRoom()!;
      expect(room).toBeDefined();
      expect(await coachedOf(c.roomSid)).toMatchObject({ state: 'live', meeting: 'live' });

      room.events.onVoice({
        identity: c.customerRow,
        name: 'Mo Customer',
        frames: microphone(SAID),
      });
      await vi.waitFor(() => expect(room.said).toHaveLength(1));
      clock += 3_000;
      await listener.tick();

      // AI notes off: its next pass leaves, and the coaching is forgotten with what was heard.
      await run(w, videoCallSetAi, { workspaceId: w.workspaceId, callId: c.callId, on: false });
      await listener.pass();
      expect(room.left).toBe(true);
      const forgotten = await waitFor('the coaching forgotten', async () => {
        const k = await coachedOf(c.roomSid);
        return k?.state === 'stopped' ? k : null;
      });
      expect(forgotten).toMatchObject({ lines: [], meeting: 'ended' });
      expect(JSON.stringify(forgotten)).not.toContain(FAKE_HEARD);
      const written = await rows(
        admin(),
        sql`select id from app.scheduled_jobs where dedupe_key = ${`salescoach.after_call:${forgotten.id}`}`,
      );
      expect(written).toEqual([]);
    } finally {
      await listener.stop();
    }
  });
});
