/**
 * Social Outreach's safety for new accounts (docs/outreach.md, decisions 96 and 97): a network's daily limits are half
 * for the first 2 weeks after the person's first step there, 2 more for an account under a year old, unless they go
 * full speed there (decision 138); and no new friend requests while 200 of theirs wait for an answer, or once their
 * friends near the network's cap.
 */
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUTOMATION_DEFAULTS,
  choicesFor,
  freshState,
  freshWords,
  halvedNow,
  NO_RULES,
  wheelsWords,
} from '../../src/addons/outreach/automation';
import { requestsHeldWords, withNetwork } from '../../src/addons/outreach/network-words';
import { limitsShownOn } from '../../src/addons/outreach/settings-parts';
import { requestsHeldOn } from '../../src/addons/outreach/today';
import { outreachBusiness, runAs } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const DAY = 86_400_000;

afterAll(closeTestDbs);
const first = Date.parse('2026-10-01T15:00:00Z');

describe('half limits on a network new to the person', () => {
  it('start before the first step there, and last 2 weeks from it', () => {
    expect(freshState(null, false, first)).toEqual({ on: true, from: null, until: null, days: 14 });
    const fresh = freshState(new Date(first), false, first + 13 * DAY);
    expect(fresh).toEqual({
      on: true,
      from: '2026-10-01T15:00:00.000Z',
      until: '2026-10-15T15:00:00.000Z',
      days: 14,
    });
    expect(freshState(new Date(first), false, first + 14 * DAY).on).toBe(false);
  });

  it('last 2 weeks more for an account under a year old', () => {
    expect(freshState(new Date(first), true, first + 20 * DAY)).toMatchObject({
      on: true,
      until: '2026-10-29T15:00:00.000Z',
      days: 28,
    });
    expect(freshState(new Date(first), true, first + 28 * DAY).on).toBe(false);
    expect(freshState(null, true, first).days).toBe(28);
  });

  it('say so in the network’s name, with the day they end once there’s a first step', () => {
    expect(freshWords(freshState(null, false, first), 'linkedin')).toBe(
      'New on LinkedIn: your daily limits there start at half, for your first 2 weeks, so LinkedIn gets used to you slowly.',
    );
    expect(freshWords(freshState(null, true, first), 'alignable')).toMatch(/first 4 weeks/);
    expect(freshWords(freshState(new Date(first), false, first), 'instagram')).toMatch(
      /^New on Instagram: your daily limits there are half until \w+day, October 15/,
    );
  });

  it('halve the limits a network’s page shows', () => {
    const most = (slower: boolean) =>
      limitsShownOn('facebook', NO_RULES, slower).find((l) => l.key === 'friend_request')!.most;
    expect([most(false), most(true)]).toEqual([20, 10]);
  });

  it('keep the account’s age with each network, Facebook’s too', () => {
    const young = withNetwork(AUTOMATION_DEFAULTS, 'facebook', { young: true });
    expect(young.networks.facebook).toEqual({
      on: true,
      young: true,
      fullSpeed: false,
      tidy: 'cancel',
      requests: 'fits',
    });
    expect(choicesFor(young, 'facebook').young).toBe(true);
    expect(choicesFor(young, 'linkedin').young).toBe(false);
    // Facebook's own choices stay the settings' fields: the account's age isn't one.
    expect('young' in young).toBe(false);
    const linkedin = withNetwork(AUTOMATION_DEFAULTS, 'linkedin', { young: true });
    expect(choicesFor(linkedin, 'linkedin').young).toBe(true);
    expect(choicesFor(linkedin, 'facebook').young).toBe(false);
  });

  it('go whole on a network the person picked Full speed on, training wheels or not', () => {
    const on = { on: true };
    const off = { on: false };
    const choices = (settings = AUTOMATION_DEFAULTS, p: 'facebook' | 'linkedin' = 'facebook') =>
      choicesFor(settings, p);
    expect(halvedNow({ wheels: off, fresh: on, choices: choices() })).toBe(true);
    expect(halvedNow({ wheels: on, fresh: off, choices: choices() })).toBe(true);
    expect(halvedNow({ wheels: off, fresh: off, choices: choices() })).toBe(false);
    const full = withNetwork(AUTOMATION_DEFAULTS, 'linkedin', { fullSpeed: true });
    expect(halvedNow({ wheels: on, fresh: on, choices: choices(full, 'linkedin') })).toBe(false);
    // Each network's own: Facebook stays at half.
    expect(halvedNow({ wheels: on, fresh: on, choices: choices(full, 'facebook') })).toBe(true);
    const facebook = withNetwork(AUTOMATION_DEFAULTS, 'facebook', { fullSpeed: true });
    expect(choicesFor(facebook, 'facebook').fullSpeed).toBe(true);
    expect('fullSpeed' in facebook).toBe(false);
  });

  it('leave half limits out of training wheels’ words at full speed', () => {
    const wheels = { on: true, from: null, ok: 25, daysLeft: 0, edits: 0 };
    expect(wheelsWords(wheels)).toMatch(/and your daily limits are half/);
    expect(wheelsWords(wheels, true)).toBe('Training wheels: every message waits for your OK.');
  });
});

describe('no new friend requests', () => {
  it('while 200 of the person’s wait for an answer', () => {
    expect(requestsHeldOn('facebook', { waiting: 199, friends: 1_500 })).toBeNull();
    expect(requestsHeldOn('facebook', { waiting: 200, friends: 1_500 })).toEqual({
      why: 'waiting',
      count: 200,
      most: 200,
      extension: 0,
      cancelling: 0,
      cancelMost: null,
    });
    // How many the extension sent, and Cancel all's left (decision 121), for the note's buttons.
    expect(
      requestsHeldOn('facebook', { waiting: 207, friends: 1_489, extension: 7, cancelling: 0 }),
    ).toMatchObject({ count: 207, extension: 7, cancelling: 0 });
    expect(requestsHeldOn('linkedin', { waiting: 212, friends: 300 })).toMatchObject({
      why: 'waiting',
    });
  });

  it('once their friends come within 100 of the network’s cap: 4,900 on Facebook', () => {
    expect(requestsHeldOn('facebook', { waiting: 0, friends: 4_899 })).toBeNull();
    expect(requestsHeldOn('facebook', { waiting: 250, friends: 4_900 })).toEqual({
      why: 'cap',
      count: 4_900,
      most: 4_900,
      extension: 0,
      cancelling: 0,
      cancelMost: null,
    });
    expect(requestsHeldOn('alignable', { waiting: 0, friends: 9_900 })).toMatchObject({
      why: 'cap',
      most: 9_900,
    });
  });

  it('never on a follow network, whose follows wait for nobody', () => {
    expect(requestsHeldOn('instagram', { waiting: 900, friends: 7_450 })).toBeNull();
  });

  it('says why, and what lets them start again, in the network’s words', () => {
    expect(requestsHeldWords({ why: 'waiting', count: 201, most: 200 }, 'facebook')).toBe(
      'No new friend requests for now: 201 of yours are still waiting for an answer, and Facebook watches accounts with many. They start again under 200. Cancel all cancels them however new, 60 a day, or tick some under Old friend requests in Tidy up on the Friends tab.',
    );
    // While Cancel all is going (decision 121), how many it has left.
    expect(
      requestsHeldWords({ why: 'waiting', count: 207, most: 200, cancelling: 199 }, 'facebook'),
    ).toMatch(/They start again under 200\. Cancelling all of them: 199 left, 30 a day\.$/);
    // At twice the pace while 100 or more wait (decision 126, answer 9a), as Today says.
    expect(
      requestsHeldWords(
        { why: 'waiting', count: 207, most: 200, cancelling: 199, cancelMost: 60 },
        'facebook',
      ),
    ).toMatch(/Cancelling all of them: 199 left, 60 a day\.$/);
    expect(requestsHeldWords({ why: 'waiting', count: 230, most: 200 }, 'linkedin')).toMatch(
      /^No new invitations to connect for now: 230 of yours .* under Old invitations in Tidy up/,
    );
    expect(requestsHeldWords({ why: 'cap', count: 4_910, most: 4_900 }, 'facebook')).toBe(
      'No new friend requests for now: you have 4,910 friends on Facebook, close to its cap of 5,000. To make room, unfriend some under Tidy up on the Friends tab.',
    );
    // LinkedIn's tidying never removes a connection.
    expect(requestsHeldWords({ why: 'cap', count: 29_950, most: 29_900 }, 'linkedin')).toMatch(
      /To make room, remove some connections on LinkedIn\.$/,
    );
  });
});

describe('a person new to a network, in the business', () => {
  let owner: TestUser;
  let member: TestUser;
  let ws: string;
  let older: string;
  const today = (u: TestUser, where = ws) => runAs(u, where, 'outreach.today', {});
  const requestsMost = async (u: TestUser, where = ws) =>
    (await today(u, where)).limits.friend_request.most as number;
  const backdate = (u: TestUser, days: number) =>
    rows(
      admin(),
      sql`update addon_outreach.network_starts set first_at = now() - make_interval(days => ${days})
          where workspace_id = ${ws} and user_id = ${u.id} and platform = 'facebook'`,
    );

  beforeAll(async () => {
    [owner, member] = await Promise.all([
      createTestUser('outn-owner', { fullName: 'Quinn Owner' }),
      createTestUser('outn-member', { fullName: 'Avery Member' }),
    ]);
    ws = await outreachBusiness(owner, 'New Networks Co', { newAccounts: true });
    older = await outreachBusiness(owner, 'Old Hands Co');
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: member.id, role: 'member' });
  }, 60_000);

  it('gets half the daily limits before their first step there, and whole ones once past their 2 weeks', async () => {
    expect(await requestsMost(owner, older)).toBe(20);
    const before = await today(owner);
    expect(before.fresh).toEqual({ on: true, from: null, until: null, days: 14 });
    expect(before.limits.friend_request.most).toBe(10);
  });

  it('counts the 2 weeks from their first step there, kept on its own network', async () => {
    const at = new Date(Date.now() - 3 * DAY);
    await runAs(
      owner,
      ws,
      'outreach.touch.save',
      {
        kind: 'like',
        profile: {
          id: null,
          username: 'jordan.vale.3',
          url: 'https://www.facebook.com/jordan.vale.3',
        },
        name: 'Jordan Vale',
        postUrl: 'https://www.facebook.com/jordan.vale.3/posts/9001',
      },
      at,
    );
    const fresh = (await today(owner)).fresh;
    expect(fresh).toMatchObject({ on: true, from: at.toISOString(), days: 14 });
    expect(fresh.until).toBe(new Date(at.getTime() + 14 * DAY).toISOString());
    // A step noted later that was taken earlier, as from a browser that was offline, moves it back.
    const earlier = new Date(Date.now() - 5 * DAY);
    await runAs(
      owner,
      ws,
      'outreach.touch.save',
      {
        kind: 'friend_request',
        profile: { id: null, username: 'sky.marsh.8', url: 'https://www.facebook.com/sky.marsh.8' },
        name: 'Sky Marsh',
      },
      earlier,
    );
    expect((await today(owner)).fresh.from).toBe(earlier.toISOString());
    const shown = await runAs(owner, ws, 'outreach.automation', {});
    expect(shown.fresh.facebook.from).toBe(earlier.toISOString());
    expect(shown.fresh.linkedin).toEqual({ on: true, from: null, until: null, days: 14 });
    await backdate(owner, 15);
    expect((await today(owner)).fresh.on).toBe(false);
    expect(await requestsMost(owner)).toBe(20);
  });

  it('keeps them at half 2 weeks more for an account under a year old', async () => {
    await runAs(owner, ws, 'outreach.automation.save', {
      settings: withNetwork(AUTOMATION_DEFAULTS, 'facebook', { young: true }),
    });
    expect((await today(owner)).fresh).toMatchObject({ on: true, days: 28 });
    expect(await requestsMost(owner)).toBe(10);
    await backdate(owner, 29);
    expect((await today(owner)).fresh.on).toBe(false);
  });

  it('shows an owner a teammate’s, and keeps each person’s own', async () => {
    await runAs(member, ws, 'outreach.touch.save', {
      kind: 'like',
      profile: { id: null, username: 'reese.lane.4', url: 'https://www.facebook.com/reese.lane.4' },
      name: 'Reese Lane',
      postUrl: 'https://www.facebook.com/reese.lane.4/posts/9002',
    });
    const theirs = await runAs(owner, ws, 'outreach.automation', { userId: member.id });
    expect(theirs.fresh.facebook).toMatchObject({ on: true, days: 14 });
    expect(theirs.fresh.facebook.from).not.toBeNull();
    expect((await runAs(member, ws, 'outreach.automation', {})).fresh.facebook.from).toBe(
      theirs.fresh.facebook.from,
    );
  });

  it('gets the whole daily limits at once on a network they go full speed on', async () => {
    expect(await requestsMost(member)).toBe(10);
    const settings = (await runAs(member, ws, 'outreach.automation', {})).settings;
    await runAs(member, ws, 'outreach.automation.save', {
      settings: withNetwork(settings, 'facebook', { fullSpeed: true }),
    });
    const list = await today(member);
    expect(list.limits.friend_request.most).toBe(20);
    expect(list.fullSpeed).toBe(true);
    expect(list.fresh.on).toBe(false);
    // The 2 weeks are still kept, for the settings page.
    expect((await runAs(member, ws, 'outreach.automation', {})).fresh.facebook.on).toBe(true);
  });
});

describe('no new friend requests, in the business', () => {
  let owner: TestUser;
  let ws: string;
  const waiting = (count: number, from: number) =>
    rows(
      admin(),
      sql`with p as (
            insert into addon_outreach.profiles
              (workspace_id, platform, username, url, name, friendship, last_seen_at)
            select ${ws}, 'facebook', 'waiting.person.' || i, 'https://www.facebook.com/waiting.person.' || i,
              'Waiting Person ' || i, 'request_sent', now()
            from generate_series(${from}::int, ${from + count - 1}::int) i
            returning id)
          insert into addon_outreach.friends (workspace_id, user_id, profile_id, state, since, seen_at)
          select ${ws}, ${owner.id}, p.id, 'request_sent', now() - interval '5 days', now() from p`,
    );

  beforeAll(async () => {
    owner = await createTestUser('outh-owner', { fullName: 'Rowan Owner' });
    ws = await outreachBusiness(owner, 'Many Waiting Co');
  }, 60_000);

  it('stop while 200 of the person’s wait for an answer, and say why', async () => {
    await waiting(199, 1);
    expect((await runAs(owner, ws, 'outreach.today', {})).requestsHeld).toBeNull();
    await waiting(1, 200);
    expect((await runAs(owner, ws, 'outreach.today', {})).requestsHeld).toEqual({
      why: 'waiting',
      count: 200,
      most: 200,
      extension: 0,
      cancelling: 0,
      // Cancel all's pace: the usual 30 a day while it isn't going (decision 126, answer 9a).
      cancelMost: 30,
    });
    // LinkedIn's invitations are their own.
    expect(
      (await runAs(owner, ws, 'outreach.today', { platform: 'linkedin' })).requestsHeld,
    ).toBeNull();
  });
});
