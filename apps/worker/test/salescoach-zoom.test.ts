/**
 * AI Sales Coach on a Zoom meeting (round three, docs/salescoach.md, meetings/live.ts), end to end against a stand-in
 * for Zoom's Realtime Media Streams and the scripted model:
 * - **The stream:** both handshakes are signed with the Zoom app's id and secret, only the transcript is asked for,
 *   the ready message follows the media handshake, and Zoom's keep-alives are answered.
 * - **Coaching it:** the rep's own words (by their name in the meeting) are the team's side; a customer worried
 *   about price gets the playbook's answer on the rep's screen.
 * - **After it:** when Zoom ends the stream, the claim is ended and the meeting is written up like a call, with
 *   the notes on the customer's timeline.
 * - **Zoom's auto-start:** a stream that comes before any claim is claimed for the linked Zoom user who started it,
 *   and the customer picked in the app after, while it's live, is the write-up's.
 * - **Not hearing it:** a stream nobody claimed, or started by another Zoom account, is left alone; and the webhook
 *   refuses a stream on a server that isn't Zoom's.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { salescoachAddon } from '@hfos/core/addons/salescoach/manifest';
import { playbookSave } from '@hfos/core/addons/salescoach/ops/playbooks';
import {
  createTokenVerifier,
  executeCommand,
  liveMeetingClaim,
  organizationCreate,
  personCreate,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import {
  closeTestDbs,
  createTestUser,
  signInTestUser,
  testDbs,
  testEnv,
  type TestUser,
} from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { scriptedAi } from '../src/ai/scripted';
import { processJobs } from '../src/jobs';
import { onStreamStarted, RTMS, rtmsSignature, trustedStreamUrl } from '../src/meetings/live';
import { FAKE_ZOOM_LIVE, fakeZoomLiveCode } from '../src/meetings/zoom-live';
import { zoomSignature } from '../src/meetings/routes';
import { buildHttpServer } from '../src/http/server';
import { processOnce } from '../src/outbox';
import { handlers } from '../src/handlers/index';
import { jobs } from '../src/scheduled';
import { testServices, type TestServices } from './helpers';

const WORKER_ID = `vitest-zoom-${process.pid}`;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;

let owner: TestUser;
let rep: TestUser;
let workspaceId: string;
let rosaId: string;
let s: TestServices;

async function drain(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const table of ['outbox', 'scheduled_jobs'])
      await rows(
        admin(),
        sql`update ${sql.raw(`app.${table}`)} set locked_at = now(), locked_by = ${WORKER_ID}
            where status = 'pending' and workspace_id = ${workspaceId}`,
      );
    const d = { ...s, workerId: WORKER_ID, batchSize: 200, reservedOnly: true };
    const passes = [await processOnce({ ...d, handlers }), await processJobs({ ...d, jobs })];
    if (!passes.some((p) => p.claimed > 0)) return;
    if (Date.now() > deadline) throw new Error('the worker did not finish in time');
  }
}

async function waitFor<T>(
  what: string,
  get: () => Promise<T | null | undefined | false>,
  ms = 8_000,
) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Zoom's side of one stream: a signaling and a media socket on this machine, checking what the worker sends the way
 * Zoom does, and what the test says next.
 */
async function zoomStream(meetingUuid: string, streamId: string) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as AddressInfo).port;
  const sent: Record<string, unknown>[] = [];
  const signature = rtmsSignature(
    FAKE_ZOOM_LIVE.clientId,
    FAKE_ZOOM_LIVE.clientSecret,
    meetingUuid,
    streamId,
  );
  let signaling: WebSocket | null = null;
  let media: WebSocket | null = null;
  let ready = false;
  const pongs: number[] = [];
  server.on('connection', (ws, req) => {
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as Record<string, unknown>;
      sent.push(m);
      if (req.url === '/signal') {
        signaling = ws;
        if (m['msg_type'] === RTMS.SIGNALING_HAND_SHAKE_REQ)
          ws.send(
            JSON.stringify({
              msg_type: RTMS.SIGNALING_HAND_SHAKE_RESP,
              status_code: m['signature'] === signature ? 0 : 3,
              media_server: { server_urls: { transcript: `ws://127.0.0.1:${port}/media` } },
            }),
          );
        if (m['msg_type'] === RTMS.CLIENT_READY_ACK) ready = true;
        if (m['msg_type'] === RTMS.KEEP_ALIVE_RESP) pongs.push(Number(m['timestamp']));
      } else {
        media = ws;
        if (m['msg_type'] === RTMS.DATA_HAND_SHAKE_REQ)
          ws.send(
            JSON.stringify({
              msg_type: RTMS.DATA_HAND_SHAKE_RESP,
              status_code: m['signature'] === signature && m['media_type'] === 8 ? 0 : 3,
            }),
          );
      }
    });
  });
  return {
    url: `ws://127.0.0.1:${port}/signal`,
    sent,
    pongs,
    ready: () => ready,
    ping: (timestamp: number) =>
      signaling?.send(JSON.stringify({ msg_type: RTMS.KEEP_ALIVE_REQ, timestamp })),
    say: (userName: string, data: string) =>
      media?.send(
        JSON.stringify({
          msg_type: RTMS.MEDIA_DATA_TRANSCRIPT,
          content: { user_id: 16778240, user_name: userName, data, timestamp: Date.now() },
        }),
      ),
    end: () =>
      signaling?.send(
        JSON.stringify({ msg_type: RTMS.STREAM_STATE_UPDATE, state: 4, rtms_stream_id: streamId }),
      ),
    close: () => new Promise((r) => server.close(r)),
  };
}

const coached = async (liveMeetingId: string) =>
  (
    await rows<{ id: string; state: string; lines: { speaker: string; text: string }[] }>(
      admin(),
      sql`select id, state, lines from addon_salescoach.calls where live_meeting_id = ${liveMeetingId}`,
    )
  )[0];

const deps = () => ({ ...s, open: (url: string) => new WebSocket(url) });

beforeAll(async () => {
  [owner, rep] = await Promise.all([
    createTestUser('zoomw-owner', { fullName: 'Dale Owner' }),
    createTestUser('zoomw-rep', { fullName: 'Marco Member' }),
  ]);
  const org = (
    await executeCommand(
      api(),
      organizationCreate,
      { businessName: 'Zoomed HVAC' },
      human(owner),
      meta(),
    )
  ).output;
  workspaceId = org.workspaceId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${workspaceId}, ${rep.id}, 'member')`,
  );
  await rows(
    admin(),
    sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
        values (${workspaceId}, 'salescoach', 'enabled', ${salescoachAddon.version})`,
  );
  await rows(
    admin(),
    sql`insert into app.live_meeting_accounts (workspace_id, user_id, provider, external_user_id)
        values (${workspaceId}, ${rep.id}, 'zoom', 'zoom-marco')`,
  );
  rosaId = (
    await executeCommand(
      api(),
      personCreate,
      { workspaceId, firstName: 'Rosa', lastName: 'Diaz', phone: '(713) 555-0161' },
      human(owner),
      meta(),
    )
  ).output.personId;
  await executeCommand(
    api(),
    playbookSave,
    {
      workspaceId,
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
    },
    human(owner),
    meta(),
  );
  s = testServices({ ai: { provider: scriptedAi(), dailyTokens: 5_000_000 } });
}, 60_000);
afterAll(closeTestDbs);

const claim = (meetingUuid: string) =>
  executeCommand(
    api(),
    liveMeetingClaim,
    {
      workspaceId,
      provider: 'zoom',
      meetingUuid,
      meetingNumber: null,
      screenName: 'Marco Member',
      personId: rosaId,
    },
    human(rep),
    meta(),
  ).then((r) => r.output);

describe('a Zoom meeting heard live', () => {
  it('signs the stream, hears the transcript, coaches the rep, and writes it up when Zoom ends it', async () => {
    const meetingUuid = `mtg-${randomUUID()}==`;
    const streamId = `stream-${randomUUID()}`;
    const { liveMeetingId } = await claim(meetingUuid);
    const zoom = await zoomStream(meetingUuid, streamId);
    try {
      const session = await onStreamStarted(deps(), {
        meetingUuid,
        streamId,
        serverUrl: zoom.url,
        operatorId: 'zoom-marco',
      });
      expect(session).not.toBeNull();
      await waitFor('the stream to be ready', async () => zoom.ready());
      // Only Zoom's transcript is asked for, in English.
      expect(zoom.sent.find((m) => m['msg_type'] === RTMS.DATA_HAND_SHAKE_REQ)).toMatchObject({
        media_type: 8,
        media_params: { transcript: { content_type: 5, language: 9 } },
      });
      zoom.ping(1712);
      await waitFor('the keep-alive answered', async () => zoom.pongs.includes(1712));

      zoom.say('Marco Member', 'Hi Rosa, thanks for making time to go over the estimate.');
      zoom.say('Rosa Diaz', 'Honestly the price is too expensive for us right now.');
      const card = await waitFor('the objection card', async () => {
        const [c] = await rows<{ kind: string; say: string }>(
          admin(),
          sql`select k.kind, k.say from addon_salescoach.cards k
                join addon_salescoach.calls c on c.id = k.coached_call_id
               where c.live_meeting_id = ${liveMeetingId}`,
        );
        return c;
      });
      expect(card).toEqual({
        kind: 'objection',
        say: 'I hear you. We can spread it over three payments.',
      });
      zoom.say(
        'Marco Member',
        'I hear you. We can spread it over three payments. I’ll send the plan today.',
      );

      zoom.end();
      const done = await waitFor('the write-up queued', async () => {
        const c = await coached(liveMeetingId);
        return c && c.state !== 'live' ? c : null;
      });
      expect(done.lines.map((l) => l.speaker)).toEqual(['team', 'customer', 'team']);
      const [lm] = await rows<{ state: string }>(
        admin(),
        sql`select state from app.live_meetings where id = ${liveMeetingId}`,
      );
      expect(lm!.state).toBe('ended');

      await drain();
      expect((await coached(liveMeetingId))!.state).toBe('done');
      const [line] = await rows<{ words: string }>(
        admin(),
        sql`select meta ->> 'words' as words from app.activities
            where person_id = ${rosaId} and subtype = 'addon_line'`,
      );
      expect(line?.words).toMatch(/^Marco’s Zoom call was coached and scored \d+ out of 100$/);
      const [task] = await rows<{ title: string; notes: string }>(
        admin(),
        sql`select title, notes from app.tasks where workspace_id = ${workspaceId} and person_id = ${rosaId}`,
      );
      expect(task).toEqual({
        title: 'Send the plan today',
        notes: 'Promised on a coached Zoom call.',
      });
    } finally {
      await zoom.close();
    }
  });

  it('leaves alone a stream nobody claimed, or one another Zoom account started', async () => {
    const meetingUuid = `mtg-${randomUUID()}==`;
    const zoom = await zoomStream(meetingUuid, 'stream-x');
    try {
      const nobody = await onStreamStarted(deps(), {
        meetingUuid,
        streamId: 'stream-x',
        serverUrl: zoom.url,
        operatorId: null,
      });
      expect(nobody).toBeNull();
      await claim(meetingUuid);
      const someoneElse = await onStreamStarted(deps(), {
        meetingUuid,
        streamId: 'stream-x',
        serverUrl: zoom.url,
        operatorId: 'zoom-somebody-else',
      });
      expect(someoneElse).toBeNull();
      expect(zoom.sent).toEqual([]);
    } finally {
      await zoom.close();
    }
  });

  it('claims a stream Zoom started on its own for the linked person, and takes the customer named while it’s live', async () => {
    // Zoom's auto-start: the stream comes as Marco joins, before the app in the meeting claims anything.
    const meetingUuid = `mtg-${randomUUID()}==`;
    const streamId = `stream-${randomUUID()}`;
    const zoom = await zoomStream(meetingUuid, streamId);
    try {
      const session = await onStreamStarted(deps(), {
        meetingUuid,
        streamId,
        serverUrl: zoom.url,
        operatorId: 'zoom-marco',
      });
      expect(session).not.toBeNull();
      await waitFor('the stream to be ready', async () => zoom.ready());
      const [lm] = await rows<{ id: string; state: string; user_id: string }>(
        admin(),
        sql`select id, state, user_id from app.live_meetings where meeting_uuid = ${meetingUuid}`,
      );
      expect(lm).toMatchObject({ state: 'live', user_id: rep.id });
      // Until the app says his name in the meeting, his name here tells his words from the customer's.
      zoom.say('Marco Member', 'Hi Rosa, thanks for making time to go over the estimate.');
      zoom.say('Rosa Diaz', 'Sounds good, go ahead.');
      // He opens the app and picks Rosa: the live claim takes her.
      const named = await claim(meetingUuid);
      expect(named).toMatchObject({
        liveMeetingId: lm!.id,
        state: 'live',
        person: { id: rosaId },
      });
      await waitFor('both lines heard', async () => {
        const c = await coached(lm!.id);
        return c && c.state === 'live' ? c : null;
      });
      zoom.end();
      const done = await waitFor('the write-up queued', async () => {
        const c = await coached(lm!.id);
        return c && c.state !== 'live' ? c : null;
      });
      expect(done.lines.map((l) => l.speaker)).toEqual(['team', 'customer']);
      const [kept] = await rows<{ person_id: string | null }>(
        admin(),
        sql`select person_id from addon_salescoach.calls where id = ${done.id}`,
      );
      expect(kept!.person_id).toBe(rosaId);
      await drain();
    } finally {
      await zoom.close();
    }
  });

  it('connects only to Zoom’s own servers', () => {
    expect(trustedStreamUrl('wss://rtms-sjc.zoom.us/ws')).toBe(true);
    expect(trustedStreamUrl('wss://zoom.us.evil.example/ws')).toBe(false);
    expect(trustedStreamUrl('ws://rtms.zoom.us/ws')).toBe(false);
    expect(trustedStreamUrl('ws://127.0.0.1:9/ws')).toBe(false);
  });
});

describe('the coaching Zoom app, installed from Zoom', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    const env = testEnv();
    app = await buildHttpServer({
      ...s,
      httpDb: testDbs().worker.db,
      verifyToken: createTokenVerifier({
        jwksUrl: `${env.supabaseUrl}/auth/v1/.well-known/jwks.json`,
        jwtIssuer: `${env.supabaseUrl}/auth/v1`,
      }),
      webOrigins: ['http://localhost:3000'],
    });
  });
  afterAll(() => app.close());

  const hook = (body: Record<string, unknown>, secret: string = FAKE_ZOOM_LIVE.webhookSecret) => {
    const raw = JSON.stringify(body);
    const ts = String(Math.floor(Date.now() / 1000));
    return app.inject({
      method: 'POST',
      url: '/webhooks/zoom-live',
      headers: {
        'content-type': 'application/json',
        'x-zm-request-timestamp': ts,
        'x-zm-signature': zoomSignature(secret, ts, raw),
      },
      payload: raw,
    });
  };

  it('links the Zoom user to whoever confirms it signed in here, and ends it when the app is removed', async () => {
    const owner2 = await createTestUser('zoomw-installer', { fullName: 'Ivy Installer' });
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role)
          values (${workspaceId}, ${owner2.id}, 'member')`,
    );
    // Added from Zoom's Marketplace: Zoom comes back with a code and no state of ours.
    const back = await app.inject({
      method: 'GET',
      url: `/oauth/zoom-live/callback?code=${fakeZoomLiveCode('ivy@zoom.example')}`,
    });
    expect(back.statusCode).toBe(302);
    const to = new URL(String(back.headers.location));
    expect(to.pathname).toBe('/zoom/connect');
    const ticket = to.searchParams.get('t')!;

    const token = await signInTestUser(owner2);
    const linkIt = (t: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/zoom-live/link',
        headers: { authorization: `Bearer ${token}` },
        payload: { workspaceId, ticket: t },
      });
    // A forged ticket links nothing.
    expect((await linkIt('not-a-ticket')).statusCode).toBe(400);
    const linked = await linkIt(ticket);
    expect(linked.json()).toEqual({ linked: true, accountEmail: 'ivy@zoom.example' });
    const active = () =>
      rows<{ external_user_id: string }>(
        admin(),
        sql`select external_user_id from app.live_meeting_accounts
             where workspace_id = ${workspaceId} and user_id = ${owner2.id} and status = 'active'`,
      );
    const [acct] = await active();
    expect(acct!.external_user_id).toMatch(/^fake-zoom-live-/);

    // A webhook not signed with the coaching app's own secret is refused.
    expect((await hook({ event: 'app_deauthorized' }, 'another-secret')).statusCode).toBe(401);
    // Removed in Zoom: the link ends.
    const removed = await hook({
      event: 'app_deauthorized',
      payload: { user_id: acct!.external_user_id },
    });
    expect(removed.statusCode).toBe(200);
    expect(await active()).toEqual([]);
  });

  it('starts Connect from HandsFreeOS with a sealed state, and answers Zoom’s URL check', async () => {
    const start = await app.inject({ method: 'GET', url: '/oauth/zoom-live/start' });
    expect(start.statusCode).toBe(302);
    const back = new URL(String(start.headers.location));
    expect(back.pathname).toBe('/oauth/zoom-live/callback');
    const done = await app.inject({ method: 'GET', url: `${back.pathname}${back.search}` });
    expect(new URL(String(done.headers.location)).pathname).toBe('/zoom/connect');
    // A state that's been tampered with is refused.
    const bad = await app.inject({
      method: 'GET',
      url: `/oauth/zoom-live/callback?code=${fakeZoomLiveCode('x@zoom.example')}&state=forged`,
    });
    expect(bad.statusCode).toBe(400);
    const check = await hook({ event: 'endpoint.url_validation', payload: { plainToken: 'abc' } });
    expect(check.json()).toMatchObject({ plainToken: 'abc' });
  });
});
