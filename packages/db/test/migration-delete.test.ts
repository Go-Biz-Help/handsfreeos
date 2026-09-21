/**
 * 0086 and 0088: taking a move off the list, whether it finished or never started.
 *
 * **Needs the stack up.** The rules worth testing are all the function's own, and a `security definer`
 * function that trusts its caller is the bug this file exists to catch:
 *
 *   - it refuses a move that put records here and has not been rolled back, whoever asks;
 *   - it deletes one that put nothing here at whatever step it stopped on, because there is nothing to put
 *     back and a rollback with no work to do is not a step (0088);
 *   - it refuses one that is still running either way, because the journal it reads to tell the two apart
 *     is not a settled answer while the engine holds a lease;
 *   - it refuses somebody who does not manage migrations, even though it runs past every policy;
 *   - it keeps a customer who has been talked to since, however plainly the import made them;
 *   - and it never touches a phone number that really moved carrier.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import {
  as,
  asService,
  bootstrapOrganization,
  closeAll,
  createTestUser,
  dbs,
  expectPgError,
  type TestUser,
} from './harness';

let owner: TestUser;
let outsider: TestUser;
let org: string;
let ws: string;
let connectionId: string;
const admin$ = dbs.admin.db;

const randomE164 = (): string =>
  `+1${2 + Math.floor(Math.random() * 8)}${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;

/** A move that has imported one customer, with the journal entry that says it made them. */
async function aMove(status: string): Promise<{ migrationId: string; personId: string }> {
  const worker = asService({ workspaceId: ws, organizationId: org });
  const [m] = await worker((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.migrations (organization_id, connection_id, source_system, status, name, adapter_version)
          values (${org}, ${connectionId}, 'gohighlevel', ${status}::app.migration_status, 'Lone Star move', 1)
          returning id`,
    ),
  );
  const migrationId = m!.id;
  const [scope] = await worker((tx) =>
    rows<{ id: string }>(
      tx,
      // `external_scope_id` — the source's own id for the sub-account. There is no `source_location_id`;
      // this fixture invented one and every test in the file died on it.
      sql`insert into app.migration_scopes (migration_id, organization_id, workspace_id, external_scope_id, name, selected)
          values (${migrationId}, ${org}, ${ws}, ${'loc_' + Math.random().toString(36).slice(2, 10)}, 'Lone Star', true)
          returning id`,
    ),
  );
  const [person] = await worker((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.people (workspace_id, first_name, last_name, phone_e164, archived_at)
          values (${ws}, 'Imported', 'Customer', ${randomE164()}, now()) returning id`,
    ),
  );
  await worker((tx) =>
    rows(
      tx,
      sql`insert into app.migration_change_journal
            (migration_id, organization_id, scope_id, workspace_id, action, target_type, target_id)
          values (${migrationId}, ${org}, ${scope!.id}, ${ws}, 'create', 'person', ${person!.id})`,
    ),
  );
  return { migrationId, personId: person!.id };
}

/**
 * A move that never wrote anything: connected, maybe scanned, and then thought better of.
 *
 * The scope row is deliberately there. Being far enough along to have found the sub-accounts is exactly the
 * state people get stuck in, and it is the journal — not the scopes, not the badge — that decides which of
 * the two acts deleting is.
 */
async function anEmptyMove(status: string): Promise<string> {
  const worker = asService({ workspaceId: ws, organizationId: org });
  const [m] = await worker((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.migrations (organization_id, connection_id, source_system, status, name, adapter_version)
          values (${org}, ${connectionId}, 'gohighlevel', ${status}::app.migration_status, 'Second thoughts', 1)
          returning id`,
    ),
  );
  const migrationId = m!.id;
  await worker((tx) =>
    rows(
      tx,
      sql`insert into app.migration_scopes (migration_id, organization_id, workspace_id, external_scope_id, name, selected)
          values (${migrationId}, ${org}, ${ws}, ${'loc_' + Math.random().toString(36).slice(2, 10)}, 'Lone Star', true)`,
    ),
  );
  return migrationId;
}

const countOf = async (migrationId: string): Promise<number> => {
  const [row] = await rows<{ n: number }>(
    admin$,
    sql`select count(*)::int as n from app.migrations where id = ${migrationId}`,
  );
  return row!.n;
};

const remove = (migrationId: string, who: TestUser) =>
  as(who)((tx) =>
    rows<{ removed: number; kept: number }>(
      tx,
      sql`select * from private.delete_migration(${migrationId})`,
    ),
  );

beforeAll(async () => {
  [owner, outsider] = await Promise.all([
    createTestUser('mig-del-owner'),
    createTestUser('mig-del-outsider'),
  ]);
  const a = await bootstrapOrganization(owner, 'Migration Delete Org', 'Migration Delete');
  org = a.orgId;
  ws = a.wsId;
  await bootstrapOrganization(outsider, 'Somebody Else', 'Somebody Else');
  const [c] = await asService({ workspaceId: null, organizationId: org })((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.migration_connections (organization_id, source_system, status, adapter_version)
          values (${org}, 'gohighlevel', 'active', 1) returning id`,
    ),
  );
  connectionId = c!.id;
}, 60_000);

afterAll(closeAll);

describe('the order is forced, not suggested', () => {
  // 0088 loosened this for moves that wrote nothing, and for nothing else: a move that put records here is
  // rolled back first at every step it can be caught on, not just at the one it finished on.
  for (const status of ['ready', 'paused', 'needs_attention', 'failed', 'imported']) {
    it(`refuses a move at ${status} that has put records here`, async () => {
      const { migrationId } = await aMove(status);
      expect((await expectPgError(() => remove(migrationId, owner))).message).toMatch(
        /take the migration back/i,
      );
      expect(await countOf(migrationId)).toBe(1);
    });
  }

  it('refuses a move that has not been taken back', async () => {
    const { migrationId } = await aMove('completed');
    // `expectPgError`, not `rejects.toThrow`: Drizzle wraps the Postgres error as "Failed query: …", so a
    // match against the function's own words never sees them.
    expect((await expectPgError(() => remove(migrationId, owner))).message).toMatch(
      /take the migration back/i,
    );
    // And it is still there.
    const [still] = await rows<{ n: number }>(
      admin$,
      sql`select count(*)::int as n from app.migrations where id = ${migrationId}`,
    );
    expect(still!.n).toBe(1);
  });
});

describe('a move that never put anything here just goes (0088)', () => {
  // Every step a move can stop on before it writes, and the ones it can reach and still have written
  // nothing. Each was a dead end before 0088: no rollback would take it, so no delete would either.
  for (const status of [
    'draft',
    'connected',
    'scanned',
    'ready',
    'paused',
    'needs_attention',
    'failed',
    'cancelled',
  ]) {
    it(`deletes one sitting at ${status}`, async () => {
      const migrationId = await anEmptyMove(status);
      const [done] = await remove(migrationId, owner);
      // Nothing was put here, so nothing was finished off and nothing was kept.
      expect(done!.removed).toBe(0);
      expect(done!.kept).toBe(0);
      expect(await countOf(migrationId)).toBe(0);
    });
  }

  it('still asks who is asking', async () => {
    const migrationId = await anEmptyMove('ready');
    expect((await expectPgError(() => remove(migrationId, outsider))).message).toMatch(
      /manage migrations/i,
    );
    expect(await countOf(migrationId)).toBe(1);
  });

  it('takes the queued work with it, which is the point of deleting it', async () => {
    const migrationId = await anEmptyMove('ready');
    await asService({ workspaceId: ws, organizationId: org })((tx) =>
      rows(
        tx,
        sql`insert into app.migration_jobs (migration_id, organization_id, kind, category, pass, input)
            values (${migrationId}, ${org}, 'scan', 'locations', 0, '{}'::jsonb)`,
      ),
    );
    await remove(migrationId, owner);
    const [jobs] = await rows<{ n: number }>(
      admin$,
      sql`select count(*)::int as n from app.migration_jobs where migration_id = ${migrationId}`,
    );
    expect(jobs!.n).toBe(0);
  });
});

describe('a move that is still going is stopped first, not raced', () => {
  // Whatever the journal says this instant, the engine may write again before the delete commits. The
  // answer is the step it is on, so the screen can say "pause it" — which is a button.
  for (const status of ['scanning', 'importing', 'rolling_back', 'cancelling']) {
    it(`refuses one at ${status}, even with nothing written`, async () => {
      const migrationId = await anEmptyMove(status);
      expect((await expectPgError(() => remove(migrationId, owner))).message).toMatch(
        /stop the migration/i,
      );
      expect(await countOf(migrationId)).toBe(1);
    });
  }

  it('refuses one that reads paused while a batch is still running', async () => {
    // Pausing stops the *next* batch, not the one already going — which is what it says it does. Pause and
    // then Delete is what somebody in a hurry does, and the lease is the only thing that knows.
    const migrationId = await anEmptyMove('paused');
    await asService({ workspaceId: ws, organizationId: org })((tx) =>
      rows(
        tx,
        sql`insert into app.migration_jobs
              (migration_id, organization_id, kind, category, pass, state, leased_by, leased_until)
            values (${migrationId}, ${org}, 'import', 'contacts', 1, 'leased', 'worker-1',
                    now() + interval '2 minutes')`,
      ),
    );
    expect((await expectPgError(() => remove(migrationId, owner))).message).toMatch(
      /stop the migration/i,
    );
    expect(await countOf(migrationId)).toBe(1);
  });

  it('lets go once the lease has run out', async () => {
    // An expired lease is a worker that died, not one still writing: the engine's own claim treats it as
    // work to be picked up again, so it must not wedge a move nobody can clear.
    const migrationId = await anEmptyMove('paused');
    await asService({ workspaceId: ws, organizationId: org })((tx) =>
      rows(
        tx,
        sql`insert into app.migration_jobs
              (migration_id, organization_id, kind, category, pass, state, leased_by, leased_until)
            values (${migrationId}, ${org}, 'import', 'contacts', 1, 'leased', 'worker-1',
                    now() - interval '1 minute')`,
      ),
    );
    await remove(migrationId, owner);
    expect(await countOf(migrationId)).toBe(0);
  });
});

describe('it asks its own permission question', () => {
  it('refuses somebody who does not manage migrations, definer or not', async () => {
    const { migrationId } = await aMove('rolled_back');
    expect((await expectPgError(() => remove(migrationId, outsider))).message).toMatch(
      /manage migrations/i,
    );
  });
});

describe('what it removes, and what it will not', () => {
  it('finishes off an archived customer the import made', async () => {
    const { migrationId, personId } = await aMove('rolled_back');
    const [done] = await remove(migrationId, owner);
    expect(done!.removed).toBe(1);
    expect(done!.kept).toBe(0);
    const [left] = await rows<{ n: number }>(
      admin$,
      sql`select count(*)::int as n from app.people where id = ${personId}`,
    );
    expect(left!.n).toBe(0);
    // And the move is off the list, with its bookkeeping cascaded away.
    const [gone] = await rows<{ n: number }>(
      admin$,
      sql`select count(*)::int as n from app.migrations where id = ${migrationId}`,
    );
    expect(gone!.n).toBe(0);
  });

  it('keeps a customer somebody has talked to since', async () => {
    const { migrationId, personId } = await aMove('rolled_back');
    await asService({ workspaceId: ws, organizationId: org })((tx) =>
      rows(
        tx,
        sql`insert into app.conversations (workspace_id, channel, counterpart, person_id)
            values (${ws}, 'sms', ${randomE164()}, ${personId})`,
      ),
    );
    const [done] = await remove(migrationId, owner);
    expect(done!.removed).toBe(0);
    expect(done!.kept).toBe(1);
    // Kept, and still put away: the rollback's decision stands, this one just does not undo it.
    const [row] = await rows<{ archived: boolean }>(
      admin$,
      sql`select (archived_at is not null) as archived from app.people where id = ${personId}`,
    );
    expect(row!.archived).toBe(true);
  });

  it('keeps a customer somebody has un-archived, which is somebody wanting them', async () => {
    const { migrationId, personId } = await aMove('rolled_back');
    await asService({ workspaceId: ws, organizationId: org })((tx) =>
      rows(tx, sql`update app.people set archived_at = null where id = ${personId}`),
    );
    const [done] = await remove(migrationId, owner);
    expect(done!.kept).toBe(1);
    const [left] = await rows<{ n: number }>(
      admin$,
      sql`select count(*)::int as n from app.people where id = ${personId}`,
    );
    expect(left!.n).toBe(1);
  });

  it('never hands a number that really moved carrier back', async () => {
    // The port request cascades away with the move; app.number_ports (0080) has its own life, and a business
    // whose phone number actually changed carrier must not lose it because an import was deleted.
    const { migrationId } = await aMove('rolled_back');
    const e164 = randomE164();
    const worker = asService({ workspaceId: ws, organizationId: org });
    const [port] = await worker((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.number_ports (workspace_id, e164, kind, status)
            values (${ws}, ${e164}, 'full', 'complete') returning id`,
      ),
    );
    await worker((tx) =>
      rows(
        tx,
        sql`insert into app.migration_port_requests (migration_id, organization_id, workspace_id, e164, number_port_id)
            values (${migrationId}, ${org}, ${ws}, ${e164}, ${port!.id})`,
      ),
    );
    await remove(migrationId, owner);
    const [still] = await rows<{ n: number }>(
      admin$,
      sql`select count(*)::int as n from app.number_ports where id = ${port!.id}`,
    );
    expect(still!.n).toBe(1);
  });
});
