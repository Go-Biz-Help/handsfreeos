/**
 * The AI teammate answers the phone (M18 step 5): when it picks up (always, after hours, when nobody answers),
 * a whole call over the websocket with the stand-in speech (audio is words) and the scripted model, hanging up,
 * handing the caller to the team on the same call, and streams it refuses.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { emptyUsage, type AiContent, type AiProvider, type AiRequest } from '@hfos/ai';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseTeammateConfig } from '@hfos/core/server';
import { scriptedAi } from '../src/ai/scripted';
import { createSealer } from '../src/crypto';
import { buildHttpServer } from '../src/http/server';
import { FAKE_AUTH_TOKEN, fakeSid, type FakeTelephony } from '../src/telephony/fake';
import { twilioSignature } from '../src/telephony/signature';
import { agentTwiml, voiceUrls } from '../src/telephony/voice';
import { heardOf, listenParams } from '../src/voice-agent/deepgram-speech';
import { createFakeSpeech } from '../src/voice-agent/fake-speech';
import { greetingOf, phoneChannelLines } from '../src/voice-agent/prompt';
import { echoOf, sentencesOf } from '../src/voice-agent/session';
import { voiceModel } from '../src/voice-agent/speech';
import { openTicket, sealTicket, TICKET_TTL_MS } from '../src/voice-agent/ticket';
import { TEST_PUBLIC_URL } from './helpers';
import {
  admin,
  appointmentsOf,
  newCustomer,
  nextPhone,
  saveTeammate,
  setStatus,
  teammateRequests,
  teammateWorld,
  useModel,
  type TeammateWorld,
} from './ai-team-world';

const V = '/webhooks/twilio/voice';

let w: TeammateWorld;
let app: FastifyInstance;
/** While set, the model's answer is held back once it's written: what's said meanwhile was said early. */
let holdAnswer: Promise<void> | null = null;

/** What the model was asked to read ahead of a call's first turn, while the greeting played. */
const warms: AiRequest[] = [];

/** The model, holding its answers back while a test says so; it reads ahead like Claude does. */
const held = (inner: AiProvider): AiProvider => ({
  id: inner.id,
  model: inner.model,
  async stream(request, options) {
    const turn = await inner.stream(request, options);
    if (holdAnswer) await holdAnswer;
    return turn;
  },
  async warm(request) {
    warms.push(request);
    return { ...emptyUsage, cacheWriteTokens: 4_000 };
  },
});
let port: number;
let accountSid: string;

beforeAll(async () => {
  w = await teammateWorld('voiceai', {
    preset: 'appointment_coordinator',
    calendar: 'Tune-ups',
    status: 'automatic',
  });
  useModel(
    w,
    held(
      scriptedAi([], {
        teammate: [
          {
            when: /\b(?:bye|that'?s all)\b/i,
            step: () => ({
              calls: [{ name: 'end_call', arguments: { message: 'Thanks for calling. Bye now!' } }],
            }),
          },
          {
            when: /\bopen on saturdays?\b/i,
            step: () => ({
              calls: [
                {
                  name: 'reply',
                  arguments: { message: 'Yes, we are. We open at nine on Saturdays.' },
                },
              ],
            }),
          },
          {
            // Books the first open time the call read at pickup, without looking times up.
            when: /\bfirst open time\b/i,
            step: (t) => {
              if (t.results['book'])
                return {
                  calls: [
                    { name: 'reply', arguments: { message: 'You’re booked. See you then!' } },
                  ],
                };
              const first =
                /\(calendar id ([0-9a-f-]{36})\):\n\s+[^:\n]+: [^(\n]+\(startsAt ([^)]+)\)/.exec(
                  t.context,
                );
              return first
                ? {
                    calls: [
                      { name: 'book', arguments: { calendarId: first[1], startsAt: first[2] } },
                    ],
                  }
                : { calls: [{ name: 'reply', arguments: { message: 'Nothing is open.' } }] };
            },
          },
          {
            // A link that isn't the business's, in its second sentence.
            when: /\bwebsite\b/i,
            step: () => ({
              calls: [
                {
                  name: 'reply',
                  arguments: { message: 'Sure thing. It is at not-ours.example.net for now.' },
                },
              ],
            }),
          },
        ],
      }),
    ),
  );
  await saveTeammate(w, { phone: { enabled: true, answer: 'always' } });
  const [a] = await rows<{ account_sid: string }>(
    admin(),
    sql`select account_sid from app.telephony_accounts where workspace_id = ${w.workspaceId}`,
  );
  accountSid = a!.account_sid;
  // An app on the world's services as they are now (the scripted model), listening for the websocket.
  const usual = w.s.ai.provider!;
  app = await buildHttpServer({
    ...w.s,
    // The model support picked for the business: the same stand-in, under that model's name.
    aiFor: (model) => ({ id: usual.id, model, stream: (r, o) => usual.stream(r, o) }),
    httpDb: testDbs().worker.db,
    verifyToken: null,
    webOrigins: ['http://localhost:3000'],
    voiceTimings: { quietMs: 60_000, goneMs: 60_000, markMs: 2_000 },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
});

afterAll(async () => {
  await app.close();
  await w.app.close();
  await closeTestDbs();
});

const telephony = () => w.s.telephony as FakeTelephony;

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

const ticketIn = (xml: string) => /<Parameter name="t" value="([^"]+)"/.exec(xml)?.[1] ?? null;

async function setOpenHours(hours: unknown): Promise<void> {
  await rows(
    admin(),
    sql`update app.workspaces set settings = jsonb_set(coalesce(settings, '{}'), '{openHours}', ${JSON.stringify(hours)}::jsonb)
        where id = ${w.workspaceId}`,
  );
}

async function waitFor<T>(what: string, get: () => T | null | undefined | false, ms = 8_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Twilio's side of a call stream: it plays back every mark, and hears what the teammate says as words. */
async function dial(callSid: string, ticket: string, opts: { readonly play?: boolean } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${V}/agent`);
  const said: string[] = [];
  const events: string[] = [];
  let closed = false;
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw)) as {
      event: string;
      media?: { payload: string };
      mark?: { name: string };
    };
    events.push(m.event);
    if (m.event === 'media') said.push(Buffer.from(m.media!.payload, 'base64').toString('utf8'));
    // Playing is instant here; `play: false` is a caller still hearing it (no mark comes back yet).
    if (m.event === 'mark' && opts.play !== false)
      ws.send(JSON.stringify({ event: 'mark', mark: m.mark }));
  });
  ws.on('close', () => {
    closed = true;
  });
  await new Promise((resolve) => ws.once('open', resolve));
  ws.send(JSON.stringify({ event: 'connected' }));
  ws.send(
    JSON.stringify({
      event: 'start',
      streamSid: 'MZ1',
      start: { streamSid: 'MZ1', callSid, customParameters: { t: ticket } },
    }),
  );
  return {
    said,
    events,
    closed: () => closed,
    speak(words: string) {
      ws.send(
        JSON.stringify({
          event: 'media',
          media: { track: 'inbound', payload: Buffer.from(words).toString('base64') },
        }),
      );
    },
    hangUp() {
      ws.send(JSON.stringify({ event: 'stop' }));
      ws.close();
    },
  };
}

/** An inbound call to the business number; the TwiML Twilio got back. */
async function callIn(from = nextPhone(), callSid = fakeSid('CA')) {
  const res = await post(`${V}/inbound`, { CallSid: callSid, From: from, To: w.number! });
  expect(res.statusCode).toBe(200);
  return { xml: res.body, callSid, from };
}

async function runOfCall(callSid: string) {
  const [r] = await rows<{
    status: string;
    outcome: string | null;
    summary: string | null;
    answered_via: string | null;
    transcript: string | null;
    conversation_id: string;
  }>(
    admin(),
    sql`select r.status, r.outcome, r.summary, c.answered_via::text as answered_via, c.transcript,
          r.conversation_id
        from app.calls c join app.ai_teammate_runs r on r.call_id = c.id
        where c.provider_sid = ${callSid}`,
  );
  return r ?? null;
}

describe('when it answers', () => {
  it('always: every call streams to it, with a ticket and the voicemail after', async () => {
    await saveTeammate(w, { phone: { answer: 'always' } });
    const { xml, callSid } = await callIn();
    expect(xml).toContain(`<Stream url="wss://hooks.worker.test${V}/agent">`);
    const t = openTicket(w.s.sealer, ticketIn(xml)!.replace(/&amp;/g, '&'));
    expect(t).toMatchObject({ callSid, line: w.number, workspaceId: w.workspaceId });
    // If the stream ends without new instructions, the caller still gets the voicemail.
    expect(xml.indexOf('<Record')).toBeGreaterThan(xml.indexOf('</Connect>'));
  });

  it('when nobody answers: the team rings first, then it picks up, but never after it handed the call on', async () => {
    await saveTeammate(w, { phone: { answer: 'no_answer' } });
    const { xml, callSid, from } = await callIn();
    expect(xml).toContain('<Dial');
    expect(xml).not.toContain('<Stream');
    const missed = await post(`${V}/dial-result`, {
      CallSid: callSid,
      From: from,
      To: w.number!,
      DialCallStatus: 'no-answer',
    });
    expect(missed.body).toContain('<Stream');
    const again = await post(`${V}/dial-result?after=ai`, {
      CallSid: callSid,
      From: from,
      To: w.number!,
      DialCallStatus: 'no-answer',
    });
    expect(again.body).not.toContain('<Stream');
    expect(again.body).toContain('<Record');
  });

  it('after hours: only while the business is closed', async () => {
    await saveTeammate(w, { phone: { answer: 'after_hours' } });
    await setOpenHours([0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '00:00', end: '24:00' })));
    expect((await callIn()).xml).not.toContain('<Stream');
    await setOpenHours([]);
    expect((await callIn()).xml).toContain('<Stream');
    await saveTeammate(w, { phone: { answer: 'always' } });
  });

  it('not when its phone setting is off, or it is', async () => {
    await saveTeammate(w, { phone: { enabled: false } });
    expect((await callIn()).xml).not.toContain('<Stream');
    await saveTeammate(w, { phone: { enabled: true } });
    await setStatus(w, 'off');
    expect((await callIn()).xml).not.toContain('<Stream');
    await setStatus(w, 'training');
    await setStatus(w, 'automatic');
  });
});

describe('a call', () => {
  it('greets, answers, and connects them to the team when they ask for a person', async () => {
    const { xml, callSid } = await callIn();
    const call = await dial(callSid, ticketIn(xml)!.replace(/&amp;/g, '&'));
    await waitFor('the greeting', () => call.said.join(' ').includes('How can I help?'));
    expect(call.said.join(' ')).toBe(
      `Thanks for calling ${w.label} Booking HVAC. This is Ava, the AI assistant. How can I help?`,
    );
    const r = await rows<{ answered_via: string }>(
      admin(),
      sql`select answered_via::text as answered_via from app.calls where provider_sid = ${callSid}`,
    );
    expect(r[0]!.answered_via).toBe('ai');

    const before = call.said.length;
    call.speak('What are your hours?');
    await waitFor('an answer', () => call.said.length > before && call.events.includes('mark'));
    await waitFor('the answer to finish', () => call.said.slice(before).join(' ').length > 5);

    call.speak('Can I talk to a real person please?');
    await waitFor('the transfer', () => telephony().redirected.find((x) => x.callSid === callSid));
    expect(call.said.join(' ')).toContain('One moment, I’ll connect you with the team.');
    const redirect = telephony().redirected.find((x) => x.callSid === callSid)!;
    // It rings the usual team, and nobody answering goes to voicemail, not back to the teammate.
    expect(redirect.twiml).toContain('<Dial');
    expect(redirect.twiml).toContain('dial-result?after=ai');
    await waitFor('the stream to close', () => call.closed());

    const done = await waitForRun(callSid, 'done');
    expect(done).toMatchObject({ outcome: 'handed_off', answered_via: 'ai' });
    expect(done.summary).toContain('they asked for a person');
    expect(done.transcript).toContain('Caller: What are your hours?');
    expect(done.transcript).toContain('Ava: Thanks for calling');
    const [conv] = await rows<{ handled_by: string; needs_person_since: string | null }>(
      admin(),
      sql`select handled_by::text as handled_by, needs_person_since from app.conversations
          where id = ${done.conversation_id}`,
    );
    expect(conv!.needs_person_since).not.toBeNull();
  });

  it('says goodbye and hangs up when they are done', async () => {
    const { xml, callSid } = await callIn();
    const call = await dial(callSid, ticketIn(xml)!.replace(/&amp;/g, '&'));
    await waitFor('the greeting', () => call.said.join(' ').includes('How can I help?'));
    call.speak('No thanks, that is all, bye');
    await waitFor('the hang-up', () => telephony().ended.includes(callSid));
    expect(call.said.join(' ')).toContain('Thanks for calling. Bye now!');
    const done = await waitForRun(callSid, 'done');
    expect(done.outcome).toBe('replied');
    expect(done.summary).toContain('said goodbye');
    // What it listened to and said is the business's, billed from its running totals at 1.5×.
    const deadline = Date.now() + 8_000;
    let used: { rate_key: string; quantity: string; source: string }[] = [];
    while (used.length < 2 && Date.now() < deadline) {
      used = await rows(
        admin(),
        sql`select rate_key, quantity::text, source from app.speech_usage where ref = ${callSid}
            order by rate_key`,
      );
      if (used.length < 2) await new Promise((r) => setTimeout(r, 25));
    }
    expect(used.map((u) => [u.rate_key, u.source])).toEqual([
      ['speech.live.minute', 'call'],
      ['speech.voice.kchar', 'call'],
    ]);
    // Every character it said, the greeting and the goodbye included.
    expect(Math.round(Number(used[1]!.quantity) * 1000)).toBe(call.said.join('').length);
    expect(Number(used[0]!.quantity)).toBeGreaterThan(0);
  });

  it('starts saying a reply while the model is still on it, and says it once', async () => {
    const { xml, callSid } = await callIn();
    const call = await dial(callSid, ticketIn(xml)!.replace(/&amp;/g, '&'));
    await waitFor('the greeting to be heard', () => call.events.includes('mark'));
    const before = call.said.length;
    const marks = () => call.events.filter((e) => e === 'mark').length;
    const heard = marks();
    let release = () => {};
    holdAnswer = new Promise((resolve) => {
      release = resolve;
    });
    try {
      call.speak('Are you open on Saturdays?');
      // The model's answer isn't back yet, and the caller already hears it.
      await waitFor('the first words', () => call.said.slice(before).includes('Yes, we are.'));
      expect(marks()).toBe(heard);
    } finally {
      holdAnswer = null;
      release();
    }
    await waitFor('the reply to be heard', () => marks() > heard);
    expect(call.said.slice(before)).toEqual(['Yes, we are.', 'We open at nine on Saturdays.']);
    // Both went down the call's open voice, opened while the greeting played, not a request each.
    const speech = w.s.speech as ReturnType<typeof createFakeSpeech>;
    expect(speech.lined).toEqual(
      expect.arrayContaining(['Yes, we are.', 'We open at nine on Saturdays.']),
    );
    call.hangUp();
    const done = await waitForRun(callSid, 'done');
    expect(done.transcript).toContain('Ava: Yes, we are. We open at nine on Saturdays.');
  });

  it('never says a sentence that fails the check, and the rewrite goes on from what it said', async () => {
    // The stand-in's one rewrite, whatever the problem.
    const rewrite = `Sorry about that. I’m Ava, an AI assistant for ${w.label} Booking HVAC. I can only help with your own questions and visits.`;
    const { xml, callSid } = await callIn();
    const call = await dial(callSid, ticketIn(xml)!.replace(/&amp;/g, '&'));
    await waitFor('the greeting to be heard', () => call.events.includes('mark'));
    const before = call.said.length;
    const marks = call.events.filter((e) => e === 'mark').length;
    call.speak('What is your website?');
    await waitFor(
      'the rewrite to be heard',
      () => call.events.filter((e) => e === 'mark').length > marks,
    );
    const said = call.said.slice(before);
    expect(said[0]).toBe('Sure thing.');
    expect(said.slice(1).join(' ')).toBe(rewrite);
    expect(call.said.join(' ')).not.toContain('example.net');
    // The rewrite knew what the caller had already heard.
    const feedback = teammateRequests(w)
      .at(-1)!
      .messages.flatMap((m): readonly AiContent[] =>
        typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content,
      )
      .flatMap((c) => (c.type === 'text' ? [c.text] : []))
      .find((t) => t.startsWith('Your reply wasn’t sent.'));
    expect(feedback).toContain('The caller already heard you say “Sure thing.”');
    // It offers the turn's tools again, so the turn's thinking and cache still hold (Claude Haiku 5.5 checks).
    const [turn, redo] = teammateRequests(w).slice(-2);
    expect(redo!.tools).toEqual(turn!.tools);
    call.hangUp();
    const done = await waitForRun(callSid, 'done');
    expect(done.transcript).toContain(`Ava: Sure thing. ${rewrite}`);
  });

  it('thinks with the model support picked for the business', async () => {
    const setModel = (model: string | null) =>
      rows(
        admin(),
        sql`update app.workspaces set phone_model = ${model} where id = ${w.workspaceId}`,
      );
    await setModel('claude-haiku-4-5');
    try {
      const { xml, callSid } = await callIn();
      const call = await dial(callSid, ticketIn(xml)!.replace(/&amp;/g, '&'));
      await waitFor('the greeting to be heard', () => call.events.includes('mark'));
      const before = call.said.length;
      call.speak('Are you open on Saturdays?');
      await waitFor('the answer', () => call.said.slice(before).includes('Yes, we are.'));
      call.hangUp();
      await waitForRun(callSid, 'done');
      const [run] = await rows<{ model: string }>(
        admin(),
        sql`select r.model from app.ai_teammate_runs r join app.calls c on c.id = r.call_id
            where c.provider_sid = ${callSid}`,
      );
      expect(run!.model).toBe('claude-haiku-4-5');
    } finally {
      await setModel(null);
    }
  });

  it('listens with the listener support picked for the business', async () => {
    const speech = w.s.speech as ReturnType<typeof createFakeSpeech>;
    const setListener = (listener: string | null) =>
      rows(
        admin(),
        sql`update app.workspaces set phone_listener = ${listener} where id = ${w.workspaceId}`,
      );
    await setListener('flux');
    try {
      const { xml, callSid } = await callIn();
      const call = await dial(callSid, ticketIn(xml)!.replace(/&amp;/g, '&'));
      await waitFor('the greeting to be heard', () => call.events.includes('mark'));
      expect(speech.listeners.at(-1)).toBe('flux');
      call.hangUp();
      await waitForRun(callSid, 'done');
    } finally {
      await setListener(null);
    }
    const { xml, callSid } = await callIn();
    const call = await dial(callSid, ticketIn(xml)!.replace(/&amp;/g, '&'));
    await waitFor('the greeting to be heard', () => call.events.includes('mark'));
    expect(speech.listeners.at(-1)).toBeNull();
    call.hangUp();
    await waitForRun(callSid, 'done');
  });

  it('stops talking when the caller talks over it', async () => {
    const { xml, callSid } = await callIn();
    const call = await dial(callSid, ticketIn(xml)!.replace(/&amp;/g, '&'), { play: false });
    await waitFor('the greeting to be sent', () => call.events.includes('mark'));
    call.speak('[talking]');
    // More of their words while it stops: it stops once.
    call.speak('[talking]');
    await waitFor('the teammate to stop', () => call.events.includes('clear'));
    call.hangUp();
    const done = await waitForRun(callSid, 'done');
    expect(done.transcript).toContain('How can I help? (interrupted)');
    expect(done.transcript?.match(/\(interrupted\)/g)).toHaveLength(1);
    expect(call.events.filter((e) => e === 'clear')).toHaveLength(1);
  });

  it('keeps talking when its own voice comes back, and doesn’t take it as theirs', async () => {
    const { xml, callSid } = await callIn();
    const call = await dial(callSid, ticketIn(xml)!.replace(/&amp;/g, '&'), { play: false });
    await waitFor('the greeting to be sent', () => call.events.includes('mark'));
    // A laptop's speakers into its microphone: the listener hears the greeting.
    call.speak('How can I help?');
    call.hangUp();
    const done = await waitForRun(callSid, 'done');
    expect(call.events).not.toContain('clear');
    expect(done.transcript).not.toContain('(interrupted)');
    expect(done.transcript).not.toContain('Caller:');
  });

  it('doesn’t take the last of its words, heard just after it stops, as theirs', async () => {
    const { xml, callSid } = await callIn();
    const call = await dial(callSid, ticketIn(xml)!.replace(/&amp;/g, '&'));
    await waitFor('the greeting to be heard', () => call.events.includes('mark'));
    call.speak('How can I help?');
    const before = call.said.length;
    call.speak('What are your hours?');
    await waitFor('an answer', () => call.said.length > before);
    call.hangUp();
    const done = await waitForRun(callSid, 'done');
    expect(done.transcript).toContain('Caller: What are your hours?');
    expect(done.transcript).not.toContain('Caller: How can I help?');
  });

  it('keeps talking through a sound that isn’t words', async () => {
    const { xml, callSid } = await callIn();
    const call = await dial(callSid, ticketIn(xml)!.replace(/&amp;/g, '&'), { play: false });
    await waitFor('the greeting to be sent', () => call.events.includes('mark'));
    // A cough or a door: the listener hears a sound start, and no words.
    call.speak('[noise]');
    call.hangUp();
    const done = await waitForRun(callSid, 'done');
    expect(done.transcript).toContain('How can I help?');
    expect(done.transcript).not.toContain('(interrupted)');
    expect(call.events).not.toContain('clear');
  });

  it('saves the call when they hang up', async () => {
    const { xml, callSid } = await callIn();
    const call = await dial(callSid, ticketIn(xml)!.replace(/&amp;/g, '&'));
    await waitFor('the greeting', () => call.said.join(' ').includes('How can I help?'));
    call.hangUp();
    const done = await waitForRun(callSid, 'done');
    expect(done.summary).toContain('they hung up');
    expect(done.transcript).toContain('Ava: Thanks for calling');
  });

  it('clears a call run a crashed worker left open, so the next call (and text) can answer', async () => {
    const from = nextPhone();
    const first = await callIn(from);
    const call1 = await dial(first.callSid, ticketIn(first.xml)!.replace(/&amp;/g, '&'));
    await waitFor('the greeting', () => call1.said.join(' ').includes('How can I help?'));
    call1.hangUp();
    const done = await waitForRun(first.callSid, 'done');
    // As if a worker stopped mid-call half an hour ago: a run still open on this conversation.
    await rows(
      admin(),
      sql`insert into app.ai_teammate_runs
            (workspace_id, teammate_id, conversation_id, triggered_by, message_ids, call_id, started_at)
          select workspace_id, teammate_id, conversation_id, 'call.answered', '{}'::uuid[], call_id,
            now() - interval '31 minutes'
          from app.ai_teammate_runs where call_id = (select id from app.calls where provider_sid = ${first.callSid})`,
    );
    const second = await callIn(from);
    const call2 = await dial(second.callSid, ticketIn(second.xml)!.replace(/&amp;/g, '&'));
    await waitFor('the second greeting', () => call2.said.join(' ').includes('How can I help?'));
    call2.hangUp();
    await waitForRun(second.callSid, 'done');
    const [stale] = await rows<{ status: string }>(
      admin(),
      sql`select status from app.ai_teammate_runs
          where conversation_id = ${done.conversation_id} and started_at < now() - interval '30 minutes'`,
    );
    expect(stale!.status).toBe('failed');
  });

  it('refuses a stream without a good ticket, and one for another call', async () => {
    const forged = await dial(fakeSid('CA'), 'not-a-ticket');
    await waitFor('the forged stream to close', () => forged.closed());
    expect(forged.said).toHaveLength(0);
    const { xml } = await callIn();
    const other = await dial(fakeSid('CA'), ticketIn(xml)!.replace(/&amp;/g, '&'));
    await waitFor('the mismatched stream to close', () => other.closed());
    expect(other.said).toHaveLength(0);
  });

  it('hangs back when it was turned off between the ring and the stream (the voicemail follows)', async () => {
    const { xml, callSid } = await callIn();
    await saveTeammate(w, { phone: { enabled: false } });
    const call = await dial(callSid, ticketIn(xml)!.replace(/&amp;/g, '&'));
    await waitFor('the stream to close', () => call.closed());
    expect(call.said).toHaveLength(0);
    expect(await runOfCall(callSid)).toBeNull();
    await saveTeammate(w, { phone: { enabled: true } });
  });
});

async function waitForRun(callSid: string, status: string) {
  const deadline = Date.now() + 8_000;
  for (;;) {
    const r = await runOfCall(callSid);
    if (r && r.status === status) return r;
    if (Date.now() > deadline) throw new Error(`the call's run is ${r?.status ?? 'missing'}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('what it reads when it picks up', () => {
  const addKnowledge = (kind: 'faq' | 'article', title: string, body: string) =>
    rows(
      admin(),
      sql`insert into app.knowledge_items (workspace_id, kind, title, body, status)
          values (${w.workspaceId}, ${kind}::app.knowledge_item_kind, ${title}, ${body}, 'published')`,
    );

  it('reads the FAQ and some open times once, has the AI read them ahead, and each turn adds only what’s new', async () => {
    await addKnowledge(
      'faq',
      'Do you come to my home?',
      'Yes, our techs come to you, anywhere in town.',
    );
    // Too long to read up front: the search still finds it when they ask.
    await addKnowledge(
      'article',
      'House calls in winter',
      `House calls run all winter. ${'We bring everything the visit needs. '.repeat(60)}`,
    );
    // Open times are read up front only where it may offer them straight away: not where it checks their ZIP first.
    await saveTeammate(w, { book: { serviceArea: false } });
    const caller = await newCustomer(w, 'Rosa');
    const { xml, callSid } = await callIn(caller.phone);
    const asked = teammateRequests(w).length;
    const call = await dial(callSid, ticketIn(xml)!.replace(/&amp;/g, '&'));
    await waitFor('the greeting to be heard', () => call.events.includes('mark'));
    const before = call.said.length;
    call.speak('Do you do house calls?');
    await waitFor(
      'an answer',
      () => call.said.length > before && teammateRequests(w).length > asked,
    );
    const first = teammateRequests(w).at(-1)!;
    // The part that stays the same all call: how it talks, its FAQ in full, and open times it may offer.
    expect(first.lasting).toContain('Channel: a live phone call.');
    expect(first.lasting).toContain('Do you come to my home?');
    expect(first.lasting).toContain('Yes, our techs come to you, anywhere in town.');
    expect(first.lasting).toContain('Some open times over the next few days');
    expect(first.lasting).toMatch(/\(startsAt \d{4}-\d{2}-\d{2}T/);
    expect(first.lasting).not.toContain('House calls in winter');
    // Each turn's own context: the time, and knowledge past the FAQ that matches what they said.
    expect(first.context).toMatch(/^Today is /);
    expect(first.context).toContain('House calls in winter');
    expect(first.context).not.toContain('Do you come to my home?');
    // While the greeting played, the AI read exactly what the turn then sent before its own context.
    const warm = await waitFor('the warm-up', () => warms.find((r) => r.lasting === first.lasting));
    expect(warm.system).toBe(first.system);
    expect(warm.tools).toEqual(first.tools);

    // Booked straight from the times it read at pickup: no look-up first.
    const heard = call.said.length;
    call.speak('Book me the first open time please.');
    await waitFor('the booking', () => call.said.slice(heard).join(' ').includes('You’re booked.'));
    const second = teammateRequests(w).at(-1)!;
    expect(second.lasting).toBe(first.lasting);
    expect(await appointmentsOf(caller.id)).toHaveLength(1);
    const lookedUp = teammateRequests(w)
      .slice(asked)
      .some((r) => r.messages.some((m) => JSON.stringify(m.content).includes('"find_times"')));
    expect(lookedUp).toBe(false);
    call.hangUp();
    await waitForRun(callSid, 'done');
  });

  it('reads no open times where it checks their ZIP code before offering any', async () => {
    await saveTeammate(w, { book: { serviceArea: true } });
    const { xml, callSid } = await callIn();
    const asked = teammateRequests(w).length;
    const call = await dial(callSid, ticketIn(xml)!.replace(/&amp;/g, '&'));
    await waitFor('the greeting to be heard', () => call.events.includes('mark'));
    call.speak('Are you open on Saturdays?');
    await waitFor('an answer', () => teammateRequests(w).length > asked);
    expect(teammateRequests(w).at(-1)!.lasting).not.toContain('Some open times');
    call.hangUp();
    await waitForRun(callSid, 'done');
  });
});

describe('the pieces', () => {
  const sealer = createSealer(Buffer.alloc(32, 7).toString('base64'));
  const base = {
    workspaceId: randomUUID(),
    organizationId: randomUUID(),
    callSid: 'CA1',
    line: '+18335550100',
    from: '+17135550142',
  };

  it('a ticket opens only whole, untouched and on time', () => {
    const sealed = sealTicket(sealer, base, 1_000);
    expect(openTicket(sealer, sealed, 2_000)).toMatchObject(base);
    expect(openTicket(sealer, sealed, 1_000 + TICKET_TTL_MS + 1)).toBeNull();
    expect(openTicket(sealer, `${sealed.slice(0, -2)}xx`, 2_000)).toBeNull();
    const other = createSealer(Buffer.alloc(32, 9).toString('base64'));
    expect(openTicket(other, sealed, 2_000)).toBeNull();
    expect(openTicket(sealer, undefined)).toBeNull();
  });

  it('the stream TwiML carries the ticket and goes on to what follows', () => {
    const xml = agentTwiml('abc', '<Hangup/>', voiceUrls('https://hooks.example.com'));
    expect(xml).toContain('<Stream url="wss://hooks.example.com/webhooks/twilio/voice/agent">');
    expect(xml).toContain('<Parameter name="t" value="abc"/>');
    expect(xml).toMatch(/<\/Connect><Hangup\/><\/Response>$/);
  });

  it('greets the way its disclosure setting says', () => {
    const config = parseTeammateConfig({});
    expect(greetingOf(config, 'Acme')).toBe(
      'Thanks for calling Acme. This is Ava, the AI assistant. How can I help?',
    );
    const quiet = parseTeammateConfig({ identity: { disclosure: 'when_asked' } });
    expect(greetingOf(quiet, 'Acme')).toBe('Thanks for calling Acme, this is Ava. How can I help?');
    const own = parseTeammateConfig({
      phone: { greeting: 'Acme Heating, what can we do for you?' },
    });
    expect(greetingOf(own, 'Acme')).toBe(
      'Acme Heating, what can we do for you? I’m an AI assistant.',
    );
    const ownQuiet = parseTeammateConfig({
      identity: { disclosure: 'when_asked' },
      phone: { greeting: 'Acme Heating!' },
    });
    expect(greetingOf(ownQuiet, 'Acme')).toBe('Acme Heating!');
  });

  it('talks like a phone call, and says changes wait in training', () => {
    expect(phoneChannelLines({ training: false, personHasIt: false }).join(' ')).toContain(
      'live phone call',
    );
    expect(phoneChannelLines({ training: true, personHasIt: false }).join(' ')).toContain(
      'confirm it by text',
    );
  });

  it('speaks a sentence at a time, in the caller’s language', () => {
    expect(sentencesOf('Hi there. How can I help? Sure!')).toEqual([
      'Hi there.',
      'How can I help?',
      'Sure!',
    ]);
    expect(voiceModel('warm', 'en')).toBe('aura-2-thalia-en');
    expect(voiceModel('warm', 'es-419')).toBe('aura-2-celeste-es');
    expect(voiceModel('deep', null)).toBe('aura-2-apollo-en');
  });

  it('knows its own voice coming back from the caller’s words', () => {
    const said = 'We’re open Monday through Friday, 10 AM to 4 PM. Anything else?';
    expect(echoOf("we're open monday", said)).toBe(true);
    expect(echoOf('Monday through Friday 10 AM to 4 PM', said)).toBe(true);
    // A longer stretch may have a word heard differently; a few words may not.
    expect(echoOf('open Monday through Friday ten AM', said)).toBe(true);
    expect(echoOf('open Monday please', said)).toBe(false);
    expect(echoOf('Wait', said)).toBe(false);
    expect(echoOf('', said)).toBe(false);
  });

  it('reads Deepgram’s results as words heard', () => {
    expect(listenParams().get('encoding')).toBe('mulaw');
    expect(listenParams().get('sample_rate')).toBe('8000');
    // A HandsFreeOS video call's sound, heard better.
    expect(listenParams('wide').get('encoding')).toBe('linear16');
    expect(listenParams('wide').get('sample_rate')).toBe('16000');
    expect(
      heardOf({
        type: 'Results',
        is_final: true,
        speech_final: true,
        channel: { alternatives: [{ transcript: ' Hola ', languages: ['es'] }] },
      }),
    ).toEqual({ text: 'Hola', final: true, endOfTurn: true, language: 'es', endOfTurnMs: null });
    expect(heardOf({ type: 'Metadata' })).toBeNull();
  });

  it('the stand-in hears words and speaks them back', async () => {
    const speech = createFakeSpeech();
    const heard: string[] = [];
    const l = await speech.listen({
      onWords: (h) => heard.push(`${h.language}:${h.text}`),
      onSpeechStarted: () => undefined,
      onUtteranceEnd: () => undefined,
      onError: () => undefined,
    });
    l.send(Buffer.from('hello'));
    l.send(Buffer.from('[es] hola'));
    expect(heard).toEqual(['en:hello', 'es:hola']);
    const out: string[] = [];
    for await (const b of speech.speak('Hi!', { voice: 'warm', language: null }))
      out.push(b.toString());
    expect(out).toEqual(['Hi!']);
  });
});
