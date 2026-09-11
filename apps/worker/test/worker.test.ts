import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  executeCommand,
  invitationAccept,
  invitationResend,
  membershipInvite,
  organizationCreate,
  type HumanActor,
} from '@hfos/core/server';
import { invitations, outbox } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, testEnv, type TestUser } from '@hfos/db/testing';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handlers } from '../src/handlers/index';
import { createSmtpMailer } from '../src/mailer';
import { backoffMs, MAX_ATTEMPTS, processOnce, type OutboxDeps } from '../src/outbox';
import { readEnv } from '../src/env';

const env = testEnv();
const smtpUrl = process.env.SMTP_URL ?? 'smtp://127.0.0.1:54425';
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });

let owner: TestUser;
let workspaceId: string;
let deps: OutboxDeps;

interface MailpitMessage {
  ID: string;
  To: { Address: string }[];
  Subject: string;
}
async function mailpitSearch(to: string): Promise<MailpitMessage[]> {
  const res = await fetch(
    `${env.mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
  );
  if (!res.ok) throw new Error(`mailpit search failed: ${res.status}`);
  return ((await res.json()) as { messages: MailpitMessage[] }).messages;
}
async function mailpitBody(id: string): Promise<string> {
  const res = await fetch(`${env.mailpitUrl}/api/v1/message/${id}`);
  return ((await res.json()) as { Text: string }).Text;
}

beforeAll(async () => {
  owner = await createTestUser('worker-owner');
  const { output } = await executeCommand(
    testDbs().api.db,
    organizationCreate,
    { businessName: 'Lone Star HVAC & Roofing', organizationName: 'Go Biz Help' },
    actor(owner),
    meta(),
  );
  workspaceId = output.workspaceId;
  deps = {
    db: testDbs().worker.db,
    mailer: createSmtpMailer(smtpUrl, 'HandsFreeOS <hello@handsfreeos.local>'),
    log: pino({ level: 'silent' }),
    handlers,
    webUrl: 'http://localhost:3000',
    workerId: 'vitest',
    batchSize: 20,
  };
});
afterAll(closeTestDbs);

describe('env', () => {
  it('rejects the postgres role and requires an SMTP url', () => {
    expect(() =>
      readEnv({ DATABASE_URL_WORKER: 'postgresql://postgres:x@h/db', SMTP_URL: 'smtp://h' }),
    ).toThrow(/postgres role/);
    expect(() => readEnv({ DATABASE_URL_WORKER: 'postgresql://hfos_worker:x@h/db' })).toThrow(
      /SMTP_URL/,
    );
    expect(backoffMs(1)).toBe(5_000);
    expect(backoffMs(3)).toBe(20_000);
    expect(backoffMs(20)).toBe(600_000);
  });
});

describe('invitation emails', () => {
  const invitee = `worker-invitee-${randomUUID().slice(0, 8)}@hfos.test`;
  let invitationId: string;
  let firstHash: Buffer;

  it('drains the outbox: mints the token, emails the link, records a system event, and is idempotent', async () => {
    const { output, eventIds } = await executeCommand(
      testDbs().api.db,
      membershipInvite,
      { workspaceId, email: invitee, role: 'admin' },
      actor(owner),
      meta(),
    );
    invitationId = output.invitationId;
    const first = await processOnce(deps);
    expect(first.claimed).toBeGreaterThan(0);
    const [mine] = await testDbs()
      .admin.db.select()
      .from(outbox)
      .where(eq(outbox.eventId, eventIds[0]!));
    expect(mine).toMatchObject({ status: 'done', attempts: 0, lastError: null });

    const [inv] = await testDbs()
      .admin.db.select()
      .from(invitations)
      .where(eq(invitations.id, invitationId));
    expect(inv?.sentAt).toBeInstanceOf(Date);
    expect(inv?.tokenHash).toBeInstanceOf(Uint8Array);
    firstHash = Buffer.from(inv!.tokenHash!);

    const messages = await mailpitSearch(invitee);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.Subject).toContain('invited you to Lone Star HVAC & Roofing');
    const body = await mailpitBody(messages[0]!.ID);
    const token = /http:\/\/localhost:3000\/invite\/(inv_[A-Za-z0-9_-]+)/.exec(body)?.[1];
    expect(token).toBeTruthy();
    expect(createHash('sha256').update(token!).digest().equals(firstHash)).toBe(true);
    expect(body).not.toContain(invitee.toUpperCase());

    await processOnce(deps);
    expect(await mailpitSearch(invitee)).toHaveLength(1);
  });

  it('resend rotates the token and sends a second email; the audit trail shows the system actor', async () => {
    await executeCommand(
      testDbs().api.db,
      invitationResend,
      { workspaceId, invitationId },
      actor(owner),
      meta(),
    );
    await processOnce(deps);
    const [inv] = await testDbs()
      .admin.db.select()
      .from(invitations)
      .where(eq(invitations.id, invitationId));
    expect(Buffer.from(inv!.tokenHash!).equals(firstHash)).toBe(false);
    expect(await mailpitSearch(invitee)).toHaveLength(2);
    const sent = await testDbs().admin.db.execute(
      `select action, actor_type, channel from app.audit_logs where entity_id = '${invitationId}' and action = 'invitation.send' order by created_at`,
    );
    expect(
      Array.from(sent as unknown as Iterable<{ actor_type: string; channel: string }>),
    ).toEqual([
      { action: 'invitation.send', actor_type: 'system', channel: 'worker' },
      { action: 'invitation.send', actor_type: 'system', channel: 'worker' },
    ]);
  });

  it('only the latest emailed link is accepted by the invitee through the real command', async () => {
    const [inv] = await testDbs()
      .admin.db.select()
      .from(invitations)
      .where(eq(invitations.id, invitationId));
    const current = Buffer.from(inv!.tokenHash!);
    const tokens: string[] = [];
    for (const m of await mailpitSearch(invitee)) {
      const t = /\/invite\/(inv_[A-Za-z0-9_-]+)/.exec(await mailpitBody(m.ID))?.[1];
      if (t) tokens.push(t);
    }
    expect(tokens).toHaveLength(2);
    const live = tokens.filter((t) => createHash('sha256').update(t).digest().equals(current));
    const dead = tokens.filter((t) => !createHash('sha256').update(t).digest().equals(current));
    expect(live).toHaveLength(1);
    const inviteeUser = await createTestUser('worker-invitee', { email: invitee });
    await expect(
      executeCommand(
        testDbs().api.db,
        invitationAccept,
        { token: dead[0]! },
        actor(inviteeUser),
        meta(),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    const { output } = await executeCommand(
      testDbs().api.db,
      invitationAccept,
      { token: live[0]! },
      actor(inviteeUser),
      meta(),
    );
    expect(output).toMatchObject({ workspaceId, role: 'admin' });
  });
});

describe('failure handling', () => {
  it('retries with backoff, then marks the row failed after the last attempt; unknown event types are marked done', async () => {
    const admin = testDbs().admin.db;
    const eventId = randomUUID();
    await admin.execute(
      `insert into app.events (id, organization_id, workspace_id, event_type, actor_type, entity_type, correlation_id)
       select '${eventId}', w.organization_id, w.id, 'test.explodes', 'system', 'test', gen_random_uuid() from app.workspaces w where w.id = '${workspaceId}'`,
    );
    await admin.execute(
      `insert into app.outbox (event_id, organization_id, workspace_id, event_type, attempts) select id, organization_id, workspace_id, event_type, ${MAX_ATTEMPTS - 2} from app.events where id = '${eventId}'`,
    );
    const exploding: OutboxDeps = {
      ...deps,
      handlers: {
        ...handlers,
        'test.explodes': async () => {
          throw new Error('boom');
        },
      },
    };

    await processOnce(exploding);
    let [row] = await admin.select().from(outbox).where(eq(outbox.eventId, eventId));
    expect(row).toMatchObject({ status: 'pending', attempts: MAX_ATTEMPTS - 1 });
    expect(row!.lastError).toContain('boom');
    expect(row!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    await admin
      .update(outbox)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(outbox.eventId, eventId));
    await processOnce(exploding);
    [row] = await admin.select().from(outbox).where(eq(outbox.eventId, eventId));
    expect(row).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS });

    const unknownId = randomUUID();
    await admin.execute(
      `insert into app.events (id, organization_id, workspace_id, event_type, actor_type, entity_type, correlation_id)
       select '${unknownId}', w.organization_id, w.id, 'test.no_handler', 'system', 'test', gen_random_uuid() from app.workspaces w where w.id = '${workspaceId}'`,
    );
    await admin.execute(
      `insert into app.outbox (event_id, organization_id, workspace_id, event_type) select id, organization_id, workspace_id, event_type from app.events where id = '${unknownId}'`,
    );
    await processOnce(deps);
    const [done] = await admin.select().from(outbox).where(eq(outbox.eventId, unknownId));
    expect(done?.status).toBe('done');
  });
});
