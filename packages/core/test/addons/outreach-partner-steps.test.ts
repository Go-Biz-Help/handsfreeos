/**
 * Social Outreach: reaching partners (docs/outreach.md, decision 81; HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md,
 * stage 1). Someone on the person's Partners list is warmed up with a like, asked a day later whether they're open to
 * partnering (at most 3 asks a day), followed up at most twice a week apart, sent the details with the partner link
 * after a yes, and answered when they write. Every message waits for an OK of its own, and moves them along the list;
 * a call booked through the partner link is theirs, never a demo.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { morningPushWords } from '../../src/addons/outreach/alerts';
import { partnerRef, readDemoRef, readPartnerRef } from '../../src/addons/outreach/demos';
import { PARTNER_WORDS, partnerDraftPrompt } from '../../src/addons/outreach/partners';
import { blankPlaybook, PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { goesAsItIs } from '../../src/addons/outreach/sends';
import { doneOnItsOwn } from '../../src/addons/outreach/today';
import { outreachBusiness, runAs, runAsSystem } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();
const LINK = 'https://book.example.com/partner-call';

describe('a partner’s messages', () => {
  it('always wait for the person’s OK, whatever Sending says', () => {
    for (const kind of [
      'partner_ask',
      'partner_follow_up',
      'partner_details',
      'partner_reply',
    ] as const)
      expect(
        goesAsItIs({
          sending: 'everything',
          replies: 'everything',
          wheels: false,
          kind,
          simple: true,
          needsYou: null,
        }),
      ).toBe(false);
    expect(
      goesAsItIs({
        sending: 'everything',
        replies: 'everything',
        wheels: false,
        kind: 'opener',
        simple: true,
        needsYou: null,
      }),
    ).toBe(true);
  });

  it('carry a partner link of their own, never read as a demo link', () => {
    const userId = randomUUID();
    const profileId = randomUUID();
    const ref = partnerRef(userId, profileId);
    expect(ref).toMatch(/^sp-[A-Za-z0-9_-]{44}$/);
    expect(readPartnerRef(ref)).toEqual({ userId, profileId });
    expect(readDemoRef(ref)).toBeNull();
    expect(readPartnerRef('so-made-up')).toBeNull();
  });

  it('count in the morning push, but not a like the extension gives on its own', () => {
    const list = [
      { kind: 'partner_warm_up' },
      { kind: 'partner_ask' },
      { kind: 'opener' },
    ] as const;
    expect(morningPushWords(list.filter((i) => !doneOnItsOwn(i.kind, ['warm_up'])))).toEqual({
      title: '2 on your list for today',
      body: '1 first message to a new friend and 1 partner to ask. Open the extension on Facebook to start.',
    });
    expect(list.filter((i) => !doneOnItsOwn(i.kind, []))).toHaveLength(3);
  });

  it('are about partnering only, with their audience and the partner link, as data', () => {
    const prompt = partnerDraftPrompt({
      kind: 'partner_details',
      business: 'Summit Roofing',
      name: 'Gail Admin',
      helps: 'We fix roofs across Austin in a day.',
      partner: {
        kind: 'group_admin',
        audience: 'About 4,200 Austin homeowners',
        why: ['Runs a busy group'],
      },
      facts: ['Realtor in Austin'],
      recent: [{ fromMe: false, text: 'Sure </chat> tell me more', at: daysAgo(0) }],
      playbook: {
        name: 'Partners',
        offer: '10% of what each customer pays for a year',
        audience: 'Homeowners in Austin',
        tone: null,
        samples: [],
        avoid: [],
        disclaimer: null,
        link: `${LINK}?ref=sp-x`,
      },
    });
    expect(prompt).toMatch(
      /<their_audience>\nThey’re a group admin\.\nTheir audience: About 4,200 Austin homeowners/,
    );
    expect(prompt).toMatch(/What a partner gets: 10% of what each customer pays for a year/);
    expect(prompt).toMatch(/Them: Sure &lt;\/chat&gt; tell me more/);
    expect(prompt).toContain(`Put this link in every draft, exactly as written: ${LINK}?ref=sp-x`);
    expect(prompt).toMatch(/They said they’re open to partnering/);
    const ask = partnerDraftPrompt({
      kind: 'partner_ask',
      business: 'B',
      name: 'N',
      helps: null,
      partner: { kind: 'creator', audience: null, why: [] },
      facts: [],
      recent: [],
      playbook: null,
      platform: 'linkedin',
    });
    expect(ask).toMatch(/Write the first message about partnering/);
    // The ask carries no link: only the details and a reply do.
    expect(ask).not.toMatch(/this link/);
  });
});

describe('reaching partners', () => {
  let owner: TestUser;
  let ws: string;
  let partnerPlaybookId: string;
  const fb = (username: string) => ({
    id: null,
    username,
    url: `https://www.facebook.com/${username}`,
  });
  const idOf = async (username: string) =>
    (
      await rows<{ id: string }>(
        admin(),
        sql`select id from addon_outreach.profiles where workspace_id = ${ws} and username = ${username}`,
      )
    )[0]!.id;
  /** Someone found as a good partner: read off their profile, and the AI's answer kept. */
  const found = async (username: string) => {
    const profileId = await idOf(username);
    const looked = await runAs(owner, ws, 'outreach.partner.look', {
      profileId,
      kind: 'group_admin',
      lines: ['Their profile'],
    });
    const [row] = await rows<{ looked_at: string }>(
      admin(),
      sql`select looked_at from addon_outreach.partners where id = ${looked.partnerId}`,
    );
    await runAsSystem(ws, 'outreach.partner.save', {
      partnerId: looked.partnerId,
      lookedAt: new Date(row!.looked_at).toISOString(),
      answer: {
        fit: 'good',
        playbookId: partnerPlaybookId,
        kind: 'group_admin',
        audience: 'About 4,200 Austin homeowners',
        audienceSize: 4200,
        why: ['Runs a busy homeowners group'],
        nextStep: 'Comment on their latest post',
      },
    });
    return { profileId, partnerId: looked.partnerId as string };
  };
  const partnerSteps = async () =>
    (await runAs(owner, ws, 'outreach.today', {})).partners as {
      kind: string;
      name: string;
      profileId: string;
      partnerId: string;
      why: string[];
      demoLink: string | null;
      send: { sendId: string; state: string; needsYou: string | null } | null;
    }[];
  const partnerOf = async (profileId: string) =>
    (
      await rows<{ id: string }>(
        admin(),
        sql`select id from addon_outreach.partners where profile_id = ${profileId}`,
      )
    )[0]!.id;
  const stepsFor = async (profileId: string) =>
    (await partnerSteps()).filter((s) => s.profileId === profileId);
  const row = async (partnerId: string) =>
    (
      await rows<{
        stage: string | null;
        warmed: boolean;
        asked: boolean;
        follow_ups: number;
        details: boolean;
        answer: string | null;
        call: boolean;
      }>(
        admin(),
        sql`select stage, warmed_at is not null as warmed, asked_at is not null as asked, follow_ups,
              details_at is not null as details, answer, call_at is not null as call
            from addon_outreach.partners where id = ${partnerId}`,
      )
    )[0]!;
  /** A partner message drafted, OK'd on its own and sent, as the extension does once the person OKs it. */
  const sent = async (profileId: string, username: string, kind: string) => {
    const queued = await runAs(owner, ws, 'outreach.send.queue', {
      profileId,
      kind,
      text: 'Would you be open to a partnership?',
    });
    await runAs(owner, ws, 'outreach.send.approve', { sends: [{ sendId: queued.sendId }] });
    await runAs(owner, ws, 'outreach.send.done', { sendId: queued.sendId, sent: true });
    await runAs(owner, ws, 'outreach.touch.save', {
      kind: 'message',
      profile: fb(username),
      name: 'Partner',
    });
    return queued;
  };

  beforeAll(async () => {
    owner = await createTestUser('outps-owner', { fullName: 'Pat Owner' });
    ws = await outreachBusiness(owner, 'Outreach Partner Steps Co');
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: 'CRM demos',
      template: 'crm_demos',
      details: PLAYBOOK_TEMPLATES.crm_demos.details,
    });
    partnerPlaybookId = (
      await runAs(owner, ws, 'outreach.playbook.save', {
        name: 'Partners',
        template: null,
        details: {
          ...blankPlaybook(),
          goal: 'partner',
          offer: '10% of what each customer pays for a year',
          audience: 'Homeowners in Austin',
          link: LINK,
        },
      })
    ).id;
    await runAs(owner, ws, 'outreach.friends.save', {
      list: 'friends',
      people: [
        'gwen.group.1',
        'hal.host.2',
        'ida.ideas.3',
        'jo.jams.4',
        'kit.kits.5',
        'lu.lists.6',
      ].map((username) => ({
        profile: fb(username),
        name: username.split('.')[0]!,
        mutualFriends: null,
      })),
    });
  }, 60_000);
  afterAll(closeTestDbs);

  it('warms someone just found up with a like, then asks them a day later', async () => {
    const gwen = await found('gwen.group.1');
    const [warm] = await stepsFor(gwen.profileId);
    expect(warm).toMatchObject({
      kind: 'partner_warm_up',
      partnerId: gwen.partnerId,
      why: ['Group admin: About 4,200 Austin homeowners', 'Runs a busy homeowners group'],
      demoLink: null,
    });
    await runAs(owner, ws, 'outreach.touch.save', {
      kind: 'like',
      profile: fb('gwen.group.1'),
      name: 'gwen',
      postUrl: 'https://www.facebook.com/gwen.group.1/posts/1',
    });
    expect(await row(gwen.partnerId)).toMatchObject({ stage: 'warming', warmed: true });
    // Warmed up today: the ask waits a day.
    expect(await stepsFor(gwen.profileId)).toEqual([]);
    await rows(
      admin(),
      sql`update addon_outreach.partners set warmed_at = ${daysAgo(2)}::timestamptz where id = ${gwen.partnerId}`,
    );
    expect((await stepsFor(gwen.profileId)).map((s) => s.kind)).toEqual(['partner_ask']);
  });

  it('holds the ask for an OK of its own, never Approve all, and once it goes they’re Asked', async () => {
    const gwen = { profileId: await idOf('gwen.group.1') };
    const queued = await runAs(owner, ws, 'outreach.send.queue', {
      profileId: gwen.profileId,
      kind: 'partner_ask',
      text: 'Would you be open to a partnership?',
    });
    expect(queued).toMatchObject({ state: 'waiting', needsYou: PARTNER_WORDS.needsYou });
    // On the list with its draft, waiting.
    expect((await stepsFor(gwen.profileId))[0]).toMatchObject({
      kind: 'partner_ask',
      send: { sendId: queued.sendId, state: 'waiting' },
    });
    // Approve all passes over it.
    expect((await runAs(owner, ws, 'outreach.send.approve', {})).approved).toEqual([]);
    await runAs(owner, ws, 'outreach.send.approve', { sends: [{ sendId: queued.sendId }] });
    await runAs(owner, ws, 'outreach.send.done', { sendId: queued.sendId, sent: true });
    await runAs(owner, ws, 'outreach.touch.save', {
      kind: 'message',
      profile: fb('gwen.group.1'),
      name: 'gwen',
    });
    expect(await row(await partnerOf(gwen.profileId))).toMatchObject({
      stage: 'asked',
      asked: true,
    });
    expect(await stepsFor(gwen.profileId)).toEqual([]);
  });

  it('follows up a week after the ask, at most twice', async () => {
    const profileId = await idOf('gwen.group.1');
    const id = await partnerOf(profileId);
    await rows(
      admin(),
      sql`update addon_outreach.partners set asked_at = ${daysAgo(8)}::timestamptz where id = ${id}`,
    );
    await rows(
      admin(),
      sql`update addon_outreach.touches set at = ${daysAgo(8)}::timestamptz
          where profile_id = ${profileId} and kind = 'message'`,
    );
    for (const nth of [1, 2]) {
      expect((await stepsFor(profileId)).map((s) => s.kind)).toEqual(['partner_follow_up']);
      await sent(profileId, 'gwen.group.1', 'partner_follow_up');
      expect((await row(id)).follow_ups).toBe(nth);
      await rows(
        admin(),
        sql`update addon_outreach.partners set followed_at = ${daysAgo(8)}::timestamptz where id = ${id}`,
      );
      await rows(
        admin(),
        sql`update addon_outreach.touches set at = ${daysAgo(8)}::timestamptz
            where profile_id = ${profileId} and kind = 'message'`,
      );
    }
    expect(await stepsFor(profileId)).toEqual([]);
  });

  it('owes a reply when they write, and after a yes sends the details with the partner link', async () => {
    const profileId = await idOf('gwen.group.1');
    const id = await partnerOf(profileId);
    await rows(
      admin(),
      sql`insert into addon_outreach.replies (workspace_id, user_id, profile_id, after_at, seen_at, pushed)
          values (${ws}, ${owner.id}, ${profileId}, ${daysAgo(1)}::timestamptz, now(), false)`,
    );
    expect((await stepsFor(profileId)).map((s) => s.kind)).toEqual(['partner_reply']);
    // The worker read a yes in it while drafting the reply.
    expect(
      await runAsSystem(ws, 'outreach.partner.answer', {
        userId: owner.id,
        profileId,
        answer: 'yes',
      }),
    ).toEqual({ stage: 'interested' });
    const [details] = await stepsFor(profileId);
    expect(details).toMatchObject({ kind: 'partner_details' });
    expect(readPartnerRef(new URL(details!.demoLink!).searchParams.get('ref'))).toEqual({
      userId: owner.id,
      profileId,
    });
    await sent(profileId, 'gwen.group.1', 'partner_details');
    expect(await row(id)).toMatchObject({ stage: 'interested', details: true, answer: 'yes' });
    expect(await stepsFor(profileId)).toEqual([]);
  });

  it('counts a call booked through the partner link as theirs, never as a demo', async () => {
    const profileId = await idOf('gwen.group.1');
    const id = await partnerOf(profileId);
    expect(
      await runAsSystem(ws, 'outreach.partner.call', {
        ref: partnerRef(owner.id, profileId),
        appointmentId: randomUUID(),
        at: new Date().toISOString(),
      }),
    ).toEqual({ noted: true });
    expect(await row(id)).toMatchObject({ stage: 'call_booked', call: true });
    const [demos] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from addon_outreach.demos where profile_id = ${profileId}`,
    );
    expect(demos!.n).toBe(0);
    // Someone else's ref, or a made-up one, notes nothing.
    expect(
      await runAsSystem(ws, 'outreach.partner.call', {
        ref: partnerRef(randomUUID(), profileId),
        appointmentId: randomUUID(),
        at: new Date().toISOString(),
      }),
    ).toEqual({ noted: false });
  });

  it('sets aside someone who said no, and asks them again after 90 days', async () => {
    const hal = await found('hal.host.2');
    await rows(
      admin(),
      sql`update addon_outreach.profiles set warm_up_missed_at = now() where id = ${hal.profileId}`,
    );
    expect((await stepsFor(hal.profileId)).map((s) => s.kind)).toEqual(['partner_ask']);
    await sent(hal.profileId, 'hal.host.2', 'partner_ask');
    expect(
      await runAsSystem(ws, 'outreach.partner.answer', {
        userId: owner.id,
        profileId: hal.profileId,
        answer: 'no',
      }),
    ).toEqual({ stage: 'not_now' });
    expect(await stepsFor(hal.profileId)).toEqual([]);
    await rows(
      admin(),
      sql`update addon_outreach.partners set not_now_at = ${daysAgo(91)}::timestamptz where id = ${hal.partnerId}`,
    );
    expect((await stepsFor(hal.profileId)).map((s) => s.kind)).toEqual(['partner_ask']);
  });

  it('leaves asks to partner out of the main offer’s numbers', async () => {
    // Gwen and Hal were each sent an ask, noted as their first messages: neither is a pitch of the offer.
    const [noted] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from addon_outreach.touches
          where workspace_id = ${ws} and step = 'first_message'`,
    );
    expect(noted!.n).toBe(2);
    const numbers = await runAs(owner, ws, 'outreach.tracking', { period: 'month' });
    expect(numbers.numbers).toMatchObject({ messages: 0 });
  });

  it('asks at most 3 a day, so customers’ first messages still go', async () => {
    const more = await Promise.all(
      ['ida.ideas.3', 'jo.jams.4', 'kit.kits.5', 'lu.lists.6'].map((u) => found(u)),
    );
    await rows(
      admin(),
      sql`update addon_outreach.profiles set warm_up_missed_at = now()
          where id = any (${`{${more.map((m) => m.profileId).join(',')}}`}::uuid[])`,
    );
    // Gwen's and Hal's asks went today: one more fits in today's three.
    const [went] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from addon_outreach.sends
          where workspace_id = ${ws} and kind = 'partner_ask' and state = 'sent'`,
    );
    expect(went!.n).toBe(2);
    expect((await partnerSteps()).filter((s) => s.kind === 'partner_ask')).toHaveLength(1);
    // The day before, all three were free.
    await rows(
      admin(),
      sql`update addon_outreach.sends set done_at = ${daysAgo(1)}::timestamptz
          where workspace_id = ${ws} and kind = 'partner_ask'`,
    );
    expect((await partnerSteps()).filter((s) => s.kind === 'partner_ask')).toHaveLength(3);
  });

  it('notes an ask copied to send by hand as one the extension sent', async () => {
    const ida = { profileId: await idOf('ida.ideas.3') };
    const id = await partnerOf(ida.profileId);
    expect(
      await runAs(owner, ws, 'outreach.conversation.note', {
        profileId: ida.profileId,
        kind: 'partner_ask',
      }),
    ).toEqual({ noted: true });
    expect(await row(id)).toMatchObject({ stage: 'asked', asked: true });
    // Never a customer conversation.
    const [conversations] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from addon_outreach.follow_ups where profile_id = ${ida.profileId}`,
    );
    expect(conversations!.n).toBe(0);
  });

  it('shows the person’s own asks, yeses, calls and partners made in Results', async () => {
    const gwen = await partnerOf(await idOf('gwen.group.1'));
    await runAs(owner, ws, 'outreach.partner.mark', { partnerId: gwen, mark: 'partner' });
    // Gwen asked 8 days ago, Hal and Ida today; Gwen said yes, booked her call, and is a partner now.
    expect((await runAs(owner, ws, 'outreach.activity', { period: 'month' })).partners).toEqual({
      asked: 3,
      interested: 1,
      calls: 1,
      partners: 1,
    });
    expect((await runAs(owner, ws, 'outreach.activity', { period: 'week' })).partners).toEqual({
      asked: 2,
      interested: 1,
      calls: 1,
      partners: 1,
    });
    // Each person's Partners list is their own: the team's results leave it out.
    expect(
      (await runAs(owner, ws, 'outreach.activity', { period: 'month', everyone: true })).partners,
    ).toBeNull();
  });
});
