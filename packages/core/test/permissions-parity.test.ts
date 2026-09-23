import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { afterAll, expect, it } from 'vitest';
import { CUSTOMIZABLE_PERMISSIONS, ROLE_PERMISSIONS } from '../src/permissions';

afterAll(closeTestDbs);

it('ROLE_PERMISSIONS in TypeScript equals app.role_permissions in the database', async () => {
  const live = await rows<{ role: string; permission: string }>(
    testDbs().admin.db,
    sql`select role, permission from app.role_permissions`,
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
    sql`select permission, requires from app.customizable_permissions`,
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
