/**
 * Quick setup's saved answers (20261026000100): an agency's owners and admins save, rename and remove them;
 * whoever sets up the AI teammate in one of its businesses reads them, to start from one; nobody else sees them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import { organizationMemberships, workspaceMemberships } from '../src/schema/index';
import {
  as,
  bootstrapOrganization,
  closeAll,
  createTestUser,
  dbs,
  expectPgError,
  type TestUser,
} from './harness';

/** Org A's owner (also workspace A's owner). */
let owner: TestUser;
let orgAdmin: TestUser;
/** Workspace A's own owner and admin, not in the organization. */
let bizOwner: TestUser;
let bizAdmin: TestUser;
let member: TestUser;
/** Org B's owner. */
let outsider: TestUser;
let wsA: string;
let orgA: string;
let orgB: string;

const ANSWERS = JSON.stringify({ jobs: ['reply', 'answer'], name: 'Max', tone: 'friendly' });
const code = async (fn: () => Promise<unknown>) => (await expectPgError(fn)).code;

beforeAll(async () => {
  [owner, orgAdmin, bizOwner, bizAdmin, member, outsider] = await Promise.all([
    createTestUser('setups-owner'),
    createTestUser('setups-org-admin'),
    createTestUser('setups-biz-owner'),
    createTestUser('setups-biz-admin'),
    createTestUser('setups-member'),
    createTestUser('setups-outsider'),
  ]);
  const a = await bootstrapOrganization(owner, 'Setups Agency A', 'Setups Plumbing');
  wsA = a.wsId;
  orgA = a.orgId;
  orgB = (await bootstrapOrganization(outsider, 'Setups Agency B', 'Setups Salon')).orgId;
  await dbs.admin.db
    .insert(organizationMemberships)
    .values([{ organizationId: orgA, userId: orgAdmin.id, role: 'admin' }]);
  await dbs.admin.db.insert(workspaceMemberships).values([
    { workspaceId: wsA, userId: bizOwner.id, role: 'owner' },
    { workspaceId: wsA, userId: bizAdmin.id, role: 'admin' },
    { workspaceId: wsA, userId: member.id, role: 'member' },
  ]);
});
afterAll(closeAll);

/** Saves one as `user` would through ai_setup_template.save; gives its id. */
async function save(user: TestUser, name: string, org = orgA): Promise<string> {
  const [row] = await as(user)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.ai_setup_templates
            (organization_id, name, kind, answers, from_workspace_id, created_by, updated_by)
          values (${org}, ${name}, 'home_services', ${ANSWERS}::jsonb, ${wsA}, ${user.id}, ${user.id})
          returning id`,
    ),
  );
  return row!.id;
}

const sees = (user: TestUser, id: string) =>
  as(user)((tx) => rows(tx, sql`select id from app.ai_setup_templates where id = ${id}`)).then(
    (r) => r.length,
  );

describe('saved AI setups', () => {
  it('the agency’s owners and admins save them; nobody else does, or for someone else', async () => {
    await save(owner, 'Plumbers');
    await save(orgAdmin, 'Electricians');
    for (const user of [bizOwner, bizAdmin, member])
      expect(await code(() => save(user, `From ${user.email}`))).toBe('42501');
    expect(await code(() => save(owner, 'Salons', orgB))).toBe('42501');
    // Saying someone else saved it.
    expect(
      await code(() =>
        as(owner)((tx) =>
          rows(
            tx,
            sql`insert into app.ai_setup_templates (organization_id, name, kind, answers, created_by, updated_by)
                values (${orgA}, 'Roofers', 'home_services', '{}'::jsonb, ${orgAdmin.id}, ${orgAdmin.id})`,
          ),
        ),
      ),
    ).toBe('42501');
  });

  it('keeps one name once in an agency, whatever its case or the spaces around it', async () => {
    await save(owner, 'Dentists');
    expect(await code(() => save(orgAdmin, '  dentists '))).toBe('23505');
    // Another agency's names are its own.
    await save(outsider, 'Dentists', orgB);
  });

  it('whoever sets up the AI teammate in one of its businesses reads them; members and outsiders don’t', async () => {
    const id = await save(owner, 'Movers');
    for (const user of [owner, orgAdmin, bizOwner, bizAdmin]) expect(await sees(user, id)).toBe(1);
    for (const user of [member, outsider]) expect(await sees(user, id)).toBe(0);
  });

  it('only the agency’s owners and admins rename or remove one, saying who changed it', async () => {
    const id = await save(owner, 'Landscapers');
    const rename = (user: TestUser, name: string, by = user.id) =>
      as(user)((tx) =>
        rows(
          tx,
          sql`update app.ai_setup_templates set name = ${name}, updated_by = ${by} where id = ${id} returning id`,
        ),
      ).then((r) => r.length);
    for (const user of [bizOwner, bizAdmin, member, outsider])
      expect(await rename(user, 'Taken over')).toBe(0);
    expect(await code(() => rename(orgAdmin, 'Lawn care', owner.id))).toBe('42501');
    expect(await rename(orgAdmin, 'Lawn care')).toBe(1);
    const [row] = await as(owner)((tx) =>
      rows<{ name: string; created_by: string; updated_by: string }>(
        tx,
        sql`select name, created_by, updated_by from app.ai_setup_templates where id = ${id}`,
      ),
    );
    expect(row).toEqual({ name: 'Lawn care', created_by: owner.id, updated_by: orgAdmin.id });
    // Which agency it belongs to, and who first saved it, stay as they were.
    expect(
      await code(() =>
        as(owner)((tx) =>
          rows(
            tx,
            sql`update app.ai_setup_templates set organization_id = ${orgB}, updated_by = ${owner.id} where id = ${id}`,
          ),
        ),
      ),
    ).toBe('42501');

    const remove = (user: TestUser) =>
      as(user)((tx) =>
        rows(tx, sql`delete from app.ai_setup_templates where id = ${id} returning id`),
      ).then((r) => r.length);
    for (const user of [bizOwner, bizAdmin, member, outsider]) expect(await remove(user)).toBe(0);
    expect(await remove(orgAdmin)).toBe(1);
    expect(await sees(owner, id)).toBe(0);
  });
});
