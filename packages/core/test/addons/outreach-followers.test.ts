/**
 * The person's own followers on Facebook (docs/outreach.md decision 113, the owner's pick 18a): read once a week, each
 * follower who isn't a friend checked by the AI like a friend, inside the day's checks and after the friends, and the
 * good fits on Today for a friend request ("Follows you on Facebook"). Each person's own.
 */
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FOLLOWER_WHY, FOLLOWERS_SAVE_MOST } from '../../src/addons/outreach/followers';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { checkedAs, outreachBusiness, refused, runAs } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const crm = PLAYBOOK_TEMPLATES.crm_demos.details;

afterAll(closeTestDbs);

describe('your followers on Facebook', () => {
  let owner: TestUser;
  let riley: TestUser;
  let ws: string;
  let playbookId: string;
  const fb = (username: string) => ({
    id: null,
    username,
    url: `https://www.facebook.com/${username}`,
  });
  const follower = (username: string, name: string) => ({ profile: fb(username), name });
  const next = async (u = owner) =>
    (await runAs(u, ws, 'outreach.followers.next', {})) as { due: boolean };
  const save = (people: { profile: object; name: string }[], done = true, u = owner) =>
    runAs(u, ws, 'outreach.followers.save', { people, done }) as Promise<{
      saved: number;
      added: number;
      readAt: string | null;
    }>;
  const idOf = async (username: string) =>
    (
      await rows<{ id: string }>(
        admin(),
        sql`select id from addon_outreach.profiles where workspace_id = ${ws} and username = ${username}`,
      )
    )[0]!.id;
  const checksNext = async (u = owner) =>
    (
      (await runAs(u, ws, 'outreach.checks.next', {})) as {
        people: { name: string; reason: string }[];
      }
    ).people.map((p) => [p.name, p.reason]);
  const today = async (u = owner) =>
    (
      (await runAs(u, ws, 'outreach.today', {})).items as {
        kind: string;
        name: string;
        why: string[];
        playbookName: string | null;
      }[]
    ).filter((i) => i.kind === 'friend_request' || i.kind === 'warm_up');

  beforeAll(async () => {
    owner = await createTestUser('outfo-owner', { fullName: 'Pat Owner' });
    ws = await outreachBusiness(owner, 'Followers Co');
    riley = await createTestUser('outfo-riley', { fullName: 'Riley Member' });
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: riley.id, role: 'member' });
    playbookId = (
      await runAs(owner, ws, 'outreach.playbook.save', {
        name: 'CRM demos',
        template: 'crm_demos',
        details: crm,
      })
    ).id;
    // A friend already, who follows them too.
    await runAs(owner, ws, 'outreach.friends.save', {
      list: 'friends',
      people: [{ profile: fb('kate.nguyen.9'), name: 'Kate Nguyen', mutualFriends: null }],
    });
  }, 60_000);

  it('is read the first time, then a week on by the business’s days', async () => {
    expect(await next()).toEqual({ due: true });
    // A part before the last keeps who it read, and the week's read isn't done yet.
    const part = await save([follower('dana.reyes.31', 'Dana Reyes')], false);
    expect(part).toEqual({ saved: 1, added: 1, readAt: null });
    expect(await next()).toEqual({ due: true });
    const last = await save([
      follower('dana.reyes.31', 'Dana Reyes'),
      follower('milo.park.2', 'Milo Park'),
      follower('kate.nguyen.9', 'Kate Nguyen'),
    ]);
    // Dana was kept already, and Kate is a friend: only Milo is new to check.
    expect(last).toMatchObject({ saved: 3, added: 1 });
    expect(typeof last.readAt).toBe('string');
    expect(await next()).toEqual({ due: false });
    const moveBack = (days: number) =>
      admin().execute(
        sql`update addon_outreach.follower_reads set read_at = now() - make_interval(days => ${days})
            where workspace_id = ${ws} and user_id = ${owner.id}`,
      );
    await moveBack(6);
    expect((await next()).due).toBe(false);
    await moveBack(7);
    expect((await next()).due).toBe(true);
    // Kept as profiles, and nobody in Contacts.
    const [kept] = await rows<{ n: number; people: number }>(
      admin(),
      sql`select count(*)::int as n, count(person_id)::int as people from addon_outreach.profiles
          where workspace_id = ${ws}`,
    );
    expect(kept).toEqual({ n: 3, people: 0 });
  });

  it('checks the followers who aren’t friends like friends, after the friends', async () => {
    // The friends first; then the followers, those kept latest first, as friends go.
    expect(await checksNext()).toEqual([
      ['Kate Nguyen', 'friend'],
      ['Milo Park', 'follower'],
      ['Dana Reyes', 'follower'],
    ]);
    // A teammate's followers are their own: Riley has none.
    expect(await checksNext(riley)).toEqual([]);
  });

  it('counts a follower’s check with the friends’, and says it’s of a follower', async () => {
    const dana = await idOf('dana.reyes.31');
    await checkedAs(owner, ws, dana, {
      fit: 'good',
      why: ['Owns a roofing business'],
      playbookId,
    });
    const [check] = await rows<{ via: string }>(
      admin(),
      sql`select via from addon_outreach.checks where profile_id = ${dana} and user_id = ${owner.id}`,
    );
    expect(check!.via).toBe('follower');
    const after = (await runAs(owner, ws, 'outreach.checks.next', {})) as { today: number };
    expect(after.today).toBe(1);
    // Not someone they know: not on the Friends tab's fits, nor Reconnect.
    const fits = await runAs(owner, ws, 'outreach.friends', { view: 'fits' });
    expect((fits.people as { name: string }[]).map((p) => p.name)).not.toContain('Dana Reyes');
  });

  it('puts a good fit on Today: a like first, then the friend request a day after', async () => {
    const dana = await idOf('dana.reyes.31');
    expect(await today()).toEqual([
      expect.objectContaining({
        kind: 'warm_up',
        name: 'Dana Reyes',
        why: [FOLLOWER_WHY, 'Owns a roofing business', 'Their friend request comes a day after'],
        playbookName: 'CRM demos',
      }),
    ]);
    await rows(
      admin(),
      sql`insert into addon_outreach.touches (workspace_id, profile_id, user_id, kind, at)
          values (${ws}, ${dana}, ${owner.id}, 'like', now() - interval '2 days')`,
    );
    expect(await today()).toEqual([
      expect.objectContaining({
        kind: 'friend_request',
        name: 'Dana Reyes',
        why: [FOLLOWER_WHY, 'Owns a roofing business', 'You liked a post of theirs'],
      }),
    ]);
    // Asked to be friends, they're off it; and a teammate never sees them.
    expect(await today(riley)).toEqual([]);
    await runAs(owner, ws, 'outreach.friend.set', { profileId: dana, dontPitch: true });
    expect(await today()).toEqual([]);
    await runAs(owner, ws, 'outreach.friend.set', { profileId: dana, dontPitch: false });
  });

  it('isn’t a follower once they’ve gone from the list three weeks', async () => {
    await admin().execute(
      sql`update addon_outreach.followers set seen_at = now() - interval '22 days'
          where workspace_id = ${ws} and user_id = ${owner.id}`,
    );
    expect(await checksNext()).toEqual([['Kate Nguyen', 'friend']]);
    expect(await today()).toEqual([]);
  });

  it('refuses more than a part at a time, and anyone not on Facebook', async () => {
    const many = Array.from({ length: FOLLOWERS_SAVE_MOST + 1 }, (_, i) =>
      follower(`many.people.${i}`, `Person ${i}`),
    );
    expect(await refused(save(many))).toBe('validation');
    expect(
      await refused(
        runAs(owner, ws, 'outreach.followers.save', {
          platform: 'linkedin',
          people: [],
        }),
      ),
    ).toBe('validation');
  });
});
