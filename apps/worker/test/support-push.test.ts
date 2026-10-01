import { randomUUID } from 'node:crypto';
import {
  executeCommand,
  organizationCreate,
  PushData,
  pushDeviceRegister,
  supportRequestCreate,
  userUpdateProfile,
  type CommandDef,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processDeliveries } from '../src/deliveries';
import { LOCAL_WEBHOOK_PASSWORD } from '../src/email/local';
import { handlers } from '../src/handlers/index';
import { buildHttpServer } from '../src/http/server';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { processors } from '../src/processors/index';
import { PUSH_JOBS, pushJobKey, type FakePushSent } from '../src/push/index';
import { jobs } from '../src/scheduled';
import { testServices, type TestServices } from './helpers';

/**
 * A new support ticket on the support people's phones (apps/worker/src/push/README.md, `support_ticket`), on the real
 * database with the stand-in sender:
 * - **Both ways in:** asking from inside the app, and mail to support@ that starts something new, each push every
 *   active support person with the switch on, and nobody else: not a suspended one, not one who turned it off, not a
 *   business's people, and not a support person who wrote in themselves.
 * - **About no business:** the job holds none, the push carries none, and it opens the ticket on the support desk.
 * - **Once:** a customer answering the ticket pushes nobody, and a phone the app is gone from is turned off.
 */

const WORKER_ID = `vitest-support-push-${process.pid}`;
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const as = <T = unknown>(u: TestUser, cmd: CommandDef, input: unknown): Promise<T> =>
  executeCommand(api(), cmd, input, actor(u), meta()).then((r) => r.output as T);
const basic = () => `Basic ${Buffer.from(`postmark:${LOCAL_WEBHOOK_PASSWORD}`).toString('base64')}`;
const mark = randomUUID().slice(0, 8);

let s: TestServices;
let app: FastifyInstance;
let onCall: TestUser;
let switchedOff: TestUser;
let suspended: TestUser;
let staffInBusiness: TestUser;
let customer: TestUser;
let customerBusiness: string;
let staffBusiness: string;
const tokens = {} as Record<
  | 'onIphone'
  | 'onAndroid'
  | 'onDead'
  | 'onGone'
  | 'off'
  | 'suspended'
  | 'staffInBusiness'
  | 'customer',
  string
>;

/** A phone the person signed in on, registered as the app does. */
async function phoneOf(u: TestUser, platform: 'ios' | 'android', label: string): Promise<string> {
  const token = `ExponentPushToken[${label}-${randomUUID().slice(0, 12)}]`;
  await as(u, pushDeviceRegister, { platform, token, appVersion: '1.0.0', deviceName: label });
  return token;
}

/** The loops, over this suite's own work: support events and mail, the drafts they ask for, and support pushes. */
async function drain(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const reserve = (table: string, where: ReturnType<typeof sql>) =>
    rows(
      admin(),
      sql`update ${sql.raw(`app.${table}`)} set locked_at = now(), locked_by = ${WORKER_ID}
          where status = 'pending' and ${where}`,
    );
  for (;;) {
    await reserve('outbox', sql`event_type like 'support%'`);
    await reserve('webhook_deliveries', sql`kind = 'support.inbound'`);
    await reserve(
      'scheduled_jobs',
      sql`(kind = 'support.draft' or (kind = ${PUSH_JOBS.send} and dedupe_key like 'push:support_ticket:%'))
          and run_at <= now()`,
    );
    const d = { ...s, workerId: WORKER_ID, batchSize: 200, reservedOnly: true };
    const passes = [
      await processOnce({ ...d, handlers }),
      await processDeliveries({ ...d, processors }),
      await processJobs({ ...d, jobs }),
    ];
    if (passes.some((p) => p.retried + p.failed > 0)) {
      const errors = await rows(
        admin(),
        sql`select event_type as what, last_error from app.outbox
              where locked_by = ${WORKER_ID} and last_error is not null
            union all select kind, last_error from app.webhook_deliveries
              where locked_by = ${WORKER_ID} and last_error is not null
            union all select kind, last_error from app.scheduled_jobs
              where locked_by = ${WORKER_ID} and last_error is not null`,
      );
      throw new Error(`support work failed: ${JSON.stringify(errors)}`);
    }
    if (!passes.some((p) => p.claimed > 0)) return;
    if (Date.now() > deadline) throw new Error('the worker did not finish in time');
  }
}

/** What the stand-in handed to this suite's phones, about one ticket. */
const sentAbout = (ticketId: string): FakePushSent[] =>
  s.push.fake.sent.filter(
    (m) =>
      Object.values(tokens).includes(m.message.to) &&
      (m.message.data as { refs?: { ticketId?: string } }).refs?.ticketId === ticketId,
  );
const tokensOf = (list: readonly FakePushSent[]) => list.map((m) => m.message.to).sort();

async function ticketOf(subjectPart: string): Promise<{ id: string; number: number }> {
  const [t] = await rows<{ id: string; number: string }>(
    admin(),
    sql`select id, number from platform.tickets where subject like ${`%${subjectPart}%`}
        order by created_at desc limit 1`,
  );
  if (!t) throw new Error(`no ticket about ${subjectPart}`);
  return { id: t.id, number: Number(t.number) };
}

beforeAll(async () => {
  [onCall, switchedOff, suspended, staffInBusiness, customer] = await Promise.all([
    createTestUser('ticket-push-on-call', { fullName: 'Sam Support' }),
    createTestUser('ticket-push-off', { fullName: 'Olive Off' }),
    createTestUser('ticket-push-suspended', { fullName: 'Sid Suspended' }),
    createTestUser('ticket-push-staff-owner', { fullName: 'Stacy Staff' }),
    createTestUser('ticket-push-customer', { fullName: 'Dana Reed' }),
  ]);
  customerBusiness = (
    await as<{ workspaceId: string }>(customer, organizationCreate, {
      businessName: `Reed Plumbing ${mark}`,
    })
  ).workspaceId;
  staffBusiness = (
    await as<{ workspaceId: string }>(staffInBusiness, organizationCreate, {
      businessName: `Stacy’s Test Shop ${mark}`,
    })
  ).workspaceId;
  await admin().execute(
    sql`insert into platform.staff (user_id, role, status) values
          (${onCall.id}, 'agent', 'active'),
          (${switchedOff.id}, 'agent', 'active'),
          (${suspended.id}, 'agent', 'suspended'),
          (${staffInBusiness.id}, 'lead', 'active')
        on conflict (user_id) do nothing`,
  );
  s = testServices();
  app = await buildHttpServer({
    ...s,
    httpDb: testDbs().worker.db,
    verifyToken: null,
    webOrigins: ['http://localhost:3000'],
  });
  tokens.onIphone = await phoneOf(onCall, 'ios', 'sam-iphone');
  tokens.onAndroid = await phoneOf(onCall, 'android', 'sam-android');
  tokens.onDead = await phoneOf(onCall, 'ios', 'sam-Dead-old-iphone');
  tokens.onGone = await phoneOf(onCall, 'android', 'sam-Gone-tablet');
  tokens.off = await phoneOf(switchedOff, 'ios', 'olive-iphone');
  tokens.suspended = await phoneOf(suspended, 'ios', 'sid-iphone');
  tokens.staffInBusiness = await phoneOf(staffInBusiness, 'ios', 'stacy-iphone');
  tokens.customer = await phoneOf(customer, 'ios', 'dana-iphone');
  await as(switchedOff, userUpdateProfile, { settings: { push: { supportTickets: false } } });
});

afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('a new support ticket, on the support people’s phones', () => {
  it('asked from inside the app: every support person with it on hears, and nobody else', async () => {
    const { ticketId, number } = await as<{ ticketId: string; number: number }>(
      customer,
      supportRequestCreate,
      {
        workspaceId: customerBusiness,
        subject: `Reminders stopped going out ${mark}`,
        body: 'They went out on Monday and not since.',
        context: { platform: 'ios' },
      },
    );
    await drain();

    const sent = sentAbout(ticketId);
    // Phones the app is gone from are handed it too: Expo says so on one's ticket, and the other's receipt.
    expect(tokensOf(sent)).toEqual(
      [
        tokens.onIphone,
        tokens.onAndroid,
        tokens.onDead,
        tokens.onGone,
        tokens.staffInBusiness,
      ].sort(),
    );
    const iphone = sent.find((m) => m.message.to === tokens.onIphone)!.message;
    expect(iphone).toMatchObject({
      title: `New support ticket #${number}`,
      subtitle: `Dana Reed · Reed Plumbing ${mark}`,
      body: `Reminders stopped going out ${mark}: “They went out on Monday and not since.”`,
      categoryId: 'support_ticket',
      collapseId: `ticket-${ticketId}`,
      interruptionLevel: 'active',
      ttl: 12 * 3_600,
    });
    // The phone reads it as a push about no business, which opens the ticket on the support desk.
    expect(PushData.parse(iphone.data)).toMatchObject({
      category: 'support_ticket',
      workspaceId: null,
      business: '',
      path: `/admin/tickets/${ticketId}`,
      refs: { ticketId },
      commandIds: {},
      collapseId: `ticket-${ticketId}`,
    });
    const android = sent.find((m) => m.message.to === tokens.onAndroid)!.message;
    expect(PushData.parse(android.data)).toMatchObject({
      title: `New support ticket #${number}`,
      subtitle: `Dana Reed · Reed Plumbing ${mark}`,
      workspaceId: null,
    });

    const [job] = await rows<{ workspace_id: string | null; status: string }>(
      admin(),
      sql`select workspace_id, status::text as status from app.scheduled_jobs
          where kind = ${PUSH_JOBS.send} and dedupe_key = ${pushJobKey(`support_ticket:${ticketId}`)}`,
    );
    expect(job).toEqual({ workspace_id: null, status: 'done' });

    // The phones the app is gone from are turned off, through the support people's own function: one from its
    // ticket at once, the other from its receipt, which is read holding no business either.
    const reason = async (token: string) =>
      (
        await rows<{ disabled_reason: string | null }>(
          admin(),
          sql`select disabled_reason from app.push_devices where expo_push_token = ${token}`,
        )
      )[0]?.disabled_reason ?? null;
    expect(await reason(tokens.onDead)).toBe('not_registered');
    expect(await reason(tokens.onGone)).toBeNull();
    const notificationId = PushData.parse(iphone.data).notificationId;
    const receipts = await rows<{ id: string; workspace_id: string | null; staff: boolean }>(
      admin(),
      sql`update app.scheduled_jobs set run_at = now(), locked_at = now(), locked_by = ${WORKER_ID}
          where kind = ${PUSH_JOBS.receipts} and status = 'pending'
            and payload ->> 'notificationId' = ${notificationId}
          returning id, workspace_id, (payload ->> 'staff')::boolean as staff`,
    );
    expect(receipts).not.toEqual([]);
    for (const r of receipts) expect(r).toMatchObject({ workspace_id: null, staff: true });
    await processJobs({ ...s, jobs, workerId: WORKER_ID, batchSize: 50, reservedOnly: true });
    expect(await reason(tokens.onGone)).toBe('not_registered');
    expect(await reason(tokens.onIphone)).toBeNull();
  });

  it('never tells a support person about the ticket they wrote themselves', async () => {
    const { ticketId } = await as<{ ticketId: string }>(staffInBusiness, supportRequestCreate, {
      workspaceId: staffBusiness,
      subject: `Trying the help form ${mark}`,
      body: 'Just checking this reaches the desk.',
    });
    await drain();
    expect(tokensOf(sentAbout(ticketId))).toEqual([tokens.onIphone, tokens.onAndroid].sort());
  });

  it('by mail to support@: something new pushes, and their answer on it doesn’t', async () => {
    const subject = `Invoices won’t send ${mark}`;
    const post = (body: unknown) =>
      app.inject({
        method: 'POST',
        url: '/webhooks/postmark/inbound',
        headers: { 'content-type': 'application/json', authorization: basic() },
        payload: JSON.stringify(body),
      });
    const mail = (over: Record<string, unknown> = {}) => ({
      MessageID: randomUUID(),
      From: customer.email,
      FromName: 'Dana Reed',
      FromFull: { Email: customer.email, Name: 'Dana Reed', MailboxHash: '' },
      ToFull: [{ Email: 'support@handsfreeos.test', Name: 'HandsFreeOS Support', MailboxHash: '' }],
      CcFull: [],
      Subject: subject,
      Date: new Date().toUTCString(),
      TextBody: 'Every invoice says it failed to send.',
      Headers: [{ Name: 'Message-ID', Value: `<${randomUUID()}@mail.example.com>` }],
      Attachments: [],
      ...over,
    });
    expect((await post(mail())).statusCode).toBe(200);
    await drain();
    const ticket = await ticketOf(subject);
    const sent = sentAbout(ticket.id);
    expect(tokensOf(sent)).toEqual(
      [tokens.onIphone, tokens.onAndroid, tokens.staffInBusiness].sort(),
    );
    // Mail finds the one business the writer works in, and says so.
    expect(sent.find((m) => m.message.to === tokens.onIphone)!.message).toMatchObject({
      title: `New support ticket #${ticket.number}`,
      subtitle: `Dana Reed · Reed Plumbing ${mark}`,
      body: `${subject}: “Every invoice says it failed to send.”`,
    });

    const [row] = await rows<{ reply_token: string }>(
      admin(),
      sql`select reply_token from platform.tickets where id = ${ticket.id}`,
    );
    const before = s.push.fake.sent.length;
    expect(
      (
        await post(
          mail({
            Subject: `Re: ${subject} [#${ticket.number}]`,
            TextBody: 'Still failing this morning.',
            ToFull: [
              {
                Email: `support+${row!.reply_token}@handsfreeos.test`,
                Name: 'HandsFreeOS Support',
                MailboxHash: row!.reply_token,
              },
            ],
          }),
        )
      ).statusCode,
    ).toBe(200);
    await drain();
    // Their answer went on the same ticket, and nobody's phone buzzed for it.
    expect(sentAbout(ticket.id)).toHaveLength(sent.length);
    expect(
      s.push.fake.sent.slice(before).filter((m) => Object.values(tokens).includes(m.message.to)),
    ).toEqual([]);
  });
});
