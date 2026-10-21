/**
 * Social Outreach's networks in the app (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "Build order" step 3):
 * what the web and the phone show of each network. The words a screen says in a network's own (a connection, an
 * invitation to connect, LinkedIn messaging), Facebook's unchanged; the networks a person works; the live view, the
 * pipeline, the friends, the chats and Results for one network, or every one with each row's network; the setup's step
 * to pick them; and asks named by their network.
 *
 * LinkedIn's profiles, chats and steps are written here as the database would keep them, since nothing reads a
 * LinkedIn page yet.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActivityOutput } from '../../src/addons/outreach/activity';
import { cantAskWhy, latestAskOn } from '../../src/addons/outreach/asks';
import {
  autoKinds,
  AUTOMATION_DEFAULTS,
  NETWORKS_DEFAULTS,
  SENDING_MODES,
  type AutomationSettings,
} from '../../src/addons/outreach/automation';
import type { ChatsOutput } from '../../src/addons/outreach/chat-read';
import type { FriendsOutput } from '../../src/addons/outreach/friends';
import { DAILY_WORDS } from '../../src/addons/outreach/limits';
import { listsWaitWords, NO_LISTS } from '../../src/addons/outreach/lists';
import { dayWords } from '../../src/addons/outreach/live';
import {
  ALONG_TICKS,
  chatUrlOn,
  dailyWordsOn,
  NETWORK_FILTERS,
  NETWORK_WORDS,
  networkShown,
  networksOn,
  networksShown,
  openChatWords,
  readNetwork,
  sendingModesOn,
  shareWords,
  ticksOn,
  ticksShownOn,
  todayKindsOn,
  withNetwork,
} from '../../src/addons/outreach/network-words';
import {
  isLooking,
  networkOfLink,
  PLATFORM_KEYS,
  WORKING_PLATFORMS,
} from '../../src/addons/outreach/networks';
import { REPORT_WORDS } from '../../src/addons/outreach/reports';
import { setupSteps, setupSummary, SETUP_WORDS } from '../../src/addons/outreach/setup';
import type { StagesOutput } from '../../src/addons/outreach/stages';
import { TODAY_KINDS } from '../../src/addons/outreach/today';
import { OUTREACH_WORDS as W } from '../../src/addons/outreach/words';
import { outreachBusiness, runAs } from './outreach-fixture';

const admin = () => testDbs().admin.db;

const withLinkedIn = (on: boolean): AutomationSettings => ({
  ...AUTOMATION_DEFAULTS,
  networks: { ...NETWORKS_DEFAULTS, linkedin: { ...NETWORKS_DEFAULTS.linkedin, on } },
});

describe('a network’s words on screen', () => {
  it('keeps Facebook’s words as they were, and says LinkedIn’s in its own', () => {
    expect(dailyWordsOn('facebook')).toEqual(DAILY_WORDS);
    expect(dailyWordsOn('linkedin').friend_request).toEqual({
      label: 'Invitations to connect',
      many: 'invitations to connect',
    });
    expect(todayKindsOn('facebook')).toEqual(TODAY_KINDS);
    expect(todayKindsOn('linkedin').friend_request).toBe('Send an invitation to connect');
    expect(todayKindsOn('linkedin').confirm).toBe('Accept their invitation');
    expect(sendingModesOn('facebook')).toEqual(SENDING_MODES);
    expect(sendingModesOn('linkedin').steps).toMatch(/^Invitations to connect, likes/);
    expect(ticksOn('facebook').warmUp).toEqual(W.ticks.warmUp);
    // Settings show only the switches a network's runner reads; one still looked at has none yet.
    expect(ticksShownOn('facebook')).toEqual(ALONG_TICKS);
    expect(ticksShownOn('linkedin')).toEqual(['warmUp', 'collect']);
    // Alignable's runner (part 5) reads the warm-up and the once-a-day jobs, as LinkedIn's does.
    expect(ticksShownOn('alignable')).toEqual(['warmUp', 'collect']);
    expect(ticksShownOn('instagram')).toEqual([]);
    // And Today marks as done on their own only the steps its runner does: LinkedIn's accepts no invitations.
    const doing = { ...AUTOMATION_DEFAULTS, sending: 'steps' as const };
    expect(autoKinds(doing, 'facebook')).toEqual([
      'confirm',
      'warm_up',
      'friend_request',
      'comment',
    ]);
    expect(autoKinds(doing, 'linkedin')).toEqual(['warm_up', 'friend_request', 'comment']);
    // Alignable's forum answers and comments wait for an OK each time: its runner warms up and connects.
    expect(autoKinds(doing, 'alignable')).toEqual(['warm_up', 'friend_request']);
    expect(autoKinds(doing, 'instagram')).toEqual([]);
    expect(sendingModesOn('alignable').steps).toBe(
      'Connection requests and likes on their own; each message waits for one tap, and you post each comment',
    );
    expect(sendingModesOn('alignable').everything).toBe(
      'Everything on its own, messages too; you post each comment',
    );
    expect(ticksOn('linkedin').confirmRequests[0]).toBe(
      'Accept invitations from people who fit a playbook',
    );
    expect(openChatWords('facebook')).toBe('Open in Messenger');
    expect(openChatWords('linkedin')).toBe('Open in LinkedIn messaging');
    expect(chatUrlOn('facebook', '1234')).toBe('https://www.facebook.com/messages/t/1234');
    expect(chatUrlOn('linkedin', '2-abc=')).toBe(
      'https://www.linkedin.com/messaging/thread/2-abc%3D/',
    );
    expect(chatUrlOn('linkedin', null)).toBeNull();
    // Alignable keeps a chat by the other business's id, as its own Message link opens it.
    expect(chatUrlOn('alignable', '8kA2')).toBe(
      'https://www.alignable.com/biz/conversations?with_business_id=8kA2',
    );
    expect(shareWords(3, 4)).toBe('75% of first messages');
    expect(shareWords(0, 0)).toBe('');
  });

  it('says beside a network’s switch that it’s saved, as the switch saves at once', () => {
    expect(NETWORK_WORDS.switched('LinkedIn', true)).toBe(
      'LinkedIn is on. The extension picks it up in a few seconds.',
    );
    expect(NETWORK_WORDS.switched('LinkedIn', false)).toBe('LinkedIn is off.');
    expect(NETWORK_WORDS.switched('Facebook', true)).toMatch(/^Facebook is on\./);
  });

  it('says a network’s day and its lists first in its words', () => {
    const warned = {
      date: '2026-10-15',
      state: 'stopped' as const,
      why: 'warning' as const,
      via: 'extension' as const,
      at: null,
    };
    expect(dayWords(warned, 'UTC')).toBe('Stopped for today: Facebook showed a warning.');
    expect(dayWords(warned, 'UTC', null, 'linkedin')).toBe(
      'Stopped for today: LinkedIn showed a warning.',
    );
    expect(listsWaitWords(NO_LISTS, true)).toBe(
      'It’s saving your friends list, friend requests and groups first, the first time only. Your day starts once they’re saved.',
    );
    expect(listsWaitWords(NO_LISTS, true, 'linkedin')).toBe(
      'It’s saving your connections and invitations first, the first time only. Your day starts once they’re saved.',
    );
    // LinkedIn has no groups to save first: its connections and invitations either way are enough.
    const saved = new Date().toISOString();
    expect(
      listsWaitWords(
        { ...NO_LISTS, friendsAt: saved, requestsAt: saved, sentAt: saved },
        true,
        'linkedin',
      ),
    ).toBe('');
    expect(
      listsWaitWords({ ...NO_LISTS, friendsAt: saved, requestsAt: saved }, true, 'linkedin'),
    ).toBe(
      'It’s saving the ones you’ve sent first, the first time only. Your day starts once they’re saved.',
    );
  });
});

describe('the networks a person works', () => {
  it('lists those turned on and allowed, Facebook first, and Facebook alone when none is', () => {
    expect(networksOn(AUTOMATION_DEFAULTS)).toEqual(['facebook']);
    expect(networksOn(withLinkedIn(true))).toEqual(['facebook', 'linkedin']);
    expect(networksOn(withLinkedIn(true), ['facebook'])).toEqual(['facebook']);
    const none = withNetwork(AUTOMATION_DEFAULTS, 'facebook', { on: false });
    expect(networksOn(none)).toEqual([]);
    expect(networksShown(none)).toEqual(['facebook']);
    expect(networkShown(['facebook', 'linkedin'], 'linkedin')).toBe('linkedin');
    expect(networkShown(['facebook'], 'linkedin')).toBe('facebook');
    expect(readNetwork('linkedin')).toBe('linkedin');
    expect(readNetwork('myspace')).toBeNull();
  });

  it('puts every network past its look on Today and the filters, once it’s turned on (decision 78)', () => {
    // Alignable works from its part 3, and on its own from part 5; Instagram from its part 12, by hand till its runner (`runsOnItsOwn`).
    expect(WORKING_PLATFORMS).toEqual(['facebook', 'linkedin', 'instagram', 'alignable']);
    expect(PLATFORM_KEYS.filter(isLooking)).toEqual([]);
    const instagram = withNetwork(AUTOMATION_DEFAULTS, 'instagram', { on: true });
    expect(networksOn(instagram)).toEqual(['facebook', 'instagram']);
    expect(networksShown(instagram)).toEqual(['facebook', 'instagram']);
    expect(NETWORK_FILTERS).toEqual(['all', 'facebook', 'linkedin', 'instagram', 'alignable']);
    expect(networkOfLink('https://www.instagram.com/dana.reyes/')).toBe('instagram');
    expect(networkOfLink('https://www.alignable.com/austin-tx/acme-plumbing')).toBe('alignable');
    expect(NETWORK_WORDS.looking('Instagram')).toContain('press Check Instagram below once');
    expect(REPORT_WORDS.notAllowed('Chrome on Mac 12', 'instagram')).toContain(
      'on an Instagram page',
    );
    expect(SETUP_WORDS.stepAbout.networks).toBe(
      'Where you reach people: Facebook, LinkedIn, Instagram or Alignable',
    );
  });

  it('changes one network’s choices, Facebook’s being the settings’ own', () => {
    const on = withNetwork(AUTOMATION_DEFAULTS, 'linkedin', { on: true, sending: 'steps' });
    expect(on.networks.linkedin.on).toBe(true);
    expect(on.networks.linkedin.sending).toBe('steps');
    expect(on.sending).toBe(AUTOMATION_DEFAULTS.sending);
    const facebook = withNetwork(AUTOMATION_DEFAULTS, 'facebook', { sending: 'everything' });
    expect(facebook.sending).toBe('everything');
    expect(facebook.networks).toEqual(AUTOMATION_DEFAULTS.networks);
  });
});

describe('the setup’s step to pick networks', () => {
  it('comes after the team’s rules and before the person’s own settings', () => {
    expect(setupSteps(true)).toEqual([
      'playbooks',
      'ready',
      'rules',
      'networks',
      'settings',
      'extension',
      'groups',
    ]);
    expect(setupSteps(false)).toEqual([
      'playbooks',
      'ready',
      'networks',
      'settings',
      'extension',
      'groups',
    ]);
    expect(SETUP_WORDS.stepAbout.networks).toBe(
      'Where you reach people: Facebook, LinkedIn, Instagram or Alignable',
    );
    const got = { playbooks: [], extensionAt: null, groups: { mine: 0, business: 0, latest: [] } };
    expect(setupSummary(got, withLinkedIn(true))[1]).toBe('Networks: Facebook, LinkedIn');
    expect(setupSummary(got, null)[1]).toBe('Networks: Facebook');
  });
});

describe('asks named by their network', () => {
  const computer = {
    computerId: randomUUID(),
    name: 'Chrome on Mac',
    online: true,
    signedOut: false,
    lastSeenAt: new Date().toISOString(),
    version: '0.40.0',
  };

  it('can’t ask a network what it can’t be asked, and Facebook’s warning holds back only Facebook', () => {
    expect(cantAskWhy({ computer, warnedToday: false }, 'groups', 'linkedin')).toBe(
      'Your computer can’t do that on LinkedIn yet. Ask it on Facebook, or from that network’s own buttons.',
    );
    expect(cantAskWhy({ computer, warnedToday: false }, 'chats', 'linkedin')).toBeNull();
    // Alignable from its part 4: its connections, requests, checks and look-ups, from 0.73.0; not its chats yet.
    const now = { ...computer, version: '0.73.0' };
    for (const kind of ['friends', 'requests', 'checks', 'research', 'lookup'] as const)
      expect(cantAskWhy({ computer: now, warnedToday: false }, kind, 'alignable')).toBeNull();
    expect(cantAskWhy({ computer: now, warnedToday: false }, 'chats', 'alignable')).toContain(
      'can’t do that on Alignable yet',
    );
    expect(
      cantAskWhy(
        { computer: { ...computer, version: '0.72.0' }, warnedToday: false },
        'friends',
        'alignable',
      ),
    ).not.toBeNull();
    expect(cantAskWhy({ computer, warnedToday: true }, 'chats')).not.toBeNull();
    expect(cantAskWhy({ computer, warnedToday: true }, 'chats', 'linkedin')).toBeNull();
    // A build from before LinkedIn can't be asked anything there.
    expect(
      cantAskWhy(
        { computer: { ...computer, version: '0.39.0' }, warnedToday: false },
        'chats',
        'linkedin',
      ),
    ).toMatch(/older build/);
  });

  it('finds the newest ask on the network, never another network’s of the same kind', () => {
    const ask = (platform: 'facebook' | 'linkedin', target: string) => ({
      kind: 'chats' as const,
      platform,
      target,
    });
    const asks = { asks: [ask('linkedin', 'linkedin:'), ask('facebook', '')] };
    expect(latestAskOn(asks, 'facebook', 'chats', '')).toBe(asks.asks[1]);
    expect(latestAskOn(asks, 'linkedin', 'chats', '')).toBe(asks.asks[0]);
    expect(latestAskOn(asks, 'linkedin', 'friends')).toBeNull();
  });
});

describe('each network’s rows and numbers', () => {
  let owner: TestUser;
  let ws: string;

  beforeAll(async () => {
    owner = await createTestUser('outna-owner', { fullName: 'Morgan Owner' });
    ws = await outreachBusiness(owner, 'Outreach Networks App Co');
  }, 60_000);

  afterAll(closeTestDbs);

  async function teammate(name: string): Promise<TestUser> {
    const u = await createTestUser(`outna-${name.toLowerCase().replace(/\s+/g, '-')}`, {
      fullName: name,
    });
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: u.id, role: 'member' });
    return u;
  }

  async function profile(platform: 'facebook' | 'linkedin', name: string): Promise<string> {
    const slug = `${name.toLowerCase().replace(/\s+/g, '')}${randomUUID().slice(0, 6)}`;
    const url =
      platform === 'linkedin'
        ? `https://www.linkedin.com/in/${slug}/`
        : `https://www.facebook.com/${slug}`;
    const [made] = await rows<{ id: string }>(
      admin(),
      sql`insert into addon_outreach.profiles (workspace_id, platform, username, url, name)
          values (${ws}, ${platform}, ${slug}, ${url}, ${name}) returning id`,
    );
    return made!.id;
  }

  async function step(
    u: TestUser,
    profileId: string,
    kind: 'friend_request' | 'message',
    first = false,
  ) {
    await rows(
      admin(),
      sql`insert into addon_outreach.touches (workspace_id, profile_id, user_id, kind, step, at)
          values (${ws}, ${profileId}, ${u.id}, ${kind}, ${first ? 'first_message' : null}, now())`,
    );
  }

  async function chat(u: TestUser, platform: 'facebook' | 'linkedin', name: string) {
    await rows(
      admin(),
      sql`insert into addon_outreach.file_chats
            (workspace_id, user_id, platform, name, name_key, first_at, last_at, messages, last_from_me,
             read_state, prospect)
          values (${ws}, ${u.id}, ${platform}, ${name}, ${name.toLowerCase()}, now() - interval '9 days',
            now() - interval '1 day', 4, false, 'read', true)`,
    );
  }

  it('gives the live view of one network: its day, its limits and its lists', async () => {
    const dana = await teammate('Dana Reyes');
    await runAs(dana, ws, 'outreach.automation.save', {
      settings: { ...withLinkedIn(true), networks: withLinkedIn(true).networks },
    });
    await step(dana, await profile('linkedin', 'Avery Lane'), 'friend_request');
    await runAs(dana, ws, 'outreach.day.stop', { platform: 'linkedin' });

    const facebook = await runAs(dana, ws, 'outreach.live', {});
    const linkedIn = await runAs(dana, ws, 'outreach.live', { platform: 'linkedin' });
    expect(facebook.day.state).toBe('none');
    expect(linkedIn.day.state).toBe('stopped');
    expect(facebook.limits.friend_request).toEqual({ done: 0, most: 20 });
    // LinkedIn's own starting limits, and its own count.
    expect(linkedIn.limits.friend_request).toEqual({ done: 1, most: 15 });
    expect(linkedIn.limits.like.most).toBe(30);
    // The computers and the feed are the person's, the same on every network.
    expect(linkedIn.computers).toEqual(facebook.computers);
  });

  it('lists every network’s people with each one’s network, or one network’s alone', async () => {
    const sam = await teammate('Sam Lee');
    const onFacebook = await profile('facebook', 'Riley Stone');
    const onLinkedIn = await profile('linkedin', 'Quinn Harper');
    await step(sam, onFacebook, 'friend_request');
    await step(sam, onLinkedIn, 'friend_request');

    const all: StagesOutput = await runAs(sam, ws, 'outreach.stages', {});
    expect(all.people.map((p) => [p.name, p.platform]).sort()).toEqual([
      ['Quinn Harper', 'linkedin'],
      ['Riley Stone', 'facebook'],
    ]);
    // Each in its network's words.
    expect(all.people.find((p) => p.platform === 'linkedin')!.why).toEqual([
      'Invitation to connect sent',
    ]);
    expect(all.people.find((p) => p.platform === 'facebook')!.why).toEqual(['Friend request sent']);
    const linkedIn: StagesOutput = await runAs(sam, ws, 'outreach.stages', {
      platform: 'linkedin',
    });
    expect(linkedIn.people.map((p) => p.name)).toEqual(['Quinn Harper']);
    expect(linkedIn.counts.warming).toBe(1);
    expect(linkedIn.total).toBe(1);
  });

  it('lists the friends and the chats on one network, with each row’s network', async () => {
    const ash = await teammate('Ash Kim');
    const onLinkedIn = await profile('linkedin', 'Rowan Price');
    const onFacebook = await profile('facebook', 'Jordan Bell');
    for (const [p, at] of [
      [onLinkedIn, 'friends'],
      [onFacebook, 'friends'],
    ] as const)
      await rows(
        admin(),
        sql`insert into addon_outreach.friends (workspace_id, user_id, profile_id, state, since, seen_at)
            values (${ws}, ${ash.id}, ${p}, ${at}, now(), now())`,
      );
    const all: FriendsOutput = await runAs(ash, ws, 'outreach.friends', {});
    expect(all.counts.friends).toBe(2);
    expect(all.cap).toBe(5000);
    const linkedIn: FriendsOutput = await runAs(ash, ws, 'outreach.friends', {
      platform: 'linkedin',
    });
    expect(linkedIn.counts.friends).toBe(1);
    expect(linkedIn.cap).toBe(30_000);
    expect(linkedIn.people.map((p) => [p.name, p.platform])).toEqual([['Rowan Price', 'linkedin']]);

    await chat(ash, 'facebook', 'Casey Fox');
    await chat(ash, 'linkedin', 'Taylor Moss');
    const chats: ChatsOutput = await runAs(ash, ws, 'outreach.chats', { view: 'read' });
    expect(chats.chats.map((c) => [c.name, c.platform]).sort()).toEqual([
      ['Casey Fox', 'facebook'],
      ['Taylor Moss', 'linkedin'],
    ]);
    const onlyLinkedIn: ChatsOutput = await runAs(ash, ws, 'outreach.chats', {
      view: 'read',
      platform: 'linkedin',
    });
    expect(onlyLinkedIn.chats.map((c) => c.name)).toEqual(['Taylor Moss']);
    expect(onlyLinkedIn.counts.read).toBe(1);
  });

  it('keeps the setup’s networks step as one finished, in its place', async () => {
    const kai = await teammate('Kai Moss');
    const got = await runAs(kai, ws, 'outreach.setup.save', { reached: 'networks' });
    expect(got.reached).toBe('networks');
    // The steps only move forward: the networks come after the rules and before the settings.
    expect((await runAs(kai, ws, 'outreach.setup.save', { reached: 'ready' })).reached).toBe(
      'networks',
    );
    expect((await runAs(kai, ws, 'outreach.setup.save', { reached: 'settings' })).reached).toBe(
      'settings',
    );
  });

  it('counts Results by network beside by playbook, adding up to the whole', async () => {
    const lee = await teammate('Lee Park');
    await step(lee, await profile('facebook', 'Pat Gray'), 'message', true);
    await step(lee, await profile('linkedin', 'Drew Hale'), 'message', true);
    await step(lee, await profile('linkedin', 'Sky Lowe'), 'message', true);

    const got = await runAs(lee, ws, 'outreach.tracking', { period: 'today' });
    expect(got.numbers.messages).toBe(3);
    expect(got.byNetwork).toEqual([
      { platform: 'linkedin', messages: 2, positive: 0, booked: 0 },
      { platform: 'facebook', messages: 1, positive: 0, booked: 0 },
    ]);
    const activity: ActivityOutput = await runAs(lee, ws, 'outreach.activity', {
      period: 'today',
    });
    expect(activity.people.map((p) => p.platform).sort()).toEqual([
      'facebook',
      'linkedin',
      'linkedin',
    ]);
  });
});
