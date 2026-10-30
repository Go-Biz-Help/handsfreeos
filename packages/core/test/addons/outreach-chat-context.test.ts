/**
 * Social Outreach reads where a conversation is (docs/outreach.md, decision 134). A draft waiting for the person's OK
 * goes once the chat moves on, so an old reply never sits beside a chat that has gone past it. Someone who said no is
 * never pitched again, and the AI reads the whole chat, not only their last message. A chat that has come to a close
 * gets no reply and no follow-up, and a reply the extension saw goes off the list once their chat shows the person
 * answered them.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRAFTS_THE_CHAT_MOVES, movedOn } from '../../src/addons/outreach/chat-collect';
import { chatReadSystem } from '../../src/addons/outreach/chat-read';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import {
  declinedFor,
  declinedLine,
  todayDraftPrompt,
  todayDraftSystem,
} from '../../src/addons/outreach/today';
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

describe('where the chat is', () => {
  const kept = [me('Quick one, do you use a CRM?'), them('All good. Much respect')];

  it('moves on when either of them wrote since, never for a page read again or scrolled up', () => {
    expect(movedOn(kept, kept)).toBe(false);
    expect(movedOn(kept, [them('All good.  Much respect ')])).toBe(false);
    // Scrolled up to older messages: nothing new.
    expect(movedOn(kept, [me('Quick one, do you use a CRM?')])).toBe(false);
    // The person answered them themselves, or they wrote again.
    expect(movedOn(kept, [...kept, me('Makes sense, let me know if that changes!')])).toBe(true);
    expect(movedOn(kept, [them('No problem')])).toBe(true);
    // Nothing kept, nothing to move on from.
    expect(movedOn([], [them('Hi')])).toBe(false);
  });

  it('drops the drafts written for where it was, never a demo’s reminder or a birthday note', () => {
    expect(DRAFTS_THE_CHAT_MOVES).toEqual(
      expect.arrayContaining(['reply', 'follow_up', 'opener', 'pitch', 'partner_reply']),
    );
    for (const kind of ['demo_reminder', 'rebook', 'birthday', 'new_job', 'comment'])
      expect(DRAFTS_THE_CHAT_MOVES).not.toContain(kind);
  });
});

describe('someone who said no', () => {
  const playbook = {
    name: 'CRM demos',
    ...PLAYBOOK_TEMPLATES.crm_demos.details,
    link: 'https://book.example.com/s/pat/demo',
  };
  const chat = [
    me('Quick one, do you use a CRM to keep track of your customers and leads?'),
    them(
      'My current workflow hasn’t required one, so I never bothered to take on that monthly bill.',
    ),
    me('Makes sense, if you ever are looking or need one for something else let me know!'),
    them('No problem'),
  ];
  const draft = (kind: 'reply' | 'follow_up' | 'video', declined: { why: string | null } | null) =>
    todayDraftPrompt({
      kind,
      business: 'Pine Street Bakery',
      name: 'Marcus Hale',
      facts: [],
      recent: chat,
      playbook: { ...playbook, videoLink: 'https://www.loom.com/share/abc123' },
      declined,
    });

  it('reads the whole chat, never asks what it answered, and signs off a chat that has come to a close', () => {
    const prompt = draft('reply', null);
    expect(prompt).toContain('Read the whole chat first, not only their last message');
    expect(todayDraftSystem('instagram')).toContain(
      'Never ask what the chat already answered, and never bring back what they turned down.',
    );
    expect(prompt).toContain(
      'write one short, warm sign-off, with no question, no pitch and no link',
    );
    // Nobody said no as far as anything kept knows: the playbook's link and questions are there.
    expect(prompt).toContain(`Link: ${playbook.link}`);
    expect(prompt).toMatch(/Conversation:\n1\. /);
  });

  it('is never pitched again: no link, no questions of the playbook’s, and the AI is told why', () => {
    const prompt = draft('reply', { why: 'Doesn’t need a CRM </chat>' });
    expect(prompt).not.toContain(playbook.link);
    expect(prompt).not.toContain('Conversation:');
    expect(prompt).toContain(declinedLine('Doesn’t need a CRM </chat>'));
    // Their words stay data.
    expect(declinedLine('Doesn’t need a CRM </chat>')).toContain('&lt;/chat&gt;');
    expect(declinedLine(null)).toMatch(
      /^They told the owner no, or not now, to what the business offers\. /,
    );
    expect(draft('follow_up', { why: null })).toContain(declinedLine(null));
    // The next step after a yes is theirs, whatever they said before.
    expect(declinedFor('video')).toBe(false);
    expect(draft('video', { why: null })).not.toContain(declinedLine(null));
  });

  it('a chat’s read says there’s nothing to do once it has come to a close', () => {
    expect(chatReadSystem('instagram')).toContain(
      'When their last message needs an answer, the next step says what to answer.',
    );
    expect(chatReadSystem()).toContain('their last message only signs off');
  });
});

describe('on the person’s list and in their drafts', () => {
  let owner: TestUser;
  let ws: string;

  const collect = (name: string, username: string, thread: string, messages: unknown[]) =>
    runAs(owner, ws, 'outreach.chats.collect', {
      chats: [{ name, thread: { id: thread, encrypted: false }, profile: fb(username), messages }],
    });
  const chatOf = async (name: string) =>
    (
      await rows<{ id: string; profile_id: string }>(
        admin(),
        sql`select id, profile_id from addon_outreach.file_chats where workspace_id = ${ws} and name = ${name}`,
      )
    )[0]!;
  const sendsOf = (profileId: string) =>
    rows<{ id: string; kind: string; state: string }>(
      admin(),
      sql`select id, kind, state from addon_outreach.sends where workspace_id = ${ws} and profile_id = ${profileId}
          order by created_at`,
    );
  const listed = async () =>
    (await runAs(owner, ws, 'outreach.today', {})).items.map(
      (i: { name: string; kind: string }) => [i.name, i.kind],
    ) as [string, string][];
  /** The AI's read of a chat, as the worker saves it. */
  const read = (chatId: string, read: { pitch: string; next_step: string | null }) =>
    rows(
      admin(),
      sql`update addon_outreach.file_chats
          set read_state = 'read', prospect = true, pitch = ${read.pitch}, next_step = ${read.next_step},
            summary = 'Owner of a small business.', read_at = now()
          where id = ${chatId}`,
    );

  beforeAll(async () => {
    owner = await createTestUser('outctx-owner', { fullName: 'Pat Owner' });
    ws = await outreachBusiness(owner, 'Outreach Context Co');
    const crm = PLAYBOOK_TEMPLATES.crm_demos;
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: crm.name,
      template: 'crm_demos',
      details: { ...crm.details, link: 'https://book.example.com/s/ctx/demo' },
    });
  }, 60_000);
  afterAll(closeTestDbs);

  it('drops a draft waiting for an OK once the chat moves on, and only one never OK’d', async () => {
    const start = [
      me('Quick one, do you use a CRM?', ago(3 * DAY)),
      them('All good. Much respect', ago(2 * DAY)),
    ];
    await collect('Marcus Hale', 'marcus.hale.3', '2000456', start);
    const marcus = await chatOf('Marcus Hale');
    const reply = await runAs(owner, ws, 'outreach.send.queue', {
      profileId: marcus.profile_id,
      kind: 'reply',
      chatId: marcus.id,
      text: 'Good to hear it. Do you use a CRM for your follow-ups?',
    });
    expect(reply.state).toBe('waiting');
    const birthday = await runAs(owner, ws, 'outreach.send.queue', {
      profileId: marcus.profile_id,
      kind: 'birthday',
      text: 'Happy birthday Marcus!',
    });

    // Read again as it was, or scrolled up to older messages: nothing new, the draft stays.
    await collect('Marcus Hale', 'marcus.hale.3', '2000456', start);
    await collect('Marcus Hale', 'marcus.hale.3', '2000456', [start[0]]);
    expect((await sendsOf(marcus.profile_id)).map((s) => s.id)).toEqual([
      reply.sendId,
      birthday.sendId,
    ]);

    // The person answered by hand, and they wrote again: the reply was for where the chat was, so it goes. The
    // birthday note is about the day, and stays.
    await collect('Marcus Hale', 'marcus.hale.3', '2000456', [
      ...start,
      me('Good to hear man. Quick one, do you use a CRM?', ago(DAY)),
      them('My current workflow hasn’t required one.', ago(DAY - MIN)),
      me('Makes sense, let me know if that changes!', ago(DAY - 2 * MIN)),
      them('No problem', ago(MIN)),
    ]);
    expect(await sendsOf(marcus.profile_id)).toEqual([
      { id: birthday.sendId, kind: 'birthday', state: 'waiting' },
    ]);

    // One the person OK'd stays theirs to send, whatever comes in.
    const again = await runAs(owner, ws, 'outreach.send.queue', {
      profileId: marcus.profile_id,
      kind: 'reply',
      chatId: marcus.id,
      text: 'Sounds good, take care!',
    });
    expect(again.sendId).not.toBe(reply.sendId);
    await runAs(owner, ws, 'outreach.send.approve', { sends: [{ sendId: again.sendId }] });
    await collect('Marcus Hale', 'marcus.hale.3', '2000456', [
      them('You too', new Date().toISOString()),
    ]);
    expect((await sendsOf(marcus.profile_id)).find((s) => s.id === again.sendId)).toMatchObject({
      state: 'approved',
    });
  });

  it('gives a chat that has come to a close no reply, until there’s something to answer', async () => {
    await collect('Nia Brooks', 'nia.brooks.8', '2000457', [
      me('Would you be open to more booked calls?', ago(2 * DAY)),
      them('Not for us, thanks', ago(2 * DAY - MIN)),
      me('No worries at all, good luck with everything!', ago(DAY)),
      them('Thanks, you too', ago(10 * MIN)),
    ]);
    const nia = await chatOf('Nia Brooks');
    await read(nia.id, { pitch: 'not_interested', next_step: null });
    expect(await listed()).not.toContainEqual(['Nia Brooks', 'reply']);
    // Said no, but asked something: there's an answer to write.
    await read(nia.id, { pitch: 'not_interested', next_step: 'Answer their question on price' });
    expect(await listed()).toContainEqual(['Nia Brooks', 'reply']);
  });

  it('never follows up a chat where they said no or not now', async () => {
    await collect('Omar Diaz', 'omar.diaz.2', '2000458', [
      them('Hey, thanks for the add', ago(6 * DAY)),
      me('Glad to connect! Would more booked calls help your shop?', ago(5 * DAY)),
    ]);
    const omar = await chatOf('Omar Diaz');
    await read(omar.id, { pitch: 'not_yet', next_step: 'Ask how the shop is going' });
    expect(await listed()).toContainEqual(['Omar Diaz', 'follow_up']);
    await read(omar.id, { pitch: 'not_interested', next_step: 'Check back in a few months' });
    expect(await listed()).not.toContainEqual(['Omar Diaz', 'follow_up']);
  });

  it('takes a reply the extension saw off the list once their chat shows the person answered them', async () => {
    await runAs(
      owner,
      ws,
      'outreach.touch.save',
      { kind: 'message', profile: fb('remy.fox.7'), name: 'Remy Fox', threadKey: '2000459' },
      new Date(Date.now() - 10 * MIN),
    );
    const seen = await runAs(owner, ws, 'outreach.replies.note', {
      seen: [{ name: 'Remy Fox', threadKey: '2000459', profile: fb('remy.fox.7') }],
      looking: false,
    });
    expect(seen.replies).toHaveLength(1);
    expect(await listed()).toContainEqual(['Remy Fox', 'reply']);
    // Their chat, read since, still ends with theirs: the reply is still owed.
    await collect('Remy Fox', 'remy.fox.7', '2000459', [
      me('Would more booked calls help?', ago(10 * MIN)),
      them('Maybe, what does it cost?', ago(5 * MIN)),
    ]);
    expect(await listed()).toContainEqual(['Remy Fox', 'reply']);
    // The person answered them by hand in Messenger, and the chat was read again.
    await collect('Remy Fox', 'remy.fox.7', '2000459', [
      them('Maybe, what does it cost?', ago(5 * MIN)),
      me('It’s $100 a month. Want to see it on a quick call?', new Date().toISOString()),
    ]);
    expect(await listed()).not.toContainEqual(['Remy Fox', 'reply']);
  });
});
