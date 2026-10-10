/**
 * Social Outreach: Save to their card (`outreach.chat.keep`, docs/outreach.md "A chat saves to"). A chat brought in
 * on the Chats tab (read in Messenger, or from Facebook's file) is copied onto the customer's Social card, with each
 * message's own time, so the activity counts a reply on its day. Nobody in Contacts yet: the person picks who, or
 * says to add them. Saved again, only what's new is added; a chat from the file that's read in Messenger later stays
 * one chat on the card. Each person's chats are their own: a teammate can't put someone else's on a card. A reply counts
 * from when outreach to them began, not from an old exchange the chat also holds.
 */
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outreachBusiness, refused, runAs } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();
const them = (text: string, at: string) => ({ fromMe: false, text, at });
const me = (text: string, at: string) => ({ fromMe: true, text, at });

let owner: TestUser;
let riley: TestUser;
let ws: string;

type Kept = {
  personId: string;
  personName: string;
  threadId: string;
  addedPerson: boolean;
  added: number;
  kept: number;
};
type Social = {
  profiles: { id: string }[];
  chats: {
    id: string;
    url: string;
    ownerName: string | null;
    messages: { from: string; text: string; when: string | null; savedAt: string }[];
  }[];
};
type ChatsList = {
  chats: {
    chatId: string;
    name: string;
    personId: string | null;
    profileId: string | null;
    onCard: boolean;
  }[];
};

const keep = (chatId: string, more: Record<string, unknown> = {}, who: TestUser = owner) =>
  runAs(who, ws, 'outreach.chat.keep', { chatId, ...more }) as Promise<Kept>;
const listed = async () =>
  Object.fromEntries(
    ((await runAs(owner, ws, 'outreach.chats', { view: 'waiting' })) as ChatsList).chats.map(
      (c) => [c.name, c],
    ),
  );
const chatId = async (name: string) =>
  (
    await rows<{ id: string }>(
      admin(),
      sql`select id from addon_outreach.file_chats where workspace_id = ${ws} and name = ${name}`,
    )
  )[0]!.id;

const avery = {
  name: 'Avery Lane',
  thread: { id: '2000123', encrypted: false },
  profile: { id: null, username: 'avery.lane.7', url: 'https://www.facebook.com/avery.lane.7' },
  messages: [me('How’s the shop?', daysAgo(3)), them('Busy! Want a demo?', daysAgo(2))],
};

beforeAll(async () => {
  owner = await createTestUser('outkeep-owner', { fullName: 'Morgan Owner' });
  riley = await createTestUser('outkeep-riley', { fullName: 'Riley Member' });
  ws = await outreachBusiness(owner, 'Outreach Keep Co');
  await admin()
    .insert(workspaceMemberships)
    .values([{ workspaceId: ws, userId: riley.id, role: 'member' }]);
  await runAs(owner, ws, 'outreach.chats.collect', {
    chats: [
      avery,
      {
        name: 'Quinn Harper',
        thread: { id: '2000456', encrypted: true },
        profile: null,
        messages: [them('Are you around Saturday?', daysAgo(1))],
      },
    ],
  });
}, 60_000);
afterAll(closeTestDbs);

describe('Save to their card', () => {
  it('asks who they are when nobody in Contacts is them yet', async () => {
    expect(await refused(keep(await chatId('Avery Lane')))).toBe('outreach_chat_who');
    const [n] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from addon_outreach.threads where workspace_id = ${ws}`,
    );
    expect(n!.n).toBe(0);
  });

  it('adds them when asked, and puts the chat on their card with each message’s own time', async () => {
    const id = await chatId('Avery Lane');
    const kept = await keep(id, { add: true });
    expect(kept).toMatchObject({ personName: 'Avery Lane', addedPerson: true, added: 2, kept: 2 });

    const social = (await runAs(owner, ws, 'outreach.person', {
      personId: kept.personId,
    })) as Social;
    // Their profile is tied to them too.
    expect(social.profiles).toHaveLength(1);
    expect(social.chats).toHaveLength(1);
    const chat = social.chats[0]!;
    expect(chat.url).toBe('https://www.facebook.com/messages/t/2000123');
    expect(chat.ownerName).toBe('Morgan Owner');
    expect(chat.messages.map((m) => [m.from, m.text])).toEqual([
      ['me', 'How’s the shop?'],
      ['them', 'Busy! Want a demo?'],
    ]);
    expect(chat.messages.map((m) => m.savedAt)).toEqual(avery.messages.map((m) => m.at));
    expect(chat.messages[0]!.when).toMatch(/\d{4}/);

    // The Chats tab shows it in Contacts and on their card, and who it's with.
    const row = (await listed())['Avery Lane']!;
    expect(row).toMatchObject({ personId: kept.personId, onCard: true });
    expect(row.profileId).not.toBeNull();

    // A line on their timeline.
    const [line] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.events
          where workspace_id = ${ws} and event_type = 'outreach.chat.saved' and entity_id = ${kept.personId}`,
    );
    expect(line!.n).toBe(1);
  });

  it('adds only what’s new when saved again', async () => {
    const id = await chatId('Avery Lane');
    expect(await keep(id)).toMatchObject({ addedPerson: false, added: 0, kept: 2 });
    await runAs(owner, ws, 'outreach.chats.collect', {
      chats: [{ ...avery, messages: [...avery.messages, them('How much is it?', daysAgo(1))] }],
    });
    expect(await keep(id)).toMatchObject({ added: 1, kept: 3 });
  });

  it('ties a chat to the customer picked', async () => {
    const quinn = (await runAs(owner, ws, 'person.create', {
      firstName: 'Quinn',
      lastName: 'Harper',
    })) as { personId: string };
    const kept = await keep(await chatId('Quinn Harper'), { personId: quinn.personId });
    expect(kept).toMatchObject({ personId: quinn.personId, addedPerson: false, added: 1 });
    expect((await listed())['Quinn Harper']).toMatchObject({
      personId: quinn.personId,
      profileId: null,
      onCard: true,
    });
  });

  it('keeps a chat from the file one chat when it’s read in Messenger later', async () => {
    const answered = daysAgo(20);
    await runAs(owner, ws, 'outreach.download.save', {
      madeAt: daysAgo(1),
      last: true,
      chats: [
        {
          name: 'Jordan Blake',
          firstAt: daysAgo(30),
          lastAt: answered,
          messages: 2,
          lastFromMe: false,
          recent: [me('Hi Jordan', daysAgo(30)), them('Hey! Tell me more', answered)],
        },
        {
          name: 'Drew Kim',
          firstAt: daysAgo(60),
          lastAt: daysAgo(60),
          messages: 1,
          lastFromMe: true,
          recent: [],
        },
      ],
    });
    const id = await chatId('Jordan Blake');
    const first = await keep(id, { add: true });
    expect(first).toMatchObject({ addedPerson: true, added: 2 });
    const [before] = await rows<{ thread_key: string }>(
      admin(),
      sql`select thread_key from addon_outreach.threads where id = ${first.threadId}`,
    );
    expect(before!.thread_key).toBe(`file.${id}`);

    await runAs(owner, ws, 'outreach.chats.collect', {
      chats: [
        {
          name: 'Jordan Blake',
          thread: { id: '2000789', encrypted: false },
          profile: null,
          messages: [them('Hey! Tell me more', answered), them('Still there?', daysAgo(1))],
        },
      ],
    });
    const again = await keep(id);
    expect(again).toMatchObject({ threadId: first.threadId, personId: first.personId, added: 1 });
    const [after] = await rows<{ thread_key: string; url: string }>(
      admin(),
      sql`select thread_key, url from addon_outreach.threads where id = ${first.threadId}`,
    );
    expect(after).toEqual({
      thread_key: '2000789',
      url: 'https://www.facebook.com/messages/t/2000789',
    });

    // A chat from the file with no messages kept has nothing to save.
    expect(await refused(keep(await chatId('Drew Kim'), { add: true }))).toBe(
      'outreach_chat_nothing_to_keep',
    );
  });

  it('counts a reply on the activity only when it came after the outreach, however old the chat', async () => {
    // Years of chat before any outreach, then a message noted an hour ago and their answer after it.
    const parker = {
      name: 'Parker Reed',
      thread: { id: '2000999', encrypted: false },
      profile: {
        id: null,
        username: 'parker.reed.5',
        url: 'https://www.facebook.com/parker.reed.5',
      },
    };
    const touched = Date.now() - 60 * 60 * 1000;
    const at = (ms: number) => new Date(ms).toISOString();
    await runAs(
      owner,
      ws,
      'outreach.touch.save',
      { kind: 'message', profile: parker.profile, name: parker.name, threadKey: parker.thread.id },
      new Date(touched),
    );
    const answered = at(touched + 30 * 60 * 1000);
    await runAs(owner, ws, 'outreach.chats.collect', {
      chats: [
        {
          ...parker,
          messages: [
            me('Happy birthday!', daysAgo(700)),
            them('Thanks!!', daysAgo(699)),
            me('Hi Parker, saw your post about the shop.', at(touched + 1000)),
            them('Sounds good, tell me more', answered),
          ],
        },
      ],
    });
    await keep(await chatId('Parker Reed'), { add: true });

    const week = (await runAs(owner, ws, 'outreach.activity', { period: 'week' })) as {
      numbers: { replies: number };
      people: { name: string; repliedAt: string | null }[];
    };
    expect(week.numbers.replies).toBe(1);
    expect(week.people.find((p) => p.name === 'Parker Reed')?.repliedAt).toBe(answered);
  });

  it('is the person’s own: a teammate can’t put it on a card', async () => {
    expect(await refused(keep(await chatId('Avery Lane'), { add: true }, riley))).toBe('not_found');
  });
});
