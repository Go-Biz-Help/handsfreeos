/**
 * Indeed by email (funnels), through the worker's own Postmark route and processor, on the real database, with the
 * scripted AI.
 *
 * What's worth holding:
 *   - Indeed's mail never becomes somebody who emailed in: it's filed in Other mail;
 *   - an applicant becomes a customer and a lead only once the business turns Indeed on, once per email;
 *   - Indeed's other mail (a job going live) opens nothing;
 *   - without the AI the email's own shapes are read, so an applicant isn't lost to it.
 */
import { randomUUID } from 'node:crypto';
import {
  executeCommand,
  intakeSourceUpdate,
  organizationCreate,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scriptedAi } from '../src/ai/scripted';
import { processDeliveries } from '../src/deliveries';
import { fileIndeedApplicant } from '../src/email/indeed';
import { LOCAL_WEBHOOK_PASSWORD } from '../src/email/local';
import { handlers } from '../src/handlers/index';
import { buildHttpServer } from '../src/http/server';
import { processOnce } from '../src/outbox';
import { processors } from '../src/processors/index';
import { testServices, type TestServices } from './helpers';

const WORKER_ID = `vitest-indeed-${process.pid}`;
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const basic = `Basic ${Buffer.from(`postmark:${LOCAL_WEBHOOK_PASSWORD}`).toString('base64')}`;

let owner: TestUser;
let workspaceId: string;
let organizationId: string;
let address: string;
let s: TestServices;
let app: FastifyInstance;

async function drain(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    for (const table of ['outbox', 'webhook_deliveries'])
      await rows(
        admin(),
        sql`update ${sql.raw(`app.${table}`)} set locked_at = now(), locked_by = ${WORKER_ID}
            where status = 'pending' and workspace_id = ${workspaceId}`,
      );
    const d = { ...s, workerId: WORKER_ID, batchSize: 100, reservedOnly: true };
    const passes = [
      await processDeliveries({ ...d, processors }),
      await processOnce({ ...d, handlers }),
    ];
    if (passes.some((p) => p.retried + p.failed > 0)) throw new Error('worker work failed');
    if (!passes.some((p) => p.claimed > 0)) return;
  }
}

/** Indeed's email about an applicant, the way Postmark's inbound webhook delivers it. */
const fromIndeed = (over: { subject?: string; text?: string; messageId?: string } = {}) => ({
  MessageID: randomUUID(),
  From: 'noreply@indeed.com',
  FromName: 'Indeed',
  FromFull: { Email: 'noreply@indeed.com', Name: 'Indeed', MailboxHash: '' },
  ToFull: [{ Email: address, Name: '', MailboxHash: '' }],
  CcFull: [],
  Subject: over.subject ?? 'Jordan Reyes applied to Sales Associate',
  Date: new Date().toUTCString(),
  TextBody:
    over.text ??
    'Jordan Reyes applied to your job Sales Associate in Austin, TX.\n' +
      'Email: jordanreyes-4kq@indeedemail.com\nPhone: (512) 555-0801\nView resume on Indeed.',
  Headers: [{ Name: 'Message-ID', Value: over.messageId ?? `<${randomUUID()}@indeed.com>` }],
  Attachments: [],
});
const post = (body: unknown) =>
  app.inject({
    method: 'POST',
    url: '/webhooks/postmark/inbound',
    headers: { 'content-type': 'application/json', authorization: basic },
    payload: JSON.stringify(body),
  });

const applicants = () =>
  rows<{ id: string; first_name: string; email: string | null; phone_e164: string | null }>(
    admin(),
    sql`select id, first_name, email, phone_e164 from app.people
        where workspace_id = ${workspaceId} and source = 'Indeed' order by created_at`,
  );

beforeAll(async () => {
  owner = await createTestUser('indeed-owner');
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Bright Team' },
    actor(owner),
    meta(),
  );
  workspaceId = output.workspaceId;
  organizationId = output.organizationId;
  const [a] = await rows<{ address: string }>(
    admin(),
    sql`select address from app.email_addresses where workspace_id = ${workspaceId} and is_default`,
  );
  address = a!.address;
  s = testServices({ ai: { provider: scriptedAi(), dailyTokens: 2_000_000 } });
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

describe('an applicant Indeed emailed about', () => {
  it('opens nothing while Indeed is off, and Indeed never counts as somebody who emailed in', async () => {
    expect((await post(fromIndeed())).statusCode).toBe(200);
    await drain();
    expect(await applicants()).toEqual([]);
    const noreply = await rows(
      admin(),
      sql`select 1 from app.people where workspace_id = ${workspaceId} and email = 'noreply@indeed.com'`,
    );
    expect(noreply).toEqual([]);
    const [thread] = await rows<{ folder: string }>(
      admin(),
      sql`select folder::text as folder from app.conversations
          where workspace_id = ${workspaceId} and counterpart = 'noreply@indeed.com'`,
    );
    expect(thread?.folder).toBe('other');
  });

  it('becomes a customer and a lead once Indeed is on, once per email', async () => {
    await executeCommand(
      api(),
      intakeSourceUpdate,
      { workspaceId, kind: 'indeed', active: true },
      actor(owner),
      meta(),
    );
    const messageId = `<${randomUUID()}@indeed.com>`;
    expect((await post(fromIndeed({ messageId }))).statusCode).toBe(200);
    await drain();
    const [jordan, ...more] = await applicants();
    expect(more).toEqual([]);
    expect(jordan).toMatchObject({
      first_name: 'Jordan',
      email: 'jordanreyes-4kq@indeedemail.com',
      phone_e164: '+15125550801',
    });
    const leads = await rows<{ title: string; source: string }>(
      admin(),
      sql`select title, source from app.leads where person_id = ${jordan!.id}`,
    );
    expect(leads).toEqual([{ title: 'Jordan Reyes (Indeed: Sales Associate)', source: 'Indeed' }]);
    // Read by the AI, and counted as such.
    const used = await rows(
      admin(),
      sql`select 1 from app.ai_usage where workspace_id = ${workspaceId} and source = 'lead_intake'`,
    );
    expect(used.length).toBeGreaterThan(0);

    // The same email again (a forward, a second inbox): still one lead.
    expect((await post(fromIndeed({ messageId }))).statusCode).toBe(200);
    await drain();
    const again = await rows(admin(), sql`select 1 from app.leads where person_id = ${jordan!.id}`);
    expect(again).toHaveLength(1);
  });

  it('opens nothing for Indeed’s other mail', async () => {
    const before = (await applicants()).length;
    await post(
      fromIndeed({ subject: 'Your job post is now live: Sales Associate', text: 'Good news!' }),
    );
    await drain();
    expect(await applicants()).toHaveLength(before);
  });

  it('reads the email’s own shapes when the AI isn’t there', async () => {
    const without = testServices({ ai: { provider: null, dailyTokens: 2_000_000 } });
    const out = await fileIndeedApplicant(
      without,
      { workspaceId, organizationId },
      {
        from: { address: 'noreply@indeed.com', name: 'Indeed' },
        subject: 'Sam Ortiz applied to Crew Lead',
        text: 'Contact: samortiz-77@indeedemail.com',
        key: `<${randomUUID()}@indeed.com>`,
      },
    );
    expect(out).toBe('filed');
    const sam = (await applicants()).find((p) => p.first_name === 'Sam');
    expect(sam?.email).toBe('samortiz-77@indeedemail.com');
  });
});
