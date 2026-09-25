/**
 * AI outbound calls (piece 4a) on the real database, the fake carrier, the stand-in speech (audio is words) and the
 * scripted model:
 * - confirming tomorrow's visit: the day-before ask went unanswered, so it calls (automatic), says it's an AI and
 *   that the call is recorded, and a "yes" confirms the visit;
 * - a missed call, while it trains: a call draft; approved, it's placed, a voicemail box answers and a text goes
 *   instead;
 * - a missed call it rings back where they ask not to be called again: nobody's AI calls them after that;
 * - a visit confirmed meanwhile, or quiet hours, leave the call alone (or waiting);
 * - a quote still unanswered two days after its reminder (piece 4b): a call draft even while the teammate is
 *   automatic, and a word from them since leaves it alone;
 * - a call campaign (piece 4b): only people who agreed to calls in writing, the AI's opening line, and approved
 *   once, each call goes without a draft, even while the teammate trains.
 */
import type { AddressInfo } from 'node:net';
import {
  aiTeammateDecideDraft,
  appointmentCreate,
  automationsSaveSettings,
  callRecord,
  callUpdateStatus,
  campaignApprove,
  campaignCreate,
  campaignGet,
  campaignUpdateCall,
  defaultAutomationSettings,
  estimateCreate,
  executeCommand,
  personSetCallConsent,
  tagCreate,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  aiCallConsiderKey,
  aiCallPlaceKey,
  armConfirmCall,
  callBrief,
  CONFIRM_CALL_AFTER_MS,
  QUOTE_CALL_AFTER_MS,
  spokenWhen,
  voicemailText,
} from '../src/ai-calls/index';
import { cleanOpening, fallbackOpening } from '../src/automations/campaigns';
import { recordSystemEvent } from '../src/system-event';
import { scriptedAi } from '../src/ai/scripted';
import { answeredByMachine, voicemailMessage } from '../src/http/ai-calls';
import { buildHttpServer } from '../src/http/server';
import { systemActor, workerMeta } from '../src/services';
import { FAKE_AUTH_TOKEN, fakeSid, type FakeTelephony } from '../src/telephony/fake';
import { twilioSignature } from '../src/telephony/signature';
import { outboundGreetingOf } from '../src/voice-agent/prompt';
import { openTicket } from '../src/voice-agent/ticket';
import { TEST_PUBLIC_URL } from './helpers';
import {
  admin,
  at,
  drain,
  iso,
  newCustomer,
  query,
  run,
  runNow,
  saveTeammate,
  setQuietHours,
  setStatus,
  teammateWorld,
  textIn,
  textsTo,
  useModel,
  type TeammateWorld,
} from './ai-team-world';

const V = '/webhooks/twilio/voice';

let w: TeammateWorld;
let app: FastifyInstance;
let port: number;
let accountSid: string;

beforeAll(async () => {
  w = await teammateWorld('aicalls', {
    preset: 'appointment_coordinator',
    calendar: 'Tune-ups',
    status: 'automatic',
  });
  useModel(
    w,
    scriptedAi([], {
      teammate: [
        {
          when: /don'?t call/i,
          step: () => ({
            calls: [
              { name: 'no_more_calls', arguments: {} },
              { name: 'end_call', arguments: { message: 'Sorry for the trouble. Goodbye.' } },
            ],
          }),
        },
        {
          when: /still works/i,
          step: () => ({
            calls: [
              { name: 'confirm_visit', arguments: {} },
              { name: 'end_call', arguments: { message: 'Great, see you then. Bye!' } },
            ],
          }),
        },
      ],
    }),
  );
  await saveTeammate(w, { phone: { enabled: true, answer: 'no_answer' } });
  // Open around the clock and never quiet, so the calls go whatever the hour the suite runs.
  await rows(
    admin(),
    sql`update app.workspaces set settings = coalesce(settings, '{}'::jsonb) || '{"openHours": []}'::jsonb
        where id = ${w.workspaceId}`,
  );
  await setQuietHours(w, null);
  await saveAutomations({ callConfirmVisits: true, callBackMissed: true, callQuotes: true });
  const [a] = await rows<{ account_sid: string }>(
    admin(),
    sql`select account_sid from app.telephony_accounts where workspace_id = ${w.workspaceId}`,
  );
  accountSid = a!.account_sid;
  app = await buildHttpServer({
    ...w.s,
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

async function saveAutomations(
  switches: Record<string, boolean>,
  calls: { voicemail?: 'text' | 'message' | 'hang_up' } = {},
) {
  const s = defaultAutomationSettings();
  await run(w, automationsSaveSettings, {
    workspaceId: w.workspaceId,
    settings: { ...s, switches: { ...s.switches, ...switches }, calls: { ...s.calls, ...calls } },
  });
}

const telephony = () => w.s.telephony as FakeTelephony;
const scope = () => ({ workspaceId: w.workspaceId, organizationId: w.organizationId });

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

const ticketIn = (xml: string) =>
  /<Parameter name="t" value="([^"]+)"/.exec(xml)?.[1]?.replace(/&amp;/g, '&') ?? null;

async function waitFor<T>(what: string, get: () => T | null | undefined | false, ms = 8_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Twilio's side of the call's stream: marks played back at once, and what the teammate says as words. */
async function dial(callSid: string, ticket: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${V}/agent`);
  const said: string[] = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw)) as {
      event: string;
      media?: { payload: string };
      mark?: { name: string };
    };
    if (m.event === 'media') said.push(Buffer.from(m.media!.payload, 'base64').toString('utf8'));
    if (m.event === 'mark') ws.send(JSON.stringify({ event: 'mark', mark: m.mark }));
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
    speak(words: string) {
      ws.send(
        JSON.stringify({
          event: 'media',
          media: { track: 'inbound', payload: Buffer.from(words).toString('base64') },
        }),
      );
    },
  };
}

interface AiCallRow extends Record<string, unknown> {
  id: string;
  status: string;
  outcome: string | null;
  reason: string | null;
  summary: string | null;
  draft_id: string | null;
  call_id: string | null;
}
const aiCallsOf = (personId: string) =>
  rows<AiCallRow>(
    admin(),
    sql`select id, status, outcome, reason, summary, draft_id, call_id from app.ai_calls
        where person_id = ${personId} order by created_at`,
  );

/** The call the carrier was asked to place to this number. */
const placedTo = (to: string) => telephony().calls.find((c) => c.to === to);

let slotDay = 1;
async function tomorrowsVisit(personId: string) {
  const { appointmentId } = await run(w, appointmentCreate, {
    workspaceId: w.workspaceId,
    calendarId: w.calendar!.id,
    startsAt: iso(at(slotDay++, '10:00')),
    personId,
    notify: false,
  });
  await drain(w);
  const [seat] = await rows<{ id: string }>(
    admin(),
    sql`select id from app.appointment_attendees where appointment_id = ${appointmentId}`,
  );
  return seat!.id;
}

/** The day-before ask went three hours ago: the confirming call is due now. */
const askedToConfirm = (attendeeId: string) =>
  asWorker(testDbs().worker.db, scope(), (tx) =>
    armConfirmCall(tx, scope(), attendeeId, Date.now() - CONFIRM_CALL_AFTER_MS),
  );

/** A call from them nobody answered. */
async function missedCallFrom(phone: string) {
  const sid = fakeSid('CA');
  const s = systemActor(scope());
  const { output } = await executeCommand(
    testDbs().worker.db,
    callRecord,
    {
      workspaceId: w.workspaceId,
      providerSid: sid,
      direction: 'inbound',
      from: phone,
      to: w.number!,
    },
    s,
    workerMeta(),
  );
  await executeCommand(
    testDbs().worker.db,
    callUpdateStatus,
    { workspaceId: w.workspaceId, callId: output.callId, status: 'no_answer' },
    s,
    workerMeta(),
  );
  await drain(w);
  return output.callId;
}

describe('confirming tomorrow’s visit', () => {
  it('calls, says it’s an AI and recorded, and a yes confirms the visit', async () => {
    const ann = await newCustomer(w, 'Ann');
    const seat = await tomorrowsVisit(ann.id);
    await askedToConfirm(seat);
    await drain(w);

    const [call] = await aiCallsOf(ann.id);
    expect(call).toMatchObject({ status: 'calling' });
    const placed = placedTo(ann.phone)!;
    expect(placed).toMatchObject({ from: w.number, machineDetection: 'answer' });
    expect(placed.record?.statusCallbackUrl).toBe(`${TEST_PUBLIC_URL}${V}/recording`);
    expect(placed.answerUrl).toBe(`${TEST_PUBLIC_URL}${V}/ai-call?aiCall=${call!.id}`);

    // They pick up.
    const answered = await post(`${V}/ai-call?aiCall=${call!.id}`, {
      CallSid: placed.sid,
      From: w.number!,
      To: ann.phone,
      AnsweredBy: 'human',
    });
    expect(answered.body).toContain('<Stream');
    const ticket = ticketIn(answered.body)!;
    expect(openTicket(w.s.sealer, ticket)).toMatchObject({ aiCallId: call!.id, from: ann.phone });

    const line = await dial(placed.sid, ticket);
    await waitFor('the greeting', () => line.said.join(' ').includes('still work for you?'));
    const hello = line.said.join(' ');
    expect(hello).toContain('Hi Ann, this is Ava, an AI assistant for');
    expect(hello).toContain('This call is recorded.');
    expect(hello).toContain('about your');
    line.speak('Yes, that still works.');
    await waitFor('the goodbye', () => telephony().ended.includes(placed.sid));
    expect(line.said.join(' ')).toContain('Great, see you then. Bye!');

    const [seatNow] = await rows<{ confirmed_via: string | null }>(
      admin(),
      sql`select confirmed_via::text as confirmed_via from app.appointment_attendees where id = ${seat}`,
    );
    expect(seatNow?.confirmed_via).toBe('ai');
    await waitFor('the call’s row', async () => {
      const [c] = await aiCallsOf(ann.id);
      return c?.status === 'done' ? c : null;
    });
    expect((await aiCallsOf(ann.id))[0]).toMatchObject({ status: 'done', outcome: 'talked' });
    const [runRow] = await rows<{ triggered_by: string }>(
      admin(),
      sql`select r.triggered_by from app.ai_teammate_runs r join app.calls c on c.id = r.call_id
          where c.provider_sid = ${placed.sid}`,
    );
    expect(runRow?.triggered_by).toBe('call.placed');
  });

  it('leaves a visit confirmed meanwhile alone, and waits out quiet hours', async () => {
    const bo = await newCustomer(w, 'Bo');
    const seat = await tomorrowsVisit(bo.id);
    await rows(
      admin(),
      sql`update app.appointment_attendees set confirmed_at = now(), confirmed_via = 'sms' where id = ${seat}`,
    );
    await askedToConfirm(seat);
    await drain(w);
    expect(await aiCallsOf(bo.id)).toEqual([]);

    const cy = await newCustomer(w, 'Cy');
    const cySeat = await tomorrowsVisit(cy.id);
    // Quiet all day but this hour's last minute: it waits.
    await setQuietHours(w, { start: '00:00', end: '23:59' });
    try {
      await askedToConfirm(cySeat);
      await drain(w);
      const [queued] = await aiCallsOf(cy.id);
      expect(queued).toMatchObject({ status: 'queued' });
      expect(placedTo(cy.phone)).toBeUndefined();
      const [job] = await rows<{ run_at: Date; status: string }>(
        admin(),
        sql`select run_at, status::text as status from app.scheduled_jobs
            where dedupe_key = ${aiCallPlaceKey(queued!.id)}`,
      );
      expect(job?.status).toBe('pending');
      expect(new Date(job!.run_at).getTime()).toBeGreaterThan(Date.now());
    } finally {
      await setQuietHours(w, null);
    }
  });
});

describe('a missed call', () => {
  it('while training: a call draft; approved, it calls, and a voicemail box gets a text instead', async () => {
    await setStatus(w, 'training');
    try {
      const dee = await newCustomer(w, 'Dee');
      const missed = await missedCallFrom(dee.phone);
      await runNow(w, [aiCallConsiderKey('missed_call', missed)]);
      const [waiting] = await aiCallsOf(dee.id);
      expect(waiting).toMatchObject({ status: 'awaiting_approval' });
      expect(placedTo(dee.phone)).toBeUndefined();
      const [draft] = await rows<{ kind: string; preview: { call: { goal: string } } }>(
        admin(),
        sql`select kind, preview from app.ai_teammate_drafts where id = ${waiting!.draft_id}`,
      );
      expect(draft).toMatchObject({
        kind: 'call',
        preview: { call: { goal: 'back, since we missed your call earlier.' } },
      });

      await run(w, aiTeammateDecideDraft, {
        workspaceId: w.workspaceId,
        draftId: waiting!.draft_id!,
        decision: 'approve',
      });
      await drain(w);
      const placed = placedTo(dee.phone)!;
      expect(placed).toBeDefined();
      const answered = await post(`${V}/ai-call?aiCall=${waiting!.id}`, {
        CallSid: placed.sid,
        From: w.number!,
        To: dee.phone,
        AnsweredBy: 'machine_start',
      });
      expect(answered.body).not.toContain('<Stream');
      expect(answered.body).toContain('<Hangup/>');
      await drain(w);
      expect((await aiCallsOf(dee.id))[0]).toMatchObject({ status: 'done', outcome: 'voicemail' });
      expect(textsTo(w, dee.phone).map((t) => t.body)).toEqual([
        expect.stringContaining('Sorry we missed your call. How can we help?'),
      ]);
    } finally {
      await setStatus(w, 'automatic');
    }
  });

  it('rejected, nobody is called', async () => {
    await setStatus(w, 'training');
    try {
      const eve = await newCustomer(w, 'Eve');
      const missed = await missedCallFrom(eve.phone);
      await runNow(w, [aiCallConsiderKey('missed_call', missed)]);
      const [waiting] = await aiCallsOf(eve.id);
      await run(w, aiTeammateDecideDraft, {
        workspaceId: w.workspaceId,
        draftId: waiting!.draft_id!,
        decision: 'reject',
      });
      await drain(w);
      expect((await aiCallsOf(eve.id))[0]).toMatchObject({
        status: 'cancelled',
        reason: 'not_approved',
      });
      expect(placedTo(eve.phone)).toBeUndefined();
    } finally {
      await setStatus(w, 'automatic');
    }
  });

  it('someone who asks not to be called again isn’t', async () => {
    const fay = await newCustomer(w, 'Fay');
    const missed = await missedCallFrom(fay.phone);
    await runNow(w, [aiCallConsiderKey('missed_call', missed)]);
    const [call] = await aiCallsOf(fay.id);
    const placed = placedTo(fay.phone)!;
    const answered = await post(`${V}/ai-call?aiCall=${call!.id}`, {
      CallSid: placed.sid,
      From: w.number!,
      To: fay.phone,
      AnsweredBy: 'human',
    });
    const line = await dial(placed.sid, ticketIn(answered.body)!);
    await waitFor('the greeting', () => line.said.join(' ').includes('How can I help?'));
    expect(line.said.join(' ')).toContain('I’m calling back, since we missed your call earlier.');
    line.speak("Please don't call me again.");
    await waitFor('the goodbye', () => telephony().ended.includes(placed.sid));
    const [p] = await rows<{ call_consent: string; call_consent_source: string | null }>(
      admin(),
      sql`select call_consent::text as call_consent, call_consent_source from app.people where id = ${fay.id}`,
    );
    expect(p).toEqual({ call_consent: 'opted_out', call_consent_source: 'Asked on a call' });

    // Another missed call from them: no call back.
    const again = await missedCallFrom(fay.phone);
    await runNow(w, [aiCallConsiderKey('missed_call', again)]);
    expect(await aiCallsOf(fay.id)).toHaveLength(1);
  });

  it('refuses an answer for a call it didn’t place', async () => {
    const res = await post(`${V}/ai-call?aiCall=00000000-0000-4000-8000-000000000000`, {
      CallSid: fakeSid('CA'),
      From: w.number!,
      To: '+17135550000',
      AnsweredBy: 'human',
    });
    expect(res.body).toContain('<Hangup/>');
    expect(res.body).not.toContain('<Stream');
  });
});

// ---------- quotes (piece 4b) ----------

/** A quote sent to them, its reminder text gone just now. */
async function nudgedQuote(personId: string, title: string) {
  const { estimateId } = (await run(w, estimateCreate, {
    workspaceId: w.workspaceId,
    personId,
    title,
    lines: [{ name: title, quantity: 1, unitPriceCents: 640_000, taxable: false }],
  })) as { estimateId: string };
  await rows(
    admin(),
    sql`update app.estimates set status = 'sent', number = ${`Q-${estimateId.slice(0, 6)}`},
          sent_at = now() - interval '4 days'
        where id = ${estimateId}`,
  );
  await asWorker(testDbs().worker.db, scope(), (tx) =>
    recordSystemEvent(tx, {
      type: 'estimate.nudged',
      action: 'estimate.nudge',
      organizationId: w.organizationId,
      workspaceId: w.workspaceId,
      entityType: 'estimate',
      entityId: estimateId,
      payload: { estimateId, outcome: 'sent', _broadcast: false },
      after: {},
      correlationId: crypto.randomUUID(),
      causationId: crypto.randomUUID(),
    }),
  );
  await drain(w);
  return estimateId;
}

describe('a quote with no answer', () => {
  it('asks to call two days after its reminder, even while automatic, and a person approves it', async () => {
    const gus = await newCustomer(w, 'Gus');
    const estimateId = await nudgedQuote(gus.id, 'AC install');
    const [job] = await rows<{ run_at: Date }>(
      admin(),
      sql`select run_at from app.scheduled_jobs where dedupe_key = ${aiCallConsiderKey('quote', estimateId)}`,
    );
    const wait = new Date(job!.run_at).getTime() - Date.now();
    expect(wait).toBeGreaterThan(QUOTE_CALL_AFTER_MS - 60_000);
    expect(wait).toBeLessThanOrEqual(QUOTE_CALL_AFTER_MS);

    await runNow(w, [aiCallConsiderKey('quote', estimateId)]);
    const [waiting] = await aiCallsOf(gus.id);
    // Money never chases itself: it waits for a person though the teammate is automatic.
    expect(waiting).toMatchObject({ status: 'awaiting_approval' });
    expect(placedTo(gus.phone)).toBeUndefined();
    const [draft] = await rows<{ preview: { call: { purpose: string; goal: string } } }>(
      admin(),
      sql`select preview from app.ai_teammate_drafts where id = ${waiting!.draft_id}`,
    );
    expect(draft!.preview.call).toMatchObject({
      purpose: 'quote',
      goal: 'about the quote we sent you for AC install.',
    });
    const brief = await asWorker(testDbs().worker.db, scope(), (tx) => callBrief(tx, waiting!.id));
    expect(brief).toContain('AC install');
    expect(brief).toContain('Total: $6,400');

    await run(w, aiTeammateDecideDraft, {
      workspaceId: w.workspaceId,
      draftId: waiting!.draft_id!,
      decision: 'approve',
    });
    await drain(w);
    const placed = placedTo(gus.phone)!;
    const answered = await post(`${V}/ai-call?aiCall=${waiting!.id}`, {
      CallSid: placed.sid,
      From: w.number!,
      To: gus.phone,
      AnsweredBy: 'human',
    });
    const line = await dial(placed.sid, ticketIn(answered.body)!);
    await waitFor('the greeting', () => line.said.join(' ').includes('questions about it?'));
    expect(line.said.join(' ')).toContain(
      'I’m calling about the quote we sent you for AC install. Do you have any questions about it?',
    );
  });

  it('leaves it alone when they wrote back since the reminder, or said no to the quote', async () => {
    const hal = await newCustomer(w, 'Hal');
    const first = await nudgedQuote(hal.id, 'Duct cleaning');
    await textIn(w, hal.phone, 'Still thinking about it, will let you know.');
    await runNow(w, [aiCallConsiderKey('quote', first)]);
    expect(await aiCallsOf(hal.id)).toEqual([]);

    const ida = await newCustomer(w, 'Ida');
    const second = await nudgedQuote(ida.id, 'Furnace');
    await rows(
      admin(),
      sql`update app.estimates set status = 'declined', declined_at = now() where id = ${second}`,
    );
    await runNow(w, [aiCallConsiderKey('quote', second)]);
    expect(await aiCallsOf(ida.id)).toEqual([]);
  });
});

// ---------- a call campaign (piece 4b) ----------

describe('a call campaign', () => {
  it('calls only people who agreed in writing, opens with its line, and doesn’t ask again per call', async () => {
    const { tagId } = await run(w, tagCreate, { workspaceId: w.workspaceId, name: 'Call list' });
    const listed = async (first: string, agreed: boolean) => {
      const c = await newCustomer(w, first);
      await rows(
        admin(),
        sql`insert into app.record_tags (workspace_id, tag_id, record_type, record_id)
            values (${w.workspaceId}, ${tagId}, 'person', ${c.id})`,
      );
      if (agreed)
        await run(w, personSetCallConsent, {
          workspaceId: w.workspaceId,
          personId: c.id,
          consent: 'opted_in',
          source: 'Signed service agreement',
        });
      return c;
    };
    const jo = await listed('Jo', true);
    const kim = await listed('Kim', false);

    const made = await run(w, campaignCreate, {
      workspaceId: w.workspaceId,
      name: 'Fall calls',
      goal: 'Our fall tune-up is $89 this month',
      audience: { tagIds: [tagId], stageIds: [] },
      perHour: 200,
      channel: 'call',
    });
    expect(made).toMatchObject({ recipients: 1, skipped: 1 });
    await drain(w);
    const got = await query(w, campaignGet, {
      workspaceId: w.workspaceId,
      campaignId: made.campaignId,
    });
    expect(got.campaign).toMatchObject({
      status: 'review',
      call: { opening: 'about our fall tune-up is $89 this month.', edited: false },
    });
    expect(got.recipients.find((r) => r.name.startsWith('Kim'))).toMatchObject({
      status: 'skipped',
      skipReason: 'no_call_consent',
    });
    await run(w, campaignUpdateCall, {
      workspaceId: w.workspaceId,
      campaignId: made.campaignId,
      opening: 'about our fall tune-up, which is $89 this month.',
    });

    // Approved once on the review screen: the calls don't wait for a person again, even in training.
    await setStatus(w, 'training');
    try {
      await run(w, campaignApprove, { workspaceId: w.workspaceId, campaignId: made.campaignId });
      await drain(w);
      const [call] = await aiCallsOf(jo.id);
      expect(call).toMatchObject({ status: 'calling', draft_id: null });
      expect(await aiCallsOf(kim.id)).toEqual([]);
      const placed = placedTo(jo.phone)!;
      const answered = await post(`${V}/ai-call?aiCall=${call!.id}`, {
        CallSid: placed.sid,
        From: w.number!,
        To: jo.phone,
        AnsweredBy: 'human',
      });
      const line = await dial(placed.sid, ticketIn(answered.body)!);
      await waitFor('the greeting', () => line.said.join(' ').includes('Is now a good time?'));
      expect(line.said.join(' ')).toContain(
        'I’m calling about our fall tune-up, which is $89 this month. Is now a good time?',
      );
      const brief = await asWorker(testDbs().worker.db, scope(), (tx) => callBrief(tx, call!.id));
      expect(brief).toContain('Our fall tune-up is $89 this month');

      const after = await query(w, campaignGet, {
        workspaceId: w.workspaceId,
        campaignId: made.campaignId,
      });
      expect(after.recipients.find((r) => r.name.startsWith('Jo'))).toMatchObject({
        status: 'sent',
        call: { status: 'calling' },
      });
    } finally {
      await setStatus(w, 'automatic');
    }
  });

  it('cleans the AI’s opening line, and falls back to the goal', () => {
    expect(cleanOpening('I’m calling about our spring special.')).toBe('about our spring special.');
    expect(cleanOpening('Hi there, I’m calling to let you know about X.')).toBe(
      'to let you know about X.',
    );
    expect(cleanOpening('')).toBeNull();
    expect(fallbackOpening('Spring special: 10% off.')).toBe('about spring special: 10% off.');
  });
});

describe('the words', () => {
  const config = { identity: { name: 'Ava' } } as Parameters<typeof outboundGreetingOf>[0];

  it('greets as an AI, says the call is recorded, and why', () => {
    expect(
      outboundGreetingOf(
        config,
        'Lone Star HVAC',
        'Mike',
        'about your AC tune-up tomorrow at 9:00 AM',
        'confirm_visit',
      ),
    ).toBe(
      'Hi Mike, this is Ava, an AI assistant for Lone Star HVAC. This call is recorded. I’m calling about your AC tune-up tomorrow at 9:00 AM. Does that still work for you?',
    );
    expect(outboundGreetingOf(config, 'Lone Star HVAC', null, 'back.', 'missed_call')).toBe(
      'Hi, this is Ava, an AI assistant for Lone Star HVAC. This call is recorded. I’m calling back. How can I help?',
    );
  });

  it('says when a visit is the way people do', () => {
    const now = Date.UTC(2026, 8, 24, 15, 0);
    expect(spokenWhen(new Date(Date.UTC(2026, 8, 25, 14, 0)), 'America/Chicago', now)).toBe(
      'tomorrow at 9:00 AM',
    );
    expect(spokenWhen(new Date(Date.UTC(2026, 8, 24, 20, 30)), 'America/Chicago', now)).toBe(
      'today at 3:30 PM',
    );
  });

  it('knows a voicemail box, and what to leave on one', () => {
    expect(answeredByMachine('machine_end_beep')).toBe(true);
    expect(answeredByMachine('fax')).toBe(true);
    expect(answeredByMachine('human')).toBe(false);
    expect(answeredByMachine(undefined)).toBe(false);
    expect(
      voicemailMessage({
        firstName: 'Mike',
        name: 'Ava',
        business: 'Lone Star HVAC',
        goal: 'back, since we missed your call earlier.',
        number: '+17135550100',
      }),
    ).toContain(
      'this is Ava, an AI assistant for Lone Star HVAC, calling back, since we missed your call earlier.',
    );
    expect(
      voicemailText('confirm_visit', {
        firstName: 'Mike',
        business: 'Lone Star HVAC',
        goal: 'about your AC tune-up tomorrow at 9:00 AM',
      }),
    ).toBe(
      "Hi Mike, it's Lone Star HVAC. We tried to call you about your AC tune-up tomorrow at 9:00 AM. Reply C to confirm, or let us know if you need another time.",
    );
  });
});
