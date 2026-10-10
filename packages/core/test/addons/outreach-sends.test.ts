/**
 * Social Outreach: messages the extension sends on its own (docs/outreach.md, decisions 26 and 27, and training
 * wheels). Each drafted one waits for the person's OK, or goes as it is with Sending (b) once training wheels are off;
 * a reply follows Replies, never goes to someone who needs the person, and one that waits after all is handed over.
 * Training wheels start with Sending (b) or Replies (b) or (c), halve the daily limits, come off after 7 days and 25
 * OK'd with few changes, end early for an owner or admin, and go back on with a warning from Facebook.
 */
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUTOMATION_DEFAULTS,
  NO_WHEELS,
  wheelsEarned,
  wheelsMatter,
  wheelsState,
  wheelsWords,
} from '../../src/addons/outreach/automation';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import {
  changed,
  goesAsItIs,
  handedOver,
  handOverPushWords,
  replyNeedsYou,
} from '../../src/addons/outreach/sends';
import { outreachBusiness, refused, runAs } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();
const fb = (username: string) => ({
  id: null,
  username,
  url: `https://www.facebook.com/${username}`,
});

describe('training wheels', () => {
  const now = Date.UTC(2026, 9, 10, 15);
  const from = new Date(now - 8 * DAY);

  it('come off after 7 days and 25 OK’d, with no more than 3 of the last 10 changed', () => {
    expect(wheelsEarned(NO_WHEELS, now)).toBe(false);
    const kept = { from, ok: 25, edits: [true, true, true, false], doneAt: null };
    expect(wheelsEarned(kept, now)).toBe(true);
    expect(wheelsEarned({ ...kept, ok: 24 }, now)).toBe(false);
    expect(wheelsEarned({ ...kept, from: new Date(now - 6 * DAY) }, now)).toBe(false);
    expect(wheelsEarned({ ...kept, edits: [true, true, true, true] }, now)).toBe(false);
    // Only the last 10 count.
    expect(wheelsEarned({ ...kept, edits: [true, true, ...Array(10).fill(false)] }, now)).toBe(
      true,
    );
  });

  it('say what’s left, and matter only with messages on their own', () => {
    const state = wheelsState(
      { from: new Date(now - 2 * DAY), ok: 20, edits: [true, true, true, true], doneAt: null },
      now,
    );
    expect(state).toMatchObject({ on: true, ok: 20, daysLeft: 5, edits: 4 });
    expect(wheelsWords(state)).toBe(
      'Training wheels: every message waits for your OK, and your daily limits are half. Still: 5 more messages to OK, 5 days to go, fewer changes: you changed 4 of the last 10.',
    );
    expect(wheelsState({ ...NO_WHEELS, from }, now, false).on).toBe(false);
    expect(wheelsState({ ...NO_WHEELS, from, doneAt: new Date(now) }, now).on).toBe(false);
  });

  it('decide what goes without waiting', () => {
    const o = {
      sending: 'everything',
      replies: 'draft',
      wheels: false,
      kind: 'opener',
      simple: false,
      needsYou: null,
    } as const;
    expect(goesAsItIs(o)).toBe(true);
    expect(goesAsItIs({ ...o, wheels: true })).toBe(false);
    expect(goesAsItIs({ ...o, kind: 'reply' })).toBe(false);
    expect(goesAsItIs({ ...o, sending: 'approve_all', kind: 'follow_up' })).toBe(false);
    // Replies (b): the simple ones; (c): all; never to someone who needs the person, nor on training wheels.
    const reply = { ...o, sending: 'steps', kind: 'reply' } as const;
    expect(goesAsItIs({ ...reply, replies: 'simple' })).toBe(false);
    expect(goesAsItIs({ ...reply, replies: 'simple', simple: true })).toBe(true);
    expect(goesAsItIs({ ...reply, replies: 'everything' })).toBe(true);
    expect(goesAsItIs({ ...reply, replies: 'everything', needsYou: 'they asked for you' })).toBe(
      false,
    );
    expect(goesAsItIs({ ...reply, replies: 'everything', wheels: true })).toBe(false);
    expect(goesAsItIs({ ...reply, replies: 'everything', sending: 'off' })).toBe(false);
    // One that waits after all is handed over, but not with (a), nor on training wheels.
    const waits = {
      sending: 'steps',
      replies: 'simple',
      wheels: false,
      kind: 'reply',
      goes: false,
    } as const;
    expect(handedOver(waits)).toBe(true);
    expect(handedOver({ ...waits, replies: 'draft' })).toBe(false);
    expect(handedOver({ ...waits, wheels: true })).toBe(false);
    expect(handedOver({ ...waits, goes: true })).toBe(false);
    expect(handedOver({ ...waits, kind: 'opener' })).toBe(false);
    expect(wheelsMatter({ sending: 'steps', replies: 'simple' })).toBe(true);
    expect(wheelsMatter({ sending: 'off', replies: 'everything' })).toBe(false);
    expect(wheelsMatter({ sending: 'approve_all', replies: 'draft' })).toBe(false);
    expect(changed('Hi Dana!\n How are you?', ' Hi Dana! How are you?')).toBe(false);
    expect(changed('Hi Dana!', 'Hey Dana!')).toBe(true);
  });

  it('know a reply that needs the person, as the AI teammate does', () => {
    expect(replyNeedsYou('Thanks so much, talk soon!')).toBeNull();
    expect(replyNeedsYou(null)).toBeNull();
    expect(replyNeedsYou('Can I get my money back?')).toBe('it’s about a refund');
    expect(replyNeedsYou('Can I talk to a real person?')).toBe('they asked for you');
    expect(replyNeedsYou('This is ridiculous, nobody is answering')).toBe('they sound upset');
    expect(replyNeedsYou('Please stop messaging me')).toBe('they asked you to stop messaging them');
    expect(handOverPushWords('Dana Cole', 'they asked for you')).toEqual({
      title: 'Dana Cole needs you',
      body: 'Their reply waits for your OK in Waiting for you: they asked for you.',
    });
    expect(handOverPushWords('Dana Cole', null).body).toBe(
      'Their reply waits for your OK in Waiting for you: it isn’t a simple one.',
    );
  });
});

describe('messages on their own', () => {
  let owner: TestUser;
  let member: TestUser;
  let ws: string;
  const group = {
    id: '423456789',
    slug: null,
    url: 'https://www.facebook.com/groups/423456789/',
    name: 'Denver Trades Owners',
  };
  const person = (username: string, name: string, lines: string[]) => ({
    profile: fb(username),
    name,
    lines,
    part: 'Members near you',
    runsGroup: false,
  });
  const profileOf = async (username: string) => {
    const [p] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_outreach.profiles where workspace_id = ${ws} and username = ${username}`,
    );
    return p!.id;
  };
  /** They accepted the person's friend request two days ago: a first message is on the list. */
  const accepted = async (u: TestUser, username: string, name: string) => {
    await runAs(u, ws, 'outreach.touch.save', {
      kind: 'friend_request',
      profile: fb(username),
      name,
      at: daysAgo(3),
    });
    await rows(
      admin(),
      sql`insert into addon_outreach.friends (workspace_id, user_id, profile_id, state, since, seen_at)
          select ${ws}, ${u.id}, p.id, 'friends', ${daysAgo(2)}::timestamptz, now()
          from addon_outreach.profiles p where p.workspace_id = ${ws} and p.username = ${username}
          on conflict (workspace_id, user_id, profile_id) do update set state = 'friends', since = excluded.since`,
    );
    return profileOf(username);
  };
  const today = () => runAs(owner, ws, 'outreach.today', {});
  const openerOf = async (name: string) =>
    (await today()).items.find(
      (i: { kind: string; name: string }) => i.kind === 'opener' && i.name === name,
    );
  const automation = (u: TestUser, sending: string, replies = 'draft') =>
    runAs(u, ws, 'outreach.automation.save', {
      settings: { ...AUTOMATION_DEFAULTS, sending, replies },
    });
  const opener = () => ({
    playbookId: playbookId,
    kind: 'style',
    text: 'Ask how they keep track of customers.',
  });
  let playbookId: string;

  beforeAll(async () => {
    [owner, member] = await Promise.all([
      createTestUser('outs-owner', { fullName: 'Morgan Owner' }),
      createTestUser('outs-member', { fullName: 'Riley Member' }),
    ]);
    ws = await outreachBusiness(owner, 'Outreach Sends Co');
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: member.id, role: 'member' });
    const crm = PLAYBOOK_TEMPLATES.crm_demos;
    const saved = await runAs(owner, ws, 'outreach.playbook.save', {
      name: crm.name,
      template: 'crm_demos',
      details: crm.details,
    });
    playbookId = saved.playbookId ?? saved.id;
    await runAs(owner, ws, 'outreach.group.save', {
      group,
      members: 9_100,
      adminsPage: true,
      people: [
        person('dana.cole.4', 'Dana Cole', ['Owner at Cole Plumbing']),
        person('eli.brook.2', 'Eli Brook', ['Founder of Brook HVAC']),
        person('fern.ash.9', 'Fern Ash', ['Owner at Ash Roofing']),
        person('gray.lund.3', 'Gray Lund', ['Owner at Lund Electric']),
      ],
    });
  }, 60_000);
  afterAll(closeTestDbs);

  it('waits for one tap with (a), and goes once it’s sent', async () => {
    await automation(owner, 'steps');
    const dana = await accepted(owner, 'dana.cole.4', 'Dana Cole');
    expect((await today()).messages).toEqual(['opener', 'follow_up', 'reply']);
    expect((await openerOf('Dana Cole')).send).toBeNull();

    const queued = await runAs(owner, ws, 'outreach.send.queue', {
      profileId: dana,
      kind: 'opener',
      text: 'Hi Dana! How do you keep track of customers?',
      opener: opener(),
    });
    expect(queued).toMatchObject({ state: 'waiting', name: 'Dana Cole', kind: 'opener' });
    // Drafted again: the one waiting comes back.
    const again = await runAs(owner, ws, 'outreach.send.queue', {
      profileId: dana,
      kind: 'opener',
      text: 'Something else',
    });
    expect(again.sendId).toBe(queued.sendId);
    expect((await openerOf('Dana Cole')).send).toEqual({
      sendId: queued.sendId,
      state: 'waiting',
      text: 'Hi Dana! How do you keep track of customers?',
      handedOver: false,
      needsYou: null,
    });
    expect((await runAs(owner, ws, 'outreach.sends', {})).sends).toHaveLength(1);

    // Someone else's isn't theirs to OK, and only an OK'd one is sent.
    expect(
      await refused(
        runAs(member, ws, 'outreach.send.approve', { sends: [{ sendId: queued.sendId }] }),
      ),
    ).toBe('not_found');
    expect(
      await refused(runAs(owner, ws, 'outreach.send.done', { sendId: queued.sendId, sent: true })),
    ).toBe('not_found');

    const ok = await runAs(owner, ws, 'outreach.send.approve', {
      sends: [{ sendId: queued.sendId, text: 'Hey Dana! How do you keep track of customers?' }],
    });
    expect(ok.approved).toEqual([queued.sendId]);
    expect(ok.wheels.on).toBe(false);
    expect((await openerOf('Dana Cole')).send).toMatchObject({
      state: 'approved',
      text: 'Hey Dana! How do you keep track of customers?',
    });

    // The extension sends it and notes the message: Dana is off the list, and the opener counts.
    await runAs(owner, ws, 'outreach.touch.save', {
      kind: 'message',
      profile: fb('dana.cole.4'),
      name: 'Dana Cole',
      auto: true,
      at: new Date().toISOString(),
    });
    expect(
      await runAs(owner, ws, 'outreach.send.done', { sendId: queued.sendId, sent: true }),
    ).toEqual({ sendId: queued.sendId, state: 'sent' });
    expect(await openerOf('Dana Cole')).toBeUndefined();
    const [use] = await rows<{ kind: string; text: string }>(
      admin(),
      sql`select kind, text from addon_outreach.opener_uses where workspace_id = ${ws} and profile_id = ${dana}`,
    );
    expect(use).toEqual({ kind: 'style', text: 'Ask how they keep track of customers.' });
    expect((await runAs(owner, ws, 'outreach.sends', {})).sends).toEqual([]);
  });

  it('skipping one takes them off today’s list; one not sent says why', async () => {
    const fern = await accepted(owner, 'fern.ash.9', 'Fern Ash');
    const s = await runAs(owner, ws, 'outreach.send.queue', {
      profileId: fern,
      kind: 'opener',
      text: 'Hi Fern!',
    });
    await runAs(owner, ws, 'outreach.send.skip', { sendId: s.sendId });
    expect(await openerOf('Fern Ash')).toBeUndefined();
    expect(await refused(runAs(owner, ws, 'outreach.send.skip', { sendId: s.sendId }))).toBe(
      'not_found',
    );

    const gray = await accepted(owner, 'gray.lund.3', 'Gray Lund');
    const g = await runAs(owner, ws, 'outreach.send.queue', {
      profileId: gray,
      kind: 'opener',
      text: 'Hi Gray!',
    });
    await runAs(owner, ws, 'outreach.send.approve', {});
    expect(
      await runAs(owner, ws, 'outreach.send.done', {
        sendId: g.sendId,
        sent: false,
        why: 'Messenger didn’t open a chat with them.',
      }),
    ).toMatchObject({ state: 'failed' });
    expect(await openerOf('Gray Lund')).toBeUndefined();
  });

  it('with (b), training wheels start: every message waits, and the limits are half', async () => {
    const before = await today();
    expect(before.wheels.on).toBe(false);
    expect(before.limits.friend_request.most).toBe(20);
    const saved = await automation(owner, 'everything');
    expect(saved.wheels).toMatchObject({ on: true, ok: 0, daysLeft: 7 });
    const after = await today();
    expect(after).toMatchObject({ sending: 'everything', wheels: { on: true } });
    expect(after.limits.friend_request.most).toBe(10);
    expect((await runAs(owner, ws, 'outreach.activity', { period: 'week' })).limits.like).toBe(20);

    const eli = await accepted(owner, 'eli.brook.2', 'Eli Brook');
    const s = await runAs(owner, ws, 'outreach.send.queue', {
      profileId: eli,
      kind: 'opener',
      text: 'Hi Eli!',
    });
    expect(s.state).toBe('waiting');
    // Approve all: it counts, changed or not.
    const ok = await runAs(owner, ws, 'outreach.send.approve', {});
    expect(ok.approved).toEqual([s.sendId]);
    expect(ok.wheels).toMatchObject({ on: true, ok: 1, edits: 0 });
    // Choosing (b) again doesn't start them over.
    await automation(owner, 'steps');
    expect((await today()).wheels.on).toBe(false);
    expect((await automation(owner, 'everything')).wheels).toMatchObject({ on: true, ok: 1 });
    await runAs(owner, ws, 'outreach.send.done', { sendId: s.sendId, sent: true });
  });

  it('come off once earned; then messages go as they are, and replies still wait', async () => {
    await rows(
      admin(),
      sql`update addon_outreach.automation set wheels_from = ${daysAgo(8)}::timestamptz, wheels_ok = 24
          where workspace_id = ${ws} and user_id = ${owner.id}`,
    );
    const dana = await profileOf('dana.cole.4');
    const s = await runAs(owner, ws, 'outreach.send.queue', {
      profileId: dana,
      kind: 'follow_up',
      text: 'Hi Dana, did you get a chance to look?',
    });
    expect(s.state).toBe('waiting');
    const ok = await runAs(owner, ws, 'outreach.send.approve', {
      sends: [{ sendId: s.sendId, text: 'Hi Dana, any thoughts?' }],
    });
    expect(ok.wheels).toMatchObject({ on: false, ok: 25, edits: 1 });
    const [kept] = await rows<{ done: boolean }>(
      admin(),
      sql`select wheels_done_at is not null as done from addon_outreach.automation
          where workspace_id = ${ws} and user_id = ${owner.id}`,
    );
    expect(kept!.done).toBe(true);
    expect((await today()).limits.friend_request.most).toBe(20);
    await runAs(owner, ws, 'outreach.send.done', { sendId: s.sendId, sent: true });

    const eli = await profileOf('eli.brook.2');
    expect(
      (
        await runAs(owner, ws, 'outreach.send.queue', {
          profileId: eli,
          kind: 'follow_up',
          text: 'Hi Eli, how’s it going?',
        })
      ).state,
    ).toBe('approved');
    expect(
      (
        await runAs(owner, ws, 'outreach.send.queue', {
          profileId: eli,
          kind: 'reply',
          text: 'Thanks Eli!',
        })
      ).state,
    ).toBe('waiting');
  });

  it('a warning from Facebook puts them back on for 7 days', async () => {
    await runAs(owner, ws, 'outreach.warning.note', {
      words: ['You can’t use this feature right now'],
    });
    const { wheels } = await runAs(owner, ws, 'outreach.automation', {});
    expect(wheels).toMatchObject({ on: true, ok: 25, daysLeft: 7 });
  });

  it('owners and admins see who’s on them and can end them early', async () => {
    await automation(member, 'everything');
    const list = await runAs(owner, ws, 'outreach.wheels', {});
    expect(list.people.map((p: { name: string }) => p.name)).toEqual([
      'Morgan Owner',
      'Riley Member',
    ]);
    expect(await refused(runAs(member, ws, 'outreach.wheels.end', { userId: member.id }))).toBe(
      'forbidden',
    );
    expect(await refused(runAs(member, ws, 'outreach.wheels', {}))).toBe('forbidden');
    expect(await runAs(owner, ws, 'outreach.wheels.end', { userId: member.id })).toEqual({
      userId: member.id,
      ended: true,
    });
    expect(await runAs(owner, ws, 'outreach.wheels.end', { userId: member.id })).toMatchObject({
      ended: false,
    });
    expect((await runAs(member, ws, 'outreach.automation', {})).wheels.on).toBe(false);
    expect(
      (await runAs(owner, ws, 'outreach.wheels', {})).people.map((p: { name: string }) => p.name),
    ).toEqual(['Morgan Owner']);
  });
  describe('replies on their own', () => {
    const chat = (username: string, name: string, thread: string, theirs: string) =>
      runAs(member, ws, 'outreach.chats.collect', {
        chats: [
          {
            name,
            thread: { id: thread, encrypted: false },
            profile: fb(username),
            messages: [
              { fromMe: true, text: 'How’s business?', at: daysAgo(2) },
              { fromMe: false, text: theirs, at: daysAgo(1) },
            ],
          },
        ],
      });
    const chatOf = async (name: string) => {
      const [c] = await rows<{ id: string; profile_id: string }>(
        admin(),
        sql`select id, profile_id from addon_outreach.file_chats
            where workspace_id = ${ws} and user_id = ${member.id} and name = ${name}`,
      );
      return c!;
    };
    const reply = (c: { id: string; profile_id: string }, simple: boolean) =>
      runAs(member, ws, 'outreach.send.queue', {
        profileId: c.profile_id,
        kind: 'reply',
        chatId: c.id,
        text: 'Glad to hear it!',
        simple,
      });
    const handOvers = async () =>
      (
        await rows<{ payload: { handOver?: boolean; why?: string | null; userId?: string } }>(
          admin(),
          sql`select payload from app.events where workspace_id = ${ws}
                and event_type = 'outreach.send.queued' and payload ? 'handOver' order by created_at`,
        )
      ).map((e) => e.payload);

    it('with (b), a simple one goes; one that isn’t, or needs the person, is handed over', async () => {
      // Their training wheels were ended above: replies go as chosen.
      const saved = await automation(member, 'steps', 'simple');
      expect(saved.settings.replies).toBe('simple');
      expect(saved.wheels.on).toBe(false);
      await chat('hana.vale.7', 'Hana Vale', '2000111', 'Thanks, things are great!');
      await chat('ivo.reed.1', 'Ivo Reed', '2000222', 'Can I get a refund on the last order?');
      await chat('jo.park.8', 'Jo Park', '2000333', 'What would it cost for my team?');
      const hana = await chatOf('Hana Vale');
      expect((await reply(hana, true)).state).toBe('approved');
      expect((await reply(await chatOf('Ivo Reed'), true)).state).toBe('waiting');
      expect((await reply(await chatOf('Jo Park'), false)).state).toBe('waiting');
      expect(await handOvers()).toEqual([
        expect.objectContaining({ handOver: true, userId: member.id, why: 'it’s about a refund' }),
        expect.objectContaining({ handOver: true, userId: member.id, why: null }),
      ]);
      await runAs(member, ws, 'outreach.send.skip', { sendId: (await reply(hana, true)).sendId });
    });

    it('with (c), every reply goes but to someone who needs the person, or one HandsFreeOS hasn’t seen', async () => {
      await automation(member, 'steps', 'everything');
      await chat('kit.moss.2', 'Kit Moss', '2000444', 'Sounds good, what’s next?');
      await chat('lee.hart.6', 'Lee Hart', '2000555', 'I want to talk to a real person');
      expect((await reply(await chatOf('Kit Moss'), false)).state).toBe('approved');
      expect((await reply(await chatOf('Lee Hart'), true)).state).toBe('waiting');
      const dana = await profileOf('dana.cole.4');
      const unseen = await runAs(member, ws, 'outreach.send.queue', {
        profileId: dana,
        kind: 'reply',
        text: 'Thanks!',
        simple: true,
      });
      expect(unseen.state).toBe('waiting');
      expect((await handOvers()).slice(2).map((p) => p.why)).toEqual([
        'they asked for you',
        'HandsFreeOS hasn’t seen what they wrote',
      ]);
    });

    it('with (a), every reply waits, and nobody is buzzed', async () => {
      await automation(member, 'steps', 'draft');
      await chat('mo.lane.4', 'Mo Lane', '2000666', 'Thanks!');
      expect((await reply(await chatOf('Mo Lane'), true)).state).toBe('waiting');
      expect(await handOvers()).toHaveLength(4);
    });

    it('choosing (b) or (c) starts training wheels, with Sending on', async () => {
      const [fresh] = await Promise.all([createTestUser('outs-fresh', { fullName: 'Sam Fresh' })]);
      await admin()
        .insert(workspaceMemberships)
        .values({ workspaceId: ws, userId: fresh!.id, role: 'member' });
      expect((await automation(fresh!, 'off', 'everything')).wheels.on).toBe(false);
      expect((await automation(fresh!, 'steps', 'everything')).wheels).toMatchObject({
        on: true,
        ok: 0,
      });
    });
  });
});
