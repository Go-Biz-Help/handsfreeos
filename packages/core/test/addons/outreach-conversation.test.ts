/**
 * Social Outreach: the conversation after someone accepts (docs/outreach.md, decisions 65 to 67;
 * ../../src/addons/outreach/conversation.ts). The first message asks about the main offer; whoever goes quiet gets
 * follow-ups at the playbook's pace, then a check-in once a month; a yes is a positive reply and moves them to the
 * video, or the link with no video; a no ends it, until the person puts them back in play. What's sent keeps the
 * main offer's version they were first pitched with.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTOMATION_DEFAULTS } from '../../src/addons/outreach/automation';
import {
  checkInAfter,
  nextAfter,
  stepAfterYes,
  versionWords,
  CHECK_IN_DAYS,
} from '../../src/addons/outreach/conversation';
import { ownOpenerFits, ownOpenerText } from '../../src/addons/outreach/openers';
import { paceOf, PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import {
  answerOf,
  draftOfferOf,
  TODAY_DRAFT_SYSTEM,
  todayDraftPrompt,
  TodayDraftAnswer,
} from '../../src/addons/outreach/today';
import { MainOfferParts } from '../../src/main-offer/parts';
import { outreachBusiness, READY_VIDEO, runAs, runAsSystem } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();
const fb = (username: string) => ({
  id: null,
  username,
  url: `https://www.facebook.com/${username}`,
});

describe('the conversation’s rules', () => {
  const from = new Date('2026-10-10T15:00:00.000Z');
  const pace = paceOf(null);

  it('follows up a day apart for three, then two, then checks in once a month', () => {
    expect(nextAfter(pace, 0, from)).toEqual({
      next: 'follow_up',
      dueAt: new Date('2026-10-11T15:00:00.000Z'),
    });
    expect(nextAfter(pace, 3, from).dueAt).toEqual(new Date('2026-10-12T15:00:00.000Z'));
    expect(nextAfter(pace, pace.followUps, from)).toEqual({
      next: 'check_in',
      dueAt: new Date(from.getTime() + CHECK_IN_DAYS * DAY),
    });
    expect(checkInAfter(from).next).toBe('check_in');
  });

  it('sends the video after a yes when there is one, then the link', () => {
    expect(stepAfterYes('first', true)).toBe('video');
    expect(stepAfterYes('first', false)).toBe('pitch');
    expect(stepAfterYes('video', true)).toBe('pitch');
    expect(stepAfterYes('link', true)).toBeNull();
  });

  it('fills the business’s own opener with the offer’s words, and holds one with nothing to put in', () => {
    const offer = { outcome: '10 booked inspections a month', guarantee: 'a 60-day guarantee' };
    expect(
      ownOpenerText('Hi {first name}! Open to {outcome} on {guarantee}?', 'Dana Reyes', offer),
    ).toBe('Hi Dana! Open to 10 booked inspections a month on a 60-day guarantee?');
    expect(ownOpenerFits('Open to {outcome}?', { outcome: null, guarantee: null })).toBe(false);
    expect(ownOpenerFits('Hi {first name}!', null)).toBe(true);
  });

  it('tells a draft the offer’s words for the conversation, never Reconnect, and the guarantee and price only if they ask', () => {
    const offer = draftOfferOf(
      2,
      MainOfferParts.parse({
        outcome: { result: '10 to 20 booked inspections a month' },
        guarantee: { promise: 'Or the next month is free' },
        price: { amount: '$2,000 a month' },
        inAFewWords: { outcome: '10 booked inspections', guarantee: 'a free month if not' },
        proof: ['Pine Roofing booked 14 in 30 days'],
      }),
    );
    expect(offer).toMatchObject({
      version: 2,
      outcome: '10 booked inspections',
      guarantee: 'a free month if not',
      price: '$2,000 a month',
    });
    const prompt = (kind: 'opener' | 'reconnect' | 'follow_up') =>
      todayDraftPrompt({
        kind,
        business: 'Pine Roof Leads',
        name: 'Dana Reyes',
        facts: [],
        recent: [],
        playbook: null,
        offer,
        conversation: { step: 'video', sent: 1, followUps: 6 },
      });
    expect(prompt('opener')).toMatch(/The outcome, in a few words: 10 booked inspections/);
    expect(prompt('opener')).toMatch(/The price, only when they ask: \$2,000 a month/);
    expect(prompt('opener')).toMatch(/Its only job is a yes/);
    // No message carries the guarantee (decision 65, 2026-10-26): it's there for a reply to someone who asks.
    expect(prompt('opener')).toMatch(
      /The guarantee, only when they ask whether there is one: a free month if not/,
    );
    expect(prompt('opener')).not.toMatch(/on its guarantee|outcome and guarantee as/);
    expect(TODAY_DRAFT_SYSTEM).toMatch(/Leave the guarantee out/);
    expect(prompt('reconnect')).not.toMatch(/<offer>/);
    expect(prompt('follow_up')).toMatch(
      /Where the conversation is: video sent\. This is follow-up 2 of 6\./,
    );
  });

  it('reads an answer only from a reply whose last message is theirs', () => {
    const them = [{ fromMe: false, text: 'Sure, send it over', at: '2026-10-10T15:00:00.000Z' }];
    const said = TodayDraftAnswer.parse({ drafts: ['Great!'], answer: 'yes' });
    expect(answerOf('reply', said, them)).toBe('yes');
    expect(answerOf('follow_up', said, them)).toBeNull();
    expect(answerOf('reply', said, [{ ...them[0]!, fromMe: true }])).toBeNull();
    expect(TodayDraftAnswer.parse({ drafts: [], answer: 'maybe' }).answer).toBe('none');
  });
});

describe('a conversation on Today', () => {
  let owner: TestUser;
  let ws: string;
  const group = {
    id: '523456789',
    slug: null,
    url: 'https://www.facebook.com/groups/523456789/',
    name: 'Boise Trades Owners',
  };
  const profileOf = async (username: string) => {
    const [p] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_outreach.profiles where workspace_id = ${ws} and username = ${username}`,
    );
    return p!.id;
  };
  /** They accepted the person's friend request two days ago. */
  const accepted = async (username: string, name: string) => {
    await runAs(owner, ws, 'outreach.touch.save', {
      kind: 'friend_request',
      profile: fb(username),
      name,
      at: daysAgo(3),
    });
    await rows(
      admin(),
      sql`insert into addon_outreach.friends (workspace_id, user_id, profile_id, state, since, seen_at)
          select ${ws}, ${owner.id}, p.id, 'friends', ${daysAgo(2)}::timestamptz, now()
          from addon_outreach.profiles p where p.workspace_id = ${ws} and p.username = ${username}
          on conflict (workspace_id, user_id, profile_id) do update set state = 'friends', since = excluded.since`,
    );
    return profileOf(username);
  };
  /** The extension sends one: it's drafted, OK'd, noted in Messenger, and said to have gone. */
  const send = async (profileId: string, username: string, name: string, kind: string) => {
    const queued = await runAs(owner, ws, 'outreach.send.queue', {
      profileId,
      kind,
      text: `A ${kind} to ${name}`,
    });
    await runAs(owner, ws, 'outreach.send.approve', { sends: [{ sendId: queued.sendId }] });
    await runAs(owner, ws, 'outreach.touch.save', {
      kind: 'message',
      profile: fb(username),
      name,
      at: new Date().toISOString(),
    });
    await runAs(owner, ws, 'outreach.send.done', { sendId: queued.sendId, sent: true });
    return queued.sendId as string;
  };
  /** Two quiet days on: the next follow-up comes due, and the person's message is two days old. */
  const quietDays = async (profileId: string) => {
    await rows(
      admin(),
      sql`update addon_outreach.follow_ups
            set due_at = case when next is not null then now() - interval '1 minute' end,
            last_at = last_at - interval '2 days'
          where workspace_id = ${ws} and profile_id = ${profileId}`,
    );
    await rows(
      admin(),
      sql`update addon_outreach.touches set at = at - interval '2 days'
          where workspace_id = ${ws} and profile_id = ${profileId} and kind = 'message'`,
    );
  };
  const conversation = async (profileId: string) => {
    const [f] = await rows<{
      step: string;
      sent: number;
      next: string | null;
      answer: string | null;
      offer_version: number | null;
      stopped: boolean;
    }>(
      admin(),
      sql`select step, sent, next, answer, offer_version, stopped_at is not null as stopped
          from addon_outreach.follow_ups where workspace_id = ${ws} and profile_id = ${profileId}`,
    );
    return f ?? null;
  };
  const listed = async (name: string) =>
    ((await runAs(owner, ws, 'outreach.today', {})).items as { kind: string; name: string }[])
      .filter((i) => i.name === name)
      .map((i) => i.kind);
  const answer = (profileId: string, said: string) =>
    runAsSystem(ws, 'outreach.answer.note', {
      userId: owner.id,
      profileId,
      answer: said,
      writtenAt: new Date().toISOString(),
    });

  beforeAll(async () => {
    owner = await createTestUser('outc-owner', { fullName: 'Morgan Owner' });
    ws = await outreachBusiness(owner, 'Outreach Conversation Co');
    const crm = PLAYBOOK_TEMPLATES.crm_demos;
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: crm.name,
      template: 'crm_demos',
      details: crm.details,
    });
    await runAs(owner, ws, 'outreach.group.save', {
      group,
      members: 9_100,
      adminsPage: true,
      people: ['dana.reyes.5', 'eli.brook.5', 'fern.ash.5'].map((u, i) => ({
        profile: fb(u),
        name: ['Dana Reyes', 'Eli Brook', 'Fern Ash'][i],
        lines: ['Owner at a plumbing company'],
        part: 'Members near you',
        runsGroup: false,
      })),
    });
    await runAs(owner, ws, 'outreach.automation.save', {
      settings: { ...AUTOMATION_DEFAULTS, sending: 'steps' },
    });
  }, 120_000);
  afterAll(closeTestDbs);

  it('follows up whoever goes quiet, then sends the link to a yes, keeping the offer’s version', async () => {
    const dana = await accepted('dana.reyes.5', 'Dana Reyes');
    expect(await listed('Dana Reyes')).toEqual(['opener']);

    await send(dana, 'dana.reyes.5', 'Dana Reyes', 'opener');
    expect(await conversation(dana)).toMatchObject({
      step: 'first',
      sent: 0,
      next: 'follow_up',
      answer: null,
      offer_version: 1,
    });
    // Sent today: nothing for Dana until the first follow-up is due.
    expect(await listed('Dana Reyes')).toEqual([]);

    await quietDays(dana);
    const today = await runAs(owner, ws, 'outreach.today', {});
    const due = today.items.find((i: { name: string }) => i.name === 'Dana Reyes');
    expect(due).toMatchObject({
      kind: 'follow_up',
      why: ['First message sent, no answer yet', '1 of 6'],
    });
    const sendId = await send(dana, 'dana.reyes.5', 'Dana Reyes', 'follow_up');
    expect(await conversation(dana)).toMatchObject({ step: 'first', sent: 1 });
    // The follow-up went with the version they were pitched with.
    const [kept] = await rows<{ offer_version: number | null }>(
      admin(),
      sql`select offer_version from addon_outreach.sends where id = ${sendId}`,
    );
    expect(kept!.offer_version).toBe(1);

    // A yes: a positive reply, and Send the video is next, with the playbook's video (Your messages waits on one).
    expect(await answer(dana, 'yes')).toEqual({ noted: true });
    const [stage] = await rows<{ positive: boolean }>(
      admin(),
      sql`select positive_at is not null as positive from addon_outreach.stages
          where workspace_id = ${ws} and profile_id = ${dana}`,
    );
    expect(stage!.positive).toBe(true);
    expect(await conversation(dana)).toMatchObject({ answer: 'yes', next: null });
    const video = (await runAs(owner, ws, 'outreach.today', {})).items.find(
      (i: { name: string }) => i.name === 'Dana Reyes',
    );
    expect(video).toMatchObject({
      kind: 'video',
      videoLink: READY_VIDEO,
      why: ['Said yes to your first message'],
    });
    await send(dana, 'dana.reyes.5', 'Dana Reyes', 'video');
    expect(await conversation(dana)).toMatchObject({ step: 'video', sent: 0, offer_version: 1 });
    await answer(dana, 'yes');
    expect(await listed('Dana Reyes')).toEqual(['pitch']);
    await send(dana, 'dana.reyes.5', 'Dana Reyes', 'pitch');
    expect(await conversation(dana)).toMatchObject({ step: 'link', next: 'follow_up' });
    expect(await listed('Dana Reyes')).toEqual([]);
  });

  it('checks in once a month after the last follow-up', async () => {
    const eli = await accepted('eli.brook.5', 'Eli Brook');
    await send(eli, 'eli.brook.5', 'Eli Brook', 'opener');
    for (let i = 0; i < 6; i++) {
      await quietDays(eli);
      expect(await listed('Eli Brook')).toEqual(['follow_up']);
      await send(eli, 'eli.brook.5', 'Eli Brook', 'follow_up');
    }
    expect(await conversation(eli)).toMatchObject({ sent: 6, next: 'check_in' });
    await quietDays(eli);
    expect(await listed('Eli Brook')).toEqual(['check_in']);
    await send(eli, 'eli.brook.5', 'Eli Brook', 'check_in');
    expect(await conversation(eli)).toMatchObject({ sent: 6, next: 'check_in' });
  }, 60_000);

  it('stops the check-ins on the person’s word, until the two talk again', async () => {
    const eli = await profileOf('eli.brook.5');
    await quietDays(eli);
    const due = (await runAs(owner, ws, 'outreach.today', {})).items.find(
      (i: { name: string }) => i.name === 'Eli Brook',
    ) as { kind: string; why: string[] };
    expect(due.kind).toBe('check_in');
    expect(due.why[0]).toMatch(/^No answer since [A-Z][a-z]{2} \d{1,2}$/);
    expect(due.why[1]).toBe('once a month');

    expect(await runAs(owner, ws, 'outreach.conversation.stop', { profileId: eli })).toEqual({
      stopped: true,
    });
    expect(await conversation(eli)).toMatchObject({ stopped: true, next: null });
    expect(await listed('Eli Brook')).toEqual([]);

    // They write back with a question: the reply says what the AI read in it.
    await rows(
      admin(),
      sql`insert into addon_outreach.replies (workspace_id, user_id, profile_id, after_at, seen_at, pushed)
          values (${ws}, ${owner.id}, ${eli}, now() - interval '3 days', now(), false)`,
    );
    await answer(eli, 'question');
    const reply = (await runAs(owner, ws, 'outreach.today', {})).items.find(
      (i: { name: string }) => i.name === 'Eli Brook',
    );
    expect(reply).toMatchObject({ kind: 'reply', why: ['Asked a question', 'Wrote back today'] });

    // Answering them goes on with the conversation.
    await runAs(owner, ws, 'outreach.conversation.note', { profileId: eli, kind: 'reply' });
    expect(await conversation(eli)).toMatchObject({ stopped: false, next: 'follow_up', sent: 0 });
  });

  it('ends with a no, until the person puts them back in play', async () => {
    const fern = await accepted('fern.ash.5', 'Fern Ash');
    await send(fern, 'fern.ash.5', 'Fern Ash', 'opener');
    await answer(fern, 'no');
    expect(await conversation(fern)).toMatchObject({ answer: 'no', stopped: true });
    await quietDays(fern);
    expect(await listed('Fern Ash')).toEqual([]);
    await runAs(owner, ws, 'outreach.stage.mark', { profileId: fern, mark: 'open' });
    expect(await conversation(fern)).toMatchObject({ stopped: false });
  });

  it('notes a draft copied to send by hand, as sent', async () => {
    const [p] = await rows<{ id: string }>(
      admin(),
      sql`insert into addon_outreach.profiles (workspace_id, platform, username, url, name)
          values (${ws}, 'facebook', 'gray.lund.5', 'https://www.facebook.com/gray.lund.5', 'Gray Lund')
          returning id`,
    );
    expect(
      await runAs(owner, ws, 'outreach.conversation.note', { profileId: p!.id, kind: 'opener' }),
    ).toEqual({ noted: true });
    expect(await conversation(p!.id)).toMatchObject({ step: 'first', sent: 0, offer_version: 1 });
  });

  it('counts each version’s first messages, yeses and calls booked, too new to judge before 100', async () => {
    const got = await runAs(owner, ws, 'outreach.offer.versions', {});
    // Dana, Eli, Fern and Gray were pitched with version 1; Dana said yes.
    expect(got).toEqual({
      versions: [{ version: 1, messages: 4, positive: 1, booked: 0 }],
      everyone: true,
      judgeAfter: 100,
      live: 1,
    });
    expect(versionWords(got.versions[0])).toEqual({
      tooNew: true,
      line: 'Too new to judge: 4 first messages, 1 yes, 0 calls booked so far. Give it 96 more first messages before you change it.',
    });
    expect(versionWords({ messages: 120, positive: 9, booked: 3 }).tooNew).toBe(false);
  });
});
