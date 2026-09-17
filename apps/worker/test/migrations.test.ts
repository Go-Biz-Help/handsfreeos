/**
 * M11 end to end, on the real database: an agency leaves its old CRM.
 *
 * The stand-in source is a deliberately awkward two-sub-account agency (migrations/adapters/fake.ts), so what
 * is proved here is the set of promises the milestone actually makes, not a happy path:
 *
 *   - the scan reads and counts and writes nothing to the business;
 *   - a category the sign-in cannot reach reads as "we were not allowed to look", never as zero;
 *   - two sub-accounts may land in one business, and the plan says so before anybody presses Import;
 *   - a customer added in 2019 still says 2019 afterwards;
 *   - the same customer in both sub-accounts becomes one customer, on the phone number;
 *   - two different Dave Smiths stay two people;
 *   - an email pointing at one person and a phone at another waits for a human;
 *   - running the whole import twice creates nothing the second time;
 *   - custom fields, which HandsFreeOS does not have, are kept and said out loud rather than dropped;
 *   - rolling back removes what the migration made and leaves what somebody changed afterwards alone.
 */
import { randomUUID } from 'node:crypto';
import {
  executeCommand,
  migrationCreate,
  migrationGet,
  migrationMapScopes,
  migrationRollback,
  migrationScan,
  migrationSelect,
  migrationStart,
  migrationRollbackPreview,
  executeQuery,
  type HumanActor,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { organizationCreate } from '@hfos/core/server';
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

interface World {
  owner: TestUser;
  organizationId: string;
  workspaceId: string;
  connectionId: string;
  migrationId: string;
  adapters: MigrationAdapters;
  deps: Parameters<typeof processMigrationJobs>[0];
}

let w: World;

const run = <T>(cmd: unknown, input: unknown): Promise<T> =>
  executeCommand(api(), cmd as never, input, actorOf(w.owner), meta()).then((r) => r.output as T);
const ask = <T>(q: unknown, input: unknown): Promise<T> =>
  executeQuery(api(), q as never, input, actorOf(w.owner), meta()) as Promise<T>;

/** Runs the migration loop until it has nothing left to do. */
async function drain(limit = 200): Promise<void> {
  for (let i = 0; i < limit; i++) {
    const stats = await processMigrationJobs(w.deps);
    if (stats.claimed === 0) return;
  }
  throw new Error('the migration loop never went quiet');
}

const people = () =>
  rows<{
    id: string;
    first_name: string;
    last_name: string;
    email: string | null;
    phone_e164: string | null;
    created_at: Date;
    notes: string | null;
    archived_at: Date | null;
  }>(
    admin(),
    sql`select id::text as id, first_name, last_name, email::text as email, phone_e164, created_at, notes,
          archived_at
        from app.people where workspace_id = ${w.workspaceId} order by first_name, last_name`,
  );

beforeAll(async () => {
  const owner = await createTestUser('m11-owner', { fullName: 'Dale Owner' });
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Lone Star HVAC', timezone: 'America/Chicago' },
    actorOf(owner),
    meta(),
  );
  const sealer = createSealer(
    Buffer.from(randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), 'hex').toString(
      'base64',
    ),
  );
  const adapters = createMigrationAdapters({
    live: false,
    goHighLevel: { clientId: '', clientSecret: '', configured: false },
  });
  w = {
    owner,
    organizationId: output.organizationId,
    workspaceId: output.workspaceId,
    connectionId: '',
    migrationId: '',
    adapters,
    deps: {
      db: worker(),
      sealer,
      log: pino({ level: 'silent' }),
      adapters,
      workerId: `vitest-m11-${process.pid}`,
      batchSize: 8,
    },
  };

  // A connected source, as the sign-in leaves it. The stand-in never reaches a real account.
  const connectionId = randomUUID();
  await asWorker(worker(), { organizationId: w.organizationId }, async (tx) => {
    await tx.execute(sql`
      insert into app.migration_connections (id, organization_id, source_system, install_kind, status,
        token_enc, token_key_id, created_by)
      values (${connectionId}::uuid, ${w.organizationId}, 'gohighlevel', 'agency', 'pending',
        ${sealTokens(w.deps.sealer, { accessToken: 'fake-not-a-real-token', refreshToken: null })},
        ${w.deps.sealer.keyId}, ${w.owner.id}::uuid)`);
    await activateConnection(tx, {
      connectionId,
      organizationId: w.organizationId,
      sourceSystem: 'gohighlevel',
      externalAccountId: 'fake-agency',
      displayName: 'Lone Star HVAC (agency)',
      installKind: 'agency',
      scopes: ['users.readonly', 'tags.readonly', 'contacts.readonly', 'companies.readonly'],
      // Custom fields are the one the sign-in was not given, on purpose.
      missingScopes: ['customFields.readonly'],
      adapterVersion: 'fake-1',
    });
  });
  w.connectionId = connectionId;
  w.adapters.fake!.denyScope('customFields.readonly');
}, 60_000);

afterAll(async () => {
  await closeTestDbs();
});

describe('a business moves house', () => {
  it('scans without touching a single customer', async () => {
    const created = await run<{ migrationId: string }>(migrationCreate, {
      organizationId: w.organizationId,
      connectionId: w.connectionId,
      name: 'Off GoHighLevel',
      transition: true,
    });
    w.migrationId = created.migrationId;
    const before = await people();
    expect(before).toHaveLength(0);

    await run(migrationScan, {
      organizationId: w.organizationId,
      migrationId: w.migrationId,
    });
    await drain();

    // Read-only means read-only: the scan found thousands of things and wrote none of them.
    expect(await people()).toHaveLength(0);
    const got = await ask<{
      scopes: { id: string; name: string; status: string }[];
      inventory: { category: string; found: number; countLabel: string; capability: string }[];
      migration: { status: string };
    }>(migrationGet, { organizationId: w.organizationId, migrationId: w.migrationId });
    expect(got.migration.status).toBe('scanned');
    expect(got.scopes.map((s) => s.name).sort()).toEqual([
      'Lone Star HVAC — Austin',
      'Lone Star HVAC — Dallas',
    ]);
    const contacts = got.inventory.find((i) => i.category === 'contacts');
    expect(contacts?.found).toBe(9);
    expect(contacts?.countLabel).toBe('9');
  }, 60_000);

  it('never shows a permission problem as an empty account', async () => {
    const got = await ask<{
      inventory: { category: string; found: number; countLabel: string; capability: string }[];
      findings: { code: string; summary: string; recommendedAction: string | null }[];
    }>(migrationGet, { organizationId: w.organizationId, migrationId: w.migrationId });
    const fields = got.inventory.find((i) => i.category === 'custom_fields');
    expect(fields?.capability).toBe('not_available');
    // The whole point: not "0".
    expect(fields?.countLabel).toBe('not visible to this sign-in');
    const finding = got.findings.find((f) => f.code === 'access.scope_missing');
    expect(finding?.recommendedAction).toContain('Sign in again');
  });

  it('says plainly what putting two sub-accounts in one business mixes', async () => {
    const got = await ask<{ scopes: { id: string; name: string }[] }>(migrationGet, {
      organizationId: w.organizationId,
      migrationId: w.migrationId,
    });
    const mapped = await run<{ shared: { workspaceName: string; scopeNames: string[] }[] }>(
      migrationMapScopes,
      {
        organizationId: w.organizationId,
        migrationId: w.migrationId,
        scopes: got.scopes.map((s) => ({ scopeId: s.id, workspaceId: w.workspaceId })),
      },
    );
    expect(mapped.shared).toHaveLength(1);
    expect(mapped.shared[0]!.scopeNames.sort()).toEqual([
      'Lone Star HVAC — Austin',
      'Lone Star HVAC — Dallas',
    ]);
    const after = await ask<{ findings: { code: string; whatChanges: string | null }[] }>(
      migrationGet,
      { organizationId: w.organizationId, migrationId: w.migrationId },
    );
    const finding = after.findings.find((f) => f.code === 'plan.scopes_share_workspace');
    expect(finding?.whatChanges).toContain('joined into one customer');
  });

  it('adds what a choice needs and says who asked for it', async () => {
    const chosen = await run<{
      added: { category: string; reason: string }[];
      selectedCategories: string[];
    }>(migrationSelect, {
      organizationId: w.organizationId,
      migrationId: w.migrationId,
      choices: [
        { category: 'contacts', selected: true },
        { category: 'tags', selected: true },
        { category: 'users', selected: true },
      ],
    });
    // Everything needs the business it belongs to; nobody should have to know that.
    expect(chosen.added.map((a) => a.category)).toContain('locations');
    expect(chosen.selectedCategories).toContain('contacts');
  });

  it('brings the customers across with the dates they were really added', async () => {
    await run(migrationStart, {
      organizationId: w.organizationId,
      migrationId: w.migrationId,
      acknowledgedFindingIds: [],
    });
    await drain();

    const list = await people();
    // Nine customers over two sub-accounts, one of whom is in both, and one waiting on a person:
    // so seven arrive, one is a merge, one is a question.
    expect(list.length).toBe(7);
    const dave = list.filter((p) => p.last_name === 'Smith');
    expect(dave).toHaveLength(2); // two different Daves, never joined on a name
    const austinDave = dave.find((p) => p.phone_e164 === '+15125550101');
    expect(new Date(austinDave!.created_at).toISOString()).toBe('2019-04-11T14:22:00.000Z');
    const tom = list.filter((p) => p.first_name === 'Tom');
    expect(tom).toHaveLength(1); // the same person in both sub-accounts, joined on the number
  }, 120_000);

  it('asks a person when the email says one customer and the phone says another', async () => {
    const got = await ask<{ needsReview: number }>(migrationGet, {
      organizationId: w.organizationId,
      migrationId: w.migrationId,
    });
    expect(got.needsReview).toBeGreaterThanOrEqual(1);
    const [candidate] = await rows<{ match_rule: string; evidence: { reason?: string } }>(
      admin(),
      sql`select match_rule, evidence from app.migration_merge_candidates
          where migration_id = ${w.migrationId} and resolution = 'pending' and match_rule = 'conflict'`,
    );
    expect(candidate?.evidence.reason).toContain(
      'matches one customer and the email matches another',
    );
  });

  it('keeps what it has nowhere to put, and says so', async () => {
    const list = await people();
    const withExtras = list.find((p) => p.notes?.includes('From the old system'));
    expect(withExtras?.notes).toContain('Carrier 24ACC6');
  });

  it('proves the history kept its own dates, and that nothing arrived twice', async () => {
    const checks = await rows<{ kind: string; result: string; summary: string }>(
      admin(),
      sql`select kind::text as kind, result::text as result, summary
          from app.migration_verifications where migration_id = ${w.migrationId} order by kind`,
    );
    const history = checks.find((c) => c.kind === 'history');
    expect(history?.result).toBe('passed');
    expect(history?.summary).toContain('not today');
    const identity = checks.find((c) => c.kind === 'identity');
    expect(identity?.result).toBe('passed');
  });

  it('brings nothing a second time', async () => {
    const before = await people();
    await run(migrationScan, { organizationId: w.organizationId, migrationId: w.migrationId });
    await drain();
    await run(migrationSelect, {
      organizationId: w.organizationId,
      migrationId: w.migrationId,
      choices: [{ category: 'contacts', selected: true }],
    });
    await run(migrationStart, {
      organizationId: w.organizationId,
      migrationId: w.migrationId,
      acknowledgedFindingIds: [],
    });
    await drain();
    const after = await people();
    expect(after.map((p) => p.id).sort()).toEqual(before.map((p) => p.id).sort());
  }, 120_000);

  it('says what taking it back would do before it does it', async () => {
    const preview = await ask<{ removable: number; restorable: number }>(migrationRollbackPreview, {
      organizationId: w.organizationId,
      migrationId: w.migrationId,
    });
    expect(preview.removable).toBeGreaterThanOrEqual(7);
  });

  it('takes back what it made, and leaves what somebody changed afterwards alone', async () => {
    const list = await people();
    const edited = list.find((p) => p.first_name === 'Maria')!;
    // Somebody does a day's work after the migration: this must survive being rolled back.
    await asWorker(worker(), { workspaceId: w.workspaceId }, (tx) =>
      tx.execute(
        sql`update app.people set notes = 'Called about the compressor.' where id = ${edited.id}::uuid`,
      ),
    );

    await run(migrationRollback, {
      organizationId: w.organizationId,
      migrationId: w.migrationId,
      confirm: true,
    });
    await drain();

    const after = await people();
    // Everything it made is archived rather than destroyed.
    expect(after.filter((p) => p.archived_at === null)).toHaveLength(0);
    const maria = after.find((p) => p.id === edited.id);
    expect(maria?.notes).toBe('Called about the compressor.');
    const [migration] = await rows<{ status: string }>(
      admin(),
      sql`select status::text as status from app.migrations where id = ${w.migrationId}`,
    );
    expect(migration?.status).toBe('rolled_back');
  }, 120_000);
});
