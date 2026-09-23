/**
 * Taking a move back, on the real database: does the business get its own records back, and only those?
 *
 * The bug this suite exists to catch is the one a business would find rather than a test: the rollback used to
 * know about two of the twenty kinds of record an import makes. It put merged fields back, archived the
 * customers and companies, and dropped every mapping it had — including the mappings for the texts, the calls,
 * the bookings, the invoices, the estimates, the tasks, the notes, the deals, the boards, the forms, the
 * answers, the templates, the products, the subscriptions and the custom fields, none of which it had touched.
 * So a business that pressed "take it back" got its customer list back and kept five years of somebody else's
 * inbox, calendar and billing history, with nothing left to say which rows those were.
 *
 * So the promises here are:
 *
 *   - every kind of record the import made is taken back — put away where the table has somewhere to put it,
 *     deleted where it has not — and the journal says so for every one of them;
 *   - a record the business has since made its own is kept, and keeps its mapping, so a second import
 *     recognises it instead of making another copy;
 *   - a thread that was already the business's own keeps its place in the list, with its summary worked out
 *     again from the messages that are actually left in it;
 *   - what a person typed after the import is still there afterwards;
 *   - and one field the journal records in a shape the column will not take is one field left alone, not a
 *     rollback that dies half way through somebody's business.
 */
import { randomUUID } from 'node:crypto';
import {
  executeCommand,
  executeQuery,
  migrationCreate,
  migrationGet,
  migrationMapScopes,
  migrationRollback,
  migrationRollbackPreview,
  migrationScan,
  migrationSelect,
  migrationStart,
  organizationCreate,
  IMPORTABLE_CATEGORIES,
  MIGRATION_ROLLBACK_LEAVES,
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
import { processMigrationJobs, TAKE_BACK_TYPES } from '../src/migrations/engine/run';
import { standInMedia } from './helpers';

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

/** The kinds a rollback leaves alone, as a list Postgres reads as values rather than as one record. */
const leaves = () =>
  sql.join(
    MIGRATION_ROLLBACK_LEAVES.map((t) => sql`${t}`),
    sql`, `,
  );

const run = <T>(cmd: unknown, input: unknown): Promise<T> =>
  executeCommand(api(), cmd as never, input, actorOf(owner), meta()).then((r) => r.output as T);
const ask = <T>(q: unknown, input: unknown): Promise<T> =>
  executeQuery(api(), q as never, input, actorOf(owner), meta()) as Promise<T>;

/** Runs this migration's own work until it has none left (see migrations.test.ts for why not the queue). */
async function drain(limit = 600): Promise<void> {
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
    if ((mine?.count ?? 0) === 0) {
      // A job that gave up is quiet in the queue and loud in its own row. Reading it here is the difference
      // between "some assertion failed" and knowing which statement the engine could not run.
      const dead = await rows<{ kind: string; last_error: string }>(
        admin(),
        sql`select kind::text as kind, coalesce(last_error, '') as last_error
            from app.migration_jobs
            where migration_id = ${migrationId} and state = 'failed'`,
      );
      if (dead.length > 0) throw new Error(`a job gave up: ${JSON.stringify(dead)}`);
      return;
    }
    await processMigrationJobs(deps);
  }
  const stuck = await rows<{ kind: string; category: string; state: string; last_error: string }>(
    admin(),
    sql`select kind::text as kind, category, state::text as state, coalesce(last_error, '') as last_error
        from app.migration_jobs where migration_id = ${migrationId}
          and state in ('pending', 'retry', 'leased')`,
  );
  throw new Error(`this migration never went quiet: ${JSON.stringify(stuck)}`);
}

/**
 * Where each kind of record lives, and what "still here" means for it.
 *
 * A table with somewhere to put a record out of the way is checked for being put away; a table without one is
 * checked for being gone. The shape is the same shape the engine's plan has, on purpose: if the two ever
 * disagree, one of these counts stops being zero.
 */
const KINDS: readonly { type: string; table: string; live: 'row' | 'archived_at' | 'status' }[] = [
  { type: 'message', table: 'messages', live: 'row' },
  { type: 'call', table: 'calls', live: 'row' },
  { type: 'appointment', table: 'appointments', live: 'row' },
  { type: 'invoice', table: 'invoices', live: 'row' },
  { type: 'estimate', table: 'estimates', live: 'row' },
  { type: 'subscription', table: 'subscriptions', live: 'row' },
  { type: 'task', table: 'tasks', live: 'row' },
  { type: 'activity', table: 'activities', live: 'row' },
  { type: 'form_response', table: 'form_responses', live: 'row' },
  { type: 'email_suppression', table: 'email_suppressions', live: 'row' },
  { type: 'conversation', table: 'conversations', live: 'archived_at' },
  { type: 'lead', table: 'leads', live: 'archived_at' },
  { type: 'pipeline', table: 'pipelines', live: 'archived_at' },
  { type: 'form', table: 'forms', live: 'archived_at' },
  { type: 'product', table: 'products', live: 'archived_at' },
  { type: 'message_template', table: 'message_templates', live: 'archived_at' },
  { type: 'custom_field', table: 'custom_fields', live: 'archived_at' },
  { type: 'person', table: 'people', live: 'archived_at' },
  { type: 'company', table: 'companies', live: 'archived_at' },
  { type: 'calendar', table: 'calendars', live: 'status' },
];

/** How many records of one kind this migration made, and how many of those are still in the business's way. */
async function stateOf(kind: (typeof KINDS)[number]): Promise<{ made: number; live: number }> {
  const alive =
    kind.live === 'archived_at'
      ? sql`t.archived_at is null`
      : kind.live === 'status'
        ? sql`t.status <> 'archived'`
        : sql`true`;
  const [row] = await rows<{ made: number; live: number }>(
    admin(),
    sql`select
          (select count(*)::int from app.migration_change_journal j
            where j.migration_id = ${migrationId} and j.action = 'create'
              and j.target_type = ${kind.type}) as made,
          (select count(*)::int from app.${sql.raw(kind.table)} t
            join app.migration_change_journal j on j.target_id = t.id
            where j.migration_id = ${migrationId} and j.action = 'create'
              and j.target_type = ${kind.type} and ${alive}) as live`,
  );
  return { made: row?.made ?? 0, live: row?.live ?? 0 };
}

const before = new Map<string, number>();
let mappedTypes: string[] = [];
let keptConversationId = '';
let keptInvoiceId = '';
let keptPipelineId = '';
let editedPersonId = '';

beforeAll(async () => {
  owner = await createTestUser('rollback-dale', { fullName: 'Dale Owner' });
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
    ...standInMedia(),
    workerId: `vitest-rollback-${process.pid}`,
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
      externalAccountId: 'fake-agency-rollback',
      displayName: 'Lone Star HVAC (agency)',
      installKind: 'agency',
      scopes: ['contacts.readonly'],
      missingScopes: [],
      adapterVersion: 'fake-1',
    });
  });

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
  // Both sub-accounts into the one business, so the rollback has to walk more than one.
  await run(migrationMapScopes, {
    organizationId,
    migrationId,
    scopes: scanned.scopes.map((s) => ({ scopeId: s.id, workspaceId })),
  });
  // Everything this release can import: the point of the suite is the kinds nobody remembered.
  await run(migrationSelect, {
    organizationId,
    migrationId,
    choices: IMPORTABLE_CATEGORIES.map((category) => ({ category, selected: true })),
  });
  await run(migrationStart, { organizationId, migrationId, acknowledgedFindingIds: [] });
  await drain();
  for (const kind of KINDS) before.set(kind.type, (await stateOf(kind)).made);
  mappedTypes = (
    await rows<{ target_type: string }>(
      admin(),
      sql`select distinct target_type from app.migration_source_mappings
          where first_migration_id = ${migrationId} and created_here`,
    )
  ).map((r) => r.target_type);
}, 300_000);

afterAll(async () => {
  await closeTestDbs();
});

describe('taking a move back', () => {
  it('imported across the kinds of record this is about', async () => {
    // Without this the assertions below would pass on an import that wrote nothing at all.
    const arrived = KINDS.filter((k) => (before.get(k.type) ?? 0) > 0).map((k) => k.type);
    for (const kind of [
      'person',
      'conversation',
      'message',
      'call',
      'appointment',
      'calendar',
      'invoice',
      'estimate',
      'lead',
      'pipeline',
      'task',
      'activity',
      'product',
      'custom_field',
      // Priya asked the old system not to contact her: her address is on the list email stops at.
      'email_suppression',
    ])
      expect(arrived).toContain(kind);
  });

  it('every kind of record the import really wrote is a kind the rollback knows', () => {
    // Asked of the mappings the import actually left behind rather than of a list in this file, because the
    // bug being guarded against is an importer that writes a kind of record nobody taught the rollback about.
    const known = new Set([...TAKE_BACK_TYPES, ...MIGRATION_ROLLBACK_LEAVES]);
    expect(mappedTypes.length).toBeGreaterThan(10);
    expect(mappedTypes.filter((t) => !known.has(t))).toEqual([]);
  });

  it('takes back every kind of record it made, and keeps what the business made its own', async () => {
    // A day's work after the import, of the three shapes that have to survive it: a text the business sent
    // itself, money that really arrived, and a deal of its own on an imported board.
    const [thread] = await rows<{ id: string }>(
      admin(),
      // A texting thread, named rather than taken in whatever order: what is planted on it below is a text,
      // and the thread the rollback keeps is the one this spec then reads.
      sql`select t.id::text as id from app.conversations t
          join app.migration_change_journal j on j.target_id = t.id
          where j.migration_id = ${migrationId} and j.action = 'create'
            and j.target_type = 'conversation' and t.channel = 'sms'
          order by t.created_at limit 1`,
    );
    keptConversationId = thread!.id;
    const [invoice] = await rows<{ id: string }>(
      admin(),
      sql`select t.id::text as id from app.invoices t
          join app.migration_change_journal j on j.target_id = t.id
          where j.migration_id = ${migrationId} and j.action = 'create' and j.target_type = 'invoice'
          order by t.created_at limit 1`,
    );
    keptInvoiceId = invoice!.id;
    const [stage] = await rows<{ pipeline_id: string; id: string }>(
      admin(),
      sql`select s.pipeline_id::text as pipeline_id, s.id::text as id
          from app.pipeline_stages s
          join app.migration_change_journal j on j.target_id = s.pipeline_id
          where j.migration_id = ${migrationId} and j.action = 'create' and j.target_type = 'pipeline'
          order by s.position limit 1`,
    );
    keptPipelineId = stage!.pipeline_id;
    const [person] = await rows<{ id: string }>(
      admin(),
      sql`select t.id::text as id from app.people t
          join app.migration_change_journal j on j.target_id = t.id
          where j.migration_id = ${migrationId} and j.action = 'create' and j.target_type = 'person'
          order by t.created_at limit 1`,
    );
    editedPersonId = person!.id;

    await asWorker(worker(), { workspaceId, organizationId }, async (tx) => {
      await tx.execute(sql`
        insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text,
          occurred_at)
        select ${workspaceId}::uuid, ${keptConversationId}::uuid, c.channel, 'outbound', 'sent',
          'Booked you in for Thursday.', now()
        from app.conversations c where c.id = ${keptConversationId}::uuid`);
      await tx.execute(sql`
        insert into app.payments (workspace_id, invoice_id, amount_cents, currency, method, status,
          received_at, recorded_by)
        values (${workspaceId}::uuid, ${keptInvoiceId}::uuid, 1, 'USD', 'cash', 'succeeded', now(),
          ${owner.id}::uuid)`);
      // A deal belongs to somebody: the table says so, and this is the business's own customer.
      const [ours] = await rows<{ id: string }>(
        tx,
        sql`insert into app.people (workspace_id, first_name, last_name, phone_e164)
            values (${workspaceId}::uuid, 'Someone', 'We Found', '+15125559998')
            returning id::text as id`,
      );
      await tx.execute(sql`
        insert into app.leads (workspace_id, pipeline_id, stage_id, person_id, title, created_by)
        values (${workspaceId}::uuid, ${keptPipelineId}::uuid, ${stage!.id}::uuid, ${ours!.id}::uuid,
          'A job we won on our own', ${owner.id}::uuid)`);
      await tx.execute(sql`
        update app.people set notes = 'Called about the compressor.'
         where id = ${editedPersonId}::uuid`);
    });

    // A merge journalled before 0092, where `custom` was recorded as the words 'kept' and 'filled in'
    // instead of the values themselves. Writing either of those to a `jsonb` column is an error, and it used
    // to be an error that took the whole business's rollback with it. The field is left alone and said to be
    // left alone; everything else still goes.
    await asWorker(worker(), { workspaceId, organizationId }, async (tx) => {
      const [scope] = await rows<{ id: string }>(
        tx,
        sql`select id::text as id from app.migration_scopes where migration_id = ${migrationId} limit 1`,
      );
      const [theirs] = await rows<{ id: string }>(
        tx,
        sql`insert into app.people (workspace_id, first_name, last_name, phone_e164)
            values (${workspaceId}::uuid, 'Someone', 'We Had', '+15125559999')
            returning id::text as id`,
      );
      await tx.execute(sql`
        insert into app.migration_change_journal (migration_id, organization_id, scope_id, workspace_id,
          action, target_type, target_id, changed_fields)
        values (${migrationId}, ${organizationId}, ${scope!.id}::uuid, ${workspaceId}::uuid, 'merge',
          'person', ${theirs!.id}::uuid,
          '{"custom": {"before": "kept", "after": "filled in"}}'::jsonb)`);
    });

    const preview = await ask<{ removable: number }>(migrationRollbackPreview, {
      organizationId,
      migrationId,
    });
    expect(preview.removable).toBeGreaterThan(0);

    await run(migrationRollback, { organizationId, migrationId, confirm: true });
    await drain();

    const [migration] = await rows<{ status: string }>(
      admin(),
      sql`select status::text as status from app.migrations where id = ${migrationId}`,
    );
    expect(migration?.status).toBe('rolled_back');

    // Nothing the import made is in the business's way any more — except the three records the business has
    // since made its own, which are exactly the three it was told about.
    const left: Record<string, number> = {};
    for (const kind of KINDS) {
      const { live } = await stateOf(kind);
      if (live > 0) left[kind.type] = live;
    }
    expect(left).toEqual({ conversation: 1, invoice: 1, pipeline: 1 });

    // The journal accounts for all of it: every record it made is either put back or says why not.
    const [journal] = await rows<{ open: number; depended: number; changed: number }>(
      admin(),
      sql`select
            (select count(*)::int from app.migration_change_journal j
              where j.migration_id = ${migrationId} and j.action = 'create' and j.reverted_at is null
                and j.target_type not in (${leaves()})) as open,
            (select count(*)::int from app.migration_change_journal j
              where j.migration_id = ${migrationId}
                and j.revert_skipped_reason = 'depended_on') as depended,
            (select count(*)::int from app.migration_change_journal j
              where j.migration_id = ${migrationId}
                and j.revert_skipped_reason = 'changed_since') as changed`,
    );
    expect(journal?.open).toBe(0);
    expect(journal?.depended).toBe(3);
    // The field it could not put back said so, rather than the rollback failing or claiming it had.
    expect(journal?.changed).toBeGreaterThan(0);

    // A record that stays keeps its mapping, so importing again recognises it rather than making a second
    // copy of it. A record that went takes its mapping with it.
    const remaining = await rows<{ target_type: string; target_id: string }>(
      admin(),
      sql`select sm.target_type, sm.target_id::text as target_id
          from app.migration_source_mappings sm
          where sm.first_migration_id = ${migrationId} and sm.created_here
            and sm.target_type not in (${leaves()})`,
    );
    expect(remaining.map((r) => r.target_id).sort()).toEqual(
      [keptConversationId, keptInvoiceId, keptPipelineId].sort(),
    );
  }, 300_000);

  it('leaves the thread it kept reading like the business’s own thread', async () => {
    const [kept] = await rows<{
      archived_at: Date | null;
      last_preview: string | null;
      messages: number;
    }>(
      admin(),
      sql`select c.archived_at, c.last_preview,
            (select count(*)::int from app.messages m where m.conversation_id = c.id) as messages
          from app.conversations c where c.id = ${keptConversationId}::uuid`,
    );
    expect(kept?.archived_at).toBeNull();
    // The import's messages are gone and the summary follows what is left, rather than pointing at a text
    // that is no longer there.
    expect(kept?.messages).toBe(1);
    expect(kept?.last_preview).toBe('Booked you in for Thursday.');
  });

  it('can be run again without undoing what it decided the first time', async () => {
    // How an old, half-done rollback is finished off (0092): the move is put back to `rolling_back` with a
    // rollback job, and the engine reads the journal to see what is still unaccounted for. Here everything is
    // accounted for, so the second pass has nothing to do — and must not take the three kept records with it.
    await asWorker(worker(), { organizationId }, (tx) =>
      tx.execute(sql`update app.migrations set status = 'rolling_back' where id = ${migrationId}`),
    );
    await asWorker(worker(), { organizationId }, (tx) =>
      tx.execute(sql`
        insert into app.migration_jobs (migration_id, organization_id, kind, category, pass, input)
        values (${migrationId}, ${organizationId}, 'rollback', 'locations', 0, '{}'::jsonb)`),
    );
    await drain();

    const [migration] = await rows<{ status: string }>(
      admin(),
      sql`select status::text as status from app.migrations where id = ${migrationId}`,
    );
    expect(migration?.status).toBe('rolled_back');
    const left: Record<string, number> = {};
    for (const kind of KINDS) {
      const { live } = await stateOf(kind);
      if (live > 0) left[kind.type] = live;
    }
    expect(left).toEqual({ conversation: 1, invoice: 1, pipeline: 1 });
  }, 120_000);

  it('keeps what a person typed after the import', async () => {
    const [person] = await rows<{ notes: string | null; archived_at: Date | null }>(
      admin(),
      sql`select notes, archived_at from app.people where id = ${editedPersonId}::uuid`,
    );
    expect(person?.notes).toBe('Called about the compressor.');
    // Archived rather than destroyed: a rollback pressed by mistake costs a click, not a customer.
    expect(person?.archived_at).not.toBeNull();
  });
});
