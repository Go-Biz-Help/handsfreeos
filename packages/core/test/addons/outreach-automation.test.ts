/**
 * Social Outreach: the extension on its own (docs/outreach.md, decisions 26 to 33). Each person's own choices, the
 * defaults until they save theirs; liking one of someone's posts a day before their friend request, and the request
 * going without when there's no post; requests the person got from people who fit a playbook, to confirm; and the
 * steps the extension took itself, marked as its own. Then the settings in HandsFreeOS (decisions 37 to 40): the
 * business's rules and defaults, an owner or admin changing someone else's, and the extension's summary.
 */
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUTOMATION_DEFAULTS,
  autoKinds,
  BusinessRules,
  hoursWords,
  inWorkingHours,
  settingsSummary,
  withinRules,
  workWindow,
} from '../../src/addons/outreach/automation';
import { dailyLimitsNow } from '../../src/addons/outreach/limits';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { outreachBusiness, refused, runAs } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const fb = (username: string) => ({
  id: null,
  username,
  url: `https://www.facebook.com/${username}`,
});

describe('working hours', () => {
  const hours = { start: 9, end: 17, days: [1, 2, 3, 4, 5] };

  it('are on the business’s clock, on the days ticked', () => {
    // Friday 9 October 2026: 10 AM in Chicago is 15:00 UTC.
    const friday10 = Date.UTC(2026, 9, 9, 15);
    expect(workWindow(hours, 'America/Chicago', friday10)).toEqual({
      from: Date.UTC(2026, 9, 9, 14),
      to: Date.UTC(2026, 9, 9, 22),
    });
    expect(inWorkingHours(hours, 'America/Chicago', friday10)).toBe(true);
    expect(inWorkingHours(hours, 'America/Chicago', Date.UTC(2026, 9, 9, 23))).toBe(false);
    // Saturday.
    expect(workWindow(hours, 'America/Chicago', Date.UTC(2026, 9, 10, 15))).toBeNull();
  });

  it('read plainly', () => {
    expect(hoursWords(hours)).toBe('9 AM to 5 PM, Mon to Fri');
    expect(hoursWords({ start: 0, end: 12, days: [0, 6] })).toBe('midnight to noon, Sun, Sat');
    expect(hoursWords({ start: 8, end: 24, days: [0, 1, 2, 3, 4, 5, 6] })).toBe(
      '8 AM to midnight, every day',
    );
  });

  it('leave messages to the person, whatever they pick', () => {
    expect(autoKinds(AUTOMATION_DEFAULTS)).toEqual([]);
    expect(autoKinds({ ...AUTOMATION_DEFAULTS, sending: 'steps' })).toEqual([
      'confirm',
      'warm_up',
      'friend_request',
      'comment',
    ]);
    expect(
      autoKinds({
        ...AUTOMATION_DEFAULTS,
        sending: 'steps',
        warmUp: false,
        confirmRequests: false,
      }),
    ).toEqual(['friend_request', 'comment']);
  });
});

describe('the extension on its own', () => {
  let owner: TestUser;
  let member: TestUser;
  let ws: string;
  const group = {
    id: '323456789',
    slug: null,
    url: 'https://www.facebook.com/groups/323456789/',
    name: 'Austin Trades Owners',
  };
  const member_ = (username: string, name: string, lines: string[], runsGroup = false) => ({
    profile: fb(username),
    name,
    lines,
    part: runsGroup ? 'Admins and moderators' : 'Members near you',
    runsGroup,
  });
  const list = () => runAs(owner, ws, 'outreach.today', {});
  const kinds = async () =>
    ((await list()).items as { kind: string; name: string }[]).map((i) => `${i.kind}: ${i.name}`);
  const steps = { ...AUTOMATION_DEFAULTS, sending: 'steps' as const };

  beforeAll(async () => {
    [owner, member] = await Promise.all([
      createTestUser('outa-owner', { fullName: 'Morgan Owner' }),
      createTestUser('outa-member', { fullName: 'Riley Member' }),
    ]);
    ws = await outreachBusiness(owner, 'Outreach On Its Own Co');
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: member.id, role: 'member' });
    const crm = PLAYBOOK_TEMPLATES.crm_demos;
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: crm.name,
      template: 'crm_demos',
      details: crm.details,
    });
    await runAs(owner, ws, 'outreach.group.save', {
      group,
      members: 12_400,
      adminsPage: true,
      people: [
        member_('jules.ortiz.7', 'Jules Ortiz', ['Owner at Ortiz Electric']),
        member_('noor.haddad.2', 'Noor Haddad', ['Founder of Haddad HVAC']),
        member_('ari.stone.1', 'Ari Stone', [], true),
      ],
    });
  }, 60_000);
  afterAll(closeTestDbs);

  it('keeps each person’s own choices, the defaults until they save', async () => {
    const before = await runAs(owner, ws, 'outreach.automation', {});
    expect(before).toMatchObject({ settings: AUTOMATION_DEFAULTS, saved: false });
    expect(typeof before.timezone).toBe('string');
    const saved = await runAs(owner, ws, 'outreach.automation.save', {
      settings: { ...steps, hours: { start: 8, end: 16, days: [5, 1, 1, 3] } },
    });
    expect(saved).toMatchObject({
      settings: { sending: 'steps', hours: { start: 8, end: 16, days: [1, 3, 5] } },
      saved: true,
    });
    // Saving again changes theirs, the once-a-day jobs too; someone else's stay the defaults.
    await runAs(owner, ws, 'outreach.automation.save', { settings: { ...steps, collect: false } });
    expect((await runAs(owner, ws, 'outreach.automation', {})).settings.collect).toBe(false);
    // An extension from before the once-a-day jobs saves without them: they're on.
    const { collect: _, ...older } = steps;
    await runAs(owner, ws, 'outreach.automation.save', { settings: older });
    expect((await runAs(owner, ws, 'outreach.automation', {})).settings.collect).toBe(true);
    await runAs(owner, ws, 'outreach.automation.save', { settings: steps });
    expect((await runAs(owner, ws, 'outreach.automation', {})).settings).toEqual(steps);
    // Their voice, kept; a screen from before it saves without one, and theirs stays.
    const voice = { shorthand: true, acronyms: true, emoji: false, split: false };
    await runAs(owner, ws, 'outreach.automation.save', { settings: { ...steps, voice } });
    const { voice: __, ...noVoice } = steps;
    await runAs(owner, ws, 'outreach.automation.save', { settings: noVoice });
    expect((await runAs(owner, ws, 'outreach.automation', {})).settings.voice).toEqual(voice);
    await runAs(owner, ws, 'outreach.automation.save', { settings: steps });
    expect((await runAs(member, ws, 'outreach.automation', {})).saved).toBe(false);
    expect(
      await refused(
        runAs(owner, ws, 'outreach.automation.save', {
          settings: { ...steps, hours: { start: 17, end: 9, days: [1] } },
        }),
      ),
    ).toBe('validation');
  });

  it('likes a post a day before the friend request, and sends it without when there’s none', async () => {
    const first = await list();
    expect(first.auto).toEqual(['confirm', 'warm_up', 'friend_request', 'comment']);
    expect(await kinds()).toEqual(['warm_up: Jules Ortiz', 'warm_up: Noor Haddad']);

    // Liked just now, by the extension: not yet; liked yesterday: their request is on.
    await runAs(owner, ws, 'outreach.touch.save', {
      kind: 'like',
      profile: fb('jules.ortiz.7'),
      name: 'Jules Ortiz',
      auto: true,
    });
    expect(await kinds()).toEqual(['warm_up: Noor Haddad']);
    await rows(
      admin(),
      sql`update addon_outreach.touches set at = at - interval '21 hours' where workspace_id = ${ws}`,
    );
    // Likes go before friend requests on the list (the main offer plan's order).
    expect(await kinds()).toEqual(['warm_up: Noor Haddad', 'friend_request: Jules Ortiz']);
    expect(
      (await list()).items.find((i: { kind: string }) => i.kind === 'friend_request')?.why,
    ).toContain('You liked a post of theirs');

    // No post of Noor's to like: the request goes without.
    const [noor] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_outreach.profiles where workspace_id = ${ws} and username = 'noor.haddad.2'`,
    );
    await runAs(owner, ws, 'outreach.warm_up.missed', { profileId: noor!.id });
    expect(await kinds()).toEqual(['friend_request: Jules Ortiz', 'friend_request: Noor Haddad']);
    expect(
      await refused(
        runAs(owner, ws, 'outreach.warm_up.missed', {
          profileId: '00000000-0000-4000-8000-000000000000',
        }),
      ),
    ).toBe('not_found');

    // The extension's own like is marked, with the group they were found in.
    const [like] = await rows<{ auto: boolean; group_id: string | null }>(
      admin(),
      sql`select auto, group_id from addon_outreach.touches where workspace_id = ${ws} and kind = 'like'`,
    );
    expect(like!.auto).toBe(true);
    expect(like!.group_id).not.toBeNull();
  });

  it('lists requests from people who fit a playbook well, to confirm', async () => {
    await runAs(owner, ws, 'outreach.friends.save', {
      list: 'requests',
      people: [
        { profile: fb('rowan.vale.4'), name: 'Rowan Vale', mutualFriends: 6 },
        { profile: fb('kit.morrow.8'), name: 'Kit Morrow', mutualFriends: 0 },
      ],
    });
    await rows(
      admin(),
      sql`update addon_outreach.profiles set intro = array['Owner at Vale Roofing']
          where workspace_id = ${ws} and username = 'rowan.vale.4'`,
    );
    const today = await list();
    const confirm = today.items.filter((i: { kind: string }) => i.kind === 'confirm');
    expect(confirm.map((i: { name: string }) => i.name)).toEqual(['Rowan Vale']);
    expect(confirm[0].why[0]).toBe('Asked to be your friend');

    await runAs(owner, ws, 'outreach.friend.note', {
      answer: 'confirm',
      profile: fb('rowan.vale.4'),
      name: 'Rowan Vale',
    });
    expect(await kinds()).not.toContain('confirm: Rowan Vale');
  });

  it('with Like a post first off, requests go straight away; with sending off, it’s all the person’s', async () => {
    await runAs(owner, ws, 'outreach.automation.save', {
      settings: { ...steps, warmUp: false },
    });
    expect((await list()).auto).toEqual(['confirm', 'friend_request', 'comment']);
    await runAs(owner, ws, 'outreach.automation.save', { settings: AUTOMATION_DEFAULTS });
    expect((await list()).auto).toEqual([]);
  });
});

describe('the business’s rules', () => {
  const rules = BusinessRules.parse({
    sendingAllowed: ['steps'],
    repliesAllowed: [],
    dailyLimits: { friend_request: 10, like: 0 },
  });

  it('always allow doing everything yourself, and every reply waiting', () => {
    expect(rules.sendingAllowed).toEqual(['off', 'steps']);
    expect(rules.repliesAllowed).toEqual(['draft']);
  });

  it('step a choice they stopped allowing back to the nearest one they allow', () => {
    const before = {
      ...AUTOMATION_DEFAULTS,
      sending: 'everything' as const,
      replies: 'simple' as const,
    };
    expect(withinRules(before, rules)).toMatchObject({ sending: 'steps', replies: 'draft' });
  });

  it('keep the daily limits under the starting ones, halved on training wheels', () => {
    const limits = dailyLimitsNow(false, rules.dailyLimits);
    expect(limits.friend_request).toBe(10);
    expect(limits.like).toBe(0);
    expect(dailyLimitsNow(true, rules.dailyLimits).friend_request).toBe(5);
    expect(() => BusinessRules.parse({ dailyLimits: { friend_request: 500 } })).toThrow();
  });

  it('read as a short summary for the extension', () => {
    expect(settingsSummary(AUTOMATION_DEFAULTS)).toEqual(['On its own: Off: you do everything']);
    expect(
      settingsSummary({
        ...AUTOMATION_DEFAULTS,
        sending: 'steps',
        replies: 'simple',
        readChats: false,
      }),
    ).toEqual([
      'On its own: Requests, likes and comments on their own; each message waits for you',
      'Replies: simple ones on their own',
      'When: 9 AM to 5 PM, Mon to Fri',
      'Off: reading chats you open',
    ]);
  });
});

describe('settings in HandsFreeOS', () => {
  let owner: TestUser;
  let member: TestUser;
  let other: TestUser;
  let ws: string;
  const steps = { ...AUTOMATION_DEFAULTS, sending: 'steps' as const };
  const setRules = (rules: Record<string, unknown>) =>
    runAs(owner, ws, 'addon.save_settings', { addonId: 'outreach', settings: { rules } });

  beforeAll(async () => {
    [owner, member, other] = await Promise.all([
      createTestUser('outs-owner', { fullName: 'Morgan Owner' }),
      createTestUser('outs-member', { fullName: 'Riley Member' }),
      createTestUser('outs-other', { fullName: 'Casey Elsewhere' }),
    ]);
    ws = await outreachBusiness(owner, 'Outreach Settings Co');
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: member.id, role: 'member' });
  }, 60_000);
  afterAll(closeTestDbs);

  it('keeps the switches and the push choice with the rest', async () => {
    const mine = { ...steps, noting: false, readChats: false, markPosts: true, pushes: 'each' };
    const saved = await runAs(member, ws, 'outreach.automation.save', { settings: mine });
    expect(saved).toMatchObject({ settings: mine, name: 'Riley Member', changedBy: null });
    expect(saved.rules.sendingAllowed).toEqual(['off', 'steps', 'approve_all', 'everything']);
    // An extension before 0.16 saves without them: they're on, and pushes are bundled.
    const { noting: _n, readChats: _r, markPosts: _m, pushes: _p, ...older } = steps;
    expect(
      (await runAs(member, ws, 'outreach.automation.save', { settings: older })).settings,
    ).toEqual(steps);
  });

  it('lets an owner see and change someone’s, and says who changed them', async () => {
    const theirs = await runAs(owner, ws, 'outreach.automation', { userId: member.id });
    expect(theirs).toMatchObject({ userId: member.id, name: 'Riley Member', saved: true });
    await runAs(owner, ws, 'outreach.automation.save', {
      userId: member.id,
      settings: { ...steps, warmUp: false },
    });
    const seen = await runAs(member, ws, 'outreach.automation', {});
    expect(seen).toMatchObject({ settings: { warmUp: false }, changedBy: 'Morgan Owner' });
    // Their own change clears it.
    await runAs(member, ws, 'outreach.automation.save', { settings: steps });
    expect((await runAs(member, ws, 'outreach.automation', {})).changedBy).toBeNull();

    const people = await runAs(owner, ws, 'outreach.automation.people', {});
    expect(people.people.map((p: { name: string; saved: boolean }) => [p.name, p.saved])).toEqual([
      ['Morgan Owner', false],
      ['Riley Member', true],
    ]);
  });

  it('keeps someone else’s settings to owners and admins, and to people here', async () => {
    expect(await refused(runAs(member, ws, 'outreach.automation', { userId: owner.id }))).toBe(
      'forbidden',
    );
    expect(
      await refused(
        runAs(member, ws, 'outreach.automation.save', { userId: owner.id, settings: steps }),
      ),
    ).toBe('forbidden');
    expect(await refused(runAs(member, ws, 'outreach.automation.people', {}))).toBe('forbidden');
    expect(await refused(runAs(owner, ws, 'outreach.automation', { userId: other.id }))).toBe(
      'not_found',
    );
  });

  it('holds everyone to the business’s rules, and gives a new person its defaults', async () => {
    await runAs(member, ws, 'outreach.automation.save', {
      settings: { ...steps, sending: 'everything', replies: 'simple' },
    });
    await setRules({
      sendingAllowed: ['steps'],
      repliesAllowed: [],
      dailyLimits: { friend_request: 10 },
      defaults: { ...steps, hours: { start: 8, end: 16, days: [1, 2, 3, 4] } },
    });
    // What they'd picked steps back.
    const now = await runAs(member, ws, 'outreach.automation', {});
    expect(now.settings).toMatchObject({ sending: 'steps', replies: 'draft' });
    expect(now.rules).toMatchObject({
      sendingAllowed: ['off', 'steps'],
      repliesAllowed: ['draft'],
    });
    const no = runAs(member, ws, 'outreach.automation.save', {
      settings: { ...steps, sending: 'everything' },
    });
    expect(await refused(no)).toBe('not_allowed');
    // The owner hasn't saved theirs: they start from the business's defaults.
    expect((await runAs(owner, ws, 'outreach.automation', {})).settings).toMatchObject({
      sending: 'steps',
      hours: { start: 8, end: 16, days: [1, 2, 3, 4] },
    });
    // The daily limits are the business's.
    const activity = await runAs(member, ws, 'outreach.activity', {});
    expect(activity.limits.friend_request).toBe(10);
  });
});
