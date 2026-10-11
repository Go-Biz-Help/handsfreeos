/**
 * What the extension sends HandsFreeOS: the saves built from a read, cut to what the commands take, with Facebook's
 * times made to last; and which businesses it can save to.
 */
import { FRIENDS_SAVE_MOST } from '@hfos/core/addons/outreach/limits';
import { describe, expect, it } from 'vitest';
import type { ChatPage, Person, ProfileRef, ReadResult } from '../src/facebook/types';
import {
  chatCollect,
  friendsSave,
  groupDetailFacts,
  groupSave,
  groupsSave,
  isAdminsPage,
  isOwnGroupsPage,
  listOnPage,
  nameKey,
  outreachBusinesses,
  postsSave,
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
