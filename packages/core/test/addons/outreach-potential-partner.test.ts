/**
 * Social Outreach: marking someone as a potential partner (docs/outreach.md, decision 130; the owner's answers "1a 2a 3a
 * 4a 5b 6a 7a 8a"). Potential partner in the person menu puts anyone on the person's Partners list, with or without a
 * partner playbook: their customer messages waiting for an OK give way, they're liked first and asked a day later, and
 * the AI reads their profile for what kind of partner they are, its "not" never taking them off. A call booked through
 * their link counts as Call booked and as Demo booked. Not a partner after all puts them back on customer messages.
 * The customer check says when someone looks more like a partner.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHECK_SCHEMA, checkedAnswer } from '../../src/addons/outreach/checks';
import { partnerRef } from '../../src/addons/outreach/demos';
import {
  PARTNER_DEMO_TASK,
  PARTNER_MARKED_ASK,
  PARTNER_WORDS,
  partnerDraftPrompt,
  partnerPrompt,
} from '../../src/addons/outreach/partners';
import { personMenuItems, type ProfileMarksOutput } from '../../src/addons/outreach/person-menu';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { OUTREACH_WORDS } from '../../src/addons/outreach/words';
import { outreachBusiness, refused, runAs, runAsSystem } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();
const P = OUTREACH_WORDS.person;

describe('a potential partner’s words', () => {
  const draft = (kind: 'partner_ask' | 'partner_details' | 'partner_reply', marked: boolean) =>
    partnerDraftPrompt({
      kind,
      business: 'Summit Roofing',
      name: 'Gail Admin',
      helps: null,
      partner: { kind: 'business', audience: null, why: [] },
      facts: [],
      recent: [],
      playbook: null,
      marked,
      link: 'https://book.example.com/demo?ref=sp-x',
    });

  it('lead with partnering, and once they’re interested offer a demo with the link, playbook or not', () => {
    expect(draft('partner_ask', true)).not.toContain(PARTNER_DEMO_TASK);
    expect(draft('partner_ask', true)).not.toMatch(/this link/);
    for (const kind of ['partner_details', 'partner_reply'] as const) {
      expect(draft(kind, true)).toContain(PARTNER_DEMO_TASK);
      expect(draft(kind, true)).toContain('https://book.example.com/demo?ref=sp-x');
      // Someone the AI found is never offered a demo.
      expect(draft(kind, false)).not.toContain(PARTNER_DEMO_TASK);
    }
  });

  it('ask the AI to read someone marked for the messages, not to judge them', () => {
    const prompt = (marked: boolean) =>
      partnerPrompt({
        business: 'Summit Roofing',
        name: 'Gail Admin',
        facts: [],
        lines: ['Agency for roofers'],
        playbooks: [],
        marked,
      });
    expect(prompt(true)).toContain(PARTNER_MARKED_ASK);
    expect(prompt(false)).not.toContain(PARTNER_MARKED_ASK);
  });

  it('come back from the customer check when someone looks more like a partner', () => {
    expect((CHECK_SCHEMA.required as string[]).includes('partner')).toBe(true);
    const answer = {
      fit: 'maybe' as const,
      playbook: null,
      why: [],
      about: 'Runs a marketing agency for roofers',
      nextStep: null,
      partner: '  Runs an agency   whose clients are roofers ',
    };
    expect(checkedAnswer(answer, []).partner).toBe('Runs an agency whose clients are roofers');
    expect(checkedAnswer({ ...answer, partner: null }, []).partner).toBeNull();
  });
});

describe('the person menu’s Potential partner', () => {
  const marks = (over: Partial<ProfileMarksOutput>): ProfileMarksOutput => ({
    profileId: randomUUID(),
    name: 'Gail',
    platform: 'facebook',
    url: 'https://www.facebook.com/gail',
    personId: null,
    partner: false,
    demoBooked: false,
    client: { on: false, tagged: false, because: null },
    laterUntil: null,
    dontPitch: null,
    neverContact: null,
    canTakeOff: { dontPitch: false, neverContact: false },
    ...over,
  });
  const keys = (m: ProfileMarksOutput) =>
    personMenuItems({
      row: { url: m.url, platform: 'facebook' },
      marks: m,
      contactsWrite: true,
      online: true,
    }).map((i) => i.key);

  it('shows for anyone not on the person’s list, under why the AI thinks so when it does', () => {
    expect(keys(marks({}))).toContain('potential-partner');
    const items = personMenuItems({
      row: { url: null, platform: 'facebook' },
      marks: marks({ partnerHint: 'Runs a group of 3,000 homeowners' }),
      contactsWrite: true,
      online: true,
    });
    const at = items.findIndex((i) => i.key === 'potential-partner');
    expect(items[at - 1]).toMatchObject({
      key: 'partner-hint',
      kind: 'line',
      label: P.partnerHint('Runs a group of 3,000 homeowners'),
    });
  });

  it('turns to Not a partner after all on the list, keeps Demo booked for someone marked, and never for a partner', () => {
    const marked = keys(marks({ partner: true, myPartner: { stage: 'found', marked: true } }));
    expect(marked).toContain('not-partner');
    expect(marked).toContain('demo');
    expect(marked).not.toContain('mark-client');
    const found = keys(marks({ partner: true, myPartner: { stage: 'asked', marked: false } }));
    expect(found).toContain('not-partner');
    expect(found).not.toContain('demo');
    const partner = keys(marks({ partner: true, myPartner: { stage: 'partner', marked: true } }));
    expect(partner).not.toContain('not-partner');
    expect(partner).not.toContain('potential-partner');
  });

  it('is left out for someone on Don’t pitch or Never contact', () => {
    const on = { by: null, at: new Date().toISOString(), tagged: false };
    expect(keys(marks({ dontPitch: on as never }))).not.toContain('potential-partner');
    expect(keys(marks({ neverContact: on as never }))).not.toContain('potential-partner');
  });
});

describe('marking a potential partner', () => {
  let owner: TestUser;
  let ws: string;
  const LINK = 'https://book.example.com/demo';
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
  const row = async (profileId: string) =>
    (
      await rows<{
        id: string;
        stage: string | null;
        fit: string;
        kind: string;
        marked: boolean;
        found_at: boolean;
        audience: string | null;
      }>(
        admin(),
        sql`select pa.id, pa.stage, pa.fit, pa.kind, pa.marked_at is not null as marked, pa.audience,
              p.partner_found_at is not null as found_at
            from addon_outreach.partners pa join addon_outreach.profiles p on p.id = pa.profile_id
            where pa.profile_id = ${profileId} and pa.user_id = ${owner.id}`,
      )
    )[0];
  const partnerSteps = async () =>
    (await runAs(owner, ws, 'outreach.today', {})).partners as {
      kind: string;
      profileId: string;
      why: string[];
      demoLink: string | null;
    }[];

  beforeAll(async () => {
    owner = await createTestUser('outpot-owner', { fullName: 'Pat Owner' });
    ws = await outreachBusiness(owner, 'Outreach Potential Partners Co');
    // A customer playbook with a demo link, and no partner playbook at all.
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: 'CRM demos',
      template: 'crm_demos',
      details: { ...PLAYBOOK_TEMPLATES.crm_demos.details, link: LINK },
    });
    await runAs(owner, ws, 'outreach.friends.save', {
      list: 'friends',
      people: ['mae.marks.1', 'ned.never.2', 'ola.other.3'].map((username) => ({
        profile: fb(username),
        name: username.split('.')[0]!,
        mutualFriends: null,
      })),
    });
  }, 60_000);
  afterAll(closeTestDbs);

  it('puts them on the list at Found, and sets aside customer messages waiting for an OK', async () => {
    const profileId = await idOf('mae.marks.1');
    const opener = await runAs(owner, ws, 'outreach.send.queue', {
      profileId,
      kind: 'opener',
      text: 'Hey, how’s the business going?',
    });
    const out = await runAs(owner, ws, 'outreach.partner.potential', {
      profileId,
      potential: true,
    });
    expect(out).toMatchObject({ stage: 'found', skipped: 1 });
    expect(await row(profileId)).toMatchObject({
      stage: 'found',
      fit: 'good',
      marked: true,
      found_at: true,
    });
    const [send] = await rows<{ state: string }>(
      admin(),
      sql`select state from addon_outreach.sends where id = ${opener.sendId}`,
    );
    expect(send!.state).toBe('skipped');
    // Marked again, nothing changes.
    expect(
      await runAs(owner, ws, 'outreach.partner.potential', { profileId, potential: true }),
    ).toMatchObject({ partnerId: out.partnerId, stage: 'found', skipped: 0 });
  });

  it('is read for the AI first, with no partner playbook, and the AI’s “not” leaves them on as a maybe', async () => {
    const profileId = await idOf('mae.marks.1');
    const next = await runAs(owner, ws, 'outreach.partners.next', {});
    expect(next.people.map((p: { profileId: string }) => p.profileId)).toEqual([profileId]);
    const looked = await runAs(owner, ws, 'outreach.partner.look', {
      profileId,
      kind: next.people[0].kind,
      lines: ['Owner at Roofers Marketing Co'],
    });
    // Read since marked: not read again.
    expect((await runAs(owner, ws, 'outreach.partners.next', {})).people).toEqual([]);
    const [kept] = await rows<{ looked_at: string }>(
      admin(),
      sql`select looked_at from addon_outreach.partners where id = ${looked.partnerId}`,
    );
    expect(
      await runAsSystem(ws, 'outreach.partner.save', {
        partnerId: looked.partnerId,
        lookedAt: new Date(kept!.looked_at).toISOString(),
        answer: {
          fit: 'not',
          playbookId: null,
          kind: 'business',
          audience: 'About 300 roofing companies',
          audienceSize: 300,
          why: ['Sells to roofers, not homeowners'],
          nextStep: 'Comment on their latest post',
        },
      }),
    ).toEqual({ saved: true, fit: 'maybe' });
    expect(await row(profileId)).toMatchObject({
      stage: 'found',
      fit: 'maybe',
      kind: 'business',
      audience: 'About 300 roofing companies',
      marked: true,
    });
  });

  it('likes them first and asks a day later, said to be marked, with any playbook’s link once they answer', async () => {
    const profileId = await idOf('mae.marks.1');
    const [warm] = (await partnerSteps()).filter((s) => s.profileId === profileId);
    expect(warm).toMatchObject({ kind: 'partner_warm_up', demoLink: null });
    expect(warm!.why[0]).toBe(PARTNER_WORDS.markedWhy);
    await runAs(owner, ws, 'outreach.touch.save', {
      kind: 'like',
      profile: fb('mae.marks.1'),
      name: 'mae',
      postUrl: 'https://www.facebook.com/mae.marks.1/posts/1',
    });
    const id = (await row(profileId))!.id;
    await rows(
      admin(),
      sql`update addon_outreach.partners set warmed_at = ${daysAgo(2)}::timestamptz where id = ${id}`,
    );
    expect(
      (await partnerSteps()).filter((s) => s.profileId === profileId).map((s) => s.kind),
    ).toEqual(['partner_ask']);
    // Interested: the details carry the customer playbook's link with their partner ref.
    await rows(
      admin(),
      sql`update addon_outreach.partners set stage = 'interested', interested_at = now() where id = ${id}`,
    );
    const [details] = (await partnerSteps()).filter((s) => s.profileId === profileId);
    expect(details).toMatchObject({ kind: 'partner_details' });
    expect(details!.demoLink).toContain(LINK);
    expect(details!.demoLink).toContain(partnerRef(owner.id, profileId));
  });

  it('counts a call booked through their link as Call booked and as Demo booked', async () => {
    const profileId = await idOf('mae.marks.1');
    const [person] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.people (workspace_id, first_name, last_name)
          values (${ws}, 'Mae', 'Marks') returning id`,
    );
    // The call they booked: a demo is kept against its appointment.
    const [cal] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.calendars (workspace_id, name, slug, status)
          values (${ws}, 'Partner calls', 'partner-calls', 'active') returning id`,
    );
    const [appt] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, title, starts_at, ends_at)
          values (${ws}, ${cal!.id}, 1, 'Partner call', now() + interval '1 day', now() + interval '1 day 30 minutes')
          returning id`,
    );
    expect(
      await runAsSystem(ws, 'outreach.partner.call', {
        ref: partnerRef(owner.id, profileId),
        appointmentId: appt!.id,
        at: new Date().toISOString(),
        personId: person!.id,
      }),
    ).toEqual({ noted: true });
    expect(await row(profileId)).toMatchObject({ stage: 'call_booked' });
    const [demo] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from addon_outreach.demos where profile_id = ${profileId} and how = 'link'`,
    );
    expect(demo!.n).toBe(1);
  });

  it('puts them back on customer messages with Not a partner after all', async () => {
    const profileId = await idOf('mae.marks.1');
    const marks = await runAs(owner, ws, 'outreach.profile.marks', { profileId });
    expect(marks.myPartner).toEqual({ stage: 'call_booked', marked: true });
    expect(
      await runAs(owner, ws, 'outreach.partner.potential', { profileId, potential: false }),
    ).toMatchObject({ stage: null });
    expect(await row(profileId)).toMatchObject({
      stage: null,
      fit: 'not',
      marked: false,
      found_at: false,
    });
    expect((await runAs(owner, ws, 'outreach.profile.marks', { profileId })).myPartner).toBeNull();
  });

  it('is refused for someone on Never contact', async () => {
    const profileId = await idOf('ned.never.2');
    await runAs(owner, ws, 'outreach.friend.set', { profileId, neverContact: true });
    expect(
      await refused(runAs(owner, ws, 'outreach.partner.potential', { profileId, potential: true })),
    ).toBe('outreach_partner_never');
    expect(await row(profileId)).toBeUndefined();
  });

  it('shows the customer check’s word that someone looks more like a partner, till they’re marked', async () => {
    const profileId = await idOf('ola.other.3');
    await rows(
      admin(),
      sql`insert into addon_outreach.checks (workspace_id, user_id, profile_id, verdict, looked_at, checked_at,
            partner_hint)
          values (${ws}, ${owner.id}, ${profileId}, 'maybe', now(), now(), 'Runs a group of 3,000 homeowners')`,
    );
    expect((await runAs(owner, ws, 'outreach.profile.marks', { profileId })).partnerHint).toBe(
      'Runs a group of 3,000 homeowners',
    );
    await runAs(owner, ws, 'outreach.partner.potential', { profileId, potential: true });
    expect(
      (await runAs(owner, ws, 'outreach.profile.marks', { profileId })).partnerHint,
    ).toBeNull();
  });
});
