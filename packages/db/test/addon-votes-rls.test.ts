import { randomBytes, randomInt } from 'node:crypto';
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
  type TestUser,
} from './harness';

/**
 * Voting on what's next (0109): the read and write rules, asked of the database rather than trusted.
 *   1. A vote is a business's, cast and taken back only by those who manage its add-ons; one per add-on.
 *   2. A business sees its own votes; who voted for what is the team's. The counts and Coming soon are anyone's.
 *   3. Nobody writes a count, a pick or a week but the trigger, the worker and the team's own function, and a vote
 *      on an add-on already picked stays where it is.
 */
let owner: TestUser;
let member: TestUser;
let other: TestUser;
let teamAdmin: TestUser;
let teamLead: TestUser;
let ws: string;
let otherWs: string;

const letters = (n: number) =>
  Array.from(randomBytes(n), (b) => String.fromCharCode(97 + (b % 26))).join('');
const fresh = () => `zr${letters(12)}`;
const code = async (fn: () => Promise<unknown>) => (await expectPgError(fn)).code;
/** A week of its own: a random moment after 2100, never one another run closed. */
const weekEnd = () => new Date(Date.UTC(2100, 0, 1) + randomInt(2 ** 47)).toISOString();

beforeAll(async () => {
  [owner, member, other, teamAdmin, teamLead] = await Promise.all([
    createTestUser('votes-rls-owner'),
    createTestUser('votes-rls-member'),
    createTestUser('votes-rls-other'),
    createTestUser('votes-rls-team-admin'),
    createTestUser('votes-rls-team-lead'),
  ]);
  ws = (await bootstrapOrganization(owner, 'Votes RLS HVAC', 'Votes RLS HVAC')).wsId;
  otherWs = (await bootstrapOrganization(other, 'Votes RLS Roofing', 'Votes RLS Roofing')).wsId;
  await dbs.admin.db.execute(
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${ws}, ${member.id}, 'member')`,
  );
  await dbs.admin.db.execute(
    sql`insert into platform.staff (user_id, role, display_name) values
          (${teamAdmin.id}, 'admin', 'Chris'), (${teamLead.id}, 'lead', 'Lee')
        on conflict (user_id) do update set role = excluded.role, status = 'active'`,
  );
});
afterAll(closeAll);

const castAs = (u: TestUser, addonId: string, workspaceId: string) =>
  as(u)((tx) =>
    rows(
      tx,
      sql`insert into platform.addon_votes (addon_id, workspace_id, voted_by) values (${addonId}, ${workspaceId}, ${u.id})`,
    ),
  );
const countOf = async (addonId: string) =>
  Number(
    (
      await rows<{ votes: number }>(
        dbs.admin.db,
        sql`select votes from platform.addon_vote_counts where addon_id = ${addonId}`,
      )
    )[0]?.votes ?? 0,
  );

describe('casting a vote', () => {
  it('is for those who manage the business’s add-ons, in their own name, once per add-on', async () => {
    const id = fresh();
    await castAs(owner, id, ws);
    expect(await countOf(id)).toBe(1);
    expect(await code(() => castAs(owner, id, ws))).toBe('23505');
    expect(await code(() => castAs(member, fresh(), ws))).toBe('42501');
    expect(await code(() => castAs(owner, fresh(), otherWs))).toBe('42501');
    // Not in somebody else's name.
    const forged = as(owner)((tx) =>
      rows(
        tx,
        sql`insert into platform.addon_votes (addon_id, workspace_id, voted_by) values (${fresh()}, ${ws}, ${member.id})`,
      ),
    );
    expect(await code(() => forged)).toBe('42501');
  });

  it('is taken back only by those who could cast it, and the count follows', async () => {
    const id = fresh();
    await castAs(owner, id, ws);
    await as(member)((tx) =>
      rows(
        tx,
        sql`delete from platform.addon_votes where addon_id = ${id} and workspace_id = ${ws}`,
      ),
    );
    expect(await countOf(id)).toBe(1);
    await as(owner)((tx) =>
      rows(
        tx,
        sql`delete from platform.addon_votes where addon_id = ${id} and workspace_id = ${ws}`,
      ),
    );
    expect(await countOf(id)).toBe(0);
  });

  it('stays where it is once the add-on is picked, and no more come', async () => {
    const id = fresh();
    await castAs(owner, id, ws);
    await asService({})((tx) =>
      rows(tx, sql`insert into platform.addon_picks (addon_id, how) values (${id}, 'votes')`),
    );
    await as(owner)((tx) =>
      rows(
        tx,
        sql`delete from platform.addon_votes where addon_id = ${id} and workspace_id = ${ws}`,
      ),
    );
    expect(await countOf(id)).toBe(1);
    expect(await code(() => castAs(other, id, otherWs))).toBe('42501');
  });
});

describe('reading', () => {
  it('shows a business its own votes, the team everyone’s, and the counts and picks to anyone', async () => {
    const id = fresh();
    await castAs(owner, id, ws);
    const seenBy = (u: TestUser) =>
      as(u)((tx) =>
        rows(tx, sql`select workspace_id from platform.addon_votes where addon_id = ${id}`),
      );
    expect(await seenBy(member)).toHaveLength(1);
    expect(await seenBy(other)).toHaveLength(0);
    expect(await seenBy(teamAdmin)).toHaveLength(1);
    const count = await as(other)((tx) =>
      rows<{ votes: number }>(
        tx,
        sql`select votes from platform.addon_vote_counts where addon_id = ${id}`,
      ),
    );
    expect(count[0]?.votes).toBe(1);
    const picks = await as(other)((tx) =>
      rows(tx, sql`select addon_id from platform.addon_picks where addon_id = 'realestate'`),
    );
    expect(picks).toHaveLength(1);
  });

  it('keeps how the weeks closed to the team who choose', async () => {
    const endsAt = weekEnd();
    await asService({})((tx) =>
      rows(tx, sql`select private.close_addon_vote_week(${endsAt}::timestamptz, '{}'::text[])`),
    );
    const read = (u: TestUser) =>
      as(u)((tx) =>
        rows(tx, sql`select id from platform.addon_vote_weeks where ends_at = ${endsAt}`),
      );
    expect(await read(owner)).toHaveLength(0);
    expect(await read(teamLead)).toHaveLength(0);
    expect(await read(teamAdmin)).toHaveLength(1);
  });
});

describe('writing what only the database and the team write', () => {
  it('refuses a person a count, a pick, a week or a delivery', async () => {
    const id = fresh();
    expect(
      await code(() =>
        as(owner)((tx) =>
          rows(
            tx,
            sql`insert into platform.addon_vote_counts (addon_id, votes) values (${id}, 99)`,
          ),
        ),
      ),
    ).toBe('42501');
    expect(
      await code(() =>
        as(teamAdmin)((tx) =>
          rows(tx, sql`insert into platform.addon_picks (addon_id, how) values (${id}, 'team')`),
        ),
      ),
    ).toBe('42501');
    expect(
      await code(() =>
        as(owner)((tx) => rows(tx, sql`select private.close_addon_vote_week(now(), '{}'::text[])`)),
      ),
    ).toBe('42501');
    expect(
      await code(() =>
        as(owner)((tx) =>
          rows(tx, sql`select * from private.addon_voters_to_tell('realestate', 'picked')`),
        ),
      ),
    ).toBe('42501');
  });

  it('lets only the team choose a week’s pick', async () => {
    const endsAt = weekEnd();
    const [week] = await asService({})((tx) =>
      rows<{ id: string }>(
        tx,
        sql`select id from private.close_addon_vote_week(${endsAt}::timestamptz, '{}'::text[])`,
      ),
    );
    const id = fresh();
    const choose = (u: TestUser) =>
      as(u)((tx) => rows(tx, sql`select private.choose_addon_pick(${week!.id}::uuid, ${id})`));
    expect(await code(() => choose(owner))).toBe('42501');
    expect(await code(() => choose(teamLead))).toBe('42501');
    await choose(teamAdmin);
    const [pick] = await rows<{ how: string; picked_by: string }>(
      dbs.admin.db,
      sql`select how, picked_by from platform.addon_picks where addon_id = ${id}`,
    );
    expect(pick).toEqual({ how: 'team', picked_by: teamAdmin.id });
  });

  it('keeps each person’s note on Home their own', async () => {
    await as(owner)((tx) =>
      rows(
        tx,
        sql`insert into platform.addon_news_seen (user_id, addon_id, kind) values (${owner.id}, 'realestate', 'picked')
            on conflict do nothing`,
      ),
    );
    expect(
      await code(() =>
        as(owner)((tx) =>
          rows(
            tx,
            sql`insert into platform.addon_news_seen (user_id, addon_id, kind) values (${member.id}, 'realestate', 'picked')`,
          ),
        ),
      ),
    ).toBe('42501');
    const seen = await as(member)((tx) =>
      rows(tx, sql`select user_id from platform.addon_news_seen where user_id = ${owner.id}`),
    );
    expect(seen).toHaveLength(0);
  });
});
