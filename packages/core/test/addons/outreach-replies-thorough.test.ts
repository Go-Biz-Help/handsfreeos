/**
 * Every reply to the person's outreach is caught (docs/outreach.md, decision 150): a newer message of theirs is news
 * again, at most once every quarter hour; a Facebook chat in the list is theirs by the chat number a chat read kept, or
 * by the one name; someone who writes after a friend or connection request or a comment counts as after a message; a
 * reply a chat read found buzzes the phone like the extension's; a reply drafted from a sighting keeps the chat it
 * answers; and Today drafts a reply in any chat the person's outreach started, not only a likely prospect's.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NEWER_QUIET_MS, REPLY_STARTS } from '../../src/addons/outreach/alerts';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { outreachBusiness, runAs } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const MIN = 60_000;
const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const them = (text: string, at = ago(MIN)) => ({ fromMe: false, text, at });
const me = (text: string, at = ago(MIN)) => ({ fromMe: true, text, at });
const fb = (username: string) => ({
  id: null,
  username,
  url: `https://www.facebook.com/${username}`,
});

afterAll(closeTestDbs);

describe('the steps a reply answers', () => {
  it('are a message, a friend or connection request, and a comment; never a like', () => {
    expect([...REPLY_STARTS]).toEqual(['message', 'friend_request', 'comment']);
    expect(NEWER_QUIET_MS).toBe(15 * MIN);
  });
});

describe('every reply, in a business', () => {
  let owner: TestUser;
  let ws: string;

  const touch = (kind: string, username: string, name: string, msAgo: number, threadKey?: string) =>
    runAs(
      owner,
      ws,
      'outreach.touch.save',
      { kind, profile: fb(username), name, ...(threadKey ? { threadKey } : {}) },
      new Date(Date.now() - msAgo),
    );
  const seen = (s: Record<string, unknown>, looking = false) =>
    runAs(owner, ws, 'outreach.replies.note', {
      seen: [{ profile: null, threadKey: null, ...s }],
      looking,
    }) as Promise<{ replies: { profileId: string; name: string }[] }>;
  const collect = (name: string, username: string | null, thread: string, messages: unknown[]) =>
    runAs(owner, ws, 'outreach.chats.collect', {
      chats: [
        {
          name,
          thread: { id: thread, encrypted: false },
          profile: username ? fb(username) : null,
          messages,
        },
      ],
    }) as Promise<{ saved: number; waiting: number; replied?: string[] }>;
  const profileOf = async (username: string) =>
    (
      await rows<{ id: string }>(
        admin(),
        sql`select id from addon_outreach.profiles where workspace_id = ${ws} and username = ${username}`,
      )
    )[0]!.id;
  const pushes = async (profileId: string) =>
    (
      await rows<{ payload: { profileIds: string[]; push: boolean } }>(
        admin(),
        sql`select payload from app.events where workspace_id = ${ws} and event_type = 'outreach.reply.seen'
            order by created_at`,
      )
    ).filter((e) => e.payload.profileIds.includes(profileId));
  const kept = async (profileId: string) =>
    (
      await rows<{ n: number }>(
        admin(),
        sql`select count(*)::int as n from addon_outreach.replies where profile_id = ${profileId}`,
      )
    )[0]!.n;
  const listed = async () =>
    (await runAs(owner, ws, 'outreach.today', {})).items as {
      name: string;
      kind: string;
      why: string[];
    }[];

  beforeAll(async () => {
    owner = await createTestUser('outrt-owner', { fullName: 'Pat Owner' });
    ws = await outreachBusiness(owner, 'Outreach Replies Co');
    const crm = PLAYBOOK_TEMPLATES.crm_demos;
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: crm.name,
      template: 'crm_demos',
      details: { ...crm.details, link: 'https://book.example.com/s/rt/demo' },
    });
  }, 60_000);

  it('a newer message of theirs counts again, buzzing once a quarter hour, and its waiting draft goes', async () => {
    await touch('message', 'dana.reyes.20', 'Dana Reyes', 30 * MIN, '4000101');
    const dana = await profileOf('dana.reyes.20');
    const chat = { name: 'Dana Reyes', threadKey: '4000101' };
    expect((await seen(chat)).replies).toEqual([{ profileId: dana, name: 'Dana Reyes' }]);
    // The same chat again, nothing newer on the computer: no news.
    expect((await seen(chat)).replies).toEqual([]);
    // A newer message, but nothing drafted for them yet: nothing to do inside the quiet time.
    expect((await seen({ ...chat, newer: true })).replies).toEqual([]);
    // Drafted, then they wrote again: the draft was for where the chat was, so it goes, to be written again.
    const draft = await runAs(owner, ws, 'outreach.send.queue', {
      profileId: dana,
      kind: 'reply',
      text: 'Thanks Dana! Want to see it on a quick call?',
    });
    expect(draft.state).toBe('waiting');
    expect((await seen({ ...chat, newer: true })).replies).toEqual([
      { profileId: dana, name: 'Dana Reyes' },
    ]);
    expect(
      await rows(admin(), sql`select id from addon_outreach.sends where id = ${draft.sendId}`),
    ).toEqual([]);
    // Still one buzz, one reply kept.
    expect(await pushes(dana)).toHaveLength(1);
    expect(await kept(dana)).toBe(1);
    // A quarter hour on, a newer message is a reply of its own, and buzzes.
    await rows(
      admin(),
      sql`update addon_outreach.replies set seen_at = now() - interval '16 minutes' where profile_id = ${dana}`,
    );
    expect((await seen({ ...chat, newer: true })).replies).toHaveLength(1);
    expect(await kept(dana)).toBe(2);
    expect((await pushes(dana)).map((e) => e.payload.push)).toEqual([true, true]);
  });

  it('a Facebook chat in the list is theirs by the number a chat read kept, else by the one name', async () => {
    // Messaged from their profile's Message button: the chat's number wasn't on the page.
    await touch('message', 'lee.park.21', 'Lee Park', 30 * MIN);
    const lee = await profileOf('lee.park.21');
    await collect('Lee Park', 'lee.park.21', '4000201', [me('Hi Lee, quick one', ago(30 * MIN))]);
    // The list shows a name the chat doesn't go by: the number says who.
    expect((await seen({ name: 'Lee P', threadKey: '4000201' })).replies).toEqual([
      { profileId: lee, name: 'Lee Park' },
    ]);

    // No number known for Jo: by name, as only one person reached here goes by it.
    await touch('message', 'jo.banks.22', 'Jo Banks', 30 * MIN);
    const jo = await profileOf('jo.banks.22');
    // A number that's someone else's chat here is never Jo's by name.
    await collect('Ana Ruiz', 'ana.ruiz.23', '4000202', [them('Hey there', ago(3 * DAY))]);
    expect((await seen({ name: 'Jo Banks', threadKey: '4000202' })).replies).toEqual([]);
    expect((await seen({ name: 'jo  banks', threadKey: '4000203' })).replies).toEqual([
      { profileId: jo, name: 'Jo Banks' },
    ]);

    // Two people reached go by the one name: neither is known to be the one.
    await touch('message', 'kim.lane.24', 'Kim Lane', 30 * MIN);
    await touch('message', 'kim.lane.25', 'Kim Lane', 30 * MIN);
    expect((await seen({ name: 'Kim Lane', threadKey: '4000204' })).replies).toEqual([]);
  });

  it('someone who writes after a friend request counts, but not for a message of theirs from before it', async () => {
    await touch('friend_request', 'max.cole.26', 'Max Cole', 60 * MIN);
    const max = await profileOf('max.cole.26');
    expect((await seen({ name: 'Max Cole', profile: fb('max.cole.26') })).replies).toEqual([
      { profileId: max, name: 'Max Cole' },
    ]);
    expect(await listed()).toContainEqual(
      expect.objectContaining({ name: 'Max Cole', kind: 'reply' }),
    );

    // Rae wrote days before the request, and their chat, read since, still ends with it.
    await collect('Rae Kim', 'rae.kim.27', '4000301', [them('Hi! Saw your post', ago(3 * DAY))]);
    await touch('friend_request', 'rae.kim.27', 'Rae Kim', 60 * MIN);
    expect((await seen({ name: 'Rae Kim', profile: fb('rae.kim.27') })).replies).toEqual([]);
    // A like starts no conversation.
    await touch('like', 'sky.moss.28', 'Sky Moss', 60 * MIN);
    expect((await seen({ name: 'Sky Moss', profile: fb('sky.moss.28') })).replies).toEqual([]);
  });

  it('a reply a chat read found buzzes the phone and is drafted next, once', async () => {
    await touch('message', 'zoe.hart.29', 'Zoe Hart', 60 * MIN, '4000401');
    const zoe = await profileOf('zoe.hart.29');
    const messages = [
      me('Quick one, do you use a CRM?', ago(60 * MIN)),
      them('Sounds good', ago(5 * MIN)),
    ];
    expect((await collect('Zoe Hart', 'zoe.hart.29', '4000401', messages)).replied).toEqual([zoe]);
    expect((await pushes(zoe)).map((e) => e.payload.push)).toEqual([true]);
    // Read again, nothing newer: no news.
    expect((await collect('Zoe Hart', 'zoe.hart.29', '4000401', messages)).replied).toEqual([]);
    // The extension's sighting of the same message: no news either.
    expect((await seen({ name: 'Zoe Hart', threadKey: '4000401' })).replies).toEqual([]);
    expect(await kept(zoe)).toBe(1);

    // The reply drafted from it, listed by the sighting with no chat, keeps their chat: what they wrote is known.
    const draft = await runAs(owner, ws, 'outreach.send.queue', {
      profileId: zoe,
      kind: 'reply',
      text: 'Great! Want to see it on a quick call this week?',
    });
    const [row] = await rows<{ chat_id: string | null; needs_you: string | null }>(
      admin(),
      sql`select chat_id, needs_you from addon_outreach.sends where id = ${draft.sendId}`,
    );
    const [chat] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_outreach.file_chats where workspace_id = ${ws} and profile_id = ${zoe}`,
    );
    expect(row).toEqual({ chat_id: chat!.id, needs_you: null });
  });

  it('Today drafts a reply in a chat the person’s outreach started, never in a personal one', async () => {
    const read = (name: string) =>
      rows(
        admin(),
        sql`update addon_outreach.file_chats set read_state = 'read', prospect = false, read_at = now()
            where workspace_id = ${ws} and name = ${name}`,
      );
    // A connection request two days ago; they wrote since. Not read as a likely prospect.
    await touch('friend_request', 'uma.reed.30', 'Uma Reed', 2 * DAY);
    const uma = await profileOf('uma.reed.30');
    await collect('Uma Reed', 'uma.reed.30', '4000501', [
      them('Thanks for the add! What do you do?', ago(20 * MIN)),
    ]);
    await read('Uma Reed');
    // From their chat alone, not the reply kept for it.
    await rows(admin(), sql`delete from addon_outreach.replies where profile_id = ${uma}`);
    // A friend's chat the outreach never touched.
    await collect('Bo Lin', 'bo.lin.31', '4000502', [them('Dinner Sunday?', ago(20 * MIN))]);
    await read('Bo Lin');
    const items = await listed();
    expect(items).toContainEqual(
      expect.objectContaining({
        name: 'Uma Reed',
        kind: 'reply',
        why: [expect.stringMatching(/^They wrote/)],
      }),
    );
    expect(items.map((i) => i.name)).not.toContain('Bo Lin');
  });
});
