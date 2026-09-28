import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { afterAll, expect, it } from 'vitest';
import { ADDON_CATALOG } from '../src/addons/catalog';
import { CUSTOMIZABLE_PERMISSIONS, ROLE_PERMISSIONS } from '../src/permissions';

afterAll(closeTestDbs);

/**
 * Core's rows have no add-on; a real add-on's rows carry its id and are checked against its manifest below. Rows of
 * any other add-on id belong to the add-on tests' fixtures (ids starting `fx`), which register their permissions in
 * the shared local database, and are left out.
 */
const REAL_ADDONS = ADDON_CATALOG.map((m) => m.id);
/** As a Postgres array literal: ids are letters only, so nothing needs quoting. */
const REAL_ADDONS_ARRAY = `{${REAL_ADDONS.join(',')}}`;

it('ROLE_PERMISSIONS in TypeScript equals app.role_permissions in the database', async () => {
  const live = await rows<{ role: string; permission: string }>(
    testDbs().admin.db,
    sql`select role, permission from app.role_permissions where addon_id is null`,
  );
  const liveMap: Record<string, string[]> = {};
  for (const r of live) (liveMap[r.role] ??= []).push(r.permission);
  for (const k of Object.keys(liveMap)) liveMap[k]!.sort();
  const expected = Object.fromEntries(
    Object.entries(ROLE_PERMISSIONS).map(([k, v]) => [k, [...v].sort()]),
  );
  expect(liveMap).toEqual(expected);
});

it('the permissions a business may set, and what each stands on, are the same in both', async () => {
  const live = await rows<{ permission: string; requires: string[] }>(
    testDbs().admin.db,
    sql`select permission, requires from app.customizable_permissions where addon_id is null`,
  );
  const liveMap = Object.fromEntries(live.map((r) => [r.permission, [...r.requires].sort()]));
  const expected = Object.fromEntries(
    CUSTOMIZABLE_PERMISSIONS.map((p) => [p.permission, [...p.requires].sort()]),
  );
  expect(liveMap).toEqual(expected);
  // Everything one can be set to stands only on permissions that exist, and every one is an owner's.
  const owner = new Set<string>(ROLE_PERMISSIONS.owner);
  for (const p of CUSTOMIZABLE_PERMISSIONS) {
    expect(owner.has(p.permission), p.permission).toBe(true);
    for (const r of p.requires) expect(owner.has(r), `${p.permission} needs ${r}`).toBe(true);
  }
});

it('each real add-on’s permissions in the database are the ones its manifest declares', async () => {
  const live = await rows<{ addon_id: string; role: string; permission: string }>(
    testDbs().admin.db,
    sql`select addon_id, role, permission from app.role_permissions
        where addon_id = any (${REAL_ADDONS_ARRAY}::text[]) order by addon_id, role, permission`,
  );
  const expected = ADDON_CATALOG.flatMap((m) =>
    m.permissions.flatMap((p) =>
      ['owner', ...p.defaultRoles].map((role) => ({ addon_id: m.id, role, permission: p.key })),
    ),
  ).sort(
    (a, b) =>
      a.addon_id.localeCompare(b.addon_id) ||
      a.role.localeCompare(b.role) ||
      a.permission.localeCompare(b.permission),
  );
  expect(live).toEqual(expected);
  // And nothing claims to be a real add-on's permission that its manifest doesn't declare.
  const declared = new Set(ADDON_CATALOG.flatMap((m) => m.permissions.map((p) => p.key)));
  const custom = await rows<{ permission: string }>(
    testDbs().admin.db,
    sql`select permission from app.customizable_permissions where addon_id = any (${REAL_ADDONS_ARRAY}::text[])`,
  );
  for (const c of custom) expect(declared.has(c.permission), c.permission).toBe(true);
});
