/**
 * M10 step 6b, the worker with the fake carrier: calls through a person's own cell.
 * - **Confirming a cell:** the call from the business number, "Press 1", verified when 1 is pressed and not otherwise;
 *   a retried event never calls twice; a request for a phone that isn't the one called is refused.
 * - **Calling a customer:** the cell rings from the business number; "Press 1 to call Mike Johnson"; the customer is
 *   dialed from the business number, recorded on two channels, and lands in the conversation as a call answered via
 *   the bridge, with its recording and its words (or, when the provider won't transcribe it, its recording and no
 *   words, never a failed recording). Not answered, a voicemail that presses nothing, and a busy customer
 *   never reach the customer's conversation (or reach it as an unanswered call, for the busy customer). A call that
 *   waited for a worker that was down isn't placed.
 * - **Cancelling it** (step 7): the carrier's call is hung up, whether it was cancelled while ringing, before the
 *   worker placed it (nothing is ever placed), or while it was being placed (hung up once recorded); the person can
 *   call again at once, and the carrier's report afterwards changes nothing.
 * - **Business caller ID on forwarded calls:** forwarded phones see the business number and still hear who is calling.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  bridgeStatusOf,
  callCancelConnect,
  callConnectMe,
  createTokenVerifier,
  executeCommand,
  organizationCreate,
  personCreate,
  phoneNumberBuy,
  phoneNumberSetCallerId,
  phoneNumberSetRouting,
  userPhoneStartVerification,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { activities, calls, conversations, events, userPhones } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, testEnv, type TestUser } from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processDeliveries } from '../src/deliveries';
import { handlers } from '../src/handlers/index';
import { buildHttpServer } from '../src/http/server';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { processors } from '../src/processors/index';
import { jobs } from '../src/scheduled';
import { FAKE_AUTH_TOKEN, FAKE_TRANSCRIPT, fakeSid } from '../src/telephony/fake';
import { twilioSignature } from '../src/telephony/signature';
import { TEST_PUBLIC_URL, testServices, type TestServices } from './helpers';

const env = testEnv();
const WORKER_ID = `vitest-cell-${process.pid}`;
const V = '/webhooks/twilio/voice';
const MIKE = '+17135550142';
const BUSINESS_NAME = 'Cell Test HVAC';
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const tollFree = () =>
  `+1833${String(100 + Math.floor(Math.random() * 899))}${String(1001 + Math.floor(Math.random() * 8998))}`;
let seq = 0;
const cellNumber = () =>
  `+1512${String(2000000 + ((Date.now() + seq++ * 7919) % 7999999)).padStart(7, '0')}`;

let dale: TestUser;
let marco: TestUser;
let workspaceId: string;
let organizationId: string;
let mikeId: string;
let s: TestServices;
let app: FastifyInstance;
let businessNumber: string;
let numberId: string;
let accountSid: string;

async function reserve(): Promise<void> {
  for (const table of ['outbox', 'webhook_deliveries', 'scheduled_jobs'])
    await rows(
      admin(),
      sql`update ${sql.raw(`app.${table}`)} set locked_at = now(), locked_by = ${WORKER_ID}
          where status = 'pending' and workspace_id = ${workspaceId}`,
    );
}

/** Runs the outbox, webhook and job loops over this workspace's due work until it is idle. */
async function drain(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await reserve();
    const d = { ...s, workerId: WORKER_ID, batchSize: 200, reservedOnly: true };
    const passes = [
      await processOnce({ ...d, handlers }),
      await processDeliveries({ ...d, processors }),
      await processJobs({ ...d, jobs }),
    ];
    if (passes.some((p) => p.retried + p.failed > 0)) {
      const errors = await rows(
        admin(),
        sql`select 'webhook' as source, kind as what, last_error from app.webhook_deliveries
              where workspace_id = ${workspaceId} and last_error is not null and status = 'pending'
            union all select 'outbox', event_type, last_error from app.outbox
              where workspace_id = ${workspaceId} and last_error is not null and status = 'pending'
            union all select 'job', kind, last_error from app.scheduled_jobs
              where workspace_id = ${workspaceId} and last_error is not null and status = 'pending'`,
      );
      throw new Error(`worker work failed: ${JSON.stringify(errors)}`);
    }
    if (!passes.some((p) => p.claimed > 0)) return;
    if (Date.now() > deadline) throw new Error('the worker did not finish in time');
  }
}

/** Posts a webhook the way Twilio does: form-encoded, signed over the public URL (query string included). */
function post(path: string, params: Record<string, string>, opts: { signature?: string } = {}) {
  const signature =
    opts.signature ?? twilioSignature(FAKE_AUTH_TOKEN, `${TEST_PUBLIC_URL}${path}`, params);
  return app.inject({
    method: 'POST',
    url: path,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': signature,
    },
    payload: new URLSearchParams(params).toString(),
  });
}

const callRow = async (id: string) =>
  (await admin().select().from(calls).where(eq(calls.id, id)))[0]!;
const lastPlaced = () => s.telephony.calls.at(-1)!;

/** A verified cell for a person, the way the real flow leaves one. */
async function verified(u: TestUser): Promise<string> {
  const phone = cellNumber();
  const { userPhoneId } = (
    await executeCommand(
      api(),
      userPhoneStartVerification,
      { workspaceId, phone },
      actor(u),
      meta(),
    )
  ).output;
  await drain();
  const params = {
    AccountSid: accountSid,
    CallSid: lastPlaced().sid,
    From: businessNumber,
    To: phone,
  };
  await post(`${V}/verify-result?userPhoneId=${userPhoneId}`, { ...params, Digits: '1' });
  return phone;
}

/** A call through Dale's cell asked for and placed: the fake carrier's call, and the call's row. */
async function placeBridge(u: TestUser, personId = mikeId) {
  const out = (
    await executeCommand(api(), callConnectMe, { workspaceId, personId }, actor(u), meta())
  ).output;
  await drain();
  const placed = lastPlaced();
  return {
    out,
    placed,
    base: { AccountSid: accountSid, CallSid: placed.sid, From: businessNumber, To: placed.to },
  };
}

beforeAll(async () => {
  [dale, marco] = await Promise.all([
    createTestUser('cellw-dale', { fullName: 'Dale Owner' }),
    createTestUser('cellw-marco', { fullName: 'Marco Member' }),
  ]);
  const org = (
    await executeCommand(
      api(),
      organizationCreate,
      { businessName: BUSINESS_NAME },
      actor(dale),
      meta(),
    )
  ).output;
  workspaceId = org.workspaceId;
  organizationId = org.organizationId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${workspaceId}, ${marco.id}, 'member')`,
  );
  mikeId = (
    await executeCommand(
      api(),
      personCreate,
      { workspaceId, firstName: 'Mike', lastName: 'Johnson', phone: '(713) 555-0142' },
      actor(dale),
      meta(),
    )
  ).output.personId;
  s = testServices();
  app = await buildHttpServer({
    ...s,
    httpDb: testDbs().worker.db,
    verifyToken: createTokenVerifier({
      jwksUrl: `${env.supabaseUrl}/auth/v1/.well-known/jwks.json`,
      jwtIssuer: `${env.supabaseUrl}/auth/v1`,
    }),
    webOrigins: ['http://localhost:3000'],
  });
  businessNumber = tollFree();
  numberId = (
    await executeCommand(
      api(),
      phoneNumberBuy,
      { workspaceId, e164: businessNumber, numberType: 'toll_free' },
      actor(dale),
      meta(),
    )
  ).output.phoneNumberId;
  await drain();
  const [account] = await rows<{ account_sid: string }>(
    admin(),
    sql`select account_sid from app.telephony_accounts where workspace_id = ${workspaceId}`,
  );
  accountSid = account!.account_sid;
});
afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('confirming someone’s cell', () => {
  it('calls it from the business number and marks it verified when they press 1', async () => {
    const phone = cellNumber();
    const { userPhoneId } = (
      await executeCommand(
        api(),
        userPhoneStartVerification,
        { workspaceId, phone },
        actor(marco),
        meta(),
      )
    ).output;
    const before = s.telephony.calls.length;
    await drain();
    expect(s.telephony.calls).toHaveLength(before + 1);
    const placed = lastPlaced();
    expect(placed).toMatchObject({
      from: businessNumber,
      to: phone,
      answerUrl: `${TEST_PUBLIC_URL}${V}/verify?userPhoneId=${userPhoneId}`,
      statusCallbackUrl: `${TEST_PUBLIC_URL}${V}/verify-status?userPhoneId=${userPhoneId}`,
      timeoutSeconds: 30,
      accountSid,
    });
    const [row] = await admin().select().from(userPhones).where(eq(userPhones.id, userPhoneId));
    expect(row).toMatchObject({ verificationCount: 1, verifiedAt: null });

    // A retried event finds the call already placed.
    await rows(
      admin(),
      sql`update app.outbox set status = 'pending', next_attempt_at = now()
          where event_id in (select id from app.events where event_type = 'user_phone.verification_requested' and entity_id = ${userPhoneId})`,
    );
    await drain();
    expect(s.telephony.calls).toHaveLength(before + 1);

    const params = { AccountSid: accountSid, CallSid: placed.sid, From: businessNumber, To: phone };
    const answer = await post(`${V}/verify?userPhoneId=${userPhoneId}`, params);
    expect(answer.body).toContain(
      `<Gather numDigits="1" timeout="5" action="${TEST_PUBLIC_URL}${V}/verify-result?userPhoneId=${userPhoneId}" method="POST">`,
    );
    expect(answer.body).toContain('This is HandsFreeOS confirming this is your phone. Press 1.');
    expect(
      (
        await post(`${V}/verify-status?userPhoneId=${userPhoneId}`, {
          ...params,
          CallStatus: 'in-progress',
        })
      ).statusCode,
    ).toBe(204);
    const pressed = await post(`${V}/verify-result?userPhoneId=${userPhoneId}`, {
      ...params,
      Digits: '1',
    });
    expect(pressed.body).toContain('Your phone is confirmed.');
    const [done] = await admin().select().from(userPhones).where(eq(userPhones.id, userPhoneId));
    expect(done!.verifiedAt).toBeInstanceOf(Date);
  });

  it('nothing pressed, another phone, or an unsigned request confirms nothing', async () => {
    const phone = cellNumber();
    const { userPhoneId } = (
      await executeCommand(
        api(),
        userPhoneStartVerification,
        { workspaceId, phone },
        actor(dale),
        meta(),
      )
    ).output;
    await drain();
    const params = {
      AccountSid: accountSid,
      CallSid: lastPlaced().sid,
      From: businessNumber,
      To: phone,
    };
    expect(
      (await post(`${V}/verify-result?userPhoneId=${userPhoneId}`, { ...params, Digits: '' })).body,
    ).toContain('This phone isn’t confirmed.');
    expect(
      (
        await post(`${V}/verify-result?userPhoneId=${userPhoneId}`, {
          ...params,
          To: '+15125550999',
          Digits: '1',
        })
      ).body,
    ).toContain('This phone isn’t confirmed.');
    expect(
      (
        await post(
          `${V}/verify-result?userPhoneId=${userPhoneId}`,
          { ...params, Digits: '1' },
          { signature: 'bogus' },
        )
      ).statusCode,
    ).toBe(403);
    const [row] = await admin().select().from(userPhones).where(eq(userPhones.id, userPhoneId));
    expect(row!.verifiedAt).toBeNull();
  });
});

describe('calling a customer through your own cell', () => {
  it('answered and 1 pressed: the customer is dialed from the business number, recorded, and filed with its words', async () => {
    const cell = await verified(dale);
    const { out, placed, base } = await placeBridge(dale);
    expect(placed).toMatchObject({
      from: businessNumber,
      to: cell,
      answerUrl: `${TEST_PUBLIC_URL}${V}/bridge?callId=${out.callId}`,
      statusCallbackUrl: `${TEST_PUBLIC_URL}${V}/status`,
      timeoutSeconds: 25,
    });
    expect(await callRow(out.callId)).toMatchObject({ providerSid: placed.sid, status: 'ringing' });
    expect(bridgeStatusOf(await callRow(out.callId))).toBe('calling_cell');

    await post(`${V}/status`, { ...base, CallStatus: 'ringing' });
    const gate = await post(`${V}/bridge?callId=${out.callId}`, {
      ...base,
      CallStatus: 'in-progress',
    });
    expect(gate.body).toContain(
      `<Gather numDigits="1" timeout="5" action="${TEST_PUBLIC_URL}${V}/bridge-gate?callId=${out.callId}" method="POST">`,
    );
    expect(gate.body).toContain('>Press 1 to call Mike Johnson.</Say>');

    const dial = await post(`${V}/bridge-gate?callId=${out.callId}`, { ...base, Digits: '1' });
    expect(dial.body).toContain('>Calling Mike Johnson.</Say>');
    expect(dial.body).toContain(
      `<Dial callerId="${businessNumber}" answerOnBridge="true" timeout="30" action="${TEST_PUBLIC_URL}${V}/bridge-result?callId=${out.callId}" method="POST" record="record-from-answer-dual" recordingStatusCallback="${TEST_PUBLIC_URL}${V}/recording" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed absent"><Number statusCallback="${TEST_PUBLIC_URL}${V}/leg-status" statusCallbackEvent="ringing answered completed" statusCallbackMethod="POST" url="${TEST_PUBLIC_URL}${V}/notice" method="POST">${MIKE}</Number></Dial>`,
    );
    expect(await callRow(out.callId)).toMatchObject({
      answeredByUserId: dale.id,
      answeredAt: null,
    });
    expect(bridgeStatusOf(await callRow(out.callId))).toBe('calling_customer');

    const legSid = fakeSid('CA');
    const leg = (status: string, extra = {}) =>
      post(`${V}/leg-status`, {
        AccountSid: accountSid,
        CallSid: legSid,
        ParentCallSid: placed.sid,
        CallStatus: status,
        From: businessNumber,
        To: MIKE,
        ...extra,
      });
    await leg('ringing');
    await leg('in-progress');
    await drain();
    expect(bridgeStatusOf(await callRow(out.callId))).toBe('connected');
    await leg('completed', { CallDuration: '134' });
    const recordingSid = fakeSid('RE');
    await post(`${V}/recording`, {
      AccountSid: accountSid,
      CallSid: placed.sid,
      RecordingSid: recordingSid,
      RecordingStatus: 'completed',
      RecordingDuration: '134',
      RecordingChannels: '2',
      RecordingSource: 'DialVerb',
    });
    expect(
      (
        await post(`${V}/bridge-result?callId=${out.callId}`, {
          ...base,
          DialCallStatus: 'completed',
        })
      ).body,
    ).toContain('<Hangup/>');
    await post(`${V}/status`, { ...base, CallStatus: 'completed', CallDuration: '150' });
    // The transcriber answers in the same call, so the words settle in the same drain as the recording.
    await drain();

    const done = await callRow(out.callId);
    expect(done).toMatchObject({
      status: 'completed',
      answeredVia: 'bridge',
      answeredByUserId: dale.id,
      answeredNumber: MIKE,
      durationSeconds: 134,
      isVoicemail: false,
      recordingSid,
      recordingSeconds: 134,
      recordingObjectPath: `${workspaceId}/calls/${out.callId}/recording.wav`,
      transcriptStatus: 'completed',
      transcript: `Dale: ${FAKE_TRANSCRIPT[0].text}\nMike: ${FAKE_TRANSCRIPT[1].text}\nDale: ${FAKE_TRANSCRIPT[2].text}`,
    });
    expect(bridgeStatusOf(done)).toBe('ended');
    expect(await s.store.exists('telephony', done.recordingObjectPath!)).toBe(true);
    expect(s.transcriber.asked).toContain(recordingSid);
    expect(s.telephony.deleted).toContain(recordingSid);
    // Hearing the recording is the business's to pay for, each side of it counted (the stand-in's half a minute).
    const used = await rows<{ rate_key: string; quantity: string; source: string }>(
      admin(),
      sql`select rate_key, quantity::text, source from app.speech_usage where ref = ${recordingSid}`,
    );
    expect(used.map((u) => [u.rate_key, Number(u.quantity), u.source])).toEqual([
      ['speech.recording.minute', 1, 'transcript'],
    ]);
    const [entry] = await admin()
      .select()
      .from(activities)
      .where(eq(activities.id, done.activityId!));
    expect(entry).toMatchObject({
      kind: 'call',
      subtype: 'outbound',
      authorUserId: dale.id,
      body: done.transcript,
    });
    expect(entry!.meta).toMatchObject({
      answeredVia: 'bridge',
      recordingPath: done.recordingObjectPath,
    });
    const [conv] = await admin()
      .select()
      .from(conversations)
      .where(eq(conversations.id, out.conversationId));
    expect(conv!.lastPreview).toBe('Call · 2:14');
  });

  it('words the provider won’t give: the call keeps its recording, says it has no words, and the provider’s copy goes', async () => {
    const { out, placed, base } = await placeBridge(dale);
    await post(`${V}/bridge?callId=${out.callId}`, { ...base, CallStatus: 'in-progress' });
    await post(`${V}/bridge-gate?callId=${out.callId}`, { ...base, Digits: '1' });
    const leg = (status: string, extra = {}) =>
      post(`${V}/leg-status`, {
        AccountSid: accountSid,
        CallSid: `CArefusedleg${out.callId.slice(0, 8)}`,
        ParentCallSid: placed.sid,
        CallStatus: status,
        From: businessNumber,
        To: MIKE,
        ...extra,
      });
    await leg('in-progress');
    await leg('completed', { CallDuration: '41' });
    // A transcriber that will not take the work at all (the fake refuses ids with "Refused" in them).
    const recordingSid = `RERefused${out.callId.replace(/-/g, '').slice(0, 20)}`;
    const stored = await post(`${V}/recording`, {
      AccountSid: accountSid,
      CallSid: placed.sid,
      RecordingSid: recordingSid,
      RecordingStatus: 'completed',
      RecordingDuration: '41',
      RecordingChannels: '2',
      RecordingSource: 'DialVerb',
    });
    expect(stored.statusCode).toBeLessThan(300);
    await post(`${V}/status`, { ...base, CallStatus: 'completed', CallDuration: '55' });
    await drain();

    const done = await callRow(out.callId);
    expect(done).toMatchObject({
      status: 'completed',
      recordingSid,
      recordingObjectPath: `${workspaceId}/calls/${out.callId}/recording.wav`,
      transcriptStatus: 'failed',
      transcript: null,
    });
    expect(await s.store.exists('telephony', done.recordingObjectPath!)).toBe(true);
    expect(s.transcriber.asked).toContain(recordingSid);
    // The words are never coming, so the carrier's copy goes anyway rather than sitting on the bill.
    expect(s.telephony.deleted).toContain(recordingSid);
    const waiting = await rows(
      admin(),
      sql`select kind from app.scheduled_jobs
          where workspace_id = ${workspaceId} and kind like 'call.transcri%' and status = 'pending'`,
    );
    expect(waiting).toEqual([]);
  });

  it('not answered: the customer never rings and nothing lands in their conversation', async () => {
    const { out, base } = await placeBridge(dale);
    const [convBefore] = await admin()
      .select()
      .from(conversations)
      .where(eq(conversations.id, out.conversationId));
    await post(`${V}/status`, { ...base, CallStatus: 'no-answer' });
    await drain();
    const row = await callRow(out.callId);
    expect(row).toMatchObject({ status: 'no_answer', answeredByUserId: null, activityId: null });
    expect(bridgeStatusOf(row)).toBe('cell_unanswered');
    const [convAfter] = await admin()
      .select()
      .from(conversations)
      .where(eq(conversations.id, out.conversationId));
    expect(convAfter!.lastMessageAt).toEqual(convBefore!.lastMessageAt);
    const [missed] = await admin()
      .select()
      .from(events)
      .where(and(eq(events.entityId, out.callId), eq(events.eventType, 'call.bridge_unanswered')));
    expect(missed).toBeTruthy();
    // Answering after it ended places nothing.
    expect(
      (await post(`${V}/bridge?callId=${out.callId}`, { ...base, CallStatus: 'in-progress' })).body,
    ).toContain('The call wasn’t placed.');
  });

  it('a voicemail picks up and presses nothing: the customer never rings', async () => {
    const { out, base } = await placeBridge(dale);
    expect(
      (await post(`${V}/bridge?callId=${out.callId}`, { ...base, CallStatus: 'in-progress' })).body,
    ).toContain('Press 1 to call Mike Johnson.');
    const nothing = await post(`${V}/bridge-gate?callId=${out.callId}`, { ...base, Digits: '' });
    expect(nothing.body).not.toContain('<Dial');
    expect(nothing.body).toContain('The call wasn’t placed.');
    await post(`${V}/status`, { ...base, CallStatus: 'completed', CallDuration: '22' });
    await drain();
    const row = await callRow(out.callId);
    expect(row).toMatchObject({ status: 'completed', answeredByUserId: null, activityId: null });
    expect(bridgeStatusOf(row)).toBe('cell_unanswered');
  });

  it('the customer is busy: the person hears it, and the call is an unanswered one', async () => {
    const { out, placed, base } = await placeBridge(dale);
    await post(`${V}/bridge?callId=${out.callId}`, { ...base, CallStatus: 'in-progress' });
    expect(
      (await post(`${V}/bridge-gate?callId=${out.callId}`, { ...base, Digits: '1' })).body,
    ).toContain('<Dial');
    await post(`${V}/leg-status`, {
      AccountSid: accountSid,
      CallSid: fakeSid('CA'),
      ParentCallSid: placed.sid,
      CallStatus: 'busy',
      From: businessNumber,
      To: MIKE,
    });
    const said = await post(`${V}/bridge-result?callId=${out.callId}`, {
      ...base,
      DialCallStatus: 'busy',
    });
    expect(said.body).toContain('Mike Johnson’s line is busy. Try again in a few minutes.');
    await post(`${V}/status`, { ...base, CallStatus: 'completed', CallDuration: '12' });
    await drain();
    const row = await callRow(out.callId);
    expect(row).toMatchObject({ status: 'busy', answeredByUserId: dale.id, answeredAt: null });
    expect(bridgeStatusOf(row)).toBe('customer_busy');
    const [entry] = await admin()
      .select()
      .from(activities)
      .where(eq(activities.id, row.activityId!));
    expect(entry).toMatchObject({ subtype: 'outbound_missed', authorUserId: dale.id });
  });

  it('only the call HandsFreeOS placed, to that person’s verified cell, is answered', async () => {
    const { out, base } = await placeBridge(dale);
    expect(
      (await post(`${V}/bridge?callId=${out.callId}`, { ...base, To: '+15125550100' })).body,
    ).toContain('The call wasn’t placed.');
    expect((await post(`${V}/bridge?callId=${randomUUID()}`, base)).body).toContain(
      'The call wasn’t placed.',
    );
    expect(
      (await post(`${V}/bridge?callId=${out.callId}`, base, { signature: 'bogus' })).statusCode,
    ).toBe(403);
    await post(`${V}/status`, { ...base, CallStatus: 'canceled' });
    await drain();
  });

  it('a call that waited for a worker that was down isn’t placed', async () => {
    await verified(marco);
    const out = (
      await executeCommand(
        api(),
        callConnectMe,
        { workspaceId, personId: mikeId },
        actor(marco),
        meta(),
      )
    ).output;
    await admin()
      .update(calls)
      .set({ startedAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(calls.id, out.callId));
    const before = s.telephony.calls.length;
    await drain();
    expect(s.telephony.calls).toHaveLength(before);
    const row = await callRow(out.callId);
    expect(row).toMatchObject({ status: 'failed', providerSid: null });
    expect(bridgeStatusOf(row)).toBe('failed');
  });
});

describe('cancelling a call through your own cell', () => {
  const cancel = (u: TestUser, callId: string) =>
    executeCommand(api(), callCancelConnect, { workspaceId, callId }, actor(u), meta()).then(
      (r) => r.output,
    );

  it('hangs up a call still ringing the cell; the person can call again at once', async () => {
    const { out, placed, base } = await placeBridge(dale);
    expect(await cancel(dale, out.callId)).toEqual({ callId: out.callId, cancelled: true });
    await drain();
    expect(s.telephony.ended).toContain(placed.sid);
    // The carrier's report afterwards changes nothing, and answering places nothing.
    await post(`${V}/status`, { ...base, CallStatus: 'canceled' });
    await drain();
    const row = await callRow(out.callId);
    expect(row).toMatchObject({ status: 'canceled', activityId: null });
    expect(bridgeStatusOf(row)).toBe('cancelled');
    expect(
      (await post(`${V}/bridge?callId=${out.callId}`, { ...base, CallStatus: 'in-progress' })).body,
    ).toContain('The call wasn’t placed.');
    const again = await placeBridge(dale);
    expect(again.out.duplicate).toBe(false);
    expect(again.placed.sid).not.toBe(placed.sid);
    await cancel(dale, again.out.callId);
    await drain();
    expect(s.telephony.ended).toContain(again.placed.sid);
  });

  it('cancelled before the worker placed it: nothing is ever placed', async () => {
    const out = (
      await executeCommand(
        api(),
        callConnectMe,
        { workspaceId, personId: mikeId },
        actor(dale),
        meta(),
      )
    ).output;
    await cancel(dale, out.callId);
    const before = s.telephony.calls.length;
    await drain();
    expect(s.telephony.calls).toHaveLength(before);
    expect(await callRow(out.callId)).toMatchObject({ status: 'canceled', providerSid: null });
  });

  it('cancelled while it was being placed: hung up as soon as it is recorded', async () => {
    const telephony = s.telephony as { placeCall: typeof s.telephony.placeCall };
    const place = telephony.placeCall;
    let cancelledId: string | null = null;
    telephony.placeCall = async (account, request) => {
      const placed = await place(account, request);
      // The person presses Cancel while the carrier is placing it.
      const [row] = await admin()
        .select({ id: calls.id })
        .from(calls)
        .where(and(eq(calls.placedBy, dale.id), eq(calls.status, 'initiated')));
      if (row) {
        cancelledId = row.id;
        await cancel(dale, row.id);
      }
      return placed;
    };
    try {
      await executeCommand(
        api(),
        callConnectMe,
        { workspaceId, personId: mikeId },
        actor(dale),
        meta(),
      );
      await drain();
    } finally {
      telephony.placeCall = place;
    }
    expect(cancelledId).not.toBeNull();
    const row = await callRow(cancelledId!);
    expect(row.status).toBe('canceled');
    expect(row.providerSid).toBe(lastPlaced().sid);
    expect(s.telephony.ended).toContain(lastPlaced().sid);
  });
});

describe('business caller ID on forwarded calls', () => {
  it('forwarded phones see the business number and still hear who is calling', async () => {
    const CELL = '+17135550161';
    await executeCommand(
      api(),
      phoneNumberSetRouting,
      {
        workspaceId,
        phoneNumberId: numberId,
        routing: {
          forwarding: [{ e164: CELL, label: 'Dale’s cell', enabled: true }],
          ringSeconds: 20,
          voicemailEnabled: true,
          voicemailGreeting: null,
        },
      },
      actor(dale),
      meta(),
    );
    const ring = async () => {
      const res = await post(`${V}/inbound`, {
        AccountSid: accountSid,
        CallSid: fakeSid('CA'),
        From: MIKE,
        To: businessNumber,
        CallStatus: 'ringing',
      });
      await drain();
      return res.body;
    };
    const line = encodeURIComponent(businessNumber);
    const shown = await ring();
    expect(shown).toContain(`<Dial answerOnBridge="true" timeout="15"`);
    expect(shown).toContain(`url="${TEST_PUBLIC_URL}${V}/screen?line=${line}"`);

    await executeCommand(
      api(),
      phoneNumberSetCallerId,
      { workspaceId, phoneNumberId: numberId, forwardedCallerId: 'business' },
      actor(dale),
      meta(),
    );
    const business = await ring();
    expect(business).toContain(
      `<Dial answerOnBridge="true" callerId="${businessNumber}" timeout="15"`,
    );
    const screenPath = `${V}/screen?line=${line}&from=${encodeURIComponent(MIKE)}`;
    expect(business).toContain(`url="${TEST_PUBLIC_URL}${screenPath.replace('&', '&amp;')}"`);
    // The forwarded leg itself comes from the business number: the screen still says who is calling.
    const screen = await post(screenPath, {
      AccountSid: accountSid,
      CallSid: fakeSid('CA'),
      ParentCallSid: fakeSid('CA'),
      From: businessNumber,
      To: CELL,
    });
    expect(screen.body).toContain(
      `Call for ${BUSINESS_NAME} from Mike Johnson. Press 1 to take it.`,
    );
    expect(organizationId).toBeTruthy();
  });
});
