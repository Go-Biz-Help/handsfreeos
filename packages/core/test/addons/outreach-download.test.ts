/**
 * Social Outreach: Facebook's download file (docs/outreach.md, decisions 2 and 15).
 * - Read in the browser, it finds the friends, the requests either way, the friends removed, the requests deleted,
 *   the followers and the one-to-one chats in Facebook's zips, in either shape of list, with Facebook's letters put
 *   back together. Of what was said it keeps only each one-to-one chat's latest few messages, for the AI to read
 *   (a photo is said as one), and a zip over 4 GB reads the same.
 * - A file it can't read says why: not a zip, cut short, locked, in HTML, or with nothing in it.
 * - It goes in parts small enough to send, and the last part matches each name to the one profile saved by it (the
 *   person's own among several; nobody when the file has the name twice), and puts what the file says in place in
 *   the person's own friends. Newer news wins, a deleted request stays deleted, and Keep stays. Bringing it in again
 *   changes nothing.
 * - The Friends tab says since when they've been friends, and the latest message either way, and a teammate sees
 *   none of it.
 */
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chatIn,
  chatsByPerson,
  DownloadError,
  downloadParts,
  facebookText,
  listIn,
  nameKey,
  readDownload,
  zipEntries,
  DOWNLOAD_PART_BYTES,
  DOWNLOAD_PEOPLE_MOST,
  type DownloadProblem,
} from '../../src/addons/outreach/download';
import { MESSAGE_MOST, RECENT_MESSAGES } from '../../src/addons/outreach/limits';
import { outreachBusiness, refused, runAs, setOutreach } from './outreach-fixture';
import { asFacebookWrites, makeZip, type ZipFile } from './zip-maker';

const json = (name: string, data: unknown): ZipFile => ({ name, data: JSON.stringify(data) });
const seconds = (iso: string) => Date.parse(iso) / 1000;
const ms = (iso: string) => Date.parse(iso);
const blob = (bytes: Uint8Array<ArrayBuffer>) => new Blob([bytes]);
const MADE = new Date(Date.UTC(2026, 9, 1, 12));

/** A made-up download, laid out as Facebook lays one out: the person's profile, their lists, and their chats. */
const DOWNLOAD: ZipFile[] = [
  json('personal_information/profile_information/profile_information.json', {
    profile_v2: { name: { full_name: 'Pat Owner' } },
  }),
  json('connections/friends/your_friends.json', {
    friends_v2: [
      { name: 'Avery Lane', timestamp: seconds('2015-03-02T10:00:00Z') },
      { name: asFacebookWrites('Renée Dubois'), timestamp: seconds('2019-07-14T08:30:00Z') },
      { name: 'Sam Lee', timestamp: seconds('2012-01-05T00:00:00Z') },
      { name: 'Sam Lee', timestamp: seconds('2020-06-01T00:00:00Z') },
      // An account that's gone: nobody to find.
      { name: 'Facebook user', timestamp: seconds('2014-01-01T00:00:00Z') },
    ],
  }),
  json('connections/friends/sent_friend_requests.json', {
    sent_requests_v2: [{ name: 'Quinn Harper', timestamp: seconds('2026-09-01T15:00:00Z') }],
  }),
  json('connections/friends/received_friend_requests.json', {
    received_requests_v2: [{ name: 'Riley Brooks', timestamp: seconds('2026-09-20T09:00:00Z') }],
  }),
  json('connections/friends/removed_friends.json', {
    deleted_friends_v2: [{ name: 'Jordan Vega', timestamp: seconds('2021-02-03T00:00:00Z') }],
  }),
  json('connections/friends/rejected_friend_requests.json', {
    rejected_requests_v2: [{ name: 'Casey Moreno', timestamp: seconds('2023-05-06T00:00:00Z') }],
  }),
  // The newer shape of a list: labelled values.
  json('connections/followers/people_who_followed_you.json', [
    {
      timestamp: seconds('2024-04-04T00:00:00Z'),
      label_values: [{ label: 'Name', value: 'Drew Kim' }],
    },
  ]),
  // Lists that aren't read.
  json('connections/friends/people_you_may_know.json', {
    people_you_may_know_v2: [{ name: 'Morgan Ellis', timestamp: seconds('2026-01-01T00:00:00Z') }],
  }),
  json('your_facebook_activity/messages/inbox/averylane_1001/message_1.json', {
    participants: [{ name: 'Avery Lane' }, { name: 'Pat Owner' }],
    messages: [
      {
        sender_name: 'Avery Lane',
        timestamp_ms: ms('2026-08-30T18:00:00Z'),
        content: 'See you at the lake',
      },
      { sender_name: 'Pat Owner', timestamp_ms: ms('2016-02-01T12:00:00Z'), content: 'Hello!' },
    ],
  }),
  json('your_facebook_activity/messages/inbox/averylane_1001/message_2.json', {
    participants: [{ name: 'Avery Lane' }, { name: 'Pat Owner' }],
    messages: [
      { sender_name: 'Pat Owner', timestamp_ms: ms('2015-03-03T09:00:00Z'), content: 'Thanks!' },
      { sender_name: 'Avery Lane', timestamp_ms: ms('2015-03-03T09:05:00Z'), photos: [{}] },
    ],
  }),
  json('your_facebook_activity/messages/inbox/lakecrew_2002/message_1.json', {
    participants: [{ name: 'Avery Lane' }, { name: 'Pat Owner' }, { name: 'Drew Kim' }],
    messages: [
      { sender_name: 'Drew Kim', timestamp_ms: ms('2026-09-25T10:00:00Z'), content: 'Boat?' },
    ],
  }),
  {
    name: 'your_facebook_activity/messages/inbox/averylane_1001/photos/1.jpg',
    data: new Uint8Array([255, 216, 255]),
    store: true,
  },
];

/** The chat backup: the newer chats, in their own zip, without the download's folders. */
const BACKUP: ZipFile[] = [
  json('quinnharper_3003/message_1.json', {
    participants: ['Quinn Harper', 'Pat Owner'],
    messages: [
      { senderName: 'Pat Owner', timestamp: ms('2026-09-02T16:00:00Z'), text: 'Glad we met' },
      { senderName: 'Quinn Harper', timestamp: ms('2026-09-02T15:00:00Z'), text: 'Hi there' },
    ],
  }),
];

async function problem(p: Promise<unknown>): Promise<DownloadProblem | string> {
  try {
    await p;
  } catch (e) {
    return e instanceof DownloadError ? e.rule : String(e);
  }
  return 'read';
}

describe('reading Facebook’s download', () => {
  it('puts Facebook’s letters back together, and matches names however they’re spaced', () => {
    expect(facebookText('JosÃ©')).toBe('José');
    expect(facebookText(asFacebookWrites('Zoë Ångström'))).toBe('Zoë Ångström');
    expect(facebookText('Plain Name')).toBe('Plain Name');
    // Text that isn't written that way stays as it was.
    expect(facebookText('Zoë')).toBe('Zoë');
    expect(facebookText('Łukasz')).toBe('Łukasz');
    expect(nameKey('  Renée   DUBOIS ')).toBe('renée dubois');
  });

  it('finds the lists, the chats and the person’s own name, and keeps only one-to-one chats’ words', async () => {
    const steps: number[] = [];
    const read = await readDownload(
      [blob(makeZip(DOWNLOAD, { at: MADE })), blob(makeZip(BACKUP))],
      (done) => {
        steps.push(done);
      },
    );
    expect(read.madeAt).toBe(MADE.toISOString());
    expect(
      [...read.people].sort((a, b) =>
        `${a.list}${a.name}${a.at}`.localeCompare(`${b.list}${b.name}${b.at}`),
      ),
    ).toEqual([
      { list: 'declined', name: 'Casey Moreno', at: '2023-05-06T00:00:00.000Z' },
      { list: 'followers', name: 'Drew Kim', at: '2024-04-04T00:00:00.000Z' },
      { list: 'friends', name: 'Avery Lane', at: '2015-03-02T10:00:00.000Z' },
      { list: 'friends', name: 'Renée Dubois', at: '2019-07-14T08:30:00.000Z' },
      { list: 'friends', name: 'Sam Lee', at: '2012-01-05T00:00:00.000Z' },
      { list: 'friends', name: 'Sam Lee', at: '2020-06-01T00:00:00.000Z' },
      { list: 'removed', name: 'Jordan Vega', at: '2021-02-03T00:00:00.000Z' },
      { list: 'request_received', name: 'Riley Brooks', at: '2026-09-20T09:00:00.000Z' },
      { list: 'request_sent', name: 'Quinn Harper', at: '2026-09-01T15:00:00.000Z' },
    ]);
    // One-to-one chats only, each person's parts together, the backup's too.
    expect([...read.chats].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      {
        name: 'Avery Lane',
        firstAt: '2015-03-03T09:00:00.000Z',
        lastAt: '2026-08-30T18:00:00.000Z',
        messages: 4,
        lastFromMe: false,
        recent: [
          { fromMe: true, text: 'Thanks!', at: '2015-03-03T09:00:00.000Z' },
          { fromMe: false, text: '(a photo)', at: '2015-03-03T09:05:00.000Z' },
          { fromMe: true, text: 'Hello!', at: '2016-02-01T12:00:00.000Z' },
          { fromMe: false, text: 'See you at the lake', at: '2026-08-30T18:00:00.000Z' },
        ],
      },
      {
        name: 'Quinn Harper',
        firstAt: '2026-09-02T15:00:00.000Z',
        lastAt: '2026-09-02T16:00:00.000Z',
        messages: 2,
        lastFromMe: true,
        recent: [
          { fromMe: false, text: 'Hi there', at: '2026-09-02T15:00:00.000Z' },
          { fromMe: true, text: 'Glad we met', at: '2026-09-02T16:00:00.000Z' },
        ],
      },
    ]);
    // A group chat's words are never kept.
    expect(JSON.stringify(read)).not.toMatch(/Boat/);
    expect(read.unread).toBe(0);
    expect(steps.at(-1)).toBe(read.read);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
  });

  it('reads a zip over 4 GB the same way', async () => {
    const small = await readDownload([blob(makeZip(DOWNLOAD, { at: MADE }))]);
    const big = await readDownload([blob(makeZip(DOWNLOAD, { at: MADE, big: true }))]);
    expect(big).toEqual(small);
    expect((await zipEntries(blob(makeZip(DOWNLOAD, { big: true })))).map((e) => e.name)).toEqual(
      DOWNLOAD.map((f) => f.name),
    );
  });

  it('dates the file no earlier than the latest moment in it', async () => {
    const read = await readDownload([
      blob(makeZip(DOWNLOAD, { at: new Date(Date.UTC(2010, 0, 1)) })),
    ]);
    expect(read.madeAt).toBe('2026-09-20T09:00:00.000Z');
  });

  it('says why a file can’t be read', async () => {
    expect(await problem(readDownload([new Blob(['just some words, not a zip'])]))).toBe('not_zip');
    const whole = makeZip(DOWNLOAD);
    expect(await problem(readDownload([blob(whole.slice(0, Math.floor(whole.length / 2)))]))).toBe(
      'cut_short',
    );
    expect(
      await problem(
        readDownload([
          blob(makeZip([{ name: 'connections/friends/your_friends.html', data: '<html></html>' }])),
        ]),
      ),
    ).toBe('html');
    expect(
      await problem(
        readDownload([blob(makeZip([json('apps_and_websites/your_apps.json', { apps: [] })]))]),
      ),
    ).toBe('nothing');
    expect(
      await problem(
        readDownload([
          blob(
            makeZip([
              {
                ...json('connections/friends/your_friends.json', { friends_v2: [] }),
                locked: true,
              },
            ]),
          ),
        ]),
      ),
    ).toBe('locked');
  });

  it('reads either shape of a list, and leaves other files alone', () => {
    expect(
      listIn('connections/followers/who_you_follow.json', {
        following_v3: [
          { string_list_data: [{ value: 'Drew Kim', timestamp: seconds('2022-01-01T00:00:00Z') }] },
        ],
      }),
    ).toEqual([{ list: 'following', name: 'Drew Kim', at: '2022-01-01T00:00:00.000Z' }]);
    expect(
      listIn('connections/friends/your_friends.json', { friends_v2: [{ name: 'Avery Lane' }] }),
    ).toEqual([{ list: 'friends', name: 'Avery Lane', at: null }]);
    expect(
      listIn('connections/friends/people_you_may_know.json', { people_you_may_know_v2: [] }),
    ).toBeNull();
    expect(
      listIn('your_facebook_activity/posts/your_posts_1.json', [{ title: 'A post' }]),
    ).toBeNull();
  });

  it('finds the person in their chats without their profile, when they’re in more than one', () => {
    const chat = (other: string, from: string, at: string) => ({
      people: [other, 'Pat Owner'],
      messages: [{ from, at: ms(at) }],
    });
    const chats = [
      chat('Avery Lane', 'Pat Owner', '2026-01-01T00:00:00Z'),
      chat('Quinn Harper', 'Quinn Harper', '2026-02-01T00:00:00Z'),
    ];
    expect(chatsByPerson(chats, null).map((c) => [c.name, c.lastFromMe])).toEqual([
      ['Avery Lane', true],
      ['Quinn Harper', false],
    ]);
    // One chat: there's no telling which of the two is the person.
    expect(chatsByPerson(chats.slice(0, 1), null)).toEqual([]);
  });

  it('keeps a long chat’s latest messages only, across its files, each cut to fit', () => {
    const file = (from: number, to: number) => ({
      participants: [{ name: 'Avery Lane' }, { name: 'Pat Owner' }],
      messages: Array.from({ length: to - from }, (_, i) => ({
        sender_name: (from + i) % 2 ? 'Avery Lane' : 'Pat Owner',
        timestamp_ms: Date.UTC(2026, 0, 1, 0, from + i),
        content: from + i === to - 1 ? 'x'.repeat(MESSAGE_MOST + 50) : `Message ${from + i}`,
      })),
    });
    const [chat] = chatsByPerson([chatIn(file(0, 30))!, chatIn(file(30, 35))!], 'Pat Owner');
    expect(chat!.messages).toBe(35);
    expect(chat!.recent).toHaveLength(RECENT_MESSAGES);
    expect(chat!.recent[0]!.text).toBe(`Message ${35 - RECENT_MESSAGES}`);
    expect(chat!.recent.at(-1)!.text).toHaveLength(MESSAGE_MOST);
    expect(chat!.recent.at(-1)!.fromMe).toBe(true);
  });
});

describe('sending it in parts', () => {
  it('keeps each part to its most people and to a size the API takes', () => {
    const people = Array.from({ length: 1300 }, (_, i) => ({
      list: 'friends' as const,
      name: `Made Up Person ${i}`,
      at: null,
    }));
    const parts = downloadParts({ people, chats: [] });
    expect(parts.map((p) => p.people.length)).toEqual([
      DOWNLOAD_PEOPLE_MOST,
      DOWNLOAD_PEOPLE_MOST,
      100,
    ]);

    // Long names in letters of three bytes each: cut by size first.
    const long = people.map((p) => ({ ...p, name: '名'.repeat(199) + p.name.slice(-1) }));
    const sized = downloadParts({ people: long, chats: [] });
    expect(sized.length).toBeGreaterThan(3);
    for (const part of sized)
      expect(new TextEncoder().encode(JSON.stringify(part)).length).toBeLessThan(
        DOWNLOAD_PART_BYTES + 1000,
      );
    expect(sized.flatMap((p) => p.people)).toEqual(long);
  });
});

// ---- Bringing it in ----

const admin = () => testDbs().admin.db;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
const iso = (d: Date) => d.toISOString();

let owner: TestUser;
let member: TestUser;

/** A made-up person's profile, known by its username. */
const someone = (username: string, name: string) => ({
  profile: { id: null, username, url: `https://www.facebook.com/${username}` },
  name,
  mutualFriends: null,
});

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('outd-owner', { fullName: 'Pat Owner' }),
    createTestUser('outd-member', { fullName: 'Lee Member' }),
  ]);
}, 60_000);

afterAll(closeTestDbs);

describe('bringing the file in', () => {
  let ws: string;
  const made = daysAgo(7);
  const sent = daysAgo(30);
  const asked = daysAgo(10);
  const bring = (u: TestUser, input: Record<string, unknown>) =>
    runAs(u, ws, 'outreach.download.save', input);
  const friendsTab = (u: TestUser, view = 'friends', search?: string) =>
    runAs(u, ws, 'outreach.friends', { view, ...(search ? { search } : {}) });
  /** Where the owner's own Facebook stands with someone saved here, by username. */
  const stateOf = async (username: string) => {
    const [row] = await rows<{ state: string; since: string; seen_at: string; keep: boolean }>(
      admin(),
      sql`select f.state, f.since, f.seen_at, f.keep from addon_outreach.friends f
          join addon_outreach.profiles p on p.id = f.profile_id
          where p.workspace_id = ${ws} and f.user_id = ${owner.id} and p.username = ${username}`,
    );
    return row ? { ...row, since: new Date(row.since), seen_at: new Date(row.seen_at) } : null;
  };

  const PART_ONE = {
    madeAt: iso(made),
    people: [
      { list: 'friends', name: 'Avery Lane', at: '2015-03-02T10:00:00.000Z' },
      { list: 'friends', name: 'Renée Dubois', at: '2019-07-14T08:30:00.000Z' },
      { list: 'friends', name: 'Sam Lee', at: '2012-01-05T00:00:00.000Z' },
      { list: 'friends', name: 'Sam  Lee', at: '2020-06-01T00:00:00.000Z' },
      { list: 'friends', name: 'Taylor Reed', at: '2018-08-08T00:00:00.000Z' },
    ],
  };
  const PART_TWO = {
    madeAt: iso(made),
    people: [
      { list: 'request_sent', name: 'Quinn Harper', at: iso(sent) },
      // An old request the file says is still waiting, though the extension saw them as a friend since.
      { list: 'request_sent', name: 'Morgan Ellis', at: '2026-01-01T00:00:00.000Z' },
      { list: 'request_received', name: 'Riley Brooks', at: iso(asked) },
      { list: 'removed', name: 'Jordan Vega', at: '2021-02-03T00:00:00.000Z' },
      { list: 'removed', name: 'Casey Moreno', at: '2023-05-06T00:00:00.000Z' },
      { list: 'declined', name: 'Blake Novak', at: '2022-02-02T00:00:00.000Z' },
      { list: 'followers', name: 'Drew Kim', at: null },
    ],
    chats: [
      {
        name: 'Avery Lane',
        firstAt: '2015-03-03T09:00:00.000Z',
        lastAt: iso(daysAgo(40)),
        messages: 3,
        lastFromMe: false,
      },
      {
        name: 'Quinn Harper',
        firstAt: iso(daysAgo(29)),
        lastAt: iso(daysAgo(29)),
        messages: 2,
        lastFromMe: true,
      },
      {
        name: 'Nobody Saved',
        firstAt: iso(daysAgo(90)),
        lastAt: iso(daysAgo(80)),
        messages: 1,
        lastFromMe: true,
      },
    ],
  };

  beforeAll(async () => {
    ws = await outreachBusiness(owner, 'Outreach Download Co');
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: member.id, role: 'member' });
    // What the extension saved before: the owner's friends and requests, a teammate's friend.
    const save = (u: TestUser, list: string, people: unknown[]) =>
      runAs(u, ws, 'outreach.friends.save', { list, people });
    await save(owner, 'friends', [
      someone('avery.lane.4', 'Avery Lane'),
      someone('renee.dubois', 'Renée Dubois'),
      someone('sam.lee.1', 'Sam Lee'),
      someone('morgan.ellis.2', 'Morgan Ellis'),
      someone('taylor.reed.mine', 'Taylor Reed'),
    ]);
    await save(owner, 'sent', [someone('quinn.harper', 'Quinn Harper')]);
    await save(member, 'friends', [
      someone('jordan.vega', 'Jordan Vega'),
      someone('taylor.reed.theirs', 'Taylor Reed'),
    ]);
    // Riley's request deleted, and Casey's, before the file was made.
    const note = (answer: string, who: ReturnType<typeof someone>, at: Date) =>
      runAs(owner, ws, 'outreach.friend.note', { answer, ...who }, at);
    await note('delete', someone('riley.brooks', 'Riley Brooks'), daysAgo(60));
    await note('delete', someone('casey.moreno', 'Casey Moreno'), daysAgo(200));
    await runAs(owner, ws, 'outreach.friend.set', {
      ...someone('avery.lane.4', 'Avery Lane'),
      keep: true,
    });
  }, 60_000);

  it('saves each part, and with the last puts what the file says in place', async () => {
    const first = await bring(owner, PART_ONE);
    expect(first).toEqual({ importId: expect.any(String), counts: null, changed: 0 });
    const last = await bring(owner, { ...PART_TWO, importId: first.importId, last: true });
    expect(last).toEqual({
      importId: first.importId,
      counts: {
        friends: 5,
        request_sent: 2,
        request_received: 1,
        removed: 2,
        declined: 1,
        followers: 1,
        following: 0,
        chats: 3,
        // Avery, Renée, Taylor, Quinn, Morgan, Riley, Jordan, Casey; Avery's and Quinn's chats.
        linked: 10,
        notLinked: 5,
      },
      // Avery, Renée and Taylor's starts, Quinn's, Riley asking again, Jordan.
      changed: 6,
    });

    // Friends since when the file says, Keep kept.
    expect(await stateOf('avery.lane.4')).toMatchObject({
      state: 'friends',
      since: new Date('2015-03-02T10:00:00Z'),
      keep: true,
    });
    // Two Sam Lees in the file: neither is matched.
    expect((await stateOf('sam.lee.1'))!.since.getTime()).toBeGreaterThan(made.getTime());
    // Of two Taylor Reeds saved here, the owner's own.
    expect(await stateOf('taylor.reed.mine')).toMatchObject({
      since: new Date('2018-08-08T00:00:00Z'),
    });
    // The request's real day, for cancelling ones nobody answers.
    expect(await stateOf('quinn.harper')).toMatchObject({ state: 'request_sent', since: sent });
    // Seen as a friend after the file was made: newer news wins.
    expect(await stateOf('morgan.ellis.2')).toMatchObject({ state: 'friends' });
    // Deleted before, and asking again by the time the file was made.
    expect(await stateOf('riley.brooks')).toMatchObject({
      state: 'request_received',
      since: asked,
      seen_at: made,
    });
    // A teammate's friend the owner removed long ago.
    expect(await stateOf('jordan.vega')).toMatchObject({
      state: 'not_friends',
      since: new Date('2021-02-03T00:00:00Z'),
    });
    // A deleted request stays deleted.
    expect(await stateOf('casey.moreno')).toMatchObject({ state: 'declined' });

    // Nobody added to Contacts.
    const [contacts] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.people where workspace_id = ${ws}`,
    );
    expect(contacts!.n).toBe(0);
  });

  it('shows since when, and the latest message either way, on the Friends tab', async () => {
    const tab = await friendsTab(owner);
    expect(tab.download).toEqual({
      madeAt: iso(made),
      at: expect.any(String),
      counts: expect.objectContaining({ friends: 5, linked: 10 }),
    });
    const avery = tab.people.find((p: { name: string }) => p.name === 'Avery Lane');
    expect(avery).toMatchObject({
      friendsSince: '2015-03-02T10:00:00.000Z',
      lastMessage: { at: expect.any(String), fromMe: false },
    });
    expect(Date.parse(avery.lastMessage.at)).toBeLessThan(daysAgo(39).getTime());
    const sam = tab.people.find((p: { name: string }) => p.name === 'Sam Lee');
    expect(sam).toMatchObject({ friendsSince: null, lastMessage: null });

    // A message noted since is later than the file's.
    await runAs(owner, ws, 'outreach.touch.save', {
      kind: 'message',
      ...someone('avery.lane.4', 'Avery Lane'),
      threadKey: '7000000009',
    });
    const after = await friendsTab(owner, 'friends', 'avery');
    expect(after.people[0].lastMessage.fromMe).toBe(true);
    expect(Date.parse(after.people[0].lastMessage.at)).toBeGreaterThan(daysAgo(1).getTime());

    const sentTab = await friendsTab(owner, 'sent');
    expect(sentTab.people[0]).toMatchObject({
      name: 'Quinn Harper',
      since: iso(sent),
      lastMessage: { fromMe: true },
    });

    // A teammate sees none of it.
    const theirs = await friendsTab(member);
    expect(theirs.download).toBeNull();
    expect(theirs.people.find((p: { name: string }) => p.name === 'Jordan Vega')).toMatchObject({
      friendsSince: null,
      lastMessage: null,
    });
  });

  it('changes nothing when the same file comes in again', async () => {
    const before = await rows(
      admin(),
      sql`select profile_id, state, since, seen_at, keep from addon_outreach.friends
          where workspace_id = ${ws} order by profile_id, user_id`,
    );
    const first = await bring(owner, PART_ONE);
    const last = await bring(owner, { ...PART_TWO, importId: first.importId, last: true });
    expect(last.changed).toBe(0);
    expect(last.counts).toMatchObject({ friends: 5, chats: 3, linked: 10, notLinked: 5 });
    expect(
      await rows(
        admin(),
        sql`select profile_id, state, since, seen_at, keep from addon_outreach.friends
            where workspace_id = ${ws} order by profile_id, user_id`,
      ),
    ).toEqual(before);
    // Each person once, kept with the newer file.
    const [kept] = await rows<{ people: number; chats: number; imports: number }>(
      admin(),
      sql`select (select count(*)::int from addon_outreach.file_people where workspace_id = ${ws}) as people,
            (select count(*)::int from addon_outreach.file_chats where workspace_id = ${ws}) as chats,
            (select count(distinct import_id)::int from addon_outreach.file_people
              where workspace_id = ${ws}) as imports`,
    );
    expect(kept).toEqual({ people: 12, chats: 3, imports: 1 });
  });

  it('keeps a bringing-in to the person who started it, and to before it’s finished', async () => {
    const first = await bring(owner, PART_ONE);
    expect(await refused(bring(member, { ...PART_TWO, importId: first.importId }))).toBe(
      'not_found',
    );
    await bring(owner, { ...PART_TWO, importId: first.importId, last: true });
    expect(await refused(bring(owner, { ...PART_TWO, importId: first.importId }))).toBe(
      'outreach_download_finished',
    );
  });

  it('refuses a moment after the file was made', async () => {
    expect(
      await refused(
        bring(owner, {
          madeAt: iso(made),
          people: [{ list: 'friends', name: 'Avery Lane', at: iso(daysAgo(1)) }],
        }),
      ),
    ).toBe('outreach_download_dates');
    expect(
      await refused(bring(owner, { madeAt: iso(new Date(Date.now() + 3 * DAY)), people: [] })),
    ).toBe('outreach_download_dates');
  });

  it('is refused while the add-on is off', async () => {
    await setOutreach(ws, 'disabled');
    try {
      expect(await refused(bring(owner, PART_ONE))).toBe('addon_inactive');
    } finally {
      await setOutreach(ws, 'enabled');
    }
  });
});
