/**
 * Social Outreach: what the browser extension notes as the person works on Facebook, and the activity panel
 * (docs/outreach.md, decisions 7 and 8).
 * - Noting a friend request, like, comment or message keeps who it was to and the group they were found in, and adds
 *   nobody to Contacts; saving the profile later does, and it keeps its steps.
 * - The same post liked twice, or a second friend request within a day, is noted once.
 * - A message starts a chat, follows one up on a later day, or neither; answering them is neither.
 * - A step that waited to send keeps its moment, however long it waited.
 * - The panel counts the person's own steps, or the whole team's for owners and admins, over a stretch of days, by
 *   group and by person, with replies from saved chats or seen by the extension and demos booked; and their own day
 *   so far for the daily limits. The groups that bring demos and replies come first, there and on the Groups tab.
 * - None of it runs while the add-on is off.
 */
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, localDateOf, startOfLocalDay } from '../../src/calendar/engine/zoned';
import { outreachBusiness, refused, runAs, setOutreach } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const HOUR = 60 * 60 * 1000;

let owner: TestUser;
let member: TestUser;

/** A made-up person's profile, known by its username. */
const someone = (username: string, name: string) => ({
  profile: { id: null, username, url: `https://www.facebook.com/${username}` },
  name,
});
const austin = {
  id: '1111222233334444',
  slug: null,
  url: 'https://www.facebook.com/groups/1111222233334444/',
  name: 'Austin Small Business Owners',
};
const hills = {
  id: null,
  slug: 'hill.country.contractors',
  url: 'https://www.facebook.com/groups/hill.country.contractors/',
  name: 'Hill Country Contractors',
};
const post = (n: number) => `https://www.facebook.com/groups/1111222233334444/posts/${n}/`;

/** A business with the add-on on, the member in it, and its time zone. */
async function business(name: string): Promise<{ ws: string; timezone: string }> {
  const ws = await outreachBusiness(owner, name);
  await admin()
    .insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: member.id, role: 'member' });
  const [w] = await rows<{ timezone: string }>(
    admin(),
    sql`select timezone from app.workspaces where id = ${ws}`,
  );
  return { ws, timezone: w!.timezone };
}

/** Noon in the business's time zone, `days` from today (before it when negative). */
const noon = (days: number, timezone: string) =>
  new Date(startOfLocalDay(addDays(localDateOf(Date.now(), timezone), days), timezone) + 12 * HOUR);

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('outa-owner', { fullName: 'Chris Owner' }),
    createTestUser('outa-member', { fullName: 'Sam Member' }),
  ]);
}, 60_000);

afterAll(closeTestDbs);

describe('noting a step', () => {
  let ws: string;
  let timezone: string;
  const riley = someone('riley.brooks.77', 'Riley Brooks');
  const note = (u: TestUser, input: Record<string, unknown>, at?: Date) =>
    runAs(u, ws, 'outreach.touch.save', input, at);

  beforeAll(async () => {
    ({ ws, timezone } = await business('Outreach Steps Co'));
  }, 60_000);

  it('keeps who it was to and the group they were found in, and adds nobody to Contacts', async () => {
    const noted = await note(owner, { kind: 'friend_request', ...riley, group: austin });
    expect(noted).toMatchObject({ personId: null, step: null, repeated: false });
    const [kept] = await rows(
      admin(),
      sql`select p.person_id, p.name, p.friendship, g.platform_id as group_number, g.name as group_name
          from addon_outreach.profiles p left join addon_outreach.groups g on g.id = p.group_id
          where p.id = ${noted.profileId}`,
    );
    expect(kept).toEqual({
      person_id: null,
      name: 'Riley Brooks',
      friendship: 'request_sent',
      group_number: '1111222233334444',
      group_name: 'Austin Small Business Owners',
    });
    expect(await rows(admin(), sql`select id from app.people where workspace_id = ${ws}`)).toEqual(
      [],
    );
  });

  it('notes the same like, or another friend request within a day, once', async () => {
    expect(await note(owner, { kind: 'friend_request', ...riley })).toMatchObject({
      repeated: true,
    });
    const liked = await note(owner, { kind: 'like', ...riley, group: austin, postUrl: post(1) });
    expect(liked.repeated).toBe(false);
    expect(await note(owner, { kind: 'like', ...riley, postUrl: post(1) })).toEqual({
      ...liked,
      repeated: true,
    });
    expect((await note(owner, { kind: 'like', ...riley, postUrl: post(2) })).repeated).toBe(false);
    // Each comment counts, and a teammate's friend request is their own.
    for (let i = 0; i < 2; i++)
      expect((await note(owner, { kind: 'comment', ...riley, postUrl: post(1) })).repeated).toBe(
        false,
      );
    expect((await note(member, { kind: 'friend_request', ...riley })).repeated).toBe(false);
    // A day later, it's another.
    expect(
      (await note(owner, { kind: 'friend_request', ...riley }, noon(-3, timezone))).repeated,
    ).toBe(false);
  });

  it('says which message started a chat and which followed it up', async () => {
    const jordan = someone('jordan.pike.5', 'Jordan Pike');
    const message = (at: Date, more: Record<string, unknown> = {}) =>
      note(owner, { kind: 'message', ...jordan, threadKey: '9988776655', ...more }, at).then(
        (n) => n.step,
      );
    expect(await message(noon(-3, timezone))).toBe('first_message');
    expect(await message(new Date(noon(-3, timezone).getTime() + HOUR))).toBe(null);
    expect(await message(noon(-2, timezone))).toBe('follow_up');
    // Answering them is neither, and so is the rest of that day.
    expect(await message(noon(-1, timezone), { replying: true })).toBe(null);
    // A teammate's first message to them starts their own chat.
    expect((await note(member, { kind: 'message', ...jordan, threadKey: '1122334455' })).step).toBe(
      'first_message',
    );
  });

  it('takes the first message in a chat saved before as writing to them again', async () => {
    const casey = someone('casey.morgan.31', 'Casey Morgan');
    await runAs(owner, ws, 'outreach.chat.save', {
      thread: { id: '4455667788', url: 'https://www.facebook.com/messages/t/4455667788/' },
      name: casey.name,
      profile: casey.profile,
      messages: [{ from: 'them', text: 'Hi there!' }],
    });
    expect((await note(owner, { kind: 'message', ...casey, threadKey: '4455667788' })).step).toBe(
      'follow_up',
    );
  });

  it('adds them to Contacts once the profile is saved, and keeps their steps', async () => {
    const saved = await runAs(owner, ws, 'outreach.profile.save', {
      ...riley,
      intro: ['Owner at Brooks Landscaping'],
      friendship: 'request_sent',
    });
    expect(saved).toMatchObject({ personName: 'Riley Brooks', addedPerson: true });
    const [kept] = await rows<{ person_id: string; steps: number }>(
      admin(),
      sql`select p.person_id,
            (select count(*)::int from addon_outreach.touches t where t.profile_id = p.id) as steps
          from addon_outreach.profiles p where p.id = ${saved.profileId}`,
    );
    expect(kept).toEqual({ person_id: saved.personId, steps: 7 });
    expect((await note(owner, { kind: 'like', ...riley, postUrl: post(3) })).personId).toBe(
      saved.personId,
    );
  });

  it('keeps the moment of a step that waited to send', async () => {
    const at = noon(-6, timezone);
    const noted = await note(
      owner,
      { kind: 'like', ...someone('taylor.quinn.8', 'Taylor Quinn'), postUrl: post(4) },
      at,
    );
    const [kept] = await rows<{ at: Date }>(
      admin(),
      sql`select at from addon_outreach.touches where id = ${noted.touchId}`,
    );
    expect(new Date(kept!.at).getTime()).toBe(at.getTime());
  });

  it('knows a group by its number or the name in its link, and fills in the other', async () => {
    const taylor = someone('taylor.quinn.8', 'Taylor Quinn');
    await note(owner, { kind: 'like', ...taylor, group: hills, postUrl: post(5) });
    await note(owner, {
      kind: 'comment',
      ...taylor,
      group: { ...hills, id: '5555666677778888', name: 'Hill Country Contractors & Trades' },
    });
    expect(
      await rows(
        admin(),
        sql`select platform_id, slug, name from addon_outreach.groups
            where workspace_id = ${ws} and slug is not null`,
      ),
    ).toEqual([
      {
        platform_id: '5555666677778888',
        slug: 'hill.country.contractors',
        name: 'Hill Country Contractors & Trades',
      },
    ]);
  });

  it('is refused with a profile it can’t tell, or a group it can’t', async () => {
    expect(
      await refused(
        note(owner, {
          kind: 'like',
          profile: { id: null, username: null, url: 'https://www.facebook.com/x' },
          name: 'Nobody',
        }),
      ),
    ).toBe('validation');
    expect(
      await refused(
        note(owner, {
          kind: 'like',
          ...riley,
          group: { id: null, slug: null, url: austin.url },
        }),
      ),
    ).toBe('validation');
  });
});

describe('the activity panel', () => {
  let ws: string;
  let timezone: string;
  const avery = someone('avery.lane.21', 'Avery Lane');
  const blake = someone('blake.torres.4', 'Blake Torres');
  const cameron = someone('cameron.ruiz.9', 'Cameron Ruiz');
  const drew = someone('drew.palmer.3', 'Drew Palmer');
  const emery = someone('emery.shaw.6', 'Emery Shaw');
  const note = (u: TestUser, input: Record<string, unknown>, at?: Date) =>
    runAs(u, ws, 'outreach.touch.save', input, at);
  const panel = (u: TestUser, input: Record<string, unknown> = {}) =>
    runAs(u, ws, 'outreach.activity', input);

  beforeAll(async () => {
    ({ ws, timezone } = await business('Outreach Panel Co'));
    // Two days ago: Drew, from the Austin group, asked and written to.
    await note(owner, { kind: 'friend_request', ...drew, group: austin }, noon(-2, timezone));
    await note(owner, { kind: 'message', ...drew, threadKey: '7000000001' }, noon(-2, timezone));
    // Today: Avery from the Austin group, asked and a post liked; Blake written to; Cameron from the Hill Country one.
    await note(owner, { kind: 'friend_request', ...avery, group: austin });
    await note(owner, { kind: 'like', ...avery, group: austin, postUrl: post(10) });
    await note(owner, { kind: 'message', ...blake, threadKey: '7000000002' });
    await note(owner, { kind: 'friend_request', ...cameron, group: hills });
    // The member's: Emery, from the Austin group.
    await note(member, { kind: 'friend_request', ...emery, group: austin });
    await note(member, { kind: 'comment', ...emery, group: austin, postUrl: post(11) });
    // Drew wrote back, as the chat saved today shows.
    await runAs(owner, ws, 'outreach.chat.save', {
      thread: { id: '7000000001', url: 'https://www.facebook.com/messages/t/7000000001/' },
      name: drew.name,
      profile: drew.profile,
      messages: [
        { from: 'me', text: 'Hi Drew, saw your post in the Austin group.' },
        { from: 'them', text: 'Thanks! Happy to chat.' },
      ],
    });
  }, 60_000);

  it('counts the person’s own day, by group and by person', async () => {
    const today = await panel(owner);
    expect(today).toMatchObject({
      timezone,
      everyone: false,
      numbers: {
        people: 3,
        friendRequests: 2,
        likes: 1,
        comments: 0,
        chatsStarted: 1,
        followUps: 0,
        replies: 1,
        demos: 0,
      },
      today: { friend_request: 2, first_message: 1, follow_up: 0, comment: 0, like: 1 },
      morePeople: 0,
    });
    expect(new Date(today.from).getTime()).toBe(
      startOfLocalDay(localDateOf(Date.now(), timezone), timezone),
    );
    expect(today.groups).toEqual([
      {
        groupId: expect.any(String),
        name: 'Austin Small Business Owners',
        url: austin.url,
        people: 2,
        friendRequests: 1,
        warmedUp: 1,
        chatsStarted: 0,
        replies: 1,
        demos: 0,
      },
      {
        groupId: expect.any(String),
        name: 'Hill Country Contractors',
        url: hills.url,
        people: 1,
        friendRequests: 1,
        warmedUp: 0,
        chatsStarted: 0,
        replies: 0,
        demos: 0,
      },
    ]);
    // Drew wrote back today, so they're listed, with the steps from two days ago; and they're a customer now.
    type Row = { name: string; personId: string | null; [k: string]: unknown };
    const byName = Object.fromEntries((today.people as Row[]).map((p) => [p.name, p]));
    expect(Object.keys(byName).sort()).toEqual([
      'Avery Lane',
      'Blake Torres',
      'Cameron Ruiz',
      'Drew Palmer',
    ]);
    expect(today.people[0].name).toBe('Drew Palmer');
    expect(byName['Drew Palmer']).toMatchObject({
      personId: expect.any(String),
      group: { name: 'Austin Small Business Owners', url: austin.url },
      requestedAt: noon(-2, timezone).toISOString(),
      messagedAt: noon(-2, timezone).toISOString(),
      repliedAt: expect.any(String),
      likedAt: null,
    });
    expect(byName['Avery Lane']).toMatchObject({
      personId: null,
      requestedAt: expect.any(String),
      likedAt: expect.any(String),
      messagedAt: null,
      repliedAt: null,
    });
    expect(byName['Blake Torres']!.group).toBe(null);
  });

  it('counts a longer stretch', async () => {
    const week = await panel(owner, { period: 'week' });
    expect(week.numbers).toEqual({
      people: 4,
      friendRequests: 3,
      likes: 1,
      comments: 0,
      chatsStarted: 2,
      followUps: 0,
      replies: 1,
      demos: 0,
    });
    expect(week.groups[0]).toMatchObject({ people: 2, friendRequests: 2, chatsStarted: 1 });
  });

  it('shows owners and admins the whole team, and each member their own', async () => {
    const team = await panel(owner, { everyone: true });
    expect(team.numbers).toMatchObject({ people: 4, friendRequests: 3, likes: 1, comments: 1 });
    // The day's limits are always the person's own.
    expect(team.today).toEqual({
      friend_request: 2,
      first_message: 1,
      follow_up: 0,
      comment: 0,
      like: 1,
    });
    expect(team.groups[0]).toMatchObject({ name: 'Austin Small Business Owners', people: 3 });

    const mine = await panel(member);
    expect(mine.numbers).toMatchObject({ people: 1, friendRequests: 1, comments: 1, replies: 0 });
    expect(mine.today).toMatchObject({ friend_request: 1, comment: 1 });
    expect(await refused(panel(member, { everyone: true }))).toBe('outreach_activity_everyone');
  });

  it('counts replies the extension saw and demos booked, and puts the groups that bring them first', async () => {
    // Blake wrote back, as the extension saw in Messenger; Cameron, from the Hill Country group, booked a demo.
    await runAs(
      owner,
      ws,
      'outreach.replies.note',
      { seen: [{ name: blake.name, threadKey: '7000000002' }] },
      new Date(Date.now() + 5 * 60_000),
    );
    await runAs(owner, ws, 'outreach.demo.mark', {
      platform: 'facebook',
      ...cameron,
      booked: true,
    });
    const today = await panel(owner);
    expect(today.numbers).toMatchObject({ replies: 2, demos: 1 });
    expect(today.groups.map((g: { name: string }) => g.name)).toEqual([
      'Hill Country Contractors',
      'Austin Small Business Owners',
    ]);
    expect(today.groups[0]).toMatchObject({ people: 1, replies: 0, demos: 1 });

    // The Groups tab: what each has brought ever, the ones that brought demos and replies first.
    const groups = await runAs(owner, ws, 'outreach.groups', { view: 'all' });
    expect(
      groups.groups.map((g: { name: string; replies: number; demos: number }) => [
        g.name,
        g.replies,
        g.demos,
      ]),
    ).toEqual([
      ['Hill Country Contractors', 0, 1],
      ['Austin Small Business Owners', 1, 0],
    ]);

    // A demo taken back no longer counts.
    await runAs(owner, ws, 'outreach.demo.mark', {
      platform: 'facebook',
      ...cameron,
      booked: false,
    });
    expect((await panel(owner)).numbers.demos).toBe(0);
  });
});

describe('posts liked and commented on', () => {
  let ws: string;
  const jo = someone('jo.hill.5', 'Jo Hill');
  const kim = someone('kim.ng.8', 'Kim Ng');
  const posts = (u: TestUser, input: Record<string, unknown> = {}) =>
    runAs(u, ws, 'outreach.activity.posts', input) as Promise<{
      posts: {
        kind: string;
        name: string;
        postUrl: string | null;
        postText: string | null;
        commentText: string | null;
        why: string | null;
        auto: boolean;
        by: string | null;
      }[];
      next: string | null;
    }>;

  beforeAll(async () => {
    ({ ws } = await business('Outreach Posts Co'));
    // The extension's own like and comment keep what the post said, its comment and why; the person's own don't.
    await runAs(owner, ws, 'outreach.touch.save', {
      kind: 'like',
      ...jo,
      postUrl: post(7001),
      auto: true,
      postText: 'Finally got the new roof on the shop!',
      why: 'A new roof on their shop',
    });
    await runAs(owner, ws, 'outreach.touch.save', {
      kind: 'comment',
      ...kim,
      group: austin,
      postUrl: post(7002),
      auto: true,
      postText: 'Can anyone recommend a roofer?',
      commentText: 'We do roofs around Austin, happy to take a look!',
    });
    await runAs(member, ws, 'outreach.touch.save', {
      kind: 'comment',
      ...jo,
      postUrl: post(7003),
      postText: 'Typed by hand',
      commentText: 'My own words',
    });
    await runAs(owner, ws, 'outreach.touch.save', { kind: 'friend_request', ...kim });
  });

  it('lists the person’s own, the latest first, with what the extension’s said', async () => {
    const mine = await posts(owner);
    expect(mine.posts.map((p) => [p.kind, p.name])).toEqual([
      ['comment', 'Kim Ng'],
      ['like', 'Jo Hill'],
    ]);
    expect(mine.posts[0]).toMatchObject({
      postUrl: post(7002),
      postText: 'Can anyone recommend a roofer?',
      commentText: 'We do roofs around Austin, happy to take a look!',
      why: null,
      auto: true,
      by: null,
    });
    expect(mine.posts[1]).toMatchObject({ why: 'A new roof on their shop', commentText: null });
    expect(mine.next).toBeNull();
    expect((await posts(owner, { kind: 'like' })).posts).toHaveLength(1);
  });

  it('never keeps what the person wrote, and shows owners everyone’s', async () => {
    const theirs = await posts(member);
    expect(theirs.posts).toHaveLength(1);
    expect(theirs.posts[0]).toMatchObject({ auto: false, postText: null, commentText: null });
    const team = await posts(owner, { everyone: true });
    expect(team.posts).toHaveLength(3);
    expect(team.posts.find((p) => !p.auto)?.by).toBe('Sam Member');
    expect(await refused(posts(member, { everyone: true }))).toBe('outreach_activity_everyone');
  });
});

describe('with the add-on off', () => {
  it('notes nothing and shows nothing', async () => {
    const { ws } = await business('Outreach Off Co');
    await setOutreach(ws, 'disabled');
    expect(
      await refused(
        runAs(owner, ws, 'outreach.touch.save', {
          kind: 'like',
          ...someone('riley.brooks.77', 'Riley Brooks'),
        }),
      ),
    ).toBe('addon_inactive');
    expect(await refused(runAs(owner, ws, 'outreach.activity', {}))).toBe('addon_inactive');
  });
});
