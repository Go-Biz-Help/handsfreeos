/**
 * Social Outreach: people found by topic on Instagram, LinkedIn and Alignable (docs/outreach.md, decision 92). A good
 * post's writer, who liked or commented on it, the businesses a search of Alignable showed and a group's members are
 * kept as the person's own finds, leaving out anyone known, reached, left alone, saying a playbook's skip word or
 * skipped for where they live, and nobody new once 3 days of checks wait. Each is checked by the AI from their own
 * page: 30 a day, 15 on training wheels or after a warning, LinkedIn's inside its 40 profiles read; none while the
 * good fits waiting for their like are 2 days of likes. Nobody found goes in Contacts.
 */
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUTOMATION_DEFAULTS,
  NETWORK_CHOICES_DEFAULTS,
  NETWORKS_DEFAULTS,
} from '../../src/addons/outreach/automation';
import { FIND_LIKES_BEHIND_DAYS, findsWaitingMost } from '../../src/addons/outreach/finds';
import { NETWORKS } from '../../src/addons/outreach/networks';
import { kindSearches } from '../../src/addons/outreach/ops/finds';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { computerOn, outreachBusiness, refused, runAs, runAsSystem } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const crm = PLAYBOOK_TEMPLATES.crm_demos.details;

describe('the searches of businesses', () => {
  it('searches a kind a local playbook and an online one share both ways, each way once', () => {
    const playbooks = [
      { details: { businessKinds: ['property manager', 'plumber'], worksOnline: null } },
      { details: { businessKinds: ['Property  manager', 'bookkeeper'], worksOnline: true } },
      { details: { businessKinds: ['plumber', 'property manager'], worksOnline: false } },
    ];
    expect(kindSearches(playbooks, 'alignable')).toEqual([
      { words: 'property manager', anywhere: false },
      { words: 'plumber', anywhere: false },
      { words: 'Property manager', anywhere: true },
      { words: 'bookkeeper', anywhere: true },
    ]);
    // LinkedIn finds people through posts, not a search of businesses.
    expect(kindSearches(playbooks, 'linkedin')).toEqual([]);
  });
});

describe('people found by topic', () => {
  let owner: TestUser;
  let riley: TestUser;
  let ws: string;
  let playbookId: string;
  const li = (username: string) => ({
    id: null,
    username,
    url: `https://www.linkedin.com/in/${username}/`,
  });
  const al = (slug: string) => ({
    id: null,
    username: slug,
    url: `https://www.alignable.com/austin-tx/${slug}`,
  });
  const post = (
    n: number,
    username: string,
    name: string,
    text: string,
    comments: number | null,
    reactions: number | null,
  ) => ({
    url: `https://www.linkedin.com/feed/update/urn:li:activity:73900000000000000${n}/`,
    author: li(username),
    name,
    text,
    comments,
    reactions,
  });
  const missed = post(
    1,
    'jordan-vale-7',
    'Jordan Vale',
    'Third Saturday in a row the crew missed calls. Anyone else?',
    6,
    20,
  );
  const lots = post(
    2,
    'morgan-price-2',
    'Morgan Price',
    'Missed calls cost us two roofs last month.',
    30,
    50,
  );
  const busy = post(
    3,
    'robin-hale-8',
    'Robin Hale',
    'How do you keep up with missed calls in storm season?',
    1,
    2,
  );
  const quiet = post(4, 'sam-okoro-4', 'Sam Okoro', 'Missed calls again today.', 0, 0);
  const unread = post(
    5,
    'kai-brennan-5',
    'Kai Brennan',
    'Missed calls are our biggest leak.',
    null,
    null,
  );
  const dull = post(6, 'lee-park-6', 'Lee Park', 'Our van got a new wrap.', 3, 9);
  const postId = async (url: string, u = owner) =>
    (
      await rows<{ id: string }>(
        admin(),
        sql`select id from addon_outreach.posts
            where workspace_id = ${ws} and url = ${url} and user_id = ${u.id}`,
      )
    )[0]!.id;
  const idOf = async (username: string) =>
    (
      await rows<{ id: string }>(
        admin(),
        sql`select id from addon_outreach.profiles where workspace_id = ${ws} and username = ${username}`,
      )
    )[0]!.id;
  const checkPost = async (url: string, good: boolean, strong = false) =>
    runAsSystem(ws, 'outreach.post.check', {
      postId: await postId(url),
      check: { good, strong, why: good ? 'Asking about missed calls' : 'Nothing to answer' },
    });
  const save = (input: Record<string, unknown>, u = owner) =>
    runAs(u, ws, 'outreach.finds.save', { platform: 'linkedin', ...input }) as Promise<{
      added: number;
      skipped: number;
    }>;
  type Next = {
    people: {
      profileId: string;
      name: string;
      how: string;
      words: string | null;
      postUrl: string | null;
    }[];
    today: number;
    perDay: number;
  };
  const next = (u = owner, input: Record<string, unknown> = {}) =>
    runAs(u, ws, 'outreach.finds.next', { platform: 'linkedin', ...input }) as Promise<Next>;
  const peopleNext = (u = owner, platform = 'linkedin') =>
    runAs(u, ws, 'outreach.posts.people_next', { platform }) as Promise<{
      posts: { postId: string; url: string; name: string; words: string | null; strong: boolean }[];
      today: number;
      perDay: number;
    }>;
  const kept = (u = owner) =>
    rows<{ name: string; how: string; said: string | null; words: string | null }>(
      admin(),
      sql`select p.name, f.how, f.said, f.words from addon_outreach.finds f
          join addon_outreach.profiles p on p.id = f.profile_id
          where f.workspace_id = ${ws} and f.user_id = ${u.id} order by p.name`,
    );
  /** Made-up people on a network, each found by `u` now: their profile ids. */
  const madeUp = async (u: TestUser, platform: string, from: number, count: number) =>
    (
      await rows<{ id: string }>(
        admin(),
        sql`with made as (
              insert into addon_outreach.profiles (workspace_id, platform, username, url, name)
              select ${ws}, ${platform}, ${`${platform}-${u.id.slice(0, 6)}-`}::text || i,
                ${`https://www.${platform}.com/in/${u.id.slice(0, 6)}-`}::text || i || '/', 'Made Up Person ' || i
              from generate_series(${from}::int, ${from + count - 1}::int) i
              returning id)
            insert into addon_outreach.finds (workspace_id, user_id, profile_id, platform, how, found_at)
            select ${ws}, ${u.id}, id, ${platform}, 'liked', now() from made
            returning profile_id as id`,
      )
    ).map((r) => r.id);
  /** Profiles `u` read today for checks of people they know, on a network. */
  const readKnown = (u: TestUser, platform: string, count: number) =>
    rows(
      admin(),
      sql`with made as (
            insert into addon_outreach.profiles (workspace_id, platform, username, url, name)
            select ${ws}, ${platform}, ${`known-${platform}-${u.id.slice(0, 6)}-`}::text || i,
              ${`https://www.${platform}.com/in/known-${u.id.slice(0, 6)}-`}::text || i || '/', 'Known Person ' || i
            from generate_series(1, ${count}::int) i
            returning id)
          insert into addon_outreach.checks (workspace_id, user_id, profile_id, verdict, looked_at, via)
          select ${ws}, ${u.id}, id, 'not', now(), 'known' from made`,
    );
  const setRule = (countries: unknown) =>
    rows(
      admin(),
      sql`update app.addon_installations
          set settings = coalesce(settings, '{}'::jsonb) || ${JSON.stringify({ countries })}::jsonb
          where workspace_id = ${ws} and addon_id = 'outreach'`,
    );
  async function teammate(name: string): Promise<TestUser> {
    const u = await createTestUser(`outf-${name.toLowerCase().replace(/\s+/g, '-')}`, {
      fullName: name,
    });
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: u.id, role: 'member' });
    return u;
  }

  beforeAll(async () => {
    owner = await createTestUser('outf-owner', { fullName: 'Pat Owner' });
    ws = await outreachBusiness(owner, 'Outreach Finds Co');
    // A good post's writer is found only for a computer that checks people found (decision 92's 18).
    await computerOn(owner, ws, '0.95.0');
    riley = await teammate('Riley Member');
    playbookId = (
      await runAs(owner, ws, 'outreach.playbook.save', {
        name: 'Roofing',
        template: 'crm_demos',
        details: {
          ...crm,
          platforms: ['linkedin', 'alignable'],
          postSearches: ['missed calls'],
          businessKinds: ['roofing contractor', 'HVAC company', 'plumber'],
          skip: [...crm.skip, 'Anyone who says “CRM consultant”'],
        },
      })
    ).id;
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: 'Bookkeepers',
      template: 'crm_demos',
      details: {
        ...crm,
        platforms: ['alignable'],
        businessKinds: ['bookkeeper'],
        worksOnline: true,
      },
    });
    // A LinkedIn connection already, and someone on Don't pitch.
    await runAs(owner, ws, 'outreach.friends.save', {
      platform: 'linkedin',
      list: 'friends',
      people: [{ profile: li('avery-lane-5'), name: 'Avery Lane', mutualFriends: null }],
    });
    await runAs(owner, ws, 'outreach.friend.set', {
      platform: 'linkedin',
      profile: li('casey-moreno-8'),
      name: 'Casey Moreno',
      dontPitch: true,
    });
    await runAs(owner, ws, 'outreach.posts.save', {
      platform: 'linkedin',
      group: null,
      found: 'search',
      words: 'missed calls',
      posts: [missed, lots, busy, quiet, unread, dull],
    });
  }, 60_000);
  afterAll(closeTestDbs);

  it('finds a good post’s writer once the AI calls the post good, and reads the busiest good posts’ people', async () => {
    // Nothing is good yet: no post's people to read.
    expect((await peopleNext()).posts).toEqual([]);
    await checkPost(missed.url, true, true);
    for (const p of [lots, busy, quiet, unread]) await checkPost(p.url, true);
    await checkPost(dull.url, false);
    expect(await kept()).toEqual([
      { name: 'Jordan Vale', how: 'posted', said: null, words: 'missed calls' },
      { name: 'Kai Brennan', how: 'posted', said: null, words: 'missed calls' },
      { name: 'Morgan Price', how: 'posted', said: null, words: 'missed calls' },
      { name: 'Robin Hale', how: 'posted', said: null, words: 'missed calls' },
      { name: 'Sam Okoro', how: 'posted', said: null, words: 'missed calls' },
    ]);
    // Asking for what the business offers first, then the busiest; one showing nobody isn't read.
    const got = await peopleNext();
    expect(got.posts.map((p) => p.name)).toEqual([
      'Jordan Vale',
      'Morgan Price',
      'Robin Hale',
      'Kai Brennan',
    ]);
    expect(got.posts[0]).toMatchObject({ url: missed.url, words: 'missed calls', strong: true });
    expect(got).toMatchObject({ today: 0, perDay: NETWORKS.linkedin.postPeoplePerDay });
    // Nobody found goes in Contacts.
    const [people] = await rows<{ n: number }>(
      admin(),
      sql`select count(person_id)::int as n from addon_outreach.profiles where workspace_id = ${ws}`,
    );
    expect(people!.n).toBe(0);
  });

  it('keeps who liked and commented, leaving out the writer and anyone known, left alone or saying a skip word', async () => {
    const id = await postId(missed.url);
    expect(
      await save({
        how: 'liked',
        postId: id,
        people: [
          { profile: li('jordan-vale-7'), name: 'Jordan Vale' },
          { profile: li('avery-lane-5'), name: 'Avery Lane' },
          { profile: li('drew-park-4'), name: 'Drew Park', lines: ['Independent CRM consultant'] },
          { profile: li('casey-moreno-8'), name: 'Casey Moreno' },
          { profile: li('quinn-harper-3'), name: 'Quinn Harper', lines: ['Owner, Harper Roofing'] },
        ],
      }),
    ).toEqual({ added: 1, skipped: 4 });
    // Found again commenting, the stronger way is kept with what they said; then someone new.
    expect(
      await save({
        how: 'commented',
        postId: id,
        people: [{ profile: li('quinn-harper-3'), name: 'Quinn Harper', said: 'Following' }],
      }),
    ).toEqual({ added: 0, skipped: 0 });
    expect(
      await save({
        how: 'commented',
        postId: id,
        people: [
          { profile: li('ellis-ford-3'), name: 'Ellis Ford', said: 'Same here, every Saturday.' },
        ],
      }),
    ).toEqual({ added: 1, skipped: 0 });
    expect((await kept()).filter((f) => f.how !== 'posted')).toEqual([
      {
        name: 'Ellis Ford',
        how: 'commented',
        said: 'Same here, every Saturday.',
        words: 'missed calls',
      },
      { name: 'Quinn Harper', how: 'commented', said: 'Following', words: 'missed calls' },
    ]);
    const [saved] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.outbox
          where workspace_id = ${ws} and event_type = 'outreach.finds.saved'`,
    );
    expect(saved!.n).toBe(2);
    // Its people are read once: it's off the list, and counts against the day.
    const got = await peopleNext();
    expect(got.posts.map((p) => p.name)).toEqual(['Morgan Price', 'Robin Hale', 'Kai Brennan']);
    expect(got.today).toBe(1);
  });

  it('refuses a post that isn’t a good one of the person’s, and a network that doesn’t check people found', async () => {
    const id = await postId(missed.url);
    const quinn = { profile: li('quinn-harper-3'), name: 'Quinn Harper' };
    expect(
      await refused(save({ how: 'liked', postId: await postId(dull.url), people: [quinn] })),
    ).toBe('outreach_find_post');
    expect(
      await refused(save({ how: 'liked', postId: id, platform: 'instagram', people: [quinn] })),
    ).toBe('outreach_find_post');
    // Each person's posts are their own.
    expect(await refused(save({ how: 'liked', postId: id, people: [quinn] }, riley))).toBe(
      'outreach_find_post',
    );
    expect(
      await refused(save({ how: 'searched', platform: 'facebook', words: 'roofing', people: [] })),
    ).toBe('outreach_finds_off');
    expect(await refused(save({ how: 'liked', people: [quinn] }))).toBe('validation');
  });

  it('skips a search’s business whose address is outside the business’s countries', async () => {
    await setRule({ mode: 'only', codes: ['US'] });
    try {
      expect(
        await save({
          platform: 'alignable',
          how: 'searched',
          words: 'roofing contractor',
          place: 'Austin, TX',
          people: [
            { profile: al('reyes-roofing'), name: 'Dana Reyes', place: 'Austin, TX' },
            { profile: al('alvarez-hvac'), name: 'Nico Alvarez', place: 'Toronto, ON' },
            { profile: al('sutton-plumbing'), name: 'Rae Sutton' },
          ],
        }),
      ).toEqual({ added: 2, skipped: 1 });
      const where = await rows<{ name: string; country: string | null; how: string | null }>(
        admin(),
        sql`select name, country, country_how as how from addon_outreach.profiles
            where workspace_id = ${ws} and platform = 'alignable' order by name`,
      );
      // Kept where they live, so Skipped for country shows who was left out and why.
      expect(where).toEqual([
        { name: 'Dana Reyes', country: 'US', how: 'seen' },
        { name: 'Nico Alvarez', country: 'CA', how: 'seen' },
        { name: 'Rae Sutton', country: null, how: null },
      ]);
      // Someone with no place is looked at by their check, which says where they live.
      const alignable = await next(owner, { platform: 'alignable' });
      expect(alignable.people.map((p) => [p.name, p.how, p.words]).sort()).toEqual([
        ['Dana Reyes', 'searched', 'roofing contractor'],
        ['Rae Sutton', 'searched', 'roofing contractor'],
      ]);
    } finally {
      await setRule({ mode: 'anywhere', codes: [] });
    }
  });

  it('checks who was found, writers first, 30 a day, and lets what a commenter said go once read', async () => {
    const got = await next();
    expect(got.people.map((p) => [p.name, p.how])).toEqual([
      ['Jordan Vale', 'posted'],
      ['Kai Brennan', 'posted'],
      ['Sam Okoro', 'posted'],
      ['Robin Hale', 'posted'],
      ['Morgan Price', 'posted'],
      ['Ellis Ford', 'commented'],
      ['Quinn Harper', 'commented'],
    ]);
    expect(got.people[0]).toMatchObject({ postUrl: missed.url, words: 'missed calls' });
    expect(got).toMatchObject({ today: 0, perDay: 30 });

    const ellis = await idOf('ellis-ford-3');
    const looked = (await runAs(owner, ws, 'outreach.check.look', {
      profileId: ellis,
      lines: ['Owner, Ford Roofing · Austin, Texas'],
    })) as { checkId: string };
    const [check] = await rows<{ via: string; looked_at: string }>(
      admin(),
      sql`select via, looked_at from addon_outreach.checks where id = ${looked.checkId}`,
    );
    expect(check!.via).toBe('found');
    // Read today: off the list, and one of the day's found checks.
    const after = await next();
    expect(after.people.map((p) => p.name)).not.toContain('Ellis Ford');
    expect(after.today).toBe(1);
    // The AI's answer: what they said under the post goes with the lines.
    await runAsSystem(ws, 'outreach.check.save', {
      checkId: looked.checkId,
      lookedAt: new Date(check!.looked_at).toISOString(),
      answer: {
        fit: 'good',
        playbookId,
        why: ['Owns a roofing company'],
        about: 'Owns Ford Roofing',
        nextStep: null,
      },
    });
    expect((await kept()).find((f) => f.name === 'Ellis Ford')!.said).toBeNull();
  });

  it('marks the look known once someone found is a connection', async () => {
    const quinn = await idOf('quinn-harper-3');
    const via = async () =>
      (
        await rows<{ via: string }>(
          admin(),
          sql`select via from addon_outreach.checks where profile_id = ${quinn} and user_id = ${owner.id}`,
        )
      )[0]!.via;
    await runAs(owner, ws, 'outreach.check.look', { profileId: quinn, lines: ['Owner'] });
    expect(await via()).toBe('found');
    await runAs(owner, ws, 'outreach.friends.save', {
      platform: 'linkedin',
      list: 'friends',
      people: [{ profile: li('quinn-harper-3'), name: 'Quinn Harper', mutualFriends: null }],
    });
    await runAs(owner, ws, 'outreach.check.look', { profileId: quinn, lines: ['Owner'] });
    expect(await via()).toBe('known');
  });

  it('keeps what a commenter said with when, and nothing once their check has answered', async () => {
    const id = await postId(missed.url);
    const saidOf = async (username: string) =>
      (
        await rows<{ said: string | null; said_at: Date | string | null }>(
          admin(),
          sql`select f.said, f.said_at from addon_outreach.finds f
              join addon_outreach.profiles p on p.id = f.profile_id
              where f.workspace_id = ${ws} and f.user_id = ${owner.id} and p.username = ${username}`,
        )
      )[0]!;
    // Ellis's check said good: found commenting again, what they said isn't kept, as nothing would read it.
    expect(
      await save({
        how: 'commented',
        postId: id,
        people: [
          {
            profile: li('ellis-ford-3'),
            name: 'Ellis Ford',
            said: 'Still no answer on Saturdays.',
          },
        ],
      }),
    ).toEqual({ added: 0, skipped: 0 });
    expect(await saidOf('ellis-ford-3')).toEqual({ said: null, said_at: null });
    // Someone new: kept with when, and found again liking it, the words keep their own time.
    await save({
      how: 'commented',
      postId: id,
      people: [
        { profile: li('jamie-cole-6'), name: 'Jamie Cole', said: 'We lose a job a week to this.' },
      ],
    });
    const first = await saidOf('jamie-cole-6');
    expect(first.said).toBe('We lose a job a week to this.');
    expect(first.said_at).not.toBeNull();
    await save({
      how: 'liked',
      postId: id,
      people: [{ profile: li('jamie-cole-6'), name: 'Jamie Cole' }],
    });
    expect(await saidOf('jamie-cole-6')).toEqual(first);
  });

  it('never keeps the person’s own business, as the check of their own profile read it', async () => {
    const kim = await teammate('Kim Self');
    // Get ready's check of their own Alignable profile read it at their business's address.
    await rows(
      admin(),
      sql`insert into addon_outreach.setup (workspace_id, user_id, network_profiles)
          values (${ws}, ${kim.id}, ${JSON.stringify({
            alignable: {
              check: {
                seen: {
                  url: 'https://www.alignable.com/austin-tx/self-roofing?user=7',
                  name: 'Kim Self',
                  username: null,
                  line: null,
                  links: [],
                },
              },
            },
          })}::jsonb)
          on conflict (workspace_id, user_id) do update set network_profiles = excluded.network_profiles`,
    );
    expect(
      await save(
        {
          platform: 'alignable',
          how: 'searched',
          words: 'roofing contractor',
          people: [
            { profile: al('self-roofing'), name: 'Kim Self' },
            { profile: al('birch-builders'), name: 'Jo Birch' },
          ],
        },
        kim,
      ),
    ).toEqual({ added: 1, skipped: 1 });
    expect((await kept(kim)).map((f) => f.name)).toEqual(['Jo Birch']);
  });

  it('finds no writer of a good post for a computer that doesn’t check people found', async () => {
    const lee = await teammate('Lee Older');
    await computerOn(lee, ws, '0.94.0');
    const older = post(
      7,
      'blair-quinn-7',
      'Blair Quinn',
      'Missed calls cost us a job again.',
      2,
      4,
    );
    await runAs(lee, ws, 'outreach.posts.save', {
      platform: 'linkedin',
      group: null,
      found: 'search',
      words: 'missed calls',
      posts: [older],
    });
    await runAsSystem(ws, 'outreach.post.check', {
      postId: await postId(older.url, lee),
      check: { good: true, strong: false, why: 'Asking about missed calls' },
    });
    // Blair stays the old search pick's: nothing found waits for a check this build never makes.
    expect(await kept(lee)).toEqual([]);
  });

  it('holds LinkedIn’s profiles read for found people only on a computer that checks them, and never while likes are behind', async () => {
    /**
     * How many people `u` knows the day's checks have room for, with 35 found waiting and 40 connections to check; with
     * `behind`, as many good fits wait for their like as 2 days of likes.
     */
    const room = async (name: string, version: string, behind = false) => {
      const u = await teammate(name);
      await computerOn(u, ws, version);
      await madeUp(u, 'linkedin', 1, 35);
      if (behind) {
        const good = await madeUp(
          u,
          'linkedin',
          36,
          FIND_LIKES_BEHIND_DAYS * NETWORKS.linkedin.dailyLimits.like,
        );
        await rows(
          admin(),
          sql`insert into addon_outreach.checks (workspace_id, user_id, profile_id, verdict, looked_at, checked_at, via)
              select ${ws}, ${u.id}, id, 'good', now() - interval '1 day', now() - interval '1 day', 'found'
              from unnest(${`{${good.join(',')}}`}::uuid[]) id`,
        );
      }
      await runAs(u, ws, 'outreach.friends.save', {
        platform: 'linkedin',
        list: 'friends',
        people: Array.from({ length: 40 }, (_, i) => ({
          profile: li(`conn-${u.id.slice(0, 6)}-${i}`),
          name: `Made Up Connection ${i}`,
          mutualFriends: null,
        })),
      });
      const next = (await runAs(u, ws, 'outreach.checks.next', {
        platform: 'linkedin',
        most: 40,
      })) as { people: unknown[] };
      return next.people.length;
    };
    // 0.94.0 never checks people found: all 40 go to the people they know.
    expect(await room('Toni Older', '0.94.0')).toBe(40);
    // 0.95.0 checks people found first: 30 held for those waiting, 10 left.
    expect(await room('Ari Newer', '0.95.0')).toBe(10);
    // Likes behind: no found check runs today (`outreach.finds.next`), so none are held and all 40 are left.
    expect(await room('Bo Behind', '0.95.0', true)).toBe(40);
  });

  it('checks 30 a day inside LinkedIn’s 40 profiles read, and 15 after a warning', async () => {
    await madeUp(riley, 'linkedin', 1, 35);
    const got = await next(riley);
    expect(got).toMatchObject({ today: 0, perDay: 30 });
    expect(got.people).toHaveLength(30);
    // Each person's own: none of the owner's.
    expect(got.people.every((p) => p.name.startsWith('Made Up Person'))).toBe(true);
    expect((await next(riley, { most: 10 })).people).toHaveLength(10);
    // 39 of the 40 read for people they know: one left today.
    await readKnown(riley, 'linkedin', 39);
    expect((await next(riley)).people).toHaveLength(1);
    // A warning halves both: 20 read, 15 of them found.
    await runAs(riley, ws, 'outreach.warning.note', {
      platform: 'linkedin',
      words: ['We restrict accounts that send too many invitations'],
    });
    expect(await next(riley)).toMatchObject({ people: [], perDay: 15 });
  });

  it('checks Instagram’s people found beside its own profiles read', async () => {
    await madeUp(riley, 'instagram', 1, 5);
    await readKnown(riley, 'instagram', NETWORKS.instagram.checksPerDay);
    const got = await next(riley, { platform: 'instagram' });
    expect(got).toMatchObject({ today: 0, perDay: 30 });
    expect(got.people).toHaveLength(5);
  });

  it('checks 15 a day on training wheels', async () => {
    const dana = await teammate('Dana Wheels');
    await runAs(dana, ws, 'outreach.automation.save', {
      settings: {
        ...AUTOMATION_DEFAULTS,
        networks: {
          ...NETWORKS_DEFAULTS,
          linkedin: { ...NETWORK_CHOICES_DEFAULTS, on: true, sending: 'everything' },
        },
      },
    });
    await madeUp(dana, 'linkedin', 1, 20);
    const got = await next(dana);
    expect(got).toMatchObject({ today: 0, perDay: 15 });
    expect(got.people).toHaveLength(15);
  });

  it('checks no more while the good fits waiting for their like are 2 days of likes', async () => {
    const sam = await teammate('Sam Likes');
    const behind = FIND_LIKES_BEHIND_DAYS * NETWORKS.linkedin.dailyLimits.like;
    const good = await madeUp(sam, 'linkedin', 1, behind);
    await rows(
      admin(),
      sql`insert into addon_outreach.checks (workspace_id, user_id, profile_id, verdict, looked_at, checked_at, via)
          select ${ws}, ${sam.id}, id, 'good', now() - interval '1 day', now() - interval '1 day', 'found'
          from unnest(${`{${good.join(',')}}`}::uuid[]) id`,
    );
    const [waiting] = await madeUp(sam, 'linkedin', behind + 1, 1);
    expect((await next(sam)).people).toEqual([]);
    // One liked: Today has caught up enough.
    await rows(
      admin(),
      sql`insert into addon_outreach.touches (workspace_id, profile_id, user_id, kind, at)
          values (${ws}, ${good[0]!}, ${sam.id}, 'like', now())`,
    );
    expect((await next(sam)).people.map((p) => p.profileId)).toEqual([waiting]);
  });

  it('gives the day’s searches of Alignable in turn, each searching anywhere when its playbook works online', async () => {
    const { searches } = (await runAs(owner, ws, 'outreach.finds.searches', {
      platform: 'alignable',
    })) as { searches: { words: string; anywhere: boolean }[] };
    expect(searches).toHaveLength(3);
    const all = new Map([
      ['roofing contractor', false],
      ['HVAC company', false],
      ['plumber', false],
      ['bookkeeper', true],
    ]);
    for (const s of searches) expect(all.get(s.words)).toBe(s.anywhere);
    expect(new Set(searches.map((s) => s.words)).size).toBe(3);
    // LinkedIn finds people through posts, not a search of businesses.
    expect(
      (await runAs(owner, ws, 'outreach.finds.searches', { platform: 'linkedin' })).searches,
    ).toEqual([]);
  });

  it('reads nobody new while 3 days of checks wait', async () => {
    const most = findsWaitingMost(NETWORKS.alignable.foundChecksPerDay!);
    await madeUp(riley, 'alignable', 1, most);
    expect(
      await save(
        {
          platform: 'alignable',
          how: 'searched',
          words: 'roofing contractor',
          people: [{ profile: al('brook-roofing'), name: 'Brook Lane' }],
        },
        riley,
      ),
    ).toEqual({ added: 0, skipped: 1 });
    expect(
      (await runAs(riley, ws, 'outreach.finds.searches', { platform: 'alignable' })).searches,
    ).toEqual([]);
    // The owner's own aren't held by the teammate's.
    expect(
      (await runAs(owner, ws, 'outreach.finds.searches', { platform: 'alignable' })).searches,
    ).toHaveLength(3);
  });
});
