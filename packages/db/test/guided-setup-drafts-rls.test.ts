/**
 * 0333: a guided setup's answers, kept as they are given. Each setup is for the people who can change that setting
 * (`private.guided_setup_permission`): the phone number's and the email's for whoever manages the business's
 * channels. Nobody else in the business reads or writes them, and nobody in another business sees them at all.
 */
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
  type TestUser,
} from './harness';

let owner: TestUser;
let member: TestUser;
let outsider: TestUser;
let ws: string;
let org: string;
let otherWs: string;

const admin$ = dbs.admin.db;
const draftsSeenBy = (u: TestUser) =>
  as(u)((tx) =>
    rows<{ setup: string }>(
      tx,
      sql`select setup from app.guided_setup_drafts where workspace_id = ${ws} order by setup`,
    ),
  );
const save = (u: TestUser, workspaceId: string, setup: string, answers: object) =>
  as(u)((tx) =>
    rows(
      tx,
      sql`insert into app.guided_setup_drafts (workspace_id, setup, answers, updated_by)
          values (${workspaceId}, ${setup}, ${JSON.stringify(answers)}::jsonb, ${u.id})
          on conflict (workspace_id, setup) do update set answers = excluded.answers`,
    ),
  );

beforeAll(async () => {
  [owner, member, outsider] = await Promise.all([
    createTestUser('gs-owner'),
    createTestUser('gs-member'),
    createTestUser('gs-outsider'),
  ]);
  const a = await bootstrapOrganization(owner, 'Guided Org', 'Guided');
  ws = a.wsId;
  org = a.orgId;
  otherWs = (await bootstrapOrganization(outsider, 'Other Guided Org', 'Other Guided')).wsId;
  await admin$
    .insert(workspaceMemberships)
    .values([{ workspaceId: ws, userId: member.id, role: 'member' }]);
});
afterAll(closeAll);

describe('guided setup answers', () => {
  it('are kept and read by the people who can change that setting', async () => {
    await save(owner, ws, 'phone', { at: 'number' });
    await save(owner, ws, 'phone', { at: 'ring' });
    await save(owner, ws, 'email', { at: 'sender' });
    expect(await draftsSeenBy(owner)).toEqual([{ setup: 'email' }, { setup: 'phone' }]);
    const [kept] = await rows<{ answers: { at: string } }>(
      admin$,
      sql`select answers from app.guided_setup_drafts where workspace_id = ${ws} and setup = 'phone'`,
    );
    expect(kept?.answers).toEqual({ at: 'ring' });
  });

  it('are hidden from a teammate who can’t, and from every other business', async () => {
    expect(await draftsSeenBy(member)).toEqual([]);
    expect(await draftsSeenBy(outsider)).toEqual([]);
    await expect(save(member, ws, 'phone', { at: 'have' })).rejects.toThrow();
    await expect(save(outsider, ws, 'phone', { at: 'have' })).rejects.toThrow();
    // Deleting what they can't see removes nothing.
    await as(member)((tx) =>
      rows(tx, sql`delete from app.guided_setup_drafts where workspace_id = ${ws}`),
    );
    expect(await draftsSeenBy(owner)).toHaveLength(2);
  });

  it('are refused for a setup nobody built, a name that isn’t one, and answers that aren’t a document', async () => {
    // No permission stands for it, so nobody may keep it.
    await expect(save(owner, ws, 'payroll', {})).rejects.toThrow();
    await expect(save(owner, ws, 'Phone!', {})).rejects.toThrow();
    await expect(
      as(owner)((tx) =>
        rows(
          tx,
          sql`insert into app.guided_setup_drafts (workspace_id, setup, answers)
              values (${ws}, 'email', '[1, 2]'::jsonb)
              on conflict (workspace_id, setup) do update set answers = excluded.answers`,
        ),
      ),
    ).rejects.toThrow();
  });

  it('never move to another business, and the worker reads only the business it is working for', async () => {
    await expect(
      rows(
        admin$,
        sql`update app.guided_setup_drafts set workspace_id = ${otherWs} where workspace_id = ${ws}`,
      ),
    ).rejects.toThrow();
    const mine = await asService({ workspaceId: ws, organizationId: org })((tx) =>
      rows<{ setup: string }>(tx, sql`select setup from app.guided_setup_drafts order by setup`),
    );
    expect(mine).toEqual([{ setup: 'email' }, { setup: 'phone' }]);
    const [otherOrg] = await rows<{ organization_id: string }>(
      admin$,
      sql`select organization_id from app.workspaces where id = ${otherWs}`,
    );
    const theirs = await asService({
      workspaceId: otherWs,
      organizationId: otherOrg!.organization_id,
    })((tx) => rows<{ setup: string }>(tx, sql`select setup from app.guided_setup_drafts`));
    expect(theirs).toEqual([]);
  });
});
