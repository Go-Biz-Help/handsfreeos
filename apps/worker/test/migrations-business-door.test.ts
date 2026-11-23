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
 *   - an owner who is in the business but not in the organization above it can do all of that too, and so
 *     can the founder working in a customer's business as its owner;
 *   - only what was ticked comes across, with what that needs, and a need nobody has any more is let go;
 *   - a business still cannot reach a migration that is nobody's business but the agency's.
 *
 * The private-token door is used because that is what Chris connected with first, but nothing here is about
 * tokens: the same three steps through an ordinary sign-in went the same way.
 */
import { randomUUID } from 'node:crypto';
import {
  executeCommand,
  executeQuery,
  isImportable,
  migrationConnect,
  migrationCreate,
  migrationGet,
  migrationMapScopes,
  migrationPause,
  migrationRollback,
  migrationScan,
  migrationSelect,
  migrationStart,
  organizationCreate,
  platformViewAsEnd,
  platformViewAsStart,
  type HumanActor,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
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
async function drain(
  limit = 200,
  id = migrationId,
  options: { using?: MigrationAdapters; pageBudgetMs?: number } = {},
): Promise<void> {
  const deps = {
    db: worker(),
    sealer: services.sealer,
    log: pino({ level: 'silent' }),
    adapters: options.using ?? adapters,
    store: services.store,
    fetchUrl: services.fetchUrl,
    workerId: `vitest-business-door-${process.pid}`,
    batchSize: 8,
    pageBudgetMs: options.pageBudgetMs,
  };
  for (let i = 0; i < limit; i++) {
    await admin().execute(
      sql`update app.migration_jobs set run_at = now()
          where migration_id = ${id} and state in ('pending', 'retry') and run_at > now()`,
    );
    const [mine] = await rows<{ count: number }>(
      admin(),
      sql`select count(*)::int as count from app.migration_jobs
          where migration_id = ${id} and state in ('leased', 'pending', 'retry')`,
    );
    if ((mine?.count ?? 0) === 0) return;
    await processMigrationJobs(deps as never);
  }
}

/**
 * The whole move through a business's own door, as somebody who runs the business but not the account above it:
 * connect with a pasted token, start, look, be told a new business isn't theirs to make, map the sub-account to
 * this business, choose the customers, bring them across. The same GoHighLevel sub-account
 * as the first business, so it is also a second business being moved in from one sub-account.
 */
async function walkTheWholeMove(
  who: TestUser,
  theirs: { organizationId: string; workspaceId: string },
): Promise<{ connectionId: string; migrationId: string }> {
  const { as, door, connectionId } = await upToChoosing(who, theirs);
  await as(migrationSelect, { ...door, choices: [{ category: 'contacts', selected: true }] });
  await as(migrationStart, { ...door, acknowledgedFindingIds: [] });
  await drain(200, door.migrationId);

  const [people] = await rows<{ count: number }>(
    admin(),
    sql`select count(*)::int as count from app.people where workspace_id = ${theirs.workspaceId}::uuid`,
  );
  expect(people!.count).toBeGreaterThan(0);
  return { connectionId, migrationId: door.migrationId };
}

/** Connect, start, look, and land the sub-account in this business: everything before choosing what comes. */
async function upToChoosing(
  who: TestUser,
  theirs: { organizationId: string; workspaceId: string },
) {
  const as = <T>(cmd: unknown, input: unknown): Promise<T> =>
    executeCommand(api(), cmd as never, input, actorOf(who), meta()).then((r) => r.output as T);
  const business = { organizationId: theirs.organizationId, workspaceId: theirs.workspaceId };

  const started = await as<{ connectionId: string; state: string }>(migrationConnect, {
    ...business,
    source: 'gohighlevel',
    authKind: 'private_token',
  });
  const pasted = await app.inject({
    method: 'POST',
    url: '/migrations/token',
    payload: { state: started.state, token: 'pit-not-a-real-token', accountId: 'loc_austin' },
  });
  expect(pasted.statusCode, pasted.body).toBe(200);

  const created = await as<{ migrationId: string }>(migrationCreate, {
    ...business,
    connectionId: started.connectionId,
    name: 'GoHighLevel',
  });
  const door = { ...business, migrationId: created.migrationId };
  const scan = await as<{ scanId: string }>(migrationScan, door);
  expect(scan.scanId).toBeTruthy();
  await drain(200, created.migrationId);

  const found = (await executeQuery(api(), migrationGet as never, door, actorOf(who), meta())) as {
    scopes: { id: string; externalScopeId: string }[];
  };
  const austin = found.scopes.find((s) => s.externalScopeId === 'loc_austin')!;
  // Nobody here runs the account, so a new business isn't theirs to make: said in words, naming this one.
  const [named] = await rows<{ name: string }>(
    admin(),
    sql`select name from app.workspaces where id = ${theirs.workspaceId}::uuid`,
  );
  await expect(
    as(migrationMapScopes, {
      ...door,
      scopes: [{ scopeId: austin.id, createWorkspace: { name: 'A second copy' } }],
    }),
  ).rejects.toMatchObject({
    rule: 'migration_new_business_needs_account_owner',
    message: expect.stringContaining(`Pick ${named!.name} under Where each one lands`),
  });
  await as(migrationMapScopes, {
    ...door,
    scopes: [{ scopeId: austin.id, workspaceId: theirs.workspaceId }],
  });
  return { as, door, connectionId: started.connectionId };
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

  it('brings the fields the business invented, as fields', async () => {
    // M15 built custom fields here, so these are no longer written into a note and hoped over: the field
    // comes across as a field, and the value arrives on the customer as something you can see and filter by.
    const fields = await rows<{
      id: string;
      key: string;
      label: string;
      type: string;
      entity: string;
    }>(
      admin(),
      sql`select id::text as id, key, label, type::text as type, entity::text as entity
          from app.custom_fields
          where workspace_id = ${workspaceId}::uuid order by key`,
    );
    expect(fields.map((f) => f.key)).toContain('contact_unit_model');
    const unit = fields.find((f) => f.key === 'contact_unit_model')!;
    expect(unit).toMatchObject({ label: 'Unit model', type: 'text', entity: 'person' });
    // A date over there is a date here, not text.
    expect(fields.find((f) => f.key === 'contact_install_date')?.type).toBe('date');

    // And the value is on the customer, under that field's id.
    const [withValue] = await rows<{ custom: Record<string, unknown> }>(
      admin(),
      sql`select custom from app.people
          where workspace_id = ${workspaceId}::uuid and custom ? ${unit.id}
          limit 1`,
    );
    expect(withValue?.custom?.[unit.id]).toBe('Carrier 24ACC6');
  }, 60_000);

  it('lets an owner who is in the business but not its organization start one too', async () => {
    // An agency's organization with a client business in it, whose owner was added to the business alone —
    // the case 0068 opened the door for. Connecting worked for them; starting the migration was refused with
    // "References must belong to the same organization", because the trigger behind the insert still asked
    // for an organization member (2026-11-23).
    const agency = await createTestUser('business-door-agency', { fullName: 'Ava Agency' });
    const { output: theirs } = await executeCommand(
      api(),
      organizationCreate,
      { businessName: 'Hill Country Roofing', timezone: 'America/Chicago' },
      actorOf(agency),
      meta(),
    );
    const client = await createTestUser('business-door-client', { fullName: 'Cody Client' });
    await admin().execute(
      sql`insert into app.workspace_memberships (workspace_id, user_id, role)
          values (${theirs.workspaceId}, ${client.id}, 'owner')`,
    );
    const { connectionId, migrationId: theirMigration } = await walkTheWholeMove(client, theirs);
    const [made] = await rows<{ created_by: string }>(
      admin(),
      sql`select created_by::text as created_by from app.migrations where id = ${theirMigration}`,
    );
    expect(made?.created_by).toBe(client.id);

    // Still not somebody who manages nothing here: a stranger naming this business's connection is refused.
    const stranger = await createTestUser('business-door-nobody', { fullName: 'Nora Nobody' });
    await expect(
      executeCommand(
        api(),
        migrationCreate,
        {
          organizationId: theirs.organizationId,
          workspaceId: theirs.workspaceId,
          connectionId,
          name: 'Not mine',
        },
        actorOf(stranger),
        meta(),
      ),
    ).rejects.toThrow();
  }, 240_000);

  it('brings only what was ticked, plus what that needs, and lets go of a need nobody has any more', async () => {
    // Ticking only invoices and pressing Bring it across brought far more (2026-11-23). The screen's half was
    // that its ticks weren't saved until Save what to bring; this is the server's half. Something added
    // because a choice needed it was then read back as a choice of its own, so it stayed ticked and locked
    // after that choice was taken back, and came across anyway.
    const picky = await createTestUser('business-door-picky', { fullName: 'Pia Picky' });
    const { output: theirs } = await executeCommand(
      api(),
      organizationCreate,
      { businessName: 'Guadalupe Plumbing', timezone: 'America/Chicago' },
      actorOf(picky),
      meta(),
    );
    const { as, door } = await upToChoosing(picky, theirs);
    const got = (await executeQuery(
      api(),
      migrationGet as never,
      door,
      actorOf(picky),
      meta(),
    )) as {
      inventory: { category: string; resourceId: string | null }[];
    };
    const everything = got.inventory
      .filter((i) => i.resourceId === null && isImportable(i.category))
      .map((i) => i.category);
    expect(everything).toContain('invoices');
    type Chosen = { added: { category: string }[]; selectedCategories: string[] };

    // Only invoices. They need their customers and products, and those need the business itself. Nothing
    // else: custom fields come only when ticked (the owner, 2026-11-23).
    const first = await as<Chosen>(migrationSelect, {
      ...door,
      choices: everything.map((category) => ({ category, selected: category === 'invoices' })),
    });
    expect([...first.selectedCategories].sort()).toEqual([
      'contacts',
      'invoices',
      'locations',
      'products',
    ]);

    // Then tags instead, sent the way the old screen sent it: without the locked rows. The customers and
    // products were there only for the invoices, so they go with them.
    const locked = new Set(first.added.map((a) => a.category));
    const second = await as<Chosen>(migrationSelect, {
      ...door,
      choices: everything
        .filter((category) => !locked.has(category))
        .map((category) => ({ category, selected: category === 'tags' })),
    });
    expect([...second.selectedCategories].sort()).toEqual(['locations', 'tags']);
    const [customers] = await rows<{ selected: boolean; auto_added: boolean }>(
      admin(),
      sql`select selected, auto_added from app.migration_selections
          where migration_id = ${door.migrationId} and category = 'contacts' and resource_id is null`,
    );
    expect(customers).toMatchObject({ selected: false, auto_added: false });

    // A lock left behind before this was fixed is not a choice either. Bring it across queues the tags and
    // the business they belong to, and nothing else.
    await admin().execute(
      sql`update app.migration_selections set selected = true, auto_added = true, required_by = '{invoices}'
          where migration_id = ${door.migrationId} and category = 'contacts'`,
    );
    await as(migrationStart, { ...door, acknowledgedFindingIds: [] });
    const queued = await rows<{ category: string }>(
      admin(),
      sql`select distinct category from app.migration_jobs
          where migration_id = ${door.migrationId} and kind = 'fetch' order by category`,
    );
    expect(queued.map((q) => q.category)).toEqual(['locations', 'tags']);
  }, 120_000);

  it('brings only the customers and products on the invoices when only invoices are ticked', async () => {
    // The owner, 2026-11-23: "if i choose only invoices then it should only bring the customers that had
    // invoices", "as well as only the products and services that were in the invoices".
    const someone = await createTestUser('business-door-invoices', { fullName: 'Ivy Invoices' });
    const { output: theirs } = await executeCommand(
      api(),
      organizationCreate,
      { businessName: 'Cibolo Creek Cooling', timezone: 'America/Chicago' },
      actorOf(someone),
      meta(),
    );
    const { as, door } = await upToChoosing(someone, theirs);
    // Everything starts ticked after the scan, so only invoices is everything else unticked, the way the
    // screen sends it.
    const got = (await executeQuery(
      api(),
      migrationGet as never,
      door,
      actorOf(someone),
      meta(),
    )) as { inventory: { category: string; resourceId: string | null }[] };
    await as(migrationSelect, {
      ...door,
      choices: got.inventory
        .filter((i) => i.resourceId === null && isImportable(i.category))
        .map((i) => ({ category: i.category, selected: i.category === 'invoices' })),
    });
    await as(migrationStart, { ...door, acknowledgedFindingIds: [] });
    await drain(200, door.migrationId);

    const people = await rows<{ name: string }>(
      admin(),
      sql`select x.first_name as name from app.migration_change_journal j
          join app.people x on x.id = j.target_id
          where j.migration_id = ${door.migrationId} and j.action = 'create' and j.target_type = 'person'
          order by 1`,
    );
    const products = await rows<{ name: string }>(
      admin(),
      sql`select x.name from app.migration_change_journal j
          join app.products x on x.id = j.target_id
          where j.migration_id = ${door.migrationId} and j.action = 'create' and j.target_type = 'product'
          order by 1`,
    );
    // Austin's three bills are Dave's, Maria's and Priya's (hers is in Canadian dollars, so the bill itself
    // stays behind, but she had one). Tom, Sam and the others had none.
    expect(people.map((p) => p.name)).toEqual(['Dave', 'Maria', 'Priya']);
    // Only Dave's bill has a line that is a product, the Service call. The Replacement coil is on none.
    expect(products.map((p) => p.name)).toEqual(['Service call']);

    // Counted as what came, and the checks say where the rest are.
    const [customers] = await rows<{ found: number; imported: number }>(
      admin(),
      sql`select (counts ->> 'found')::int as found, (counts ->> 'imported')::int as imported
          from app.migration_checkpoints where migration_id = ${door.migrationId} and category = 'contacts'`,
    );
    expect(customers).toEqual({ found: 3, imported: 3 });
    const [check] = await rows<{ result: string; summary: string }>(
      admin(),
      sql`select result::text as result, summary from app.migration_verifications
          where migration_id = ${door.migrationId} and kind = 'counts' and category = 'contacts'`,
    );
    expect(check?.result).toBe('passed');
    expect(check?.summary).toContain('stayed in the old system, because Contacts wasn’t ticked');
  }, 180_000);

  it('stops a batch that is already reading when the move is taken back, so nothing is left behind', async () => {
    // 2026-11-23, Burroughs Digital: taking a move back left records in the business. A batch the worker was
    // already running was cancelled in the database but carried on reading, put itself back in the queue, and
    // wrote more after the rollback had passed. Here the owner pauses and takes it back while the customers'
    // first page is being read, one customer a page and one page a turn, as a long import would.
    const someone = await createTestUser('business-door-takeback', { fullName: 'Tia Takeback' });
    const { output: theirs } = await executeCommand(
      api(),
      organizationCreate,
      { businessName: 'Llano River Pools', timezone: 'America/Chicago' },
      actorOf(someone),
      meta(),
    );
    const { as, door } = await upToChoosing(someone, theirs);
    let pressed = false;
    const midRead: MigrationAdapters = {
      ...adapters,
      get(system) {
        const real = adapters.get(system);
        if (!real) return real;
        return {
          ...real,
          async list(connection, scope, category, options) {
            if (category === 'contacts' && !pressed) {
              pressed = true;
              await as(migrationPause, door);
              await as(migrationRollback, { ...door, confirm: true });
            }
            return real.list(connection, scope, category, { ...options, limit: 1 });
          },
        };
      },
    };
    await as(migrationSelect, { ...door, choices: [{ category: 'contacts', selected: true }] });
    await as(migrationStart, { ...door, acknowledgedFindingIds: [] });
    await drain(200, door.migrationId, { using: midRead, pageBudgetMs: 1 });
    expect(pressed).toBe(true);

    const [after] = await rows<{ status: string; live: number; working: number }>(
      admin(),
      sql`select m.status::text as status,
            (select count(*)::int from app.people p
              where p.workspace_id = ${theirs.workspaceId}::uuid and p.archived_at is null) as live,
            (select count(*)::int from app.migration_jobs j
              where j.migration_id = m.id and j.state in ('pending', 'retry', 'leased')) as working
          from app.migrations m where m.id = ${door.migrationId}`,
    );
    expect(after).toMatchObject({ status: 'rolled_back', live: 0, working: 0 });
    const got = (await executeQuery(
      api(),
      migrationGet as never,
      door,
      actorOf(someone),
      meta(),
    )) as {
      migration: { leftBehind: number };
    };
    expect(got.migration.leftBehind).toBe(0);
  }, 120_000);

  it('takes back again what a move left behind after it was taken back, and only then', async () => {
    const someone = await createTestUser('business-door-again', { fullName: 'Al Again' });
    const { output: theirs } = await executeCommand(
      api(),
      organizationCreate,
      { businessName: 'Pedernales Painting', timezone: 'America/Chicago' },
      actorOf(someone),
      meta(),
    );
    const { as, door } = await upToChoosing(someone, theirs);
    await as(migrationSelect, { ...door, choices: [{ category: 'contacts', selected: true }] });
    await as(migrationStart, { ...door, acknowledgedFindingIds: [] });
    await drain(200, door.migrationId);
    await as(migrationRollback, { ...door, confirm: true });
    await drain(200, door.migrationId);

    // What a batch that kept going used to leave: a customer this move made, written after the rollback ran.
    const [stray] = await rows<{ id: string }>(
      admin(),
      sql`select j.target_id::text as id from app.migration_change_journal j
          where j.migration_id = ${door.migrationId} and j.action = 'create' and j.target_type = 'person'
          limit 1`,
    );
    await admin().execute(sql`
      update app.migration_change_journal set reverted_at = null, revert_skipped_reason = null
       where migration_id = ${door.migrationId} and target_id = ${stray!.id}::uuid and action = 'create'`);
    // Written as the worker, the way the batch wrote it: taking a customer out of the archive is guarded.
    await asWorker(worker(), theirs, (tx) =>
      tx.execute(sql`update app.people set archived_at = null where id = ${stray!.id}::uuid`),
    );

    type Detail = { migration: { status: string; leftBehind: number } };
    const before = (await executeQuery(
      api(),
      migrationGet as never,
      door,
      actorOf(someone),
      meta(),
    )) as Detail;
    expect(before.migration).toMatchObject({ status: 'rolled_back', leftBehind: 1 });

    const again = await as<{ status: string; changed: boolean }>(migrationRollback, {
      ...door,
      confirm: true,
    });
    expect(again).toMatchObject({ status: 'rolling_back', changed: true });
    await drain(200, door.migrationId);
    const [person] = await rows<{ archived: boolean }>(
      admin(),
      sql`select archived_at is not null as archived from app.people where id = ${stray!.id}::uuid`,
    );
    expect(person?.archived).toBe(true);
    const after = (await executeQuery(
      api(),
      migrationGet as never,
      door,
      actorOf(someone),
      meta(),
    )) as Detail;
    expect(after.migration).toMatchObject({ status: 'rolled_back', leftBehind: 0 });

    // Nothing left, so pressing it again does nothing.
    const once = await as<{ status: string; changed: boolean }>(migrationRollback, {
      ...door,
      confirm: true,
    });
    expect(once).toMatchObject({ status: 'rolled_back', changed: false });
  }, 180_000);

  it('takes back the tags the move made, and keeps one the business has put on its own customer', async () => {
    // The owner's decision, 2026-11-23: a tag the move made goes when the move is taken back, unless something
    // of the business's own uses it. These tags come only on the customers (the Tags box isn't ticked), the
    // way that used to leave them out of the journal altogether.
    const someone = await createTestUser('business-door-tags', { fullName: 'Tam Tags' });
    const { output: theirs } = await executeCommand(
      api(),
      organizationCreate,
      { businessName: 'Brazos Tags & Trim', timezone: 'America/Chicago' },
      actorOf(someone),
      meta(),
    );
    const tagsHere = async () =>
      rows<{ id: string; name: string }>(
        admin(),
        sql`select id::text as id, name::text as name from app.tags
            where workspace_id = ${theirs.workspaceId}::uuid order by name`,
      );
    const theirOwn = (await tagsHere()).map((t) => t.name);
    const { as, door } = await upToChoosing(someone, theirs);
    await as(migrationSelect, { ...door, choices: [{ category: 'contacts', selected: true }] });
    await as(migrationStart, { ...door, acknowledgedFindingIds: [] });
    await drain(200, door.migrationId);
    const brought = await tagsHere();
    const vip = brought.find((t) => t.name === 'VIP');
    const plan = brought.find((t) => t.name === 'Maintenance plan');
    expect(vip && plan).toBeTruthy();

    // A customer of the business's own, wearing one of the move's tags.
    const [own] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.people (workspace_id, first_name, last_name)
          values (${theirs.workspaceId}::uuid, 'Own', 'Customer') returning id::text as id`,
    );
    await admin().execute(sql`
      insert into app.record_tags (workspace_id, tag_id, record_type, record_id)
      values (${theirs.workspaceId}::uuid, ${vip!.id}::uuid, 'person', ${own!.id}::uuid)`);

    await as(migrationRollback, { ...door, confirm: true });
    await drain(200, door.migrationId);

    // The tag nothing of theirs used is gone; the one on their own customer stays, still on them.
    expect((await tagsHere()).map((t) => t.name)).toEqual([...theirOwn, 'VIP'].sort());
    const [still] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.record_tags
          where tag_id = ${vip!.id}::uuid and record_id = ${own!.id}::uuid`,
    );
    expect(still?.n).toBe(1);
    const journal = await rows<{ target_id: string; reverted: boolean; reason: string | null }>(
      admin(),
      sql`select target_id::text as target_id, reverted_at is not null as reverted,
            revert_skipped_reason as reason
          from app.migration_change_journal
          where migration_id = ${door.migrationId} and target_type = 'tag' and action = 'create'`,
    );
    expect(journal.find((j) => j.target_id === vip!.id)).toMatchObject({
      reverted: true,
      reason: 'depended_on',
    });
    expect(journal.find((j) => j.target_id === plan!.id)).toMatchObject({
      reverted: true,
      reason: null,
    });
    const got = (await executeQuery(
      api(),
      migrationGet as never,
      door,
      actorOf(someone),
      meta(),
    )) as {
      migration: { status: string; leftBehind: number };
    };
    expect(got.migration).toMatchObject({ status: 'rolled_back', leftBehind: 0 });
  }, 180_000);

  it('lets the founder, working in a business as its owner, move it in', async () => {
    // The founder opens a customer's business as its owner (20261013002100) without ever joining it or its
    // organization. Starting the move was fixed beside the case above; "Save and choose what to bring" then
    // said "You don't have permission to do that" (2026-11-23, in a real customer's business).
    const customer = await createTestUser('business-door-customer', { fullName: 'Bea Customer' });
    const { output: theirs } = await executeCommand(
      api(),
      organizationCreate,
      { businessName: 'Pecan Street Digital', timezone: 'America/Chicago' },
      actorOf(customer),
      meta(),
    );
    const founder = await createTestUser('business-door-founder', { fullName: 'Fran Founder' });
    // There is only ever one, marked at the database's console.
    await admin().execute(sql`update platform.staff set founder = false where founder`);
    await admin().execute(
      sql`insert into platform.staff (user_id, role, founder) values (${founder.id}, 'agent', true)`,
    );
    try {
      await executeCommand(
        api(),
        platformViewAsStart,
        { workspaceId: theirs.workspaceId },
        actorOf(founder),
        meta(),
      );
      await walkTheWholeMove(founder, theirs);
    } finally {
      await executeCommand(api(), platformViewAsEnd, {}, actorOf(founder), meta()).catch(
        () => undefined,
      );
      await admin().execute(sql`delete from platform.staff where user_id = ${founder.id}`);
    }
  }, 240_000);

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
