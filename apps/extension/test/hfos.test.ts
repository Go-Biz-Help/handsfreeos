/**
 * What the extension sends HandsFreeOS: the saves built from a read, cut to what the commands take, with Facebook's
 * times made to last; and which businesses it can save to.
 */
import { FIND_LINES, FINDS_SAVE_MOST } from '@hfos/core/addons/outreach/finds';
import { GROUP_PEOPLE_MOST } from '@hfos/core/addons/outreach/groups';
import { FRIENDS_SAVE_MOST } from '@hfos/core/addons/outreach/limits';
import { describe, expect, it } from 'vitest';
import type { ChatPage, Person, ProfileRef, ReadResult } from '../src/networks/facebook/types';
import type { ReadResult as LinkedInRead } from '../src/networks/linkedin/types';
import {
  alignableGroupSave,
  alignableGroupsSave,
  alignablePostsSave,
  chatCollect,
  findsSave,
  friendsSave,
  groupDetailFacts,
  groupSave,
  groupsSave,
  facebookSearchPostsSave,
  instagramPostsSave,
  isAdminsPage,
  isOwnGroupsPage,
  linkedInPostsSave,
  listOnPage,
  nameKey,
  outreachBusinesses,
  postsSave,
  type AlignableMember,
  type FoundPerson,
} from '../src/hfos/saves';
import { instantOf, resolveWhen } from '../src/hfos/when';

const WS = '6f0a3c1e-2b4d-4e8f-9a1b-3c5d7e9f1a2b';

const dana = { id: null, username: 'dana.reyes.12', url: 'https://www.facebook.com/dana.reyes.12' };
const lee = {
  id: '100000000000123',
  username: null,
  url: 'https://www.facebook.com/profile.php?id=100000000000123',
};
const thread = {
  id: '100000000000777',
  encrypted: false,
  url: 'https://www.facebook.com/messages/t/100000000000777/',
};

const read = (more: Partial<ReadResult>): ReadResult => ({
  kind: 'other',
  url: 'https://www.facebook.com/',
  readAt: '2026-10-05T15:00:00.000Z',
  warnings: [],
  notes: [],
  ...more,
});

describe('instantOf', () => {
  const now = new Date(2026, 9, 5, 15, 30);
  it.each([
    ['Today at 10:12 AM', new Date(2026, 9, 5, 10, 12)],
    ['Yesterday', new Date(2026, 9, 4)],
    ['Wed 11:02 PM', new Date(2026, 8, 30, 23, 2)],
    ['Sep 25, 2026, 11:39 PM', new Date(2026, 8, 25, 23, 39)],
    ['28 September 2025 at 16:05', new Date(2025, 8, 28, 16, 5)],
    ['3h', new Date(2026, 9, 5, 12, 30)],
    ['2d', new Date(2026, 9, 3, 15, 30)],
  ])('“%s” is a moment', (when, at) => {
    expect(instantOf(when, now)).toEqual(at);
  });
  it.each(['Active now', 'Someday', '25:61'])('“%s” isn’t one', (when) => {
    expect(instantOf(when, now)).toBeNull();
  });
});

describe('chatCollect', () => {
  const now = new Date(2026, 9, 5, 15, 30);
  const chat = (messages: ChatPage['messages']): ChatPage => ({
    name: 'Dana Reyes',
    thread,
    profile: dana,
    messages,
  });

  it('gives each message the time shown above it, and leaves out ones it can’t place', () => {
    const built = chatCollect(
      chat([
        { from: 'me', sender: null, text: 'Hi Dana', when: null },
        { from: 'them', sender: 'Dana Reyes', text: 'Hey!', when: 'Yesterday at 9:00 AM' },
        { from: 'unknown', sender: null, text: 'You’re now friends', when: 'Yesterday at 9:00 AM' },
        { from: 'them', sender: 'Dana Reyes', text: 'Got a minute?', when: 'Today at 10:12 AM' },
      ]),
      now,
    );
    expect(built).toEqual({
      name: 'Dana Reyes',
      thread: { id: thread.id, encrypted: false },
      profile: dana,
      messages: [
        { fromMe: true, text: 'Hi Dana', at: new Date(2026, 9, 4, 9, 0).toISOString() },
        { fromMe: false, text: 'Hey!', at: new Date(2026, 9, 4, 9, 0).toISOString() },
        { fromMe: false, text: 'Got a minute?', at: new Date(2026, 9, 5, 10, 12).toISOString() },
      ],
    });
  });

  it('uses the list’s time when the chat shows none, and leaves out group chats', () => {
    const plain = chat([{ from: 'them', sender: null, text: 'Hello', when: null }]);
    expect(chatCollect(plain, now)).toBeNull();
    expect(chatCollect(plain, now, '2h')?.messages[0]?.at).toBe(
      new Date(2026, 9, 5, 13, 30).toISOString(),
    );
    const group = chat([
      { from: 'them', sender: 'Dana Reyes', text: 'Hi all', when: 'Today at 9:00 AM' },
      { from: 'them', sender: 'Lee Park', text: 'Hey', when: 'Today at 9:00 AM' },
    ]);
    expect(chatCollect(group, now)).toBeNull();
  });
});

describe('resolveWhen', () => {
  // A Monday, in the person's own time.
  const now = new Date(2026, 9, 5, 15, 30);

  it.each([
    ['Today at 10:12 AM', 'Oct 5, 2026, 10:12 AM'],
    ['today 10:12 AM', 'Oct 5, 2026, 10:12 AM'],
    ['Yesterday at 3:15 PM', 'Oct 4, 2026, 3:15 PM'],
    ['Yesterday', 'Oct 4, 2026'],
    ['10:12 AM', 'Oct 5, 2026, 10:12 AM'],
    ['Wed 11:02 AM', 'Sep 30, 2026, 11:02 AM'],
    ['Sunday at 9:41 AM', 'Oct 4, 2026, 9:41 AM'],
    // Facebook shows only the time for today, so a weekday that's today's is a week ago.
    ['Mon 8:00 AM', 'Sep 28, 2026, 8:00 AM'],
    ['September 28 at 4:05 PM', 'Sep 28, 2026, 4:05 PM'],
    ['Oct 5', 'Oct 5, 2026'],
    // A day still to come this year was last year's.
    ['Dec 24, 6:30 PM', 'Dec 24, 2025, 6:30 PM'],
    ['28 September', 'Sep 28, 2026'],
  ])('%s → %s', (when, written) => {
    expect(resolveWhen(when, now)).toBe(written);
  });

  it.each(['Sep 25, 2026, 11:39 PM', '3h', '2 days ago', '9/28/26, 4:05 PM', 'Feb 30', 'Someday'])(
    'keeps %s as it was printed',
    (when) => {
      expect(resolveWhen(when, now)).toBe(when);
    },
  );
});

describe('nameKey', () => {
  it('matches names the way HandsFreeOS does', () => {
    expect(nameKey('  Dana   REYES ')).toBe('dana reyes');
  });
});

describe('your lists', () => {
  const person = (name: string, more: Partial<Person> = {}): Person => ({
    name,
    profile: {
      id: null,
      username: name.toLowerCase().replace(' ', '.'),
      url: `https://www.facebook.com/${name.toLowerCase().replace(' ', '.')}`,
    },
    details: [],
    badges: [],
    section: null,
    request: null,
    ...more,
  });
  const read = (more: Partial<ReadResult>): ReadResult => ({
    kind: 'friends',
    url: 'https://www.facebook.com/friends',
    readAt: '2026-10-06T06:00:00.000Z',
    warnings: [],
    notes: [],
    ...more,
  });

  it('finds your list on the page: the whole of it, or only the requests on /friends', () => {
    const avery = person('Avery Lane', { details: ['12 mutual friends'] });
    expect(listOnPage(read({ friendList: 'friends', people: [avery] }))).toEqual({
      list: 'friends',
      people: [avery],
    });
    const asking = person('Quinn Harper', { section: 'Friend requests', request: 'received' });
    const answered = person('Sky Patel', { section: 'Friend requests', request: 'answered' });
    const suggested = person('Rowan Blake', { section: 'People you may know' });
    expect(listOnPage(read({ people: [asking, answered, suggested] }))).toEqual({
      list: 'requests',
      people: [asking],
    });
    // Someone else's friends aren't yours.
    expect(listOnPage(read({ people: [avery] }))).toBeNull();
    expect(
      listOnPage(read({ kind: 'group-members', friendList: undefined, people: [avery] })),
    ).toBeNull();
  });

  it('saves the requests you’ve got and haven’t answered, or the ones you’ve sent', () => {
    const requests = (people: Person[]) => read({ friendList: 'requests', people });
    const asking = person('Quinn Harper', { request: 'received' });
    const accepted = person('Sky Patel', { request: 'answered' });
    const sent = person('Jamie Cole', { request: 'sent' });
    expect(listOnPage(requests([asking, accepted]))).toEqual({
      list: 'requests',
      people: [asking],
    });
    expect(listOnPage(requests([sent, accepted]))).toEqual({ list: 'sent', people: [sent] });
    expect(listOnPage(requests([accepted]))).toBeNull();
    // A request you've sent shows on someone you may know too, but that isn't your list of them.
    expect(listOnPage(read({ people: [{ ...sent, section: 'People you may know' }] }))).toBeNull();
    expect(friendsSave([], 'sent', WS)).toEqual({
      ok: false,
      why: 'There are no sent requests on the page to save.',
    });
  });

  it('saves each person once with their mutual friends, in parts', () => {
    const avery = person('Avery Lane', {
      details: ['Owner at Lane Landscaping', '12 mutual friends'],
    });
    const built = friendsSave(
      [avery, avery, person('Sky Patel'), person('No Link', { profile: null })],
      'requests',
      WS,
    );
    expect(built).toEqual({
      ok: true,
      input: [
        {
          workspaceId: WS,
          platform: 'facebook',
          list: 'requests',
          people: [
            { profile: { ...avery.profile, id: null }, name: 'Avery Lane', mutualFriends: 12 },
            { profile: person('Sky Patel').profile, name: 'Sky Patel', mutualFriends: null },
          ],
        },
      ],
    });
    const many = Array.from({ length: FRIENDS_SAVE_MOST + 1 }, (_, i) =>
      person(`Friend ${i}`, {
        profile: {
          id: String(100_000_000_000_000 + i),
          username: null,
          url: `https://www.facebook.com/profile.php?id=${100_000_000_000_000 + i}`,
        },
      }),
    );
    const parts = friendsSave(many, 'friends', WS);
    expect(parts.ok && parts.input.map((part) => part.people.length)).toEqual([
      FRIENDS_SAVE_MOST,
      1,
    ]);
    expect(friendsSave([], 'friends', WS)).toEqual({
      ok: false,
      why: 'There are no friends on the page to save. Scroll down so Facebook shows them, then try again.',
    });
  });
});

describe('groups', () => {
  const group = { id: '223456789', url: 'https://www.facebook.com/groups/223456789/' };
  const person = (name: string, profile: ProfileRef, more: Partial<Person> = {}): Person => ({
    name,
    profile,
    details: ['Owner at Reyes Plumbing'],
    badges: [],
    section: 'Members near you',
    request: null,
    ...more,
  });
  const groupPage = {
    name: 'Austin Small Business Owners',
    group,
    privacy: 'public' as const,
    members: 34_718,
    joined: true,
  };

  it('reads what the line under a group’s name says', () => {
    expect(groupDetailFacts('Public group · 12K members')).toEqual({
      privacy: 'public',
      members: 12_000,
    });
    expect(groupDetailFacts('Last active 2 hours ago')).toEqual({ privacy: null, members: null });
  });

  it('saves the groups a page lists, and leaves out what isn’t a group it can keep', () => {
    const built = groupsSave(
      [
        { name: 'Austin Small Business Owners', group, detail: 'Private · 840 members' },
        {
          name: 'Odd',
          group: { id: '!!', url: 'https://www.facebook.com/groups/!!/' },
          detail: null,
        },
      ],
      WS,
    );
    expect(built.ok && built.input.groups).toEqual([
      {
        group: {
          id: '223456789',
          slug: null,
          url: group.url,
          name: 'Austin Small Business Owners',
        },
        detail: 'Private · 840 members',
        privacy: 'private',
        members: 840,
      },
    ]);
  });

  it('saves the groups on the person’s own list as ones they’re in, and nowhere else', () => {
    expect(isOwnGroupsPage('https://www.facebook.com/groups/joins/')).toBe(true);
    expect(isOwnGroupsPage('https://www.facebook.com/groups/joins/?nav_source=tab')).toBe(true);
    expect(isOwnGroupsPage('https://www.facebook.com/groups/your_groups')).toBe(true);
    expect(isOwnGroupsPage('https://www.facebook.com/groups/discover/')).toBe(false);
    expect(isOwnGroupsPage('https://www.facebook.com/groups/feed/')).toBe(false);
    expect(isOwnGroupsPage('https://www.facebook.com/search/groups/?q=austin')).toBe(false);
    const listed = [{ name: 'Austin Small Business Owners', group, detail: null }];
    const own = groupsSave(listed, WS, 'https://www.facebook.com/groups/joins/');
    expect(own.ok && own.input.groups[0]?.joined).toBe(true);
    const found = groupsSave(listed, WS, 'https://www.facebook.com/search/groups/?q=austin');
    expect(found.ok && 'joined' in found.input.groups[0]!).toBe(false);
  });

  it('marks everyone on the admins page as running the group, and says so only on the last part', () => {
    expect(isAdminsPage('https://www.facebook.com/groups/223456789/members/admins')).toBe(true);
    expect(isAdminsPage('https://www.facebook.com/groups/223456789/members')).toBe(false);
    const members = groupSave(
      read({
        kind: 'group-members',
        url: 'https://www.facebook.com/groups/223456789/members',
        group: groupPage,
        people: [
          person('Dana Reyes', dana),
          person('Lee Park', lee, { badges: ['Admin'], section: 'Admins and moderators' }),
          person('Dana Reyes', dana),
        ],
      }),
      WS,
    );
    expect(members.ok && members.input).toHaveLength(1);
    expect(
      members.ok && members.input[0]!.people!.map((p) => [p.name, p.runsGroup, p.part]),
    ).toEqual([
      ['Dana Reyes', false, 'Members near you'],
      ['Lee Park', true, 'Admins and moderators'],
    ]);
    expect(members.ok && members.input[0]!.adminsPage).toBe(false);

    const many = Array.from({ length: 501 }, (_, i) =>
      person(`Person ${i}`, {
        id: null,
        username: `person.${i}`,
        url: `https://www.facebook.com/person.${i}`,
      }),
    );
    const admins = groupSave(
      read({
        kind: 'group-members',
        url: 'https://www.facebook.com/groups/223456789/members/admins/',
        group: groupPage,
        people: many,
      }),
      WS,
    );
    expect(admins.ok && admins.input.map((part) => [part.people!.length, part.adminsPage])).toEqual(
      [
        [500, false],
        [1, true],
      ],
    );
    expect(admins.ok && admins.input[0]!.people!.every((p) => p.runsGroup)).toBe(true);
  });
});

describe('group posts', () => {
  const group = {
    name: 'Austin Small Business Owners',
    group: { id: '323456789', url: 'https://www.facebook.com/groups/323456789/' },
    privacy: 'public' as const,
    members: 34_718,
    joined: true,
  };
  const post = (n: number, more: Partial<NonNullable<ReadResult['posts']>[number]> = {}) => ({
    author: { name: 'Dana Reyes', profile: dana },
    url: `https://www.facebook.com/groups/323456789/posts/10000${n}/`,
    when: '3h',
    text: 'Can anyone recommend a CRM?',
    comments: 4,
    reactions: null,
    ...more,
  });

  it('sends the posts with who wrote them, and leaves out those it can’t comment on', () => {
    const built = postsSave(
      read({
        kind: 'group',
        group,
        posts: [
          post(1, { text: `  ${'Long post. '.repeat(400)}` }),
          post(1),
          post(2, { author: null }),
          post(3, { url: null }),
          post(4, { text: '   ' }),
          post(5, { author: { name: 'Lee Park', profile: lee } }),
        ],
      }),
      WS,
      'find',
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.input).toMatchObject({
      workspaceId: WS,
      platform: 'facebook',
      group: { id: '323456789', slug: null, name: 'Austin Small Business Owners' },
      found: 'find',
    });
    expect(built.input.posts.map((p) => [p.url.slice(-8), p.name])).toEqual([
      ['/100001/', 'Dana Reyes'],
      ['/100005/', 'Lee Park'],
    ]);
    expect(built.input.posts[0]!.text.length).toBe(2000);
    expect(built.input.posts[0]!.text.endsWith('…')).toBe(true);
    expect(built.input.posts[1]!.author).toEqual({ id: lee.id, username: null, url: lee.url });
  });

  it('sends nothing off a group’s feed', () => {
    expect(postsSave(read({ kind: 'feed', posts: [post(1)] }), WS)).toMatchObject({ ok: false });
    expect(postsSave(read({ kind: 'group', group, posts: [] }), WS)).toMatchObject({ ok: false });
  });

  it('sends the posts Facebook’s post search shows in no group, with the phrase, and none from past a week (decision 141)', () => {
    const searched = read({
      kind: 'search',
      url: 'https://www.facebook.com/search/posts/?q=missed%20calls',
      posts: [
        post(1),
        post(2, { when: '6d' }),
        post(3, { when: '3w' }),
        post(4, { when: 'March 3, 2024' }),
        post(5, { when: null }),
        post(6, { url: null }),
      ],
    });
    const built = facebookSearchPostsSave(searched, WS, '  missed calls ');
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.input).toMatchObject({
      workspaceId: WS,
      platform: 'facebook',
      group: null,
      found: 'search',
      words: 'missed calls',
    });
    expect(built.input.posts.map((p) => p.url.slice(-8))).toEqual([
      '/100001/',
      '/100002/',
      '/100005/',
    ]);
    // Only off Facebook's search.
    expect(
      facebookSearchPostsSave(read({ kind: 'group', group, posts: [post(1)] }), WS, 'missed calls'),
    ).toMatchObject({ ok: false });
  });
});

describe('outreachBusinesses', () => {
  it('lists only the businesses with Social Outreach on where the person may use it', () => {
    const workspace = (id: string, addons: string[], permissions: string[]) => ({
      id,
      organizationId: 'org',
      organizationName: 'Org',
      name: `Business ${id}`,
      slug: id,
      timezone: 'America/Chicago',
      industry: 'other',
      role: 'member' as const,
      permissions,
      addons,
      gettingStarted: false,
      needsPlan: false,
    });
    expect(
      outreachBusinesses([
        workspace('a', ['outreach'], ['outreach.use', 'records.read']),
        workspace('b', [], ['outreach.use']),
        workspace('c', ['outreach'], ['records.read']),
      ]),
    ).toEqual([{ id: 'a', name: 'Business a' }]);
  });
});

describe('found by topic (decision 92)', () => {
  const IG = 'https://www.instagram.com';
  const AL = 'https://www.alignable.com';
  const POST_ID = 'e0e0e0e0-0000-4000-8000-000000000001';
  const account = (username: string) => ({ id: null, username, url: `${IG}/${username}/` });
  const business = (id: string) => ({ id, username: null, url: `${AL}/biz/businesses/${id}` });
  const group = {
    id: 'springfield-small-business',
    url: `${AL}/groups/springfield-small-business`,
    name: 'Springfield Small Business',
  };

  it('keeps the hashtag or phrase a look or search went with on each Instagram and LinkedIn save', () => {
    const posts = [
      {
        url: `${IG}/p/C0ffee12345/`,
        author: { username: 'kim_bakes', url: `${IG}/kim_bakes/` },
        caption: 'Fresh sourdough this morning',
        likes: 12,
      },
    ];
    const tagged = instagramPostsSave(posts, WS, '#sourdough');
    expect(tagged.ok && tagged.input.words).toBe('sourdough');
    const placed = instagramPostsSave(posts, WS);
    expect(placed.ok && placed.input.words).toBeNull();

    const read = {
      kind: 'search',
      url: 'https://www.linkedin.com/search/results/content/?keywords=bakery',
      posts: [
        {
          author: {
            name: 'Kim Baker',
            profile: {
              id: null,
              username: 'kim-baker',
              url: 'https://www.linkedin.com/in/kim-baker/',
            },
          },
          company: null,
          headline: 'Owner, Kim’s Bakery',
          url: 'https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001/',
          when: '2d',
          text: 'Looking for a bakery for our office party',
          comments: 2,
          reactions: 8,
        },
      ],
    } as unknown as LinkedInRead;
    const searched = linkedInPostsSave(read, WS, 'search', '  bakery for events ');
    expect(searched.ok && searched.input).toMatchObject({
      found: 'search',
      words: 'bakery for events',
    });
    const plain = linkedInPostsSave(read, WS);
    expect(plain.ok && plain.input.words).toBeNull();
  });

  it('saves a joined Alignable group’s posts with their group, and none when it can’t tell the group', () => {
    const threads = [
      {
        author: { name: 'Dana Reyes', profile: business('B1') },
        url: `${AL}/forum/how-do-you-find-a-good-bookkeeper`,
        when: '1d',
        text: 'How do you find a good bookkeeper?',
        likes: 3,
      },
    ];
    const town = alignablePostsSave(threads, WS);
    expect(town.ok && town.input.group).toBeNull();
    const joined = alignablePostsSave(threads, WS, group);
    expect(joined.ok && joined.input.group).toEqual({
      id: null,
      slug: 'springfield-small-business',
      url: group.url,
      name: 'Springfield Small Business',
    });
    expect(
      alignablePostsSave(threads, WS, { id: '!!', url: 'https://example.com/g', name: null }),
    ).toEqual({ ok: false, why: 'Couldn’t tell which group this is.' });
  });

  it('saves the groups an Alignable page lists, each once, and as the person’s own on their groups page', () => {
    const cards = [
      { ...group, members: 1_204, joined: null, detail: 'Springfield, IL' },
      { ...group, members: 1_204, joined: null },
      {
        id: 'bakers-of-the-midwest',
        url: `${AL}/groups/bakers-of-the-midwest`,
        name: 'Bakers of the Midwest',
        members: null,
        joined: false,
      },
      { id: '!!', url: `${AL}/groups/x`, name: 'Odd', members: 3, joined: null },
    ];
    const found = alignableGroupsSave(cards, WS);
    expect(found.ok && found.input).toEqual({
      workspaceId: WS,
      platform: 'alignable',
      groups: [
        {
          group: {
            id: null,
            slug: 'springfield-small-business',
            url: group.url,
            name: 'Springfield Small Business',
          },
          detail: 'Springfield, IL',
          privacy: null,
          members: 1_204,
        },
        {
          group: {
            id: null,
            slug: 'bakers-of-the-midwest',
            url: `${AL}/groups/bakers-of-the-midwest`,
            name: 'Bakers of the Midwest',
          },
          detail: null,
          privacy: null,
          members: null,
          joined: false,
        },
      ],
    });
    const own = alignableGroupsSave(cards, WS, true);
    expect(own.ok && own.input.groups.map((g) => g.joined)).toEqual([true, true]);
    expect(alignableGroupsSave([], WS)).toEqual({
      ok: false,
      why: 'There are no groups on the page to save.',
    });
  });

  it('saves an Alignable group’s members, its leaders as running it, and says the leaders were read only on the last part', () => {
    const card = { ...group, members: 1_204, joined: true };
    const member = (i: number, leader = false): AlignableMember => ({
      name: `Owner ${i}`,
      profile: business(`B${i}`),
      lines: ['Bakery', '', 'Springfield, IL'],
      leader,
    });
    const few = alignableGroupSave(card, [member(1, true), member(2), member(2)], WS, true);
    expect(few.ok && few.input).toHaveLength(1);
    expect(few.ok && few.input[0]).toMatchObject({
      platform: 'alignable',
      privacy: null,
      members: 1_204,
      joined: true,
      adminsPage: true,
    });
    expect(
      few.ok && few.input[0]!.people!.map((p) => [p.name, p.runsGroup, p.part, p.lines]),
    ).toEqual([
      ['Owner 1', true, null, ['Bakery', 'Springfield, IL']],
      ['Owner 2', false, null, ['Bakery', 'Springfield, IL']],
    ]);
    const many = Array.from({ length: GROUP_PEOPLE_MOST + 1 }, (_, i) => member(i + 1));
    const parts = alignableGroupSave(card, many, WS, true);
    expect(parts.ok && parts.input.map((p) => [p.people!.length, p.adminsPage])).toEqual([
      [GROUP_PEOPLE_MOST, false],
      [1, true],
    ]);
    // A page with nobody on it yet still says whether its leaders were read.
    const empty = alignableGroupSave(card, [], WS, true);
    expect(empty.ok && empty.input).toEqual([
      expect.objectContaining({ people: [], adminsPage: true }),
    ]);
    expect(alignableGroupSave({ ...card, id: '!!' }, [], WS)).toEqual({
      ok: false,
      why: 'Couldn’t tell which group this is.',
    });
  });

  it('saves a good post’s commenters once each, with what they said, and the post with nobody when none showed', () => {
    const kim: FoundPerson = {
      name: 'Kim Baker',
      profile: account('kim_bakes'),
      lines: ['Home baker', 'Home baker', 'Springfield', 'Cakes', 'Bread', 'Pies'],
      said: 'Where do you get your flour?',
    };
    const built = findsSave(
      [
        kim,
        kim,
        { name: 'Nobody', profile: { id: null, username: null, url: 'https://example.com/x' } },
      ],
      'commented',
      'instagram',
      WS,
      { postId: POST_ID, words: 'ignored for a post' },
    );
    expect(built).toEqual({
      ok: true,
      input: [
        {
          workspaceId: WS,
          platform: 'instagram',
          how: 'commented',
          postId: POST_ID,
          group: null,
          words: null,
          place: null,
          people: [
            {
              name: 'Kim Baker',
              profile: account('kim_bakes'),
              lines: ['Home baker', 'Springfield', 'Cakes', 'Bread'].slice(0, FIND_LINES),
              said: 'Where do you get your flour?',
              place: null,
            },
          ],
        },
      ],
    });
    const liked = findsSave([kim], 'liked', 'instagram', WS, { postId: POST_ID });
    expect(liked.ok && liked.input[0]!.people![0]!.said).toBeNull();
    // Nobody showed: the post still goes, so it counts as read.
    const none = findsSave([], 'liked', 'instagram', WS, { postId: POST_ID });
    expect(none.ok && none.input).toEqual([
      expect.objectContaining({ postId: POST_ID, people: [] }),
    ]);
    expect(findsSave([kim], 'liked', 'instagram', WS)).toEqual({
      ok: false,
      why: 'Couldn’t tell which post they’re the people of.',
    });
  });

  it('saves a search’s businesses with its words and town, and a group’s members only with their group', () => {
    const people = Array.from({ length: FINDS_SAVE_MOST + 1 }, (_, i): FoundPerson => ({
      name: `Owner ${i}`,
      profile: business(`B${i}`),
      place: 'Springfield, IL',
    }));
    const searched = findsSave(people, 'searched', 'alignable', WS, {
      words: 'Bakery',
      place: 'Springfield, IL',
    });
    expect(searched.ok && searched.input.map((p) => p.people!.length)).toEqual([
      FINDS_SAVE_MOST,
      1,
    ]);
    expect(searched.ok && searched.input[0]).toMatchObject({
      how: 'searched',
      postId: null,
      group: null,
      words: 'Bakery',
      place: 'Springfield, IL',
    });
    expect(searched.ok && searched.input[0]!.people![0]).toMatchObject({
      place: 'Springfield, IL',
    });
    const members = findsSave(people.slice(0, 2), 'member', 'alignable', WS, { group });
    expect(members.ok && members.input[0]).toMatchObject({
      how: 'member',
      group: { slug: 'springfield-small-business' },
      place: null,
    });
    expect(findsSave(people, 'member', 'alignable', WS)).toEqual({
      ok: false,
      why: 'Couldn’t tell which group this is.',
    });
  });
});
