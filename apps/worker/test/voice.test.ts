import { createHmac, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  callStart,
  createTokenVerifier,
  executeCommand,
  organizationCreate,
  personCreate,
  phoneNumberBuy,
  phoneNumberSetRouting,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import {
  activities,
  calls,
  conversations,
  telephonyAccounts,
  webhookDeliveries,
} from '@hfos/db/schema';
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
import { processDeliveries } from '../src/deliveries';
import { handlers } from '../src/handlers/index';
import { buildHttpServer } from '../src/http/server';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { processors } from '../src/processors/index';
import { jobs } from '../src/scheduled';
import { FAKE_AUTH_TOKEN, FAKE_VOICE_KEY_SECRET, fakeSid } from '../src/telephony/fake';
import { twilioSignature } from '../src/telephony/signature';
import { identityOf } from '../src/telephony/voice';
import { TEST_PUBLIC_URL, testServices, type TestServices } from './helpers';

const env = testEnv();
const WORKER_ID = `vitest-voice-${process.pid}`;
const V = '/webhooks/twilio/voice';
const MIKE = '+17135550142';
const CELL = '+17135550161';
const OFFICE = '+17135550102';
const BUSINESS_NAME = 'Voice Test HVAC';
const WORDS = 'Hey, it’s Mike on Main Street. The AC upstairs is blowing warm air again.';
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
/** A toll-free number nobody else holds; the fake carrier refuses numbers ending in 0000. */
const tollFree = () =>
  `+1833${String(100 + Math.floor(Math.random() * 899))}${String(1001 + Math.floor(Math.random() * 8998))}`;

let owner: TestUser;
let member: TestUser;
let outsider: TestUser;
let workspaceId: string;
let mikeId: string;
let s: TestServices;
let app: FastifyInstance;
let businessNumber: string;
let accountSid: string;

/** Locks this workspace's pending work for this suite's worker id: no other poller or suite takes it. */
async function reserve(): Promise<void> {
  for (const table of ['outbox', 'webhook_deliveries', 'scheduled_jobs'])
    await rows(
      admin(),
      sql`update ${sql.raw(`app.${table}`)} set locked_at = now(), locked_by = ${WORKER_ID}
          where status = 'pending' and workspace_id = ${workspaceId}`,
    );
}

const loopDeps = () => ({ ...s, workerId: WORKER_ID, batchSize: 200, reservedOnly: true });

/** Runs the outbox, webhook and job loops over this workspace's due work until it is idle. */
async function drain(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await reserve();
    const d = loopDeps();
    const passes = [
      await processOnce({ ...d, handlers }),
      await processDeliveries({ ...d, processors }),
      await processJobs({ ...d, jobs }),
    ];
    if (passes.some((p) => p.retried + p.failed > 0)) {
      const errors = await rows(
        admin(),
        sql`select kind as what, last_error from app.webhook_deliveries
              where workspace_id = ${workspaceId} and last_error is not null and status = 'pending'
            union all select event_type, last_error from app.outbox
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

const callRow = async (sid: string) =>
  (await admin().select().from(calls).where(eq(calls.providerSid, sid)))[0];

/** Mike calls the business number; returns the TwiML and files the call. */
async function ringIn(sid: string, from = MIKE) {
  const res = await post(`${V}/inbound`, {
    AccountSid: accountSid,
    CallSid: sid,
    From: from,
    To: businessNumber,
    CallStatus: 'ringing',
    Direction: 'inbound',
  });
  expect(res.statusCode).toBe(200);
  await drain();
  return res.body;
}

/** One leg of Mike's call reports in. */
const leg = (parent: string, legSid: string, to: string, status: string, extra = {}) =>
  post(`${V}/leg-status`, {
    AccountSid: accountSid,
    CallSid: legSid,
    ParentCallSid: parent,
    CallStatus: status,
    From: MIKE,
    To: to,
    Direction: 'outbound-dial',
    ...extra,
  });

beforeAll(async () => {
  [owner, member, outsider] = await Promise.all([
    createTestUser('voice-owner'),
    createTestUser('voice-member'),
    createTestUser('voice-outsider'),
  ]);
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: BUSINESS_NAME },
    actor(owner),
    meta(),
  );
  workspaceId = output.workspaceId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${workspaceId}, ${member.id}, 'member')`,
  );
  mikeId = (
    await executeCommand(
      api(),
      personCreate,
      { workspaceId, firstName: 'Mike', lastName: 'Johnson', phone: '(713) 555-0142' },
      actor(owner),
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
  const bought = await executeCommand(
    api(),
    phoneNumberBuy,
    { workspaceId, e164: businessNumber, numberType: 'toll_free' },
    actor(owner),
    meta(),
  );
  await drain();
  const [account] = await admin()
    .select()
    .from(telephonyAccounts)
    .where(eq(telephonyAccounts.workspaceId, workspaceId));
  accountSid = account!.accountSid!;
  await executeCommand(
    api(),
    phoneNumberSetRouting,
    {
      workspaceId,
      phoneNumberId: bought.output.phoneNumberId,
      routing: {
        forwarding: [
          { e164: CELL, label: 'Dale’s cell', enabled: true },
          { e164: OFFICE, label: 'Office line', enabled: false },
        ],
        ringSeconds: 20,
        voicemailEnabled: true,
        voicemailGreeting: null,
      },
    },
    actor(owner),
    meta(),
  );
  await drain();
});
afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('browser calling', () => {
  it('buying a number sets up browser calls: an API key (sealed) and a TwiML app', async () => {
    const [account] = await admin()
      .select()
      .from(telephonyAccounts)
      .where(eq(telephonyAccounts.workspaceId, workspaceId));
    expect(account).toMatchObject({ status: 'active' });
    expect(account!.apiKeySid).toMatch(/^SKfake/);
    expect(account!.twimlAppSid).toMatch(/^APfake/);
    expect(account!.apiKeySecretEnc).toBeTruthy();
    expect(account!.apiKeySecretEnc).not.toContain(FAKE_VOICE_KEY_SECRET);
  });

  it('signs a one-hour token for teammates who use the inbox, and refuses everyone else', async () => {
    const path = '/v1/telephony/voice-token';
    const body = { workspaceId };
    expect((await app.inject({ method: 'POST', url: path, payload: body })).statusCode).toBe(401);
    const asOutsider = await app.inject({
      method: 'POST',
      url: path,
      payload: body,
      headers: { authorization: `Bearer ${await signInTestUser(outsider)}` },
    });
    expect(asOutsider.statusCode).toBe(403);
    const res = await app.inject({
      method: 'POST',
      url: path,
      payload: body,
      headers: { authorization: `Bearer ${await signInTestUser(member)}` },
    });
    expect(res.statusCode).toBe(200);
    const got = res.json() as { token: string; identity: string; expiresAt: string };
    expect(got).toMatchObject({
      identity: identityOf(member.id),
      callerId: businessNumber,
      provider: 'fake',
    });
    const [head, payload, signature] = got.token.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(head, 'base64url').toString())).toEqual({
      alg: 'HS256',
      typ: 'JWT',
      cty: 'twilio-fpa;v=1',
    });
    const [account] = await admin()
      .select()
      .from(telephonyAccounts)
      .where(eq(telephonyAccounts.workspaceId, workspaceId));
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      iss: string;
      sub: string;
      iat: number;
      exp: number;
      grants: unknown;
    };
    expect(claims).toMatchObject({
      iss: account!.apiKeySid,
      sub: accountSid,
      grants: {
        identity: identityOf(member.id),
        voice: {
          incoming: { allow: true },
          outgoing: { application_sid: account!.twimlAppSid },
        },
      },
    });
    expect(claims.exp - claims.iat).toBe(3600);
    expect(signature).toBe(
      createHmac('sha256', FAKE_VOICE_KEY_SECRET).update(`${head}.${payload}`).digest('base64url'),
    );
  });
});

describe('a customer calls', () => {
  it('rings every teammate and the enabled forwarding phone, then files the call under Mike', async () => {
    const sid = fakeSid('CA');
    const body = await ringIn(sid);
    expect(body).toContain(
      `<Dial answerOnBridge="true" timeout="15" action="${TEST_PUBLIC_URL}${V}/dial-result" method="POST">`,
    );
    expect(body).toContain(`<Identity>${identityOf(owner.id)}</Identity>`);
    expect(body).toContain(`<Identity>${identityOf(member.id)}</Identity>`);
    expect(body).toContain('<Parameter name="callerName" value="Mike Johnson"/>');
    expect(body).toContain('<Parameter name="alsoRinging" value="Dale’s cell"/>');
    expect(body).toContain(
      `<Number url="${TEST_PUBLIC_URL}${V}/screen?line=${encodeURIComponent(businessNumber)}" method="POST"`,
    );
    expect(body).toContain(`>${CELL}</Number>`);
    expect(body).not.toContain(OFFICE);
    const call = await callRow(sid);
    expect(call).toMatchObject({ direction: 'inbound', status: 'ringing', personId: mikeId });
    expect(call!.conversationId).toBeTruthy();
  });

  it('refuses a mis-signed call and stores nothing', async () => {
    const sid = fakeSid('CA');
    const res = await post(
      `${V}/inbound`,
      { AccountSid: accountSid, CallSid: sid, From: MIKE, To: businessNumber },
      { signature: 'bogus' },
    );
    expect(res.statusCode).toBe(403);
    const stored = await rows(
      admin(),
      sql`select 1 from app.webhook_deliveries where dedupe_key like ${`${sid}%`}`,
    );
    expect(stored).toHaveLength(0);
  });

  it('says a number nobody owns is not in service', async () => {
    const res = await post(`${V}/inbound`, {
      AccountSid: accountSid,
      CallSid: fakeSid('CA'),
      From: MIKE,
      To: '+15005550006',
    });
    expect(res.body).toContain('this number is not in service');
  });

  it('a teammate answers in the browser: the call reads "Call · 1:35" and lands on the timeline', async () => {
    const sid = fakeSid('CA');
    await ringIn(sid);
    const memberLeg = fakeSid('CA');
    expect(
      (await leg(sid, memberLeg, `client:${identityOf(member.id)}`, 'in-progress')).statusCode,
    ).toBe(204);
    // Dale's browser lost the race; its leg ends without taking the call.
    await leg(sid, fakeSid('CA'), `client:${identityOf(owner.id)}`, 'canceled');
    await leg(sid, memberLeg, `client:${identityOf(member.id)}`, 'completed', {
      CallDuration: '95',
    });
    await post(`${V}/status`, {
      AccountSid: accountSid,
      CallSid: sid,
      CallStatus: 'completed',
      CallDuration: '112',
      From: MIKE,
      To: businessNumber,
    });
    await drain();
    const call = await callRow(sid);
    expect(call).toMatchObject({
      status: 'completed',
      answeredVia: 'browser',
      answeredByUserId: member.id,
      durationSeconds: 95,
    });
    const [conversation] = await admin()
      .select()
      .from(conversations)
      .where(eq(conversations.id, call!.conversationId!));
    expect(conversation!.lastPreview).toBe('Call · 1:35');
    const [entry] = await admin()
      .select()
      .from(activities)
      .where(and(eq(activities.id, call!.activityId!)));
    expect(entry).toMatchObject({ kind: 'call', subtype: 'answered', personId: mikeId });
  });

  it('nobody answers: the greeting, a voicemail and its words; the provider copies are deleted', async () => {
    const sid = fakeSid('CA');
    await ringIn(sid);
    const result = await post(`${V}/dial-result`, {
      AccountSid: accountSid,
      CallSid: sid,
      DialCallStatus: 'no-answer',
      From: MIKE,
      To: businessNumber,
    });
    expect(result.body).toContain(
      `<Say voice="Polly.Joanna-Neural">You’ve reached ${BUSINESS_NAME}. Leave your name, number and what you need, and we’ll call you back today.</Say>`,
    );
    expect(result.body).toContain('<Record maxLength="120"');
    expect(result.body).toContain(`transcribeCallback="${TEST_PUBLIC_URL}${V}/transcription"`);

    // The words can beat the recording; they wait for our copy of it.
    const rec = fakeSid('RE');
    const tr = fakeSid('TR');
    expect(
      (
        await post(`${V}/transcription`, {
          AccountSid: accountSid,
          CallSid: sid,
          RecordingSid: rec,
          TranscriptionSid: tr,
          TranscriptionStatus: 'completed',
          TranscriptionText: WORDS,
          From: MIKE,
          To: businessNumber,
        })
      ).statusCode,
    ).toBe(204);
    await reserve();
    const early = await processDeliveries({ ...loopDeps(), processors });
    expect(early).toMatchObject({ retried: 1, done: 0 });
    await rows(
      admin(),
      sql`update app.webhook_deliveries set next_attempt_at = now() + interval '1 hour'
          where dedupe_key like ${`${tr}%`}`,
    );
    await post(`${V}/recording`, {
      AccountSid: accountSid,
      CallSid: sid,
      RecordingSid: rec,
      RecordingStatus: 'completed',
      RecordingDuration: '12',
      RecordingUrl: `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${rec}`,
    });
    await post(`${V}/status`, {
      AccountSid: accountSid,
      CallSid: sid,
      CallStatus: 'completed',
      CallDuration: '40',
      From: MIKE,
      To: businessNumber,
    });
    await drain();
    await rows(
      admin(),
      sql`update app.webhook_deliveries set next_attempt_at = now() where dedupe_key like ${`${tr}%`}`,
    );
    await drain();

    const call = await callRow(sid);
    expect(call).toMatchObject({
      status: 'completed',
      answeredAt: null,
      isVoicemail: true,
      recordingSeconds: 12,
      recordingObjectPath: `${workspaceId}/calls/${call!.id}/voicemail.wav`,
      transcript: WORDS,
      transcriptStatus: 'completed',
    });
    expect(await s.store.exists('telephony', call!.recordingObjectPath!)).toBe(true);
    expect(s.telephony.deleted).toEqual(expect.arrayContaining([rec, tr]));
    const [conversation] = await admin()
      .select()
      .from(conversations)
      .where(eq(conversations.id, call!.conversationId!));
    expect(conversation!.lastPreview).toBe(`Voicemail, 0:12: “${WORDS}”`);
    expect(conversation!.unreadCount).toBeGreaterThan(0);
  });

  it('a forwarded phone takes the call only once someone presses 1', async () => {
    const sid = fakeSid('CA');
    await ringIn(sid);
    const cellLeg = fakeSid('CA');
    const screenPath = `${V}/screen?line=${encodeURIComponent(businessNumber)}`;
    const legParams = {
      AccountSid: accountSid,
      CallSid: cellLeg,
      ParentCallSid: sid,
      From: MIKE,
      To: CELL,
    };
    const screen = await post(screenPath, legParams);
    expect(screen.body).toContain(
      `<Gather numDigits="1" timeout="6" action="${TEST_PUBLIC_URL}${V}/screen-result?line=${encodeURIComponent(businessNumber)}" method="POST">`,
    );
    expect(screen.body).toContain(
      `Call for ${BUSINESS_NAME} from Mike Johnson. Press 1 to take it.`,
    );
    const resultPath = `${V}/screen-result?line=${encodeURIComponent(businessNumber)}`;
    // The cell's own voicemail "answered" and pressed nothing: that phone hangs up, nothing is recorded.
    await leg(sid, cellLeg, CELL, 'in-progress');
    expect((await post(resultPath, { ...legParams, Digits: '' })).body).toContain('<Hangup/>');
    await drain();
    expect((await callRow(sid))!.answeredAt).toBeNull();
    // Dale presses 1.
    expect((await post(resultPath, { ...legParams, Digits: '1' })).body).toContain(
      '>Connecting.</Say>',
    );
    await leg(sid, cellLeg, CELL, 'completed', { CallDuration: '61' });
    await drain();
    expect(await callRow(sid)).toMatchObject({
      status: 'completed',
      answeredVia: 'forwarding',
      answeredNumber: CELL,
      durationSeconds: 61,
    });
  });

  it('a withheld number still rings, and leaves nothing to process', async () => {
    const sid = fakeSid('CA');
    const body = await ringIn(sid, 'anonymous');
    expect(body).toContain('<Dial');
    expect(body).not.toContain('name="from"');
    await post(`${V}/status`, {
      AccountSid: accountSid,
      CallSid: sid,
      CallStatus: 'completed',
      CallDuration: '9',
      From: 'anonymous',
      To: businessNumber,
    });
    await drain();
    expect(await callRow(sid)).toBeUndefined();
    const stored = await admin()
      .select({ status: webhookDeliveries.status })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.workspaceId, workspaceId));
    expect(stored.every((d) => d.status !== 'failed')).toBe(true);
  });
});

describe('a teammate calls a customer from the browser', () => {
  it('dials only the call call.start recorded, shows the business number, and credits the teammate', async () => {
    const started = (
      await executeCommand(
        api(),
        callStart,
        { workspaceId, personId: mikeId },
        actor(member),
        meta(),
      )
    ).output;
    const browserSid = fakeSid('CA');
    const outbound = (params: Record<string, string>) =>
      post(`${V}/outbound`, {
        AccountSid: accountSid,
        CallSid: browserSid,
        From: `client:${identityOf(member.id)}`,
        To: MIKE,
        CallId: started.callId,
        Direction: 'inbound',
        ...params,
      });
    // Someone else's browser, or another number, cannot reuse the call.
    expect((await outbound({ From: `client:${identityOf(owner.id)}` })).body).toContain(
      'could not be placed',
    );
    expect((await outbound({ To: '+17135550199' })).body).toContain('could not be placed');
    const ok = await outbound({});
    expect(ok.body).toContain(
      `<Dial callerId="${businessNumber}" answerOnBridge="true" action="${TEST_PUBLIC_URL}${V}/hangup" method="POST"><Number statusCallback="${TEST_PUBLIC_URL}${V}/leg-status" statusCallbackEvent="ringing answered completed" statusCallbackMethod="POST">${MIKE}</Number></Dial>`,
    );
    await drain();
    expect(await callRow(browserSid)).toMatchObject({ id: started.callId, status: 'ringing' });

    const customerLeg = fakeSid('CA');
    const legOut = (status: string, extra = {}) =>
      post(`${V}/leg-status`, {
        AccountSid: accountSid,
        CallSid: customerLeg,
        ParentCallSid: browserSid,
        CallStatus: status,
        From: businessNumber,
        To: MIKE,
        ...extra,
      });
    await legOut('ringing');
    await legOut('in-progress');
    await legOut('completed', { CallDuration: '30' });
    await post(`${V}/status`, {
      AccountSid: accountSid,
      CallSid: browserSid,
      CallStatus: 'completed',
      CallDuration: '45',
      From: `client:${identityOf(member.id)}`,
      To: MIKE,
    });
    await drain();
    const call = await callRow(browserSid);
    expect(call).toMatchObject({
      status: 'completed',
      answeredNumber: MIKE,
      durationSeconds: 30,
      placedBy: member.id,
    });
    const [entry] = await admin()
      .select()
      .from(activities)
      .where(eq(activities.id, call!.activityId!));
    expect(entry).toMatchObject({ subtype: 'outbound', authorUserId: member.id });
  });
});
