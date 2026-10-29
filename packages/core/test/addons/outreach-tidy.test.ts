/**
 * Social Outreach: tidying the person's own friends, and Facebook's warnings (docs/outreach.md, decisions 10, 12, 17
 * and 25). Sent requests nobody answered in the business's wait, and friends with no contact in six months who aren't
 * in Contacts, a prospect, kept or on Don't pitch, are listed for the person to tick; each the extension cancels or
 * unfriends is noted and counted against today's limit. A warning halves the limits for a week and keeps friend
 * requests off Today's list for two days.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DAILY_LIMITS, DECLINES_PER_DAY, TIDY_LIMITS } from '../../src/addons/outreach/limits';
import { warningNote } from '../../src/addons/outreach/tidy';
import { outreachBusiness, runAs } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();
const fb = (username: string) => ({
  id: null,
  username,
  url: `https://www.facebook.com/${username}`,
});
const person = (username: string, name: string) => ({
  profile: fb(username),
  name,
  mutualFriends: null,
});

describe('tidying friends', () => {
  let owner: TestUser;
  let ws: string;
  const tidy = () => runAs(owner, ws, 'outreach.friends.tidy', {});
  const names = (list: { name: string }[]) => list.map((c) => c.name);
  /** Moves where the owner's Facebook stands with someone back to `days` ago. */
  const since = (username: string, days: number) =>
    rows(
      admin(),
      sql`update addon_outreach.friends f set since = ${daysAgo(days)}::timestamptz
          from addon_outreach.profiles p
          where p.id = f.profile_id and p.workspace_id = ${ws} and p.username = ${username}`,
    );
  const profileId = async (username: string) => {
    const [p] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_outreach.profiles where workspace_id = ${ws} and username = ${username}`,
    );
    return p!.id;
  };

  beforeAll(async () => {
    owner = await createTestUser('outtidy-owner', { fullName: 'Pat Owner' });
    ws = await outreachBusiness(owner, 'Outreach Tidy Co');
    await runAs(owner, ws, 'outreach.friends.save', {
      list: 'sent',
      people: [person('dana.reyes.12', 'Dana Reyes'), person('casey.m', 'Casey Moreno')],
    });
    await runAs(owner, ws, 'outreach.friends.save', {
      list: 'friends',
      people: [
        person('old.pal.1', 'Jordan Quiet'),
        person('old.pal.2', 'Riley Talks'),
        person('old.pal.3', 'Morgan Kept'),
        person('old.pal.4', 'Quinn Family'),
        person('old.pal.5', 'Drew Prospect'),
        person('new.pal', 'Sky New'),
      ],
    });
    await since('dana.reyes.12', 30);
    await since('casey.m', 10);
    for (const u of ['old.pal.1', 'old.pal.2', 'old.pal.3', 'old.pal.4', 'old.pal.5'])
      await since(u, 2000);
    await since('new.pal', 60);
  }, 60_000);
  afterAll(closeTestDbs);

  it('lists sent requests older than the business’s wait, the oldest first', async () => {
    const out = await tidy();
    expect(out.cancelAfterWeeks).toBe(3);
    expect(names(out.cancel)).toEqual(['Dana Reyes']);
    expect(out.cancel[0]).toEqual(
      expect.objectContaining({ username: 'dana.reyes.12', platformId: null, lastContact: null }),
    );
    // A business that waits one week sees both.
    await rows(
      admin(),
      sql`update app.addon_installations set settings = '{"cancelRequestsAfterWeeks": 1}'::jsonb
          where workspace_id = ${ws} and addon_id = 'outreach'`,
    );
    expect(names((await tidy()).cancel)).toEqual(['Dana Reyes', 'Casey Moreno']);
  });

  it('suggests unfriending only once the download file says who they talk to', async () => {
    const before = await tidy();
    expect(before.needsFile).toBe(true);
    expect(before.unfriend).toEqual([]);

    const [made] = await rows<{ id: string }>(
      admin(),
      sql`insert into addon_outreach.imports (workspace_id, user_id, platform, made_at, finished_at, counts)
          values (${ws}, ${owner.id}, 'facebook', now(), now(), '{}'::jsonb) returning id`,
    );
    const chat = (username: string, name: string, lastDays: number, prospect: boolean) =>
      profileId(username).then((id) =>
        rows(
          admin(),
          sql`insert into addon_outreach.file_chats (workspace_id, user_id, platform, name, name_key, first_at,
                last_at, messages, last_from_me, profile_id, import_id, read_state, prospect)
              values (${ws}, ${owner.id}, 'facebook', ${name}, ${name.toLowerCase()}, ${daysAgo(3000)}::timestamptz,
                ${daysAgo(lastDays)}::timestamptz, 12, true, ${id}, ${made!.id}, 'read', ${prospect})`,
        ),
      );
    await chat('old.pal.2', 'Riley Talks', 20, false);
    await chat('old.pal.5', 'Drew Prospect', 400, true);
    await runAs(owner, ws, 'outreach.friend.set', {
      ...byName('old.pal.3', 'Morgan Kept'),
      keep: true,
    });
    await runAs(owner, ws, 'outreach.friend.set', {
      ...byName('old.pal.4', 'Quinn Family'),
      dontPitch: true,
    });

    const out = await tidy();
    expect(out.needsFile).toBe(false);
    // Talked lately, kept, on Don't pitch, a prospect, or friends for less than six months: none of those.
    expect(names(out.unfriend)).toEqual(['Jordan Quiet']);
    expect(out.friends).toBe(6);
    expect(out.limits).toEqual({
      cancel_request: { done: 0, most: TIDY_LIMITS.cancel_request },
      unfriend: { done: 0, most: TIDY_LIMITS.unfriend },
      // The requests they got that it deletes on its own, as they pick (decision 121).
      decline: { done: 0, most: DECLINES_PER_DAY },
    });
  });

  it('notes each one the extension cancels or unfriends, and counts it unless it was done already', async () => {
    const ended = await runAs(owner, ws, 'outreach.friend.end', {
      kind: 'cancel_request',
      ...byName('dana.reyes.12', 'Dana Reyes'),
    });
    expect(ended).toEqual({ profileId: expect.any(String), counted: true, doneToday: 1 });
    const already = await runAs(owner, ws, 'outreach.friend.end', {
      kind: 'cancel_request',
      ...byName('casey.m', 'Casey Moreno'),
      already: true,
    });
    expect(already.counted).toBe(false);
    await runAs(owner, ws, 'outreach.friend.end', {
      kind: 'unfriend',
      ...byName('old.pal.1', 'Jordan Quiet'),
    });

    const out = await tidy();
    expect(out.cancel).toEqual([]);
    expect(out.unfriend).toEqual([]);
    expect(out.limits.cancel_request.done).toBe(1);
    expect(out.limits.unfriend.done).toBe(1);
    expect(out.friends).toBe(5);
    const [state] = await rows<{ state: string; friendship: string }>(
      admin(),
      sql`select f.state, p.friendship from addon_outreach.friends f
          join addon_outreach.profiles p on p.id = f.profile_id
          where p.workspace_id = ${ws} and p.username = 'old.pal.1'`,
    );
    expect(state).toEqual({ state: 'not_friends', friendship: 'not_friends' });
  });

  it('halves the limits for a week after a warning, and keeps friend requests off the list for two days', async () => {
    const words = ['You’re temporarily blocked from sending friend requests'];
    const seen = await runAs(owner, ws, 'outreach.warning.note', {
      words,
      url: 'https://www.facebook.com/friends',
    });
    expect(seen.repeated).toBe(false);
    expect(seen.warning).toEqual(expect.objectContaining({ words: words[0], today: true }));
    expect(new Date(seen.warning.slowerUntil).getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
    expect(warningNote(seen.warning)).toMatch(/^Facebook warned you: “You’re temporarily blocked/);
    expect((await runAs(owner, ws, 'outreach.warning.note', { words })).repeated).toBe(true);

    const out = await tidy();
    expect(out.limits.unfriend.most).toBe(TIDY_LIMITS.unfriend / 2);
    expect(out.warning).toEqual(expect.objectContaining({ words: words[0] }));
    const today = await runAs(owner, ws, 'outreach.today', {});
    expect(today.limits.friend_request.most).toBe(DAILY_LIMITS.friend_request / 2);
    expect(today.items.filter((i: { kind: string }) => i.kind === 'friend_request')).toEqual([]);
    expect(today.warning).not.toBeNull();
    const activity = await runAs(owner, ws, 'outreach.activity', {});
    expect(activity.limits.like).toBe(DAILY_LIMITS.like / 2);
    expect(activity.warning).not.toBeNull();

    // A week on, it's over.
    await rows(
      admin(),
      sql`update addon_outreach.warnings set at = ${daysAgo(8)}::timestamptz where workspace_id = ${ws}`,
    );
    const later = await tidy();
    expect(later.warning).toBeNull();
    expect(later.limits.unfriend.most).toBe(TIDY_LIMITS.unfriend);
  });
});

function byName(username: string, name: string) {
  return { profile: fb(username), name };
}
