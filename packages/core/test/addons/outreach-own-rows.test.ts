/**
 * Social Outreach: each person's own rows stay their own on the database, not only in the operations. A member reads
 * and writes only their own computers, day and feed; owners and admins may read the team's computers and days, for the
 * team's status and counts, but never change them, and never read anyone's feed.
 */
import { randomUUID } from 'node:crypto';
import { asUser, rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outreachBusiness } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const api = () => testDbs().api.db;

let owner: TestUser;
let riley: TestUser;
let dana: TestUser;
let ws: string;

/** What `u` sees of a table's rows in the business, by whose they are. */
const seenBy = async (u: TestUser, table: string): Promise<string[]> =>
  (
    await asUser(api(), u.claims, (tx) =>
      rows<{ user_id: string }>(
        tx,
        sql`select user_id from ${sql.raw(`addon_outreach.${table}`)} where workspace_id = ${ws}`,
      ),
    )
  )
    .map((r) => r.user_id)
    .sort();

/** Runs `query` as `u`: what it changed, or that the database refused it. */
const tried = (u: TestUser, query: ReturnType<typeof sql>) =>
  asUser(api(), u.claims, (tx) => rows<{ id: string }>(tx, query)).then(
    (r) => r.length,
    (e: Error & { cause?: Error }) => {
      const why = `${e.message} ${e.cause?.message ?? ''}`;
      return /row-level security/.test(why) ? 'refused' : why;
    },
  );

const sorted = (...ids: string[]) => [...ids].sort();

beforeAll(async () => {
  owner = await createTestUser('outown-owner', { fullName: 'Morgan Owner' });
  riley = await createTestUser('outown-riley', { fullName: 'Riley Member' });
  dana = await createTestUser('outown-dana', { fullName: 'Dana Reyes' });
  ws = await outreachBusiness(owner, 'Own Rows Co');
  await admin()
    .insert(workspaceMemberships)
    .values([
      { workspaceId: ws, userId: riley.id, role: 'member' },
      { workspaceId: ws, userId: dana.id, role: 'member' },
    ]);
  for (const u of [owner, riley, dana]) {
    const [computer] = await rows<{ id: string }>(
      admin(),
      sql`insert into addon_outreach.computers (workspace_id, user_id, install_id, name, last_seen_at, line)
          values (${ws}, ${u.id}, ${randomUUID()}, 'Chrome on Windows', now(), 'Reading Austin Makers')
          returning id`,
    );
    await rows(
      admin(),
      sql`insert into addon_outreach.days (workspace_id, user_id, day, state, via, changed_at)
          values (${ws}, ${u.id}, current_date, 'started', 'web', now())`,
    );
    await rows(
      admin(),
      sql`insert into addon_outreach.live_steps (workspace_id, user_id, computer_id, at, kind, line)
          values (${ws}, ${u.id}, ${computer!.id}, now(), 'done', 'Sent a friend request to Avery Lane')`,
    );
  }
});

afterAll(async () => {
  await closeTestDbs();
});

describe('computers, days and the feed, on the database', () => {
  it('show a member only their own', async () => {
    for (const table of ['computers', 'days', 'live_steps'])
      expect(await seenBy(riley, table)).toEqual([riley.id]);
  });

  it('show owners and admins the team’s days, never a colleague’s computer or feed', async () => {
    const everyone = sorted(owner.id, riley.id, dana.id);
    expect(await seenBy(owner, 'days')).toEqual(everyone);
    expect(await seenBy(owner, 'computers')).toEqual([owner.id]);
    expect(await seenBy(owner, 'live_steps')).toEqual([owner.id]);
  });

  it('give owners and admins the team’s computers without their lines, and a member only their own', async () => {
    const team = (u: TestUser) =>
      asUser(api(), u.claims, (tx) =>
        rows<Record<string, unknown>>(
          tx,
          sql`select * from private.outreach_team_computers(${ws}::uuid)`,
        ),
      );
    const theirs = await team(owner);
    expect(theirs.map((c) => c.user_id).sort()).toEqual(sorted(owner.id, riley.id, dana.id));
    expect(theirs[0]).toMatchObject({ name: 'Chrome on Windows', state: 'idle' });
    expect(Object.keys(theirs[0]!)).not.toContain('line');
    expect((await team(riley)).map((c) => c.user_id)).toEqual([riley.id]);
  });

  it('let nobody change a colleague’s, owners included', async () => {
    for (const u of [riley, owner]) {
      expect(
        await tried(
          u,
          sql`update addon_outreach.days set state = 'stopped', why = 'person'
              where workspace_id = ${ws} and user_id = ${dana.id} returning id`,
        ),
      ).toBe(0);
      expect(
        await tried(
          u,
          sql`update addon_outreach.computers set line = 'Changed'
              where workspace_id = ${ws} and user_id = ${dana.id} returning id`,
        ),
      ).toBe(0);
    }
    expect(
      await tried(
        riley,
        sql`insert into addon_outreach.live_steps (workspace_id, user_id, at, kind, line)
            values (${ws}, ${dana.id}, now(), 'done', 'Not theirs') returning id`,
      ),
    ).toBe('refused');
    expect(
      await tried(
        riley,
        sql`insert into addon_outreach.computers (workspace_id, user_id, install_id, name, last_seen_at)
            values (${ws}, ${dana.id}, ${randomUUID()}, 'Not theirs', now()) returning id`,
      ),
    ).toBe('refused');
    // Moving one's own row to someone else is refused too.
    expect(
      await tried(
        riley,
        sql`update addon_outreach.days set user_id = ${dana.id}
            where workspace_id = ${ws} and user_id = ${riley.id} returning id`,
      ),
    ).toBe('refused');
  });

  it('still let a person change their own', async () => {
    expect(
      await tried(
        riley,
        sql`update addon_outreach.computers set name = 'Chrome on a Mac'
            where workspace_id = ${ws} and user_id = ${riley.id} returning id`,
      ),
    ).toBe(1);
  });
});
