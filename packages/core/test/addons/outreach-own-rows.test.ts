/**
 * Social Outreach: each person's own rows stay their own on the database, not only in the operations. A member reads
 * and writes only their own computers, day, feed, needs, pushes and asks. Owners and admins may read the team's days,
 * which hold no words, and see the team's computers and how many needs and asks wait only through private functions
 * that give status and counts, never a line, a need or a drafted message. Nobody changes a colleague's.
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
let profileId: string;

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
  const [profile] = await rows<{ id: string }>(
    admin(),
    sql`insert into addon_outreach.profiles (workspace_id, platform, url, name, username)
        values (${ws}, 'facebook', 'https://www.facebook.com/avery.lane', 'Avery Lane', 'avery.lane')
        returning id`,
  );
  profileId = profile!.id;
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
    await rows(
      admin(),
      sql`insert into addon_outreach.needs (workspace_id, user_id, step, profile_id, name, why, seen_at)
          values (${ws}, ${u.id}, 'confirm', ${profileId}, 'Avery Lane', 'The Confirm button wasn’t there.', now())`,
    );
    await rows(
      admin(),
      sql`insert into addon_outreach.list_saves (workspace_id, user_id, friends_at)
          values (${ws}, ${u.id}, now())`,
    );
    await rows(
      admin(),
      sql`insert into addon_outreach.waiting_pushes (workspace_id, user_id, pushed_at)
          values (${ws}, ${u.id}, now())`,
    );
    await rows(
      admin(),
      sql`insert into addon_outreach.asks (workspace_id, user_id, kind, via, asked_at, task)
          values (${ws}, ${u.id}, 'unfriend', 'web', now(), '{"names": ["Avery Lane"]}')`,
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

  it('keep when each person’s own lists were saved their own, even from owners', async () => {
    expect(await seenBy(riley, 'list_saves')).toEqual([riley.id]);
    expect(await seenBy(owner, 'list_saves')).toEqual([owner.id]);
    expect(
      await tried(
        riley,
        sql`update addon_outreach.list_saves set sent_at = now()
            where workspace_id = ${ws} and user_id = ${dana.id} returning id`,
      ),
    ).toBe(0);
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

describe('needs and pushes, on the database', () => {
  it('show a member only their own', async () => {
    for (const table of ['needs', 'waiting_pushes'])
      expect(await seenBy(riley, table)).toEqual([riley.id]);
  });

  it('show owners and admins no colleague’s needs or pushes, and count the team’s needs on the database', async () => {
    expect(await seenBy(owner, 'needs')).toEqual([owner.id]);
    expect(await seenBy(owner, 'waiting_pushes')).toEqual([owner.id]);
    const counted = (u: TestUser, users: TestUser[]) =>
      asUser(api(), u.claims, (tx) =>
        rows<{ user_id: string; n: number }>(
          tx,
          sql`select user_id, n from private.outreach_needs_waiting(${ws}::uuid,
                ${`{${users.map((x) => x.id).join(',')}}`}::uuid[], now() - interval '7 days')
              order by user_id`,
        ),
      );
    const everyone = [owner, riley, dana];
    expect(await counted(owner, everyone)).toEqual(
      sorted(owner.id, riley.id, dana.id).map((user_id) => ({ user_id, n: 1 })),
    );
    // A member counts their own, never a colleague's.
    expect(await counted(riley, [riley])).toEqual([{ user_id: riley.id, n: 1 }]);
    expect(await counted(riley, everyone)).toEqual([]);
  });

  it('let nobody change a colleague’s, owners included', async () => {
    for (const u of [riley, owner])
      expect(
        await tried(
          u,
          sql`update addon_outreach.needs set state = 'dismissed', cleared_at = now()
              where workspace_id = ${ws} and user_id = ${dana.id} returning id`,
        ),
      ).toBe(0);
    expect(
      await tried(
        riley,
        sql`insert into addon_outreach.needs (workspace_id, user_id, step, profile_id, name, why, seen_at)
            values (${ws}, ${dana.id}, 'friend_request', ${profileId}, 'Avery Lane', 'Not theirs', now())
            returning id`,
      ),
    ).toBe('refused');
    expect(
      await tried(
        riley,
        sql`update addon_outreach.waiting_pushes set pushed_at = now()
            where workspace_id = ${ws} and user_id = ${dana.id} returning id`,
      ),
    ).toBe(0);
  });
});

describe('asks, on the database', () => {
  it('show each person only their own, owners and admins included, and count the team’s on the database', async () => {
    // Riley's look-up, stuck at their computer, with the AI's drafts for Avery Lane.
    await rows(
      admin(),
      sql`insert into addon_outreach.asks
            (workspace_id, user_id, kind, via, state, asked_at, started_at, computer_id, line, result)
          select ${ws}, ${riley.id}, 'lookup', 'web', 'stuck', now(), now(), c.id, 'Looking up Avery Lane',
            '{"drafts": ["Hi Avery! Saw your post in Austin Makers."]}'
          from addon_outreach.computers c where c.workspace_id = ${ws} and c.user_id = ${riley.id}`,
    );
    expect(await seenBy(riley, 'asks')).toEqual([riley.id, riley.id]);
    expect(await seenBy(owner, 'asks')).toEqual([owner.id]);
    // Not even named: the owner can't read Riley's drafted messages.
    expect(
      await asUser(api(), owner.claims, (tx) =>
        rows(
          tx,
          sql`select result, task, line from addon_outreach.asks
              where workspace_id = ${ws} and user_id = ${riley.id}`,
        ),
      ),
    ).toEqual([]);
    const counted = (u: TestUser, users: TestUser[]) =>
      asUser(api(), u.claims, (tx) =>
        rows<{ user_id: string; n: number }>(
          tx,
          sql`select user_id, n from private.outreach_asks_waiting(${ws}::uuid,
                ${`{${users.map((x) => x.id).join(',')}}`}::uuid[], '{stuck,typing}'::text[],
                now() - interval '3 minutes', now() - interval '6 hours')`,
        ),
      );
    expect(await counted(owner, [owner, riley, dana])).toEqual([{ user_id: riley.id, n: 1 }]);
    expect(await counted(riley, [riley])).toEqual([{ user_id: riley.id, n: 1 }]);
    expect(await counted(dana, [riley])).toEqual([]);
  });

  it('let nobody ask for a colleague, or change a colleague’s, owners included', async () => {
    for (const u of [riley, owner]) {
      expect(
        await tried(
          u,
          sql`insert into addon_outreach.asks (workspace_id, user_id, kind, via, asked_at)
              values (${ws}, ${dana.id}, 'unfriend', 'web', now()) returning id`,
        ),
      ).toBe('refused');
      expect(
        await tried(
          u,
          sql`update addon_outreach.asks set state = 'cancelled', ended_at = now()
              where workspace_id = ${ws} and user_id = ${dana.id} returning id`,
        ),
      ).toBe(0);
    }
  });
});
