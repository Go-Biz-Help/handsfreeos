/**
 * A live test call from the test console (@hfos/core's ai-team/test-call.ts), on the real database with the
 * stand-in speech (audio is words) and the scripted model: through this browser, where the console's websocket
 * carries the audio, and over the business's phone line, where the browser places a call that Twilio streams to
 * the AI teammate. Either way the call runs on the live call loop a real call runs, the console hears every turn's
 * events and where its time went, and nothing happens for real: no visit, no call record, nobody rung.
 */
import { createTokenVerifier, TEST_CALL_PARAM, TEST_CALL_TO } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, signInTestUser, testDbs, testEnv } from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHttpServer } from '../src/http/server';
import { FAKE_AUTH_TOKEN, fakeSid, type FakeTelephony } from '../src/telephony/fake';
import { twilioSignature } from '../src/telephony/signature';
import { identityOf } from '../src/telephony/voice';
import { testMessagesOf } from '../src/ai-team/test-call';
import { CONNECTING } from '../src/voice-agent/prompt';
import { openTestTicket } from '../src/voice-agent/ticket';
import { TEST_PUBLIC_URL } from './helpers';
import {
  admin,
  appointmentsOf,
  newCustomer,
  saveTeammate,
  teammateWorld,
  type TeammateWorld,
} from './ai-team-world';

const env = testEnv();
const V = '/webhooks/twilio/voice';
let w: TeammateWorld;
let app: FastifyInstance;
let port: number;
let ownerToken: string;
let memberToken: string;
let accountSid: string;

type Message = Record<string, unknown> & { type: string };

beforeAll(async () => {
  w = await teammateWorld('tmlive', {
    preset: 'appointment_coordinator',
    calendar: 'Tune-ups',
    status: 'automatic',
  });
  await saveTeammate(w, { phone: { enabled: true, answer: 'always' } });
  app = await buildHttpServer({
    ...w.s,
    httpDb: testDbs().worker.db,
    verifyToken: createTokenVerifier({
      jwksUrl: `${env.supabaseUrl}/auth/v1/.well-known/jwks.json`,
      jwtIssuer: `${env.supabaseUrl}/auth/v1`,
    }),
    webOrigins: ['http://localhost:3000'],
    voiceTimings: { quietMs: 60_000, goneMs: 60_000, markMs: 2_000 },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
  const member = await createTestUser('tmlive-member', { fullName: 'Mia Member' });
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${w.workspaceId}, ${member.id}, 'member')`,
  );
  [ownerToken, memberToken] = await Promise.all([signInTestUser(w.owner), signInTestUser(member)]);
  const [a] = await rows<{ account_sid: string }>(
    admin(),
    sql`select account_sid from app.telephony_accounts where workspace_id = ${w.workspaceId}`,
  );
  accountSid = a!.account_sid;
});

afterAll(async () => {
  await app.close();
  await w.app.close();
  await closeTestDbs();
});

async function waitFor<T>(what: string, get: () => T | null | undefined | false, ms = 8_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * The console's end: it opens the test call, keeps every message, and (on a call in this browser) hears what the
 * teammate says as words and plays it at once, so every mark comes straight back.
 */
async function openConsole(
  token: string,
  way: 'browser' | 'phone',
  test: Record<string, unknown> = {},
) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ai-team/test/call`);
  const messages: Message[] = [];
  const said: string[] = [];
  let closed = false;
  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      said.push(Buffer.from(raw as Buffer).toString('utf8'));
      return;
    }
    const m = JSON.parse(String(raw)) as Message;
    messages.push(m);
    if (m.type === 'mark') ws.send(JSON.stringify({ type: 'played', name: m['name'] }));
  });
  ws.on('close', () => {
    closed = true;
  });
  await new Promise((resolve) => ws.once('open', resolve));
  ws.send(
    JSON.stringify({
      type: 'start',
      token,
      way,
      test: {
        workspaceId: w.workspaceId,
        personId: null,
        call: { direction: 'inbound' },
        at: null,
        config: null,
        ...test,
      },
    }),
  );
  return {
    messages,
    said,
    closed: () => closed,
    of: (type: string) => messages.filter((m) => m.type === type),
    turn: (n: number) =>
      messages
        .filter((m) => m.type === 'event' && m['turn'] === n)
        .map((m) => m['event'] as Message),
    speak(words: string) {
      ws.send(Buffer.from(words, 'utf8'));
    },
    send(m: Record<string, unknown>) {
      ws.send(JSON.stringify(m));
    },
    close: () => ws.close(),
  };
}

/** Posts a voice webhook the way Twilio does: form-encoded, signed over the public URL. */
function post(path: string, params: Record<string, string>) {
  const all = { AccountSid: accountSid, ...params };
  return app.inject({
    method: 'POST',
    url: path,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': twilioSignature(FAKE_AUTH_TOKEN, `${TEST_PUBLIC_URL}${path}`, all),
    },
    payload: new URLSearchParams(all).toString(),
  });
}

describe('a live test call', () => {
  it('needs someone who manages the AI teammate, signed in', async () => {
    const member = await openConsole(memberToken, 'browser');
    await waitFor('the refusal', () => member.of('error').length);
    expect(member.of('error')[0]).toMatchObject({ message: expect.stringMatching(/permission/i) });
    await waitFor('the socket to close', () => member.closed());

    const stranger = await openConsole('not-a-token', 'browser');
    await waitFor('the refusal', () => stranger.of('error').length);
    await waitFor('the socket to close', () => stranger.closed());
    expect(stranger.of('answered')).toHaveLength(0);
  });

  it('in this browser: picks up, answers what they say out loud, says goodbye, and changes nothing', async () => {
    const c = await newCustomer(w, 'Rosa');
    const call = await openConsole(ownerToken, 'browser', { personId: c.id });
    await waitFor('the greeting', () => call.said.join(' ').includes('How can I help?'));
    expect(call.of('answered')).toHaveLength(1);
    expect(call.messages.find((m) => m.type === 'turn')).toMatchObject({ turn: 0, said: '' });
    // The pickup's own events: who they are, and the greeting.
    expect(call.turn(0).find((e) => e.type === 'context')).toMatchObject({
      title: 'Read who Rosa is',
    });
    expect(call.said.join(' ')).toMatch(/^Thanks for calling /);
    // When it said hello, from the pickup.
    await waitFor('the pickup’s timing', () => call.of('timing').find((m) => m['turn'] === 0));

    call.speak('Can you book me in for Thursday?');
    await waitFor('the booking reply', () =>
      call.turn(1).find((e) => e.type === 'done' && e['outcome'] === 'replied'),
    );
    expect(call.messages.find((m) => m.type === 'turn' && m['turn'] === 1)).toMatchObject({
      said: 'Can you book me in for Thursday?',
    });
    // What the listener heard, as it heard it.
    expect(call.of('hearing').map((m) => m['text'])).toContain('Can you book me in for Thursday?');
    expect(call.turn(1).find((e) => e.type === 'tool')).toMatchObject({ name: 'find_times' });
    expect(call.turn(1).find((e) => e.type === 'would')).toMatchObject({ kind: 'book' });
    // Where the turn's time went, to the first sound of its answer.
    const timing = await waitFor('the turn’s timing', () =>
      call.of('timing').find((m) => m['turn'] === 1),
    );
    expect(timing['timing']).toMatchObject({
      firstSoundMs: expect.any(Number),
      loadMs: expect.any(Number),
      waitMs: expect.any(Number),
      thought: false,
    });
    await waitFor('the booking reply to be said', () => call.said.some((s) => /booked/i.test(s)));

    call.speak('That’s all, bye!');
    const ended = await waitFor('the end of the call', () => call.of('ended')[0]);
    expect(ended).toMatchObject({
      outcome: 'replied',
      summary: expect.stringContaining('goodbye'),
    });
    // The goodbye was said while it was written, and to the end.
    expect(call.turn(2).filter((e) => e.type === 'say')).toEqual([
      { type: 'say', text: 'Thanks for calling.', ending: true },
      { type: 'say', text: 'Bye now!', ending: true },
    ]);
    expect(call.said.slice(-2)).toEqual(['Thanks for calling.', 'Bye now!']);
    await waitFor('the socket to close', () => call.closed());

    // Nothing happened for real, and every turn was a test run.
    expect(await appointmentsOf(c.id)).toHaveLength(0);
    expect(
      await rows(admin(), sql`select 1 from app.calls where person_id = ${c.id}`),
    ).toHaveLength(0);
    const runs = await rows<{ is_test: boolean; status: string }>(
      admin(),
      sql`select is_test, status from app.ai_teammate_runs where person_id = ${c.id}`,
    );
    expect(runs.length).toBe(3);
    expect(runs.every((r) => r.is_test && r.status === 'done')).toBe(true);
    // Talking out loud in a test is the business's to pay for, like the console's voice mode.
    const deadline = Date.now() + 8_000;
    let used: { rate_key: string }[] = [];
    while (used.length < 2 && Date.now() < deadline) {
      used = await rows<{ rate_key: string }>(
        admin(),
        sql`select rate_key from app.speech_usage
            where workspace_id = ${w.workspaceId} and source = 'talk' order by rate_key`,
      );
      if (used.length < 2) await new Promise((r) => setTimeout(r, 25));
    }
    expect(used.map((u) => u.rate_key)).toEqual(['speech.live.minute', 'speech.voice.kchar']);
  });

  it('connects a caller who asks for a person: it says so and the call ends, with nobody rung', async () => {
    const call = await openConsole(ownerToken, 'browser');
    await waitFor('the greeting', () => call.said.join(' ').includes('How can I help?'));
    call.speak('I want to talk to a real person');
    const ended = await waitFor('the end of the call', () => call.of('ended')[0]);
    expect(ended).toMatchObject({ outcome: 'handed_off' });
    expect(call.said).toContain(CONNECTING.en);
    expect(call.turn(1).find((e) => e.type === 'would')).toMatchObject({ kind: 'hand_off' });
    expect((w.s.telephony as FakeTelephony).redirected).toHaveLength(0);
  });

  it('is one at a time for each person, and hanging up ends it', async () => {
    const first = await openConsole(ownerToken, 'browser');
    await waitFor('the greeting', () => first.said.join(' ').includes('How can I help?'));
    const second = await openConsole(ownerToken, 'browser');
    await waitFor('the refusal', () => second.of('error').length);
    expect(second.of('error')[0]).toMatchObject({ message: expect.stringMatching(/already/) });
    first.send({ type: 'hang_up' });
    const ended = await waitFor('the end of the call', () => first.of('ended')[0]);
    expect(ended['summary']).toMatch(/they hung up/);
    await waitFor('the socket to close', () => first.closed());
  });

  it('over the phone line: the browser’s call streams to the teammate, and hangs up with it', async () => {
    // Browser calls work here: a TwiML app for the business's subaccount.
    await rows(
      admin(),
      sql`update app.telephony_accounts set twiml_app_sid = ${fakeSid('AP')}
          where workspace_id = ${w.workspaceId}`,
    );
    const call = await openConsole(ownerToken, 'phone');
    const dial = await waitFor('the ticket to dial with', () => call.of('dial')[0]);
    const ticket = String(dial['ticket']);
    const from = `client:${identityOf(w.owner.id)}`;
    const callSid = fakeSid('CA');

    // Someone else can't place it with this ticket.
    const other = await post(`${V}/outbound`, {
      CallSid: fakeSid('CA'),
      From: `client:${identityOf('00000000-0000-4000-8000-000000000001')}`,
      To: TEST_CALL_TO,
      [TEST_CALL_PARAM]: ticket,
    });
    expect(other.body).toContain('could not be placed');

    const res = await post(`${V}/outbound`, {
      CallSid: callSid,
      From: from,
      To: TEST_CALL_TO,
      [TEST_CALL_PARAM]: ticket,
    });
    expect(res.statusCode).toBe(200);
    // Straight to the teammate on this machine, hung up when the stream ends. Nothing rings.
    expect(res.body).toContain(`<Stream url="wss://hooks.worker.test${V}/agent/test/local">`);
    expect(res.body).toMatch(/<\/Connect><Hangup\/><\/Response>$/);
    expect(res.body).not.toContain('<Dial');
    const streamTicket = /<Parameter name="t" value="([^"]+)"/
      .exec(res.body)![1]!
      .replace(/&amp;/g, '&');
    expect(openTestTicket(w.s.sealer, streamTicket)).toMatchObject({
      callSid,
      userId: w.owner.id,
      machine: 'local',
    });

    // Twilio's side of the stream: it plays back every mark, and hears the teammate as words.
    const twilio = new WebSocket(`ws://127.0.0.1:${port}${V}/agent/test/local`);
    const heard: string[] = [];
    let hungUp = false;
    twilio.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as {
        event: string;
        media?: { payload: string };
        mark?: { name: string };
      };
      if (m.event === 'media') heard.push(Buffer.from(m.media!.payload, 'base64').toString('utf8'));
      if (m.event === 'mark') twilio.send(JSON.stringify({ event: 'mark', mark: m.mark }));
    });
    twilio.on('close', () => {
      hungUp = true;
    });
    await new Promise((resolve) => twilio.once('open', resolve));
    twilio.send(
      JSON.stringify({
        event: 'start',
        streamSid: 'MZtest',
        start: { streamSid: 'MZtest', callSid, customParameters: { t: streamTicket } },
      }),
    );
    await waitFor('the greeting down the line', () => heard.join(' ').includes('How can I help?'));
    expect(call.of('answered')).toHaveLength(1);
    // The console gets the events; the audio is the phone line's.
    expect(call.said).toHaveLength(0);
    twilio.send(
      JSON.stringify({
        event: 'media',
        media: { track: 'inbound', payload: Buffer.from('That’s all, bye!').toString('base64') },
      }),
    );
    await waitFor('the end of the call', () => call.of('ended')[0]);
    expect(heard.slice(-2)).toEqual(['Thanks for calling.', 'Bye now!']);
    // Closing the stream is hanging up: the TwiML's <Hangup/> ends the browser's call.
    await waitFor('the stream to close', () => hungUp);
    await waitFor('the console to close', () => call.closed());

    // Twilio's reports about the test call aren't kept: it isn't a call anybody made.
    const report = await post(`${V}/status`, {
      CallSid: callSid,
      CallStatus: 'completed',
      From: from,
      To: TEST_CALL_TO,
    });
    expect(report.statusCode).toBe(204);
    const kept = await rows(
      admin(),
      sql`select 1 from app.webhook_deliveries where dedupe_key like ${`${callSid}:%`}`,
    );
    expect(kept).toHaveLength(0);
    expect(
      await rows(admin(), sql`select 1 from app.calls where provider_sid = ${callSid}`),
    ).toHaveLength(0);
  });

  it('refuses a stream no console here is waiting for', async () => {
    const twilio = new WebSocket(`ws://127.0.0.1:${port}${V}/agent/test/local`);
    let closed = false;
    twilio.on('close', () => {
      closed = true;
    });
    await new Promise((resolve) => twilio.once('open', resolve));
    twilio.send(
      JSON.stringify({
        event: 'start',
        streamSid: 'MZnobody',
        start: { streamSid: 'MZnobody', callSid: fakeSid('CA'), customParameters: { t: 'forged' } },
      }),
    );
    await waitFor('the stream to close', () => closed);
  });

  it('sends a stream that reached another machine on to the one holding the console', async () => {
    const was = process.env['FLY_MACHINE_ID'];
    process.env['FLY_MACHINE_ID'] = 'e784079b449483';
    try {
      const res = await app.inject({ method: 'GET', url: `${V}/agent/test/3d8d9e3ae43238` });
      expect(res.statusCode).toBe(409);
      expect(res.headers['fly-replay']).toBe('instance=3d8d9e3ae43238');
    } finally {
      if (was === undefined) delete process.env['FLY_MACHINE_ID'];
      else process.env['FLY_MACHINE_ID'] = was;
    }
  });
});

describe('the call so far, as the console reads it', () => {
  it('is its messages, ending with what the caller just said', () => {
    expect(
      testMessagesOf(
        [
          { who: 'teammate', text: 'Thanks for calling. How can I help?' },
          { who: 'caller', text: 'Hi' },
          { who: 'teammate', text: '' },
          { who: 'teammate', text: 'Sure. (interrupted)' },
        ],
        'Are you open Saturday?',
      ),
    ).toEqual([
      { from: 'teammate', text: 'Thanks for calling. How can I help?' },
      { from: 'customer', text: 'Hi' },
      { from: 'teammate', text: 'Sure. (interrupted)' },
      { from: 'customer', text: 'Are you open Saturday?' },
    ]);
  });
});
