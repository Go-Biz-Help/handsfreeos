/**
 * The client portal's sign-in tables (Real Estate round two, step 2): everyone in a business sees who has access
 * and their devices, never a bearer's hash or a code; only people who may change customers let someone in or turn
 * it off; another business sees nothing; and a link's version only goes up, so a link sent before never works again.
 */
import { createHash, randomBytes } from 'node:crypto';
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
let readOnly: TestUser;
let outsider: TestUser;
let ws: string;
let org: string;
let person: string;
let access: string;
let session: string;

const worker = () => asService({ workspaceId: ws, organizationId: org });
/** Fails with this Postgres code. */
async function refused(fn: () => Promise<unknown>, code: string): Promise<void> {
  expect((await expectPgError(fn)).code).toBe(code);
}

const hash = () => createHash('sha256').update(randomBytes(32)).digest();

beforeAll(async () => {
  [owner, member, readOnly, outsider] = await Promise.all([
    createTestUser('portal-owner'),
    createTestUser('portal-member'),
    createTestUser('portal-readonly'),
    createTestUser('portal-outsider'),
  ]);
  ({ wsId: ws, orgId: org } = await bootstrapOrganization(owner, 'Portal Org', 'Portal Realty'));
  await bootstrapOrganization(outsider, 'Other Org', 'Other Realty');
  await dbs.admin.db.insert(workspaceMemberships).values([
    { workspaceId: ws, userId: member.id, role: 'member' },
    { workspaceId: ws, userId: readOnly.id, role: 'member' },
  ]);
  await rows(
    dbs.admin.db,
    sql`insert into app.member_permission_overrides (workspace_id, user_id, permission, allowed)
        values (${ws}, ${readOnly.id}, 'records.write', false)`,
  );
  const [p] = await rows<{ id: string }>(
    dbs.admin.db,
    sql`insert into app.people (workspace_id, first_name, last_name, email)
        values (${ws}, 'Linh', 'Nguyen', 'linh@example.com') returning id`,
  );
  person = p!.id;
});
afterAll(closeAll);

describe('letting someone in', () => {
  it('is for people who may change customers, as themselves', async () => {
    await refused(
      () =>
        as(readOnly)((tx) =>
          rows(
            tx,
            sql`insert into app.portal_access (workspace_id, person_id, given_by)
              values (${ws}, ${person}, ${readOnly.id})`,
          ),
        ),
      '42501',
    );
    await refused(
      () =>
        as(member)((tx) =>
          rows(
            tx,
            sql`insert into app.portal_access (workspace_id, person_id, given_by)
              values (${ws}, ${person}, ${owner.id})`,
          ),
        ),
      '42501',
    );
    const [a] = await as(member)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.portal_access (workspace_id, person_id, given_by)
            values (${ws}, ${person}, ${member.id}) returning id`,
      ),
    );
    access = a!.id;
  });

  it('is seen by the business, and not by anyone else', async () => {
    const seen = (u: TestUser) =>
      as(u)((tx) =>
        rows<{ id: string }>(tx, sql`select id from app.portal_access where id = ${access}`),
      );
    expect(await seen(readOnly)).toHaveLength(1);
    expect(await seen(outsider)).toHaveLength(0);
  });
});

describe('codes and devices', () => {
  beforeAll(async () => {
    await worker()((tx) =>
      rows(
        tx,
        sql`insert into app.portal_codes (workspace_id, access_id, code_hash, expires_at)
            values (${ws}, ${access}, ${hash()}, now() + interval '10 minutes')`,
      ),
    );
    const [s] = await worker()((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.portal_sessions (workspace_id, access_id, person_id, token_hash, device, expires_at)
            values (${ws}, ${access}, ${person}, ${hash()}, 'Safari on iPhone', now() + interval '90 days')
            returning id`,
      ),
    );
    session = s!.id;
  });

  it('keeps codes from everyone but the worker', async () => {
    await refused(() => as(owner)((tx) => rows(tx, sql`select id from app.portal_codes`)), '42501');
  });

  it('shows the business its client’s devices, never a bearer’s hash', async () => {
    const devices = await as(readOnly)((tx) =>
      rows<{ device: string }>(
        tx,
        sql`select device from app.portal_sessions where access_id = ${access}`,
      ),
    );
    expect(devices).toEqual([{ device: 'Safari on iPhone' }]);
    await refused(
      () => as(owner)((tx) => rows(tx, sql`select token_hash from app.portal_sessions`)),
      '42501',
    );
    const other = await as(outsider)((tx) =>
      rows(tx, sql`select id from app.portal_sessions where id = ${session}`),
    );
    expect(other).toHaveLength(0);
  });

  it('finds a device only through the worker’s lookup', async () => {
    await refused(
      () =>
        as(owner)((tx) => rows(tx, sql`select * from private.portal_session_lookup(${hash()})`)),
      '42501',
    );
    await refused(
      () => as(owner)((tx) => rows(tx, sql`select * from private.portal_link_lookup('AAAAAAAA')`)),
      '42501',
    );
  });
});

describe('turning it off', () => {
  it('is refused to people who can’t change customers', async () => {
    const changed = await as(readOnly)((tx) =>
      rows(
        tx,
        sql`update app.portal_access set revoked_at = now(), revoked_by = ${readOnly.id},
              link_version = link_version + 1
            where id = ${access} returning id`,
      ),
    );
    expect(changed).toHaveLength(0);
  });

  it('signs every device out', async () => {
    await as(member)((tx) =>
      rows(
        tx,
        sql`update app.portal_access set revoked_at = now(), revoked_by = ${member.id},
              link_version = link_version + 1
            where id = ${access}`,
      ),
    );
    const [s] = await rows<{ ended_reason: string | null }>(
      dbs.admin.db,
      sql`select ended_reason from app.portal_sessions where id = ${session}`,
    );
    expect(s!.ended_reason).toBe('access_off');
  });

  it('never brings an old link back', async () => {
    // Letting them back in without a new version, or winding the version back, is refused.
    await refused(
      () =>
        as(member)((tx) =>
          rows(
            tx,
            sql`update app.portal_access set revoked_at = null, revoked_by = null where id = ${access}`,
          ),
        ),
      '23514',
    );
    await refused(
      () =>
        as(member)((tx) =>
          rows(tx, sql`update app.portal_access set link_version = 1 where id = ${access}`),
        ),
      '23514',
    );
    await as(member)((tx) =>
      rows(
        tx,
        sql`update app.portal_access set revoked_at = null, revoked_by = null, link_version = link_version + 1,
              given_by = ${member.id}, given_at = now()
            where id = ${access}`,
      ),
    );
  });
});
