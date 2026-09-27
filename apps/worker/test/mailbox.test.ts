import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  executeCommand,
  mailboxConnect,
  mailboxDisconnect,
  messageSend,
  organizationCreate,
  personCreate,
  type HumanActor,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { emailInboundUnmatched, mailboxConnections, messages } from '@hfos/db/schema';
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
import { sha256Hex } from '../src/mailbox/sync';
import type { TokenSet } from '../src/mailbox/provider';
import { processOnce } from '../src/outbox';
import { processors } from '../src/processors/index';
import { jobs } from '../src/scheduled';
import { finishSignIn, testTokenVerifier } from './finish-sign-in';
import { testServices, type TestServices } from './helpers';

const env = testEnv();
const WORKER_ID = `vitest-mailbox-${process.pid}`;
const token = () => randomUUID().slice(0, 8);
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const pdf = (name: string) => ({
  name,
  contentType: 'application/pdf',
  content: Buffer.from(`%PDF-1.4 ${name}`),
  contentId: null,
});

let owner: TestUser;
let workspaceId: string;
let organizationId: string;
let mike: string;
let mikeId: string;
let sarah: string;
let sarahId: string;
let outlook: string;
let outlookId: string;
let s: TestServices;
let app: FastifyInstance;

async function reserve(): Promise<void> {
  for (const table of ['outbox', 'webhook_deliveries', 'scheduled_jobs'])
    await rows(
      admin(),
      sql`update ${sql.raw(`app.${table}`)} set locked_at = now(), locked_by = ${WORKER_ID}
          where status = 'pending' and workspace_id = ${workspaceId}`,
    );
}

/** Runs the outbox, webhook and job loops over this workspace's due work until it is idle. */
async function drain(timeoutMs = 15_000): Promise<void> {
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
        sql`select kind as what, last_error from app.scheduled_jobs
              where workspace_id = ${workspaceId} and last_error is not null
            union all select event_type, last_error from app.outbox
              where workspace_id = ${workspaceId} and last_error is not null and status = 'pending'`,
      );
      throw new Error(`worker work failed: ${JSON.stringify(errors)}`);
    }
    if (!passes.some((p) => p.claimed > 0)) return;
    if (Date.now() > deadline) throw new Error('the worker did not finish in time');
  }
}

/** The mailbox's sync runs now instead of in a minute. */
async function syncNow(connectionId: string): Promise<void> {
  await rows(
    admin(),
    sql`update app.scheduled_jobs set run_at = now()
        where dedupe_key = ${`mailbox.sync:${connectionId}`} and status = 'pending'`,
  );
  await drain();
}

const get = (url: string) => app.inject({ method: 'GET', url });
/** Test setup on a mailbox row, done as the worker: people may only disconnect one. */
const setBox = (id: string, set: Partial<typeof mailboxConnections.$inferInsert>) =>
  asWorker(testDbs().worker.db, { workspaceId, organizationId }, (tx) =>
    tx.update(mailboxConnections).set(set).where(eq(mailboxConnections.id, id)),
  );
const box = async (id: string) =>
  (await admin().select().from(mailboxConnections).where(eq(mailboxConnections.id, id)))[0]!;
const viaMailbox = (connectionId: string) =>
  admin().select().from(messages).where(eq(messages.mailboxConnectionId, connectionId));

/**
 * Signs in through the real routes: connect, start, the fake provider's Allow, the callback, then the app
 * finishing it as the owner.
 */
async function signIn(
  provider: 'microsoft' | 'google',
  account: string,
  decision: 'allow' | 'deny' = 'allow',
): Promise<{ connectionId: string; state: string; location: string }> {
  const { output } = await executeCommand(
    api(),
    mailboxConnect,
    { workspaceId, provider },
    actor(owner),
    meta(),
  );
  const start = await get(`/oauth/${provider}/start?state=${encodeURIComponent(output.state)}`);
  expect(start.statusCode).toBe(302);
  const authorize = new URL(String(start.headers.location));
  expect(authorize.pathname).toBe(`/oauth/fake/${provider}/authorize`);
  const challenge = authorize.searchParams.get('code_challenge')!;
  expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const page = await get(`${authorize.pathname}${authorize.search}`);
  expect(page.statusCode).toBe(200);
  expect(page.body).toContain('No real mailbox is touched');
  const approve = await get(
    `/oauth/fake/${provider}/approve?${new URLSearchParams({
      state: output.state,
      code_challenge: challenge,
      redirect_uri: authorize.searchParams.get('redirect_uri')!,
      email: account,
      decision,
    })}`,
  );
  expect(approve.statusCode).toBe(302);
  const callback = new URL(String(approve.headers.location));
  const back = await finishSignIn(
    app,
    await get(`${callback.pathname}${callback.search}`),
    await signInTestUser(owner),
  );
  expect(back.status).toBe(302);
  await drain();
  return {
    connectionId: output.connectionId,
    state: output.state,
    location: String(back.location),
  };
}

interface MailpitMessage {
  Subject: string;
  To: { Address: string }[];
  Text: string;
}
async function mailTo(to: string, subject: string): Promise<MailpitMessage> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const res = await fetch(
      `${env.mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
    );
    const hit = (
      (await res.json()) as { messages: { ID: string; Subject: string }[] }
    ).messages.find((m) => m.Subject === subject);
    if (hit)
      return (await (
        await fetch(`${env.mailpitUrl}/api/v1/message/${hit.ID}`)
      ).json()) as MailpitMessage;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no "${subject}" email reached ${to}`);
}

beforeAll(async () => {
  owner = await createTestUser('mailbox-worker-owner');
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Mailbox Worker HVAC' },
    actor(owner),
    meta(),
  );
  workspaceId = output.workspaceId;
  organizationId = output.organizationId;
  mike = `mike-${token()}@example.com`;
  sarah = `sarah-${token()}@example.com`;
  outlook = `dale-${token()}@outlook.fake`;
  const person = async (firstName: string, email: string) =>
    (
      await executeCommand(
        api(),
        personCreate,
        { workspaceId, firstName, lastName: 'Customer', email },
        actor(owner),
        meta(),
      )
    ).output.personId;
  mikeId = await person('Mike', mike);
  sarahId = await person('Sarah', sarah);
  s = testServices();
  app = await buildHttpServer({
    ...s,
    httpDb: testDbs().worker.db,
    verifyToken: testTokenVerifier(),
    webOrigins: ['http://localhost:3000'],
  });
});
afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('connecting a mailbox', () => {
  it('signs in with PKCE, seals the tokens, and syncs right away', async () => {
    const signed = await signIn('microsoft', outlook);
    outlookId = signed.connectionId;
    expect(signed.location).toBe(
      `http://localhost:3000/app/w/${workspaceId}/settings/email?mailbox=connected`,
    );
    const m = await box(outlookId);
    expect(m).toMatchObject({ status: 'active', accountEmail: outlook, userId: owner.id });
    // Sealed, not stored in the clear; the one-time state and verifier are gone.
    expect(m.tokenEnc).toMatch(/^v1\./);
    expect(m.tokenEnc).not.toContain('fake-access');
    expect(m.pkceVerifierEnc).toBeNull();
    expect(m.oauthStateHash).toBeNull();
    expect(JSON.parse(s.sealer.open(m.tokenEnc!)) as TokenSet).toMatchObject({
      refreshToken: expect.stringMatching(/^fake-refresh\./),
    });
    // The first sync ran, and Outlook notifications are on.
    expect(m.lastSyncedAt).not.toBeNull();
    expect(m.subscriptionId).toMatch(/^fake-sub-/);
    expect(m.subscriptionClientStateHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a used or unknown sign-in link is a dead end', async () => {
    const used = await get(`/oauth/microsoft/start?state=${encodeURIComponent(randomUUID())}`);
    expect(used.statusCode).toBe(400);
    expect(used.body).toContain('This sign-in link has expired');
    const wrongProvider = await get('/oauth/yahoo/start?state=x');
    expect(wrongProvider.statusCode).toBe(400);
  });

  it('comes back as cancelled when the owner says no, and nothing connects', async () => {
    const signed = await signIn('microsoft', `nobody-${token()}@outlook.fake`, 'deny');
    expect(signed.location).toMatch(/\?mailbox=cancelled$/);
    const m = await box(signed.connectionId);
    expect(m.status).toBe('pending');
    expect(m.lastError).toContain('access_denied');
  });
});

describe('syncing', () => {
  it('brings in mail with customers only, with their attachments; the rest stays private', async () => {
    const stranger = `deals-${token()}@shop.example.com`;
    s.mailboxes.fake.deliver(outlook, {
      from: { address: mike, name: 'Mike Customer' },
      subject: 'Water heater',
      text: 'Is Tuesday OK? The photo of the unit is attached.',
      files: [pdf('unit.pdf')],
    });
    s.mailboxes.fake.deliver(outlook, {
      from: { address: stranger, name: 'Shop Deals' },
      subject: 'This week only',
      text: 'Everything is on sale.',
      files: [pdf('coupon.pdf')],
    });
    await syncNow(outlookId);
    const rowsIn = await viaMailbox(outlookId);
    expect(rowsIn).toHaveLength(1);
    expect(rowsIn[0]).toMatchObject({
      direction: 'inbound',
      status: 'received',
      fromAddress: mike,
      subject: 'Water heater',
    });
    expect(rowsIn[0]!.media.map((m) => m.name)).toEqual(['unit.pdf']);
    // Mail from strangers isn't even set aside as unmatched: a mailbox's other mail is private.
    const unmatched = await admin()
      .select()
      .from(emailInboundUnmatched)
      .where(
        and(
          eq(emailInboundUnmatched.workspaceId, workspaceId),
          eq(emailInboundUnmatched.fromAddress, stranger),
        ),
      );
    expect(unmatched).toHaveLength(0);
  });

  it('a replay from the start lands on the rows it already made', async () => {
    await setBox(outlookId, { syncCursor: {} });
    await syncNow(outlookId);
    expect(await viaMailbox(outlookId)).toHaveLength(1);
  });
});

describe('sending through a mailbox', () => {
  it('replies through Outlook; the Sent copy the next sync finds is the same row', async () => {
    const sent = await executeCommand(
      api(),
      messageSend,
      {
        workspaceId,
        personId: mikeId,
        channel: 'email',
        subject: 'Re: Water heater',
        body: 'Tuesday works. See you then.',
        mailboxConnectionId: outlookId,
      },
      actor(owner),
      meta(),
    );
    await drain();
    const [m] = await admin().select().from(messages).where(eq(messages.id, sent.output.messageId));
    expect(m).toMatchObject({ status: 'sent', mailboxConnectionId: outlookId });
    expect(m!.providerMessageId).toMatch(/^fake-microsoft-sent-/);
    // Outlook assigned its own Message-ID; the row took it.
    expect(m!.messageIdHeader).toMatch(/^<fake-\d+-[0-9a-f]{8}@outlook\.fake>$/);
    const out = s.mailboxes.fake.sent(outlook);
    expect(out.at(-1)).toMatchObject({ subject: 'Re: Water heater', to: [{ address: mike }] });
    await syncNow(outlookId);
    const same = await admin()
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.workspaceId, workspaceId),
          eq(messages.messageIdHeader, m!.messageIdHeader!),
        ),
      );
    expect(same).toHaveLength(1);
  });

  it('Gmail keeps our Message-ID and sends in the customer’s thread', async () => {
    const gmail = `dale-${token()}@gmail.fake`;
    const { connectionId } = await signIn('google', gmail);
    s.mailboxes.fake.deliver(gmail, {
      from: { address: sarah, name: 'Sarah Customer' },
      subject: 'Maintenance plan',
      text: 'Can we do the 18th?',
    });
    await syncNow(connectionId);
    const [inbound] = await viaMailbox(connectionId);
    expect(inbound?.providerThreadId).toMatch(/^fake-thread-/);
    const sent = await executeCommand(
      api(),
      messageSend,
      {
        workspaceId,
        personId: sarahId,
        channel: 'email',
        subject: 'Re: Maintenance plan',
        body: 'The 18th is booked.',
        mailboxConnectionId: connectionId,
      },
      actor(owner),
      meta(),
    );
    const [queued] = await admin()
      .select()
      .from(messages)
      .where(eq(messages.id, sent.output.messageId));
    await drain();
    const [m] = await admin().select().from(messages).where(eq(messages.id, sent.output.messageId));
    expect(m).toMatchObject({ status: 'sent', messageIdHeader: queued!.messageIdHeader });
    expect(s.mailboxes.fake.sent(gmail).at(-1)?.threadId).toBe(inbound!.providerThreadId);
  });
});

describe('Outlook notifications', () => {
  const post = (url: string, body: unknown) =>
    app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
  const nextRun = async () =>
    (
      await rows<{ run_at: Date }>(
        admin(),
        sql`select run_at from app.scheduled_jobs
            where dedupe_key = ${`mailbox.sync:${outlookId}`} and status = 'pending'`,
      )
    )[0]!.run_at;

  it('answers the validation handshake with the token as plain text', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/graph/notifications?validationToken=Validation%3A%20Testing',
      headers: { 'content-type': 'text/plain' },
      payload: '',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.body).toBe('Validation: Testing');
  });

  it('ignores a notification with the wrong clientState; the right one brings the sync forward', async () => {
    const m = await box(outlookId);
    await setBox(outlookId, { subscriptionClientStateHash: sha256Hex('known-state') });
    await rows(
      admin(),
      sql`update app.scheduled_jobs set run_at = now() + interval '1 hour'
          where dedupe_key = ${`mailbox.sync:${outlookId}`} and status = 'pending'`,
    );
    const note = (clientState: string) => ({
      value: [{ subscriptionId: m.subscriptionId, clientState, changeType: 'created' }],
    });
    expect((await post('/webhooks/graph/notifications', note('guessed'))).statusCode).toBe(202);
    expect(new Date(await nextRun()).getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);
    expect((await post('/webhooks/graph/notifications', note('known-state'))).statusCode).toBe(202);
    expect(new Date(await nextRun()).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe('losing access', () => {
  it('a revoked sign-in asks for a reconnect and emails the owner once; syncing stops', async () => {
    // The access token is about to lapse, and the refresh finds the sign-in revoked.
    const m = await box(outlookId);
    const tokens = JSON.parse(s.sealer.open(m.tokenEnc!)) as TokenSet;
    await setBox(outlookId, {
      tokenEnc: s.sealer.seal(JSON.stringify({ ...tokens, expiresAt: new Date(0).toISOString() })),
    });
    s.mailboxes.fake.revoke(outlook);
    await syncNow(outlookId);
    const after = await box(outlookId);
    expect(after.status).toBe('reauth_required');
    expect(after.lastError).toContain('stopped accepting');
    const mail = await mailTo(owner.email, 'Reconnect your Outlook mailbox');
    expect(mail.Text).toContain(outlook);
    expect(mail.Text).toContain('Nothing was lost.');
    // No more syncs until someone reconnects.
    const pending = await rows(
      admin(),
      sql`select 1 from app.scheduled_jobs
          where dedupe_key = ${`mailbox.sync:${outlookId}`} and status = 'pending'`,
    );
    expect(pending).toHaveLength(0);
  });

  it('disconnecting forgets the sign-in', async () => {
    await executeCommand(
      api(),
      mailboxDisconnect,
      { workspaceId, connectionId: outlookId },
      actor(owner),
      meta(),
    );
    const m = await box(outlookId);
    expect(m).toMatchObject({ status: 'disconnected', tokenEnc: null });
  });
});
