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
  uniq,
  type TestUser,
} from './harness';

let owner: TestUser;
let orgA: string;
let orgTie: string;
let orgEmpty: string;

async function addOrg(name: string): Promise<string> {
  const [o] = await rows<{ id: string }>(
    dbs.admin.db,
    sql`insert into app.organizations (name, slug) values (${name}, ${`digest-${uniq()}`}) returning id`,
  );
  return o!.id;
}

async function addBusiness(org: string, timezone: string, createdAgo = '0 seconds') {
  await rows(
    dbs.admin.db,
    sql`insert into app.workspaces (organization_id, name, slug, timezone, created_at)
        values (${org}, ${`Digest ${timezone}`}, ${`digest-ws-${uniq()}`}, ${timezone},
          now() - ${createdAgo}::interval)`,
  );
}

beforeAll(async () => {
  owner = await createTestUser('digest-owner');
  // One business in Chicago (from the bootstrap), two in Denver: Denver is where most of them are.
  orgA = (await bootstrapOrganization(owner, 'Digest Org A', 'Digest A')).orgId;
  await addBusiness(orgA, 'America/Denver');
  await addBusiness(orgA, 'America/Denver');
  // One each: the earliest business wins, though Chicago sorts first.
  orgTie = await addOrg('Digest Tie');
  await addBusiness(orgTie, 'America/Chicago');
  await addBusiness(orgTie, 'America/Phoenix', '1 day');
  orgEmpty = await addOrg('Digest Empty');
});
afterAll(closeAll);

describe('the agency digest’s organizations', () => {
  it('each with the time zone most of its businesses use, or Chicago, to the worker only', async () => {
    const listed = await asService({})((tx) =>
      rows<{ organization_id: string; timezone: string }>(
        tx,
        sql`select organization_id, timezone from private.organization_timezones()
            where organization_id in (${orgA}, ${orgTie}, ${orgEmpty})`,
      ),
    );
    expect(Object.fromEntries(listed.map((o) => [o.organization_id, o.timezone]))).toEqual({
      [orgA]: 'America/Denver',
      [orgTie]: 'America/Phoenix',
      [orgEmpty]: 'America/Chicago',
    });
    // One organization's digest asks for its own.
    const own = await asService({ organizationId: orgA })((tx) =>
      rows(tx, sql`select * from private.organization_timezones(${orgA}::uuid)`),
    );
    expect(own).toEqual([{ organization_id: orgA, timezone: 'America/Denver' }]);

    const asPerson = await expectPgError(() =>
      as(owner)((tx) => rows(tx, sql`select * from private.organization_timezones()`)),
    );
    expect(asPerson.code).toBe('42501');
  });
});

describe('when a business’s own owners last signed in', () => {
  it('answers the agency’s owners and the worker bound to the business, and nobody else', async () => {
    const agency = await createTestUser('signin-agency');
    const client = await createTestUser('signin-client');
    const stranger = await createTestUser('signin-stranger');
    const { orgId, wsId } = await bootstrapOrganization(
      agency,
      'Sign-in Agency',
      'Sign-in Plumbing',
    );
    await rows(
      dbs.admin.db,
      sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${wsId}, ${client.id}, 'owner')`,
    );
    await rows(
      dbs.admin.db,
      sql`update auth.users set last_sign_in_at = now() - interval '6 days' where id = ${client.id}`,
    );
    await rows(
      dbs.admin.db,
      sql`update auth.users set last_sign_in_at = now() where id = ${agency.id}`,
    );
    const ask = (run: ReturnType<typeof as>) =>
      run((tx) =>
        rows<{ at: Date | null }>(tx, sql`select private.owners_last_sign_in(${wsId}) as at`),
      ).then((r) => r[0]?.at ?? null);
    // The client's own owner, six days ago; not the agency's owner, who signed in just now.
    const seen = await ask(as(agency));
    expect(seen).not.toBeNull();
    expect(Date.now() - new Date(seen!).getTime()).toBeGreaterThan(5 * 24 * 3600 * 1000);
    expect(await ask(asService({ workspaceId: wsId, organizationId: orgId }))).not.toBeNull();
    expect(await ask(as(client))).toBeNull();
    expect(await ask(as(stranger))).toBeNull();
  });
});
