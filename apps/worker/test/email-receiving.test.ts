/**
 * A business receiving its own mail (M19, step 1), through the worker: Postmark's inbound webhook routing mail
 * for a receiving domain, the support desk keeping its own addresses, the MX checks that turn a domain on, and
 * mail going out with no Reply-To once replies can come straight back.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  emailAddressCreate,
  emailAddressUpdate,
  emailDomainAdd,
  emailDomainReceive,
  emailDomainStopReceiving,
  emailSetupLookUp,
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
import {
  checkEmailDomains,
  checkEmailReceivingJob,
  jobs,
  removeEmailFiles,
} from '../src/scheduled';
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
    sql`update app.email_domains set status = 'verified', dkim_verified_at = now(), return_path_verified_at = now(), ownership_proved_at = now(),
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
  // HandsFreeOS's own business, for the handsfreeos.com cases; every other business receives the same way.
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
  // Their threads first: removing an address leaves a thread on it with no address, and two of one sender's
  // threads with none would be the same lane.
  await rows(
    admin(),
    sql`delete from app.conversations where email_address_id in (
          select id from app.email_addresses where workspace_id = ${workspaceId} and email_domain_id is not null)`,
  );
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

  it('takes a website form’s visitor from Reply-To, From the site or from the business’s own address', async () => {
    const domain = `forms-${token()}.example.com`;
    await domainWith(domain, 'on', 'office');
    const dana = `dana-${token()}@example.net`;
    const lee = `lee-${token()}@example.net`;
    // Contact Form 7's way: From the site, the visitor in Reply-To. WPForms' way: From the business's own address.
    const fromSite = inbound(`office@${domain}`, {
      From: `wordpress@${domain}`,
      FromName: 'Receiving HVAC',
      FromFull: { Email: `wordpress@${domain}`, Name: 'Receiving HVAC', MailboxHash: '' },
      ReplyTo: `Dana Rivera <${dana.toUpperCase()}>`,
    });
    const fromOffice = inbound(`office@${domain}`, {
      From: `office@${domain}`,
      FromName: 'Receiving HVAC',
      FromFull: { Email: `office@${domain}`, Name: 'Receiving HVAC', MailboxHash: '' },
      ReplyTo: lee,
    });
    for (const p of [fromSite, fromOffice]) expect((await post(p)).statusCode).toBe(200);
    await drain();
    const withWhom = async (providerMessageId: string) =>
      (
        await rows<{ counterpart: string; from_address: string }>(
          admin(),
          sql`select c.counterpart, m.from_address from app.messages m
                join app.conversations c on c.id = m.conversation_id
              where m.provider_message_id = ${providerMessageId}`,
        )
      )[0];
    // Each visitor has a thread of their own, and the answer goes to them; the message still says who sent it.
    expect(await withWhom(fromSite.MessageID)).toEqual({
      counterpart: dana,
      from_address: `wordpress@${domain}`,
    });
    expect(await withWhom(fromOffice.MessageID)).toEqual({
      counterpart: lee,
      from_address: `office@${domain}`,
    });
    const [person] = await rows<{ first_name: string; last_name: string }>(
      admin(),
      sql`select first_name, last_name from app.people where workspace_id = ${workspaceId} and email = ${dana}`,
    );
    expect(person).toEqual({ first_name: 'Dana', last_name: 'Rivera' });
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

  it('keeps the old mail records it still sees, for the guided setup’s last step, until they are gone', async () => {
    // The local mail service gives an oldmx-… domain two old records at its web host, gone by the second check.
    const domain = `oldmx-${token()}.example.com`;
    const { domainId } = await domainWith(domain, 'off');
    const seen = async () =>
      (
        await rows<{ receiving: string; mail_host: string | null; mx: { host: string }[] | null }>(
          admin(),
          sql`select receiving::text as receiving, mail_host, mx_records as mx
              from app.email_domains where id = ${domainId}`,
        )
      )[0]!;
    const ask = () =>
      executeCommand(
        api(),
        emailDomainReceive,
        { workspaceId, emailDomainId: domainId },
        actor(owner),
        meta(),
      );
    await ask();
    await drain();
    let now = await seen();
    expect(now.receiving).toBe('pending');
    expect(now.mx?.map((r) => r.host)).toEqual([
      'inbound.postmarkapp.com',
      'mx10.mailspamprotection.com',
      'mx20.mailspamprotection.com',
    ]);
    // Check now, once the old ones are deleted.
    await ask();
    await drain();
    now = await seen();
    expect(now).toMatchObject({ receiving: 'on', mail_host: 'handsfreeos' });
    expect(now.mx?.map((r) => r.host)).toEqual(['inbound.postmarkapp.com']);
  });

  it('looks a website name up before it is added, and says when there is no such name', async () => {
    const lookedUp = async (domain: string) => {
      await executeCommand(api(), emailSetupLookUp, { workspaceId, domain }, actor(owner), meta());
      await drain();
      return (
        await rows<{
          domain: string;
          mail_host: string | null;
          dns_host: string | null;
          n: number;
        }>(
          admin(),
          sql`select domain, mail_host, dns_host, jsonb_array_length(coalesce(mx_records, '[]'::jsonb))::int as n
              from app.email_domain_lookups where workspace_id = ${workspaceId}`,
        )
      )[0];
    };
    const old = `oldmx-${token()}.example.com`;
    expect(await lookedUp(old)).toEqual({
      domain: old,
      mail_host: 'other',
      dns_host: 'siteground',
      n: 2,
    });
    const typo = `typo-${token()}.example.com`;
    expect(await lookedUp(typo)).toEqual({
      domain: typo,
      mail_host: 'none',
      dns_host: 'none',
      n: 0,
    });
    // Nothing was added to the business for either.
    const [added] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.email_domains
          where workspace_id = ${workspaceId} and domain in (${old}, ${typo})`,
    );
    expect(added!.n).toBe(0);
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

describe('removing a domain from a business', () => {
  const removed: string[] = [];
  const closed: string[] = [];
  const ctx = (domain: string, inboundServerId: string | null = null) =>
    ({
      tx: admin(),
      event: { payload: { domain, providerDomainId: `pm-${domain}`, inboundServerId } },
      email: {
        domains: {
          remove: async (id: string) => void removed.push(id),
          closeInbound: async (id: string) => void closed.push(id),
        },
      },
    }) as unknown as Parameters<typeof onEmailDomainRemoved>[0];

  it('leaves handsfreeos.com at the mail service, where HandsFreeOS’s own mail still sends as it', async () => {
    removed.length = 0;
    await onEmailDomainRemoved(ctx('handsfreeos.com'));
    await onEmailDomainRemoved(ctx(`gone-${token()}.example.com`));
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatch(/^pm-gone-/);
  });

  it('stops its server receiving, but leaves a name another business still claims (M19)', async () => {
    removed.length = 0;
    closed.length = 0;
    const domain = `claimed-${token()}.example.com`;
    // Another claim on the same name is still there: Postmark's one domain for it is that claim's too.
    await rows(
      admin(),
      sql`insert into app.email_domains (workspace_id, domain) values (${workspaceId}, ${domain})`,
    );
    await onEmailDomainRemoved(ctx(domain, 'server-1'));
    expect(closed).toEqual(['server-1']);
    expect(removed).toEqual([]);
  });
});

describe('a receiving domain’s own Postmark server (M19 step 6)', () => {
  const serverOf = async (id: string) =>
    (
      await rows<{ server: string | null; receiving: string; error: string | null }>(
        admin(),
        sql`select inbound_server_id as server, receiving::text as receiving, receiving_error as error
            from app.email_domains where id = ${id}`,
      )
    )[0]!;
  const receive = (emailDomainId: string) =>
    executeCommand(api(), emailDomainReceive, { workspaceId, emailDomainId }, actor(owner), meta());
  afterEach(async () => {
    await rows(
      admin(),
      sql`update app.scheduled_jobs set status = 'cancelled'
          where kind = ${EMAIL_RECEIVING_CHECK_JOB} and status = 'pending' and workspace_id = ${workspaceId}`,
    );
  });

  it('is made when the business asks to receive, and stops when it stops', async () => {
    const domain = `server-${token()}.example.com`;
    const { domainId } = await domainWith(domain, 'off');
    await receive(domainId);
    await drain();
    expect(await serverOf(domainId)).toEqual({
      server: `local-inbound-${domain}`,
      receiving: 'on',
      error: null,
    });
    await executeCommand(
      api(),
      emailDomainStopReceiving,
      { workspaceId, emailDomainId: domainId },
      actor(owner),
      meta(),
    );
    await drain();
    expect(await serverOf(domainId)).toEqual({ server: null, receiving: 'off', error: null });
  });

  // Postmark takes a domain only once its MX already points there (its code 610): Burroughs Digital's first try.
  it('waits for the MX record before Postmark takes the domain, then makes its server as the MX shows', async () => {
    // The local Postmark refuses a latemx-… domain until the MX check has looked once.
    const domain = `latemx-${token()}.example.com`;
    const { domainId } = await domainWith(domain, 'off');
    await receive(domainId);
    await drain();
    expect(await serverOf(domainId)).toEqual({
      server: `local-inbound-${domain}`,
      receiving: 'on',
      error: null,
    });
  });

  it('stays waiting, with no refusal, while the MX points elsewhere; Check now looks again at once', async () => {
    const domain = `nomx-${token()}.example.com`;
    const { domainId } = await domainWith(domain, 'off');
    // A refusal from an earlier try no longer applies once the domain waits for its MX.
    await rows(
      admin(),
      sql`update app.email_domains set receiving_error = 'Postmark wouldn’t set it up.' where id = ${domainId}`,
    );
    await receive(domainId);
    await drain();
    expect(await serverOf(domainId)).toEqual({ server: null, receiving: 'pending', error: null });
    const checked = async () =>
      (
        await rows<{ at: string | null }>(
          admin(),
          sql`select mx_checked_at::text as at from app.email_domains where id = ${domainId}`,
        )
      )[0]!.at;
    const before = await checked();
    expect(before).not.toBeNull();
    // Check now: the business changed its MX a moment ago and doesn't wait for the next 15-minute look.
    expect((await receive(domainId)).output).toMatchObject({
      receiving: 'pending',
      changed: false,
    });
    await drain();
    expect(await checked()).not.toBe(before);
    expect(await serverOf(domainId)).toEqual({ server: null, receiving: 'pending', error: null });
  });

  it('asks Postmark again in 5 minutes when our DNS sees the MX before Postmark’s does', async () => {
    // The local Postmark refuses a slowmx-… domain until the MX check has looked twice.
    const domain = `slowmx-${token()}.example.com`;
    const { domainId } = await domainWith(domain, 'off');
    await rows(
      admin(),
      sql`update app.email_domains set receiving = 'pending' where id = ${domainId}`,
    );
    const job = {
      ...s,
      job: { payload: { emailDomainId: domainId } } as unknown as JobRow,
      scope: { workspaceId, organizationId },
      attempt: 1,
      now: Date.now(),
    };
    const first = await checkEmailReceivingJob(job);
    const wait = (first?.rescheduleAt.getTime() ?? 0) - Date.now();
    expect(wait).toBeGreaterThan(4 * 60_000);
    expect(wait).toBeLessThanOrEqual(5 * 60_000);
    expect(await serverOf(domainId)).toEqual({ server: null, receiving: 'pending', error: null });
    expect(await checkEmailReceivingJob(job)).toBeUndefined();
    expect(await serverOf(domainId)).toEqual({
      server: `local-inbound-${domain}`,
      receiving: 'on',
      error: null,
    });
  });

  it('says why when Postmark won’t receive the domain, and receiving goes back off', async () => {
    const full = await domainWith(`full-${token()}.example.com`, 'off', 'office');
    await receive(full.domainId);
    await drain();
    expect(await serverOf(full.domainId)).toMatchObject({
      server: null,
      receiving: 'off',
      error: expect.stringContaining('can’t take on another domain’s mail right now'),
    });
    const taken = await domainWith(`elsewhere-${token()}.example.com`, 'off', 'sales');
    await receive(taken.domainId);
    await drain();
    expect(await serverOf(taken.domainId)).toMatchObject({
      server: null,
      receiving: 'off',
      error: expect.stringContaining('another Postmark account'),
    });
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

describe('someone’s own address (M19)', () => {
  it('files mail to it as theirs alone, and sends their answer from it', async () => {
    const domain = `own-${token()}.example.com`;
    const { addressId } = await domainWith(domain, 'on', 'chris');
    await executeCommand(
      api(),
      emailAddressUpdate,
      { workspaceId, emailAddressId: addressId, ownerUserId: owner.id },
      actor(owner),
      meta(),
    );
    // Mike is a customer, and still his mail to someone's own address is theirs, not on his record.
    const p = inbound(`chris@${domain}`, { Subject: 'Just between us' });
    expect((await post(p)).statusCode).toBe(200);
    await drain();
    const m = (await filed(p.MessageID))!;
    expect(m).toMatchObject({ emailAddressId: addressId, privateTo: owner.id });
    const [c] = await rows<{ private_to: string | null; person_id: string | null }>(
      admin(),
      sql`select private_to, person_id from app.conversations where id = ${m.conversationId}`,
    );
    expect(c).toEqual({ private_to: owner.id, person_id: null });

    const subject = `Re: Just between us ${token()}`;
    await executeCommand(
      api(),
      messageSend,
      {
        workspaceId,
        channel: 'email',
        conversationId: m.conversationId,
        subject,
        body: 'Sure thing.',
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

  it('removes a departed person’s removed mail from storage, and nothing outside the business’s mail', async () => {
    const mine = `${workspaceId}/email/${token()}/0-letter.txt`;
    const elsewhere = `${randomUUID()}/email/${token()}/0-other.txt`;
    for (const path of [mine, elsewhere])
      await s.store.upload('telephony', path, Buffer.from('hello'), 'text/plain', { upsert: true });
    await removeEmailFiles({
      ...s,
      job: {
        payload: {
          files: [
            { bucket: 'telephony', objectPath: mine },
            { bucket: 'telephony', objectPath: elsewhere },
          ],
        },
      } as unknown as JobRow,
      scope: { workspaceId, organizationId },
      attempt: 1,
      now: Date.now(),
    });
    expect(await s.store.exists('telephony', mine)).toBe(false);
    expect(await s.store.exists('telephony', elsewhere)).toBe(true);
    await s.store.remove('telephony', elsewhere);
  });
});
