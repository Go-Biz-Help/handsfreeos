/**
 * The history, on the real database: conversations, messages, calls and voicemail (Phase 2 of the plan).
 *
 * The promise this suite exists to hold is the one a business actually cares about — that after the move,
 * opening a customer looks as though HandsFreeOS had been carrying their conversations all along:
 *
 *   - a text sent on a Tuesday afternoon in 2019 sits where a Tuesday afternoon in 2019 belongs;
 *   - two threads with the same customer on the same channel become one timeline, because that is what
 *     HandsFreeOS is, and the folding is said out loud rather than losing one of them;
 *   - a channel HandsFreeOS has no exact home for (WhatsApp) arrives readable, as a chat, and says so;
 *   - a message longer than the column holds keeps every character of itself;
 *   - a call keeps its length and its recording is queued for copying; a voicemail is marked as one;
 *   - and the part that would be unforgivable to get wrong: **none of it is work.** No unread badge, no
 *     awaiting-reply clock, nothing queued to send, no AI teammate asked to answer five-year-old texts.
 */
import { randomUUID } from 'node:crypto';
import {
  executeCommand,
  executeQuery,
  migrationCreate,
  migrationGet,
  migrationMapScopes,
  migrationScan,
  migrationSelect,
  migrationStart,
  organizationCreate,
  type HumanActor,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { createSealer } from '../src/crypto';
import {
  createMigrationAdapters,
  type MigrationAdapters,
} from '../src/migrations/adapters/registry';
import { activateConnection, sealTokens } from '../src/migrations/engine/connection';
import { processMigrationJobs } from '../src/migrations/engine/run';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const worker = () => testDbs().worker.db;

const actorOf = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });

let owner: TestUser;
let organizationId: string;
let workspaceId: string;
let migrationId: string;
let adapters: MigrationAdapters;
let deps: Parameters<typeof processMigrationJobs>[0];

const run = <T>(cmd: unknown, input: unknown): Promise<T> =>
  executeCommand(api(), cmd as never, input, actorOf(owner), meta()).then((r) => r.output as T);
const ask = <T>(q: unknown, input: unknown): Promise<T> =>
  executeQuery(api(), q as never, input, actorOf(owner), meta()) as Promise<T>;

async function drain(limit = 400): Promise<void> {
  for (let i = 0; i < limit; i++) {
    await admin().execute(
      sql`update app.migration_jobs set run_at = now()
          where migration_id = ${migrationId} and state in ('pending', 'retry') and run_at > now()`,
    );
    const [mine] = await rows<{ count: number }>(
      admin(),
      sql`select count(*)::int as count from app.migration_jobs
          where migration_id = ${migrationId} and state in ('leased', 'pending', 'retry')`,
    );
    if ((mine?.count ?? 0) === 0) return;
    await processMigrationJobs(deps);
  }
}

beforeAll(async () => {
  owner = await createTestUser('history-dale', { fullName: 'Dale Owner' });
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Lone Star HVAC', timezone: 'America/Chicago' },
    actorOf(owner),
    meta(),
  );
  organizationId = output.organizationId;
  workspaceId = output.workspaceId;
  const sealer = createSealer(
    Buffer.from(randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), 'hex').toString(
      'base64',
    ),
  );
  adapters = createMigrationAdapters({
    live: false,
    goHighLevel: { clientId: '', clientSecret: '', configured: false },
  });
  deps = {
    db: worker(),
    sealer,
    log: pino({ level: 'silent' }),
    adapters,
    workerId: `vitest-history-${process.pid}`,
    batchSize: 8,
  } as never;

  const connectionId = randomUUID();
  await asWorker(worker(), { organizationId }, async (tx) => {
    await tx.execute(sql`
      insert into app.migration_connections (id, organization_id, source_system, install_kind, status,
        token_enc, token_key_id, created_by)
      values (${connectionId}::uuid, ${organizationId}, 'gohighlevel', 'agency', 'pending',
        ${sealTokens(sealer, { accessToken: 'fake-not-a-real-token', refreshToken: null })},
        ${sealer.keyId}, ${owner.id}::uuid)`);
    await activateConnection(tx, {
      connectionId,
      organizationId,
      sourceSystem: 'gohighlevel',
      externalAccountId: 'fake-agency-history',
      displayName: 'Lone Star HVAC (agency)',
      installKind: 'agency',
      scopes: [
        'users.readonly',
        'tags.readonly',
        'customFields.readonly',
        'contacts.readonly',
        'conversations.readonly',
        'conversations/message.readonly',
      ],
      missingScopes: [],
      adapterVersion: 'fake-1',
    });
  });

  // Scan, put both sub-accounts in the one business, bring everything that can come.
  const created = await run<{ migrationId: string }>(migrationCreate, {
    organizationId,
    connectionId,
    name: 'Off GoHighLevel',
  });
  migrationId = created.migrationId;
  await run(migrationScan, { organizationId, migrationId });
  await drain();
  const scanned = await ask<{ scopes: { id: string }[] }>(migrationGet, {
    organizationId,
    migrationId,
  });
  await run(migrationMapScopes, {
    organizationId,
    migrationId,
    scopes: scanned.scopes.map((s) => ({ scopeId: s.id, workspaceId })),
  });
  await run(migrationSelect, {
    organizationId,
    migrationId,
    choices: [
      { category: 'contacts', selected: true },
      { category: 'tags', selected: true },
      { category: 'custom_fields', selected: true },
      { category: 'conversations', selected: true },
      { category: 'messages', selected: true },
      { category: 'calls', selected: true },
    ],
  });
  await run(migrationStart, { organizationId, migrationId, acknowledgedFindingIds: [] });
  await drain();
}, 180_000);

afterAll(async () => {
  await closeTestDbs();
});

const threads = () =>
  rows<{
    id: string;
    channel: string;
    counterpart: string;
    status: string;
    unread_count: number;
    last_message_at: Date | null;
    awaiting_reply_since: Date | null;
    handled_by: string;
    person_name: string | null;
  }>(
    admin(),
    sql`select c.id::text as id, c.channel::text as channel, c.counterpart, c.status::text as status,
          c.unread_count, c.last_message_at, c.awaiting_reply_since, c.handled_by::text as handled_by,
          p.first_name as person_name
        from app.conversations c left join app.people p on p.id = c.person_id
        where c.workspace_id = ${workspaceId}::uuid
        order by c.channel, c.counterpart`,
  );

describe('the history arrives as history', () => {
  it('brings every thread, on the channel it belongs to, attached to its customer', async () => {
    const list = await threads();
    expect(list.length).toBeGreaterThanOrEqual(4);
    const sms = list.filter((t) => t.channel === 'sms');
    const email = list.filter((t) => t.channel === 'email');
    const chat = list.filter((t) => t.channel === 'chat');
    expect(email.map((t) => t.counterpart)).toEqual(['maria@example.com']);
    // A WhatsApp thread has no website visitor id, so it is addressed as one of its own rather than being
    // folded onto the customer's texts — where a reply would have gone out as a text they never asked for.
    expect(chat).toHaveLength(1);
    expect(chat[0]!.counterpart).toMatch(/^chat:gohighlevel-cnv_a4/);
    // Every thread found the customer it belongs to rather than floating unattached.
    expect(list.every((t) => t.person_name !== null)).toBe(true);
    expect(sms.map((t) => t.counterpart)).toContain('+15125550101');
  }, 60_000);

  it('folds two threads with the same customer into one timeline, and says it did', async () => {
    const [dave] = await threads().then((l) =>
      l.filter((t) => t.counterpart === '+15125550101' && t.channel === 'sms'),
    );
    expect(dave).toBeTruthy();
    // Two source threads, five years apart, one thread here.
    const msgs = await rows<{ body_text: string; occurred_at: Date; direction: string }>(
      admin(),
      sql`select body_text, occurred_at, direction::text as direction from app.messages
          where conversation_id = ${dave!.id}::uuid order by occurred_at`,
    );
    expect(msgs.map((m) => m.body_text)).toEqual([
      'Our AC is making a grinding noise.',
      'We can be there Thursday at 9.',
      'Thursday works, thank you.',
      'Time for the annual service?',
    ]);
    // The dates are the old system's, not today's.
    expect(new Date(msgs[0]!.occurred_at).getUTCFullYear()).toBe(2019);
    expect(new Date(msgs[3]!.occurred_at).getUTCFullYear()).toBe(2024);
    // Inbound is what the customer said; the table's own rule is that those read as received.
    expect(msgs[0]!.direction).toBe('inbound');

    const got = await ask<{ findings: { code: string; whatChanges: string | null }[] }>(
      migrationGet,
      { organizationId, migrationId },
    );
    expect(got.findings.map((f) => f.code)).toContain('conversations.folded');
  }, 60_000);

  it('keeps a channel it has no home for, and says what that means', async () => {
    const [whatsapp] = await threads().then((l) => l.filter((t) => t.channel === 'chat'));
    const msgs = await rows<{ body_text: string }>(
      admin(),
      sql`select body_text from app.messages where conversation_id = ${whatsapp!.id}::uuid`,
    );
    expect(msgs.map((m) => m.body_text)).toEqual(['Are you open Saturday?']);
    const got = await ask<{ findings: { code: string; summary: string }[] }>(migrationGet, {
      organizationId,
      migrationId,
    });
    const said = got.findings.find((f) => f.code === 'conversations.channel_narrowed');
    expect(said?.summary).toContain('whatsapp');
  }, 60_000);

  it('keeps every character of a message longer than a message here holds', async () => {
    const [long] = await rows<{ len: number; html_len: number }>(
      admin(),
      sql`select length(body_text) as len, length(body_html) as html_len from app.messages
          where workspace_id = ${workspaceId}::uuid and subject = 'Spring checklist'`,
    );
    expect(long!.len).toBe(10_000);
    // The whole thing is still there, in the body that has no limit.
    expect(long!.html_len).toBeGreaterThan(11_000);
  }, 60_000);

  it('brings calls with their length, and marks a voicemail as one', async () => {
    const list = await rows<{
      direction: string;
      duration_seconds: number | null;
      is_voicemail: boolean;
      transcript: string | null;
      provider_sid: string | null;
      started_at: Date;
    }>(
      admin(),
      sql`select direction::text as direction, duration_seconds, is_voicemail, transcript, provider_sid,
            started_at
          from app.calls where workspace_id = ${workspaceId}::uuid order by started_at`,
    );
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({
      direction: 'outbound',
      duration_seconds: 214,
      is_voicemail: false,
    });
    expect(list[1]).toMatchObject({ direction: 'inbound', is_voicemail: true });
    expect(list[1]!.transcript).toContain('thermostat');
    // No carrier id: that column is unique across the whole database and holds a carrier's own id, so an
    // imported call leaves it empty and is traced through the migration's mapping instead.
    expect(list[0]!.provider_sid).toBeNull();
    expect(new Date(list[0]!.started_at).getUTCFullYear()).toBe(2019);

    // The recording is queued for copying while the old system's link still works.
    const [media] = await rows<{ count: number }>(
      admin(),
      sql`select count(*)::int as count from app.migration_media
          where migration_id = ${migrationId}::uuid and source_object_type = 'call'`,
    );
    expect(media!.count).toBe(1);
  }, 60_000);

  it('never turns history into work', async () => {
    // Not one badge, not one waiting clock, and no AI teammate handed a five-year-old text.
    const list = await threads();
    expect(list.every((t) => t.unread_count === 0)).toBe(true);
    expect(list.every((t) => t.awaiting_reply_since === null)).toBe(true);
    expect(list.every((t) => t.handled_by === 'none')).toBe(true);
    // Nothing queued to go out: no message is sitting in a sendable state.
    const [queued] = await rows<{ count: number }>(
      admin(),
      sql`select count(*)::int as count from app.messages
          where workspace_id = ${workspaceId}::uuid and status in ('queued', 'sending')`,
    );
    expect(queued!.count).toBe(0);
    // And the thread's own summary follows its newest message, as it would have if it happened here.
    const [dave] = list.filter((t) => t.counterpart === '+15125550101');
    expect(new Date(dave!.last_message_at!).getUTCFullYear()).toBe(2024);
  }, 60_000);
});
