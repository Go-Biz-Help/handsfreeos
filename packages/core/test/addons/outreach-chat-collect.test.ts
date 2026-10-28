/**
 * Social Outreach: chats read in Messenger, without Facebook's file (docs/outreach.md, decision 2's "Collect from
 * Facebook"). A chat comes in with its latest messages and the chat's number, waiting for the AI when they wrote;
 * the same chat read again with nothing new changes nothing, and newer messages wait again. A chat from the file and
 * from Messenger with the same person is one chat. Older messages scrolled up to fill in without a new read.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mergeRecent } from '../../src/addons/outreach/chat-collect';
import { outreachBusiness, refused, runAs } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();
const them = (text: string, at: string) => ({ fromMe: false, text, at });
const me = (text: string, at: string) => ({ fromMe: true, text, at });

let owner: TestUser;
let ws: string;

beforeAll(async () => {
  owner = await createTestUser('outcc-owner', { fullName: 'Pat Owner' });
  ws = await outreachBusiness(owner, 'Outreach Collect Co');
}, 60_000);
afterAll(closeTestDbs);

const collect = (chats: Record<string, unknown>[]) =>
  runAs(owner, ws, 'outreach.chats.collect', { chats }) as Promise<{
    saved: number;
    waiting: number;
  }>;
const chatOf = async (name: string) =>
  (
    await rows<{
      read_state: string;
      recent: { text: string }[];
      thread_key: string | null;
      import_id: string | null;
      profile_id: string | null;
      messages: number;
      last_from_me: boolean;
    }>(
      admin(),
      sql`select read_state, recent, thread_key, import_id, profile_id, messages, last_from_me
          from addon_outreach.file_chats where workspace_id = ${ws} and name = ${name}`,
    )
  )[0];

describe('keeping the latest few', () => {
  it('puts what was kept and what was read in order, each once', () => {
    const a = me('Hi', '2026-09-01T10:00:00.000Z');
    const b = them('Hey', '2026-09-01T10:00:00.000Z');
    const c = them('Demo?', '2026-09-02T10:00:00.000Z');
    expect(mergeRecent([a, b], [b, c])).toEqual([a, b, c]);
    expect(mergeRecent([c], [a])).toEqual([a, c]);
  });
});

describe('chats read in Messenger', () => {
  const avery = {
    name: 'Avery Lane',
    thread: { id: '1000123', encrypted: false },
    profile: { id: null, username: 'avery.lane.5', url: 'https://www.facebook.com/avery.lane.5' },
    messages: [me('How’s the shop?', daysAgo(3)), them('Busy! Want a demo?', daysAgo(2))],
  };

  it('keeps a chat for the AI, with its number and who it’s with', async () => {
    expect(await collect([avery])).toEqual({ saved: 1, waiting: 1 });
    const c = await chatOf('Avery Lane');
    expect(c).toMatchObject({
      read_state: 'waiting',
      thread_key: '1000123',
      import_id: null,
      messages: 2,
      last_from_me: false,
    });
    expect(c!.profile_id).not.toBeNull();
    // Nobody is added to Contacts by reading.
    const [people] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.people where workspace_id = ${ws}`,
    );
    expect(people!.n).toBe(0);
  });

  it('reads nothing twice, and newer messages wait again', async () => {
    await runAs(owner, ws, 'outreach.chats.collect', { chats: [avery] });
    await rows(
      admin(),
      sql`update addon_outreach.file_chats set read_state = 'read' where workspace_id = ${ws}`,
    );
    expect(await collect([avery])).toEqual({ saved: 0, waiting: 0 });
    expect((await chatOf('Avery Lane'))!.read_state).toBe('read');

    // Scrolled up: an older message fills in, and the read stands.
    expect(await collect([{ ...avery, messages: [me('Hello again', daysAgo(5))] }])).toEqual({
      saved: 1,
      waiting: 0,
    });
    const older = await chatOf('Avery Lane');
    expect(older!.read_state).toBe('read');
    expect(older!.recent.map((m) => m.text)).toEqual([
      'Hello again',
      'How’s the shop?',
      'Busy! Want a demo?',
    ]);

    // A new message from them is read again.
    expect(
      await collect([{ ...avery, messages: [...avery.messages, them('How much?', daysAgo(1))] }]),
    ).toEqual({ saved: 1, waiting: 1 });
    expect((await chatOf('Avery Lane'))!.read_state).toBe('waiting');
  });

  it('joins the same person’s chat from the file', async () => {
    await runAs(owner, ws, 'outreach.download.save', {
      madeAt: daysAgo(10),
      last: true,
      chats: [
        {
          name: 'Quinn Harper',
          firstAt: daysAgo(400),
          lastAt: daysAgo(20),
          messages: 240,
          lastFromMe: true,
          recent: [me('See you then', daysAgo(20))],
        },
      ],
    });
    await collect([
      {
        name: 'Quinn Harper',
        thread: { id: '1000456', encrypted: true },
        profile: null,
        messages: [them('Are you around?', daysAgo(1))],
      },
    ]);
    const q = await chatOf('Quinn Harper');
    expect(q).toMatchObject({ read_state: 'waiting', thread_key: '1000456', messages: 240 });
    expect(q!.import_id).not.toBeNull();
    expect(q!.recent.map((m) => m.text)).toEqual(['See you then', 'Are you around?']);
  });

  describe('two people with the same name', () => {
    const chatsOf = (name: string) =>
      rows<{ thread_key: string | null; profile_id: string | null; recent: { text: string }[] }>(
        admin(),
        sql`select thread_key, profile_id, recent from addon_outreach.file_chats
            where workspace_id = ${ws} and name = ${name} order by created_at`,
      );
    const jordan = (n: number, thread: string, text: string) => ({
      name: 'Jordan Reyes',
      thread: { id: thread, encrypted: false },
      profile: {
        id: null,
        username: `jordan.reyes.${n}`,
        url: `https://www.facebook.com/jordan.reyes.${n}`,
      },
      messages: [them(text, daysAgo(2))],
    });

    it('keeps each one’s chat apart, by their own profiles', async () => {
      await collect([jordan(1, '2000111', 'Hi from the first')]);
      await collect([jordan(2, '2000222', 'Hi from the second')]);
      // Each read again lands on their own chat, never the other's.
      await collect([
        { ...jordan(1, '2000111', 'More from the first'), messages: [them('More', daysAgo(1))] },
      ]);
      const both = await chatsOf('Jordan Reyes');
      expect(both).toHaveLength(2);
      expect(both.map((c) => c.thread_key)).toEqual(['2000111', '2000222']);
      expect(both[0]!.profile_id).not.toBe(both[1]!.profile_id);
      expect(both[0]!.recent.map((m) => m.text)).toEqual(['Hi from the first', 'More']);
      expect(both[1]!.recent.map((m) => m.text)).toEqual(['Hi from the second']);
    });

    it('tells them apart by their chats when no profile shows', async () => {
      const casey = (thread: string, text: string, at = daysAgo(2)) => ({
        name: 'Casey Moore',
        thread: { id: thread, encrypted: false },
        profile: null,
        messages: [them(text, at)],
      });
      const said = daysAgo(3);
      await collect([casey('3000111', 'One Casey', said)]);
      await collect([casey('3000222', 'Another Casey')]);
      expect(await chatsOf('Casey Moore')).toHaveLength(2);
      // The first one's chat under a new number (it was encrypted) still shows their messages: it's them.
      await collect([
        {
          ...casey('3000999', 'One Casey', said),
          thread: { id: '3000999', encrypted: true },
          messages: [them('One Casey', said), them('Still me', daysAgo(1))],
        },
      ]);
      const two = await chatsOf('Casey Moore');
      expect(two).toHaveLength(2);
      expect(two[0]).toMatchObject({ thread_key: '3000999' });
      expect(two[0]!.recent.map((m) => m.text)).toEqual(['One Casey', 'Still me']);
      expect(two[1]!.recent.map((m) => m.text)).toEqual(['Another Casey']);
    });

    it('keeps the profile their chat named when the file comes in', async () => {
      // The file names Jordan Reyes once; two saved profiles share that name, so the name alone matches nobody.
      await runAs(owner, ws, 'outreach.download.save', {
        madeAt: daysAgo(1),
        last: true,
        chats: [
          {
            name: 'Jordan Reyes',
            firstAt: daysAgo(300),
            lastAt: daysAgo(30),
            messages: 12,
            lastFromMe: true,
            recent: [me('Long time', daysAgo(30))],
          },
        ],
      });
      const both = await chatsOf('Jordan Reyes');
      expect(both).toHaveLength(2);
      expect(both.every((c) => c.profile_id !== null)).toBe(true);
    });
  });

  it('refuses messages from after today', async () => {
    const tomorrow = new Date(Date.now() + 3 * DAY).toISOString();
    expect(
      await refused(
        collect([{ ...avery, name: 'Sam Lee', messages: [them('Hi from the future', tomorrow)] }]),
      ),
    ).toBe('outreach_chat_dates');
  });
});
