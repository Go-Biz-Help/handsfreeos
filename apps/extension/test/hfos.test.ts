/**
 * What the extension sends HandsFreeOS: the saves and the look-up built from a read, cut to what the commands take,
 * with Facebook's times made to last; and which businesses it can save to.
 */
import { KEPT_MESSAGES } from '@hfos/core/addons/outreach/limits';
import { describe, expect, it } from 'vitest';
import type { ChatPage, ProfilePage, ReadResult } from '../src/facebook/types';
import {
  chatSave,
  MOST_BYTES,
  nameKey,
  onPage,
  outreachBusinesses,
  profileSave,
} from '../src/hfos/saves';
import { resolveWhen } from '../src/hfos/when';

const WS = '6f0a3c1e-2b4d-4e8f-9a1b-3c5d7e9f1a2b';
const PERSON = '0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e';

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

const profilePage = (more: Partial<ProfilePage> = {}): ProfilePage => ({
  name: 'Dana Reyes',
  profile: dana,
  intro: ['Owner at Reyes Plumbing', 'Lives in Austin, Texas'],
  friendship: 'not_friends',
  mutualFriends: 3,
  ...more,
});

const chatPage = (more: Partial<ChatPage> = {}): ChatPage => ({
  name: 'Dana Reyes',
  thread,
  profile: dana,
  messages: [
    {
      from: 'me',
      sender: null,
      text: 'Hi Dana, saw your post about missed calls.',
      when: 'Wed 11:02 AM',
    },
    { from: 'them', sender: 'Dana', text: 'Yes! It’s been a mess.', when: '10:12 AM' },
  ],
  ...more,
});

const read = (more: Partial<ReadResult>): ReadResult => ({
  kind: 'other',
  url: 'https://www.facebook.com/',
  readAt: '2026-10-05T15:00:00.000Z',
  warnings: [],
  notes: [],
  ...more,
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

describe('profileSave', () => {
  it('sends the profile as the page showed it', () => {
    expect(profileSave(profilePage(), WS)).toEqual({
      ok: true,
      input: {
        workspaceId: WS,
        platform: 'facebook',
        profile: dana,
        name: 'Dana Reyes',
        intro: ['Owner at Reyes Plumbing', 'Lives in Austin, Texas'],
        friendship: 'not_friends',
        mutualFriends: 3,
      },
    });
  });

  it('says who the person picked, and cuts what’s too long to fit', () => {
    const built = profileSave(
      profilePage({
        name: `  Dana   ${'R'.repeat(300)} `,
        intro: ['', ...Array.from({ length: 40 }, (_, i) => `Line ${i} ${'x'.repeat(400)}`)],
      }),
      WS,
      PERSON,
    );
    if (!built.ok) throw new Error(built.why);
    expect(built.input.personId).toBe(PERSON);
    expect(built.input.name).toHaveLength(200);
    expect(built.input.name.endsWith('…')).toBe(true);
    expect(built.input.intro).toHaveLength(30);
    expect(built.input.intro![0]!.startsWith('Line 0 ')).toBe(true);
    expect(built.input.intro!.every((line) => line.length <= 300)).toBe(true);
  });

  it('never saves your own profile, or one it couldn’t read', () => {
    expect(profileSave(profilePage({ friendship: 'self' }), WS)).toMatchObject({ ok: false });
    expect(profileSave(profilePage({ profile: null }), WS)).toMatchObject({ ok: false });
    expect(profileSave(profilePage({ name: ' ' }), WS)).toMatchObject({ ok: false });
  });
});

describe('chatSave', () => {
  const now = new Date(2026, 9, 5, 15, 30);

  it('sends the messages with their days spelled out', () => {
    const built = chatSave(chatPage(), WS, now);
    if (!built.ok) throw new Error(built.why);
    expect(built.input).toEqual({
      workspaceId: WS,
      platform: 'facebook',
      thread,
      name: 'Dana Reyes',
      profile: dana,
      messages: [
        {
          from: 'me',
          sender: null,
          text: 'Hi Dana, saw your post about missed calls.',
          when: 'Sep 30, 2026, 11:02 AM',
        },
        {
          from: 'them',
          sender: 'Dana',
          text: 'Yes! It’s been a mess.',
          when: 'Oct 5, 2026, 10:12 AM',
        },
      ],
    });
    expect(built.left).toBe(0);
  });

  it('sends the newest it keeps, and as many as fit in one request', () => {
    const many = chatPage({
      messages: Array.from({ length: KEPT_MESSAGES + 20 }, (_, i) => ({
        from: 'them' as const,
        sender: null,
        text: `Message ${i}`,
        when: null,
      })),
    });
    const kept = chatSave(many, WS, now);
    if (!kept.ok) throw new Error(kept.why);
    expect(kept.input.messages).toHaveLength(KEPT_MESSAGES);
    expect(kept.input.messages.at(-1)!.text).toBe(`Message ${KEPT_MESSAGES + 19}`);
    expect(kept.left).toBe(20);

    // 100 long messages in an alphabet that takes three bytes a letter would be 600 KB.
    const long = chatPage({
      messages: Array.from({ length: KEPT_MESSAGES }, (_, i) => ({
        from: 'me' as const,
        sender: null,
        text: `${i} ${'界'.repeat(3000)}`,
        when: null,
      })),
    });
    const fitted = chatSave(long, WS, now);
    if (!fitted.ok) throw new Error(fitted.why);
    expect(new TextEncoder().encode(JSON.stringify(fitted.input)).length).toBeLessThanOrEqual(
      MOST_BYTES,
    );
    expect(fitted.input.messages.at(-1)!.text.startsWith(`${KEPT_MESSAGES - 1} `)).toBe(true);
    expect(fitted.input.messages.every((m) => m.text.length <= 2000)).toBe(true);
    expect(fitted.left).toBe(KEPT_MESSAGES - fitted.input.messages.length);
  });

  it('never cuts through an emoji, and leaves out messages with no words', () => {
    const built = chatSave(
      chatPage({
        messages: [
          { from: 'me', sender: null, text: '   ', when: null },
          { from: 'them', sender: null, text: `${'a'.repeat(1998)}😀😀`, when: null },
        ],
      }),
      WS,
      now,
    );
    if (!built.ok) throw new Error(built.why);
    expect(built.input.messages).toHaveLength(1);
    expect(built.input.messages[0]!.text).toBe(`${'a'.repeat(1998)}…`);
  });

  it('sends a chat with no profile link for HandsFreeOS to place, and says why it can’t send others', () => {
    expect(chatSave(chatPage({ profile: null }), WS, now)).toMatchObject({
      ok: true,
      input: { profile: null },
    });
    expect(chatSave(chatPage({ profile: null }), WS, now, PERSON)).toMatchObject({
      ok: true,
      input: { personId: PERSON },
    });
    expect(chatSave(chatPage({ thread: null }), WS, now)).toMatchObject({ ok: false });
    expect(
      chatSave(chatPage({ thread: { ...thread, id: 'not/a/thread' } }), WS, now),
    ).toMatchObject({
      ok: false,
    });
    expect(chatSave(chatPage({ messages: [] }), WS, now)).toMatchObject({ ok: false });
  });
});

describe('onPage', () => {
  it('asks about each profile once, and about the one person a profile is', () => {
    const found = onPage(
      read({
        kind: 'profile',
        profile: profilePage(),
        people: [
          { name: 'Lee Park', profile: lee, details: [], badges: [], section: null },
          {
            name: 'Dana Reyes',
            profile: { ...dana, username: 'DANA.REYES.12' },
            details: [],
            badges: [],
            section: null,
          },
          { name: 'No Link', profile: null, details: [], badges: [], section: null },
        ],
      }),
    );
    expect(found).toEqual({ profiles: [dana, lee], threads: [], name: 'Dana Reyes' });
  });

  it('asks about your own profile’s people, but not about you', () => {
    expect(onPage(read({ kind: 'profile', profile: profilePage({ friendship: 'self' }) }))).toEqual(
      {
        profiles: [],
        threads: [],
        name: null,
      },
    );
  });

  it('asks about a chat, the person it’s with, and the chats in the list', () => {
    expect(
      onPage(
        read({
          kind: 'chat',
          chat: chatPage(),
          chats: [
            {
              name: 'Lee Park',
              thread: { ...thread, id: '100000000000888' },
              preview: null,
              when: null,
            },
            { name: 'Odd', thread: { ...thread, id: 'odd/one' }, preview: null, when: null },
          ],
        }),
      ),
    ).toEqual({
      profiles: [dana],
      threads: ['100000000000777', '100000000000888'],
      name: 'Dana Reyes',
    });
  });

  it('matches names the way HandsFreeOS does', () => {
    expect(nameKey('  Dana   REYES ')).toBe('dana reyes');
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
