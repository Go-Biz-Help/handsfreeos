import { randomBytes, randomUUID } from 'node:crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import {
  conversationLinkPerson,
  conversationSnooze,
  createTokenVerifier,
  executeCommand,
  messageRetry,
  messageSend,
  organizationCreate,
  personCreate,
  phoneNumberBuy,
  phoneNumberRelease,
  phoneUpdateSettings,
  registrationSubmit,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import {
  activities,
  conversations,
  events,
  messages,
  phoneNumbers,
  scheduledJobs,
  telephonyAccounts,
  telephonyRegistrations,
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
import { createSealer } from '../src/crypto';
import { processDeliveries } from '../src/deliveries';
import { readEnv } from '../src/env';
import { handlers } from '../src/handlers/index';
import { buildHttpServer } from '../src/http/server';
import { processJobs } from '../src/jobs';
import { MAX_ATTEMPTS, processOnce } from '../src/outbox';
import { processors } from '../src/processors/index';
import { jobs, unansweredCheck } from '../src/scheduled';
import { FAKE_AUTH_TOKEN, fakeSid } from '../src/telephony/fake';
import { twilioSignature, verifyTwilioSignature } from '../src/telephony/signature';
import { TEST_PUBLIC_URL, testServices, type TestServices } from './helpers';

const env = testEnv();
const WORKER_ID = `vitest-telephony-${process.pid}`;
const INBOUND = '/webhooks/twilio/messaging/inbound';
const STATUS = '/webhooks/twilio/messaging/status';
const MIKE = '+17135550142';
const STRANGER = '+18325550190';
const BUSINESS_NAME = 'Telephony Test HVAC';
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A toll-free number nobody else holds; the fake carrier refuses numbers ending in 0000. */
const tollFree = (ending?: string) =>
  `+1833${String(100 + Math.floor(Math.random() * 899))}${ending ?? String(1001 + Math.floor(Math.random() * 8998))}`;

const business = {
  legalName: 'Telephony Test HVAC LLC',
  businessType: 'llc',
  ein: '12-3456789',
  website: 'https://example.com',
  address: { line1: '4410 Westpark Dr', city: 'Houston', state: 'TX', postalCode: '77027' },
  contact: {
    firstName: 'Dale',
    lastName: 'Ramsey',
    email: 'dale@example.com',
    phone: '(713) 555-0161',
  },
  useCase: 'customer_care',
  messageSamples: ['Hi Mike, this is Lone Star HVAC. Marco is on the way. Reply STOP to opt out.'],
  optInDescription:
    'Customers give us their cell number when they book a visit and agree to texts about it.',
  monthlyVolume: 'under_1000',
};

let owner: TestUser;
let member: TestUser;
let workspaceId: string;
let organizationId: string;
let mikeId: string;
let patId: string;
let s: TestServices;
let app: FastifyInstance;
let numberId: string;
let businessNumber: string;
let accountSid: string;
let mikeConversationId: string;

/** Locks this workspace's pending work for this suite's worker id: no other poller or suite takes it. */
async function reserve(): Promise<void> {
  for (const table of ['outbox', 'webhook_deliveries', 'scheduled_jobs'])
    await rows(
      admin(),
      sql`update ${sql.raw(`app.${table}`)} set locked_at = now(), locked_by = ${WORKER_ID}
          where status = 'pending' and workspace_id = ${workspaceId}`,
    );
}

/** Runs the outbox, webhook and job loops over this workspace's work until it is idle or `until` holds. */
async function drain(opts: { until?: () => Promise<boolean>; timeoutMs?: number } = {}) {
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
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
        sql`select 'outbox' as source, event_type as what, last_error from app.outbox
              where workspace_id = ${workspaceId} and last_error is not null
            union all select 'webhook', kind, last_error from app.webhook_deliveries
              where workspace_id = ${workspaceId} and last_error is not null
            union all select 'job', kind, last_error from app.scheduled_jobs
              where workspace_id = ${workspaceId} and last_error is not null`,
      );
      throw new Error(`worker work failed: ${JSON.stringify(errors)}`);
    }
    const busy = passes.some((p) => p.claimed > 0);
    if (opts.until ? await opts.until() : !busy) return;
    if (Date.now() > deadline) throw new Error('the worker did not finish in time');
    if (!busy) await sleep(100);
  }
}

/** Posts a webhook the way Twilio does: form-encoded, signed over the public URL. */
function postTwilio(
  path: string,
  params: Record<string, string>,
  opts: { token?: string; signature?: string | null } = {},
) {
  const signature =
    opts.signature === undefined
      ? twilioSignature(opts.token ?? FAKE_AUTH_TOKEN, `${TEST_PUBLIC_URL}${path}`, params)
      : opts.signature;
  return app.inject({
    method: 'POST',
    url: path,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(signature ? { 'x-twilio-signature': signature } : {}),
    },
    payload: new URLSearchParams(params).toString(),
  });
}

interface MailpitMessage {
  ID: string;
  Subject: string;
}
async function mailTo(to: string): Promise<MailpitMessage[]> {
  const res = await fetch(
    `${env.mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
  );
  if (!res.ok) throw new Error(`mailpit search failed: ${res.status}`);
  return ((await res.json()) as { messages: MailpitMessage[] }).messages;
}
async function waitForMail(to: string, subject: string): Promise<MailpitMessage> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const hit = (await mailTo(to)).find((m) => m.Subject === subject);
    if (hit) return hit;
    await sleep(250);
  }
  throw new Error(`no "${subject}" email reached ${to}`);
}

const numberRow = async (id: string) =>
  (await admin().select().from(phoneNumbers).where(eq(phoneNumbers.id, id)))[0];
const conversationRow = async (id: string) =>
  (await admin().select().from(conversations).where(eq(conversations.id, id)))[0];
const messageBySid = async (sid: string) =>
  (await admin().select().from(messages).where(eq(messages.providerMessageId, sid)))[0];

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('telephony-owner'),
    createTestUser('telephony-member'),
  ]);
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: BUSINESS_NAME },
    actor(owner),
    meta(),
  );
  workspaceId = output.workspaceId;
  organizationId = output.organizationId;
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
  patId = (
    await executeCommand(
      api(),
      personCreate,
      { workspaceId, firstName: 'Pat', lastName: 'Rivera' },
      actor(owner),
      meta(),
    )
  ).output.personId;
  // Tests send at any hour.
  await executeCommand(
    api(),
    phoneUpdateSettings,
    { workspaceId, quietHours: { enabled: false, start: '20:00', end: '08:00' } },
    actor(owner),
    meta(),
  );
  // Lead intake (M14) would make a customer out of a stranger's first text. This suite covers linking one
  // to a customer by hand and the backfill that follows, which is the path with the channel off; core's
  // intake.test.ts covers what intake opens instead.
  await rows(
    admin(),
    sql`insert into app.intake_sources (workspace_id, kind, name, active)
        values (${workspaceId}, 'text', 'Text message', false),
               (${workspaceId}, 'call', 'Phone call', false)`,
  );
  s = testServices({ reminderOverrideMs: 1500 });
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
afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('env, signatures and sealed credentials', () => {
  it('needs an encryption key, keeps the fake carrier out of production, and wants https for providers', () => {
    const base = { DATABASE_URL_WORKER: 'postgresql://hfos_worker:x@h/db', SMTP_URL: 'smtp://h' };
    const key = randomBytes(32).toString('base64');
    expect(() => readEnv(base)).toThrow(/WORKER_ENCRYPTION_KEY/);
    expect(readEnv({ ...base, WORKER_ENCRYPTION_KEY: key })).toMatchObject({
      telephonyProvider: 'fake',
      httpPort: 4100,
      publicUrl: 'http://127.0.0.1:4100',
    });
    expect(() =>
      readEnv({
        ...base,
        WORKER_ENCRYPTION_KEY: key,
        NODE_ENV: 'production',
        TELEPHONY_PROVIDER: 'fake',
      }),
    ).toThrow(/development and tests/);
    expect(() =>
      readEnv({ ...base, WORKER_ENCRYPTION_KEY: key, TELEPHONY_PROVIDER: 'twilio' }),
    ).toThrow(/TWILIO_ACCOUNT_SID/);
    expect(() =>
      readEnv({
        ...base,
        WORKER_ENCRYPTION_KEY: key,
        NODE_ENV: 'production',
        TWILIO_ACCOUNT_SID: 'ACx',
        TWILIO_AUTH_TOKEN: 'y',
        WORKER_PUBLIC_URL: 'http://hooks.example.com',
      }),
    ).toThrow(/https/);
  });

  it('computes the signature Twilio documents and rejects tampering', () => {
    const url = 'https://example.com/myapp.php?foo=1&bar=2';
    const params = {
      CallSid: 'CA1234567890ABCDE',
      Caller: '+14158675310',
      Digits: '1234',
      From: '+14158675310',
      To: '+18005551212',
    };
    const documented = 'L/OH5YylLD5NRKLltdqwSvS0BnU=';
    expect(twilioSignature('12345', url, params)).toBe(documented);
    expect(verifyTwilioSignature('12345', url, params, documented)).toBe(true);
    expect(verifyTwilioSignature('12345', url, { ...params, Digits: '9999' }, documented)).toBe(
      false,
    );
    expect(verifyTwilioSignature('54321', url, params, documented)).toBe(false);
    expect(verifyTwilioSignature('12345', url, params, undefined)).toBe(false);
  });

  it('seals tokens so only the current or a previous key opens them', () => {
    const k1 = randomBytes(32).toString('base64');
    const k2 = randomBytes(32).toString('base64');
    const first = createSealer(k1);
    const sealed = first.seal('subaccount-token');
    expect(sealed.startsWith(`v1.${first.keyId}.`)).toBe(true);
    expect(sealed).not.toContain('subaccount-token');
    expect(first.seal('subaccount-token')).not.toBe(sealed);
    expect(first.open(sealed)).toBe('subaccount-token');
    expect(() => createSealer(k2).open(sealed)).toThrow();
    expect(createSealer(k2, [k1]).open(sealed)).toBe('subaccount-token');
    const parts = sealed.split('.');
    parts[3] = parts[3]!.split('').reverse().join('');
    expect(() => first.open(parts.join('.'))).toThrow();
    expect(() => createSealer('too-short')).toThrow();
  });
});

describe('buying a number', () => {
  it('records a number the carrier no longer has as failed', async () => {
    const { output } = await executeCommand(
      api(),
      phoneNumberBuy,
      { workspaceId, e164: tollFree('0000'), numberType: 'toll_free' },
      actor(owner),
      meta(),
    );
    await drain();
    const n = await numberRow(output.phoneNumberId);
    expect(n?.status).toBe('failed');
    expect(n?.lastError).toMatch(/no longer available/);
  });

  it('gives up after the last try when the carrier keeps failing, so the owner can pick another number', async () => {
    const { output } = await executeCommand(
      api(),
      phoneNumberBuy,
      { workspaceId, e164: tollFree('0503'), numberType: 'toll_free' },
      actor(owner),
      meta(),
    );
    const [requested] = await admin()
      .select()
      .from(events)
      .where(
        and(
          eq(events.entityId, output.phoneNumberId),
          eq(events.eventType, 'phone_number.purchase_requested'),
        ),
      );
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Skip the backoff: each try is due at once.
      await rows(
        admin(),
        sql`update app.outbox set next_attempt_at = now() where event_id = ${requested!.id}`,
      );
      await reserve();
      await processOnce({
        ...s,
        workerId: WORKER_ID,
        batchSize: 200,
        reservedOnly: true,
        handlers,
      });
      expect((await numberRow(output.phoneNumberId))?.status).toBe(
        attempt < MAX_ATTEMPTS ? 'provisioning' : 'failed',
      );
    }
    expect((await numberRow(output.phoneNumberId))?.lastError).toBe(
      'The phone carrier did not answer.',
    );
    const [outboxRow] = await rows<{ status: string; attempts: number }>(
      admin(),
      sql`select status::text as status, attempts from app.outbox where event_id = ${requested!.id}`,
    );
    expect(outboxRow).toEqual({ status: 'done', attempts: MAX_ATTEMPTS - 1 });
    const [failed] = await admin()
      .select()
      .from(events)
      .where(
        and(
          eq(events.entityId, output.phoneNumberId),
          eq(events.eventType, 'phone_number.purchase_failed'),
        ),
      );
    expect(failed?.payload).toMatchObject({ error: 'The phone carrier did not answer.' });
    await drain();
  });

  it('buys through the workspace subaccount and keeps the subaccount token sealed', async () => {
    businessNumber = tollFree();
    const { output } = await executeCommand(
      api(),
      phoneNumberBuy,
      { workspaceId, e164: businessNumber, numberType: 'toll_free' },
      actor(owner),
      meta(),
    );
    numberId = output.phoneNumberId;
    await drain();
    const n = await numberRow(numberId);
    expect(n).toMatchObject({ status: 'active', e164: businessNumber });
    expect(n?.providerSid).toMatch(/^PNfake/);
    const [account] = await admin()
      .select()
      .from(telephonyAccounts)
      .where(eq(telephonyAccounts.workspaceId, workspaceId));
    expect(account).toMatchObject({ status: 'active', provider: 'fake', keyId: s.sealer.keyId });
    expect(account?.accountSid).toMatch(/^ACfake/);
    expect(account?.messagingServiceSid).toMatch(/^MGfake/);
    expect(account?.authTokenEnc).not.toContain(FAKE_AUTH_TOKEN);
    expect(s.sealer.open(account!.authTokenEnc!)).toBe(FAKE_AUTH_TOKEN);
    expect(n?.accountId).toBe(account?.id);
    accountSid = account!.accountSid!;
  });
});

describe('carrier registration', () => {
  it('submits toll-free verification; turned down, it is fixed and sent again as an edit, then approved', async () => {
    const registration = async () =>
      (
        await admin()
          .select()
          .from(telephonyRegistrations)
          .where(eq(telephonyRegistrations.workspaceId, workspaceId))
      )[0];
    const before = s.telephony.registrations.length;
    // The fake carrier turns down a legal name that says "reject".
    await executeCommand(
      api(),
      registrationSubmit,
      {
        workspaceId,
        kind: 'toll_free_verification',
        business: { ...business, legalName: 'Reject Me HVAC LLC' },
      },
      actor(owner),
      meta(),
    );
    await drain({ until: async () => (await registration())?.status === 'rejected' });
    const turnedDown = (await registration())!;
    expect(turnedDown).toMatchObject({
      status: 'rejected',
      providerStatus: 'TWILIO_REJECTED',
      rejectionReason: expect.stringContaining('agree to receive texts'),
    });
    await drain();
    await waitForMail(owner.email, `The carriers need a change before ${BUSINESS_NAME} can text`);
    // And Home says so, quoting them, until it's sent again.
    const card = () =>
      rows<{ state: string; detail: string | null; resolution: string | null }>(
        admin(),
        sql`select state::text as state, detail, resolution from app.attention_items
            where workspace_id = ${workspaceId} and kind = 'texting_rejected' and subject_id = ${turnedDown.id}`,
      );
    expect(await card()).toEqual([
      expect.objectContaining({
        state: 'open',
        detail: expect.stringContaining('agree to receive texts'),
      }),
    ]);

    // Fix and send again: the corrected details reach the carrier as an edit of the same request.
    await executeCommand(
      api(),
      registrationSubmit,
      { workspaceId, kind: 'toll_free_verification', business },
      actor(owner),
      meta(),
    );
    await drain({ until: async () => (await registration())?.status === 'approved' });
    const r = await registration();
    expect(r).toMatchObject({
      status: 'approved',
      providerStatus: 'TWILIO_APPROVED',
      providerSid: turnedDown.providerSid,
      rejectionReason: null,
    });
    expect(r?.providerSid).toMatch(/^HHfake/);
    expect(r?.carrierSubmittedAt?.getTime()).toBe(r?.submittedAt?.getTime());
    const asked = s.telephony.registrations.slice(before);
    expect(asked.map((a) => [a.kind, a.replaces, a.submission['legalName']])).toEqual([
      ['toll_free_verification', null, 'Reject Me HVAC LLC'],
      ['toll_free_verification', turnedDown.providerSid, business.legalName],
    ]);
    const changes = await admin()
      .select()
      .from(events)
      .where(and(eq(events.entityId, r!.id), eq(events.eventType, 'registration.status_changed')))
      .orderBy(asc(events.createdAt));
    expect(changes.map((e) => (e.payload as { to: string }).to)).toEqual([
      'in_review',
      'rejected',
      'in_review',
      'approved',
    ]);
    await drain();
    await waitForMail(owner.email, `Texting is on for ${BUSINESS_NAME}`);
    expect((await mailTo(member.email)).length).toBe(0);
    expect(await card()).toEqual([expect.objectContaining({ state: 'resolved' })]);
  });
});

describe('texting', () => {
  let sentSid: string;
  let sentMessageId: string;

  it('hands a queued text to the carrier through the messaging service', async () => {
    const { output } = await executeCommand(
      api(),
      messageSend,
      { workspaceId, personId: mikeId, body: 'Hi Mike, Marco is on the way.' },
      actor(owner),
      meta(),
    );
    sentMessageId = output.messageId;
    await drain();
    const out = s.telephony.sent.find(
      (m) => m.to === MIKE && m.body === 'Hi Mike, Marco is on the way.',
    );
    expect(out).toMatchObject({
      from: businessNumber,
      accountSid,
      statusCallbackUrl: `${TEST_PUBLIC_URL}${STATUS}`,
      mediaUrls: [],
    });
    expect(out?.messagingServiceSid).toMatch(/^MGfake/);
    sentSid = out!.sid;
    const [m] = await admin().select().from(messages).where(eq(messages.id, sentMessageId));
    expect(m).toMatchObject({ providerMessageId: sentSid, status: 'sending' });
  });

  it('applies status callbacks once each and never moves a text backwards', async () => {
    const base = { AccountSid: accountSid, MessageSid: sentSid, From: businessNumber, To: MIKE };
    expect((await postTwilio(STATUS, { ...base, MessageStatus: 'delivered' })).statusCode).toBe(
      204,
    );
    expect((await postTwilio(STATUS, { ...base, MessageStatus: 'delivered' })).statusCode).toBe(
      204,
    );
    expect((await postTwilio(STATUS, { ...base, MessageStatus: 'sent' })).statusCode).toBe(204);
    const stored = await admin()
      .select()
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.provider, 'twilio'),
          eq(webhookDeliveries.dedupeKey, `${sentSid}:delivered:`),
        ),
      );
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      workspaceId,
      kind: 'messaging.status',
      signatureValid: true,
    });
    await drain();
    const [m] = await admin().select().from(messages).where(eq(messages.id, sentMessageId));
    expect(m?.status).toBe('delivered');
    expect(m?.deliveredAt).toBeInstanceOf(Date);
  });

  it('sends a text the carrier could not deliver again when it is retried, as a new attempt', async () => {
    const body = 'Your estimate is ready to look over.';
    const { output } = await executeCommand(
      api(),
      messageSend,
      { workspaceId, personId: mikeId, body },
      actor(owner),
      meta(),
    );
    await drain();
    const sends = () => s.telephony.sent.filter((x) => x.to === MIKE && x.body === body);
    const load = async () =>
      (await admin().select().from(messages).where(eq(messages.id, output.messageId)))[0]!;
    const first = sends()[0]!;
    const base = { AccountSid: accountSid, From: businessNumber, To: MIKE };
    await postTwilio(STATUS, { ...base, MessageSid: first.sid, MessageStatus: 'sent' });
    await postTwilio(STATUS, {
      ...base,
      MessageSid: first.sid,
      MessageStatus: 'undelivered',
      ErrorCode: '30003',
    });
    await drain();
    const failed = await load();
    expect(failed).toMatchObject({ status: 'undelivered', providerMessageId: first.sid });
    expect(failed.sentAt).toBeInstanceOf(Date);

    // The carrier took the first attempt, so its provider id is still on the message. It goes again anyway.
    await executeCommand(
      api(),
      messageRetry,
      { workspaceId, messageId: output.messageId },
      actor(owner),
      meta(),
    );
    await drain();
    expect(sends()).toHaveLength(2);
    const second = sends()[1]!;
    expect(second.sid).not.toBe(first.sid);
    expect(await load()).toMatchObject({
      status: 'sending',
      providerMessageId: second.sid,
      errorCode: null,
      sentAt: null,
      deliveredAt: null,
    });

    // The carrier's reports on the new attempt find it.
    await postTwilio(STATUS, { ...base, MessageSid: second.sid, MessageStatus: 'delivered' });
    await drain();
    const delivered = await load();
    expect(delivered.status).toBe('delivered');
    expect(delivered.deliveredAt).toBeInstanceOf(Date);

    // The retry's event arriving a second time sends nothing more.
    await rows(
      admin(),
      sql`update app.outbox set status = 'pending', next_attempt_at = now()
          where event_id in (select id from app.events where entity_id = ${output.messageId}
            and event_type = 'message.queued' and payload->>'retry' = 'true')`,
    );
    await drain();
    expect(sends()).toHaveLength(2);
    expect((await load()).status).toBe('delivered');
  });

  it('refuses unsigned, mis-signed and unknown-account webhooks without storing them', async () => {
    const params = {
      AccountSid: accountSid,
      MessageSid: fakeSid('SM'),
      From: MIKE,
      To: businessNumber,
      Body: 'hi',
    };
    expect(
      (await postTwilio(INBOUND, params, { signature: 'bm90IGEgc2lnbmF0dXJl' })).statusCode,
    ).toBe(403);
    expect((await postTwilio(INBOUND, params, { signature: null })).statusCode).toBe(403);
    expect((await postTwilio(INBOUND, params, { token: 'someone-elses-token' })).statusCode).toBe(
      403,
    );
    expect(
      (await postTwilio(INBOUND, { ...params, AccountSid: 'ACfakenobodyhome' })).statusCode,
    ).toBe(403);
    const stored = await admin()
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.dedupeKey, params.MessageSid));
    expect(stored).toHaveLength(0);
  });

  it('files an inbound text with its photo and schedules the reply reminder', async () => {
    // A 1x1 PNG.
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const sid = fakeSid('SM');
    const res = await postTwilio(INBOUND, {
      AccountSid: accountSid,
      MessageSid: sid,
      From: MIKE,
      To: businessNumber,
      Body: 'Is Marco still coming? Here is the unit.',
      NumMedia: '1',
      MediaContentType0: 'image/png',
      MediaUrl0: `data:image/png;base64,${png}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/xml/);
    expect(res.body).toContain('<Response></Response>');
    await drain();
    const m = await messageBySid(sid);
    expect(m).toMatchObject({
      direction: 'inbound',
      status: 'received',
      bodyText: 'Is Marco still coming? Here is the unit.',
    });
    expect(m?.media).toHaveLength(1);
    expect(m?.media[0]).toMatchObject({
      bucket: 'telephony',
      contentType: 'image/png',
      objectPath: `${workspaceId}/messages/${m!.id}/0.png`,
    });
    expect(await s.store.exists('telephony', m!.media[0]!.objectPath)).toBe(true);
    const c = await conversationRow(m!.conversationId);
    expect(c).toMatchObject({ personId: mikeId, status: 'open', unreadCount: 1 });
    expect(c?.awaitingReplySince).toBeInstanceOf(Date);
    mikeConversationId = c!.id;
    const [job] = await admin()
      .select()
      .from(scheduledJobs)
      .where(
        and(
          eq(scheduledJobs.dedupeKey, `unanswered:${c!.id}`),
          eq(scheduledJobs.status, 'pending'),
        ),
      );
    expect(job?.kind).toBe('conversation.unanswered_check');
  });

  it('emails the owners once when nobody answers', async () => {
    const alerted = () =>
      admin()
        .select()
        .from(events)
        .where(
          and(
            eq(events.entityId, mikeConversationId),
            eq(events.eventType, 'conversation.unanswered_alerted'),
          ),
        );
    await drain({ until: async () => (await alerted()).length > 0, timeoutMs: 15_000 });
    const subject = 'Mike Johnson is waiting for a reply';
    await waitForMail(owner.email, subject);
    // The same wait never alerts twice, even if the check runs again.
    const [job] = await admin()
      .select()
      .from(scheduledJobs)
      .where(eq(scheduledJobs.dedupeKey, `unanswered:${mikeConversationId}`))
      .orderBy(desc(scheduledJobs.createdAt))
      .limit(1);
    await unansweredCheck({
      ...s,
      job: job!,
      scope: { workspaceId, organizationId },
      attempt: 1,
      now: Date.now(),
    });
    expect(await alerted()).toHaveLength(1);
    expect((await mailTo(owner.email)).filter((m) => m.Subject === subject)).toHaveLength(1);
    expect((await mailTo(member.email)).filter((m) => m.Subject === subject)).toHaveLength(0);
  });

  it('brings a snoozed conversation back when its time comes', async () => {
    await executeCommand(
      api(),
      conversationSnooze,
      {
        workspaceId,
        conversationId: mikeConversationId,
        until: new Date(Date.now() + 61_000).toISOString(),
      },
      actor(owner),
      meta(),
    );
    expect((await conversationRow(mikeConversationId))?.status).toBe('snoozed');
    await drain();
    const [alarm] = await admin()
      .select()
      .from(scheduledJobs)
      .where(
        and(
          eq(scheduledJobs.dedupeKey, `unsnooze:${mikeConversationId}`),
          eq(scheduledJobs.status, 'pending'),
        ),
      );
    expect(alarm?.kind).toBe('conversation.unsnooze');
    // Snoozes are a minute at least; move the clock instead of waiting for it.
    await rows(
      admin(),
      sql`update app.conversations set snoozed_until = now() - interval '1 second' where id = ${mikeConversationId}`,
    );
    await rows(admin(), sql`update app.scheduled_jobs set run_at = now() where id = ${alarm!.id}`);
    await drain({
      until: async () => (await conversationRow(mikeConversationId))?.status === 'open',
    });
    expect((await conversationRow(mikeConversationId))?.status).toBe('open');
  });

  it('opens a customer and a lead when lead intake is on for texts (M14)', async () => {
    await rows(
      admin(),
      sql`update app.intake_sources set active = true where workspace_id = ${workspaceId} and kind = 'text'`,
    );
    const stranger = '+15125550187';
    const sid = fakeSid('SM');
    await postTwilio(INBOUND, {
      AccountSid: accountSid,
      MessageSid: sid,
      From: stranger,
      To: businessNumber,
      Body: 'My unit is making a noise — can someone come out?',
    });
    await drain();
    const m = await messageBySid(sid);
    const c = await conversationRow(m!.conversationId);
    const [lead] = await rows<{ title: string; source: string; person_id: string }>(
      admin(),
      sql`select l.title, l.source, l.person_id from app.leads l join app.people p on p.id = l.person_id
          where p.workspace_id = ${workspaceId} and p.phone_e164 = ${stranger}`,
    );
    expect(lead).toMatchObject({ title: '(512) 555-0187 (texted in)', source: 'Text message' });
    // The conversation is theirs from the first message, so the timeline entry is already filed.
    expect(c?.personId).toBe(lead!.person_id);
    expect(m?.activityId).toBeTruthy();
    await rows(
      admin(),
      sql`update app.intake_sources set active = false where workspace_id = ${workspaceId} and kind = 'text'`,
    );
  });

  it('links an unknown texter to a customer and backfills their timeline', async () => {
    const sid = fakeSid('SM');
    await postTwilio(INBOUND, {
      AccountSid: accountSid,
      MessageSid: sid,
      From: STRANGER,
      To: businessNumber,
      Body: 'Do you service Katy?',
    });
    await drain();
    const m = await messageBySid(sid);
    const c = await conversationRow(m!.conversationId);
    expect(c?.personId).toBeNull();
    expect(m?.activityId).toBeNull();
    await executeCommand(
      api(),
      conversationLinkPerson,
      { workspaceId, conversationId: c!.id, personId: patId },
      actor(owner),
      meta(),
    );
    await drain();
    const linked = await messageBySid(sid);
    expect(linked?.activityId).toBeTruthy();
    const [a] = await admin()
      .select()
      .from(activities)
      .where(eq(activities.id, linked!.activityId!));
    expect(a).toMatchObject({
      personId: patId,
      kind: 'sms',
      subtype: 'inbound',
      body: 'Do you service Katy?',
    });
  });
});

describe('number search', () => {
  const path = '/v1/telephony/available-numbers';

  it('answers signed-in managers only', async () => {
    const body = { workspaceId, numberType: 'local', areaCode: '713' };
    expect((await app.inject({ method: 'POST', url: path, payload: body })).statusCode).toBe(401);
    const memberToken = await signInTestUser(member);
    const asMember = await app.inject({
      method: 'POST',
      url: path,
      payload: body,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(asMember.statusCode).toBe(403);
    const ownerToken = await signInTestUser(owner);
    const ok = await app.inject({
      method: 'POST',
      url: path,
      payload: body,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(ok.statusCode).toBe(200);
    const { numbers } = ok.json<{ numbers: { e164: string; display: string }[] }>();
    expect(numbers.length).toBeGreaterThan(0);
    expect(numbers[0]!.e164).toMatch(/^\+1713/);
    expect(numbers[0]!.display).toMatch(/^\(713\)/);
    const invalid = await app.inject({
      method: 'POST',
      url: path,
      payload: { ...body, areaCode: '07' },
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('combines a city with a digit pattern, and asks for the state', async () => {
    const ownerToken = await signInTestUser(owner);
    const post = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: path,
        payload: { workspaceId, numberType: 'local', ...payload },
        headers: { authorization: `Bearer ${ownerToken}` },
      });

    const both = await post({ areaCode: '256', city: 'Huntsville', state: 'AL', contains: '454' });
    expect(both.statusCode).toBe(200);
    const { numbers } = both.json<{ numbers: { e164: string; locality: string }[] }>();
    expect(numbers.length).toBeGreaterThan(0);
    expect(numbers[0]!.e164).toContain('454');
    expect(numbers[0]!.locality).toBe('Huntsville');

    // A city on its own picks the wrong Huntsville, so the worker turns it down.
    expect((await post({ city: 'Huntsville' })).statusCode).toBe(400);
    // Toll-free numbers sit in no city.
    expect(
      (await post({ numberType: 'toll_free', city: 'Huntsville', state: 'AL' })).statusCode,
    ).toBe(400);
    // A distance widens a city, so it has no meaning without one.
    expect((await post({ withinMiles: 25 })).statusCode).toBe(400);
    expect((await post({ city: 'Huntsville', state: 'AL', withinMiles: 25 })).statusCode).toBe(200);
    expect((await post({ city: 'Huntsville', state: 'AL', withinMiles: 900 })).statusCode).toBe(
      400,
    );
    // A filter this worker has never heard of means the web app is ahead of it: say so, don't answer anyway.
    expect((await post({ areaCode: '256', nearPostalCode: '35801' })).statusCode).toBe(400);
    // A pattern is digits and stars, nothing else.
    expect((await post({ contains: '45a' })).statusCode).toBe(400);
    expect((await post({ contains: '256***454*' })).statusCode).toBe(200);
  });

  it('lets the web app call it across origins', async () => {
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: path,
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });
});

describe('releasing the number', () => {
  it('lets the carrier have it back', async () => {
    await executeCommand(
      api(),
      phoneNumberRelease,
      { workspaceId, phoneNumberId: numberId, confirmE164: businessNumber },
      actor(owner),
      meta(),
    );
    await drain();
    expect((await numberRow(numberId))?.status).toBe('released');
  });
});

describe('local numbers (10DLC)', () => {
  it('walks the carrier chain in order and starts the brand while the profile is in review', async () => {
    // A local number never ending in 0000 (the fake carrier refuses those).
    const local = `+1713${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}7`;
    const bought = await executeCommand(
      api(),
      phoneNumberBuy,
      { workspaceId, e164: local, numberType: 'local' },
      actor(owner),
      meta(),
    );
    await drain();
    expect((await numberRow(bought.output.phoneNumberId))?.status).toBe('active');
    const before = s.telephony.registrations.length;
    const fixedSample =
      'Hi Mike, your estimate for the new AC unit is ready. Reply with questions or STOP to opt out.';
    const submit = (secondSample: string) =>
      executeCommand(
        api(),
        registrationSubmit,
        {
          workspaceId,
          kind: 'a2p_10dlc',
          business: { ...business, messageSamples: [business.messageSamples[0], secondSample] },
        },
        actor(owner),
        meta(),
      );
    const chain = async () =>
      (
        await admin()
          .select()
          .from(telephonyRegistrations)
          .where(eq(telephonyRegistrations.workspaceId, workspaceId))
      ).filter((r) => r.kind.startsWith('a2p_'));
    const campaign = async () => (await chain()).find((r) => r.kind === 'a2p_campaign');
    // The fake carrier turns down a campaign whose example texts say "reject".
    await submit(
      'Hi Mike, your estimate is ready. Accept or reject it here, or reply STOP to opt out.',
    );
    await drain({
      until: async () => (await campaign())?.status === 'rejected',
      timeoutMs: 15_000,
    });
    const turnedDown = (await campaign())!;
    // Fix and send again: only the campaign goes back, as a new one in place of the old.
    await submit(fixedSample);
    await drain({
      until: async () => (await campaign())?.status === 'approved',
      timeoutMs: 15_000,
    });
    const rows4 = await chain();
    expect(rows4.map((r) => `${r.kind}:${r.status}`).sort()).toEqual([
      'a2p_brand:approved',
      'a2p_campaign:approved',
      'a2p_customer_profile:approved',
      'a2p_trust_product:approved',
    ]);
    const sid = Object.fromEntries(rows4.map((r) => [r.kind, r.providerSid]));
    expect(sid['a2p_campaign']).not.toBe(turnedDown.providerSid);
    const asked = s.telephony.registrations.slice(before);
    expect(asked.map((r) => r.kind)).toEqual([
      'a2p_customer_profile',
      'a2p_trust_product',
      'a2p_brand',
      'a2p_campaign',
      'a2p_campaign',
    ]);
    expect(asked.map((r) => r.replaces)).toEqual([null, null, null, null, turnedDown.providerSid]);
    expect(asked[4]!.submission['messageSamples']).toEqual([
      business.messageSamples[0],
      fixedSample,
    ]);
    expect(asked[0]!.previous).toEqual({});
    expect(asked[1]!.previous).toEqual({ a2p_customer_profile: sid['a2p_customer_profile'] });
    expect(asked[2]!.previous).toEqual({
      a2p_customer_profile: sid['a2p_customer_profile'],
      a2p_trust_product: sid['a2p_trust_product'],
    });
    expect(asked[3]!.previous).toMatchObject({ a2p_brand: sid['a2p_brand'] });
    expect(asked[3]!.messagingServiceSid).toMatch(/^MGfake/);
    // The brand went in before the profile's review finished.
    const changes = await admin()
      .select()
      .from(events)
      .where(
        and(
          eq(events.workspaceId, workspaceId),
          eq(events.eventType, 'registration.status_changed'),
        ),
      )
      .orderBy(asc(events.createdAt));
    const at = (kind: string, to: string) =>
      changes.findIndex((e) => {
        const p = e.payload as { kind?: string; to?: string };
        return p.kind === kind && p.to === to;
      });
    expect(at('a2p_brand', 'in_review')).toBeGreaterThan(-1);
    expect(at('a2p_brand', 'in_review')).toBeLessThan(at('a2p_customer_profile', 'approved'));
  });
});
