/**
 * The Assistant in the inbox, against the real database: what it reads of a conversation (who it's with, which of
 * their numbers, their other threads, each message by id, a call in the thread, a handover's why and note, and the
 * earlier messages page by page), the inbox's own boxes and filters (Spam, Unread, one page after another), the call
 * log with each call's ids, and who is waiting. Then what it sends: a reply in a website chat, a text held for quiet
 * hours or sent anyway, with a video link or reply buttons, an email copied to someone, and a HandsFreeOS video call.
 * Every change shows its card first, changes nothing until Confirm, and then runs the command as the person.
 */
import { randomUUID } from 'node:crypto';
import {
  aiTeammateCreate,
  aiTeammateSetStatus,
  assistantToolByName,
  executeCommand,
  formatClock,
  localMinutes,
  organizationCreate,
  personCreate,
  phoneUpdateSettings,
  videoCallAppPath,
  type AssistantCard,
  type CommandDef,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { ToolContext } from '../src/assistant/runtime';
import { allScreenReadTools } from '../src/assistant/tools-screen-reads';
import { createToolExecutor } from '../src/assistant/tools-write';

const CHI = 'America/Chicago';
/** The web app's address, which a customer's links are written out on. */
const WEB = 'https://app.handsfree.test';
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: { sub: u.id, email: u.email, role: 'authenticated', aud: 'authenticated' },
});
const run = async <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
): Promise<z.output<O>> =>
  (
    await executeCommand(api(), cmd, input, actor(u), {
      correlationId: randomUUID(),
      channel: 'test',
    })
  ).output;

let dale: TestUser;
let workspaceId: string;
let organizationId: string;
let dana: string;
let lee: string;
let ann: string;
/** Dana's texts, her email and her website chat; Lee's texts and Messenger; a stranger's email in Spam. */
let danaText: string;
let danaMail: string;
let danaChat: string;
let leeText: string;
let leeMessenger: string;
let spam: string;
let firstWords: string;
let lastWords: string;
let call: string;

const ctx = (): ToolContext => ({
  actor: actor(dale),
  workspaceId,
  organizationId,
  correlationId: randomUUID(),
  timezone: CHI,
});
const tools = () => createToolExecutor(api(), null, null, WEB);
const tool = (name: string) => assistantToolByName.get(name)!;
/** The arguments as the runtime hands them over: checked against the tool's input, defaults filled. */
const argsOf = (name: string, args: Record<string, unknown>) =>
  tool(name).input.parse(args) as Record<string, unknown>;
type Confirm = Extract<AssistantCard, { type: 'confirm' }>;
const prepare = async (name: string, args: Record<string, unknown>) =>
  (await tools().prepare(tool(name), argsOf(name, args), ctx(), randomUUID())) as {
    card: Confirm;
    result: Record<string, unknown>;
  };
const commit = (name: string, args: Record<string, unknown>) =>
  tools().commit(tool(name), argsOf(name, args), ctx(), { toolCallId: randomUUID() });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = async (name: string, args: Record<string, unknown>): Promise<any> =>
  ((await tools().run(tool(name), argsOf(name, args), ctx())) as { result: unknown }).result;
const field = (card: { fields: { label: string; value: string }[] }, label: string) =>
  card.fields.find((f) => f.label === label)?.value;
const one = async <T extends Record<string, unknown>>(query: ReturnType<typeof sql>) =>
  (await rows<T>(admin(), query))[0]!;
const ids = (list: { id: string }[]) => list.map((c) => c.id);

async function insertConversation(c: {
  channel: 'sms' | 'email' | 'chat' | 'messenger';
  counterpart: string;
  personId: string | null;
  unread?: number;
  folder?: 'inbox' | 'spam';
  ago: string;
}): Promise<string> {
  return (
    await one<{ id: string }>(
      sql`insert into app.conversations (workspace_id, channel, counterpart, person_id, status, unread_count,
            folder, last_message_at)
          values (${workspaceId}, ${c.channel}, ${c.counterpart}, ${c.personId}, 'open', ${c.unread ?? 0},
            ${c.folder ?? 'inbox'}::app.conversation_folder, now() - ${c.ago}::interval)
          returning id`,
    )
  ).id;
}
async function insertMessage(
  conversationId: string,
  m: { direction: 'inbound' | 'outbound'; status: string; body: string; ago: string },
): Promise<string> {
  return (
    await one<{ id: string }>(
      sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text, occurred_at)
          values (${workspaceId}, ${conversationId}, 'sms', ${m.direction}, ${m.status}, ${m.body},
            now() - ${m.ago}::interval)
          returning id`,
    )
  ).id;
}
const lastMessage = (conversationId: string) =>
  one<{ body_text: string; status: string; error_code: string | null }>(
    sql`select body_text, status::text as status, error_code from app.messages
        where conversation_id = ${conversationId} and direction = 'outbound'
        order by created_at desc limit 1`,
  );
/** The newest email that went to a customer, in whichever of their threads it went. */
const lastEmailTo = (personId: string) =>
  one<{ cc: string[] }>(
    sql`select m.cc_addresses as cc from app.messages m join app.conversations c on c.id = m.conversation_id
        where c.person_id = ${personId} and m.channel = 'email' and m.direction = 'outbound'
        order by m.created_at desc limit 1`,
  );

beforeAll(async () => {
  dale = await createTestUser('ainbox-dale', { fullName: 'Dale Owner' });
  const org = await run(
    organizationCreate,
    { businessName: `Inbox HVAC ${randomUUID().slice(0, 8)}`, timezone: CHI },
    dale,
  );
  workspaceId = org.workspaceId;
  organizationId = org.organizationId;
  const person = async (firstName: string, lastName: string, more: Record<string, string>) =>
    (await run(personCreate, { workspaceId, firstName, lastName, ...more }, dale)).personId;
  dana = await person('Dana', 'Park', { phone: '512-555-0142', email: 'dana@park.test' });
  lee = await person('Lee', 'Wong', { phone: '512-555-0150' });
  ann = await person('Ann', 'Lee', { email: 'ann@lee.test' });

  danaText = await insertConversation({
    channel: 'sms',
    counterpart: '+15125550142',
    personId: dana,
    unread: 1,
    ago: '1 hour',
  });
  call = (
    await one<{ id: string }>(
      sql`insert into app.calls (workspace_id, conversation_id, person_id, direction, from_e164, to_e164, status,
            started_at)
          values (${workspaceId}, ${danaText}, ${dana}, 'inbound', '+15125550142', '+15125550000', 'completed',
            now() - interval '5 hours')
          returning id`,
    )
  ).id;
  firstWords = await insertMessage(danaText, {
    direction: 'inbound',
    status: 'received',
    body: 'Is Tuesday still good?',
    ago: '3 hours',
  });
  await insertMessage(danaText, {
    direction: 'outbound',
    status: 'sent',
    body: 'Yes, 9am.',
    ago: '2 hours',
  });
  lastWords = await insertMessage(danaText, {
    direction: 'inbound',
    status: 'received',
    body: 'Great, thanks',
    ago: '1 hour',
  });
  danaMail = await insertConversation({
    channel: 'email',
    counterpart: 'dana@park.test',
    personId: dana,
    ago: '2 hours',
  });
  danaChat = await insertConversation({
    channel: 'chat',
    counterpart: `chat:${randomUUID()}`,
    personId: dana,
    ago: '3 hours',
  });
  leeText = await insertConversation({
    channel: 'sms',
    counterpart: '+15125550150',
    personId: lee,
    ago: '30 minutes',
  });
  await rows(
    admin(),
    sql`update app.conversations set awaiting_reply_since = now() - interval '30 minutes' where id = ${leeText}`,
  );
  leeMessenger = await insertConversation({
    channel: 'messenger',
    counterpart: 'messenger:1234567:psid42',
    personId: lee,
    ago: '4 hours',
  });
  spam = await insertConversation({
    channel: 'email',
    counterpart: 'deals@prizes.test',
    personId: null,
    unread: 1,
    folder: 'spam',
    ago: '10 minutes',
  });
}, 60_000);
afterAll(closeTestDbs);

describe('reading a conversation', () => {
  it('says who it’s with by id, which of their numbers, their other threads, and each message by id', async () => {
    const out = await read('get_conversation', { conversationId: danaText, limit: 2 });
    expect(out).toMatchObject({
      conversationId: danaText,
      with: 'Dana Park',
      personId: dana,
      counterpart: '(512) 555-0142',
      channel: 'sms',
      status: 'open',
    });
    expect(out.otherLanes.map((l: { conversationId: string }) => l.conversationId).sort()).toEqual(
      [danaMail, danaChat].sort(),
    );
    // The newest two, oldest first, and the way back to the ones before.
    expect(out.messages).toEqual([
      expect.objectContaining({ from: 'the business', text: 'Yes, 9am.', status: 'sent' }),
      expect.objectContaining({
        id: lastWords,
        from: 'customer',
        text: { customer_wrote: 'Great, thanks' },
      }),
    ]);
    expect(out.more).toBe(true);

    const earlier = await read('get_conversation', {
      conversationId: danaText,
      before: out.before,
    });
    expect(earlier.messages).toEqual([
      {
        at: expect.any(String),
        call: expect.objectContaining({
          callId: call,
          direction: 'inbound',
          recorded: false,
          note: 'Nothing was recorded on that call.',
        }),
      },
      expect.objectContaining({
        id: firstWords,
        text: { customer_wrote: 'Is Tuesday still good?' },
      }),
    ]);
    expect(earlier.more).toBeUndefined();
  });

  it('opens their website chat by customer, not only their texts', async () => {
    const out = await read('get_conversation', { personId: dana, channel: 'chat' });
    expect(out.conversationId).toBe(danaChat);
    expect(out.channel).toBe('chat');
  });

  it('says why the AI teammate handed it over, with its note marked as its own words', async () => {
    await rows(
      admin(),
      sql`update app.conversations set handled_by = 'person', needs_person_since = now() - interval '20 minutes',
            handoff_reason = 'asked_for_person', handoff_note = 'Wants to talk to the owner.'
          where id = ${danaText}`,
    );
    try {
      const out = await read('get_conversation', { conversationId: danaText });
      expect(out.handoff).toMatchObject({
        why: expect.any(String),
        note: { ai_teammate_wrote: 'Wants to talk to the owner.' },
        waitingForAPersonSince: expect.any(String),
      });
      const box = await read('find_conversations', { box: 'needs_person' });
      expect(box.conversations).toEqual([
        expect.objectContaining({
          id: danaText,
          handoff: expect.objectContaining({
            note: { ai_teammate_wrote: 'Wants to talk to the owner.' },
          }),
        }),
      ]);
    } finally {
      await rows(
        admin(),
        sql`update app.conversations set handled_by = 'none', needs_person_since = null, handoff_reason = null,
              handoff_note = null
            where id = ${danaText}`,
      );
    }
  });
});

describe('the inbox’s boxes and filters', () => {
  it('lists a customer once, with which of their numbers and their other threads', async () => {
    const out = await read('find_conversations', {});
    expect(ids(out.conversations)).toEqual([leeText, danaText]);
    expect(out.conversations[1]).toMatchObject({
      with: 'Dana Park',
      personId: dana,
      counterpart: '(512) 555-0142',
      unread: 1,
    });
    expect(
      out.conversations[1].otherLanes.map((l: { conversationId: string }) => l.conversationId),
    ).toEqual(expect.arrayContaining([danaMail, danaChat]));
    // A stranger's mail in Spam stays out of the Inbox.
    expect(ids(out.conversations)).not.toContain(spam);
  });

  it('finds Spam, only the unread, and one page after another', async () => {
    const box = await read('find_conversations', { box: 'spam' });
    expect(box.conversations).toEqual([
      expect.objectContaining({ id: spam, folder: 'Spam', personId: null }),
    ]);
    const unread = await read('find_conversations', { unread: true });
    expect(ids(unread.conversations)).toEqual([danaText]);

    const first = await read('find_conversations', { limit: 1 });
    expect(ids(first.conversations)).toEqual([leeText]);
    expect(first.cursor).toEqual(expect.any(String));
    const next = await read('find_conversations', { limit: 1, cursor: first.cursor });
    expect(ids(next.conversations)).toEqual([danaText]);
  });

  it('lists who is waiting for a reply', async () => {
    const out = await read('list_inbox', { waitingOnly: true });
    expect(ids(out.conversations)).toEqual([leeText]);
    expect(out.conversations[0].waitingMinutes).toBeGreaterThanOrEqual(29);
    expect(out.more).toBeUndefined();
  });

  it('gives each call’s ids and where it lives, and says when nothing was recorded', async () => {
    const out = await read('recent_calls', {});
    expect(out.calls).toEqual([
      expect.objectContaining({
        callId: call,
        conversationId: danaText,
        personId: dana,
        note: 'Nothing was recorded on that call.',
        href: `/app/w/${workspaceId}/inbox/${danaText}`,
      }),
    ]);
  });
});

describe('replying where the customer wrote', () => {
  it('replies in a website chat only after Confirm, as the person', async () => {
    const args = { conversationId: danaChat, body: 'Yes, we can come Tuesday.' };
    const { card } = await prepare('reply_in_conversation', args);
    expect(card.title).toBe('Reply to Dana in the chat?');
    expect(field(card, 'To')).toBe('Dana Park · Website chat');
    expect(card.confirmLabel).toBe('Send reply');
    expect(card.warnings).toEqual([{ kind: 'caution', text: 'It reaches Dana now.' }]);
    expect(
      await rows(admin(), sql`select id from app.messages where conversation_id = ${danaChat}`),
    ).toEqual([]);

    const done = await commit('reply_in_conversation', args);
    expect(done).toMatchObject({
      outcome: 'Replied to Dana Park in the chat',
      command: 'message.send',
      href: `/app/w/${workspaceId}/inbox/${danaChat}`,
    });
    const sent = await one<{ body_text: string; channel: string; sent_by: string | null }>(
      sql`select body_text, channel::text as channel, sent_by from app.messages where conversation_id = ${danaChat}`,
    );
    expect(sent).toEqual({
      body_text: 'Yes, we can come Tuesday.',
      channel: 'chat',
      sent_by: dale.id,
    });
  });

  it('points a text thread to send_text, and send_text in a chat to a reply there', async () => {
    await expect(
      prepare('reply_in_conversation', { conversationId: danaText, body: 'Hi' }),
    ).rejects.toThrow('Write with send_text and this conversationId instead.');
    const { card, result } = await prepare('send_text', { conversationId: danaChat, body: 'Hi' });
    expect(card.confirmLabel).toBe('');
    expect(card.warnings[0]).toEqual({
      kind: 'blocked',
      text: 'That conversation is a website chat, so a reply goes in the chat, not by text.',
    });
    expect(result['next']).toBe('Reply with reply_in_conversation and this conversationId.');
  });

  it('says on the card when a Messenger thread can’t take a reply, and that the AI teammate can’t answer it', async () => {
    const { card } = await prepare('reply_in_conversation', {
      conversationId: leeMessenger,
      body: 'Hi Lee',
    });
    expect(card.title).toBe('Reply to Lee on Messenger?');
    expect(card.confirmLabel).toBe('');
    expect(card.warnings[0]?.kind).toBe('blocked');

    const { teammateId } = await run(
      aiTeammateCreate,
      { workspaceId, preset: 'lead_responder', name: 'Ava' },
      dale,
    );
    await run(aiTeammateSetStatus, { workspaceId, teammateId, status: 'training' }, dale);
    const hand = await prepare('manage_conversation', {
      action: 'hand_to_ai',
      conversationId: leeMessenger,
    });
    expect(hand.card.confirmLabel).toBe('');
    expect(hand.card.warnings[0]).toEqual({
      kind: 'blocked',
      text: 'Ava can’t answer Messenger messages yet, so someone on the team has to.',
    });
  });
});

describe('texting and emailing', () => {
  it('emails with a copy to someone else, and won’t send from an address it can’t', async () => {
    const args = {
      personId: dana,
      subject: 'Your estimate',
      body: 'It’s attached.',
      cc: ['office@park.test'],
    };
    const { card } = await prepare('send_email', args);
    expect(field(card, 'Cc')).toBe('office@park.test');
    await commit('send_email', args);
    expect((await lastEmailTo(dana)).cc).toEqual(['office@park.test']);
    await expect(prepare('send_email', { ...args, from: 'nobody@else.test' })).rejects.toThrow(
      'This email can’t go from nobody@else.test.',
    );
  });

  it('holds a text for quiet hours or sends it anyway, with buttons or a video link, as the person says', async () => {
    const [before] = await rows<{ settings: unknown }>(
      admin(),
      sql`select settings from app.workspaces where id = ${workspaceId}`,
    );
    // A number that may text, and quiet hours from an hour ago to an hour from now.
    const [account] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.telephony_accounts (workspace_id, provider, account_sid, status)
          values (${workspaceId}, 'fake', ${`ACinbox${randomUUID().slice(0, 8)}`}, 'active') returning id`,
    );
    const [number] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.phone_numbers (workspace_id, account_id, provider_sid, e164, number_type, status)
          values (${workspaceId}, ${account!.id}, ${`PNinbox${randomUUID().slice(0, 8)}`},
            ${`+1833${String((Date.now() + 7) % 10_000_000).padStart(7, '0')}`}, 'toll_free', 'active')
          returning id`,
    );
    await rows(
      admin(),
      sql`insert into app.telephony_registrations (workspace_id, account_id, phone_number_id, kind, status, provider_sid, approved_at)
          values (${workspaceId}, ${account!.id}, ${number!.id}, 'toll_free_verification', 'approved',
            ${`HHinbox${randomUUID().slice(0, 8)}`}, now())`,
    );
    const hhmm = (m: number) => {
      const x = ((m % 1440) + 1440) % 1440;
      return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
    };
    const local = localMinutes(new Date(), CHI);
    const end = hhmm(local + 60);
    await run(
      phoneUpdateSettings,
      { workspaceId, quietHours: { enabled: true, start: hhmm(local - 60), end } },
      dale,
    );
    try {
      // Held until they end, unless the person says to send it now.
      const later = { conversationId: danaText, body: 'See you Tuesday at 9.' };
      const held = await prepare('send_text', later);
      expect(held.card.confirmLabel).toBe(`Send at ${formatClock(end)}`);
      expect(field(held.card, 'Goes')).toBe(`When quiet hours end, at ${formatClock(end)}`);
      expect(held.card.warnings[0]?.kind).toBe('quiet_hours');
      const done = await commit('send_text', later);
      expect(done.outcome).toMatch(/^Held for Dana Park until quiet hours end: it goes /);
      expect(await lastMessage(danaText)).toMatchObject({
        body_text: 'See you Tuesday at 9.',
        error_code: 'scheduled',
      });

      const now = {
        conversationId: danaText,
        body: 'Can you make it?',
        whenQuiet: 'send_anyway',
        rich: {
          kind: 'buttons',
          buttons: [
            { type: 'reply', title: 'Yes' },
            { type: 'reply', title: 'No' },
          ],
        },
      };
      const anyway = await prepare('send_text', now);
      expect(anyway.card.confirmLabel).toBe('Send anyway');
      expect(field(anyway.card, 'Goes')).toBe('Now, in quiet hours');
      expect(field(anyway.card, 'Buttons')).toBe('Yes · No');
      expect((await commit('send_text', now)).outcome).toBe('Sent to Dana Park');
      const went = await lastMessage(danaText);
      expect(went.body_text).toMatch(/^Can you make it\?/);
      expect(went.error_code).toBeNull();

      // A video link goes on its own line under the words, as a whole link on the business's address.
      const video = {
        conversationId: danaText,
        body: 'Send us a video of the noise.',
        whenQuiet: 'send_anyway',
        askForVideo: true,
      };
      const asked = await prepare('send_text', video);
      expect(field(asked.card, 'Adds')).toBe('A link for them to send you a video');
      await commit('send_text', video);
      expect((await lastMessage(danaText)).body_text).toMatch(
        /^Send us a video of the noise\.\nhttps:\/\/app\.handsfree\.test\/v\/\S+$/,
      );
    } finally {
      await rows(
        admin(),
        sql`update app.workspaces set settings = ${JSON.stringify(before!.settings)}::jsonb
            where id = ${workspaceId}`,
      );
      await rows(
        admin(),
        sql`update app.phone_numbers set status = 'releasing' where id = ${number!.id}`,
      );
    }
  });
});

describe('a HandsFreeOS video call', () => {
  it('says why it can’t start while calls are off, then starts one on Confirm, sending their link', async () => {
    const off = await prepare('start_video_call', { personId: ann });
    expect(off.card.confirmLabel).toBe('');
    expect(off.card.warnings[0]?.kind).toBe('blocked');
    expect(off.card.warnings[0]?.text).toContain('video calls aren’t on for this business yet');

    await rows(
      admin(),
      sql`update app.workspaces set video_calls = true where id = ${workspaceId}`,
    );
    const { card } = await prepare('start_video_call', { personId: ann });
    expect(card.title).toBe('Start a video call with Ann?');
    expect(field(card, 'Their link goes')).toBe('By email to ann@lee.test');
    expect(card.confirmLabel).toBe('Start the call');
    expect(card.warnings).toEqual([
      { kind: 'caution', text: 'Ann gets their own link now, from you. Only they get it.' },
    ]);
    expect(
      await rows(admin(), sql`select id from app.video_calls where person_id = ${ann}`),
    ).toEqual([]);

    const done = await commit('start_video_call', { personId: ann });
    const { id, host_user_id, conversation_id } = await one<{
      id: string;
      host_user_id: string;
      conversation_id: string;
    }>(sql`select id, host_user_id, conversation_id from app.video_calls where person_id = ${ann}`);
    expect(host_user_id).toBe(dale.id);
    expect(done).toMatchObject({
      outcome: 'Ann Lee’s link is on its way by email. Open the call from here to join it.',
      href: videoCallAppPath(workspaceId, id),
      command: 'video_call.start',
      answer: { callId: id, conversationId: conversation_id, join: `${WEB}/call/${id}` },
    });
    // Their own link went to them alone, on the business's address.
    expect((await lastMessage(conversation_id)).body_text).toContain(`${WEB}/j/`);
    // The call's page, read as the screen reads it, gives the team's own way in.
    const screen = allScreenReadTools().find((t) => t.name === 'read_video_call_get')!;
    const got = await tools().run(screen, screen.input.parse({ callId: id }), ctx());
    expect((got.result as { data: { join: string } }).data.join).toBe(`${WEB}/call/${id}`);
  });
});
