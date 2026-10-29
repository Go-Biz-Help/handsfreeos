/**
 * Instagram accounts like yours (docs/outreach.md decision 110, the owner's pick 10a): the AI picks up to 5 accounts
 * (a chamber, a venue, a partner) from what Instagram's search shows for words made from the playbooks; owners and
 * admins add or remove them in Settings; each day one is read, its latest posts kept for who liked and commented on
 * them whatever the AI makes of them, and its followers kept as found.
 */
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findFact } from '../../src/addons/outreach/finds';
import {
  checkedPicks,
  LIKE_YOURS_MOST,
  likeYoursPickPrompt,
  likeYoursSearches,
  usernameOf,
} from '../../src/addons/outreach/like-yours';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { computerOn, outreachBusiness, refused, runAs, runAsSystem } from './outreach-fixture';

const admin = () => testDbs().admin.db;

afterAll(closeTestDbs);

describe('accounts like yours, in words', () => {
  it('searches for the area’s chamber, its events, a kind of business and the niche there', () => {
    expect(
      likeYoursSearches([
        {
          details: {
            area: 'Austin and Round Rock',
            niche: 'Roofers',
            businessKinds: ['Home inspector'],
          },
        },
        { details: { area: 'Denver', niche: 'Plumbers', businessKinds: [] } },
      ]),
    ).toEqual([
      'Austin chamber of commerce',
      'Austin events',
      'Home inspector Austin',
      'Roofers Austin',
    ]);
    expect(likeYoursSearches([{ details: { area: null, niche: 'Roofers' } }])).toEqual(['Roofers']);
    expect(likeYoursSearches([{ details: { area: null, niche: null } }])).toEqual([]);
  });

  it('takes a username however it’s typed, and nothing that isn’t one', () => {
    expect(usernameOf('@AustinChamber')).toBe('austinchamber');
    expect(usernameOf('austin.chamber_1')).toBe('austin.chamber_1');
    expect(usernameOf('https://www.instagram.com/austinchamber/?hl=en')).toBe('austinchamber');
    expect(usernameOf('instagram.com/austinchamber')).toBe('austinchamber');
    expect(usernameOf('Austin Chamber of Commerce')).toBeNull();
    expect(usernameOf('https://www.facebook.com/austinchamber')).toBeNull();
  });

  it('keeps only the AI’s picks it was shown, each once, no more than the room', () => {
    const shown = [
      { id: 'a', username: 'austinchamber' },
      { id: 'b', username: 'austinevents' },
      { id: 'c', username: 'pine.street.inspect' },
    ];
    expect(
      checkedPicks(
        {
          picks: [
            { username: '@AustinChamber', why: ' The city’s chamber ' },
            { username: 'austinchamber', why: 'Again' },
            { username: 'someone.else', why: 'Not shown' },
            { username: 'austinevents', why: 'Local events' },
            { username: 'pine.street.inspect', why: 'Same customers' },
          ],
        },
        shown,
        2,
      ),
    ).toEqual([
      { id: 'a', why: 'The city’s chamber' },
      { id: 'b', why: 'Local events' },
    ]);
    const prompt = likeYoursPickPrompt({
      business: 'Cole Roofing',
      playbooks: [{ name: 'Roofing', details: { area: 'Austin', niche: 'Homeowners' } }],
      room: 3,
      accounts: [
        { username: 'austinchamber', name: 'Austin Chamber', words: 'Austin chamber of commerce' },
      ],
    });
    expect(prompt).toContain('<account username="austinchamber" name="Austin Chamber"');
    expect(prompt).toContain('Pick up to 3 of these accounts');
  });

  it('says how someone was found from one', () => {
    expect(findFact({ platform: 'instagram', how: 'follows', words: '@austinchamber' })).toBe(
      'Follows @austinchamber on Instagram',
    );
    expect(findFact({ platform: 'instagram', how: 'commented', words: '@austinchamber' })).toBe(
      'Commented on a post by @austinchamber',
    );
    expect(findFact({ platform: 'instagram', how: 'liked', words: 'austinroofing' })).toBe(
      'Liked a post under #austinroofing',
    );
  });
});

describe('the business’s accounts like yours', () => {
  let owner: TestUser;
  let riley: TestUser;
  let ws: string;
  type Account = { id: string; username: string; addedBy: string; why: string | null };
  const list = async (u = owner) =>
    (await runAs(u, ws, 'outreach.like_yours.list', {})) as {
      accounts: Account[];
      most: number;
      canManage: boolean;
    };
  const next = async (u = owner) =>
    (await runAs(u, ws, 'outreach.like_yours.next', {})) as {
      searches: string[];
      account: { id: string; username: string; url: string } | null;
    };
  const stateOf = async (username: string) =>
    (
      await rows<{ state: string }>(
        admin(),
        sql`select state from addon_outreach.like_yours where workspace_id = ${ws} and username = ${username}`,
      )
    )[0]?.state;
  const ig = (username: string) => ({
    id: null,
    username,
    url: `https://www.instagram.com/${username}/`,
  });

  beforeAll(async () => {
    owner = await createTestUser('outly-owner', { fullName: 'Pat Owner' });
    ws = await outreachBusiness(owner, 'Like Yours Co');
    await computerOn(owner, ws, '0.102.0');
    riley = await createTestUser('outly-riley', { fullName: 'Riley Member' });
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: riley.id, role: 'member' });
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: 'Roofing',
      template: 'crm_demos',
      details: {
        ...PLAYBOOK_TEMPLATES.crm_demos.details,
        area: 'Austin',
        niche: 'Homeowners',
        networks: ['facebook', 'instagram'],
      },
    });
    // The owner's own Instagram, as their profile check read it.
    await rows(
      admin(),
      sql`insert into addon_outreach.setup (workspace_id, user_id, network_profiles)
          values (${ws}, ${owner.id}, jsonb_build_object('instagram', jsonb_build_object('check',
            jsonb_build_object('seen', jsonb_build_object('username', 'coleroofing',
              'url', 'https://www.instagram.com/coleroofing/')))))
          on conflict (workspace_id, user_id) do update set network_profiles = excluded.network_profiles`,
    );
  }, 60_000);

  it('starts empty, searching Instagram with words from the playbook', async () => {
    expect(await list()).toEqual({ accounts: [], most: LIKE_YOURS_MOST, canManage: true });
    expect((await list(riley)).canManage).toBe(false);
    const first = await next();
    expect(first.account).toBeNull();
    expect(first.searches[0]).toBe('Austin chamber of commerce');
  });

  it('keeps what a search found for the AI to pick from, never the person’s own account', async () => {
    const found = await runAs(owner, ws, 'outreach.like_yours.found', {
      accounts: [
        { username: 'AustinChamber', name: 'Austin Chamber', words: 'Austin chamber of commerce' },
        { username: 'austinevents', name: null, words: 'Austin events' },
        { username: 'coleroofing', name: 'Cole Roofing', words: 'Homeowners Austin' },
        { username: 'random.brand', name: null, words: 'Austin events' },
      ],
    });
    expect(found).toEqual({ candidates: 3 });
    expect(await stateOf('austinchamber')).toBe('candidate');
    expect(await stateOf('coleroofing')).toBeUndefined();
    // While they wait for the AI, and for a week after, it doesn't search again.
    expect((await next()).searches).toEqual([]);
    const [event] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.events
          where workspace_id = ${ws} and event_type = 'outreach.like_yours.found'`,
    );
    expect(event!.n).toBe(1);
  });

  it('keeps the AI’s picks and passes over the rest for good', async () => {
    const ids = await rows<{ id: string; username: string }>(
      admin(),
      sql`select id, username from addon_outreach.like_yours where workspace_id = ${ws} order by username`,
    );
    const id = (u: string) => ids.find((r) => r.username === u)!.id;
    const picked = await runAsSystem(ws, 'outreach.like_yours.pick', {
      picks: [{ id: id('austinchamber'), why: 'The city’s chamber of commerce' }],
      looked: ids.map((r) => r.id),
    });
    expect(picked).toEqual({ kept: 1 });
    expect(await stateOf('random.brand')).toBe('passed');
    expect((await list()).accounts).toMatchObject([
      { username: 'austinchamber', addedBy: 'ai', why: 'The city’s chamber of commerce' },
    ]);
    // Found again, one passed over stays passed over.
    await runAs(owner, ws, 'outreach.like_yours.found', {
      accounts: [{ username: 'random.brand', name: null, words: 'Austin events' }],
    });
    expect(await stateOf('random.brand')).toBe('passed');
  });

  it('lets an owner add and remove one, up to 5, and never a teammate', async () => {
    expect(
      await refused(runAs(riley, ws, 'outreach.like_yours.add', { account: '@pine.street' })),
    ).toBe('forbidden');
    expect(
      await refused(runAs(owner, ws, 'outreach.like_yours.add', { account: 'Pine Street Bakery' })),
    ).toBe('outreach_like_yours_username');
    const added = await runAs(owner, ws, 'outreach.like_yours.add', {
      account: 'https://www.instagram.com/Pine.Street/',
    });
    expect(added.accounts.map((a: Account) => [a.username, a.addedBy])).toEqual([
      ['austinchamber', 'ai'],
      ['pine.street', 'person'],
    ]);
    for (const u of ['venue.one', 'venue.two', 'venue.three'])
      await runAs(owner, ws, 'outreach.like_yours.add', { account: u });
    expect(
      await refused(runAs(owner, ws, 'outreach.like_yours.add', { account: 'venue.four' })),
    ).toBe('outreach_like_yours_full');
    // Five kept: no more searches.
    expect((await next()).searches).toEqual([]);
    const venue = (await list()).accounts.find((a) => a.username === 'venue.three')!;
    expect(await refused(runAs(riley, ws, 'outreach.like_yours.remove', { id: venue.id }))).toBe(
      'forbidden',
    );
    const left = await runAs(owner, ws, 'outreach.like_yours.remove', { id: venue.id });
    expect(left.accounts.map((a: Account) => a.username)).not.toContain('venue.three');
    expect(await stateOf('venue.three')).toBe('removed');
    expect(await refused(runAs(owner, ws, 'outreach.like_yours.remove', { id: venue.id }))).toBe(
      'not_found',
    );
  });

  it('reads one a day in turn, the one read longest ago first', async () => {
    const first = (await next()).account!;
    expect(first.username).toBe('austinchamber');
    expect(first.url).toBe('https://www.instagram.com/austinchamber/');
    await runAs(owner, ws, 'outreach.like_yours.read', { id: first.id });
    expect((await next()).account!.username).toBe('pine.street');
  });

  it('keeps its posts for their people whatever they say, and its followers as found', async () => {
    const saved = await runAs(owner, ws, 'outreach.posts.save', {
      platform: 'instagram',
      found: 'account',
      words: '@austinchamber',
      posts: [
        {
          url: 'https://www.instagram.com/p/AUSCHAM001/',
          author: ig('austinchamber'),
          name: 'Austin Chamber',
          text: 'Ribbon cutting at the new bakery on Pine Street this Friday.',
          comments: 12,
          reactions: 80,
        },
      ],
    });
    expect(saved.checking).toBe(1);
    const [post] = await rows<{ id: string; reasons: string[] }>(
      admin(),
      sql`select id, reasons from addon_outreach.posts
          where workspace_id = ${ws} and url = 'https://www.instagram.com/p/AUSCHAM001/'`,
    );
    expect(post!.reasons).toEqual(['By @austinchamber, an account like yours']);
    // The AI found it nothing to comment on; its people are read all the same, and the account itself isn't found.
    await runAsSystem(ws, 'outreach.post.check', {
      postId: post!.id,
      check: { good: false, strong: false, why: 'An event notice' },
    });
    const people = await runAs(owner, ws, 'outreach.posts.people_next', { platform: 'instagram' });
    expect(people.posts.map((p: { postId: string }) => p.postId)).toContain(post!.id);
    const commenters = await runAs(owner, ws, 'outreach.finds.save', {
      platform: 'instagram',
      how: 'commented',
      postId: post!.id,
      people: [
        {
          profile: ig('dana.reyes.home'),
          name: 'Dana Reyes',
          said: 'Can’t wait to try it!',
        },
      ],
    });
    expect(commenters.added).toBe(1);
    expect(
      await refused(
        runAs(owner, ws, 'outreach.finds.save', {
          platform: 'instagram',
          how: 'follows',
          people: [{ profile: ig('casey.m.home'), name: 'Casey Moreno' }],
        }),
      ),
    ).toBe('validation');
    const followers = await runAs(owner, ws, 'outreach.finds.save', {
      platform: 'instagram',
      how: 'follows',
      words: '@austinchamber',
      people: [{ profile: ig('casey.m.home'), name: 'Casey Moreno' }],
    });
    expect(followers.added).toBe(1);
    const kept = await rows<{ username: string; how: string; words: string | null }>(
      admin(),
      sql`select p.username, f.how, f.words from addon_outreach.finds f
          join addon_outreach.profiles p on p.id = f.profile_id
          where f.workspace_id = ${ws} order by p.username`,
    );
    expect(kept).toEqual([
      { username: 'casey.m.home', how: 'follows', words: '@austinchamber' },
      { username: 'dana.reyes.home', how: 'commented', words: '@austinchamber' },
    ]);
    // Posts said to be an account's need its @username, on Instagram.
    expect(
      await refused(
        runAs(owner, ws, 'outreach.posts.save', {
          platform: 'instagram',
          found: 'account',
          words: 'austinchamber',
          posts: [
            {
              url: 'https://www.instagram.com/p/AUSCHAM002/',
              author: ig('austinchamber'),
              name: 'Austin Chamber',
              text: 'Mixer next week.',
            },
          ],
        }),
      ),
    ).toBe('validation');
  });
});
