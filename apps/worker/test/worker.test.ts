import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  executeCommand,
  fileBeginUpload,
  fileConfirm,
  fileDelete,
  invitationAccept,
  invitationResend,
  membershipInvite,
  organizationCreate,
  personCreate,
  type HumanActor,
} from '@hfos/core/server';
import { auditLogs, events, files, invitations, outbox } from '@hfos/db/schema';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, testEnv, type TestUser } from '@hfos/db/testing';
import { createClient } from '@supabase/supabase-js';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handlers } from '../src/handlers/index';
import { createSmtpMailer } from '../src/mailer';
import { backoffMs, MAX_ATTEMPTS, processOnce, type OutboxDeps } from '../src/outbox';
import { readEnv } from '../src/env';
import { assertInWorkspace } from '../src/handlers/file-removed';
import { createSupabaseStore } from '../src/storage';

const env = testEnv();
const WORKER_ID = `vitest-worker-${process.pid}`;
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

/**
 * The dev stack runs a worker that polls the same outbox. Pre-locking a row for this test's worker id keeps
 * it out of other pollers' hands; processOnce may re-claim rows locked by its own id.
 */
async function reserveForTests(eventIds: readonly string[]): Promise<void> {
  for (const id of eventIds)
    await rows(
      testDbs().admin.db,
      sql`update app.outbox set locked_at = now(), locked_by = ${WORKER_ID} where event_id = ${id}`,
    );
}

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
    store: createSupabaseStore(env.supabaseUrl, env.secretKey),
    log: pino({ level: 'silent' }),
    handlers,
    webUrl: 'http://localhost:3000',
    workerId: WORKER_ID,
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
    await reserveForTests(eventIds);
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
    const resent = await executeCommand(
      testDbs().api.db,
      invitationResend,
      { workspaceId, invitationId },
      actor(owner),
      meta(),
    );
    await reserveForTests(resent.eventIds);
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

describe('file removal and the pending sweep', () => {
  // A 1x1 transparent PNG.
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  const store = () => deps.store;

  it('deletes the stored object with the worker key, records file.removed, tolerates a missing object, and refuses foreign paths', async () => {
    const person = await executeCommand(
      testDbs().api.db,
      personCreate,
      { workspaceId, firstName: 'Photo', lastName: 'Person' },
      actor(owner),
      meta(),
    );
    const begun = await executeCommand(
      testDbs().api.db,
      fileBeginUpload,
      {
        workspaceId,
        recordType: 'person',
        recordId: person.output.personId,
        name: 'roof.png',
        mimeType: 'image/png',
        sizeBytes: PNG.length,
      },
      actor(owner),
      meta(),
    );
    // The browser would upload with the user's session; the test uses the worker key to land the object.
    const admin = createSupabaseStoreClient();
    const up = await admin.storage
      .from(begun.output.bucket)
      .upload(begun.output.objectPath, PNG, { contentType: 'image/png' });
    expect(up.error).toBeNull();
    await executeCommand(
      testDbs().api.db,
      fileConfirm,
      { workspaceId, fileId: begun.output.fileId },
      actor(owner),
      meta(),
    );
    await processOnce(deps); // drains file.attached (no handler)
    expect(await store().exists(begun.output.bucket, begun.output.objectPath)).toBe(true);

    const deleted = await executeCommand(
      testDbs().api.db,
      fileDelete,
      { workspaceId, fileId: begun.output.fileId },
      actor(owner),
      meta(),
    );
    const first = await processOnce(deps);
    expect(first.done).toBeGreaterThan(0);
    expect(await store().exists(begun.output.bucket, begun.output.objectPath)).toBe(false);
    const [job] = await testDbs()
      .admin.db.select()
      .from(outbox)
      .where(eq(outbox.eventId, deleted.eventIds[0]!));
    expect(job).toMatchObject({ status: 'done', lastError: null });
    const removed = await testDbs()
      .admin.db.select()
      .from(events)
      .where(eq(events.causationId, deleted.eventIds[0]!));
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({
      eventType: 'file.removed',
      actorType: 'system',
      entityType: 'file',
      entityId: begun.output.fileId,
      workspaceId,
    });
    const [audit] = await testDbs()
      .admin.db.select()
      .from(auditLogs)
      .where(eq(auditLogs.eventId, removed[0]!.id));
    expect(audit).toMatchObject({ action: 'file.remove', actorType: 'system', channel: 'worker' });
    expect((audit!.after as { name: string }).name).toBe('roof.png');
    // The row keeps the history; only the object is gone.
    const [row] = await testDbs()
      .admin.db.select()
      .from(files)
      .where(eq(files.id, begun.output.fileId));
    expect(row?.deletedAt).toBeInstanceOf(Date);

    // At-least-once: removing an object that is already gone is not an error.
    await expect(
      store().remove(begun.output.bucket, begun.output.objectPath),
    ).resolves.toBeUndefined();

    // A forged event naming another workspace's prefix is refused before any Storage call.
    expect(() => assertInWorkspace(`${randomUUID()}/person/x/y/z.png`, workspaceId)).toThrow(
      /outside workspace/,
    );
    expect(() => assertInWorkspace(`${workspaceId}/../other/z.png`, workspaceId)).toThrow(
      /outside workspace/,
    );
    const forgedId = randomUUID();
    await testDbs()
      .admin.db.insert(events)
      .values({
        id: forgedId,
        organizationId: removed[0]!.organizationId,
        workspaceId,
        eventType: 'file.deleted',
        actorType: 'system',
        actorId: null,
        entityType: 'person',
        entityId: person.output.personId,
        payload: {
          fileId: randomUUID(),
          name: 'x.png',
          bucket: 'attachments',
          objectPath: `${randomUUID()}/person/a/b/x.png`,
        },
        correlationId: randomUUID(),
        causationId: null,
      });
    await testDbs().admin.db.insert(outbox).values({
      eventId: forgedId,
      organizationId: removed[0]!.organizationId,
      workspaceId,
      eventType: 'file.deleted',
    });
    const second = await processOnce(deps);
    expect(second.retried).toBe(1);
    const [forgedJob] = await testDbs()
      .admin.db.select()
      .from(outbox)
      .where(eq(outbox.eventId, forgedId));
    expect(forgedJob?.status).toBe('pending');
    expect(forgedJob?.lastError).toMatch(/outside workspace/);
    await testDbs()
      .admin.db.update(outbox)
      .set({ status: 'failed' })
      .where(eq(outbox.eventId, forgedId));
  });

  it('sweeps pending uploads older than an hour when it handles a removal in that workspace', async () => {
    const person = await executeCommand(
      testDbs().api.db,
      personCreate,
      { workspaceId, firstName: 'Sweep', lastName: 'Person' },
      actor(owner),
      meta(),
    );
    const stalePath = `${workspaceId}/person/${person.output.personId}/${randomUUID()}/stale.png`;
    const freshPath = `${workspaceId}/person/${person.output.personId}/${randomUUID()}/fresh.png`;
    await rows(
      testDbs().admin.db,
      sql`insert into app.files (workspace_id, record_type, record_id, object_path, name, mime_type, created_by, created_at)
          values (${workspaceId}, 'person', ${person.output.personId}, ${stalePath}, 'stale.png', 'image/png', ${owner.id}, now() - interval '2 hours'),
                 (${workspaceId}, 'person', ${person.output.personId}, ${freshPath}, 'fresh.png', 'image/png', ${owner.id}, now())`,
    );
    const admin = createSupabaseStoreClient();
    expect(
      (await admin.storage.from('attachments').upload(stalePath, PNG, { contentType: 'image/png' }))
        .error,
    ).toBeNull();

    // Any removal in the workspace triggers the sweep: reuse a confirmed-then-deleted file.
    const begun = await executeCommand(
      testDbs().api.db,
      fileBeginUpload,
      {
        workspaceId,
        recordType: 'person',
        recordId: person.output.personId,
        name: 'gone.png',
        mimeType: 'image/png',
        sizeBytes: PNG.length,
      },
      actor(owner),
      meta(),
    );
    expect(
      (
        await admin.storage
          .from(begun.output.bucket)
          .upload(begun.output.objectPath, PNG, { contentType: 'image/png' })
      ).error,
    ).toBeNull();
    await executeCommand(
      testDbs().api.db,
      fileConfirm,
      { workspaceId, fileId: begun.output.fileId },
      actor(owner),
      meta(),
    );
    await executeCommand(
      testDbs().api.db,
      fileDelete,
      { workspaceId, fileId: begun.output.fileId },
      actor(owner),
      meta(),
    );
    await processOnce(deps);

    const remaining = await rows<{ object_path: string }>(
      testDbs().admin.db,
      sql`select object_path from app.files where object_path in (${stalePath}, ${freshPath})`,
    );
    expect(remaining.map((r) => r.object_path)).toEqual([freshPath]);
    expect(await deps.store.exists('attachments', stalePath)).toBe(false);
  });
});

function createSupabaseStoreClient() {
  return createClient(env.supabaseUrl, env.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
