import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  emailClaimUnmatched,
  emailDomainAdd,
  emailDomainRemove,
  emailDomainVerify,
  executeCommand,
  messageSend,
  organizationCreate,
  personCreate,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { conversations, messages } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, testEnv, type TestUser } from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processDeliveries } from '../src/deliveries';
import { LOCAL_WEBHOOK_PASSWORD } from '../src/email/local';
import { handlers } from '../src/handlers/index';
import { buildHttpServer } from '../src/http/server';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { processors } from '../src/processors/index';
import { jobs } from '../src/scheduled';
import { testServices, type TestServices } from './helpers';

const env = testEnv();
const WORKER_ID = `vitest-email-${process.pid}`;
/** A 1x1 PNG, as an inline image and an attachment. */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
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
const basic = (password = LOCAL_WEBHOOK_PASSWORD) =>
  `Basic ${Buffer.from(`postmark:${password}`).toString('base64')}`;

let owner: TestUser;
let workspaceId: string;
let organizationId: string;
let mike: string;
let mikeId: string;
let shared: { id: string; address: string; local: string };
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

const post = (path: string, body: unknown, authorization = basic()) =>
  app.inject({
    method: 'POST',
    url: path,
    headers: { 'content-type': 'application/json', authorization },
    payload: JSON.stringify(body),
  });

const message = async (id: string) =>
  (await admin().select().from(messages).where(eq(messages.id, id)))[0]!;

interface MailpitSummary {
  ID: string;
  Subject: string;
}
interface MailpitMessage {
  MessageID: string;
  Subject: string;
  ReplyTo: { Name: string; Address: string }[];
  From: { Name: string; Address: string };
  Text: string;
}
async function mailTo(to: string, subject: string): Promise<MailpitMessage> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const res = await fetch(
      `${env.mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
    );
    const hit = ((await res.json()) as { messages: MailpitSummary[] }).messages.find(
      (m) => m.Subject === subject,
    );
    if (hit)
      return (await (
        await fetch(`${env.mailpitUrl}/api/v1/message/${hit.ID}`)
      ).json()) as MailpitMessage;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no "${subject}" email reached ${to}`);
}

/** Mike's email to the business, the way Postmark's inbound webhook delivers it. */
const inbound = (over: Record<string, unknown> = {}) => ({
  MessageID: randomUUID(),
  From: mike,
  FromName: 'Mike Johnson',
  FromFull: { Email: mike, Name: 'Mike Johnson', MailboxHash: '' },
  ToFull: [{ Email: shared.address, Name: 'Email Worker HVAC', MailboxHash: '' }],
  CcFull: [],
  Subject: 'Question',
  Date: new Date().toUTCString(),
  TextBody: 'Hello there',
  HtmlBody: '<p>Hello there</p>',
  Headers: [{ Name: 'Message-ID', Value: `<${randomUUID()}@mail.example.com>` }],
  Attachments: [],
  ...over,
});

beforeAll(async () => {
  owner = await createTestUser('email-worker-owner');
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Email Worker HVAC' },
    actor(owner),
    meta(),
  );
  workspaceId = output.workspaceId;
  organizationId = output.organizationId;
  mike = `mike-${token()}@example.com`;
  mikeId = (
    await executeCommand(
      api(),
      personCreate,
      { workspaceId, firstName: 'Mike', lastName: 'Johnson', email: mike },
      actor(owner),
      meta(),
    )
  ).output.personId;
  const [a] = await rows<{ id: string; address: string; local_part: string }>(
    admin(),
    sql`select id, address, local_part from app.email_addresses where workspace_id = ${workspaceId} and is_default`,
  );
  shared = { id: a!.id, address: a!.address, local: a!.local_part };
  s = testServices();
  app = await buildHttpServer({
    ...s,
    httpDb: testDbs().worker.db,
    verifyToken: null,
    webOrigins: ['http://localhost:3000'],
  });
});
afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('sending', () => {
  it('goes out from the shared address with our Message-ID and a Reply-To that names the conversation', async () => {
    const subject = `Your roof estimate ${token()}`;
    const sent = await executeCommand(
      api(),
      messageSend,
      {
        workspaceId,
        personId: mikeId,
        channel: 'email',
        subject,
        body: 'Hi Mike,\n\nIt’s attached.',
      },
      actor(owner),
      meta(),
    );
    await drain();
    const m = await message(sent.output.messageId);
    expect(m.status).toBe('sent');
    expect(m.providerMessageId).toMatch(/^local-/);
    const [c] = await admin()
      .select()
      .from(conversations)
      .where(eq(conversations.id, sent.output.conversationId));
    const mail = await mailTo(mike, subject);
    expect(mail.From).toMatchObject({ Name: 'Email Worker HVAC', Address: shared.address });
    expect(mail.ReplyTo[0]!.Address).toBe(
      `${shared.local}+${c!.emailReplyToken}@mail.handsfreeos.com`,
    );
    expect(`<${mail.MessageID}>`).toBe(m.messageIdHeader);
    expect(mail.Text).toContain('It’s attached.');
  });
});

describe('inbound mail', () => {
  it('a reply by Reply-To token lands in the thread, sanitized, with its attachments stored', async () => {
    const [conv] = await admin()
      .select()
      .from(conversations)
      .where(eq(conversations.counterpart, mike));
    const replyTo = `${shared.local}+${conv!.emailReplyToken}@mail.handsfreeos.com`;
    const payload = inbound({
      ToFull: [{ Email: replyTo, Name: 'Email Worker HVAC', MailboxHash: conv!.emailReplyToken }],
      Subject: 'Re: Your roof estimate',
      TextBody: 'Sounds good.\n\nOn Tuesday you wrote: …',
      StrippedTextReply: 'Sounds good.',
      HtmlBody:
        '<p>Sounds good. <img src="cid:photo.png@part"><img src="https://tracker.example.com/p.gif"></p><script>alert(1)</script>',
      Attachments: [
        {
          Name: 'photo.png',
          Content: PNG,
          ContentType: 'image/png',
          ContentLength: 68,
          ContentID: 'photo.png@part',
        },
      ],
    });
    expect((await post('/webhooks/postmark/inbound', payload)).statusCode).toBe(200);
    await drain();
    const [m] = await admin()
      .select()
      .from(messages)
      .where(eq(messages.providerMessageId, payload.MessageID));
    expect(m).toMatchObject({
      conversationId: conv!.id,
      direction: 'inbound',
      bodyText: 'Sounds good.',
      subject: 'Re: Your roof estimate',
    });
    expect(m!.bodyHtml).toContain('data-hfos-media="0"');
    expect(m!.bodyHtml).toContain('data-remote-src="https://tracker.example.com/p.gif"');
    expect(m!.bodyHtml).not.toContain('<script');
    expect(m!.media[0]!.objectPath).toMatch(new RegExp(`^${workspaceId}/email/`));
    expect(await s.store.exists('telephony', m!.media[0]!.objectPath)).toBe(true);
  });

  it('refuses webhooks without the password, drops mail for nobody, and ignores automatic replies', async () => {
    const wrong = inbound();
    expect(
      (await post('/webhooks/postmark/inbound', wrong, basic('not-the-password'))).statusCode,
    ).toBe(403);
    const nobody = inbound({ ToFull: [{ Email: `nobody-${token()}@mail.handsfreeos.com` }] });
    expect((await post('/webhooks/postmark/inbound', nobody)).statusCode).toBe(200);
    const auto = inbound({
      Headers: [
        { Name: 'Message-ID', Value: `<${randomUUID()}@mail.example.com>` },
        { Name: 'Auto-Submitted', Value: 'auto-replied' },
      ],
      Subject: 'Out of office',
    });
    expect((await post('/webhooks/postmark/inbound', auto)).statusCode).toBe(200);
    await drain();
    for (const id of [wrong.MessageID, nobody.MessageID, auto.MessageID]) {
      const [m] = await admin().select().from(messages).where(eq(messages.providerMessageId, id));
      expect(m).toBeUndefined();
    }
    const stored = await rows(
      admin(),
      sql`select 1 from app.webhook_deliveries where dedupe_key in (${`inbound:${wrong.MessageID}`}, ${`inbound:${nobody.MessageID}`})`,
    );
    expect(stored).toHaveLength(0);
  });
});

describe('delivery reports', () => {
  it('delivered, then a hard bounce that stops the address; soft bounces change nothing', async () => {
    const subject = `Reminder ${token()}`;
    const first = await executeCommand(
      api(),
      messageSend,
      { workspaceId, personId: mikeId, channel: 'email', subject, body: 'See you tomorrow.' },
      actor(owner),
      meta(),
    );
    await drain();
    const m = await message(first.output.messageId);
    const report = (over: Record<string, unknown>) =>
      post('/webhooks/postmark/events', {
        MessageID: m.providerMessageId,
        Metadata: { messageId: m.id, workspaceId, organizationId },
        ...over,
      });
    expect(
      (
        await report({
          RecordType: 'Delivery',
          Recipient: mike,
          DeliveredAt: new Date().toISOString(),
        })
      ).statusCode,
    ).toBe(200);
    await drain();
    expect((await message(m.id)).status).toBe('delivered');

    // A soft bounce: the mail service keeps trying.
    await report({
      RecordType: 'Bounce',
      Type: 'SoftBounce',
      Inactive: false,
      Email: mike,
      BouncedAt: new Date().toISOString(),
    });
    await drain();
    expect((await message(m.id)).status).toBe('delivered');

    const second = await executeCommand(
      api(),
      messageSend,
      {
        workspaceId,
        personId: mikeId,
        channel: 'email',
        subject: `${subject} again`,
        body: 'Hello?',
      },
      actor(owner),
      meta(),
    );
    await drain();
    const m2 = await message(second.output.messageId);
    await post('/webhooks/postmark/events', {
      RecordType: 'Bounce',
      Type: 'HardBounce',
      Inactive: true,
      Email: mike,
      Description: 'Unknown user',
      BouncedAt: new Date().toISOString(),
      MessageID: m2.providerMessageId,
      Metadata: { messageId: m2.id, workspaceId, organizationId },
    });
    await drain();
    expect(await message(m2.id)).toMatchObject({
      status: 'bounced',
      errorMessage: 'that address doesn’t exist',
    });
    const stopped = await rows<{ reason: string }>(
      admin(),
      sql`select reason::text as reason from app.email_suppressions
          where workspace_id = ${workspaceId} and address = ${mike} and released_at is null`,
    );
    expect(stopped).toEqual([{ reason: 'hard_bounce' }]);

    // Platform mail carries no workspace: accepted and dropped.
    expect(
      (await post('/webhooks/postmark/events', { RecordType: 'Delivery', MessageID: 'platform-1' }))
        .statusCode,
    ).toBe(200);
  });
});

describe('a workspace domain', () => {
  it('is created at the mail service, verifies when asked, and goes away', async () => {
    const domain = `${token()}.example.com`;
    const added = await executeCommand(
      api(),
      emailDomainAdd,
      { workspaceId, domain },
      actor(owner),
      meta(),
    );
    const id = added.output.emailDomainId;
    await drain();
    const row = async () =>
      (
        await rows<{
          status: string;
          dkim_host: string | null;
          provider_domain_id: string | null;
          return_path_host: string | null;
        }>(
          admin(),
          sql`select status::text as status, dkim_host, provider_domain_id, return_path_host
              from app.email_domains where id = ${id}`,
        )
      )[0];
    expect(await row()).toMatchObject({
      status: 'pending',
      provider_domain_id: `local-${domain}`,
      dkim_host: `20260912000000pm._domainkey.${domain}`,
      return_path_host: `pm-bounces.${domain}`,
    });
    await executeCommand(
      api(),
      emailDomainVerify,
      { workspaceId, emailDomainId: id },
      actor(owner),
      meta(),
    );
    await drain();
    expect((await row())?.status).toBe('verified');
    await executeCommand(
      api(),
      emailDomainRemove,
      { workspaceId, emailDomainId: id },
      actor(owner),
      meta(),
    );
    await drain();
    expect(await row()).toBeUndefined();
  });
});

describe('mail from someone we don’t know', () => {
  it('waits aside until someone claims it for a customer, then joins a thread linked to them', async () => {
    const stranger = `karen-${token()}@example.com`;
    const payload = inbound({
      From: stranger,
      FromName: 'Karen Liu',
      FromFull: { Email: stranger, Name: 'Karen Liu' },
      Subject: 'Quote for an AC tune-up?',
      TextBody: 'How much is a tune-up?',
      HtmlBody: undefined,
    });
    expect((await post('/webhooks/postmark/inbound', payload)).statusCode).toBe(200);
    await drain();
    const [u] = await rows<{ id: string }>(
      admin(),
      sql`select id from app.email_inbound_unmatched where workspace_id = ${workspaceId} and from_address = ${stranger}`,
    );
    expect(u).toBeTruthy();
    await executeCommand(
      api(),
      emailClaimUnmatched,
      { workspaceId, unmatchedId: u!.id, personId: mikeId },
      actor(owner),
      meta(),
    );
    await drain();
    const [claimed] = await rows<{ resolved_message_id: string | null }>(
      admin(),
      sql`select resolved_message_id from app.email_inbound_unmatched where id = ${u!.id}`,
    );
    const m = await message(claimed!.resolved_message_id!);
    expect(m).toMatchObject({
      direction: 'inbound',
      subject: 'Quote for an AC tune-up?',
      bodyText: 'How much is a tune-up?',
    });
    const [c] = await admin()
      .select()
      .from(conversations)
      .where(eq(conversations.id, m.conversationId));
    expect(c).toMatchObject({ counterpart: stranger, personId: mikeId });
  });
});
