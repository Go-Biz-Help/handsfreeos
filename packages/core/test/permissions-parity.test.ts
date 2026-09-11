import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { afterAll, expect, it } from 'vitest';
import { ROLE_PERMISSIONS } from '../src/permissions';

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
