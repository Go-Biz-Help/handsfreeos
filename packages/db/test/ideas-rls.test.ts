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
 * Ideas, the roadmap and What's new (0100): the read and write rules, asked of the database rather than trusted.
 *   1. The board is for people who work in a business here (and the team), and for nobody else.
 *   2. Another business sees an idea and a short name, never what anybody voted for.
 *   3. The counts, the stamps and the roadmap are not a person's to write: an author fixes their words, the team
 *      tidies and takes down, and only a lead or an admin moves an idea along.
 */
let dale: TestUser;
let renee: TestUser;
let stranger: TestUser;
let agent: TestUser;
let lead: TestUser;
let daleWs: string;
let reneeWs: string;

const code = async (fn: () => Promise<unknown>) => (await expectPgError(fn)).code;
const detail = async (fn: () => Promise<unknown>) => (await expectPgError(fn)).detail;

beforeAll(async () => {
  [dale, renee, stranger, agent, lead] = await Promise.all([
    createTestUser('ideas-rls-dale', { fullName: 'Dale Ramsey' }),
    createTestUser('ideas-rls-renee', { fullName: 'Renee Broussard' }),
    createTestUser('ideas-rls-stranger'),
    createTestUser('ideas-rls-agent', { fullName: 'Al Agent' }),
    createTestUser('ideas-rls-lead', { fullName: 'Samantha Lead' }),
  ]);
  daleWs = (await bootstrapOrganization(dale, 'Ideas RLS HVAC', 'Ideas RLS HVAC')).wsId;
  reneeWs = (await bootstrapOrganization(renee, 'Ideas RLS Plumbing', 'Ideas RLS Plumbing')).wsId;
  await dbs.admin.db.execute(
    sql`insert into platform.staff (user_id, role, display_name) values
          (${agent.id}, 'agent', ''), (${lead.id}, 'lead', 'Sam')
        on conflict (user_id) do update set role = excluded.role, status = 'active',
          display_name = excluded.display_name`,
  );
});
afterAll(closeAll);

/** An idea shared the way the command shares one: column by column, in the author's own name. */
async function share(u: TestUser, ws: string | null, title = `An idea ${Math.random()}`) {
  const [row] = await as(u)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into platform.ideas (title, body, area_id, author_user_id, workspace_id)
          values (${title}, 'Details', 'money', ${u.id}, ${ws}) returning id`,
    ),
  );
  return row!.id;
}

/**
 * An idea put on the board for a test about something else. Straight in, so no one person here shares more than
 * the ten a day everybody gets (the author's vote and follow still come from the database's own triggers).
 */
async function onBoard(u: TestUser, ws: string | null, title = `An idea ${Math.random()}`) {
  const [row] = await rows<{ id: string }>(
    dbs.admin.db,
    sql`insert into platform.ideas (title, body, area_id, author_user_id, workspace_id)
        values (${title}, 'Details', 'money', ${u.id}, ${ws}) returning id`,
  );
  return row!.id;
}

const ideaRow = async (id: string) =>
  (
    await rows<{
      status: string;
      vote_count: number;
      comment_count: number;
      hidden_by: string | null;
      merged_into: string | null;
      title: string;
    }>(
      dbs.admin.db,
      sql`select status::text as status, vote_count, comment_count, hidden_by, merged_into, title
          from platform.ideas where id = ${id}`,
    )
  )[0]!;

describe('who takes part', () => {
  it('somebody in no business sees nothing and shares nothing', async () => {
    await share(dale, daleWs);
    const seen = await as(stranger)((tx) => rows(tx, sql`select id from platform.ideas`));
    expect(seen).toEqual([]);
    expect(await as(stranger)((tx) => rows(tx, sql`select id from platform.idea_areas`))).toEqual(
      [],
    );
    expect(await code(() => share(stranger, null))).toBe('42501');
  });

  it('a person shares in their own name, from a business they really work in', async () => {
    expect(
      await code(() =>
        as(renee)((tx) =>
          rows(
            tx,
            sql`insert into platform.ideas (title, author_user_id) values ('Not mine to sign', ${dale.id})`,
          ),
        ),
      ),
    ).toBe('42501');
    expect(await code(() => share(renee, daleWs))).toBe('42501');
  });

  it('sharing votes for it and follows it, and the count is the database’s', async () => {
    const id = await share(dale, daleWs);
    expect((await ideaRow(id)).vote_count).toBe(1);
    const [follow] = await rows<{ following: boolean }>(
      dbs.admin.db,
      sql`select following from platform.idea_followers where idea_id = ${id} and user_id = ${dale.id}`,
    );
    expect(follow?.following).toBe(true);
  });
});

describe('what is nobody’s to write', () => {
  it('the counts, the status and who wrote it are out of a person’s reach', async () => {
    const id = await onBoard(dale, daleWs);
    expect(
      await code(() =>
        as(dale)((tx) =>
          rows(tx, sql`update platform.ideas set vote_count = 999 where id = ${id}`),
        ),
      ),
    ).toBe('42501');
    expect(
      await detail(() =>
        as(dale)((tx) =>
          rows(tx, sql`update platform.ideas set status = 'planned' where id = ${id}`),
        ),
      ),
    ).toBe('idea_roadmap_is_ours');
    expect(
      await code(() =>
        as(dale)((tx) =>
          rows(
            tx,
            sql`insert into platform.ideas (title, author_user_id, status) values ('Skip the queue', ${dale.id}, 'planned')`,
          ),
        ),
      ),
    ).toBe('42501');
    expect(
      await detail(() =>
        as(dale)((tx) =>
          rows(tx, sql`update platform.ideas set hidden_at = now() where id = ${id}`),
        ),
      ),
    ).toBe('idea_protected');
  });

  it('its author fixes the words while it is under review, and not after', async () => {
    const id = await onBoard(dale, daleWs, 'Tipping on invoces');
    await as(dale)((tx) =>
      rows(tx, sql`update platform.ideas set title = 'Tipping on invoices' where id = ${id}`),
    );
    expect((await ideaRow(id)).title).toBe('Tipping on invoices');
    const notTheirs = await as(renee)((tx) =>
      rows(tx, sql`update platform.ideas set title = 'Hijacked' where id = ${id} returning id`),
    );
    expect(notTheirs).toEqual([]);
    await as(lead)((tx) =>
      rows(tx, sql`update platform.ideas set status = 'planned' where id = ${id}`),
    );
    const late = await as(dale)((tx) =>
      rows(
        tx,
        sql`update platform.ideas set title = 'Changed later' where id = ${id} returning id`,
      ),
    );
    expect(late).toEqual([]);
    expect((await ideaRow(id)).title).toBe('Tipping on invoices');
  });
});

describe('votes', () => {
  it('what you voted for is yours to know; who voted is the team’s', async () => {
    const id = await onBoard(dale, daleWs);
    await as(renee)((tx) =>
      rows(
        tx,
        sql`insert into platform.idea_votes (idea_id, user_id, workspace_id) values (${id}, ${renee.id}, ${reneeWs})`,
      ),
    );
    expect((await ideaRow(id)).vote_count).toBe(2);
    const daleSees = await as(dale)((tx) =>
      rows<{ user_id: string }>(
        tx,
        sql`select user_id from platform.idea_votes where idea_id = ${id}`,
      ),
    );
    expect(daleSees.map((v) => v.user_id)).toEqual([dale.id]);
    const teamSees = await as(agent)((tx) =>
      rows<{ user_id: string }>(
        tx,
        sql`select user_id from platform.idea_votes where idea_id = ${id}`,
      ),
    );
    expect(teamSees.map((v) => v.user_id).sort()).toEqual([dale.id, renee.id].sort());
    // Nobody votes in somebody else's name, or from a business they are not in.
    expect(
      await code(() =>
        as(renee)((tx) =>
          rows(
            tx,
            sql`insert into platform.idea_votes (idea_id, user_id) values (${id}, ${dale.id})`,
          ),
        ),
      ),
    ).toBe('42501');
    const other = await onBoard(renee, reneeWs);
    expect(
      await code(() =>
        as(dale)((tx) =>
          rows(
            tx,
            sql`insert into platform.idea_votes (idea_id, user_id, workspace_id) values (${other}, ${dale.id}, ${reneeWs})`,
          ),
        ),
      ),
    ).toBe('42501');
  });

  it('voting closes when an idea is done, and taking a vote back takes it off the count', async () => {
    const id = await onBoard(dale, daleWs);
    await as(lead)((tx) =>
      rows(tx, sql`update platform.ideas set status = 'done' where id = ${id}`),
    );
    expect(
      await code(() =>
        as(renee)((tx) =>
          rows(
            tx,
            sql`insert into platform.idea_votes (idea_id, user_id) values (${id}, ${renee.id})`,
          ),
        ),
      ),
    ).toBe('42501');
    await as(dale)((tx) =>
      rows(tx, sql`delete from platform.idea_votes where idea_id = ${id} and user_id = ${dale.id}`),
    );
    expect((await ideaRow(id)).vote_count).toBe(0);
  });
});

describe('comments', () => {
  it('whether a comment is the team’s is the database’s to say', async () => {
    const id = await onBoard(dale, daleWs);
    expect(
      await code(() =>
        as(renee)((tx) =>
          rows(
            tx,
            sql`insert into platform.idea_comments (idea_id, author_user_id, body, from_team)
                values (${id}, ${renee.id}, 'Official, honest', true)`,
          ),
        ),
      ),
    ).toBe('42501');
    const [mine] = await as(renee)((tx) =>
      rows<{ from_team: boolean }>(
        tx,
        sql`insert into platform.idea_comments (idea_id, author_user_id, body)
            values (${id}, ${renee.id}, 'Me too') returning from_team`,
      ),
    );
    expect(mine?.from_team).toBe(false);
    const [theirs] = await as(agent)((tx) =>
      rows<{ from_team: boolean }>(
        tx,
        sql`insert into platform.idea_comments (idea_id, author_user_id, body)
            values (${id}, ${agent.id}, 'Looking at it') returning from_team`,
      ),
    );
    expect(theirs?.from_team).toBe(true);
    expect((await ideaRow(id)).comment_count).toBe(2);
  });

  it('a comment is taken down, never rewritten; its author takes down their own and nobody else’s', async () => {
    const id = await onBoard(dale, daleWs);
    const [c] = await as(renee)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into platform.idea_comments (idea_id, author_user_id, body)
            values (${id}, ${renee.id}, 'First words') returning id`,
      ),
    );
    expect(
      await code(() =>
        as(renee)((tx) =>
          rows(tx, sql`update platform.idea_comments set body = 'Other words' where id = ${c!.id}`),
        ),
      ),
    ).toBe('42501');
    const byDale = await as(dale)((tx) =>
      rows(
        tx,
        sql`update platform.idea_comments set hidden_at = now() where id = ${c!.id} returning id`,
      ),
    );
    expect(byDale).toEqual([]);
    await as(renee)((tx) =>
      rows(tx, sql`update platform.idea_comments set hidden_at = now() where id = ${c!.id}`),
    );
    expect((await ideaRow(id)).comment_count).toBe(0);
    expect(
      await detail(() =>
        as(renee)((tx) =>
          rows(tx, sql`update platform.idea_comments set hidden_at = null where id = ${c!.id}`),
        ),
      ),
    ).toBe('idea_comment_protected');
    const shown = await as(dale)((tx) =>
      rows(tx, sql`select id from platform.idea_comments where idea_id = ${id}`),
    );
    expect(shown).toEqual([]);
  });
});

describe('the team', () => {
  it('an agent tidies and takes down, but only a lead moves the roadmap', async () => {
    const id = await onBoard(dale, daleWs);
    expect(
      await detail(() =>
        as(agent)((tx) =>
          rows(tx, sql`update platform.ideas set status = 'planned' where id = ${id}`),
        ),
      ),
    ).toBe('idea_roadmap_is_ours');
    await as(agent)((tx) =>
      rows(tx, sql`update platform.ideas set hidden_at = '2001-01-01' where id = ${id}`),
    );
    // The stamp is the database's clock, in the name of whoever did it.
    expect((await ideaRow(id)).hidden_by).toBe(agent.id);
    const [hidden] = await rows<{ recent: boolean }>(
      dbs.admin.db,
      sql`select hidden_at > now() - interval '1 minute' as recent from platform.ideas where id = ${id}`,
    );
    expect(hidden?.recent).toBe(true);
    // Taken down: gone for other businesses, still there for its author and the team.
    expect(
      await as(renee)((tx) => rows(tx, sql`select id from platform.ideas where id = ${id}`)),
    ).toEqual([]);
    expect(
      await as(dale)((tx) => rows(tx, sql`select id from platform.ideas where id = ${id}`)),
    ).toHaveLength(1);
    await as(lead)((tx) =>
      rows(tx, sql`update platform.ideas set status = 'planned' where id = ${id}`),
    );
    expect((await ideaRow(id)).status).toBe('planned');
  });

  it('merging is the team’s, and a follower who said stop stays stopped', async () => {
    const into = await onBoard(dale, daleWs);
    const dup = await onBoard(renee, reneeWs);
    await as(dale)((tx) =>
      rows(
        tx,
        sql`insert into platform.idea_followers (idea_id, user_id, following) values (${dup}, ${dale.id}, true)`,
      ),
    );
    await as(renee)((tx) =>
      rows(
        tx,
        sql`insert into platform.idea_followers (idea_id, user_id, following) values (${into}, ${renee.id}, false)`,
      ),
    );
    expect(
      await code(() =>
        as(dale)((tx) => rows(tx, sql`select * from private.merge_idea(${dup}, ${into})`)),
      ),
    ).toBe('42501');
    // Only the merge itself points a duplicate somewhere, so its votes and followers never stay behind.
    expect(
      await code(() =>
        as(agent)((tx) =>
          rows(tx, sql`update platform.ideas set merged_into = ${into} where id = ${dup}`),
        ),
      ),
    ).toBe('42501');
    const [moved] = await as(agent)((tx) =>
      rows<{ moved_votes: number; moved_followers: number }>(
        tx,
        sql`select * from private.merge_idea(${dup}, ${into})`,
      ),
    );
    expect(moved).toEqual({ moved_votes: 1, moved_followers: 0 });
    expect((await ideaRow(dup)).merged_into).toBe(into);
    expect((await ideaRow(into)).vote_count).toBe(2);
    const [still] = await rows<{ following: boolean }>(
      dbs.admin.db,
      sql`select following from platform.idea_followers where idea_id = ${into} and user_id = ${renee.id}`,
    );
    expect(still?.following).toBe(false);
    expect(
      await detail(() =>
        as(agent)((tx) => rows(tx, sql`select * from private.merge_idea(${into}, ${dup})`)),
      ),
    ).toBe('idea_merge_target_gone');
  });

  it('writes What’s new, which people read only once it is published', async () => {
    const [entry] = await as(lead)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into platform.whats_new (title, body, kind) values ('A draft for now', 'Soon', 'new') returning id`,
      ),
    );
    expect(
      await as(dale)((tx) =>
        rows(tx, sql`select id from platform.whats_new where id = ${entry!.id}`),
      ),
    ).toEqual([]);
    expect(
      await as(agent)((tx) =>
        rows(tx, sql`select id from platform.whats_new where id = ${entry!.id}`),
      ),
    ).toEqual([]);
    expect(
      await code(() =>
        as(dale)((tx) =>
          rows(tx, sql`insert into platform.whats_new (title) values ('Mine to announce')`),
        ),
      ),
    ).toBe('42501');
    await as(lead)((tx) =>
      rows(tx, sql`update platform.whats_new set published_at = now() where id = ${entry!.id}`),
    );
    expect(
      await as(dale)((tx) =>
        rows(tx, sql`select id from platform.whats_new where id = ${entry!.id}`),
      ),
    ).toHaveLength(1);
  });
});

describe('names and the worker’s own', () => {
  it('names only people who wrote something, only to people who take part', async () => {
    const id = await onBoard(dale, daleWs);
    await as(renee)((tx) =>
      rows(tx, sql`insert into platform.idea_votes (idea_id, user_id) values (${id}, ${renee.id})`),
    );
    const names = await as(renee)((tx) =>
      rows<{ user_id: string; name: string }>(
        tx,
        sql`select * from private.idea_people(array[${dale.id}::uuid, ${agent.id}::uuid, ${stranger.id}::uuid])`,
      ),
    );
    expect(names).toContainEqual({ user_id: dale.id, name: 'Dale R.' });
    expect(names.map((n) => n.user_id)).not.toContain(stranger.id);
    expect(
      await as(stranger)((tx) =>
        rows(tx, sql`select * from private.idea_people(array[${dale.id}::uuid])`),
      ),
    ).toEqual([]);
  });

  it('who has been told, and who to tell, are the worker’s alone', async () => {
    expect(
      await code(() =>
        as(lead)((tx) => rows(tx, sql`select * from platform.idea_update_deliveries`)),
      ),
    ).toBe('42501');
    expect(
      await code(() =>
        as(lead)((tx) =>
          rows(tx, sql`select * from private.idea_followers_to_tell(gen_random_uuid())`),
        ),
      ),
    ).toBe('42501');
    const none = await asService({})((tx) =>
      rows(tx, sql`select * from private.idea_followers_to_tell(gen_random_uuid())`),
    );
    expect(none).toEqual([]);
  });
});
