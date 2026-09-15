import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import { workspaceMemberships } from '../src/schema/index';
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
let member: TestUser;
let outsider: TestUser;
let A: { ws: string; org: string };
let B: { ws: string; org: string };

beforeAll(async () => {
  [owner, member, outsider] = await Promise.all([
    createTestUser('tz-owner'),
    createTestUser('tz-member'),
    createTestUser('tz-outsider'),
  ]);
  const a = await bootstrapOrganization(owner, 'Timezone Org A', 'Timezone A');
  A = { ws: a.wsId, org: a.orgId };
  const b = await bootstrapOrganization(outsider, 'Timezone Org B', 'Timezone B');
  B = { ws: b.wsId, org: b.orgId };
  await dbs.admin.db
    .insert(workspaceMemberships)
    .values([{ workspaceId: A.ws, userId: member.id, role: 'member' }]);
  await dbs.admin.db.execute(
    sql`update app.workspaces set timezone = 'America/Denver' where id = ${B.ws}`,
  );
});
afterAll(closeAll);

describe('every business’s time zone', () => {
  it('lists each business with its organization and time zone, to the worker only', async () => {
    const listed = await asService({})((tx) =>
      rows<{ workspace_id: string; organization_id: string; timezone: string }>(
        tx,
        sql`select * from private.workspace_timezones() where workspace_id in (${A.ws}, ${B.ws})`,
      ),
    );
    expect(Object.fromEntries(listed.map((w) => [w.workspace_id, w]))).toEqual({
      [A.ws]: { workspace_id: A.ws, organization_id: A.org, timezone: 'America/Chicago' },
      [B.ws]: { workspace_id: B.ws, organization_id: B.org, timezone: 'America/Denver' },
    });
    // A job bound to one business sees them all too: the planner is the worker either way.
    const [scoped] = await asService({ workspaceId: A.ws, organizationId: A.org })((tx) =>
      rows<{ n: number }>(tx, sql`select count(*)::int as n from private.workspace_timezones()`),
    );
    expect(scoped!.n).toBeGreaterThanOrEqual(2);
    // People can't ask, whatever their role, even about their own business.
    for (const user of [owner, member, outsider])
      expect(
        (
          await expectPgError(() =>
            as(user)((tx) => rows(tx, sql`select * from private.workspace_timezones()`)),
          )
        ).code,
      ).toBe('42501');
  });
});
