/**
 * A business receiving its own mail (M19, step 1), through the worker: Postmark's inbound webhook routing mail
 * for a receiving domain, the support desk keeping its own addresses, the MX checks that turn a domain on, and
 * mail going out with no Reply-To once replies can come straight back.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  emailAddressCreate,
  emailDomainAdd,
  emailDomainReceive,
  executeCommand,
  messageSend,
  organizationCreate,
  personCreate,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { messages } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, testEnv, type TestUser } from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { processDeliveries } from '../src/deliveries';
import { LOCAL_WEBHOOK_PASSWORD } from '../src/email/local';
import {
  EMAIL_RECEIVING_CHECK_JOB,
  onEmailDomainRemoved,
  receivingCheckKey,
} from '../src/handlers/email';
import { handlers } from '../src/handlers/index';
import { buildHttpServer } from '../src/http/server';
import { processJobs, type JobRow } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { processors } from '../src/processors/index';
import { checkEmailDomains, checkEmailReceivingJob, jobs } from '../src/scheduled';
import { testServices, type TestServices } from './helpers';

const env = testEnv();
const WORKER_ID = `vitest-receiving-${process.pid}`;
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
const basic = `Basic ${Buffer.from(`postmark:${LOCAL_WEBHOOK_PASSWORD}`).toString('base64')}`;

let owner: TestUser;
let workspaceId: string;
let organizationId: string;
let mike: string;
let mikeId: string;
let fallbackId: string;
let s: TestServices;
let app: FastifyInstance;
/** The support desk's domain in this suite. The business receives on it too, as HandsFreeOS's own does. */
let supportDomain: string;

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
              where workspace_id = ${workspaceId} and last_error is not null and status = 'pending'
            union all select kind, last_error from app.scheduled_jobs
              where workspace_id = ${workspaceId} and last_error is not null and status = 'pending'`,
      );
      throw new Error(`worker work failed: ${JSON.stringify(errors)}`);
    }
    if (!passes.some((p) => p.claimed > 0)) return;
    if (Date.now() > deadline) throw new Error('the worker did not finish in time');
  }
}

const post = (body: unknown) =>
  app.inject({
    method: 'POST',
    url: '/webhooks/postmark/inbound',
    headers: { 'content-type': 'application/json', authorization: basic },
    payload: JSON.stringify(body),
  });

/** Mike's email, the way Postmark's inbound webhook delivers it. */
const inbound = (to: string, over: Record<string, unknown> = {}) => ({
  MessageID: randomUUID(),
  From: mike,
  FromName: 'Mike Johnson',
  FromFull: { Email: mike, Name: 'Mike Johnson', MailboxHash: '' },
  ToFull: [{ Email: to, Name: '', MailboxHash: '' }],
  CcFull: [],
  OriginalRecipient: to,
  Subject: 'Question',
  Date: new Date().toUTCString(),
  TextBody: 'Hello there',
  HtmlBody: '<p>Hello there</p>',
  Headers: [{ Name: 'Message-ID', Value: `<${randomUUID()}@mail.example.com>` }],
  Attachments: [],
  ...over,
});

const filed = async (providerMessageId: string) =>
  (
    await admin().select().from(messages).where(eq(messages.providerMessageId, providerMessageId))
  )[0];

/** A verified domain of the business's, receiving or not, with an address on it. */
async function domainWith(
  domain: string,
  receiving: 'off' | 'on',
  localPart = 'chris',
): Promise<{ domainId: string; addressId: string }> {
  const { emailDomainId } = (
    await executeCommand(api(), emailDomainAdd, { workspaceId, domain }, actor(owner), meta())
  ).output;
  await drain();
  await rows(
    admin(),
    sql`update app.email_domains set status = 'verified', dkim_verified_at = now(), return_path_verified_at = now(),
          receiving = ${receiving}::app.email_receiving_status
        where id = ${emailDomainId}`,
  );
  const { emailAddressId } = (
    await executeCommand(
      api(),
      emailAddressCreate,
      { workspaceId, emailDomainId, localPart, displayName: 'Receiving HVAC', isDefault: false },
      actor(owner),
      meta(),
    )
  ).output;
  return { domainId: emailDomainId, addressId: emailAddressId };
}

const receivingOf = async (id: string) =>
  (
    await rows<{ receiving: string }>(
      admin(),
      sql`select receiving::text as receiving from app.email_domains where id = ${id}`,
    )
  )[0]!.receiving;

beforeAll(async () => {
  owner = await createTestUser('receiving-worker-owner');
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Receiving HVAC' },
    actor(owner),
    meta(),
  );
  workspaceId = output.workspaceId;
  organizationId = output.organizationId;
  // Until every business can (M19 step 6), only HandsFreeOS's own turns receiving on.
  await rows(admin(), sql`update app.workspaces set is_platform = true where id = ${workspaceId}`);
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
  const [a] = await rows<{ id: string }>(
    admin(),
    sql`select id from app.email_addresses where workspace_id = ${workspaceId} and is_default`,
  );
  fallbackId = a!.id;
  supportDomain = `support-${token()}.example.com`;
  s = testServices();
  app = await buildHttpServer({
    ...s,
    support: { ...s.support, mailDomain: supportDomain },
    httpDb: testDbs().worker.db,
    verifyToken: null,
    webOrigins: ['http://localhost:3000'],
  });
});
// A business holds up to 3 domains: each test's go when it's done.
afterEach(async () => {
  await rows(admin(), sql`delete from app.email_domains where workspace_id = ${workspaceId}`);
});
afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('mail to a receiving domain', () => {
  it('lands in its address’s lane, and mail for a name nobody has goes to the default address', async () => {
    const domain = `recv-${token()}.example.com`;
    const { addressId } = await domainWith(domain, 'on');
    const toChris = inbound(`Chris+invoices@${domain.toUpperCase()}`);
    const toNobody = inbound(`sales@${domain}`);
    for (const p of [toChris, toNobody]) expect((await post(p)).statusCode).toBe(200);
    await drain();
    expect(await filed(toChris.MessageID)).toMatchObject({
      direction: 'inbound',
      emailAddressId: addressId,
      subject: 'Question',
    });
    expect((await filed(toNobody.MessageID))?.emailAddressId).toBe(fallbackId);
  });

  it('goes by the address it was delivered to, before any address the headers name', async () => {
    const domain = `envelope-${token()}.example.com`;
    const { addressId } = await domainWith(domain, 'on');
    const [shared] = await rows<{ address: string }>(
      admin(),
      sql`select address from app.email_addresses where id = ${fallbackId}`,
    );
    const p = inbound(`chris@${domain}`, { ToFull: [{ Email: shared!.address, MailboxHash: '' }] });
    expect((await post(p)).statusCode).toBe(200);
    await drain();
    expect((await filed(p.MessageID))?.emailAddressId).toBe(addressId);
  });

  it('is dropped while the domain doesn’t receive', async () => {
    const domain = `off-${token()}.example.com`;
    await domainWith(domain, 'off');
    const p = inbound(`chris@${domain}`);
    expect((await post(p)).statusCode).toBe(200);
    await drain();
    expect(await filed(p.MessageID)).toBeUndefined();
  });

  it('never takes the support desk’s addresses, even on a domain the business receives', async () => {
    const { addressId } = await domainWith(supportDomain, 'on', 'chris');
    const toSupport = inbound(`support@${supportDomain}`);
    const toChris = inbound(`chris@${supportDomain}`);
    for (const p of [toSupport, toChris]) expect((await post(p)).statusCode).toBe(200);
    const [ticket] = await rows<{ kind: string; workspace_id: string | null }>(
      admin(),
      sql`select kind, workspace_id from app.webhook_deliveries where dedupe_key = ${`support:${toSupport.MessageID}`}`,
    );
    expect(ticket).toEqual({ kind: 'support.inbound', workspace_id: null });
    // Not left for the support suite's loop.
    await rows(
      admin(),
      sql`delete from app.webhook_deliveries where dedupe_key = ${`support:${toSupport.MessageID}`}`,
    );
    await drain();
    expect(await filed(toSupport.MessageID)).toBeUndefined();
    expect((await filed(toChris.MessageID))?.emailAddressId).toBe(addressId);
  });
});

describe('turning receiving on', () => {
  it('looks for the MX at once, and turns on when it points here', async () => {
    const domain = `mx-${token()}.example.com`;
    const { domainId } = await domainWith(domain, 'off');
    await executeCommand(
      api(),
      emailDomainReceive,
      { workspaceId, emailDomainId: domainId },
      actor(owner),
      meta(),
    );
    await drain();
    expect(await receivingOf(domainId)).toBe('on');
  });

  it('keeps looking every 15 minutes while the MX points elsewhere', async () => {
    // The local mail service never finds a nomx-… domain's MX.
    const domain = `nomx-${token()}.example.com`;
    const { domainId } = await domainWith(domain, 'off');
    await executeCommand(
      api(),
      emailDomainReceive,
      { workspaceId, emailDomainId: domainId },
      actor(owner),
      meta(),
    );
    await drain();
    expect(await receivingOf(domainId)).toBe('pending');
    const [next] = await rows<{ later: boolean }>(
      admin(),
      sql`select run_at > now() + interval '14 minutes' as later from app.scheduled_jobs
          where kind = ${EMAIL_RECEIVING_CHECK_JOB} and dedupe_key = ${receivingCheckKey(domainId)}
            and status = 'pending'`,
    );
    expect(next).toEqual({ later: true });
    await rows(
      admin(),
      sql`update app.scheduled_jobs set status = 'cancelled'
          where kind = ${EMAIL_RECEIVING_CHECK_JOB} and dedupe_key = ${receivingCheckKey(domainId)}
            and status = 'pending'`,
    );
  });

  it('lapses when a daily check finds the MX gone, and the daily check covers every receiving domain', async () => {
    // The local mail service finds a lapsed-… domain's MX the first time, then not.
    const domain = `lapsed-${token()}.example.com`;
    const { domainId } = await domainWith(domain, 'off');
    await rows(
      admin(),
      sql`update app.email_domains set receiving = 'pending' where id = ${domainId}`,
    );
    const job = (id: string) => ({
      ...s,
      job: { payload: { emailDomainId: id } } as unknown as JobRow,
      scope: { workspaceId, organizationId },
      attempt: 1,
      now: Date.now(),
    });
    expect(await checkEmailReceivingJob(job(domainId))).toBeUndefined();
    expect(await receivingOf(domainId)).toBe('on');
    await checkEmailReceivingJob(job(domainId));
    expect(await receivingOf(domainId)).toBe('lapsed');

    const daily = { ...s, job: {} as JobRow, scope: {}, attempt: 1, now: Date.now() };
    await checkEmailDomains(daily);
    const checks = await rows<{ workspace_id: string; payload: unknown }>(
      admin(),
      sql`select workspace_id, payload from app.scheduled_jobs
          where kind = ${EMAIL_RECEIVING_CHECK_JOB} and dedupe_key = ${receivingCheckKey(domainId)}
            and status = 'pending'`,
    );
    expect(checks).toEqual([{ workspace_id: workspaceId, payload: { emailDomainId: domainId } }]);
    await rows(
      admin(),
      sql`update app.scheduled_jobs set status = 'cancelled'
          where kind in (${EMAIL_RECEIVING_CHECK_JOB}, 'email_domain.check') and status = 'pending'
            and workspace_id = ${workspaceId}`,
    );
  });
});

describe('removing handsfreeos.com from a business', () => {
  it('leaves it at the mail service, where HandsFreeOS’s own mail still sends as it', async () => {
    const removed: string[] = [];
    const ctx = (domain: string) =>
      ({
        event: { payload: { domain, providerDomainId: `pm-${domain}` } },
        email: { domains: { remove: async (id: string) => void removed.push(id) } },
      }) as unknown as Parameters<typeof onEmailDomainRemoved>[0];
    await onEmailDomainRemoved(ctx('handsfreeos.com'));
    await onEmailDomainRemoved(ctx('lonestarhvac.com'));
    expect(removed).toEqual(['pm-lonestarhvac.com']);
  });
});

describe('sending from a receiving domain', () => {
  it('has no Reply-To, so the answer comes straight back to the address', async () => {
    const domain = `send-${token()}.example.com`;
    const { addressId } = await domainWith(domain, 'on');
    const subject = `Your estimate ${token()}`;
    await executeCommand(
      api(),
      messageSend,
      {
        workspaceId,
        personId: mikeId,
        channel: 'email',
        emailAddressId: addressId,
        subject,
        body: 'Hi Mike',
      },
      actor(owner),
      meta(),
    );
    await drain();
    const deadline = Date.now() + 10_000;
    let mail: { From: { Address: string }; ReplyTo: { Address: string }[] } | undefined;
    while (!mail && Date.now() < deadline) {
      const res = await fetch(
        `${env.mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${mike}" subject:"${subject}"`)}`,
      );
      const hit = ((await res.json()) as { messages: { ID: string }[] }).messages[0];
      if (hit)
        mail = (await (
          await fetch(`${env.mailpitUrl}/api/v1/message/${hit.ID}`)
        ).json()) as typeof mail;
      else await new Promise((r) => setTimeout(r, 250));
    }
    expect(mail?.From.Address).toBe(`chris@${domain}`);
    expect(mail?.ReplyTo).toEqual([]);
  });
});
