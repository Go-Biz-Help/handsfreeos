import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import {
  as,
  bootstrapOrganization,
  closeAll,
  createTestUser,
  dbs,
  uniq,
  type TestUser,
} from './harness';

/**
 * The two doors onto one migration (0068), on the real database.
 *
 * The shape under test is an agency with two client businesses and one migration carrying both. What has to
 * hold, and what these tests exist to catch if it ever stops holding:
 *
 *   - the agency sees the whole thing;
 *   - each client sees its own sub-account, its own counts and its own findings;
 *   - **neither client sees the other's anything** — that is the line, and it is row by row rather than
 *     table by table, because both clients' rows live in the same tables;
 *   - a plain member of a client business sees none of it.
 */
let agencyOwner: TestUser;
let austinOwner: TestUser;
let dallasOwner: TestUser;
let austinMember: TestUser;
let orgId = '';
let austinWs = '';
let dallasWs = '';
let migrationId = '';
let austinScope = '';
let dallasScope = '';

const admin = () => dbs.admin.db;

beforeAll(async () => {
  agencyOwner = await createTestUser('m11rls-agency');
  austinOwner = await createTestUser('m11rls-austin');
  dallasOwner = await createTestUser('m11rls-dallas');
  austinMember = await createTestUser('m11rls-member');

  const boot = await bootstrapOrganization(agencyOwner, `M11 RLS Agency ${uniq()}`, 'Austin HVAC');
  orgId = boot.orgId;
  austinWs = boot.wsId;

  // A second client business under the same agency, and each client's own people. Scaffolding, so it is
  // built as the database owner: the worker role may not create a workspace, and none of this is what the
  // test is about.
  const [ws] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.workspaces (organization_id, name, slug, timezone)
        values (${orgId}, 'Dallas HVAC', ${'dallas-' + uniq()}, 'America/Chicago')
        returning id::text as id`,
  );
  dallasWs = ws!.id;
  await admin().execute(sql`insert into app.workspace_memberships (workspace_id, user_id, role)
    values (${austinWs}, ${austinOwner.id}::uuid, 'owner'),
           (${austinWs}, ${austinMember.id}::uuid, 'member'),
           (${dallasWs}, ${dallasOwner.id}::uuid, 'owner')`);

  // One agency migration carrying both businesses.
  {
    const tx = admin();
    const [c] = await rows<{ id: string }>(
      tx,
      sql`insert into app.migration_connections
            (organization_id, source_system, install_kind, status, external_account_id, created_by)
          values (${orgId}, 'gohighlevel', 'agency', 'active', ${'acct-' + uniq()}, ${agencyOwner.id}::uuid)
          returning id::text as id`,
    );
    const [m] = await rows<{ id: string }>(
      tx,
      sql`insert into app.migrations (organization_id, connection_id, source_system, status, name, created_by)
          values (${orgId}, ${c!.id}::uuid, 'gohighlevel', 'scanned', 'Off GoHighLevel', ${agencyOwner.id}::uuid)
          returning id::text as id`,
    );
    migrationId = m!.id;
    for (const [ws, name, out] of [
      [austinWs, 'Austin sub-account', 'austin'],
      [dallasWs, 'Dallas sub-account', 'dallas'],
    ] as const) {
      const [s] = await rows<{ id: string }>(
        tx,
        sql`insert into app.migration_scopes
              (migration_id, organization_id, workspace_id, external_scope_id, name, status, selected)
            values (${migrationId}, ${orgId}, ${ws}, ${'loc-' + out}, ${name}, 'mapped', true)
            returning id::text as id`,
      );
      if (out === 'austin') austinScope = s!.id;
      else dallasScope = s!.id;
      await tx.execute(sql`
        insert into app.migration_inventory
          (migration_id, organization_id, scope_id, category, found_count, count_quality, capability)
        values (${migrationId}, ${orgId}, ${s!.id}, 'contacts', ${out === 'austin' ? 500 : 900},
          'complete', 'ready')`);
      await tx.execute(sql`
        insert into app.migration_findings
          (migration_id, organization_id, scope_id, category, code, capability, severity, summary)
        values (${migrationId}, ${orgId}, ${s!.id}, 'contacts', ${'only.' + out}, 'needs_review', 'info',
          ${'A note about ' + out})`);
    }
  }
}, 120_000);

afterAll(closeAll);

const seenScopes = (u: TestUser) =>
  as(u)((tx) =>
    rows<{ name: string }>(
      tx,
      sql`select name from app.migration_scopes where migration_id = ${migrationId} order by name`,
    ),
  ).then((r) => r.map((x) => x.name));

const seenCounts = (u: TestUser) =>
  as(u)((tx) =>
    rows<{ found_count: string }>(
      tx,
      sql`select found_count::text from app.migration_inventory where migration_id = ${migrationId}`,
    ),
  ).then((r) => r.map((x) => Number(x.found_count)).sort((a, b) => a - b));

const seenFindings = (u: TestUser) =>
  as(u)((tx) =>
    rows<{ code: string }>(
      tx,
      sql`select code from app.migration_findings where migration_id = ${migrationId} order by code`,
    ),
  ).then((r) => r.map((x) => x.code));

describe('one migration, two doors', () => {
  it('the agency sees every business in it', async () => {
    expect(await seenScopes(agencyOwner)).toEqual(['Austin sub-account', 'Dallas sub-account']);
    expect(await seenCounts(agencyOwner)).toEqual([500, 900]);
    expect(await seenFindings(agencyOwner)).toEqual(['only.austin', 'only.dallas']);
  });

  it('a client sees its own business, and the migration it belongs to', async () => {
    expect(await seenScopes(austinOwner)).toEqual(['Austin sub-account']);
    const seen = await as(austinOwner)((tx) =>
      rows<{ name: string }>(tx, sql`select name from app.migrations where id = ${migrationId}`),
    );
    expect(seen.map((m) => m.name)).toEqual(['Off GoHighLevel']);
  });

  it('never another client’s counts or notes', async () => {
    expect(await seenCounts(austinOwner)).toEqual([500]);
    expect(await seenFindings(austinOwner)).toEqual(['only.austin']);
    expect(await seenCounts(dallasOwner)).toEqual([900]);
    expect(await seenFindings(dallasOwner)).toEqual(['only.dallas']);
  });

  it('a member of a client business sees none of it', async () => {
    expect(await seenScopes(austinMember)).toEqual([]);
    expect(await seenCounts(austinMember)).toEqual([]);
    const migrations = await as(austinMember)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`select id::text as id from app.migrations where id = ${migrationId}`,
      ),
    );
    expect(migrations).toEqual([]);
  });

  it('a client may point its own sub-account, and not the other client’s', async () => {
    await as(austinOwner)((tx) =>
      tx.execute(
        sql`update app.migration_scopes set status = 'mapped' where id = ${austinScope}::uuid`,
      ),
    );
    // Row policies make another client's sub-account invisible, so the update simply matches nothing.
    await as(austinOwner)((tx) =>
      tx.execute(
        sql`update app.migration_scopes set selected = false where id = ${dallasScope}::uuid`,
      ),
    );
    const [dallas] = await rows<{ selected: boolean }>(
      admin(),
      sql`select selected from app.migration_scopes where id = ${dallasScope}::uuid`,
    );
    expect(dallas?.selected).toBe(true);
  });

  it('gives the workspace permission to owners and admins, and to nobody else', async () => {
    const granted = await rows<{ role: string }>(
      admin(),
      sql`select role from app.role_permissions where permission = 'migrations.manage' order by role`,
    );
    expect(granted.map((r) => r.role)).toEqual(['admin', 'owner']);
  });
});
