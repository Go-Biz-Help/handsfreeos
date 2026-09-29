/**
 * Other mail and Spam (M19, step 2) in the database: who can see and change where a sender's mail goes, and that
 * only the worker deletes old spam.
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
  expectPgError,
  uniq,
  type TestUser,
} from './harness';

let owner: TestUser;
let member: TestUser;
let outsider: TestUser;
let wsA: string;
let orgA: string;

beforeAll(async () => {
  [owner, member, outsider] = await Promise.all([
    createTestUser('folders-owner'),
    createTestUser('folders-member'),
    createTestUser('folders-outsider'),
  ]);
  const a = await bootstrapOrganization(owner, 'Folders Org A', 'Folders A');
  wsA = a.wsId;
  orgA = a.orgId;
  await bootstrapOrganization(outsider, 'Folders Org B', 'Folders B');
  await dbs.admin.db
    .insert(workspaceMemberships)
    .values({ workspaceId: wsA, userId: member.id, role: 'member' });
});
afterAll(closeAll);

describe('sender rules', () => {
  it('are the business’s: anyone on its inbox keeps them, nobody else sees them', async () => {
    const address = `news-${uniq().toLowerCase()}@example.com`;
    await as(member)((tx) =>
      rows(
        tx,
        sql`insert into app.email_sender_rules (workspace_id, address, folder, created_by)
            values (${wsA}, ${address}, 'other', ${member.id})`,
      ),
    );
    const seen = (u: TestUser) =>
      as(u)((tx) =>
        rows<{ folder: string }>(
          tx,
          sql`select folder::text as folder from app.email_sender_rules where workspace_id = ${wsA} and address = ${address}`,
        ),
      );
    expect(await seen(owner)).toEqual([{ folder: 'other' }]);
    expect(await seen(outsider)).toEqual([]);
    // A rule is written as its author, and its address can't be changed into someone else's.
    const forged = await expectPgError(() =>
      as(outsider)((tx) =>
        rows(
          tx,
          sql`insert into app.email_sender_rules (workspace_id, address, folder, created_by)
              values (${wsA}, ${`x-${address}`}, 'spam', ${outsider.id})`,
        ),
      ),
    );
    expect(forged.code).toBe('42501');
    const renamed = await expectPgError(() =>
      as(owner)((tx) =>
        rows(
          tx,
          sql`update app.email_sender_rules set address = 'someone@else.example.com'
              where workspace_id = ${wsA} and address = ${address}`,
        ),
      ),
    );
    expect(renamed.code).toBe('23514');
    const gone = await as(member)((tx) =>
      rows(
        tx,
        sql`delete from app.email_sender_rules where workspace_id = ${wsA} and address = ${address} returning id`,
      ),
    );
    expect(gone).toHaveLength(1);
  });
});

describe('old spam', () => {
  it('is deleted by the worker alone, and only once it is old', async () => {
    const [young, old, inbox] = await Promise.all(
      [
        { folder: 'spam', age: '1 day' },
        { folder: 'spam', age: '31 days' },
        { folder: 'inbox', age: '400 days' },
      ].map(async ({ folder, age }) => {
        const [c] = await rows<{ id: string }>(
          dbs.admin.db,
          sql`insert into app.conversations (workspace_id, channel, counterpart, folder, last_message_at)
              values (${wsA}, 'email', ${`${uniq().toLowerCase()}@spam.example.com`},
                ${folder}::app.conversation_folder, now() - ${age}::interval)
              returning id`,
        );
        return c!.id;
      }),
    );
    const refused = await expectPgError(() =>
      as(owner)((tx) =>
        rows(tx, sql`select * from private.delete_old_spam(now() - interval '30 days', 100)`),
      ),
    );
    expect(refused.code).toBe('42501');
    const deleted = await asService({ workspaceId: wsA, organizationId: orgA })((tx) =>
      rows<{ conversation_id: string }>(
        tx,
        sql`select conversation_id from private.delete_old_spam(now() - interval '30 days', 1000)`,
      ),
    );
    const ids = deleted.map((d) => d.conversation_id);
    expect(ids).toContain(old);
    expect(ids).not.toContain(young);
    expect(ids).not.toContain(inbox);
    const left = await rows<{ id: string }>(
      dbs.admin.db,
      sql`select id from app.conversations where id in (${young}, ${old}, ${inbox})`,
    );
    expect(left.map((l) => l.id).sort()).toEqual([young, inbox].sort());
  });
});
