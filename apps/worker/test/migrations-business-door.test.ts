/**
 * A business moving itself in, on the real database (0070): the door 0068 opened, walked from the beginning.
 *
 * It is here because the beginning was the part that did not work, and it failed in the quietest possible way.
 * "Is this migration mine?" was answered through the sub-account rows — right for the hard case, where twenty
 * clients share one agency migration and each must see only its own line — and those rows are written by the
 * discovery pass, which is the first thing a scan does. So a business's *first* scan of its own connection was
 * refused by work the scan had not done yet: the migration stayed at `connected`, no job was queued, and the
 * browser (which did not check that call's answer either) said it had started looking.
 *
 * So what is proved here is the order a real person does things in, through the business's own door:
 *
 *   - connect a source as that business, start a migration on it, and look at it — the three in a row;
 *   - the business can read its own migration before anything has been discovered;
 *   - the discovery pass then finds the sub-account, and the counts follow;
 *   - a business still cannot reach a migration that is nobody's business but the agency's.
 *
 * The private-token door is used because that is what Chris connected with first, but nothing here is about
 * tokens: the same three steps through an ordinary sign-in went the same way.
 */
import { randomUUID } from 'node:crypto';
import {
  executeCommand,
  executeQuery,
  migrationConnect,
  migrationCreate,
  migrationGet,
  migrationMapScopes,
  migrationScan,
  migrationSelect,
  migrationStart,
  organizationCreate,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { buildHttpServer } from '../src/http/server';
import {
  createMigrationAdapters,
  type MigrationAdapters,
} from '../src/migrations/adapters/registry';
import { processMigrationJobs } from '../src/migrations/engine/run';
import { testServices, type TestServices } from './helpers';

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
let services: TestServices;
let adapters: MigrationAdapters;
let app: FastifyInstance;
let migrationId = '';

const run = <T>(cmd: unknown, input: unknown): Promise<T> =>
  executeCommand(api(), cmd as never, input, actorOf(owner), meta()).then((r) => r.output as T);
const ask = <T>(q: unknown, input: unknown): Promise<T> =>
  executeQuery(api(), q as never, input, actorOf(owner), meta()) as Promise<T>;

/** The migration loop until this migration has nothing left of its own to do. */
async function drain(limit = 200): Promise<void> {
  const deps = {
    db: worker(),
    sealer: services.sealer,
    log: pino({ level: 'silent' }),
    adapters,
    workerId: `vitest-business-door-${process.pid}`,
    batchSize: 8,
  };
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
    await processMigrationJobs(deps as never);
  }
}

beforeAll(async () => {
  owner = await createTestUser('business-door-dale', { fullName: 'Dale Owner' });
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Lone Star HVAC', timezone: 'America/Chicago' },
    actorOf(owner),
    meta(),
  );
  organizationId = output.organizationId;
  workspaceId = output.workspaceId;
  services = testServices();
  adapters = createMigrationAdapters({
    live: false,
    goHighLevel: { clientId: '', clientSecret: '', configured: false },
  });
  app = await buildHttpServer({
    ...services,
    httpDb: worker(),
    verifyToken: null,
    webOrigins: ['http://localhost:3000'],
    migrationAdapters: adapters,
  });
}, 60_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  await closeTestDbs();
});

describe('a business moves itself in', () => {
  it('connects its own source, starts a migration and looks at it — in that order, with nothing discovered yet', async () => {
    // Connect, from the business's own Settings page: `workspaceId` is what makes this the business's door.
    const started = await run<{ connectionId: string; state: string }>(migrationConnect, {
      organizationId,
      workspaceId,
      source: 'gohighlevel',
      authKind: 'private_token',
    });
    const pasted = await app.inject({
      method: 'POST',
      url: '/migrations/token',
      payload: { state: started.state, token: 'pit-not-a-real-token', accountId: 'loc_austin' },
    });
    expect(pasted.statusCode, pasted.body).toBe(200);

    const created = await run<{ migrationId: string }>(migrationCreate, {
      organizationId,
      workspaceId,
      connectionId: started.connectionId,
      name: 'Off GoHighLevel',
    });
    migrationId = created.migrationId;

    // The business can read the migration it just made, before a single sub-account exists. This is the read
    // that used to come back as though the migration were somebody else's.
    const before = await ask<{ migration: { status: string; name: string } | null }>(migrationGet, {
      organizationId,
      workspaceId,
      migrationId,
    });
    expect(before.migration?.name).toBe('Off GoHighLevel');
    expect(before.migration?.status).toBe('connected');

    // And it can look at the old system. The whole bug was here: this was refused, silently.
    const scan = await run<{ scanId: string }>(migrationScan, {
      organizationId,
      workspaceId,
      migrationId,
    });
    expect(scan.scanId).toBeTruthy();
    const [queued] = await rows<{ kind: string; state: string }>(
      admin(),
      sql`select kind::text as kind, state::text as state from app.migration_jobs
          where migration_id = ${migrationId}`,
    );
    expect(queued?.kind).toBe('discover');
  }, 60_000);

  it('then finds the sub-account and counts what is in it', async () => {
    await drain();
    const got = await ask<{
      migration: { status: string };
      scopes: { name: string; externalScopeId: string }[];
      inventory: { category: string; countLabel: string }[];
    }>(migrationGet, { organizationId, workspaceId, migrationId });
    expect(got.migration.status).toBe('scanned');
    // One sub-account, because a private token reaches exactly one.
    expect(got.scopes.map((s) => s.externalScopeId)).toEqual(['loc_austin']);
    expect(got.inventory.find((i) => i.category === 'contacts')?.countLabel).toBeTruthy();
  }, 120_000);

  it('maps its own sub-account, chooses, and brings the customers across', async () => {
    const got = await ask<{ scopes: { id: string; externalScopeId: string }[] }>(migrationGet, {
      organizationId,
      workspaceId,
      migrationId,
    });
    const austin = got.scopes.find((s) => s.externalScopeId === 'loc_austin')!;
    const mapped = await run<{ mapped: number }>(migrationMapScopes, {
      organizationId,
      workspaceId,
      scopes: [{ scopeId: austin.id, workspaceId }],
      migrationId,
    });
    expect(mapped.mapped).toBe(1);

    await run(migrationSelect, {
      organizationId,
      workspaceId,
      migrationId,
      choices: [
        { category: 'contacts', selected: true },
        { category: 'tags', selected: true },
      ],
    });
    await run(migrationStart, {
      organizationId,
      workspaceId,
      migrationId,
      acknowledgedFindingIds: [],
    });
    await drain();

    // The customers are in the business, and the migration is past the import rather than stuck in it.
    const [people] = await rows<{ count: number }>(
      admin(),
      sql`select count(*)::int as count from app.people where workspace_id = ${workspaceId}::uuid`,
    );
    expect(people!.count).toBeGreaterThan(0);
    const after = await ask<{ migration: { status: string } }>(migrationGet, {
      organizationId,
      workspaceId,
      migrationId,
    });
    expect(['imported', 'verifying', 'transition', 'completed', 'needs_attention']).toContain(
      after.migration.status,
    );
  }, 180_000);

  it('still keeps somebody else’s migration out of reach', async () => {
    // A second business in another organization, with its own connection and migration. Ours may not read it.
    const stranger = await createTestUser('business-door-stranger', { fullName: 'Sam Stranger' });
    const { output: theirs } = await executeCommand(
      api(),
      organizationCreate,
      { businessName: 'Gulf Coast Plumbing', timezone: 'America/Chicago' },
      actorOf(stranger),
      meta(),
    );
    const theirStart = await executeCommand(
      api(),
      migrationConnect,
      {
        organizationId: theirs.organizationId,
        workspaceId: theirs.workspaceId,
        source: 'gohighlevel',
        authKind: 'private_token',
      },
      actorOf(stranger),
      meta(),
    ).then((r) => r.output);
    const pasted = await app.inject({
      method: 'POST',
      url: '/migrations/token',
      payload: { state: theirStart.state, token: 'pit-not-a-real-token', accountId: 'loc_dallas' },
    });
    expect(pasted.statusCode, pasted.body).toBe(200);
    const theirMigration = await executeCommand(
      api(),
      migrationCreate,
      {
        organizationId: theirs.organizationId,
        workspaceId: theirs.workspaceId,
        connectionId: theirStart.connectionId,
        name: 'Off GoHighLevel',
      },
      actorOf(stranger),
      meta(),
    ).then((r) => r.output);

    // Asked for as ours, by us: not found, whichever way it is addressed.
    await expect(
      run(migrationScan, {
        organizationId: theirs.organizationId,
        workspaceId,
        migrationId: theirMigration.migrationId,
      }),
    ).rejects.toThrow();
    await expect(
      run(migrationScan, {
        organizationId,
        workspaceId,
        migrationId: theirMigration.migrationId,
      }),
    ).rejects.toThrow();
  }, 60_000);
});
