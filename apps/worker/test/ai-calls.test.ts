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
 *   once, each call goes without a draft, even while the teammate trains; one that keeps adding people (part 4)
 *   calls whoever comes to fit and agrees, and finishes once it's turned off;
 * - a workflow's "AI teammate calls them" (part 2): only someone who agreed in writing, with the step's opening and
 *   playbook, and a call still waiting for an OK isn't made once they've written in since;
 * - a call to a lead (part 3) waits for the calling hours where they are, and rings again the next day when nobody
 *   answers or a voicemail box does, up to 3 times, then texts as the business chose;
 * - with Call business landlines without a yes on (part 5), a call to someone with no yes goes only once the phone
 *   company says their number is a business's landline (or it's a company's number here), each ask charged once.
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
  campaignPreviewAudience,
  campaignSetKeepAdding,
  campaignUpdateCall,
  defaultAutomationSettings,
  estimateCreate,
  executeCommand,
  leadCreate,
  personSetCallConsent,
  tagCreate,
  type AutomationSettings,
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
  queueAiCall,
  RETRY_AFTER_MS,
  spokenWhen,
  voicemailText,
} from '../src/ai-calls/index';
import {
  campaignSendKey,
  cleanOpening,
  fallbackOpening,
  KEEP_ADDING_LOOK_MS,
} from '../src/automations/campaigns';
import { recordSystemEvent } from '../src/system-event';
import { scriptedAi } from '../src/ai/scripted';
import { answeredByMachine, voicemailMessage } from '../src/http/ai-calls';
import { buildHttpServer } from '../src/http/server';
import { processJobs } from '../src/jobs';
import { jobs } from '../src/scheduled';
import { systemActor, workerMeta } from '../src/services';
import { FAKE_AUTH_TOKEN, fakeSid, type FakeTelephony } from '../src/telephony/fake';
import { twilioSignature } from '../src/telephony/signature';
import { outboundGreetingOf } from '../src/voice-agent/prompt';
import { openTicket } from '../src/voice-agent/ticket';
import { TEST_PUBLIC_URL } from './helpers';
import { addWorkflow, runsOf, sid, stepOf } from './workflow-world';
import {
  admin,
  at,
  drain,
  hh,
  hourNow,
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
  await saveAutomations();
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

/** The suite's automations: every AI call switched on, and the calls settings as given (the defaults otherwise). */
async function saveAutomations(calls: Partial<AutomationSettings['calls']> = {}) {
  const s = defaultAutomationSettings();
  const switches = { callConfirmVisits: true, callBackMissed: true, callQuotes: true };
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
/** Every call the carrier was asked to place to this number, in order. */
const allPlacedTo = (to: string) => telephony().calls.filter((c) => c.to === to);

/**
 * Runs a call's place job as of `asOf` (default: when it's due). A call to a lead waits for the calling hours where
 * the lead is (Houston's, for these numbers), which the hour the suite runs at may not be in. Nothing when no place
 * job waits.
 */
async function placeAt(aiCallId: string, asOf?: number) {
  await runJobAt(aiCallPlaceKey(aiCallId), asOf);
}

/** Runs the pending job with this key now, with this test's carrier and speech (as of `asOf`, or when it was due). */
async function runJobAt(key: string, asOf?: number) {
  const [job] = await rows<{ run_at: Date }>(
    admin(),
    sql`select run_at from app.scheduled_jobs
        where dedupe_key = ${key} and workspace_id = ${w.workspaceId} and status = 'pending'`,
  );
  if (!job) return;
  const due = asOf ?? Math.max(Date.now(), new Date(job.run_at).getTime());
  const runner = `place-${w.workerId}`;
  await rows(
    admin(),
    sql`update app.scheduled_jobs set run_at = now(), locked_at = now(), locked_by = ${runner}
        where dedupe_key = ${key} and workspace_id = ${w.workspaceId} and status = 'pending'`,
  );
  await processJobs({
    ...w.s,
    jobs,
    workerId: runner,
    batchSize: 5,
    reservedOnly: true,
    clock: () => due,
  });
  await drain(w);
}

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
    // Quiet from the hour before this one to two hours on, past midnight too: it waits.
    await setQuietHours(w, { start: hh(hourNow() - 1), end: hh(hourNow() + 2) });
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
      await placeAt((await aiCallsOf(jo.id))[0]!.id);
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

  it('keeps adding people: whoever comes to fit and agrees is called, until it’s turned off', async () => {
    const { tagId } = await run(w, tagCreate, { workspaceId: w.workspaceId, name: 'Every lead' });
    const made = await run(w, campaignCreate, {
      workspaceId: w.workspaceId,
      name: 'Every new lead',
      goal: 'The quote you asked us for',
      audience: { tagIds: [tagId], stageIds: [] },
      perHour: 200,
      channel: 'call',
      keepAdding: true,
    });
    expect(made).toMatchObject({ recipients: 0, skipped: 0 });
    await drain(w);
    await run(w, campaignApprove, { workspaceId: w.workspaceId, campaignId: made.campaignId });
    await drain(w);
    const get = () =>
      query(w, campaignGet, { workspaceId: w.workspaceId, campaignId: made.campaignId });
    // Nobody yet: it keeps going, and looks again within the hour.
    const waiting = await get();
    expect(waiting.campaign).toMatchObject({ status: 'sending', keepAdding: true });
    expect(new Date(waiting.nextSendAt!).getTime()).toBeGreaterThan(
      Date.now() + KEEP_ADDING_LOOK_MS - 5 * 60_000,
    );

    // Lee gets the tag, then agrees to calls in writing: Lee joins at once and is called.
    const lee = await newCustomer(w, 'Lee');
    await rows(
      admin(),
      sql`insert into app.record_tags (workspace_id, tag_id, record_type, record_id)
          values (${w.workspaceId}, ${tagId}, 'person', ${lee.id})`,
    );
    await drain(w);
    expect((await get()).recipients).toEqual([]);
    await run(w, personSetCallConsent, {
      workspaceId: w.workspaceId,
      personId: lee.id,
      consent: 'opted_in',
      source: 'Website form',
    });
    await drain(w);
    const [call] = await aiCallsOf(lee.id);
    expect(call).toBeDefined();
    const joined = await get();
    expect(joined.campaign.status).toBe('sending');
    expect(joined.recipients).toEqual([
      expect.objectContaining({ personId: lee.id, status: 'sent' }),
    ]);

    // Off, it finishes once everyone it has is called.
    await run(w, campaignSetKeepAdding, {
      workspaceId: w.workspaceId,
      campaignId: made.campaignId,
      on: false,
    });
    await drain(w);
    await runJobAt(campaignSendKey(made.campaignId));
    expect((await get()).campaign).toMatchObject({ status: 'done', keepAdding: false });
    expect(await aiCallsOf(lee.id)).toHaveLength(1);
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

describe('a workflow’s call (AI calls, part 2)', () => {
  const stepId = sid('call');
  let workflowId: string;
  beforeAll(async () => {
    const wf = await addWorkflow(w, 'Speed to lead by phone', {
      version: 1,
      trigger: { kind: 'event', event: 'lead.created' },
      steps: [
        {
          id: stepId,
          type: 'action',
          action: 'call_with_ai',
          config: {
            opening: 'I’m calling about the {{lead.title}} request you just sent us',
            findOut: 'Which rooms, and how soon.',
            offer: 'A free estimate.',
            book: 'always',
          },
        },
      ],
      settings: {},
    });
    workflowId = wf.id;
  });

  const agreed = (personId: string) =>
    run(w, personSetCallConsent, {
      workspaceId: w.workspaceId,
      personId,
      consent: 'opted_in',
      source: 'Form: Get a quote',
    });
  const newLead = async (personId: string, title: string) => {
    await run(w, leadCreate, { workspaceId: w.workspaceId, title, personId });
    await drain(w);
    const run1 = (await runsOf(workflowId)).find((r) => r.person_id === personId)!;
    return stepOf(run1.id, stepId);
  };

  it('calls a new lead who agreed, with the step’s opening and playbook, and skips one who didn’t', async () => {
    const ann = await newCustomer(w, 'Ann');
    await agreed(ann.id);
    const step = await newLead(ann.id, 'carpet cleaning');
    await placeAt((await aiCallsOf(ann.id))[0]!.id);
    const [call] = await aiCallsOf(ann.id);
    expect(step).toMatchObject({
      status: 'done',
      output: { aiCallId: call!.id, waitsForApproval: false },
    });
    expect(call).toMatchObject({ status: 'calling', draft_id: null });
    const placed = placedTo(ann.phone)!;
    const answered = await post(`${V}/ai-call?aiCall=${call!.id}`, {
      CallSid: placed.sid,
      From: w.number!,
      To: ann.phone,
      AnsweredBy: 'human',
    });
    const line = await dial(placed.sid, ticketIn(answered.body)!);
    await waitFor('the greeting', () => line.said.join(' ').includes('Is now a good time?'));
    expect(line.said.join(' ')).toContain(
      'I’m calling about the carpet cleaning request you just sent us. Is now a good time?',
    );
    const brief = await asWorker(testDbs().worker.db, scope(), (tx) => callBrief(tx, call!.id));
    expect(brief).toContain('What to find out: Which rooms, and how soon.');
    expect(brief).toContain('What you may offer, and nothing more: A free estimate.');
    expect(brief).toContain('Ask if they’d like to book a visit');

    const bo = await newCustomer(w, 'Bo');
    expect(await newLead(bo.id, 'rugs')).toMatchObject({
      status: 'skipped',
      output: expect.objectContaining({ skipped: 'no_call_consent' }),
    });
    expect(await aiCallsOf(bo.id)).toEqual([]);
  });

  it('while training, waits for an OK, and leaves them alone once they’ve written in since', async () => {
    await setStatus(w, 'training');
    try {
      const cy = await newCustomer(w, 'Cy');
      await agreed(cy.id);
      expect(await newLead(cy.id, 'stairs')).toMatchObject({
        status: 'done',
        output: expect.objectContaining({ waitsForApproval: true }),
      });
      const [waiting] = await aiCallsOf(cy.id);
      expect(waiting).toMatchObject({ status: 'awaiting_approval' });
      await textIn(w, cy.phone, 'Actually, can you text me a price instead?');
      await drain(w);
      await run(w, aiTeammateDecideDraft, {
        workspaceId: w.workspaceId,
        draftId: waiting!.draft_id!,
        decision: 'approve',
      });
      await drain(w);
      expect((await aiCallsOf(cy.id))[0]).toMatchObject({
        status: 'skipped',
        reason: 'in_touch_since',
      });
      expect(placedTo(cy.phone)).toBeUndefined();
    } finally {
      await setStatus(w, 'automatic');
    }
  });
});

// ---------- calls to leads: their hours, and trying again (part 3) ----------

describe('a call to a lead (AI calls, part 3)', () => {
  const utc = (when: string) => new Date(when).getTime();
  // These numbers are Houston's: Texas calls from 9 AM, and from noon on Sundays, Central time.
  const WEDNESDAY_NOON = utc('2026-11-04T18:00:00Z');
  const SUNDAY_10AM = utc('2026-11-08T16:00:00Z');
  const day = (n: number) => WEDNESDAY_NOON + n * RETRY_AFTER_MS;

  /** A lead who agreed to calls and texts in writing, and the workflow's call to them, queued. */
  async function queuedCall(first: string) {
    const lead = await newCustomer(w, first);
    await run(w, personSetCallConsent, {
      workspaceId: w.workspaceId,
      personId: lead.id,
      consent: 'opted_in',
      source: 'Form: Get a quote',
    });
    await rows(
      admin(),
      sql`update app.people set sms_consent = 'opted_in'::app.sms_consent where id = ${lead.id}`,
    );
    const made = await asWorker(testDbs().worker.db, scope(), (tx) =>
      queueAiCall(
        tx,
        scope(),
        {
          purpose: 'workflow',
          personId: lead.id,
          to: lead.phone,
          goal: 'about the window cleaning request you just sent us.',
          playbook: { findOut: '', offer: '', book: 'never' },
          dedupeKey: `part3:${lead.id}`,
        },
        crypto.randomUUID(),
      ),
    );
    return { ...lead, aiCallId: made!.id };
  }

  const placeJobAt = async (aiCallId: string) => {
    const [job] = await rows<{ run_at: Date }>(
      admin(),
      sql`select run_at from app.scheduled_jobs
          where dedupe_key = ${aiCallPlaceKey(aiCallId)} and status = 'pending'`,
    );
    return job ? new Date(job.run_at).getTime() : null;
  };
  const tries = async (aiCallId: string) => {
    const [c] = await rows<{ tries: number }>(
      admin(),
      sql`select tries from app.ai_calls where id = ${aiCallId}`,
    );
    return c!.tries;
  };

  /** The carrier says nobody picked up the call it's ringing now. */
  async function noAnswer(personId: string) {
    const [c] = await aiCallsOf(personId);
    await executeCommand(
      testDbs().worker.db,
      callUpdateStatus,
      { workspaceId: w.workspaceId, callId: c!.call_id!, status: 'no_answer' },
      systemActor(scope()),
      workerMeta(),
    );
    await drain(w);
  }

  it('waits for the calling hours where the lead is, narrowed by the business’s own', async () => {
    const dot = await queuedCall('Dot');
    // Sunday 10 AM in Houston: Texas calls from noon.
    await placeAt(dot.aiCallId, SUNDAY_10AM);
    expect((await aiCallsOf(dot.id))[0]).toMatchObject({ status: 'queued' });
    expect(new Date((await placeJobAt(dot.aiCallId))!).toISOString()).toBe(
      '2026-11-08T18:00:00.000Z',
    );
    expect(placedTo(dot.phone)).toBeUndefined();

    // Weekdays only: Monday at 9 AM, Houston time.
    await saveAutomations({ hours: { start: '08:00', end: '21:00', weekends: false } });
    try {
      await placeAt(dot.aiCallId, utc('2026-11-08T18:00:00Z'));
      expect(new Date((await placeJobAt(dot.aiCallId))!).toISOString()).toBe(
        '2026-11-09T15:00:00.000Z',
      );
      expect(placedTo(dot.phone)).toBeUndefined();
    } finally {
      await saveAutomations();
    }
    await placeAt(dot.aiCallId, utc('2026-11-09T15:00:00Z'));
    expect((await aiCallsOf(dot.id))[0]).toMatchObject({ status: 'calling' });
    expect(placedTo(dot.phone)).toBeDefined();
  });

  it('rings again the next day when nobody answers, hangs up on a voicemail box before the last try, then texts', async () => {
    const eli = await queuedCall('Eli');
    await placeAt(eli.aiCallId, WEDNESDAY_NOON);
    expect(await tries(eli.aiCallId)).toBe(1);

    // Nobody answers: it tries again tomorrow, and says so.
    const before = Date.now();
    await noAnswer(eli.id);
    expect((await aiCallsOf(eli.id))[0]).toMatchObject({
      status: 'queued',
      outcome: 'no_answer',
      summary: 'Nobody answered; it tries again tomorrow.',
    });
    const next = (await placeJobAt(eli.aiCallId))!;
    expect(next).toBeGreaterThanOrEqual(before + RETRY_AFTER_MS);
    expect(next).toBeLessThanOrEqual(Date.now() + RETRY_AFTER_MS);

    // The second try: a voicemail box answers, and it just hangs up. No text yet.
    await placeAt(eli.aiCallId, day(1));
    expect((await aiCallsOf(eli.id))[0]).toMatchObject({
      status: 'calling',
      outcome: null,
      summary: null,
    });
    const second = allPlacedTo(eli.phone);
    expect(second).toHaveLength(2);
    const answered = await post(`${V}/ai-call?aiCall=${eli.aiCallId}`, {
      CallSid: second[1]!.sid,
      From: w.number!,
      To: eli.phone,
      AnsweredBy: 'machine_end_beep',
    });
    expect(answered.body).toContain('<Hangup/>');
    expect(answered.body).not.toContain('<Say');
    await drain(w);
    expect((await aiCallsOf(eli.id))[0]).toMatchObject({ status: 'queued', outcome: 'voicemail' });
    expect(textsTo(w, eli.phone)).toEqual([]);

    // The last try: nobody answers, so it's done, and the text the business chose goes.
    await placeAt(eli.aiCallId, day(2));
    expect(allPlacedTo(eli.phone)).toHaveLength(3);
    await noAnswer(eli.id);
    expect((await aiCallsOf(eli.id))[0]).toMatchObject({
      status: 'done',
      outcome: 'no_answer',
      summary: 'Nobody picked up on any of its 3 tries.',
    });
    expect(await placeJobAt(eli.aiCallId)).toBeNull();
    expect(textsTo(w, eli.phone).map((t) => t.body)).toEqual([
      expect.stringContaining(
        'We tried to call you about the window cleaning request you just sent us. Just reply here',
      ),
    ]);
  });

  it('tries once when the business says so, and not again once they’ve been in touch', async () => {
    await saveAutomations({ tries: 1, voicemail: 'hang_up' });
    try {
      const fin = await queuedCall('Fin');
      await placeAt(fin.aiCallId, WEDNESDAY_NOON);
      await noAnswer(fin.id);
      expect((await aiCallsOf(fin.id))[0]).toMatchObject({ status: 'done', outcome: 'no_answer' });
      expect(textsTo(w, fin.phone)).toEqual([]);
    } finally {
      await saveAutomations();
    }

    const flo = await queuedCall('Flo');
    await placeAt(flo.aiCallId, WEDNESDAY_NOON);
    await noAnswer(flo.id);
    await textIn(w, flo.phone, 'Sorry I missed you, can you call after 5?');
    await drain(w);
    await placeAt(flo.aiCallId, day(1));
    expect((await aiCallsOf(flo.id))[0]).toMatchObject({
      status: 'skipped',
      reason: 'in_touch_since',
    });
    expect(allPlacedTo(flo.phone)).toHaveLength(1);
  });
});

// ---------- business landlines with no yes (part 5) ----------

describe('a business landline with no yes (AI calls, part 5)', () => {
  // Houston's numbers: a Wednesday at noon there is inside every calling hour.
  const WEDNESDAY_NOON = new Date('2026-11-04T18:00:00Z').getTime();

  /** Someone who never said yes or no to calls, and a workflow's call to them, queued. */
  async function queuedCall(first: string) {
    const lead = await newCustomer(w, first);
    const made = await asWorker(testDbs().worker.db, scope(), (tx) =>
      queueAiCall(
        tx,
        scope(),
        {
          purpose: 'workflow',
          personId: lead.id,
          to: lead.phone,
          goal: 'about the office cleaning quote you asked for.',
          playbook: { findOut: '', offer: '', book: 'never' },
          dedupeKey: `part5:${lead.id}:${crypto.randomUUID()}`,
        },
        crypto.randomUUID(),
      ),
    );
    return { ...lead, aiCallId: made!.id };
  }
  const checksOf = (phone: string) => telephony().lineChecks.filter((c) => c.e164 === phone);
  const chargesFor = (phone: string) =>
    rows<{ rate_key: string; amount_cents: string }>(
      admin(),
      sql`select rate_key, amount_cents::text from app.usage_ledger
          where workspace_id = ${w.workspaceId} and meta->>'e164' = ${phone} order by rate_key`,
    );
  const callOf = async (aiCallId: string) => {
    const [c] = await rows<{ status: string; reason: string | null; consent_basis: string | null }>(
      admin(),
      sql`select status, reason, consent_basis from app.ai_calls where id = ${aiCallId}`,
    );
    return c!;
  };

  beforeAll(() => saveAutomations({ businessLandlines: true }));
  afterAll(() => saveAutomations());

  it('calls a business’s landline once the phone company says so, and charges each ask', async () => {
    const lia = await queuedCall('Lia');
    telephony().lines.set(lia.phone, { lineType: 'landline', callerType: 'BUSINESS' });
    await placeAt(lia.aiCallId, WEDNESDAY_NOON);
    expect(await callOf(lia.aiCallId)).toMatchObject({
      status: 'calling',
      consent_basis: 'business_landline',
    });
    expect(placedTo(lia.phone)).toBeDefined();
    expect(checksOf(lia.phone)).toEqual([
      { e164: lia.phone, lineType: true, callerName: false },
      { e164: lia.phone, lineType: false, callerName: true },
    ]);
    expect(await chargesFor(lia.phone)).toEqual([
      { rate_key: 'lookup.caller_name', amount_cents: '-2' },
      { rate_key: 'lookup.line_type', amount_cents: '-2' },
    ]);
    const [kept] = await rows<{ line_type: string; caller_type: string | null }>(
      admin(),
      sql`select line_type, caller_type from app.phone_line_checks
          where workspace_id = ${w.workspaceId} and phone_e164 = ${lia.phone}`,
    );
    expect(kept).toEqual({ line_type: 'landline', caller_type: 'business' });
  });

  it('leaves a mobile or a home landline alone, and asks only what it doesn’t know yet', async () => {
    // A mobile: the line type is enough, and no caller name is paid for.
    const mo = await queuedCall('Mo');
    await placeAt(mo.aiCallId, WEDNESDAY_NOON);
    expect(await callOf(mo.aiCallId)).toMatchObject({
      status: 'skipped',
      reason: 'not_business_landline',
    });
    expect(placedTo(mo.phone)).toBeUndefined();
    expect(checksOf(mo.phone)).toEqual([{ e164: mo.phone, lineType: true, callerName: false }]);

    // Another call to the same number goes by what's kept: nothing is asked again.
    const again = await asWorker(testDbs().worker.db, scope(), (tx) =>
      queueAiCall(
        tx,
        scope(),
        {
          purpose: 'workflow',
          personId: mo.id,
          to: mo.phone,
          goal: 'about your quote.',
          playbook: { findOut: '', offer: '', book: 'never' },
          dedupeKey: `part5-again:${mo.id}`,
        },
        crypto.randomUUID(),
      ),
    );
    await placeAt(again!.id, WEDNESDAY_NOON);
    expect(await callOf(again!.id)).toMatchObject({ reason: 'not_business_landline' });
    expect(checksOf(mo.phone)).toHaveLength(1);

    // A landline registered to a person.
    const hal = await queuedCall('Hal');
    telephony().lines.set(hal.phone, { lineType: 'landline', callerType: 'CONSUMER' });
    await placeAt(hal.aiCallId, WEDNESDAY_NOON);
    expect(await callOf(hal.aiCallId)).toMatchObject({ reason: 'not_business_landline' });
    expect(checksOf(hal.phone)).toHaveLength(2);
  });

  it('takes a company’s own number here as a business’s, and needs the yes once it’s off', async () => {
    const cy = await queuedCall('Cy');
    await rows(
      admin(),
      sql`insert into app.companies (workspace_id, name, phone_e164)
          values (${w.workspaceId}, 'Cy’s Office Supply', ${cy.phone})`,
    );
    telephony().lines.set(cy.phone, { lineType: 'landline', callerType: 'UNDETERMINED' });
    await placeAt(cy.aiCallId, WEDNESDAY_NOON);
    expect(await callOf(cy.aiCallId)).toMatchObject({
      status: 'calling',
      consent_basis: 'business_landline',
    });
    expect(checksOf(cy.phone)).toEqual([{ e164: cy.phone, lineType: true, callerName: false }]);

    await saveAutomations();
    try {
      const dee = await queuedCall('Dee');
      telephony().lines.set(dee.phone, { lineType: 'landline', callerType: 'BUSINESS' });
      await placeAt(dee.aiCallId, WEDNESDAY_NOON);
      expect(await callOf(dee.aiCallId)).toMatchObject({
        status: 'skipped',
        reason: 'no_call_consent',
      });
      expect(checksOf(dee.phone)).toEqual([]);
    } finally {
      await saveAutomations({ businessLandlines: true });
    }
  });

  it('a call campaign counts who waits on the check, and leaves out who isn’t a business landline', async () => {
    const { tagId } = await run(w, tagCreate, { workspaceId: w.workspaceId, name: 'Offices' });
    const tagged = async (first: string) => {
      const c = await newCustomer(w, first);
      await rows(
        admin(),
        sql`insert into app.record_tags (workspace_id, tag_id, record_type, record_id)
            values (${w.workspaceId}, ${tagId}, 'person', ${c.id})`,
      );
      return c;
    };
    const kay = await tagged('Kay');
    const ned = await tagged('Ned');
    // Ned's number was checked last week: a mobile.
    await rows(
      admin(),
      sql`insert into app.phone_line_checks (workspace_id, phone_e164, line_type, checked_at)
          values (${w.workspaceId}, ${ned.phone}, 'mobile', now() - interval '7 days')`,
    );
    const audience = { tagIds: [tagId], stageIds: [] };
    const preview = await query(w, campaignPreviewAudience, {
      workspaceId: w.workspaceId,
      audience,
      channel: 'call',
    });
    // What checking Kay's number could cost, before it starts: the line, and who owns it if it's a landline.
    expect(preview).toMatchObject({
      recipients: 1,
      landlineChecks: 1,
      landlineCheckCents: { line: 2, owner: 2, upTo: 4 },
      skipped: { not_business_landline: 1 },
    });

    const made = await run(w, campaignCreate, {
      workspaceId: w.workspaceId,
      name: 'Office calls',
      goal: 'Our office cleaning special this month',
      audience,
      perHour: 200,
      channel: 'call',
    });
    await drain(w);
    await run(w, campaignApprove, { workspaceId: w.workspaceId, campaignId: made.campaignId });
    await drain(w);
    // Kay's number turns out to be a mobile: left out, saying why, and never rung.
    const [call] = await aiCallsOf(kay.id);
    await placeAt(call!.id, WEDNESDAY_NOON);
    expect(placedTo(kay.phone)).toBeUndefined();
    const got = await query(w, campaignGet, {
      workspaceId: w.workspaceId,
      campaignId: made.campaignId,
    });
    expect(got.recipients.find((r) => r.personId === kay.id)).toMatchObject({
      status: 'skipped',
      skipReason: 'not_business_landline',
    });
    expect(got.recipients.find((r) => r.personId === ned.id)).toMatchObject({
      status: 'skipped',
      skipReason: 'not_business_landline',
    });
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
