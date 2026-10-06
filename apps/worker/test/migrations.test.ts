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
  migrationResolveMerge,
  migrationReviewQueue,
  migrationRollback,
  migrationResume,
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

/**
 * Runs the migration loop until **this migration** has nothing left to do.
 *
 * Deliberately not "until the loop claims nothing". Claiming is global, which is right in production — one
 * worker serves every business — but it means a leftover batch from an earlier run, or from another session
 * sharing this database, is claimed by this loop too. Waiting on the global queue therefore lets the loop go
 * quiet while this migration's own work is still outstanding, and because these tests share one migration in
 * sequence, one early return fails every assertion after it. Asking about our own rows instead makes the run
 * the same whatever else the database happens to be holding.
 */
async function drain(limit = 400): Promise<void> {
  for (let i = 0; i < limit; i++) {
    // A batch that failed once is scheduled minutes out by the backoff. Waiting for it would stall the run
    // and ignoring it would end the run early with the work half done — which is what made this suite
    // nondeterministic even after the jobs stopped being stolen. So it is pulled forward instead: the retry
    // happens now, and a batch that genuinely cannot succeed still exhausts its attempts and shows up as
    // failed rather than being quietly skipped.
    await admin().execute(
      sql`update app.migration_jobs set run_at = now()
          where migration_id = ${w.migrationId} and state in ('pending', 'retry') and run_at > now()`,
    );
    const [mine] = await rows<{ count: number }>(
      admin(),
      sql`select count(*)::int as count from app.migration_jobs
          where migration_id = ${w.migrationId}
            and (state = 'leased' or state in ('pending', 'retry'))`,
    );
    if ((mine?.count ?? 0) === 0) return;
    await processMigrationJobs(w.deps);
  }
  // Loud, and with the reason: a silent timeout here would look exactly like a product bug.
  const stuck = await rows<{
    kind: string;
    category: string;
    state: string;
    last_error: string | null;
  }>(
    admin(),
    sql`select kind::text as kind, category, state::text as state, last_error
        from app.migration_jobs where migration_id = ${w.migrationId}
          and state in ('pending', 'retry', 'leased')`,
  );
  throw new Error(`this migration never went quiet: ${JSON.stringify(stuck)}`);
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
      ...standInMedia(),
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
    expect(contacts?.found).toBe(11);
    expect(contacts?.countLabel).toBe('11');
  }, 60_000);

  it('never shows a permission problem as an empty account', async () => {
    const got = await ask<{
      inventory: { category: string; found: number; countLabel: string; capability: string }[];
      findings: { code: string; summary: string; recommendedAction: string | null }[];
    }>(migrationGet, { organizationId: w.organizationId, migrationId: w.migrationId });
    const fields = got.inventory.find((i) => i.category === 'custom_fields');
    expect(fields?.capability).toBe('not_available');
    // The whole point: not "0".
    expect(fields?.countLabel).toBe('not shared with us');
    const finding = got.findings.find((f) => f.code === 'access.scope_missing');
    // A sign-in made before the app was retired still gets a fix the screens offer: a token.
    expect(finding?.recommendedAction).toContain('private integration token');
    expect(finding?.recommendedAction).not.toMatch(/sign in again/i);
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

  it('makes the business when a sub-account has nowhere to land, and leaves one behind when told', async () => {
    // The default on that screen, and the one path no test took until it 500'd in somebody's hands: making
    // the business raises `workspace.created`, and a command may only raise events it declares.
    const got = await ask<{ scopes: { id: string; name: string }[] }>(migrationGet, {
      organizationId: w.organizationId,
      migrationId: w.migrationId,
    });
    const austin = got.scopes.find((s) => s.name.includes('Austin'))!;
    const made = await run<{ mapped: number }>(migrationMapScopes, {
      organizationId: w.organizationId,
      migrationId: w.migrationId,
      scopes: [
        {
          scopeId: austin.id,
          createWorkspace: { name: 'Made By The Migration', timezone: 'America/Chicago' },
        },
      ],
    });
    expect(made.mapped).toBe(1);
    const [ws] = await rows<{ id: string; name: string }>(
      admin(),
      sql`select w.id::text as id, w.name from app.workspaces w
          join app.migration_scopes s on s.workspace_id = w.id
          where s.id = ${austin.id}::uuid`,
    );
    expect(ws?.name).toBe('Made By The Migration');
    // And it is a real business, with the event behind it, not a bare row.
    const [event] = await rows<{ count: number }>(
      admin(),
      sql`select count(*)::int as count from app.events
          where event_type = 'workspace.created' and entity_id = ${ws!.id}::uuid`,
    );
    expect(event?.count).toBe(1);
    // The other choice on that screen nothing had taken: leaving a sub-account behind.
    const dallas = got.scopes.find((s) => s.name.includes('Dallas'))!;
    const skipped = await run<{ mapped: number; skipped: number }>(migrationMapScopes, {
      organizationId: w.organizationId,
      migrationId: w.migrationId,
      scopes: [{ scopeId: dallas.id, skip: true }],
    });
    expect(skipped.skipped).toBe(1);
    const [left] = await rows<{ status: string; selected: boolean; workspace_id: string | null }>(
      admin(),
      sql`select status::text as status, selected, workspace_id::text as workspace_id
          from app.migration_scopes where id = ${dallas.id}::uuid`,
    );
    expect(left).toMatchObject({ status: 'skipped', selected: false, workspace_id: null });

    // Put it back where the rest of these tests expect it: both sub-accounts in the one business.
    await run(migrationMapScopes, {
      organizationId: w.organizationId,
      migrationId: w.migrationId,
      scopes: got.scopes.map((s) => ({ scopeId: s.id, workspaceId: w.workspaceId })),
    });
  }, 60_000);

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
    // Eleven customers over two sub-accounts: one is in both, one waits on a person, and one has no name,
    // no email and no number at all. So eight arrive, one is a merge, one is a question, one is kept back.
    expect(list.length).toBe(8);
    // The nameless one that could still be identified came across under what identifies it, because the
    // book has no room for a customer with no name and the old system showed them this way too.
    const nameless = list.find((p) => p.email === 'no.name@example.com');
    expect(nameless?.first_name).toBe('no.name@example.com');
    expect(nameless?.last_name).toBe('');
    const dave = list.filter((p) => p.last_name === 'Smith');
    expect(dave).toHaveLength(2); // two different Daves, never joined on a name
    const austinDave = dave.find((p) => p.phone_e164 === '+15125550101');
    expect(new Date(austinDave!.created_at).toISOString()).toBe('2019-04-11T14:22:00.000Z');
    const tom = list.filter((p) => p.first_name === 'Tom');
    expect(tom).toHaveLength(1); // the same person in both sub-accounts, joined on the number
  }, 120_000);

  it('keeps the business a customer works for, when the old system only wrote its name on them', async () => {
    const [sam] = await rows<{ company: string | null; website: string | null }>(
      admin(),
      sql`select c.name as company, c.website from app.people p
          left join app.companies c on c.id = p.company_id
          where p.workspace_id = ${w.workspaceId} and p.first_name = 'Sam' and p.last_name = 'Okafor'`,
    );
    expect(sam).toEqual({ company: 'Okafor Property Management', website: 'okaforpm.example' });
  });

  it('does not email a customer who switched email off in the old system', async () => {
    // Priya asked the old system not to contact her. Her address is on the list every email here stops at.
    const [stop] = await rows<{ reason: string }>(
      admin(),
      sql`select reason::text as reason from app.email_suppressions
          where workspace_id = ${w.workspaceId} and address = 'priya@example.com' and released_at is null`,
    );
    expect(stop?.reason).toBe('manual');
    const [priya] = await rows<{ sms_consent: string }>(
      admin(),
      sql`select sms_consent::text as sms_consent from app.people
          where workspace_id = ${w.workspaceId} and email = 'priya@example.com'`,
    );
    expect(priya?.sms_consent).toBe('opted_out');
  });

  it('keeps back a customer with no name, no email and no number, and says which one', async () => {
    // GoHighLevel makes a contact for a form somebody opened and abandoned. One with nothing on it is not a
    // customer, and the insert could never have worked: `app.people` will not take a row with no name. It
    // used to take the whole batch of customers down with it.
    const [kept] = await rows<{ source_object_id: string; message: string; retryable: boolean }>(
      admin(),
      sql`select source_object_id, message, retryable from app.migration_errors
          where migration_id = ${w.migrationId} and code = 'person_without_name'`,
    );
    expect(kept?.source_object_id).toBe('con_a7');
    expect(kept?.message).toContain('nothing here to bring');
    expect(kept?.retryable).toBe(false);
    // Left out, not failed: the progress screen reads "failed" as "needs another go", and trying again can
    // never find a name that was never there. It is said once, in words, instead.
    const [counted] = await rows<{ failed: number; skipped: number }>(
      admin(),
      sql`select sum((counts ->> 'failed')::int)::int as failed, sum((counts ->> 'skipped')::int)::int as skipped
          from app.migration_checkpoints where migration_id = ${w.migrationId} and category = 'contacts'`,
    );
    expect(counted?.failed).toBe(0);
    expect(counted?.skipped).toBeGreaterThanOrEqual(1);
    const [said] = await rows<{ summary: string }>(
      admin(),
      sql`select summary from app.migration_findings
          where migration_id = ${w.migrationId} and code = 'contacts.nothing_to_bring'`,
    );
    expect(said?.summary).toContain('no name, email address or phone number');
  });

  /**
   * The test above is the one that used to fail at random, and this is why it does not any more.
   *
   * "Email says one customer, phone says another" can only be seen once both of those customers have
   * landed. `migration.start` reads the sub-accounts in their own order by name, a millisecond apart, and
   * says so in a comment — but the claim used to break a tie on `id`, which is a random uuid. Read one way
   * it was a question; read the other it was a silent merge. Same data, different answer.
   *
   * So the order a batch was made in is now what breaks the tie, and this holds that: whatever else moves,
   * the sub-accounts are read in one order, and it is theirs.
   */
  it('reads the sub-accounts in one order, so two runs of a migration answer the same', async () => {
    const batches = await rows<{ name: string; sequence: string; category: string }>(
      admin(),
      sql`select distinct on (j.scope_id) s.name, j.sequence::text as sequence, j.category
          from app.migration_jobs j
          join app.migration_scopes s on s.id = j.scope_id
          where j.migration_id = ${w.migrationId} and j.kind = 'fetch' and j.category = 'contacts'
          order by j.scope_id, j.sequence`,
    );
    expect(batches).toHaveLength(2);
    const order = [...batches].sort((a, b) => Number(a.sequence) - Number(b.sequence));
    // Austin before Dallas, because A comes before D — not because of a uuid.
    expect(order.map((b) => b.name)).toEqual([
      'Lone Star HVAC — Austin',
      'Lone Star HVAC — Dallas',
    ]);
    // And every batch has a place in the queue, which is what the claim now reads.
    const [unplaced] = await rows<{ count: number }>(
      admin(),
      sql`select count(*)::int as count from app.migration_jobs
          where migration_id = ${w.migrationId} and sequence is null`,
    );
    expect(unplaced!.count).toBe(0);
  });

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

  it('brings the customer across the way a person decided, once they decide', async () => {
    // The screen's question, answered: Chris Doyle is nobody already here. Until 0091 the answer was
    // recorded and nothing acted on it — the batch it queued had no handler — so the customer waited forever.
    const [candidate] = await rows<{ id: string }>(
      admin(),
      sql`select id::text as id from app.migration_merge_candidates
          where migration_id = ${w.migrationId} and resolution = 'pending' and match_rule = 'conflict'`,
    );
    expect(candidate).toBeDefined();
    const before = await ask<{ needsReview: number }>(migrationGet, {
      organizationId: w.organizationId,
      migrationId: w.migrationId,
    });
    expect((await people()).some((p) => p.first_name === 'Chris')).toBe(false);

    /**
     * The queue as the screen reads it: the question, and both of the people he collides with, by name.
     *
     * Nothing called this query until the wizard did, and the lookup behind `here` handed the database a
     * bare JS array, which the query builder spreads into a row constructor — `any(($1, $2)::uuid[])` — so
     * it threw for every queue that had anybody in it and the screen sat on "Looking them up…".
     */
    const queue = await ask<{
      candidates: { id: string; incoming: { name: string }; here: { name: string }[] }[];
      remaining: number;
    }>(migrationReviewQueue, {
      organizationId: w.organizationId,
      migrationId: w.migrationId,
      limit: 10,
    });
    expect(queue.remaining).toBe(before.needsReview);
    const waiting = queue.candidates.find((c) => c.id === candidate!.id);
    expect(waiting?.incoming.name).toBe('Chris Doyle');
    expect(waiting?.here.map((h) => h.name).sort()).toEqual(['Dave Smith', 'Maria Alvarez']);

    await run(migrationResolveMerge, {
      organizationId: w.organizationId,
      migrationId: w.migrationId,
      candidateId: candidate!.id,
      decision: 'separate',
    });
    await drain();

    const chris = (await people()).find((p) => p.first_name === 'Chris' && p.last_name === 'Doyle');
    expect(chris).toBeDefined();
    // With the date the old system first knew them, like everybody else who came across.
    expect(new Date(chris!.created_at).getUTCFullYear()).toBe(2022);
    const after = await ask<{
      needsReview: number;
      progress: { category: string; imported: number; found: number }[];
    }>(migrationGet, { organizationId: w.organizationId, migrationId: w.migrationId });
    expect(after.needsReview).toBe(before.needsReview - 1);
    // Counted as brought across now, not as waiting.
    const contacts = after.progress.filter((p) => p.category === 'contacts');
    expect(contacts.reduce((n, p) => n + p.imported, 0)).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('names the right person in every "no account here" note', async () => {
    // These are counted up by their key, so without a person of their own every one of them would land on
    // the same row — with the last person's name and the first person's email beside it.
    const notes = await rows<{ summary: string; recommended_action: string }>(
      admin(),
      sql`select summary, recommended_action from app.migration_findings
          where migration_id = ${w.migrationId} and code = 'users.not_here'`,
    );
    expect(notes.length).toBeGreaterThanOrEqual(2);
    for (const n of notes) {
      const who = n.summary.split(' worked in')[0]!;
      expect(n.recommended_action).toContain(who);
    }
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

  it('carrying on never declares a migration finished: the checks say', async () => {
    // Every state a button may ask for is refused by the database unless it is one a person can really
    // cause, and "it worked" is not one of them. So: a paused migration with nothing left in the queue,
    // which is exactly the case where declaring it finished would be tempting and wrong.
    await asWorker(worker(), { organizationId: w.organizationId }, (tx) =>
      tx.execute(sql`update app.migrations set status = 'paused' where id = ${w.migrationId}`),
    );
    const resumed = await run<{ status: string }>(migrationResume, {
      organizationId: w.organizationId,
      migrationId: w.migrationId,
    });
    expect(resumed.status).toBe('importing');
    await drain();
    const [after] = await rows<{ status: string }>(
      admin(),
      sql`select status::text as status from app.migrations where id = ${w.migrationId}`,
    );
    // The checks ran again and said where it stands; the button never said it itself.
    expect(['imported', 'transition']).toContain(after?.status);
  }, 60_000);

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
