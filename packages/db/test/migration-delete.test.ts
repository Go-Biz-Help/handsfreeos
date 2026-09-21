/**
 * 0086: deleting a move that has been taken back, so the import can be run again.
 *
 * **Needs the stack up.** The rules worth testing are all the function's own, and a `security definer`
 * function that trusts its caller is the bug this file exists to catch:
 *
 *   - it refuses a move that has not been rolled back, whoever asks;
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
