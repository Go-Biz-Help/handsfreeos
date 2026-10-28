/**
 * HandsFreeOS video calls (docs/video-calls.md) through the worker's own routes, jobs and LiveKit's webhooks, on the
 * real database, with LiveKit's stand-in.
 *
 * What's worth holding:
 *   - an appointment booked for one gets its call, the team's address for it goes on its place, and the customer's
 *     messages carry their own Join link instead;
 *   - the team joins with a ticket for that room alone; nobody signed out or from another business gets one;
 *   - a customer's link opens the call an hour ahead and until it's over; they wait until someone from the team is
 *     in, then go straight in, and the team's phones hear once per wait;
 *   - LiveKit is believed only when it signed; someone taken out who comes back on an old ticket is taken out again;
 *   - taking out, muting and ending reach LiveKit, and when the room closes everyone's minutes go on the balance once;
 *   - anyone else on the call's link asks to be let in, sees the business's name and never the appointment's, and only
 *     their own page hears how it went;
 *   - with calls off for the business, or LiveKit not set up, nothing opens;
 *   - the customer is told the AI takes notes: on the booking page, in their messages and before they join;
 *   - the AI's listener joins only a room with people in it, hears each person, keeps who said what, puts only the
 *     sound it sent on the balance, and leaves once it's alone; when the call ends, what it heard becomes the
 *     appointment's transcript once, and After the call starts from it;
 *   - the team turning AI notes off forgets what was heard, and the listener leaves;
 *   - a call with a customer that isn't for an appointment (part 5) sends them their own link on the business's
 *     address, lets them in on it once the team is there, becomes a line on their timeline with its transcript and
 *     summary, and stops opening a day after it was sent.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  calendarAvailability,
  callSuggestionList,
  captionOf,
  executeCommand,
  pushDeviceRegister,
  VIDEO_CALL_WORDS,
  videoCallAdmit,
  videoCallEnd,
  videoCallHeard,
  videoCallKeepWords,
  videoCallMute,
  videoCallRemove,
  videoCallRoom,
  videoCallSetAi,
  videoCallTurnAway,
  videoCallUsageKey,
  LISTENER_IDENTITY,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, signInTestUser, testDbs } from '@hfos/db/testing';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { passThroughBotCheck } from '../src/booking/bot-check';
import { whereLine } from '../src/booking/messages';
import { loadBooking } from '../src/booking/visit';
import { buildHttpServer } from '../src/http/server';
import { queueMeetingSync } from '../src/meetings/sync';
import { systemActor, workerMeta } from '../src/services';
import { fakeVideoWebhook, readFakeListenerTicket, readFakeTicket } from '../src/video-calls/fake';
import { ALONE_MS, GATE, type JoinRoom, type ListenerRoomEvents } from '../src/video-calls/hearing';
import { createListener } from '../src/video-calls/listener';
import { createFakeSpeech, FAKE_HEARD } from '../src/voice-agent/fake-speech';
import {
  admin,
  at,
  attendeeByToken,
  bookOnline,
  BUSINESS,
  customer,
  drain,
  errorOf,
  get,
  HOUR,
  iso,
  jobRow,
  makeCalendar,
  makeWorld,
  MIN,
  query,
  run,
  runDue,
  type World,
} from './booking-world';
import { testTokenVerifier } from './finish-sign-in';
import { microphone, SAID } from './sound';

const PHONE_BROWSER = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15';
const ROOM = { max: 10_000, timeWindow: MIN };

let w: World;
let calendar: { id: string; slug: string };
let ownerToken: string;
let ownerPhone: string;

beforeAll(async () => {
  w = await makeWorld('vcalls');
  // Support's switch (the /admin page's, tested in core).
  await rows(
    admin(),
    sql`update app.workspaces set video_calls = true where id = ${w.workspaceId}`,
  );
  calendar = await makeCalendar(w, 'Video consult', {
    // Five-minute calls, so the next hour holds enough of them for every test that needs one now.
    durations: { minutes: [5], step: 5 },
    locations: { options: [{ kind: 'virtual', video: 'handsfree' }] },
  });
  ownerToken = await signInTestUser(w.owner);
  ownerPhone = `ExponentPushToken[vcalls-${randomUUID().slice(0, 12)}]`;
  await run(w, pushDeviceRegister, {
    platform: 'ios',
    token: ownerPhone,
    appVersion: '1.0.0',
    deviceName: 'ios',
  });
}, 120_000);
afterAll(async () => {
  await w.app.close();
  await closeTestDbs();
});

/** The calendar's soonest open time, a minute or more from now. */
async function soonest(): Promise<number> {
  const out = await query(w, calendarAvailability, {
    workspaceId: w.workspaceId,
    calendarId: calendar.id,
    from: iso(Date.now() + MIN),
    to: iso(Date.now() + HOUR),
  });
  const slot = out.slots[0];
  if (!slot) throw new Error('no open time in the next hour');
  return Date.parse(slot.startsAt);
}

/** The Join link a customer's own messages carry. */
async function joinLinkOf(attendeeId: string): Promise<string> {
  const b = await asWorker(
    w.s.db,
    { workspaceId: w.workspaceId, organizationId: w.organizationId },
    (tx) => loadBooking(tx, w.s, attendeeId, { forCustomer: true }),
  );
  return b!.visit.meetingUrl!;
}

/** Booked on the public page, and the worker caught up: its call made and its address on the place. */
async function booked(first: string, startsAt: number) {
  const b = await bookOnline(w, calendar.slug, startsAt, customer(first));
  const seat = await attendeeByToken(b.manageToken);
  await drain(w);
  const [c] = await rows<{ id: string }>(
    admin(),
    sql`select id from app.video_calls where appointment_id = ${seat.appointment_id}`,
  );
  if (!c) throw new Error('the booking got no video call');
  return {
    attendeeId: seat.id,
    appointmentId: seat.appointment_id,
    callId: c.id,
    room: videoCallRoom(c.id),
    link: await joinLinkOf(seat.id),
  };
}

const placeOf = async (appointmentId: string) =>
  (
    await rows<{ location: Record<string, unknown> }>(
      admin(),
      sql`select location from app.appointments where id = ${appointmentId}`,
    )
  )[0]!.location;

const callRow = async (callId: string) =>
  (
    await rows<{ state: string; room_sid: string | null; host_user_id: string | null }>(
      admin(),
      sql`select state, room_sid, host_user_id from app.video_calls where id = ${callId}`,
    )
  )[0]!;

/** Someone from the team presses Join on the appointment. */
const teamJoin = (token: string | null, callId: string, app: FastifyInstance = w.app) =>
  app.inject({
    method: 'POST',
    url: '/v1/video-calls/join',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    payload: JSON.stringify({ callId }),
  });

const tokenOf = (link: string) => link.split('/j/')[1]!;

/** The customer's page opening their Join link. */
const openLink = (link: string, app: FastifyInstance = w.app) =>
  app.inject({
    method: 'POST',
    url: `/public/join/${tokenOf(link)}`,
    headers: { 'content-type': 'application/json', 'user-agent': PHONE_BROWSER },
    payload: '{}',
  });

/** The customer pressing Join on that page (and the page asking again while they wait). */
const enter = (link: string, body: Record<string, unknown>) =>
  w.app.inject({
    method: 'POST',
    url: `/public/join/${tokenOf(link)}/enter`,
    headers: { 'content-type': 'application/json', 'user-agent': PHONE_BROWSER },
    payload: JSON.stringify(body),
  });

const publicCall = (callId: string, app: FastifyInstance = w.app) =>
  app.inject({ method: 'GET', url: `/public/calls/${callId}` });

const knock = (callId: string, body: Record<string, unknown>) =>
  w.app.inject({
    method: 'POST',
    url: `/public/calls/${callId}/knock`,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });

const knockStatus = (callId: string, personId: string, key: string) =>
  w.app.inject({
    method: 'POST',
    url: `/public/calls/${callId}/knock/${personId}`,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ key }),
  });

/** The random key a waiting page keeps to itself. */
const pageKey = () => randomBytes(32).toString('base64url');

/** LiveKit's webhook, as the stand-in signs it. */
function hook(
  event: string,
  room: string,
  opts: { identity?: string; participantSid?: string; roomSid?: string; at?: number } = {},
  app: FastifyInstance = w.app,
  id = `EV_${randomUUID()}`,
) {
  const e = fakeVideoWebhook({
    event,
    id,
    createdAt: BigInt(Math.floor((opts.at ?? Date.now()) / 1000)),
    room: { sid: opts.roomSid ?? 'RM_default', name: room },
    ...(opts.identity
      ? {
          participant: {
            sid: opts.participantSid ?? `PA_${randomUUID().slice(0, 8)}`,
            identity: opts.identity,
          },
        }
      : {}),
  });
  return app.inject({
    method: 'POST',
    url: '/webhooks/livekit',
    headers: { 'content-type': 'application/webhook+json', authorization: e.authorization },
    payload: e.body,
  });
}

/** LiveKit says someone came into the room, and the worker acts on it. */
async function cameIn(
  room: string,
  identity: string,
  opts: { participantSid?: string; roomSid?: string; at?: number } = {},
) {
  const res = await hook('participant_joined', room, { identity, ...opts });
  expect(res.statusCode, res.body).toBe(200);
  await drain(w);
}

const stored = async (room: string) =>
  (
    await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.webhook_deliveries
          where provider = 'livekit' and account_ref = ${room}`,
    )
  )[0]!.n;

const ticketOf = (res: LightMyRequestResponse) =>
  readFakeTicket((res.json() as { ticket: { token: string } }).ticket.token);

const pushesAbout = (callId: string) =>
  w.s.push.fake.sent.filter(
    (p) => p.message.to === ownerPhone && p.message.collapseId === `video-call-${callId}`,
  );

const joinedAt = async (attendeeId: string) =>
  (
    await rows<{ joined_at: Date | null }>(
      admin(),
      sql`select joined_at from app.appointment_attendees where id = ${attendeeId}`,
    )
  )[0]!.joined_at;

describe('an appointment booked for a video call', () => {
  it('gets its call, with the team’s address on its place and the customer’s own Join link in their messages', async () => {
    const b = await booked('Ana', at(1, '10:00'));
    expect(await placeOf(b.appointmentId)).toMatchObject({
      kind: 'virtual',
      video: 'handsfree',
      meetingUrl: `${w.s.webUrl}/call/${b.callId}`,
      meetingId: b.callId,
    });
    expect(await callRow(b.callId)).toMatchObject({ state: 'open', host_user_id: w.owner.id });
    expect(b.link).toMatch(/\/j\/[0-9A-Za-z]{18}$/);
    const staff = await asWorker(
      w.s.db,
      { workspaceId: w.workspaceId, organizationId: w.organizationId },
      (tx) => loadBooking(tx, w.s, b.attendeeId),
    );
    expect(staff!.visit.meetingUrl).toBe(`${w.s.webUrl}/call/${b.callId}`);

    // The job again (a move, a reassignment): the same call, the same address.
    const scope = { workspaceId: w.workspaceId, organizationId: w.organizationId };
    await asWorker(w.s.db, scope, (tx) => queueMeetingSync(tx, scope, b.appointmentId));
    await drain(w);
    const calls = await rows<{ id: string }>(
      admin(),
      sql`select id from app.video_calls where appointment_id = ${b.appointmentId}`,
    );
    expect(calls).toEqual([{ id: b.callId }]);
    expect(await placeOf(b.appointmentId)).toMatchObject({ meetingId: b.callId });
  });
});

describe('the team', () => {
  it('joins with a ticket for the call’s room alone, and nobody signed out or from elsewhere gets one', async () => {
    const b = await booked('Bea', at(1, '11:00'));
    expect((await teamJoin(null, b.callId)).statusCode).toBe(401);
    const stranger = await createTestUser('vcalls-stranger');
    const elsewhere = await teamJoin(await signInTestUser(stranger), b.callId);
    expect(elsewhere.statusCode).toBe(404);
    expect((await teamJoin(ownerToken, randomUUID())).statusCode).toBe(404);

    const res = await teamJoin(ownerToken, b.callId);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { workspaceId: string; personId: string; name: string };
    expect(body).toMatchObject({
      workspaceId: w.workspaceId,
      call: { id: b.callId, state: 'open', appointmentId: b.appointmentId },
      name: 'Dale Owner',
      ticket: { url: 'fake:' },
    });
    expect(ticketOf(res)).toEqual({
      room: b.room,
      identity: body.personId,
      name: 'Dale Owner',
      kind: 'team',
    });
    expect(res.headers['cache-control']).toBe('no-store');
    // Pressed again (a second tab): the same person in the room, not a second one.
    expect((await teamJoin(ownerToken, b.callId)).json()).toMatchObject({
      personId: body.personId,
    });
  });
});

describe('a customer on their own Join link', () => {
  it('opens the call from an hour ahead until it’s over, and says when outside that', async () => {
    const later = await booked('Cal', at(1, '12:00'));
    expect((await openLink(later.link)).json()).toMatchObject({
      state: 'early',
      title: 'Video consult',
      business: BUSINESS,
    });
    const tooSoon = await enter(later.link, { name: 'Cal Customer' });
    expect(tooSoon.statusCode).toBe(409);
    expect(errorOf(tooSoon).rule).toBe('video_call_early');

    const soon = await booked('Dee', await soonest());
    const opened = await openLink(soon.link);
    expect(opened.statusCode, opened.body).toBe(200);
    expect(opened.json()).toMatchObject({
      state: 'call',
      title: 'Video consult',
      business: BUSINESS,
      name: 'Dee Customer',
      look: expect.any(Object),
    });
    // Opening the page isn't joining: that's counted once they're really in the call.
    expect(await joinedAt(soon.attendeeId)).toBeNull();

    // It ran a few hours ago.
    await rows(
      admin(),
      sql`update app.appointments set starts_at = now() - interval '3 hours',
            ends_at = now() - interval '2 hours 50 minutes'
          where id = ${later.appointmentId}`,
    );
    expect((await openLink(later.link)).json()).toMatchObject({ state: 'over' });
    const over = await enter(later.link, { name: 'Cal Customer' });
    expect(over.statusCode).toBe(409);
    expect(errorOf(over).rule).toBe('video_call_over');
  });

  it('waits until someone from the team is in, then goes straight in, and the team hears once per wait', async () => {
    const b = await booked('Eli', await soonest());
    const first = await enter(b.link, { name: 'Eli Customer' });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({
      status: 'waiting',
      callId: b.callId,
      name: 'Eli Customer',
      host: 'Dale',
      ticket: null,
    });
    await drain(w);
    expect(pushesAbout(b.callId)).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ title: 'Eli Customer is waiting in the video call' }),
      }),
    ]);
    // Tapping it opens the call itself: the phone's call screen, or the call's page on the web.
    expect(pushesAbout(b.callId)[0]!.message.data).toMatchObject({
      path: `/app/w/${w.workspaceId}/call/${b.callId}`,
    });
    // The page asks again while they wait: no new wait, nobody told again.
    expect((await enter(b.link, { name: 'Eli Customer' })).json()).toMatchObject({
      status: 'waiting',
    });
    await drain(w);
    expect(pushesAbout(b.callId)).toHaveLength(1);

    const team = (await teamJoin(ownerToken, b.callId)).json() as { personId: string };
    // Let in by the team isn't in the room yet: still waiting.
    expect((await enter(b.link, { name: 'Eli Customer' })).json()).toMatchObject({
      status: 'waiting',
    });
    await cameIn(b.room, team.personId, { roomSid: 'RM_eli' });
    expect(await callRow(b.callId)).toMatchObject({ state: 'live', room_sid: 'RM_eli' });

    const inNow = await enter(b.link, { name: 'Eli Customer' });
    expect(inNow.json()).toMatchObject({ status: 'in', ticket: { url: 'fake:' } });
    const said = inNow.json() as { personId: string };
    expect(ticketOf(inNow)).toEqual({
      room: b.room,
      identity: said.personId,
      name: 'Eli Customer',
      kind: 'customer',
    });
    expect(await joinedAt(b.attendeeId)).toBeNull();
    await cameIn(b.room, said.personId, { roomSid: 'RM_eli' });
    // Really in the call: that's joining, for attendance and workflows.
    expect(await joinedAt(b.attendeeId)).not.toBeNull();
  });
});

describe('LiveKit’s word', () => {
  it('is believed only when signed, and keeps nothing about other rooms or the AI’s listener', async () => {
    const b = await booked('Fay', at(1, '13:00'));
    const unsigned = await w.app.inject({
      method: 'POST',
      url: '/webhooks/livekit',
      headers: { 'content-type': 'application/webhook+json' },
      payload: JSON.stringify({ event: 'room_finished', id: 'EV_x', room: { name: b.room } }),
    });
    expect(unsigned.statusCode).toBe(401);
    const report = fakeVideoWebhook({ event: 'room_finished', id: 'EV_y', room: { name: b.room } });
    const forged = await w.app.inject({
      method: 'POST',
      url: '/webhooks/livekit',
      headers: { 'content-type': 'application/webhook+json', authorization: 'not-the-key' },
      payload: report.body,
    });
    expect(forged.statusCode).toBe(401);

    // Nothing to keep: a room starting, the AI's listener, a room that isn't a call, a call that isn't there.
    const otherRoom = 'someone-elses-room';
    const goneCall = videoCallRoom(randomUUID());
    for (const told of [
      await hook('room_started', b.room),
      await hook('participant_joined', b.room, { identity: LISTENER_IDENTITY }),
      await hook('participant_joined', otherRoom, { identity: randomUUID() }),
      await hook('participant_joined', goneCall, { identity: randomUUID() }),
    ])
      expect(told.statusCode).toBe(200);
    for (const room of [b.room, otherRoom, goneCall]) expect(await stored(room)).toBe(0);

    // Told twice (LiveKit retries): kept once.
    const team = (await teamJoin(ownerToken, b.callId)).json() as { personId: string };
    const id = `EV_${randomUUID()}`;
    for (let i = 0; i < 2; i++)
      expect(
        (
          await hook(
            'participant_joined',
            b.room,
            { identity: team.personId, roomSid: 'RM_fay' },
            w.app,
            id,
          )
        ).statusCode,
      ).toBe(200);
    expect(await stored(b.room)).toBe(1);
    await drain(w);
    expect(await callRow(b.callId)).toMatchObject({ state: 'live' });
  });

  it('takes someone out who comes back on an old ticket, and they come back only by asking', async () => {
    const b = await booked('Gus', await soonest());
    const team = (await teamJoin(ownerToken, b.callId)).json() as { personId: string };
    await cameIn(b.room, team.personId, { roomSid: 'RM_gus' });
    const gus = (await enter(b.link, { name: 'Gus Customer' })).json() as {
      status: string;
      personId: string;
    };
    expect(gus.status).toBe('in');
    await cameIn(b.room, gus.personId, { roomSid: 'RM_gus', participantSid: 'PA_gus_1' });

    await run(w, videoCallRemove, {
      workspaceId: w.workspaceId,
      callId: b.callId,
      personId: gus.personId,
    });
    await drain(w);
    const takenOut = () => w.s.videoCalls.removed.filter((r) => r.identity === gus.personId);
    expect(takenOut()).toEqual([{ room: b.room, identity: gus.personId }]);
    const left = await hook('participant_left', b.room, {
      identity: gus.personId,
      participantSid: 'PA_gus_1',
      roomSid: 'RM_gus',
    });
    expect(left.statusCode).toBe(200);
    await drain(w);

    // Their page reconnects with the ticket it still has: straight back out.
    await cameIn(b.room, gus.personId, { roomSid: 'RM_gus', participantSid: 'PA_gus_2' });
    expect(takenOut()).toHaveLength(2);

    // Join again only says they were taken out; asking to come back is a request the team answers.
    expect((await enter(b.link, { name: 'Gus Customer' })).json()).toMatchObject({
      status: 'removed',
      ticket: null,
    });
    const key = pageKey();
    const asked = await enter(b.link, { name: 'Gus Customer', ask: true, key });
    expect(asked.json()).toMatchObject({ status: 'knocking', ticket: null });
    const knockId = (asked.json() as { personId: string }).personId;
    expect(knockId).not.toBe(gus.personId);
    await drain(w);
    expect(pushesAbout(b.callId).at(-1)?.message.title).toBe(
      'Gus Customer is asking to join the video call',
    );
    expect((await knockStatus(b.callId, knockId, key)).json()).toMatchObject({
      status: 'waiting',
    });
  });

  it('mutes and ends for everyone, and the room closing puts everyone’s minutes on the balance once', async () => {
    const b = await booked('Hal', await soonest());
    const roomSid = `RM_${randomUUID().slice(0, 12)}`;
    const t0 = Date.now() - 10 * MIN;
    const team = (await teamJoin(ownerToken, b.callId)).json() as { personId: string };
    await cameIn(b.room, team.personId, { roomSid, at: t0 });
    const hal = (await enter(b.link, { name: 'Hal Customer' })).json() as { personId: string };
    await cameIn(b.room, hal.personId, { roomSid, at: t0 + 60_000 });

    await run(w, videoCallMute, {
      workspaceId: w.workspaceId,
      callId: b.callId,
      personId: hal.personId,
    });
    await drain(w);
    expect(w.s.videoCalls.muted).toContainEqual({ room: b.room, identity: hal.personId });

    await run(w, videoCallEnd, { workspaceId: w.workspaceId, callId: b.callId });
    await drain(w);
    expect(w.s.videoCalls.closed).toContain(b.room);

    // LiveKit closes the room five minutes in: Dale's five minutes and Hal's four.
    const closedAt = t0 + 5 * MIN;
    const id = `EV_${randomUUID()}`;
    expect(
      (await hook('room_finished', b.room, { roomSid, at: closedAt }, w.app, id)).statusCode,
    ).toBe(200);
    await drain(w);
    const charges = () =>
      rows<{ quantity: string; idempotency_key: string; subject: string; amount_cents: string }>(
        admin(),
        sql`select quantity::text, idempotency_key, subject, amount_cents::text from app.usage_ledger
            where workspace_id = ${w.workspaceId} and rate_key = 'video.minute' and provider_ref = ${roomSid}`,
      );
    const [charge, ...more] = await charges();
    expect(more).toEqual([]);
    expect(Number(charge!.quantity)).toBe(9);
    expect(charge).toMatchObject({
      idempotency_key: videoCallUsageKey(roomSid),
      subject: expect.stringContaining('Video call: '),
    });
    expect(Number(charge!.amount_cents)).toBeLessThan(0);
    expect(await callRow(b.callId)).toMatchObject({ state: 'ended', room_sid: null });

    // Told again, under the same id or another: still once.
    await hook('room_finished', b.room, { roomSid, at: closedAt }, w.app, id);
    await hook('room_finished', b.room, { roomSid, at: closedAt + 1000 });
    await drain(w);
    expect(await charges()).toHaveLength(1);
  });
});

describe('anyone else on the call’s link', () => {
  it('asks to be let in, sees the business and not the appointment, and only their page hears back', async () => {
    const b = await booked('Ivy', at(1, '14:00'));
    const page = await publicCall(b.callId);
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json()).toMatchObject({
      business: BUSINESS,
      state: 'open',
      host: 'Dale',
      ready: true,
    });
    expect(page.body).not.toContain('Video consult');
    expect(page.body).not.toContain('Ivy');
    expect((await publicCall('not-a-call')).statusCode).toBe(404);
    expect((await publicCall(randomUUID())).statusCode).toBe(404);

    const blank = await knock(b.callId, { name: '  ', key: pageKey() });
    expect(blank.statusCode).toBe(400);
    const camKey = pageKey();
    const cam = await knock(b.callId, { name: 'Cam Guest', key: camKey });
    expect(cam.statusCode, cam.body).toBe(200);
    expect(cam.json()).toMatchObject({ status: 'waiting', host: 'Dale' });
    const camId = (cam.json() as { personId: string }).personId;
    await drain(w);
    expect(pushesAbout(b.callId).at(-1)?.message.title).toBe(
      'Cam Guest is asking to join the video call',
    );

    // Only the page that asked holds the key.
    expect((await knockStatus(b.callId, camId, pageKey())).statusCode).toBe(404);
    expect((await knockStatus(b.callId, camId, camKey)).json()).toMatchObject({
      status: 'waiting',
      name: 'Cam Guest',
      ticket: null,
    });

    await run(w, videoCallAdmit, { workspaceId: w.workspaceId, callId: b.callId, personId: camId });
    const letIn = await knockStatus(b.callId, camId, camKey);
    expect(letIn.json()).toMatchObject({ status: 'in', ticket: { url: 'fake:' } });
    expect(ticketOf(letIn)).toEqual({
      room: b.room,
      identity: camId,
      name: 'Cam Guest',
      kind: 'guest',
    });

    const deeKey = pageKey();
    const dee = (await knock(b.callId, { name: 'Dee Guest', key: deeKey })).json() as {
      personId: string;
    };
    await run(w, videoCallTurnAway, {
      workspaceId: w.workspaceId,
      callId: b.callId,
      personId: dee.personId,
    });
    expect((await knockStatus(b.callId, dee.personId, deeKey)).json()).toMatchObject({
      status: 'turned_away',
      ticket: null,
    });
    // Turned away, they never come in on a ticket: LiveKit letting them in is undone.
    await cameIn(b.room, dee.personId);
    expect(w.s.videoCalls.removed).toContainEqual({ room: b.room, identity: dee.personId });
  });
});

/** A room the AI's listener is in, through the stand-in for LiveKit's media library. */
interface HeardRoom {
  readonly room: string;
  readonly events: ListenerRoomEvents;
  /** What it sent everyone (captions). */
  readonly said: { topic: string; payload: Uint8Array }[];
  people: number;
  left: boolean;
}

/** The AI's listener, as the media process runs it, on a clock the test moves. */
function listening() {
  let clock = Date.now();
  const rooms: HeardRoom[] = [];
  const join: JoinRoom = async (ticket, events) => {
    const r: HeardRoom = {
      room: readFakeListenerTicket(ticket.token)!,
      events,
      said: [],
      people: 2,
      left: false,
    };
    rooms.push(r);
    return {
      people: () => (r.left ? 0 : r.people),
      say: async (topic, payload) => {
        r.said.push({ topic, payload });
      },
      leave: async () => {
        r.left = true;
      },
    };
  };
  const listener = createListener({
    db: w.s.db,
    log: pino({ level: 'silent' }),
    speech: createFakeSpeech(),
    video: w.s.videoCalls,
    join,
    now: () => clock,
  });
  const inRoom = (room: string) => rooms.find((r) => r.room === room && !r.left);
  return {
    listener,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    /** Its passes until it's in the room: other calls, still live from earlier tests, can come first. */
    async joined(room: string): Promise<HeardRoom> {
      for (let i = 0; i < 20 && !inRoom(room); i++) await listener.pass();
      const r = inRoom(room);
      if (!r) throw new Error(`the listener never joined ${room}`);
      return r;
    },
  };
}

const linesOf = (callId: string) =>
  rows<{
    person_row_id: string;
    side: string;
    name: string;
    body: string;
    language: string | null;
  }>(
    admin(),
    sql`select person_row_id, side, name, body, language from app.video_call_lines
        where video_call_id = ${callId} order by said_at, line_key`,
  );

const transcriptsOf = (appointmentId: string) =>
  rows<{ id: string; provider: string; external_id: string; body: string }>(
    admin(),
    sql`select id, provider, external_id, body from app.appointment_transcripts
        where appointment_id = ${appointmentId}`,
  );

/** The team and a customer in the call, as LiveKit tells it. */
async function inCall(first: string) {
  const b = await booked(first, await soonest());
  const roomSid = `RM_${randomUUID().slice(0, 12)}`;
  const team = (await teamJoin(ownerToken, b.callId)).json() as { personId: string; name: string };
  await cameIn(b.room, team.personId, { roomSid });
  const them = (await enter(b.link, { name: `${first} Customer` })).json() as {
    personId: string;
  };
  await cameIn(b.room, them.personId, { roomSid });
  return { ...b, roomSid, team, customerId: them.personId };
}

const asSystem = () =>
  systemActor({ workspaceId: w.workspaceId, organizationId: w.organizationId });

describe('the AI hearing the call', () => {
  it('tells the customer it takes notes: on the booking page, in their messages and before they join', async () => {
    const page = await get(w, `/public/book/${w.site}/${calendar.slug}`);
    expect(page.statusCode, page.body).toBe(200);
    expect((page.json() as { booking: { locations: unknown[] } }).booking.locations).toEqual([
      expect.objectContaining({ kind: 'virtual', aiNotes: true, recorded: false }),
    ]);

    const b = await booked('Nia', at(1, '13:30'));
    const seen = await asWorker(
      w.s.db,
      { workspaceId: w.workspaceId, organizationId: w.organizationId },
      (tx) => loadBooking(tx, w.s, b.attendeeId, { forCustomer: true }),
    );
    expect(seen!.visit.aiNotes).toBe(true);
    expect(whereLine(seen!.visit)).toBe(`Online: ${b.link} (${VIDEO_CALL_WORDS.emailNotice})`);
  });

  it('hears each person, keeps who said what, and makes it the appointment’s transcript once the call ends', async () => {
    const c = await inCall('Lu');
    expect((await openLink(c.link)).json()).toMatchObject({ state: 'call', aiNotes: true });
    const t = listening();
    try {
      // LiveKit hasn't said anyone's in yet: it waits, and looks again a few seconds on.
      await t.listener.pass();
      expect(t.listener.calls.has(c.callId)).toBe(false);
      w.s.videoCalls.inRooms.set(c.room, { people: 2, listener: false });
      t.advance(6_000);
      const room = await t.joined(c.room);
      expect(w.s.videoCalls.aiMarks.get(c.room)).toBe(true);

      room.events.onVoice({
        identity: c.customerId,
        name: 'Lu Customer',
        frames: microphone([...SAID, ...SAID]),
      });
      await vi.waitFor(() => expect(room.said).toHaveLength(2));
      t.advance(5_000);
      room.events.onVoice({
        identity: c.team.personId,
        name: c.team.name,
        frames: microphone(SAID),
      });
      await vi.waitFor(() => expect(room.said).toHaveLength(3));
      expect(room.said.map((s) => captionOf(s.payload))).toEqual([
        expect.objectContaining({ who: c.customerId, text: FAKE_HEARD, final: true }),
        expect.objectContaining({ who: c.customerId, text: FAKE_HEARD, final: true }),
        expect.objectContaining({ who: c.team.personId, name: c.team.name, text: FAKE_HEARD }),
      ]);

      t.advance(3_000);
      await t.listener.tick();
      const lu = {
        person_row_id: c.customerId,
        side: 'customer',
        name: 'Lu Customer',
        body: FAKE_HEARD,
        language: 'en',
      };
      expect(await linesOf(c.callId)).toEqual([
        lu,
        lu,
        { ...lu, person_row_id: c.team.personId, side: 'team', name: c.team.name },
      ]);

      // Everyone goes: alone a while, the listener leaves, and only the sound it sent goes on the balance.
      room.people = 0;
      await t.listener.tick();
      t.advance(ALONE_MS);
      await t.listener.tick();
      expect(room.left).toBe(true);
      expect(t.listener.calls.size).toBe(0);
      const uses = await rows<{ quantity: string; source: string }>(
        admin(),
        sql`select quantity::text, source from app.speech_usage
            where workspace_id = ${w.workspaceId} and rate_key = 'speech.live.minute'
              and ref = ${`video:${c.callId}`}`,
      );
      expect(uses).toHaveLength(1);
      expect(uses[0]!.source).toBe('call');
      const seconds = Number(uses[0]!.quantity) * 60;
      expect(seconds).toBeGreaterThan((3 * (1000 + GATE.hangMs)) / 1000);
      expect(seconds).toBeLessThanOrEqual((3 * (1000 + GATE.beforeMs + GATE.hangMs)) / 1000 + 0.01);

      // The room closes. Its last lines can still be on their way, so the transcript waits a moment.
      const endedAt = t.now() + MIN;
      const closed = await hook('room_finished', c.room, { roomSid: c.roomSid, at: endedAt });
      expect(closed.statusCode).toBe(200);
      await drain(w);
      expect(await transcriptsOf(c.appointmentId)).toEqual([]);
      await runDue(w, [`video_call.keep_words:${c.roomSid}`]);
      const [kept, ...more] = await transcriptsOf(c.appointmentId);
      expect(more).toEqual([]);
      expect(kept).toMatchObject({
        provider: 'handsfree',
        external_id: `video:${c.roomSid}`,
        body: `Lu Customer: ${FAKE_HEARD} ${FAKE_HEARD}\n${c.team.name}: ${FAKE_HEARD}`,
      });
      expect(await linesOf(c.callId)).toEqual([]);
      // After the call starts from it, as it does from Zoom's.
      expect(await jobRow(`appointment.call_review:${kept!.id}`)).toBeDefined();

      // Once: the same stretch again keeps nothing more.
      const again = await executeCommand(
        w.s.db,
        videoCallKeepWords,
        {
          workspaceId: w.workspaceId,
          callId: c.callId,
          until: iso(endedAt),
          stretch: c.roomSid,
        },
        asSystem(),
        workerMeta(),
      );
      expect(again.output).toEqual({ transcriptId: null, lines: 0 });
      expect(await transcriptsOf(c.appointmentId)).toHaveLength(1);
    } finally {
      await t.listener.stop();
    }
  });

  it('forgets what it heard and leaves once the team turns AI notes off for the call', async () => {
    const c = await inCall('Mo');
    w.s.videoCalls.inRooms.set(c.room, { people: 2, listener: false });
    const t = listening();
    try {
      const room = await t.joined(c.room);
      room.events.onVoice({
        identity: c.customerId,
        name: 'Mo Customer',
        frames: microphone(SAID),
      });
      await vi.waitFor(() => expect(room.said).toHaveLength(1));
      t.advance(3_000);
      await t.listener.tick();
      expect(await linesOf(c.callId)).toHaveLength(1);

      const off = { workspaceId: w.workspaceId, callId: c.callId, on: false };
      expect(await run(w, videoCallSetAi, off)).toEqual({ changed: true, aiNotes: false });
      expect(await run(w, videoCallSetAi, off)).toEqual({ changed: false, aiNotes: false });
      expect(await linesOf(c.callId)).toEqual([]);
      await drain(w);
      expect(w.s.videoCalls.aiMarks.get(c.room)).toBe(false);

      // Its next pass leaves, and lines that were on their way are dropped.
      await t.listener.pass();
      expect(room.left).toBe(true);
      expect(t.listener.calls.has(c.callId)).toBe(false);
      const late = await executeCommand(
        w.s.db,
        videoCallHeard,
        {
          workspaceId: w.workspaceId,
          callId: c.callId,
          lines: [
            { key: 'late:0', personId: c.customerId, text: FAKE_HEARD, saidAt: iso(Date.now()) },
          ],
        },
        asSystem(),
        workerMeta(),
      );
      expect(late.output).toEqual({ kept: 0 });
      expect(await linesOf(c.callId)).toEqual([]);

      // Everyone's pages say so.
      expect((await openLink(c.link)).json()).toMatchObject({ state: 'call', aiNotes: false });
      expect((await publicCall(c.callId)).json()).toMatchObject({ aiNotes: false });

      // On again, it hears from then on.
      expect(await run(w, videoCallSetAi, { ...off, on: true })).toEqual({
        changed: true,
        aiNotes: true,
      });
      const back = await t.joined(c.room);
      expect(back).not.toBe(room);
      expect(w.s.videoCalls.aiMarks.get(c.room)).toBe(true);
    } finally {
      await t.listener.stop();
    }
  });

  it('leaves a call another listener is hearing to it', async () => {
    const c = await inCall('Pat');
    w.s.videoCalls.inRooms.set(c.room, { people: 2, listener: true });
    const t = listening();
    try {
      for (let i = 0; i < 5; i++) await t.listener.pass();
      expect(t.listener.calls.has(c.callId)).toBe(false);
      // That one went (a deploy): a minute on, this one takes over.
      w.s.videoCalls.inRooms.set(c.room, { people: 2, listener: false });
      await t.listener.pass();
      expect(t.listener.calls.has(c.callId)).toBe(false);
      t.advance(MIN);
      await t.joined(c.room);
    } finally {
      await t.listener.stop();
    }
  });
});

describe('with nothing to hold the call', () => {
  it('opens nothing while the business has calls off', async () => {
    const b = await booked('Jo', await soonest());
    await rows(
      admin(),
      sql`update app.workspaces set video_calls = false where id = ${w.workspaceId}`,
    );
    try {
      expect((await openLink(b.link)).json()).toMatchObject({ state: 'no_link' });
      const team = await teamJoin(ownerToken, b.callId);
      expect(team.statusCode).toBe(409);
      expect(errorOf(team).rule).toBe('video_calls_off');
      const refused = await enter(b.link, { name: 'Jo Customer' });
      expect(refused.statusCode).toBe(409);
      expect(errorOf(refused).rule).toBe('video_calls_off');
      expect((await publicCall(b.callId)).json()).toMatchObject({ ready: false });
    } finally {
      await rows(
        admin(),
        sql`update app.workspaces set video_calls = true where id = ${w.workspaceId}`,
      );
    }
  });

  it('says calls aren’t ready, and believes no webhook, before LiveKit is set up', async () => {
    const b = await booked('Kim', at(1, '15:00'));
    const bare = await buildHttpServer({
      ...w.s,
      videoCalls: null,
      httpDb: testDbs().worker.db,
      verifyToken: testTokenVerifier(),
      webOrigins: ['http://localhost:3000'],
      booking: {
        botCheck: passThroughBotCheck,
        limits: { read: ROOM, book: ROOM, manageRead: ROOM, manageWrite: ROOM },
      },
    });
    try {
      const team = await teamJoin(ownerToken, b.callId, bare);
      expect(team.statusCode).toBe(503);
      expect(errorOf(team).rule).toBe('video_calls_unavailable');
      expect((await openLink(b.link, bare)).json()).toMatchObject({ state: 'no_link' });
      expect((await publicCall(b.callId, bare)).json()).toMatchObject({ ready: false });
      const told = await hook('room_finished', b.room, {}, bare);
      expect(told.statusCode).toBe(401);
    } finally {
      await bare.close();
    }
  });
});

describe('a call with a customer that isn’t for an appointment (part 5)', () => {
  const start = (token: string | null, body: Record<string, unknown>) =>
    w.app.inject({
      method: 'POST',
      url: '/v1/video-calls/start',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      payload: JSON.stringify(body),
    });

  const lineOf = async (callId: string) =>
    (
      await rows<{ id: string; body: string | null; meta: Record<string, unknown> }>(
        admin(),
        sql`select id, body, meta from app.activities
            where kind = 'call' and subtype = 'video' and meta->>'videoCallId' = ${callId}`,
      )
    )[0];

  it('sends the customer their own link, which lets them in once the team is there', async () => {
    const [gia] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.people (workspace_id, first_name, last_name, email)
          values (${w.workspaceId}, 'Gia', 'Customer', ${`gia-${randomUUID().slice(0, 8)}@example.com`})
          returning id`,
    );
    expect((await start(null, { workspaceId: w.workspaceId, personId: gia!.id })).statusCode).toBe(
      401,
    );
    const res = await start(ownerToken, { workspaceId: w.workspaceId, personId: gia!.id });
    expect(res.statusCode, res.body).toBe(200);
    const out = res.json() as { callId: string; channel: string; conversationId: string };
    expect(out).toMatchObject({ channel: 'email', name: 'Gia Customer' });
    const [m] = await rows<{ body: string }>(
      admin(),
      sql`select body from app.messages where conversation_id = ${out.conversationId}`,
    );
    // On the address the business's links are on, as a booking's Join link is.
    const link = /(https?:\/\/\S+\/j\/[0-9A-Za-z]{32})(?:\s|$)/.exec(m!.body)?.[1];
    expect(link, m!.body).toBeDefined();
    expect(new URL(link!).origin).toBe(new URL(w.s.bookingLinks.webUrl).origin);

    expect((await openLink(link!)).json()).toMatchObject({
      state: 'call',
      title: `Video call with ${BUSINESS}`,
      business: BUSINESS,
      when: 'With Dale',
      name: 'Gia Customer',
      aiNotes: true,
    });
    const first = await enter(link!, { name: 'Gia Customer' });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ status: 'waiting', callId: out.callId, ticket: null });
    await drain(w);
    expect(pushesAbout(out.callId)).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ title: 'Gia Customer is waiting in the video call' }),
      }),
    ]);

    const room = videoCallRoom(out.callId);
    const roomSid = `RM_${randomUUID().slice(0, 12)}`;
    const t0 = Date.now() - 10 * MIN;
    const team = (await teamJoin(ownerToken, out.callId)).json() as { personId: string };
    await cameIn(room, team.personId, { roomSid, at: t0 });
    const inNow = await enter(link!, { name: 'Gia Customer' });
    expect(inNow.json()).toMatchObject({ status: 'in', ticket: { url: 'fake:' } });
    const said = inNow.json() as { personId: string };
    expect(ticketOf(inNow)).toEqual({
      room,
      identity: said.personId,
      name: 'Gia Customer',
      kind: 'customer',
    });
    await cameIn(room, said.personId, { roomSid, at: t0 + MIN });

    // What the AI heard while they talked.
    await executeCommand(
      w.s.db,
      videoCallHeard,
      {
        workspaceId: w.workspaceId,
        callId: out.callId,
        lines: [
          {
            key: 'gia-1',
            personId: said.personId,
            text: 'Could you send me the quote for the duct cleaning by Friday, and one for the attic as well please?',
            saidAt: iso(t0 + 2 * MIN),
          },
        ],
      },
      asSystem(),
      workerMeta(),
    );

    // The room closes: the call is a line on Gia's timeline, and what was said becomes its transcript.
    expect((await hook('room_finished', room, { roomSid, at: t0 + 6 * MIN })).statusCode).toBe(200);
    await drain(w);
    const line = await lineOf(out.callId);
    expect(line?.meta).toMatchObject({ videoCallId: out.callId, durationSeconds: 5 * 60 });
    await runDue(w, [`video_call.keep_words:${roomSid}`]);
    const [kept] = await rows<{ id: string; video_call_id: string | null }>(
      admin(),
      sql`select id, video_call_id from app.appointment_transcripts where video_call_id = ${out.callId}`,
    );
    expect(kept?.video_call_id).toBe(out.callId);
    // After the call starts from it, as from an appointment's, and its summary goes on the line.
    expect(await jobRow(`appointment.call_review:${kept!.id}`)).toBeDefined();
    await drain(w);
    const review = await query(w, callSuggestionList, {
      workspaceId: w.workspaceId,
      videoCallId: out.callId,
    });
    expect(review.summary).toBeTruthy();
    expect((await lineOf(out.callId))?.body).toBe(review.summary);
  });

  it('closes the link a day after it was sent, once the call isn’t going', async () => {
    const [hana] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.people (workspace_id, first_name, last_name, email)
          values (${w.workspaceId}, 'Hana', 'Customer', ${`hana-${randomUUID().slice(0, 8)}@example.com`})
          returning id`,
    );
    const out = (
      await start(ownerToken, { workspaceId: w.workspaceId, personId: hana!.id })
    ).json() as { callId: string; conversationId: string };
    const [m] = await rows<{ body: string }>(
      admin(),
      sql`select body from app.messages where conversation_id = ${out.conversationId}`,
    );
    const link = /(https?:\/\/\S+\/j\/[0-9A-Za-z]{32})(?:\s|$)/.exec(m!.body)![1]!;
    await rows(
      admin(),
      sql`update app.video_calls set created_at = now() - interval '2 days' where id = ${out.callId}`,
    );
    expect((await openLink(link)).json()).toMatchObject({ state: 'over' });
    const over = await enter(link, { name: 'Hana Customer' });
    expect(over.statusCode).toBe(409);
    expect(errorOf(over).rule).toBe('video_call_over');
    // A link that was never sent opens nothing.
    const made = await openLink(`${w.s.bookingLinks.webUrl}/j/${'Z'.repeat(32)}`);
    expect(made.statusCode).toBe(404);
  });
});
