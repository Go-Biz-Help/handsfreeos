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
  onboardingSendLink,
  organizationCreate,
  personCreate,
  type HumanActor,
} from '@hfos/core/server';
import { auditLogs, events, files, invitations, outbox } from '@hfos/db/schema';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, testEnv, type TestUser } from '@hfos/db/testing';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handlers } from '../src/handlers/index';
import { backoffMs, MAX_ATTEMPTS, processOnce, type OutboxDeps } from '../src/outbox';
import { readEnv } from '../src/env';
import { assertInWorkspace } from '../src/handlers/file-removed';
import { testServices } from './helpers';

const env = testEnv();
const WORKER_ID = `vitest-worker-${process.pid}`;
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

/** Reserves every pending outbox row of this suite's workspace, then runs one pass over reserved rows. */
async function processReserved(d: OutboxDeps = deps) {
  await rows(
    testDbs().admin.db,
    sql`update app.outbox set locked_at = now(), locked_by = ${WORKER_ID}
        where status = 'pending' and workspace_id = ${workspaceId}`,
  );
  return processOnce(d);
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
    ...testServices(),
    handlers,
    workerId: WORKER_ID,
    batchSize: 200,
    // Only rows this suite reserved: other suites share the database and leave their own work pending.
    reservedOnly: true,
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

  it("takes Opinly's secret key, and refuses the website's publishable one", () => {
    const base = {
      DATABASE_URL_WORKER: 'postgresql://hfos_worker:x@h/db',
      SMTP_URL: 'smtp://h',
      WORKER_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    };
    expect(readEnv(base).opinlyApiKey).toBeNull();
    expect(readEnv({ ...base, OPINLY_API_KEY: ' sk-abc ' }).opinlyApiKey).toBe('sk-abc');
    expect(() => readEnv({ ...base, OPINLY_API_KEY: 'pk-abc' })).toThrow(/sk- key/);
  });

  it('refuses to run production without a bot check, unless told to on purpose', () => {
    const production = {
      DATABASE_URL_WORKER: 'postgresql://hfos_worker:x@h/db',
      SMTP_URL: 'smtp://h',
      WORKER_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      NODE_ENV: 'production',
      TWILIO_ACCOUNT_SID: 'ACx',
      TWILIO_AUTH_TOKEN: 'y',
      WORKER_PUBLIC_URL: 'https://hooks.example.com',
      POSTMARK_SERVER_TOKEN: 'p',
      POSTMARK_ACCOUNT_TOKEN: 'a',
      POSTMARK_WEBHOOK_PASSWORD: 'w'.repeat(32),
      CHAT_IP_KEY: 'c'.repeat(40),
    };
    expect(() => readEnv(production)).toThrow(/TURNSTILE_SECRET_KEY is required/);
    expect(readEnv({ ...production, ALLOW_NO_BOT_CHECK: '1' }).turnstileSecretKey).toBeNull();
    expect(readEnv({ ...production, TURNSTILE_SECRET_KEY: 't' }).turnstileSecretKey).toBe('t');
  });
});

describe('Getting started: “Email me a link”', () => {
  it('emails the person who asked the page for their step, on the app’s own address', async () => {
    const { eventIds } = await executeCommand(
      testDbs().api.db,
      onboardingSendLink,
      { workspaceId, step: 'customers' },
      actor(owner),
      meta(),
    );
    await reserveForTests(eventIds);
    await processReserved(deps);
    const mine = (await mailpitSearch(owner.email)).filter((m) =>
      m.Subject.startsWith('Your link:'),
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]!.Subject).toBe('Your link: Bring in your customers');
    const body = await mailpitBody(mine[0]!.ID);
    expect(body).toContain('Lone Star HVAC & Roofing');
    expect(body).toContain(`http://localhost:3000/onboarding/${workspaceId}/setup/customers`);
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
    const first = await processReserved(deps);
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

    await processReserved(deps);
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
    await processReserved(deps);
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

    await processReserved(exploding);
    let [row] = await admin.select().from(outbox).where(eq(outbox.eventId, eventId));
    expect(row).toMatchObject({ status: 'pending', attempts: MAX_ATTEMPTS - 1 });
    expect(row!.lastError).toContain('boom');
    expect(row!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    await admin
      .update(outbox)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(outbox.eventId, eventId));
    await processReserved(exploding);
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
    await processReserved(deps);
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
    await processReserved(deps); // drains file.attached (no handler)
    expect(await store().exists(begun.output.bucket, begun.output.objectPath)).toBe(true);

    const deleted = await executeCommand(
      testDbs().api.db,
      fileDelete,
      { workspaceId, fileId: begun.output.fileId },
      actor(owner),
      meta(),
    );
    const first = await processReserved(deps);
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
    const second = await processReserved(deps);
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
    await processReserved(deps);

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
