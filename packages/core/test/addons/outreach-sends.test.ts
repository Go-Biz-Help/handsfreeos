/**
 * Social Outreach: messages the extension sends on its own (docs/outreach.md, decisions 26 and 27, and training
 * wheels). Each drafted one waits for the person's OK, or goes as it is with Sending (b) once training wheels are off;
 * a reply follows Replies, never goes to someone who needs the person, and one that waits after all is handed over.
 * Training wheels start with Sending (b) or Replies (b) or (c), halve the daily limits, come off after 7 days and 25
 * OK'd with few changes, end early for an owner or admin, and go back on with a warning from Facebook. On Instagram and
 * Alignable a comment on a good post goes the same way (decision 92), waiting under its own hold at first.
 */
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUTOMATION_DEFAULTS,
  NETWORK_CHOICES_DEFAULTS,
  NETWORKS_DEFAULTS,
  NO_WHEELS,
  wheelsEarned,
  wheelsMatter,
  wheelsState,
  wheelsWords,
} from '../../src/addons/outreach/automation';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { LINKEDIN_COMMENTS_WAIT_SINCE } from '../../src/addons/outreach/profile-parts';
import {
  changed,
  COMMENT_HOLD,
  COMMENT_NEEDS_YOU,
  commentHoldOn,
  goesAsItIs,
  handedOver,
  handOverPushWords,
  postStartOf,
  replyNeedsYou,
} from '../../src/addons/outreach/sends';
import { computerOn, outreachBusiness, refused, runAs } from './outreach-fixture';

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

  it('hold a comment till its network has had them a week and the person OK’d 25, never with Sending Off (decision 92)', () => {
    const now = Date.UTC(2026, 9, 27, 15);
    expect(COMMENT_HOLD).toEqual({ days: 7, okd: 25 });
    expect(commentHoldOn({ firstAt: null, okd: 0, now })).toBe(true);
    expect(commentHoldOn({ firstAt: now - 8 * DAY, okd: 25, now })).toBe(false);
    expect(commentHoldOn({ firstAt: now - 8 * DAY, okd: 24, now })).toBe(true);
    expect(commentHoldOn({ firstAt: now - 6 * DAY, okd: 40, now })).toBe(true);
    const comment = {
      sending: 'steps',
      replies: 'draft',
      wheels: false,
      kind: 'comment',
      simple: false,
      needsYou: null,
      held: false,
    } as const;
    // Off the hold, a comment goes with any Sending but Off, as Facebook's comments do.
    expect(goesAsItIs(comment)).toBe(true);
    expect(goesAsItIs({ ...comment, sending: 'approve_all' })).toBe(true);
    expect(goesAsItIs({ ...comment, held: true })).toBe(false);
    expect(goesAsItIs({ ...comment, wheels: true })).toBe(false);
    expect(goesAsItIs({ ...comment, sending: 'off' })).toBe(false);
    expect(goesAsItIs({ ...comment, needsYou: COMMENT_NEEDS_YOU.answer })).toBe(false);
    // Never handed over: that's a reply's.
    expect(handedOver({ ...comment, goes: false })).toBe(false);
    // The post's first words above it, cut short.
    expect(postStartOf('  Short post.  ')).toBe('Short post.');
    expect(postStartOf('word '.repeat(80))).toMatch(/^word word .*…$/);
    expect(postStartOf('word '.repeat(80)).length).toBeLessThanOrEqual(200);
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
      body: 'Their reply waits for your OK on Today: they asked for you.',
    });
    expect(handOverPushWords('Dana Cole', null).body).toBe(
      'Their reply waits for your OK on Today: it isn’t a simple one.',
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
    expect((await today()).messages).toEqual([
      'opener',
      'reconnect',
      'pitch',
      'video',
      'follow_up',
      'check_in',
      'reply',
      // After a demo (decision 106): the reminder the day before, and another time after a no-show.
      'demo_reminder',
      'rebook',
      // A birthday or a new job (decision 108), which always waits for an OK.
      'birthday',
      'new_job',
      // A partner's (decision 81), which always wait for an OK of their own.
      'partner_ask',
      'partner_follow_up',
      'partner_details',
      'partner_reply',
    ]);
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

  it('tries one that didn’t go again with Retry, and Retry all spaces them a few minutes apart (decision 132)', async () => {
    const [gray, fern] = [await profileOf('gray.lund.3'), await profileOf('fern.ash.9')];
    const needOf = async (profileId: string) =>
      (await runAs(owner, ws, 'outreach.waiting', {})).items.find(
        (i: { kind: string; need?: { profileId: string; step: string } }) =>
          i.kind === 'need' && i.need?.profileId === profileId && i.need.step === 'message',
      )?.need;
    const failed = await needOf(gray);
    expect(failed).toMatchObject({ text: 'Hi Gray!' });

    // Someone else can't try the person's again.
    expect(
      await refused(runAs(member, ws, 'outreach.send.retry', { needIds: [failed.needId] })),
    ).toBe('not_found');
    const before = Date.now();
    const one = await runAs(owner, ws, 'outreach.send.retry', { needIds: [failed.needId] });
    expect(one.passed).toBe(0);
    expect(one.retried).toHaveLength(1);
    expect(one.retried[0]).toMatchObject({ needId: failed.needId });
    expect(one.retried[0].sendId).not.toBe(failed.sendId);
    expect(new Date(one.retried[0].at).getTime()).toBeGreaterThanOrEqual(before - 1_000);
    // Off Steps it needs you for, and back on the list OK'd as it was, as a send of its own.
    expect(await needOf(gray)).toBeUndefined();
    expect((await openerOf('Gray Lund')).send).toMatchObject({
      sendId: one.retried[0].sendId,
      state: 'approved',
      text: 'Hi Gray!',
    });
    expect((await today()).retryAt).toBeNull();
    expect(
      await refused(runAs(owner, ws, 'outreach.send.retry', { needIds: [failed.needId] })),
    ).toBe('not_found');

    // It doesn't go again: it's handed back. And another that didn't go, an hour before.
    await runAs(owner, ws, 'outreach.send.done', {
      sendId: one.retried[0].sendId,
      sent: false,
      why: 'Messenger didn’t open a chat with them.',
    });
    const [fernSent] = await rows<{ id: string }>(
      admin(),
      sql`insert into addon_outreach.sends (workspace_id, user_id, profile_id, kind, text, drafted, state, done_at)
          values (${ws}, ${owner.id}, ${fern}, 'opener', 'Hi Fern!', 'Hi Fern!', 'failed', now())
          returning id`,
    );
    await rows(
      admin(),
      sql`insert into addon_outreach.needs (workspace_id, user_id, step, profile_id, send_id, name, why, seen_at)
          values (${ws}, ${owner.id}, 'message', ${fern}, ${fernSent!.id}, 'Fern Ash', 'it didn’t go',
            now() - interval '1 hour')`,
    );
    // A third whose message went since: passed over, and still waiting for the person.
    const [ana] = await rows<{ id: string }>(
      admin(),
      sql`insert into addon_outreach.sends (workspace_id, user_id, profile_id, kind, text, drafted, state, done_at)
          values (${ws}, ${owner.id}, ${fern}, 'follow_up', 'Hi again, Fern!', 'Hi again, Fern!', 'sent', now())
          returning id`,
    );
    await rows(
      admin(),
      sql`insert into addon_outreach.needs (workspace_id, user_id, step, profile_id, send_id, name, why, seen_at)
          values (${ws}, ${owner.id}, 'comment', ${fern}, ${ana!.id}, 'Fern Ash', 'it didn’t go', now())`,
    );

    const all = await runAs(owner, ws, 'outreach.send.retry', {});
    expect(all.passed).toBe(1);
    expect(all.retried).toHaveLength(2);
    // The oldest first, now; the next 3 to 7 minutes after it.
    const [first, second] = all.retried as { at: string; sendId: string }[];
    const gap = new Date(second!.at).getTime() - new Date(first!.at).getTime();
    expect(gap).toBeGreaterThanOrEqual(3 * 60_000);
    expect(gap).toBeLessThanOrEqual(7 * 60_000);
    const [kept] = await rows<{ profile_id: string; state: string }>(
      admin(),
      sql`select profile_id, state from addon_outreach.sends where id = ${first!.sendId}`,
    );
    expect(kept).toEqual({ profile_id: fern, state: 'approved' });
    // Gray's waits its turn: off the list till then, and Today says when the next may go.
    const list = await today();
    expect(
      list.items.find(
        (i: { kind: string; name: string }) => i.kind === 'opener' && i.name === 'Gray Lund',
      ),
    ).toBeUndefined();
    expect(list.retryAt).toBe(second!.at);
    expect(await needOf(gray)).toBeUndefined();
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
      // Something they asked that the business's Knowledge doesn't answer waits too (decision 122).
      await chat('max.dale.3', 'Max Dale', '2000777', 'Do you come out to Dallas?');
      const max = await chatOf('Max Dale');
      const asked = await runAs(member, ws, 'outreach.send.queue', {
        profileId: max.profile_id,
        kind: 'reply',
        chatId: max.id,
        text: 'Good question. Let me check on that and get back to you.',
        simple: false,
        unanswered: 'whether you come out to Dallas',
      });
      expect(asked.state).toBe('waiting');
      expect((await handOvers()).at(-1)?.why).toBe(
        'Knowledge has no answer to whether you come out to Dallas',
      );
    });

    it('with (a), every reply waits, and nobody is buzzed', async () => {
      await automation(member, 'steps', 'draft');
      await chat('mo.lane.4', 'Mo Lane', '2000666', 'Thanks!');
      expect((await reply(await chatOf('Mo Lane'), true)).state).toBe('waiting');
      expect(await handOvers()).toHaveLength(5);
    });

    it('shows the chat so far beside a message waiting for an OK', async () => {
      const waiting = await runAs(member, ws, 'outreach.waiting', {});
      const mo = waiting.items.find(
        (i: { kind: string; send?: { name: string } }) => i.send?.name === 'Mo Lane',
      );
      expect(mo.send.recent).toEqual([
        { fromMe: true, text: 'How’s business?', at: expect.any(String) },
        { fromMe: false, text: 'Thanks!', at: expect.any(String) },
      ]);
      // One with no chat kept has none.
      const dana = waiting.items.find(
        (i: { kind: string; send?: { name: string } }) => i.send?.name === 'Dana Cole',
      );
      expect(dana?.send.recent ?? []).toEqual([]);
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

/**
 * Comments on good posts through Waiting for you on Instagram and Alignable (decision 92): queued with their post for
 * a build that finds people by topic, one open a writer, waiting under the comments-only hold (a week of them and 25
 * OK'd) and under training wheels, an Alignable answer to a post asking for what the business offers always on its
 * own, and a post set aside once its comment is skipped or not posted. Facebook's and LinkedIn's are never queued.
 */
describe('comments through Waiting for you (decision 92)', () => {
  let owner: TestUser;
  let ws: string;
  const IG = 'https://www.instagram.com';
  const AL = 'https://www.alignable.com';
  const account = (username: string) => ({ id: null, username, url: `${IG}/${username}/` });
  const business = (slug: string) => ({
    id: null,
    username: slug,
    url: `${AL}/austin-tx/${slug}`,
  });
  const ASKING =
    'Our crew keeps missing calls. Can anyone recommend a simple CRM for a small team?';
  const profileOf = async (username: string) =>
    (
      await rows<{ id: string }>(
        admin(),
        sql`select id from addon_outreach.profiles where workspace_id = ${ws} and username = ${username}`,
      )
    )[0]!.id;
  /** A post found by the network's own search that the AI called good, by someone: its id. */
  const goodPost = async (
    platform: 'instagram' | 'alignable' | 'linkedin',
    url: string,
    author: { id: null; username: string; url: string },
    strong = false,
  ) => {
    await runAs(owner, ws, 'outreach.posts.save', {
      platform,
      found: 'search',
      posts: [{ url, author, name: author.username, text: ASKING }],
    });
    const [post] = await rows<{ id: string }>(
      admin(),
      sql`update addon_outreach.posts set check_state = 'good', strong = ${strong}
          where workspace_id = ${ws} and user_id = ${owner.id} and url = ${url} returning id`,
    );
    return post!.id;
  };
  const queue = (profileId: string, postId: string | null, text: string, kind = 'comment') =>
    runAs(owner, ws, 'outreach.send.queue', {
      profileId,
      kind,
      text,
      ...(postId ? { postId } : {}),
    });
  const todayOn = (platform: 'instagram' | 'alignable' | 'linkedin') =>
    runAs(owner, ws, 'outreach.today', { platform });
  const commentRow = async (platform: 'instagram' | 'alignable', postId: string) =>
    (await todayOn(platform)).items.find(
      (i: { kind: string; postId: string | null }) => i.kind === 'comment' && i.postId === postId,
    );
  const sending = (instagram: string, alignable = 'steps') =>
    runAs(owner, ws, 'outreach.automation.save', {
      settings: {
        ...AUTOMATION_DEFAULTS,
        networks: {
          ...NETWORKS_DEFAULTS,
          instagram: { ...NETWORK_CHOICES_DEFAULTS, on: true, sending: instagram },
          alignable: { ...NETWORK_CHOICES_DEFAULTS, on: true, sending: alignable },
          linkedin: { ...NETWORK_CHOICES_DEFAULTS, on: true, sending: 'steps' },
        },
      },
    });

  beforeAll(async () => {
    owner = await createTestUser('outs-comments', { fullName: 'Avery Owner' });
    ws = await outreachBusiness(owner, 'Outreach Comments Co');
    const crm = PLAYBOOK_TEMPLATES.crm_demos;
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: crm.name,
      template: 'crm_demos',
      details: { ...crm.details, platforms: ['instagram', 'alignable', 'linkedin'] },
    });
    await computerOn(owner, ws, '0.95.0');
    await sending('steps');
  }, 60_000);
  afterAll(closeTestDbs);

  it('queues one only on a good post of theirs kept for the person, where comments wait at first', async () => {
    const post = await goodPost('instagram', `${IG}/p/DQcomment01/`, account('sky.lane.plumbing'));
    const other = await goodPost('instagram', `${IG}/p/DQcomment02/`, account('tess.moor.hvac'));
    const sky = await profileOf('sky.lane.plumbing');
    const instagram = await todayOn('instagram');
    expect(instagram.messages).toContain('comment');
    expect((await commentRow('instagram', post)).send).toBeNull();
    // A comment needs its post, and a post goes only with a comment.
    expect(await refused(queue(sky, null, 'Great question!'))).toBe('validation');
    expect(await refused(queue(sky, post, 'Hi Sky!', 'opener'))).toBe('validation');
    // Someone else's post, or one the AI didn't call good, isn't theirs to comment on.
    expect(await refused(queue(sky, other, 'Great question!'))).toBe('outreach_comment_post');
    await rows(
      admin(),
      sql`update addon_outreach.posts set check_state = 'not' where id = ${other}`,
    );
    expect(await refused(queue(await profileOf('tess.moor.hvac'), other, 'Hi!'))).toBe(
      'outreach_comment_post',
    );
    // LinkedIn's wait for an OK too, but only from the build that posts them (decision 102): an older one would send
    // one as a message, so it's offered none and none is queued.
    const linkedin = await goodPost(
      'linkedin',
      'https://www.linkedin.com/feed/update/urn:li:activity:7390000000000000901/',
      {
        id: null,
        username: 'nia-park-roofing',
        url: 'https://www.linkedin.com/in/nia-park-roofing/',
      },
    );
    const nia = await profileOf('nia-park-roofing');
    expect(await refused(queue(nia, linkedin, 'Hi!'))).toBe('outreach_comment_network');
    expect((await todayOn('linkedin')).messages).not.toContain('comment');
    expect((await runAs(owner, ws, 'outreach.today', {})).messages).not.toContain('comment');
    await computerOn(owner, ws, LINKEDIN_COMMENTS_WAIT_SINCE);
    expect((await todayOn('linkedin')).messages).toContain('comment');
    const held = await queue(nia, linkedin, 'A shared call list helped our crew most.');
    expect(held).toMatchObject({ kind: 'comment', state: 'waiting', postId: linkedin });
    // Set aside here, so the hold below is Instagram's alone.
    await runAs(owner, ws, 'outreach.send.skip', { sendId: held.sendId });
    await computerOn(owner, ws, '0.95.0');
  });

  it('waits under the hold with its post, one open a writer, and Approve all takes it', async () => {
    const post = (
      await rows<{ id: string }>(
        admin(),
        sql`select id from addon_outreach.posts where workspace_id = ${ws} and url = ${`${IG}/p/DQcomment01/`}`,
      )
    )[0]!.id;
    const sky = await profileOf('sky.lane.plumbing');
    const queued = await queue(
      sky,
      post,
      'Same trouble here. A shared inbox for calls helped us most.',
    );
    expect(queued).toMatchObject({
      kind: 'comment',
      state: 'waiting',
      name: 'sky.lane.plumbing',
      postId: post,
      postUrl: `${IG}/p/DQcomment01/`,
      post: ASKING,
      needsYou: null,
      handedOver: false,
      recent: [],
    });
    expect((await commentRow('instagram', post)).send).toMatchObject({
      sendId: queued.sendId,
      state: 'waiting',
    });
    // The writer's second good post waits till this comment is sent or skipped; queued anyway, the open one comes back.
    const second = await goodPost(
      'instagram',
      `${IG}/p/DQcomment03/`,
      account('sky.lane.plumbing'),
    );
    expect(await commentRow('instagram', second)).toBeUndefined();
    expect((await queue(sky, second, 'Another thought')).sendId).toBe(queued.sendId);
    // In Waiting for you as a message to OK, and Approve all takes it.
    const waiting = await runAs(owner, ws, 'outreach.waiting', {});
    expect(waiting.kinds.message.count).toBe(1);
    expect(
      waiting.items.find((i: { send?: { sendId: string } }) => i.send?.sendId === queued.sendId)
        .kind,
    ).toBe('message');
    // It says Instagram's comments wait under the hold, for the hold's note there.
    expect(waiting.commentHolds).toContain('instagram');
    expect((await runAs(owner, ws, 'outreach.send.approve', {})).approved).toEqual([queued.sendId]);
    // The extension posts it and notes the comment: the post is done, and the writer's next one comes.
    await runAs(owner, ws, 'outreach.touch.save', {
      platform: 'instagram',
      kind: 'comment',
      profile: account('sky.lane.plumbing'),
      name: 'sky.lane.plumbing',
      postUrl: `${IG}/p/DQcomment01/`,
      auto: true,
    });
    expect(
      await runAs(owner, ws, 'outreach.send.done', { sendId: queued.sendId, sent: true }),
    ).toEqual({ sendId: queued.sendId, state: 'sent' });
    expect(await commentRow('instagram', post)).toBeUndefined();
    expect(await refused(queue(sky, post, 'Once more'))).toBe('outreach_comment_done');
    expect((await commentRow('instagram', second)).send).toBeNull();
  });

  it('sets its post aside once skipped, or not posted, and hands one not posted to the person', async () => {
    const sky = await profileOf('sky.lane.plumbing');
    const second = (
      await rows<{ id: string }>(
        admin(),
        sql`select id from addon_outreach.posts where workspace_id = ${ws} and url = ${`${IG}/p/DQcomment03/`}`,
      )
    )[0]!.id;
    const skipped = await queue(sky, second, 'Good luck with the busy season!');
    await runAs(owner, ws, 'outreach.send.skip', { sendId: skipped.sendId });
    const asideOf = async (id: string) =>
      (
        await rows<{ aside: boolean }>(
          admin(),
          sql`select skipped_at is not null as aside from addon_outreach.posts where id = ${id}`,
        )
      )[0]!.aside;
    expect(await asideOf(second)).toBe(true);
    expect(await commentRow('instagram', second)).toBeUndefined();
    expect(await refused(queue(sky, second, 'Again'))).toBe('outreach_comment_done');

    const third = await goodPost('instagram', `${IG}/p/DQcomment04/`, account('sky.lane.plumbing'));
    const failed = await queue(sky, third, 'We use a shared calendar for this.');
    await runAs(owner, ws, 'outreach.send.approve', { sends: [{ sendId: failed.sendId }] });
    expect(
      await runAs(owner, ws, 'outreach.send.done', {
        sendId: failed.sendId,
        sent: false,
        why: 'Instagram didn’t show the comment box.',
      }),
    ).toMatchObject({ state: 'failed' });
    expect(await asideOf(third)).toBe(true);
    const need = (await runAs(owner, ws, 'outreach.waiting', {})).items.find(
      (i: { kind: string; need?: { postId: string | null } }) => i.need?.postId === third,
    ).need;
    expect(need).toMatchObject({
      step: 'comment',
      sendId: failed.sendId,
      url: `${IG}/p/DQcomment04/`,
      text: 'We use a shared calendar for this.',
      why: 'Instagram didn’t show the comment box.',
    });
  });

  it('goes on its own after a week of comments and 25 OK’d, but never under training wheels', async () => {
    // A week and more of comments the person OK'd themselves, each on a post of its own.
    const vic = await goodPost('instagram', `${IG}/p/DQcomment05/`, account('vic.hale.roofing'));
    await rows(
      admin(),
      sql`with made as (
            insert into addon_outreach.posts (workspace_id, user_id, profile_id, url, body, found, check_state, seen_at)
            select ${ws}, ${owner.id}, p.id, ${`${IG}/p/DQold`} || n || '/', 'An older post', 'search', 'good',
              now() - interval '10 days'
            from addon_outreach.profiles p, generate_series(1, ${COMMENT_HOLD.okd}) n
            where p.workspace_id = ${ws} and p.username = 'vic.hale.roofing'
            returning id, profile_id)
          insert into addon_outreach.sends (workspace_id, user_id, profile_id, kind, post_id, text, drafted, state,
            approved_at, done_at, created_at, updated_at)
          select ${ws}, ${owner.id}, made.profile_id, 'comment', made.id, 'Thanks for sharing!', 'Thanks for sharing!',
            'sent', now() - interval '9 days', now() - interval '9 days', now() - interval '10 days',
            now() - interval '9 days'
          from made`,
    );
    const goes = await queue(await profileOf('vic.hale.roofing'), vic, 'Good tip, thanks.');
    expect(goes.state).toBe('approved');
    // Sending (b) starts Instagram's training wheels: every comment waits again while they're on.
    await sending('everything');
    const wren = await goodPost('instagram', `${IG}/p/DQcomment06/`, account('wren.ash.cleaning'));
    expect((await queue(await profileOf('wren.ash.cleaning'), wren, 'Nice work!')).state).toBe(
      'waiting',
    );
    // It waits for the training wheels, not the hold: Waiting for you says Instagram's hold is past, Alignable's on.
    const { commentHolds } = await runAs(owner, ws, 'outreach.waiting', {});
    expect(commentHolds).not.toContain('instagram');
    expect(commentHolds).toContain('alignable');
    await sending('steps');
  });

  it('keeps an Alignable answer to a post asking for what the business offers waiting for an OK of its own', async () => {
    const answer = await goodPost(
      'alignable',
      `${AL}/forum/what-crm-do-small-crews-use`,
      business('reyes-plumbing'),
      true,
    );
    const helpful = await goodPost(
      'alignable',
      `${AL}/forum/tips-for-a-busy-season`,
      business('ng-roofing'),
    );
    expect((await todayOn('alignable')).messages).toContain('comment');
    const asked = await queue(
      await profileOf('reyes-plumbing'),
      answer,
      'We help small crews keep every call in one place. Happy to share what works.',
    );
    expect(asked).toMatchObject({ state: 'waiting', needsYou: COMMENT_NEEDS_YOU.answer });
    // Alignable's own hold: no comments there yet, so this one waits too, with nothing of its own.
    const tip = await queue(
      await profileOf('ng-roofing'),
      helpful,
      'Plan the week on Sunday night.',
    );
    expect(tip).toMatchObject({ state: 'waiting', needsYou: null });
    const all = (await runAs(owner, ws, 'outreach.send.approve', {})).approved;
    expect(all).toContain(tip.sendId);
    expect(all).not.toContain(asked.sendId);
    // Named with another, it's refused; named alone, it's OK'd.
    expect(
      await refused(
        runAs(owner, ws, 'outreach.send.approve', {
          sends: [{ sendId: asked.sendId }, { sendId: tip.sendId }],
        }),
      ),
    ).toBe('outreach_send_one_by_one');
    expect(
      (await runAs(owner, ws, 'outreach.send.approve', { sends: [{ sendId: asked.sendId }] }))
        .approved,
    ).toEqual([asked.sendId]);
  });

  it('drafts comments only for a build that finds people by topic, and none with Sending Off', async () => {
    await computerOn(owner, ws, '0.94.0');
    expect((await todayOn('instagram')).messages).not.toContain('comment');
    await computerOn(owner, ws, '0.95.0');
    expect((await todayOn('instagram')).messages).toContain('comment');
    await sending('off');
    expect((await todayOn('instagram')).messages).toEqual([]);
  });
});
