import { randomUUID } from 'node:crypto';
import {
  executeCommand,
  executeQuery,
  organizationCreate,
  supportTicketGet,
  supportTicketList,
  supportTicketReply,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
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

/**
 * Support mail, end to end (M13): Postmark's webhook → a ticket → the acknowledgement that goes back →
 * a support person's answer → the customer's reply landing on the same ticket.
 *
 * Nothing here belongs to a business, which is the point: the work is claimed, handled and sent with no
 * tenant scope at all.
 */
const env = testEnv();
const WORKER_ID = `vitest-support-${process.pid}`;
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const basic = () => `Basic ${Buffer.from(`postmark:${LOCAL_WEBHOOK_PASSWORD}`).toString('base64')}`;

let agent: TestUser;
let customer: TestUser;
/** The database keeps rows between runs, so this run's ticket has a subject only this run uses. */
const mark = randomUUID().slice(0, 8);
const SUBJECT = `Reminders stopped going out ${mark}`;
let s: TestServices;
let app: FastifyInstance;

/** Reserves the platform's own work (it has no workspace) and runs the loops until they are idle. */
async function drain(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const table of ['outbox', 'webhook_deliveries', 'scheduled_jobs'])
      await rows(
        admin(),
        sql`update ${sql.raw(`app.${table}`)} set locked_at = now(), locked_by = ${WORKER_ID}
            where status = 'pending' and workspace_id is null`,
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
        sql`select kind as what, last_error from app.webhook_deliveries
              where workspace_id is null and last_error is not null
            union all select event_type, last_error from app.outbox
              where workspace_id is null and last_error is not null`,
      );
      throw new Error(`support work failed: ${JSON.stringify(errors)}`);
    }
    if (!passes.some((p) => p.claimed > 0)) return;
    if (Date.now() > deadline) throw new Error('the worker did not finish in time');
  }
}

interface MailpitMessage {
  Subject: string;
  ReplyTo: { Address: string }[];
  From: { Name: string; Address: string };
  Text: string;
}
async function mailTo(to: string, subjectPart: string): Promise<MailpitMessage> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const res = await fetch(
      `${env.mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
    );
    const hit = (
      (await res.json()) as { messages: { ID: string; Subject: string }[] }
    ).messages.find((m) => m.Subject.includes(subjectPart));
    if (hit)
      return (await (
        await fetch(`${env.mailpitUrl}/api/v1/message/${hit.ID}`)
      ).json()) as MailpitMessage;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no email about "${subjectPart}" reached ${to}`);
}

/** Mail arriving at support@, the way Postmark's inbound webhook delivers it. */
const inbound = (over: Record<string, unknown> = {}) => ({
  MessageID: randomUUID(),
  From: customer.email,
  FromName: 'Dana Reed',
  FromFull: { Email: customer.email, Name: 'Dana Reed', MailboxHash: '' },
  ToFull: [{ Email: 'support@handsfreeos.test', Name: 'HandsFreeOS Support', MailboxHash: '' }],
  CcFull: [],
  Subject: SUBJECT,
  Date: new Date().toUTCString(),
  TextBody: 'They went out on Monday and not since. Nothing changed at our end.',
  HtmlBody: '<p>They went out on Monday and not since.</p>',
  Headers: [{ Name: 'Message-ID', Value: `<${randomUUID()}@mail.example.com>` }],
  Attachments: [],
  ...over,
});

const post = (body: unknown) =>
  app.inject({
    method: 'POST',
    url: '/webhooks/postmark/inbound',
    headers: { 'content-type': 'application/json', authorization: basic() },
    payload: JSON.stringify(body),
  });

beforeAll(async () => {
  [agent, customer] = await Promise.all([
    createTestUser('support-desk-agent'),
    createTestUser('support-desk-customer'),
  ]);
  // The customer has a business, so their mail should find it without anybody linking it by hand.
  await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Reed Plumbing' },
    actor(customer),
    meta(),
  );
  await admin().execute(
    sql`insert into platform.staff (user_id, role, display_name) values (${agent.id}, 'lead', 'Sam')
        on conflict (user_id) do update set role = 'lead', status = 'active'`,
  );
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

describe('mail to support@ becomes a ticket', () => {
  let ticketId: string;
  let number: number;
  let replyToken: string;

  it('files it, finds the business it is about, and says it arrived', async () => {
    const mail = inbound();
    expect((await post(mail)).statusCode).toBe(200);
    await drain();

    const found = await executeQuery(
      api(),
      supportTicketList,
      { search: mark },
      actor(agent),
      meta(),
    );
    expect(found.tickets).toHaveLength(1);
    const ticket = found.tickets[0]!;
    ticketId = ticket.id;
    number = ticket.number;
    expect(ticket.status).toBe('new');
    expect(ticket.channel).toBe('email');
    expect(ticket.requester.email).toBe(customer.email.toLowerCase());
    // The address belongs to one of our users, in exactly one business: nobody had to ask which.
    expect(ticket.business?.name).toBe('Reed Plumbing');

    const ack = await mailTo(customer.email, `#${number}`);
    expect(ack.Subject).toContain('We have your message');
    expect(ack.Text).toContain(`ticket #${number}`);
    const [row] = await rows<{ reply_token: string }>(
      admin(),
      sql`select reply_token from platform.tickets where id = ${ticketId}`,
    );
    replyToken = row!.reply_token;
    // Their reply comes back to the ticket, not to a mailbox.
    expect(ack.ReplyTo[0]?.Address).toBe(`support+${replyToken}@handsfreeos.test`);
  });

  it('sends a support person’s answer, and keeps a note to itself', async () => {
    await executeCommand(
      api(),
      supportTicketReply,
      { ticketId, body: 'Checking the reminder job now — nothing looks wrong at your end.' },
      actor(agent),
      meta(),
    );
    await drain();
    const sent = await mailTo(customer.email, `Re: ${SUBJECT} [#${number}]`);
    expect(sent.Text).toContain('Checking the reminder job now');
    expect(sent.From.Name).toContain('Sam');

    await executeCommand(
      api(),
      supportTicketReply,
      { ticketId, body: 'Their worker had a bad deploy on Monday.', internal: true },
      actor(agent),
      meta(),
    );
    await drain();
    const ticket = await executeQuery(api(), supportTicketGet, { ticketId }, actor(agent), meta());
    // Answering it takes it, and it now waits on them.
    expect(ticket.ticket.status).toBe('waiting_on_customer');
    expect(ticket.ticket.assignee?.userId).toBe(agent.id);
    expect(ticket.messages.filter((m) => m.internal)).toHaveLength(1);
    // The note stayed here: only the answer was sent.
    const outbound = ticket.messages.filter((m) => m.author === 'staff');
    expect(outbound).toHaveLength(2);
  });

  it('puts their reply back on the same ticket, and reopens it', async () => {
    const reply = inbound({
      Subject: `Re: ${SUBJECT} [#${number}]`,
      TextBody: 'Thanks — it started again this morning.',
      ToFull: [
        {
          Email: `support+${replyToken}@handsfreeos.test`,
          Name: 'HandsFreeOS Support',
          MailboxHash: replyToken,
        },
      ],
    });
    expect((await post(reply)).statusCode).toBe(200);
    await drain();
    const ticket = await executeQuery(api(), supportTicketGet, { ticketId }, actor(agent), meta());
    expect(ticket.ticket.status).toBe('open');
    expect(ticket.messages.at(-1)?.bodyText).toContain('started again this morning');
  });

  it('drops an automatic reply instead of answering it', async () => {
    const before = await executeQuery(api(), supportTicketGet, { ticketId }, actor(agent), meta());
    const away = inbound({
      Subject: `Out of office ${mark}`,
      Headers: [
        { Name: 'Message-ID', Value: `<${randomUUID()}@mail.example.com>` },
        { Name: 'Auto-Submitted', Value: 'auto-replied' },
      ],
    });
    expect((await post(away)).statusCode).toBe(200);
    await drain();
    const after = await executeQuery(api(), supportTicketGet, { ticketId }, actor(agent), meta());
    expect(after.messages).toHaveLength(before.messages.length);
    const stillOne = await executeQuery(
      api(),
      supportTicketList,
      { search: 'Out of office' },
      actor(agent),
      meta(),
    );
    expect(stillOne.tickets).toEqual([]);
  });
});

describe('the desk belongs to the people who work here', () => {
  it('refuses a business owner who asks for the queue', async () => {
    await expect(
      executeQuery(api(), supportTicketList, {}, actor(customer), meta()),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses a business owner who tries to answer a ticket', async () => {
    const [t] = await rows<{ id: string }>(
      admin(),
      sql`select id from platform.tickets order by created_at desc limit 1`,
    );
    await expect(
      executeCommand(
        api(),
        supportTicketReply,
        { ticketId: t!.id, body: 'Let me in' },
        actor(customer),
        meta(),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
