/**
 * RCS (0101), end to end against the fake carrier: connecting a business's RCS sender, texts going RCS first
 * with the thread's own number as the fallback, a rich text's template and its plain face, read receipts, a
 * tapped button and a texted-back number landing in the customer's one thread, and pausing and letting go.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import {
  createTokenVerifier,
  executeCommand,
  messageSend,
  organizationCreate,
  personCreate,
  phoneNumberBuy,
  phoneUpdateSettings,
  rcsSenderConnect,
  rcsSenderDisconnect,
  rcsSenderUpdate,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import {
  conversations,
  events,
  messages,
  phoneNumbers,
  rcsSenders,
  telephonyAccounts,
  telephonyRegistrations,
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
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processDeliveries } from '../src/deliveries';
import { handlers } from '../src/handlers/index';
import { buildHttpServer } from '../src/http/server';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { processors } from '../src/processors/index';
import { jobs } from '../src/scheduled';
import {
  createFakeTelephony,
  FAKE_AUTH_TOKEN,
  FAKE_RCS_SENDERS,
  fakeSid,
  type FakeTelephony,
} from '../src/telephony/fake';
import { twilioSignature } from '../src/telephony/signature';
import { TEST_PUBLIC_URL, testServices, type TestServices } from './helpers';

const env = testEnv();
const WORKER_ID = `vitest-rcs-${process.pid}`;
const INBOUND = '/webhooks/twilio/messaging/inbound';
const STATUS = '/webhooks/twilio/messaging/status';
/** The fake plays a phone that can show RCS for this one… */
const MIKE = '+17135550142';
/** …and one that can't for any number ending in 7. */
const LINDA = '+18325550177';
const BUSINESS_NAME = 'RCS Test HVAC';
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
const tollFree = () =>
  `+1833${String(100 + Math.floor(Math.random() * 899))}${String(1001 + Math.floor(Math.random() * 8998))}`;

let owner: TestUser;
let workspaceId: string;
let mikeId: string;
let lindaId: string;
let s: TestServices;
let fake: FakeTelephony;
let app: FastifyInstance;
let businessNumber: string;
let accountSid: string;

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
function postTwilio(path: string, params: Record<string, string>) {
  return app.inject({
    method: 'POST',
    url: path,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': twilioSignature(FAKE_AUTH_TOKEN, `${TEST_PUBLIC_URL}${path}`, params),
    },
    payload: new URLSearchParams(params).toString(),
  });
}

/** Twilio's status callbacks for one sent message, in order, from whichever sender it went out on. */
async function callbacks(sid: string, from: string, statuses: readonly string[]) {
  for (const status of statuses) {
    const res = await postTwilio(STATUS, {
      AccountSid: accountSid,
      MessageSid: sid,
      MessageStatus: status,
      From: from,
      ...(from.startsWith('rcs:') ? { ChannelPrefix: 'rcs' } : {}),
      ...(status === 'read' ? { EventType: 'READ' } : {}),
    });
    expect(res.statusCode).toBe(204);
  }
  await drain();
}

async function waitForMail(to: string, subject: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const res = await fetch(
      `${env.mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
    );
    const found = ((await res.json()) as { messages: { Subject: string }[] }).messages;
    if (found.some((m) => m.Subject === subject)) return;
    await sleep(250);
  }
  throw new Error(`no "${subject}" email reached ${to}`);
}

const sender = async () =>
  (
    await admin()
      .select()
      .from(rcsSenders)
      .where(eq(rcsSenders.workspaceId, workspaceId))
      .orderBy(asc(rcsSenders.createdAt))
  ).at(-1)!;
const messageRow = async (id: string) =>
  (await admin().select().from(messages).where(eq(messages.id, id)))[0]!;
const send = async (input: Record<string, unknown>) =>
  (
    await executeCommand(
      api(),
      messageSend,
      { workspaceId, channel: 'sms', ...input },
      actor(owner),
      meta(),
    )
  ).output;

beforeAll(async () => {
  owner = await createTestUser('rcs-owner');
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: BUSINESS_NAME },
    actor(owner),
    meta(),
  );
  workspaceId = output.workspaceId;
  const person = async (firstName: string, phone: string) =>
    (
      await executeCommand(
        api(),
        personCreate,
        { workspaceId, firstName, lastName: 'Customer', phone },
        actor(owner),
        meta(),
      )
    ).output.personId;
  mikeId = await person('Mike', MIKE);
  lindaId = await person('Linda', LINDA);
  await executeCommand(
    api(),
    phoneUpdateSettings,
    { workspaceId, quietHours: { enabled: false, start: '20:00', end: '08:00' } },
    actor(owner),
    meta(),
  );
  const log = pino({ level: 'silent' });
  // The sender in review stays there for the length of the suite, so review can be seen at all.
  fake = createFakeTelephony({ approvalMs: 60 * 60_000, callbacks: false, log });
  s = { ...testServices(), telephony: fake };
  app = await buildHttpServer({
    ...s,
    httpDb: testDbs().worker.db,
    verifyToken: createTokenVerifier({
      jwksUrl: `${env.supabaseUrl}/auth/v1/.well-known/jwks.json`,
      jwtIssuer: `${env.supabaseUrl}/auth/v1`,
    }),
    webOrigins: ['http://localhost:3000'],
  });
  // A number, approved for texting: RCS rides on it, and every phone without RCS is texted from it.
  businessNumber = tollFree();
  await executeCommand(
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
  // Approved for texting, written as the carrier would have left it: this fake's clock is the RCS review's.
  const [number] = await admin()
    .select()
    .from(phoneNumbers)
    .where(eq(phoneNumbers.workspaceId, workspaceId));
  await admin()
    .insert(telephonyRegistrations)
    .values({
      workspaceId,
      accountId: account!.id,
      phoneNumberId: number!.id,
      kind: 'toll_free_verification',
      status: 'approved',
      providerSid: fakeSid('HH'),
      approvedAt: new Date(),
    });
});
afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('connecting the sender', () => {
  it('lists the senders in the business’s own Twilio account for Settings', async () => {
    const token = await signInTestUser(owner);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/telephony/rcs-senders',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { workspaceId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      accountSid: string;
      senders: { senderId: string; state: string }[];
    };
    expect(body.accountSid).toBe(accountSid);
    expect(Object.fromEntries(body.senders.map((x) => [x.senderId, x.state]))).toEqual({
      [FAKE_RCS_SENDERS.online]: 'online',
      [FAKE_RCS_SENDERS.review]: 'in_review',
      [FAKE_RCS_SENDERS.offline]: 'offline',
    });
  });

  it('says plainly when the account has no sender by that id, and connects the right one on the next try', async () => {
    await executeCommand(
      api(),
      rcsSenderConnect,
      { workspaceId, senderId: 'rcs:no_such_agent' },
      actor(owner),
      meta(),
    );
    await drain();
    const missing = await sender();
    expect(missing).toMatchObject({
      status: 'failed',
      senderId: 'no_such_agent',
      inService: false,
    });
    expect(missing.lastError).toContain(accountSid);

    await executeCommand(
      api(),
      rcsSenderConnect,
      { workspaceId, senderId: FAKE_RCS_SENDERS.online },
      actor(owner),
      meta(),
    );
    await drain();
    const live = await sender();
    // The same row tried again: one sender per business.
    expect(live.id).toBe(missing.id);
    expect(live).toMatchObject({
      status: 'active',
      senderId: FAKE_RCS_SENDERS.online,
      inService: true,
      providerStatus: 'ONLINE',
      displayName: 'Stand-in RCS sender',
      lastError: null,
    });
    expect(live.connectedAt).toBeInstanceOf(Date);
    expect(live.providerSid).toMatch(/^XEfake/);
    const [account] = await admin()
      .select()
      .from(telephonyAccounts)
      .where(eq(telephonyAccounts.workspaceId, workspaceId));
    // In the messaging service's pool: what makes Twilio try RCS first.
    expect(fake.rcsPools.get(account!.messagingServiceSid!)).toBe(live.providerSid);
    const changes = await admin()
      .select()
      .from(events)
      .where(and(eq(events.entityId, live.id), eq(events.eventType, 'rcs_sender.state_changed')))
      .orderBy(asc(events.createdAt));
    expect(changes.map((e) => (e.payload as { status: string }).status)).toEqual([
      'failed',
      'active',
    ]);
    // Owners and admins hear that it is live, as they hear that texting is.
    await waitForMail(owner.email, `RCS is on for ${BUSINESS_NAME}`);
  });

  it('refuses a second sender while one is connected', async () => {
    await expect(
      executeCommand(
        api(),
        rcsSenderConnect,
        { workspaceId, senderId: FAKE_RCS_SENDERS.review },
        actor(owner),
        meta(),
      ),
    ).rejects.toMatchObject({ rule: 'rcs_sender_exists' });
  });
});

describe('texts go RCS first', () => {
  let richToMike: string;

  it('sends through the service with the thread’s number as the fallback, and learns it went as RCS and was read', async () => {
    const { messageId } = await send({ personId: mikeId, body: 'Marco is on the way.' });
    await drain();
    const out = fake.sent.at(-1)!;
    expect(out).toMatchObject({
      to: MIKE,
      from: businessNumber,
      rcsFirst: true,
      contentSid: null,
      via: 'rcs',
    });
    expect(out.messagingServiceSid).toMatch(/^MGfake/);
    // Nothing is known about the way until the carrier says.
    expect((await messageRow(messageId)).transport).toBeNull();
    await callbacks(out.sid, `rcs:${FAKE_RCS_SENDERS.online}`, ['sent', 'delivered', 'read']);
    const m = await messageRow(messageId);
    expect(m).toMatchObject({ status: 'read', transport: 'rcs' });
    expect(m.readAt).toBeInstanceOf(Date);
    expect(m.deliveredAt).toBeInstanceOf(Date);
    const [read] = await admin()
      .select()
      .from(events)
      .where(and(eq(events.entityId, messageId), eq(events.eventType, 'message.read')));
    expect(read).toBeTruthy();
  });

  it('sends buttons as a content template whose text fallback lists the choices', async () => {
    const { messageId } = await send({
      personId: mikeId,
      body: 'Your visit is tomorrow at 2 PM.',
      rich: {
        kind: 'buttons',
        buttons: [
          { type: 'reply', title: 'Confirm' },
          { type: 'reply', title: 'Reschedule' },
          { type: 'call', title: 'Call us', phone: '(713) 555-0142' },
        ],
      },
    });
    richToMike = messageId;
    await drain();
    const out = fake.sent.at(-1)!;
    expect(out.contentSid).toMatch(/^HXfake/);
    const template = fake.contents.get(out.contentSid!)!;
    const card = template.types['twilio/card'] as { body: string; actions: { type: string }[] };
    expect(card.body).toBe('Your visit is tomorrow at 2 PM.');
    expect(card.actions.map((a) => a.type)).toEqual(['QUICK_REPLY', 'QUICK_REPLY', 'PHONE_NUMBER']);
    expect((template.types['twilio/text'] as { body: string }).body).toBe(
      'Your visit is tomorrow at 2 PM.\n\nCall us: (713) 555-0142\n\nReply 1 for Confirm or 2 for Reschedule.',
    );
    const m = await messageRow(messageId);
    expect(m.contentSid).toBe(out.contentSid);
    expect(m.rich?.buttons.map((b) => b.id)).toEqual([
      `${messageId.replace(/-/g, '').slice(0, 8)}.r1`,
      `${messageId.replace(/-/g, '').slice(0, 8)}.r2`,
      `${messageId.replace(/-/g, '').slice(0, 8)}.c1`,
    ]);
    await callbacks(out.sid, `rcs:${FAKE_RCS_SENDERS.online}`, ['sent', 'delivered']);
    // Done with: its template is gone from Twilio.
    expect(fake.deletedContents).toContain(out.contentSid);
  });

  it('files a tapped button in the customer’s own thread, with the message it came from', async () => {
    const texts = await admin()
      .select()
      .from(conversations)
      .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.personId, mikeId)));
    expect(texts).toHaveLength(1);
    const payload = `${richToMike.replace(/-/g, '').slice(0, 8)}.r2`;
    const res = await postTwilio(INBOUND, {
      AccountSid: accountSid,
      MessageSid: `SMfaketap${randomUUID().slice(0, 8)}`,
      From: `rcs:${MIKE}`,
      To: `rcs:${FAKE_RCS_SENDERS.online}`,
      Body: 'Reschedule',
      ButtonPayload: payload,
      ButtonText: 'Reschedule',
      ButtonType: 'QUICK_REPLY',
      NumMedia: '0',
    });
    expect(res.statusCode).toBe(200);
    await drain();
    const [tap] = await admin()
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, texts[0]!.id), eq(messages.direction, 'inbound')));
    expect(tap).toMatchObject({
      channel: 'sms',
      bodyText: 'Reschedule',
      transport: 'rcs',
      fromAddress: MIKE,
      buttonReply: {
        type: 'reply',
        title: 'Reschedule',
        id: payload,
        messageId: richToMike,
        via: 'tap',
      },
    });
    // Everything that waits on a customer's message hears it: the AI teammate, workflows, the Action Center.
    const [received] = await admin()
      .select()
      .from(events)
      .where(and(eq(events.entityId, tap!.id), eq(events.eventType, 'message.received')));
    expect(received?.payload).toMatchObject({
      channel: 'sms',
      transport: 'rcs',
      button: { title: 'Reschedule', type: 'reply', via: 'tap' },
    });
    expect(
      (await admin().select().from(conversations).where(eq(conversations.id, texts[0]!.id)))[0],
    ).toMatchObject({ status: 'open', lastPreview: 'Reschedule' });
  });

  it('notes a tapped call button without treating it as something to answer', async () => {
    const res = await postTwilio(INBOUND, {
      AccountSid: accountSid,
      MessageSid: `SMfakecall${randomUUID().slice(0, 8)}`,
      From: `rcs:${MIKE}`,
      To: `rcs:${FAKE_RCS_SENDERS.online}`,
      Body: 'Call us',
      ButtonText: 'Call us',
      ButtonType: 'PHONE_NUMBER',
      NumMedia: '0',
    });
    expect(res.statusCode).toBe(200);
    await drain();
    const [tap] = await rows<{ id: string; button_reply: { type: string; via: string } }>(
      admin(),
      sql`select id, button_reply from app.messages
          where workspace_id = ${workspaceId} and body_text = 'Call us' and direction = 'inbound'`,
    );
    expect(tap?.button_reply).toMatchObject({ type: 'call', via: 'tap' });
    const types = await rows<{ event_type: string }>(
      admin(),
      sql`select event_type from app.events where entity_id = ${tap!.id}`,
    );
    expect(types.map((t) => t.event_type)).toEqual(['message.action_tapped']);
  });

  it('falls back to SMS for a phone without RCS, from the thread’s number, and matches a texted-back number', async () => {
    const { messageId } = await send({
      personId: lindaId,
      body: 'Can we come Thursday?',
      rich: {
        kind: 'buttons',
        buttons: [
          { type: 'reply', title: 'Thursday works' },
          { type: 'reply', title: 'Another day' },
        ],
      },
    });
    await drain();
    const out = fake.sent.at(-1)!;
    expect(out).toMatchObject({ to: LINDA, from: businessNumber, rcsFirst: true, via: 'sms' });
    expect(out.delivered.body).toBe(
      'Can we come Thursday?\n\nReply 1 for Thursday works or 2 for Another day.',
    );
    await callbacks(out.sid, businessNumber, ['sent', 'delivered']);
    expect(await messageRow(messageId)).toMatchObject({ status: 'delivered', transport: 'sms' });

    const res = await postTwilio(INBOUND, {
      AccountSid: accountSid,
      MessageSid: `SMfakeanswer${randomUUID().slice(0, 8)}`,
      From: LINDA,
      To: businessNumber,
      Body: '2',
      NumMedia: '0',
    });
    expect(res.statusCode).toBe(200);
    await drain();
    const [answer] = await rows<{ transport: string; button_reply: Record<string, unknown> }>(
      admin(),
      sql`select transport::text, button_reply from app.messages
          where workspace_id = ${workspaceId} and body_text = '2' and direction = 'inbound'`,
    );
    expect(answer).toMatchObject({
      transport: 'sms',
      button_reply: { title: 'Another day', messageId, via: 'text' },
    });
  });
});

describe('pausing and letting go', () => {
  it('takes the sender out of the pool when RCS is switched off, and texts go as they did before', async () => {
    await executeCommand(
      api(),
      rcsSenderUpdate,
      { workspaceId, enabled: false },
      actor(owner),
      meta(),
    );
    await drain();
    const paused = await sender();
    expect(paused).toMatchObject({ status: 'active', enabled: false, inService: false });
    expect([...fake.rcsPools.values()]).not.toContain(paused.providerSid);
    // Still approved, so no news from the carriers: an event of its own, for Settings to show the change.
    const [offService] = await admin()
      .select()
      .from(events)
      .where(
        and(eq(events.entityId, paused.id), eq(events.eventType, 'rcs_sender.service_changed')),
      );
    expect(offService?.payload).toMatchObject({ inService: false });
    const { messageId } = await send({ personId: mikeId, body: 'Plain text again.' });
    await drain();
    expect(fake.sent.at(-1)).toMatchObject({ rcsFirst: false, via: 'sms' });
    // Without RCS the way is known at once.
    expect((await messageRow(messageId)).transport).toBe('sms');
  });

  it('lets the sender go', async () => {
    await executeCommand(api(), rcsSenderDisconnect, { workspaceId }, actor(owner), meta());
    await drain();
    const gone = await sender();
    expect(gone).toMatchObject({ status: 'disconnected', inService: false });
    expect(gone.disconnectedAt).toBeInstanceOf(Date);
  });
});
