/**
 * Social Outreach on more than one network (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "Each network on its
 * own"): a warning or a pause on one network never affects another. LinkedIn's steps never count against Facebook's
 * daily limits, and a warning on one network slows, stops and refuses only that network: Facebook's limits, Today,
 * day, asks and training wheels stay as they were after LinkedIn's, and LinkedIn's after Facebook's.
 *
 * Some LinkedIn profiles and steps are written here as the database would keep them, since nothing reads a
 * LinkedIn page yet; others go through the commands the extension will call.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUTOMATION_DEFAULTS,
  NETWORK_CHOICES_DEFAULTS,
  NETWORKS_DEFAULTS,
} from '../../src/addons/outreach/automation';
import { tooOldFor } from '../../src/addons/outreach/asks';
import { preDaySteps } from '../../src/addons/outreach/lists';
import { networkOfLink, NETWORKS, profileMisfit } from '../../src/addons/outreach/networks';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { notReadyWords, readinessOf } from '../../src/addons/outreach/readiness';
import { PROFILE_ITEMS, PROFILE_ITEMS_ON } from '../../src/addons/outreach/profile-check';
import {
  checkedAs,
  computerOn,
  outreachBusiness,
  refused,
  runAs,
  runAsSystem,
  runWith,
} from './outreach-fixture';

const admin = () => testDbs().admin.db;

let owner: TestUser;
let ws: string;

beforeAll(async () => {
  owner = await createTestUser('outn-owner', { fullName: 'Morgan Owner' });
  ws = await outreachBusiness(owner, 'Outreach Networks Co');
  // A playbook with a niche: one of the things a person needs before their day starts (decision 63). It runs on
  // Facebook and LinkedIn (data version 7: a playbook runs on its own networks).
  await runAs(owner, ws, 'outreach.playbook.save', {
    name: 'CRM demos',
    template: 'crm_demos',
    details: { ...PLAYBOOK_TEMPLATES.crm_demos.details, platforms: ['facebook', 'linkedin'] },
  });
}, 60_000);

afterAll(closeTestDbs);

/** Someone new on the team, with nothing done yet on any network. */
async function teammate(name: string): Promise<TestUser> {
  const u = await createTestUser(`outn-${name.toLowerCase().replace(/\s+/g, '-')}`, {
    fullName: name,
  });
  await admin()
    .insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: u.id, role: 'member' });
  return u;
}

/** A LinkedIn profile, kept as the database would keep one. Its id. */
async function linkedInProfile(name: string): Promise<string> {
  const slug = `${name.toLowerCase().replace(/\s+/g, '')}${randomUUID().slice(0, 6)}`;
  const [made] = await rows<{ id: string }>(
    admin(),
    sql`insert into addon_outreach.profiles (workspace_id, platform, username, url, name)
        values (${ws}, 'linkedin', ${slug}, ${`https://www.linkedin.com/in/${slug}/`}, ${name})
        returning id`,
  );
  return made!.id;
}

/** A step taken on LinkedIn today, as the extension would note it. */
async function linkedInStep(u: TestUser, profileId: string, kind: 'friend_request' | 'like') {
  await rows(
    admin(),
    sql`insert into addon_outreach.touches (workspace_id, profile_id, user_id, kind, at)
        values (${ws}, ${profileId}, ${u.id}, ${kind}, now())`,
  );
}

const warn = (u: TestUser, platform: 'facebook' | 'linkedin', words: string) =>
  runAs(u, ws, 'outreach.warning.note', { platform, words: [words] });

describe('each network on its own', () => {
  it('counts LinkedIn’s steps against LinkedIn’s limits, never Facebook’s', async () => {
    const dana = await teammate('Dana Reyes');
    await runAs(dana, ws, 'outreach.touch.save', {
      kind: 'friend_request',
      profile: { id: null, username: 'sam.lee.7', url: 'https://www.facebook.com/sam.lee.7' },
      name: 'Sam Lee',
      at: new Date().toISOString(),
    });
    await linkedInStep(dana, await linkedInProfile('Avery Lane'), 'friend_request');
    await linkedInStep(dana, await linkedInProfile('Quinn Harper'), 'friend_request');
    await linkedInStep(dana, await linkedInProfile('Rowan Price'), 'like');

    const facebook = await runAs(dana, ws, 'outreach.today', {});
    expect(facebook.limits.friend_request.done).toBe(1);
    expect(facebook.limits.like.done).toBe(0);
    const linkedIn = await runAs(dana, ws, 'outreach.today', { platform: 'linkedin' });
    expect(linkedIn.limits.friend_request.done).toBe(2);
    expect(linkedIn.limits.like.done).toBe(1);
    // The live view and the activity panel show Facebook's day, where the extension works.
    expect((await runAs(dana, ws, 'outreach.live', {})).limits.friend_request.done).toBe(1);
    expect((await runAs(dana, ws, 'outreach.activity', {})).today.friend_request).toBe(1);
  });

  it('slows and stops only LinkedIn on a LinkedIn warning', async () => {
    const dana = await teammate('Riley Stone');
    await runAs(dana, ws, 'outreach.automation.save', {
      settings: {
        ...AUTOMATION_DEFAULTS,
        sending: 'everything',
        networks: {
          ...AUTOMATION_DEFAULTS.networks,
          linkedin: { ...AUTOMATION_DEFAULTS.networks.linkedin, on: true },
        },
      },
    });
    // Their training wheels came off already.
    await rows(
      admin(),
      sql`update addon_outreach.automation set wheels_done_at = now()
          where workspace_id = ${ws} and user_id = ${dana.id}`,
    );
    const facebookBefore = await runAs(dana, ws, 'outreach.today', {});

    const noted = await warn(dana, 'linkedin', 'You’ve reached the weekly invitation limit');
    expect(noted.repeated).toBe(false);
    const [seen] = await rows<{ payload: Record<string, unknown> }>(
      admin(),
      sql`select payload from app.events where workspace_id = ${ws}
            and event_type = 'outreach.warning.seen' order by created_at desc limit 1`,
    );
    expect(seen!.payload).toMatchObject({ platform: 'linkedin', userId: dana.id });

    // LinkedIn: halved, its invitations off the list, its day stopped, Start refused in LinkedIn's words.
    const linkedIn = await runAs(dana, ws, 'outreach.today', { platform: 'linkedin' });
    expect(linkedIn.warning?.today).toBe(true);
    // LinkedIn's own starting limit (15), halved.
    expect(linkedIn.limits.friend_request.most).toBe(7);
    const [day] = await rows<{ platform: string; state: string; why: string }>(
      admin(),
      sql`select platform, state, why from addon_outreach.days
          where workspace_id = ${ws} and user_id = ${dana.id}`,
    );
    expect(day).toEqual({ platform: 'linkedin', state: 'stopped', why: 'warning' });
    const said = await runAs(dana, ws, 'outreach.day.start', { platform: 'linkedin' }).catch(
      (e: { rule?: string; message: string }) => e,
    );
    expect(said).toMatchObject({ rule: 'outreach_warned_today' });
    expect((said as { message: string }).message).toContain('stays stopped on LinkedIn');
    const [line] = await rows<{ line: string }>(
      admin(),
      sql`select line from addon_outreach.live_steps
          where workspace_id = ${ws} and user_id = ${dana.id} and kind = 'stopped'`,
    );
    expect(line!.line).toContain('LinkedIn showed a warning');

    // Facebook: its limits, list, day, asks and training wheels as they were.
    const facebook = await runAs(dana, ws, 'outreach.today', {});
    expect(facebook.warning).toBeNull();
    expect(facebook.limits).toEqual(facebookBefore.limits);
    expect(facebook.limits.friend_request.most).toBe(20);
    const live = await runAs(dana, ws, 'outreach.live', {});
    expect(live.warning).toBeNull();
    expect(live.day.state).toBe('none');
    expect((await runAs(dana, ws, 'outreach.asks', {})).warnedToday).toBe(false);
    expect((await runAs(dana, ws, 'outreach.friends.tidy', {})).warning).toBeNull();
    const team = await runAs(owner, ws, 'outreach.live.team', {});
    expect(team.platform).toBe('facebook');
    expect(team.people.find((p: { userId: string }) => p.userId === dana.id)).toMatchObject({
      warned: false,
      day: { state: 'none' },
    });
    // The team's view of LinkedIn: her day there stopped by its warning, at LinkedIn's halved limits.
    const onLinkedIn = await runAs(owner, ws, 'outreach.live.team', { platform: 'linkedin' });
    expect(onLinkedIn.platform).toBe('linkedin');
    expect(onLinkedIn.people.find((p: { userId: string }) => p.userId === dana.id)).toMatchObject({
      warned: true,
      day: { state: 'stopped', why: 'warning' },
      limits: { friend_request: { most: 7 } },
    });
    // Only those who have LinkedIn on are on its list.
    expect(onLinkedIn.people.some((p: { userId: string }) => p.userId === owner.id)).toBe(false);
    const [wheels] = await rows<{ done: boolean }>(
      admin(),
      sql`select wheels_done_at is not null as done from addon_outreach.automation
          where workspace_id = ${ws} and user_id = ${dana.id}`,
    );
    expect(wheels!.done).toBe(true);
  });

  it('keeps each network’s day: a stop or a warning on LinkedIn leaves Facebook’s day going', async () => {
    const dana = await teammate('Harper Lane');
    await runAs(dana, ws, 'outreach.automation.save', {
      settings: {
        ...AUTOMATION_DEFAULTS,
        sending: 'steps',
        networks: {
          ...NETWORKS_DEFAULTS,
          linkedin: { ...NETWORK_CHOICES_DEFAULTS, on: true, sending: 'steps' },
        },
      },
    });
    expect(await runAs(dana, ws, 'outreach.day.start', {})).toMatchObject({ state: 'started' });
    expect(await runAs(dana, ws, 'outreach.day.start', { platform: 'linkedin' })).toMatchObject({
      state: 'started',
    });
    // Stop for today on LinkedIn: Facebook's day goes on.
    expect(await runAs(dana, ws, 'outreach.day.stop', { platform: 'linkedin' })).toMatchObject({
      state: 'stopped',
      why: 'person',
    });
    expect((await runAs(dana, ws, 'outreach.live', {})).day).toMatchObject({ state: 'started' });
    // LinkedIn warns them: its day stays stopped for the warning, and Facebook's still goes.
    await warn(dana, 'linkedin', 'Your account has been restricted');
    const days = await rows<{ platform: string; state: string; why: string | null }>(
      admin(),
      sql`select platform, state, why from addon_outreach.days
          where workspace_id = ${ws} and user_id = ${dana.id} order by platform`,
    );
    expect(days).toEqual([
      { platform: 'facebook', state: 'started', why: null },
      { platform: 'linkedin', state: 'stopped', why: 'warning' },
    ]);
    expect(await runAs(dana, ws, 'outreach.day.stop', {})).toMatchObject({ state: 'stopped' });
    expect(await runAs(dana, ws, 'outreach.day.start', {})).toMatchObject({ state: 'started' });
    expect(await refused(runAs(dana, ws, 'outreach.day.start', { platform: 'linkedin' }))).toBe(
      'outreach_warned_today',
    );
  });

  it('keeps a warning’s words once a day on each network, never across them', async () => {
    const dana = await teammate('Jordan Vale');
    const words = 'We limit how often you can do this';
    expect((await warn(dana, 'linkedin', words)).repeated).toBe(false);
    expect((await warn(dana, 'linkedin', words)).repeated).toBe(true);
    const kept = await rows<{ platform: string }>(
      admin(),
      sql`select platform from addon_outreach.warnings
          where workspace_id = ${ws} and user_id = ${dana.id}`,
    );
    expect(kept).toEqual([{ platform: 'linkedin' }]);
  });

  it('leaves LinkedIn as it was on a Facebook warning', async () => {
    const dana = await teammate('Casey Moss');
    await warn(dana, 'facebook', 'You’re temporarily blocked from sending friend requests');
    const facebook = await runAs(dana, ws, 'outreach.today', {});
    expect(facebook.limits.friend_request.most).toBe(10);
    expect(await refused(runAs(dana, ws, 'outreach.day.start', {}))).toBe('outreach_warned_today');
    const linkedIn = await runAs(dana, ws, 'outreach.today', { platform: 'linkedin' });
    expect(linkedIn.warning).toBeNull();
    expect(linkedIn.limits.friend_request.most).toBe(15);
  });
});

/** A LinkedIn chat's id in its link's shape: "2-", then letters and numbers, ending "==". Made up. */
const CHAT_ID = '2-aaaabbbbcccc==';

describe('each network’s own shapes', () => {
  const dana = {
    id: 'ACoAABx9-Kq_7',
    username: 'dana-reyes-4b1a2',
    url: 'https://www.linkedin.com/in/dana-reyes-4b1a2/',
  };

  it('know a network by its links, and a profile that isn’t on the network named', () => {
    expect(networkOfLink('https://www.linkedin.com/in/dana-reyes-4b1a2/')).toBe('linkedin');
    expect(networkOfLink('https://www.facebook.com/dana.reyes.12')).toBe('facebook');
    expect(networkOfLink('https://linkedin.example.com/in/dana')).toBeNull();
    expect(profileMisfit('linkedin', dana)).toBeNull();
    expect(profileMisfit('facebook', dana)).toContain('isn’t a Facebook one');
    expect(
      profileMisfit('linkedin', { ...dana, url: 'https://www.facebook.com/dana.reyes.12' }),
    ).toContain('isn’t a LinkedIn one');
    expect(
      profileMisfit('facebook', {
        id: null,
        username: 'dana-reyes',
        url: 'https://www.facebook.com/dana-reyes',
      }),
    ).toContain('isn’t a Facebook profile’s name');
    // Each network starts at its own limits; LinkedIn also caps invitations in any 7 days.
    expect(NETWORKS.linkedin.dailyLimits.friend_request).toBe(15);
    expect(NETWORKS.linkedin.weeklyRequests).toBe(80);
    expect(NETWORKS.facebook.weeklyRequests).toBeNull();
  });

  it('keep a LinkedIn profile and its steps, and refuse one sent for the wrong network', async () => {
    const riley = await teammate('Avery Quinn');
    const saved = await runAs(riley, ws, 'outreach.touch.save', {
      platform: 'linkedin',
      kind: 'message',
      profile: dana,
      name: 'Dana Reyes',
      threadKey: CHAT_ID,
      at: new Date().toISOString(),
    });
    const [kept] = await rows<{ platform: string; platform_id: string; username: string }>(
      admin(),
      sql`select platform, platform_id, username from addon_outreach.profiles
          where id = ${saved.profileId}`,
    );
    expect(kept).toEqual({
      platform: 'linkedin',
      platform_id: dana.id,
      username: dana.username,
    });
    const [touch] = await rows<{ thread_key: string }>(
      admin(),
      sql`select thread_key from addon_outreach.touches where profile_id = ${saved.profileId}`,
    );
    expect(touch!.thread_key).toBe(CHAT_ID);

    // A LinkedIn page sent as Facebook's, or a Facebook one as LinkedIn's, is refused with what to send.
    expect(
      await refused(
        runAs(riley, ws, 'outreach.touch.save', {
          kind: 'like',
          profile: dana,
          name: 'Dana Reyes',
          at: new Date().toISOString(),
        }),
      ),
    ).toBe('outreach_wrong_network');
    expect(
      await refused(
        runAs(riley, ws, 'outreach.touch.save', {
          platform: 'linkedin',
          kind: 'like',
          profile: { id: null, username: 'sam.lee.7', url: 'https://www.facebook.com/sam.lee.7' },
          name: 'Sam Lee',
          at: new Date().toISOString(),
        }),
      ),
    ).toBe('outreach_wrong_network');
  });
});

describe('each network’s own choices', () => {
  const linkedIn = (more: Record<string, unknown> = {}) => ({
    ...AUTOMATION_DEFAULTS,
    networks: {
      ...NETWORKS_DEFAULTS,
      linkedin: { ...NETWORK_CHOICES_DEFAULTS, on: true, ...more },
    },
  });
  const setRules = (rules: Record<string, unknown>) =>
    runAs(owner, ws, 'addon.save_settings', { addonId: 'outreach', settings: { rules } });

  it('keep LinkedIn off to start, and its choices apart from Facebook’s', async () => {
    const dana = await teammate('Jesse Park');
    const fresh = await runAs(dana, ws, 'outreach.automation', {});
    expect(fresh.settings.networks).toEqual(NETWORKS_DEFAULTS);
    expect(fresh.settings.networks.linkedin.on).toBe(false);
    // Off, LinkedIn has no day to start, and the extension does nothing there on its own.
    expect(await refused(runAs(dana, ws, 'outreach.day.start', { platform: 'linkedin' }))).toBe(
      'outreach_network_off',
    );
    expect((await runAs(dana, ws, 'outreach.today', { platform: 'linkedin' })).auto).toEqual([]);

    const saved = await runAs(dana, ws, 'outreach.automation.save', {
      settings: linkedIn({ sending: 'steps', warmUp: false }),
    });
    expect(saved.settings.sending).toBe('off');
    expect(saved.settings.networks.linkedin).toMatchObject({
      on: true,
      sending: 'steps',
      warmUp: false,
    });
    // Facebook does nothing on its own; LinkedIn does its own steps, without liking a post first. From decision 136
    // its runner accepts the invitations Today lists to confirm, and its comments wait for an OK at first, as
    // messages do (decision 102).
    expect((await runAs(dana, ws, 'outreach.today', {})).auto).toEqual([]);
    expect((await runAs(dana, ws, 'outreach.today', { platform: 'linkedin' })).auto).toEqual([
      'confirm',
      'friend_request',
    ]);
    // A screen from before networks sends none: the ones kept stay.
    const { networks: _left, ...before } = AUTOMATION_DEFAULTS;
    const again = await runAs(dana, ws, 'outreach.automation.save', { settings: before });
    expect(again.settings.networks.linkedin).toMatchObject({ on: true, sending: 'steps' });
  });

  it('keep each network’s training wheels its own', async () => {
    const dana = await teammate('Morgan Ellis');
    const saved = await runAs(dana, ws, 'outreach.automation.save', {
      settings: linkedIn({ sending: 'everything' }),
    });
    expect(saved.networkWheels.linkedin.on).toBe(true);
    expect(saved.wheels.on).toBe(false);
    // Halved on LinkedIn for the wheels; Facebook as it was.
    expect(
      (await runAs(dana, ws, 'outreach.today', { platform: 'linkedin' })).limits.like.most,
    ).toBe(15);
    expect((await runAs(dana, ws, 'outreach.today', {})).limits.like.most).toBe(40);
    // An owner ends LinkedIn's early; a LinkedIn warning puts them back on, and only LinkedIn's.
    expect(
      await runAs(owner, ws, 'outreach.wheels.end', { userId: dana.id, platform: 'linkedin' }),
    ).toEqual({ userId: dana.id, ended: true });
    expect((await runAs(dana, ws, 'outreach.automation', {})).networkWheels.linkedin.on).toBe(
      false,
    );
    await warn(dana, 'linkedin', 'We restrict accounts that send too many invitations');
    const after = await runAs(dana, ws, 'outreach.automation', {});
    expect(after.networkWheels.linkedin.on).toBe(true);
    expect(after.wheels.on).toBe(false);
    const listed = await runAs(owner, ws, 'outreach.wheels', {});
    expect(
      listed.people
        .filter((p: { userId: string }) => p.userId === dana.id)
        .map((p: { platform: string }) => p.platform),
    ).toEqual(['linkedin']);
  });

  it('keep to the networks and limits the business allows', async () => {
    const dana = await teammate('Riley Fox');
    await setRules({ networksAllowed: ['facebook'], networkLimits: { linkedin: { like: 12 } } });
    expect(
      await refused(runAs(dana, ws, 'outreach.automation.save', { settings: linkedIn() })),
    ).toBe('not_allowed');
    await setRules({ networkLimits: { linkedin: { like: 12 } } });
    await runAs(dana, ws, 'outreach.automation.save', { settings: linkedIn() });
    expect(
      (await runAs(dana, ws, 'outreach.today', { platform: 'linkedin' })).limits.like.most,
    ).toBe(12);
    // The business stops allowing LinkedIn: theirs reads as off, and its day won't start. The refusal says only an
    // owner can allow it, and where, with the details that tell a screen it isn't theirs to turn on.
    await setRules({ networksAllowed: ['facebook'] });
    expect((await runAs(dana, ws, 'outreach.automation', {})).settings.networks.linkedin.on).toBe(
      false,
    );
    const said = await runAs(dana, ws, 'outreach.day.start', { platform: 'linkedin' }).catch(
      (e: { rule?: string; message: string; details?: unknown }) => e,
    );
    expect(said).toMatchObject({
      rule: 'outreach_network_off',
      details: { platform: 'linkedin', allowed: false },
    });
    expect((said as { message: string }).message).toContain('Ask an owner of this business');
    await setRules({});
  });
});

describe('each network’s own lists, asks and Today', () => {
  const HOUR = 3_600_000;
  const linkedInOn = {
    ...AUTOMATION_DEFAULTS,
    networks: { ...NETWORKS_DEFAULTS, linkedin: { ...NETWORK_CHOICES_DEFAULTS, on: true } },
  };
  const beat = (u: TestUser, installId: string, version: string) =>
    runWith(
      u,
      ws,
      'outreach.live.beat',
      {
        computer: { id: installId, name: 'Chrome on Mac', version },
        active: true,
        status: { state: 'idle', line: null, lineAt: null, nextAt: null },
      },
      { channel: 'extension', commandId: randomUUID(), occurredAt: new Date(), sentAt: new Date() },
    );
  const ask = (u: TestUser, platform: string | undefined, a: Record<string, unknown>) =>
    runWith(
      u,
      ws,
      'outreach.ask.make',
      { ...(platform ? { platform } : {}), ask: a },
      {
        channel: 'web',
      },
    );

  it('keep Today to its own network: a reply owed on LinkedIn shows on LinkedIn’s list alone', async () => {
    const dana = await teammate('Quinn Avery');
    const sam = {
      id: 'ACoAABsam-7',
      username: 'sam-lee-77',
      url: 'https://www.linkedin.com/in/sam-lee-77/',
    };
    await runAs(
      dana,
      ws,
      'outreach.touch.save',
      { platform: 'linkedin', kind: 'message', profile: sam, name: 'Sam Lee' },
      new Date(Date.now() - HOUR),
    );
    const seen = await runAs(dana, ws, 'outreach.replies.note', {
      platform: 'linkedin',
      seen: [{ name: 'Sam Lee', profile: sam }],
    });
    expect(seen.replies).toHaveLength(1);
    const kinds = async (platform?: string) =>
      (await runAs(dana, ws, 'outreach.today', platform ? { platform } : {})).items.map(
        (i: { kind: string; name: string }) => `${i.kind}: ${i.name}`,
      );
    expect(await kinds('linkedin')).toEqual(['reply: Sam Lee']);
    expect(await kinds()).toEqual([]);
  });

  it('take a reply seen by its name alone, as Instagram’s list of chats shows it, when one person messaged goes by it', async () => {
    const dana = await teammate('Ellis Grant');
    const ig = (username: string) => ({
      id: null,
      username,
      url: `https://www.instagram.com/${username}/`,
    });
    const message = (username: string, name: string, threadKey: string) =>
      runAs(
        dana,
        ws,
        'outreach.touch.save',
        { platform: 'instagram', kind: 'message', profile: ig(username), name, threadKey },
        new Date(Date.now() - HOUR),
      );
    const seen = (name: string) =>
      runAs(dana, ws, 'outreach.replies.note', { platform: 'instagram', seen: [{ name }] });
    await message('kim.bakes', 'Kim Baker', '340282366841710301');
    // Nobody the person messaged goes by the name: no reply.
    expect((await seen('Lee Park')).replies).toEqual([]);
    // The list's name, whatever its spaces and capitals; kept with the chat the message went in, which the runner
    // opens to read before it drafts the reply.
    const kim = (await seen('  kim   BAKER ')).replies;
    expect(kim).toEqual([{ profileId: expect.any(String), name: 'Kim Baker' }]);
    const [kept] = await rows<{ thread_key: string | null }>(
      admin(),
      sql`select thread_key from addon_outreach.replies where profile_id = ${kim[0].profileId}`,
    );
    expect(kept!.thread_key).toBe('340282366841710301');
    const today = await runAs(dana, ws, 'outreach.today', { platform: 'instagram' });
    expect(today.items.find((i: { name: string }) => i.name === 'Kim Baker')).toMatchObject({
      kind: 'reply',
      threadKey: '340282366841710301',
    });
    // By the name in their address too, when the list shows that.
    await message('sam.fixes', 'Sam Ortiz', '340282366841710302');
    expect((await seen('sam.fixes')).replies).toHaveLength(1);
    // Two people messaged by one name: neither is known to be the one who wrote.
    await message('jo.reed.1', 'Jo Reed', '340282366841710303');
    await message('jo.reed.2', 'Jo Reed', '340282366841710304');
    expect((await seen('Jo Reed')).replies).toEqual([]);
  });

  it('keep each network’s lists and first day apart', async () => {
    const dana = await teammate('Rowan Blake');
    const linkedIn = await runAs(dana, ws, 'outreach.lists.saved', {
      platform: 'linkedin',
      list: 'friends',
    });
    expect(linkedIn.friendsAt).not.toBeNull();
    expect((await runAs(dana, ws, 'outreach.lists', {})).friendsAt).toBeNull();
    expect((await runAs(dana, ws, 'outreach.lists', { platform: 'linkedin' })).friendsAt).toBe(
      linkedIn.friendsAt,
    );
    await runAs(dana, ws, 'outreach.lists.saved', { list: 'requests' });
    expect((await runAs(dana, ws, 'outreach.lists', {})).requestsAt).not.toBeNull();
    expect(
      (await runAs(dana, ws, 'outreach.lists', { platform: 'linkedin' })).requestsAt,
    ).toBeNull();
    // LinkedIn's first day has no groups to save, and its own words.
    const steps = preDaySteps(linkedIn, {}, 'linkedin');
    expect(steps.map((s) => s.label)).toEqual([
      'Save your connections',
      'Save invitations you got',
      'Save invitations you sent',
      'Work out which old invitations to withdraw',
      'Check your connections for good fits',
    ]);
    expect(steps.map((s) => s.state)).toEqual(['done', 'now', 'next', 'next', 'next']);
  });

  it('keep each network’s asks apart, for a build that knows the network', async () => {
    const dana = await teammate('Emery Stone');
    const pc = randomUUID();
    // LinkedIn off: nothing asked there.
    await beat(dana, pc, '0.40.0');
    expect(await refused(ask(dana, 'linkedin', { kind: 'friends' }))).toBe('outreach_network_off');
    await runAs(dana, ws, 'outreach.automation.save', { settings: linkedInOn });
    // A kind LinkedIn isn't asked.
    expect(await refused(ask(dana, 'linkedin', { kind: 'groups' }))).toBe(
      'outreach_ask_not_on_network',
    );
    // LinkedIn's and Facebook's of the same kind are two asks.
    const onLinkedIn = await ask(dana, 'linkedin', { kind: 'friends' });
    expect(onLinkedIn).toMatchObject({
      fresh: true,
      ask: { platform: 'linkedin', kind: 'friends' },
    });
    const onFacebook = await ask(dana, undefined, { kind: 'friends' });
    expect(onFacebook).toMatchObject({ fresh: true, ask: { platform: 'facebook' } });
    expect((await ask(dana, 'linkedin', { kind: 'friends' })).fresh).toBe(false);
    // A LinkedIn warning ends LinkedIn's waiting ask at the take; Facebook's is taken.
    await warn(dana, 'linkedin', 'You’ve reached the weekly invitation limit');
    const taken = await runAs(dana, ws, 'outreach.ask.take', { installId: pc, underway: null });
    expect(taken.ask).toMatchObject({ platform: 'facebook', kind: 'friends' });
    const [ended] = await rows<{ state: string }>(
      admin(),
      sql`select state from addon_outreach.asks where id = ${onLinkedIn.ask.askId}`,
    );
    expect(ended!.state).toBe('failed');

    // A build from before LinkedIn isn't asked anything there.
    const old = await teammate('Logan Pierce');
    await runAs(old, ws, 'outreach.automation.save', { settings: linkedInOn });
    await beat(old, randomUUID(), '0.33.0');
    expect(await refused(ask(old, 'linkedin', { kind: 'friends' }))).toBe(
      'outreach_extension_too_old',
    );
  });

  it('ask for the work, what’s featured and the rest only of a build from 0.98.0 (decision 99)', async () => {
    const dana = await teammate('Jordan Vale');
    const pc = randomUUID();
    await runAs(dana, ws, 'outreach.automation.save', { settings: linkedInOn });
    const work = { title: 'Owner', company: 'Summit Roof Leads', words: null, since: '2021-03' };
    const featured = { post: 'Five stars from the Parkers.', link: 'https://cal.com/casey' };
    // Refused before it's asked, saying what to do: LinkedIn asks when they started.
    expect(
      await refused(
        ask(dana, 'linkedin', { kind: 'profile_edit', work: { ...work, since: null } }),
      ),
    ).toBe('outreach_profile_edit_refused');
    // 0.97.0 never sees them, so it's asked to update first; its headline still goes in.
    await beat(dana, pc, '0.97.0');
    expect(await refused(ask(dana, 'linkedin', { kind: 'profile_edit', work, featured }))).toBe(
      'outreach_extension_too_old',
    );
    await beat(dana, pc, '0.98.0');
    const made = await ask(dana, 'linkedin', { kind: 'profile_edit', work, featured });
    expect(made).toMatchObject({
      fresh: true,
      ask: { platform: 'linkedin', kind: 'profile_edit' },
    });
    const [row] = await rows<{ task: unknown }>(
      admin(),
      sql`select task from addon_outreach.asks where id = ${made.ask.askId}`,
    );
    expect(row!.task).toMatchObject({
      kind: 'profile_edit',
      bio: null,
      work,
      featured,
      ideal: null,
      services: [],
      linkChanges: [],
    });
  });

  it('ask Instagram only what a build there does, its followers from 0.80.0 and its chats from 0.81.0, and start its day', async () => {
    const dana = await teammate('Rowan Ellis');
    const pc = randomUUID();
    const instagramOn = {
      ...AUTOMATION_DEFAULTS,
      networks: { ...NETWORKS_DEFAULTS, instagram: { ...NETWORK_CHOICES_DEFAULTS, on: true } },
    };
    // Every network is allowed to start, Instagram among them.
    await runAs(dana, ws, 'outreach.automation.save', { settings: instagramOn });
    // A build from before Instagram isn't asked anything there.
    await beat(dana, pc, '0.57.0');
    expect(await refused(ask(dana, 'instagram', { kind: 'checkup' }))).toBe(
      'outreach_extension_too_old',
    );
    await beat(dana, pc, '0.58.0');
    expect(await ask(dana, 'instagram', { kind: 'checkup' })).toMatchObject({
      fresh: true,
      ask: { platform: 'instagram', kind: 'checkup' },
    });
    // Save my followers and unfollowing come with 0.80.0; Instagram has no groups to ask about.
    expect(await refused(ask(dana, 'instagram', { kind: 'friends' }))).toBe(
      'outreach_extension_too_old',
    );
    expect(await refused(ask(dana, 'instagram', { kind: 'groups' }))).toBe(
      'outreach_ask_not_on_network',
    );
    await beat(dana, pc, '0.80.0');
    expect(await ask(dana, 'instagram', { kind: 'friends' })).toMatchObject({
      fresh: true,
      ask: { platform: 'instagram', kind: 'friends' },
    });
    // Checking followers, research, reading chats and a look-up come with 0.81.0 (its part 13).
    expect(await refused(ask(dana, 'instagram', { kind: 'chats' }))).toBe(
      'outreach_extension_too_old',
    );
    for (const kind of ['checks', 'research', 'chats', 'lookup'] as const) {
      expect(tooOldFor('0.80.0', kind, 'instagram')).toBe(true);
      expect(tooOldFor('0.81.0', kind, 'instagram')).toBe(false);
    }
    await beat(dana, pc, '0.81.0');
    expect(await ask(dana, 'instagram', { kind: 'chats' })).toMatchObject({
      fresh: true,
      ask: { platform: 'instagram', kind: 'chats' },
    });
    // Its day starts once they're ready, as any network's does: it isn't looked at anymore.
    expect(await refused(runAs(dana, ws, 'outreach.day.start', { platform: 'instagram' }))).toBe(
      'outreach_not_ready',
    );
  });

  it('ask for LinkedIn’s data file and post only of a build that does them there', async () => {
    expect(tooOldFor('0.41.0', 'file_in', 'linkedin')).toBe(true);
    expect(tooOldFor('0.42.0', 'file_in', 'linkedin')).toBe(false);
    // Facebook's file every build here gets.
    expect(tooOldFor('0.41.0', 'file_in')).toBe(false);
    // LinkedIn's helpful post on the person's feed came after.
    expect(tooOldFor('0.42.0', 'post', 'linkedin')).toBe(true);
    expect(tooOldFor('0.43.0', 'post', 'linkedin')).toBe(false);
    expect(tooOldFor('0.24.0', 'post')).toBe(false);
    const dana = await teammate('Harper Quinn');
    const pc = randomUUID();
    await runAs(dana, ws, 'outreach.automation.save', { settings: linkedInOn });
    await beat(dana, pc, '0.41.0');
    expect(await refused(ask(dana, 'linkedin', { kind: 'file_request' }))).toBe(
      'outreach_extension_too_old',
    );
    expect((await ask(dana, undefined, { kind: 'file_request' })).fresh).toBe(true);
    await beat(dana, pc, '0.42.0');
    expect(await ask(dana, 'linkedin', { kind: 'file_request' })).toMatchObject({
      fresh: true,
      ask: { platform: 'linkedin', kind: 'file_request' },
    });
  });
});

describe('each network’s own line of asks', () => {
  const linkedInOn = {
    ...AUTOMATION_DEFAULTS,
    networks: { ...NETWORKS_DEFAULTS, linkedin: { ...NETWORK_CHOICES_DEFAULTS, on: true } },
  };
  const beat = (u: TestUser, installId: string) =>
    runWith(
      u,
      ws,
      'outreach.live.beat',
      {
        computer: { id: installId, name: 'Chrome on Mac', version: '0.40.0' },
        active: true,
        status: { state: 'idle', line: null, lineAt: null, nextAt: null },
      },
      { channel: 'extension', commandId: randomUUID(), occurredAt: new Date(), sentAt: new Date() },
    );
  const ask = (u: TestUser, platform: string, a: Record<string, unknown>) =>
    runWith(u, ws, 'outreach.ask.make', { platform, ask: a }, { channel: 'web' });
  const stateOf = async (askId: string) =>
    (
      await rows<{ state: string }>(
        admin(),
        sql`select state from addon_outreach.asks where id = ${askId}`,
      )
    )[0]!.state;

  /** Someone with LinkedIn on and a computer on 0.40.0. */
  async function onLinkedIn(name: string): Promise<{ u: TestUser; pc: string }> {
    const u = await teammate(name);
    await runAs(u, ws, 'outreach.automation.save', { settings: linkedInOn });
    const pc = randomUUID();
    await beat(u, pc);
    return { u, pc };
  }

  it('take each network’s asks on its own line, leaving the other’s under way', async () => {
    const { u, pc } = await onLinkedIn('Harper Quinn');
    const onFacebook = await ask(u, 'facebook', { kind: 'friends' });
    const onLinkedIn_ = await ask(u, 'linkedin', { kind: 'friends' });
    const take = (platform: string, underway: string | null) =>
      runAs(u, ws, 'outreach.ask.take', { installId: pc, underway, platform });
    // LinkedIn's line takes only LinkedIn's, though Facebook's is older.
    expect((await take('linkedin', null)).ask).toMatchObject({
      askId: onLinkedIn_.ask.askId,
      platform: 'linkedin',
    });
    // Facebook's line takes Facebook's, and LinkedIn's under way isn't lost for it.
    expect((await take('facebook', null)).ask).toMatchObject({ askId: onFacebook.ask.askId });
    expect(await stateOf(onLinkedIn_.ask.askId)).toBe('working');
    // A restart on LinkedIn's line (nothing under way there) loses only LinkedIn's.
    expect((await take('linkedin', null)).ask).toBeNull();
    expect(await stateOf(onLinkedIn_.ask.askId)).toBe('failed');
    expect(await stateOf(onFacebook.ask.askId)).toBe('working');
  });

  it('say LinkedIn’s day in the beat’s answer, beside Facebook’s, for LinkedIn’s own runner', async () => {
    const { u, pc } = await onLinkedIn('Rowan Hale');
    const first = await beat(u, pc);
    expect(first.day.state).toBe('none');
    expect(first.days.linkedin).toMatchObject({ state: 'none' });
    // Stop for today on LinkedIn: the beat says so for LinkedIn alone.
    await runAs(u, ws, 'outreach.day.stop', { platform: 'linkedin' });
    const after = await beat(u, pc);
    expect(after.days.linkedin).toMatchObject({ state: 'stopped', why: 'person' });
    expect(after.day.state).toBe('none');
  });

  it('end LinkedIn’s waiting asks on a LinkedIn warning, in LinkedIn’s words, and leave Facebook’s', async () => {
    const { u, pc } = await onLinkedIn('Morgan Hale');
    const onFacebook = await ask(u, 'facebook', { kind: 'friends' });
    const onLinkedIn_ = await ask(u, 'linkedin', { kind: 'requests' });
    await warn(u, 'linkedin', 'You’ve reached the weekly invitation limit');
    const take = (platform: string) =>
      runAs(u, ws, 'outreach.ask.take', { installId: pc, underway: null, platform });
    expect((await take('linkedin')).ask).toBeNull();
    const [ended] = await rows<{ state: string; line: string }>(
      admin(),
      sql`select state, line from addon_outreach.asks where id = ${onLinkedIn_.ask.askId}`,
    );
    expect(ended).toEqual({
      state: 'failed',
      line: 'LinkedIn warned you today (“You’ve reached the weekly invitation limit”), so the extension does nothing more on LinkedIn until tomorrow.',
    });
    expect((await take('facebook')).ask).toMatchObject({ askId: onFacebook.ask.askId });
  });

  it('find LinkedIn’s posts with the playbooks’ words, and keep them in no group', async () => {
    const { u } = await onLinkedIn('Sage Morrow');
    const made = await ask(u, 'linkedin', { kind: 'posts' });
    expect(made.ask.platform).toBe('linkedin');
    const [row] = await rows<{ task: { words: string[]; groups: null } }>(
      admin(),
      sql`select task from addon_outreach.asks where id = ${made.ask.askId}`,
    );
    // The quoted words in its signs, then its words for groups.
    expect(row!.task).toEqual({
      kind: 'posts',
      groups: null,
      words: ['Owner', 'Founder', 'CEO', 'small business owners', 'business owners'],
    });
    // The same words for LinkedIn's runner, which finds posts once a day on its own; no hashtags, which are Instagram's.
    expect(await runAs(u, ws, 'outreach.posts.words', { platform: 'linkedin' })).toEqual({
      words: ['Owner', 'Founder', 'CEO', 'small business owners', 'business owners'],
      tags: [],
      places: [],
    });
    // Facebook's goes by groups, as before.
    const fb = await ask(u, 'facebook', { kind: 'posts' });
    const [fbRow] = await rows<{ task: Record<string, unknown> }>(
      admin(),
      sql`select task from addon_outreach.asks where id = ${fb.ask.askId}`,
    );
    expect(fbRow!.task).toEqual({ kind: 'posts', groups: null, words: [] });

    const post = {
      url: 'https://www.linkedin.com/feed/update/urn:li:activity:7380000000000000555/',
      author: {
        id: null,
        username: 'casey-owner-1',
        url: 'https://www.linkedin.com/in/casey-owner-1/',
      },
      name: 'Casey Owner',
      text: 'Can anyone recommend a simple CRM? I’m the owner of a small plumbing business.',
    };
    const saved = await runAs(u, ws, 'outreach.posts.save', {
      platform: 'linkedin',
      group: null,
      posts: [post],
      found: 'scroll',
    });
    expect(saved.groupId).toBeNull();
    expect(saved.posts).toEqual([expect.objectContaining({ url: post.url, check: 'waiting' })]);
    // On Facebook a post is kept only from a group.
    expect(
      await refused(
        runAs(u, ws, 'outreach.posts.save', {
          group: null,
          posts: [{ ...post, url: 'https://www.facebook.com/permalink.php?story_fbid=1&id=2' }],
        }),
      ),
    ).not.toBe('went through');
  });

  it('research someone on the network asked, and put a headline in at LinkedIn’s length', async () => {
    const { u } = await onLinkedIn('Ellis Park');
    const avery = await linkedInProfile('Avery Lane');
    expect((await ask(u, 'linkedin', { kind: 'research', profileId: avery })).ask).toMatchObject({
      platform: 'linkedin',
      kind: 'research',
    });
    // A Facebook profile has nothing to read on LinkedIn.
    const [fb] = await rows<{ id: string }>(
      admin(),
      sql`insert into addon_outreach.profiles (workspace_id, platform, username, url, name)
          values (${ws}, 'facebook', ${`kim.lowe.${randomUUID().slice(0, 4)}`}, 'https://www.facebook.com/kim.lowe.9', 'Kim Lowe')
          returning id`,
    );
    expect(await refused(ask(u, 'linkedin', { kind: 'research', profileId: fb!.id }))).toBe(
      'outreach_research_no_profile',
    );
    // A headline is up to 220 characters on LinkedIn; Facebook's bio stays at 101.
    const headline =
      `Owner at Acme Plumbing | ${'Helping Austin homeowners keep their water running. '.repeat(3)}`.slice(
        0,
        200,
      );
    expect((await ask(u, 'linkedin', { kind: 'profile_edit', bio: headline })).ask.kind).toBe(
      'profile_edit',
    );
    expect(await refused(ask(u, 'facebook', { kind: 'profile_edit', bio: headline }))).toBe(
      'outreach_bio_too_long',
    );
  });
});

describe('one person on two networks', () => {
  const at = () => new Date().toISOString();
  const reach = async (
    u: TestUser,
    platform: 'facebook' | 'linkedin',
    profile: { id: string | null; username: string; url: string },
    name: string,
  ) =>
    (
      await runAs(u, ws, 'outreach.touch.save', {
        platform,
        kind: 'friend_request',
        profile,
        name,
        at: at(),
      })
    ).profileId as string;
  const like = (
    u: TestUser,
    platform: 'facebook' | 'linkedin',
    profile: { id: string | null; username: string; url: string },
    name: string,
  ) => runAs(u, ws, 'outreach.touch.save', { platform, kind: 'like', profile, name, at: at() });
  /** Ties a profile to a customer in Contacts: a new one, or the one named. Their id. */
  const contact = async (u: TestUser, profileId: string, personId: string | null = null) =>
    (await runWith(u, ws, 'outreach.profile.contact', { profileId, personId }, { channel: 'web' }))
      .personId as string;
  const linkedIn = (slug: string) => ({
    id: null,
    username: slug,
    url: `https://www.linkedin.com/in/${slug}/`,
  });
  const facebook = (slug: string) => ({
    id: null,
    username: slug,
    url: `https://www.facebook.com/${slug}`,
  });

  it('covers every profile on a customer with Don’t pitch and Never contact, and never a name alone', async () => {
    const pat = await teammate('Pat Morgan');
    const fb = facebook('jordan.blake.3');
    const li = linkedIn('jordan-blake-cpa');
    const namesake = linkedIn('jordan-blake-9');
    const onFacebook = await reach(pat, 'facebook', fb, 'Jordan Blake');
    const onLinkedIn = await reach(pat, 'linkedin', li, 'Jordan B.');
    await reach(pat, 'linkedin', namesake, 'Jordan Blake');
    await contact(pat, onLinkedIn, await contact(pat, onFacebook));

    // Don't pitch on their Facebook covers their LinkedIn: the same customer. Another Jordan Blake there isn't them.
    await runAs(pat, ws, 'outreach.friend.set', { profileId: onFacebook, dontPitch: true });
    expect(await refused(like(pat, 'linkedin', li, 'Jordan B.'))).toBe('outreach_dont_pitch');
    await like(pat, 'linkedin', namesake, 'Jordan Blake');
    const [listed] = await rows<{ twin: boolean }>(
      admin(),
      sql`select exists (select 1 from addon_outreach.profiles tw
            where tw.person_id = p.person_id and tw.id <> p.id and tw.dont_pitch) as twin
          from addon_outreach.profiles p where p.id = ${onLinkedIn}`,
    );
    expect(listed!.twin).toBe(true);
    await runAs(pat, ws, 'outreach.friend.set', { profileId: onFacebook, dontPitch: false });
    await like(pat, 'linkedin', li, 'Jordan B.');

    // Never contact on their LinkedIn covers their Facebook.
    await runAs(pat, ws, 'outreach.friend.set', { profileId: onLinkedIn, neverContact: true });
    expect(await refused(like(pat, 'facebook', fb, 'Jordan Blake'))).toBe('outreach_never_contact');
    await runAs(pat, ws, 'outreach.friend.set', { profileId: onLinkedIn, neverContact: false });
    await like(pat, 'facebook', fb, 'Jordan Blake');
  });

  it('doesn’t start someone again on LinkedIn once they were pitched or booked on Facebook', async () => {
    const lee = await teammate('Lee Harper');
    const onFacebook = await reach(lee, 'facebook', facebook('casey.north.4'), 'Casey North');
    const onLinkedIn = await reach(lee, 'linkedin', linkedIn('casey-north'), 'Casey North');
    await contact(lee, onLinkedIn, await contact(lee, onFacebook));
    // The AI found Casey a good fit among Lee's LinkedIn connections: Reconnect.
    await rows(
      admin(),
      sql`insert into addon_outreach.checks (workspace_id, user_id, profile_id, verdict, why, looked_at)
          values (${ws}, ${lee.id}, ${onLinkedIn}, 'good', array['Runs a small accounting firm'], now())`,
    );
    const onLinkedInToday = async () =>
      (await runAs(lee, ws, 'outreach.today', { platform: 'linkedin' })).items
        .filter((i: { name: string }) => i.name === 'Casey North')
        .map((i: { kind: string }) => i.kind);
    expect(await onLinkedInToday()).toEqual(['reconnect']);

    await runAs(lee, ws, 'outreach.stage.mark', { profileId: onFacebook, mark: 'pitched' });
    expect(await onLinkedInToday()).toEqual([]);
    await runAs(lee, ws, 'outreach.stage.mark', { profileId: onFacebook, mark: 'open' });
    expect(await onLinkedInToday()).toEqual(['reconnect']);

    // Booked on Facebook, by anyone here: the same.
    await runAs(lee, ws, 'outreach.demo.mark', { profileId: onFacebook, booked: true });
    expect(await onLinkedInToday()).toEqual([]);
    await runAs(lee, ws, 'outreach.demo.mark', { profileId: onFacebook, booked: false });
    expect(await onLinkedInToday()).toEqual(['reconnect']);
  });
});

/**
 * LinkedIn's people found by topic (decision 92): a good post's writer reaches Today only after the AI's check of
 * them from their own page, liked on the post it found, then invited a day after; who reacted gets a post of their own
 * liked. A comment no longer stands in for the like. Anyone the old search pick warmed up before the switch to
 * finding by topic still gets their invitation; a like or comment since never counts. Only a computer on 0.95.0 or
 * later gets this list.
 */
describe('people found by topic on LinkedIn', () => {
  const POST = 'https://www.linkedin.com/feed/update/urn:li:activity:7390000000000000777/';
  const OLD_POST = 'https://www.linkedin.com/feed/update/urn:li:activity:7390000000000000778/';
  const COLD_POST = 'https://www.linkedin.com/feed/update/urn:li:activity:7390000000000000779/';
  const person = (slug: string) => ({
    id: null,
    username: slug,
    url: `https://www.linkedin.com/in/${slug}/`,
  });
  const idOf = async (slug: string) =>
    (
      await rows<{ id: string }>(
        admin(),
        sql`select id from addon_outreach.profiles where workspace_id = ${ws} and username = ${slug}`,
      )
    )[0]!.id;
  const postIdOf = async (u: TestUser, url: string) =>
    (
      await rows<{ id: string }>(
        admin(),
        sql`select id from addon_outreach.posts where workspace_id = ${ws} and user_id = ${u.id} and url = ${url}`,
      )
    )[0]!.id;
  /** The AI's check of someone found, from their own page: good, maybe or not, for the playbook. */
  const checked = async (u: TestUser, slug: string, fit: 'good' | 'maybe' | 'not', why: string) => {
    const [playbook] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_outreach.playbooks where workspace_id = ${ws} and name = 'CRM demos'`,
    );
    await checkedAs(u, ws, await idOf(slug), { fit, why: [why], playbookId: playbook!.id });
  };
  /** A like or a comment noted so many hours ago; a comment on the post it was under. */
  const touched = (
    u: TestUser,
    slug: string,
    kind: 'like' | 'comment',
    hoursAgo: number,
    postUrl: string | null = null,
  ) =>
    rows(
      admin(),
      sql`insert into addon_outreach.touches (workspace_id, profile_id, user_id, kind, at, post_url)
          select ${ws}, p.id, ${u.id}, ${kind}, now() - ${`${hoursAgo} hours`}::interval, ${postUrl}
          from addon_outreach.profiles p where p.workspace_id = ${ws} and p.username = ${slug}`,
    );
  type Listed = {
    name: string;
    kind: string;
    why: string[];
    postId: string | null;
    postUrl: string | null;
    post: string | null;
  };
  const listOf = async (u: TestUser, platform?: 'linkedin') =>
    (await runAs(u, ws, 'outreach.today', platform ? { platform } : {})).items as Listed[];

  it('likes a writer’s found post once the AI checked them good, then invites them; a reactor gets a post of their own', async () => {
    const sky = await teammate('Sky Reyes');
    await computerOn(sky, ws, '0.95.0');
    await runAs(sky, ws, 'outreach.posts.save', {
      platform: 'linkedin',
      found: 'search',
      words: 'missed calls',
      posts: [
        {
          url: POST,
          author: person('robin-vale-plumbing'),
          name: 'Robin Vale',
          text: 'I’m the owner of a small plumbing business and we keep missing calls. Can anyone recommend a simple CRM?',
        },
      ],
    });
    const postId = await postIdOf(sky, POST);
    // The AI said the post was worth a comment: its writer is found.
    await rows(
      admin(),
      sql`update addon_outreach.posts set check_state = 'waiting' where id = ${postId}`,
    );
    await runAsSystem(ws, 'outreach.post.check', {
      postId,
      check: { good: true, strong: false, why: 'Asking for a simple CRM' },
    });
    // Who reacted to it, as the computer read them.
    await runAs(sky, ws, 'outreach.finds.save', {
      platform: 'linkedin',
      how: 'liked',
      postId,
      people: [
        { profile: person('quinn-harper-roofing'), name: 'Quinn Harper' },
        { profile: person('drew-park-hvac'), name: 'Drew Park' },
        { profile: person('ellis-ford-design'), name: 'Ellis Ford' },
      ],
    });
    const names = ['Robin Vale', 'Quinn Harper', 'Drew Park', 'Ellis Ford'];
    const found = async () =>
      (await listOf(sky, 'linkedin'))
        .filter((i) => names.includes(i.name))
        .map((i) => [i.name, i.kind]);
    // Nobody before the AI's check of them: only the post's comment.
    expect(await found()).toEqual([['Robin Vale', 'comment']]);

    await checked(sky, 'robin-vale-plumbing', 'good', 'Owns a small plumbing business');
    await checked(sky, 'quinn-harper-roofing', 'good', 'Runs a roofing crew');
    await checked(sky, 'drew-park-hvac', 'maybe', 'Might run an HVAC company');
    await checked(sky, 'ellis-ford-design', 'not', 'A designer, not a trade');
    const list = await listOf(sky, 'linkedin');
    // A no is never listed; a maybe fills what's left after the good fits (decision 126, answer 5a).
    expect(list.filter((i) => names.includes(i.name)).map((i) => [i.name, i.kind])).toEqual([
      ['Robin Vale', 'comment'],
      ['Robin Vale', 'warm_up'],
      ['Quinn Harper', 'warm_up'],
      ['Drew Park', 'warm_up'],
    ]);
    // The writer's like goes on the post it found; a reactor's on one of their own.
    const robin = list.find((i) => i.name === 'Robin Vale' && i.kind === 'warm_up')!;
    expect(robin).toMatchObject({
      postId,
      postUrl: POST,
      post: expect.stringMatching(/^I’m the owner/),
    });
    expect(robin.why).toEqual([
      'Wrote a post your search for “missed calls” found',
      'Owns a small plumbing business',
      'Like the post it found: their invitation to connect comes a day after',
    ]);
    const quinn = list.find((i) => i.name === 'Quinn Harper')!;
    expect(quinn).toMatchObject({ postId: null, postUrl: null, post: null });
    expect(quinn.why).toEqual([
      'Reacted to a post your search for “missed calls” found',
      'Runs a roofing crew',
      'Their invitation to connect comes a day after',
    ]);

    // A comment on the post no longer stands in for the like.
    await touched(sky, 'robin-vale-plumbing', 'comment', 21, POST);
    expect((await found()).filter(([name]) => name === 'Robin Vale')).toEqual([
      ['Robin Vale', 'warm_up'],
    ]);
    // Liked yesterday: the invitation comes.
    await touched(sky, 'robin-vale-plumbing', 'like', 21);
    const invited = (await listOf(sky, 'linkedin')).find(
      (i) => i.name === 'Robin Vale' && i.kind === 'friend_request',
    );
    expect(invited?.why).toEqual([
      'Wrote a post your search for “missed calls” found',
      'Owns a small plumbing business',
      'You liked the post it found',
    ]);
    // Facebook's list never has them: they're on LinkedIn.
    expect((await listOf(sky)).filter((i) => names.includes(i.name))).toEqual([]);
  });

  it('never invites a writer found and commented on since, without a good check of them', async () => {
    const jo = await teammate('Jo Lane');
    await computerOn(jo, ws, '0.95.0');
    const TAYLOR_POST = 'https://www.linkedin.com/feed/update/urn:li:activity:7390000000000000780/';
    const MORGAN_POST = 'https://www.linkedin.com/feed/update/urn:li:activity:7390000000000000781/';
    await runAs(jo, ws, 'outreach.posts.save', {
      platform: 'linkedin',
      found: 'search',
      words: 'missed calls',
      posts: [
        {
          url: TAYLOR_POST,
          author: person('taylor-reed-roofing'),
          name: 'Taylor Reed',
          text: 'I’m the owner of a small roofing business and we keep missing calls. Can anyone recommend a simple CRM?',
        },
        {
          url: MORGAN_POST,
          author: person('morgan-ash-hvac'),
          name: 'Morgan Ash',
          text: 'I’m the owner of a small HVAC business and we keep missing calls. Can anyone recommend a simple CRM?',
        },
      ],
    });
    for (const url of [TAYLOR_POST, MORGAN_POST]) {
      const postId = await postIdOf(jo, url);
      await rows(
        admin(),
        sql`update addon_outreach.posts set check_state = 'waiting' where id = ${postId}`,
      );
      await runAsSystem(ws, 'outreach.post.check', {
        postId,
        check: { good: true, strong: false, why: 'Asking for a simple CRM' },
      });
    }
    // Found two days ago, and LinkedIn commented on both posts on its own yesterday.
    await rows(
      admin(),
      sql`update addon_outreach.finds set created_at = now() - interval '2 days'
          where workspace_id = ${ws} and user_id = ${jo.id}`,
    );
    await touched(jo, 'taylor-reed-roofing', 'comment', 21, TAYLOR_POST);
    await touched(jo, 'morgan-ash-hvac', 'comment', 21, MORGAN_POST);
    // The AI said Taylor might fit; Morgan's check hasn't come.
    await checked(jo, 'taylor-reed-roofing', 'maybe', 'Might run a roofing crew');
    // A comment since they were found is no warm-up the old pick gave: only a check that they fit, or might (decision
    // 126, answer 5a), lists them.
    expect(
      (await listOf(jo, 'linkedin'))
        .filter((i) => ['Taylor Reed', 'Morgan Ash'].includes(i.name) && i.kind !== 'comment')
        .map((i) => [i.name, i.kind]),
    ).toEqual([['Taylor Reed', 'warm_up']]);
  });

  it('still invites a writer the old search pick warmed up, and a computer before 0.95.0 keeps that pick', async () => {
    const kim = await teammate('Kim Vale');
    await computerOn(kim, ws, '0.95.0');
    await runAs(kim, ws, 'outreach.posts.save', {
      platform: 'linkedin',
      found: 'search',
      posts: [
        {
          url: OLD_POST,
          author: person('avery-north-electric'),
          name: 'Avery North',
          text: 'Owner of a small electrical company here. What CRM do you use for quotes?',
        },
        {
          url: COLD_POST,
          author: person('jules-park-cleaning'),
          name: 'Jules Park',
          text: 'Owner of a cleaning company. Any CRM tips for a small team?',
        },
      ],
    });
    // Called good before the computer found people by topic: no find, no check of them.
    await rows(
      admin(),
      sql`update addon_outreach.posts set check_state = 'good'
          where workspace_id = ${ws} and user_id = ${kim.id}`,
    );
    // Avery was warmed up with a comment, as the old pick did on LinkedIn.
    await touched(kim, 'avery-north-electric', 'comment', 21, OLD_POST);
    const writers = async () =>
      (await listOf(kim, 'linkedin'))
        .filter((i) => i.kind !== 'comment')
        .map((i) => [i.name, i.kind, i.why[0]]);
    // Avery carries on to the invitation; Jules, never warmed and never checked, gets nothing new.
    expect(await writers()).toEqual([
      ['Avery North', 'friend_request', 'Wrote a post your search on LinkedIn found'],
    ]);

    // An older build on the computer that works now: the old search pick, as it was.
    await computerOn(kim, ws, '0.94.0');
    expect(await writers()).toEqual([
      ['Avery North', 'friend_request', 'Wrote a post your search on LinkedIn found'],
    ]);
    // With no comment of Avery's, the old pick waits on the comment; the new one on the AI's check.
    await rows(
      admin(),
      sql`delete from addon_outreach.touches where workspace_id = ${ws} and user_id = ${kim.id}`,
    );
    expect(await writers()).toEqual([]);
    expect(
      (await listOf(kim, 'linkedin')).filter((i) => i.kind === 'comment').map((i) => i.name),
    ).toEqual(expect.arrayContaining(['Avery North', 'Jules Park']));
  });

  it('never carries a writer whose only warm-up came after the switch to finding by topic', async () => {
    const lou = await teammate('Lou Marsh');
    await computerOn(lou, ws, '0.95.0');
    const BEFORE_POST = 'https://www.linkedin.com/feed/update/urn:li:activity:7390000000000000782/';
    const AFTER_POST = 'https://www.linkedin.com/feed/update/urn:li:activity:7390000000000000783/';
    await runAs(lou, ws, 'outreach.posts.save', {
      platform: 'linkedin',
      found: 'search',
      posts: [
        {
          url: BEFORE_POST,
          author: person('dale-moss-roofing'),
          name: 'Dale Moss',
          text: 'Owner of a small roofing company here. What CRM do you use for quotes?',
        },
        {
          url: AFTER_POST,
          author: person('noor-bright-painting'),
          name: 'Noor Bright',
          text: 'Owner of a painting company. Any CRM tips for a small team?',
        },
      ],
    });
    // Both called good before the switch: no find of either writer, and no check of them.
    await rows(
      admin(),
      sql`update addon_outreach.posts set check_state = 'good'
          where workspace_id = ${ws} and user_id = ${lou.id}`,
    );
    // Lou's computer first worked on 0.95.0 30 hours ago, and Lou has found nobody on LinkedIn yet.
    const switchedAt = (at: string | null) =>
      rows(
        admin(),
        sql`update addon_outreach.computers set found_by_topic_at = ${at}::timestamptz
            where workspace_id = ${ws} and user_id = ${lou.id}`,
      );
    await switchedAt(new Date(Date.now() - 30 * 3_600_000).toISOString());
    // Dale was warmed up with a comment before it; Noor's post had LinkedIn's comment on its own since, and a like.
    await touched(lou, 'dale-moss-roofing', 'comment', 40, BEFORE_POST);
    await touched(lou, 'noor-bright-painting', 'comment', 26, AFTER_POST);
    await touched(lou, 'noor-bright-painting', 'like', 25);
    const writers = async () =>
      (await listOf(lou, 'linkedin'))
        .filter((i) => ['Dale Moss', 'Noor Bright'].includes(i.name) && i.kind !== 'comment')
        .map((i) => [i.name, i.kind]);
    // Dale carries on to the invitation; Noor, never checked by the AI, gets nothing.
    expect(await writers()).toEqual([['Dale Moss', 'friend_request']]);

    // A computer removed since takes its time with it: Lou's first find on LinkedIn, 30 hours ago, still says when.
    await switchedAt(null);
    await rows(
      admin(),
      sql`with made as (
            insert into addon_outreach.profiles (workspace_id, platform, username, url, name)
            values (${ws}, 'linkedin', 'sasha-made-up-9', 'https://www.linkedin.com/in/sasha-made-up-9/',
              'Sasha Madeup')
            returning id)
          insert into addon_outreach.finds (workspace_id, user_id, profile_id, platform, how, found_at, created_at)
          select ${ws}, ${lou.id}, id, 'linkedin', 'liked', now() - interval '30 hours', now() - interval '30 hours'
          from made`,
    );
    expect(await writers()).toEqual([['Dale Moss', 'friend_request']]);

    // With no switch known at all, no warm-up carries anyone.
    await rows(
      admin(),
      sql`delete from addon_outreach.finds where workspace_id = ${ws} and user_id = ${lou.id}`,
    );
    expect(await writers()).toEqual([]);
  });
});

describe('each network’s own limits', () => {
  it('keep LinkedIn’s invitations under 80 in any 7 days, and Facebook’s as they were', async () => {
    const kim = await teammate('Kim Park');
    // 70 invitations over the last six days, none of them today.
    await rows(
      admin(),
      sql`insert into addon_outreach.profiles (workspace_id, platform, username, url, name)
          select ${ws}, 'linkedin', 'kim-invite-' || i, 'https://www.linkedin.com/in/kim-invite-' || i || '/', 'Invite ' || i
          from generate_series(1, 70) i`,
    );
    await rows(
      admin(),
      sql`insert into addon_outreach.touches (workspace_id, profile_id, user_id, kind, at)
          select ${ws}, p.id, ${kim.id}, 'friend_request', now() - interval '2 days' - (row_number() over () * interval '1 hour')
          from addon_outreach.profiles p where p.workspace_id = ${ws} and p.username like 'kim-invite-%'`,
    );
    const linkedIn = await runAs(kim, ws, 'outreach.today', { platform: 'linkedin' });
    expect(linkedIn.week).toEqual({ done: 70, most: 80 });
    expect(linkedIn.limits.friend_request).toEqual({ done: 0, most: 10 });
    const facebook = await runAs(kim, ws, 'outreach.today', {});
    expect(facebook.week).toBeNull();
    expect(facebook.limits.friend_request.most).toBe(NETWORKS.facebook.dailyLimits.friend_request);
  });

  it('keep each network’s checks to its own people and its own profiles read a day', async () => {
    const lou = await teammate('Lou Grant');
    const known = async (profileId: string) =>
      rows(
        admin(),
        sql`insert into addon_outreach.friends (workspace_id, user_id, profile_id, state, since, seen_at)
            values (${ws}, ${lou.id}, ${profileId}, 'friends', now(), now())
            on conflict (workspace_id, user_id, profile_id) do update set state = 'friends'`,
      );
    const onLinkedIn = await linkedInProfile('Ari Moss');
    await known(onLinkedIn);
    const onFacebook = await runAs(lou, ws, 'outreach.touch.save', {
      kind: 'friend_request',
      profile: { id: null, username: 'ari.moss.5', url: 'https://www.facebook.com/ari.moss.5' },
      name: 'Ari Moss',
      at: new Date().toISOString(),
    });
    await known(onFacebook.profileId);
    const next = async (platform?: 'linkedin') =>
      (await runAs(lou, ws, 'outreach.checks.next', platform ? { platform } : {})) as {
        people: { profileId: string }[];
        today: number;
        perDay: number;
      };
    expect((await next('linkedin')).people.map((p) => p.profileId)).toEqual([onLinkedIn]);
    expect((await next()).people.map((p) => p.profileId)).toEqual([onFacebook.profileId]);

    // A LinkedIn profile read today counts on LinkedIn alone.
    await rows(
      admin(),
      sql`insert into addon_outreach.checks (workspace_id, user_id, profile_id, verdict, looked_at)
          values (${ws}, ${lou.id}, ${onLinkedIn}, 'waiting', now())`,
    );
    expect(await next('linkedin')).toMatchObject({
      today: 1,
      perDay: NETWORKS.linkedin.checksPerDay,
    });
    expect(await next()).toMatchObject({ today: 0 });
    // A LinkedIn warning halves LinkedIn's, never Facebook's.
    await warn(lou, 'linkedin', 'Your account has been restricted');
    expect((await next('linkedin')).perDay).toBe(NETWORKS.linkedin.checksPerDay / 2);
    expect((await next()).perDay).toBe(NETWORKS.facebook.checksPerDay);
  });
});

describe('each network’s own profile in Get ready', () => {
  /** The AI's check of someone's profile on a network, as the worker keeps it: every item right. */
  const checked = (userId: string, platform: 'facebook' | 'linkedin', version: number | null) =>
    runAsSystem(ws, 'outreach.profile.check_save', {
      userId,
      platform,
      check: {
        items: Object.fromEntries(
          PROFILE_ITEMS_ON[platform].map((i) => [i, { ok: true, why: 'Looks right.', fix: null }]),
        ),
        bios: [
          platform === 'linkedin'
            ? 'I help owners of small businesses book more calls in 30 days, or they don’t pay'
            : 'I help owners book more calls.',
        ],
        coverLine: 'More booked calls',
        feature: [],
        at: new Date().toISOString(),
        version,
      },
    });
  const profileItem = async (u: TestUser, platform?: 'linkedin') =>
    (
      (await runAs(u, ws, 'outreach.readiness', platform ? { platform } : {})) as {
        platform: string;
        items: { item: string; state: string; left: string | null }[];
        offer: { version: number } | null;
      }
    ).items.find((i) => i.item === 'profile')!;

  it('keeps LinkedIn’s profile apart from Facebook’s, with its headline and About', async () => {
    const sky = await teammate('Sky Turner');
    // Today on Facebook readies the business's offer and playbook, and Sky's Facebook profile, as the fixture does.
    await runAs(sky, ws, 'outreach.today', {});
    await rows(
      admin(),
      sql`update addon_outreach.setup set network_profiles = '{}'::jsonb
          where workspace_id = ${ws} and user_id = ${sky.id}`,
    );
    const offer = (await runAs(sky, ws, 'outreach.readiness', {})) as {
      offer: { version: number } | null;
    };
    expect((await profileItem(sky)).state).toBe('done');
    expect(await profileItem(sky, 'linkedin')).toEqual({
      item: 'profile',
      state: 'todo',
      whose: 'person',
      left: 'Have the extension read your LinkedIn profile. The AI says what to change, and writes your headline and About.',
    });

    // The worker keeps LinkedIn's check: LinkedIn's profile is right, and Facebook's as it was.
    await checked(sky.id, 'linkedin', offer.offer?.version ?? null);
    expect((await profileItem(sky, 'linkedin')).state).toBe('done');
    expect((await profileItem(sky)).state).toBe('done');

    // About is LinkedIn's alone: ticked there, refused on Facebook.
    await runAs(sky, ws, 'outreach.readiness.profile', {
      platform: 'linkedin',
      item: 'about',
      done: true,
    });
    const [kept] = await rows<{
      network_profiles: { linkedin: { ticks: Record<string, unknown> } };
    }>(
      admin(),
      sql`select network_profiles from addon_outreach.setup
          where workspace_id = ${ws} and user_id = ${sky.id}`,
    );
    expect(Object.keys(kept!.network_profiles.linkedin.ticks)).toEqual(['about']);
    expect(
      await refused(runAs(sky, ws, 'outreach.readiness.profile', { item: 'about', done: true })),
    ).toBe('validation');
  });

  it('says which network’s profile is left, and never holds that network’s day for it', () => {
    const facts = {
      offer: null,
      playbooks: [],
      profile: {},
      profileCheck: null,
      messages: null,
      numbers: { goal: null, at: null },
      canOffer: true,
      canPlaybooks: true,
    };
    const onLinkedIn = readinessOf({ ...facts, platform: 'linkedin' });
    expect(onLinkedIn.items.find((i) => i.item === 'profile')!.left).toContain('LinkedIn profile');
    // Only the profile left: advice (decision 90), so nothing holds the day.
    expect(
      notReadyWords({
        ...onLinkedIn,
        items: onLinkedIn.items.map((i) => (i.item === 'profile' ? i : { ...i, state: 'done' })),
        platform: 'linkedin',
      }),
    ).toBe('');
    // No playbook runs there: that's what holds it, and where it's changed.
    expect(
      notReadyWords({
        ...onLinkedIn,
        items: onLinkedIn.items.map((i) =>
          i.item === 'profile' || i.item === 'playbook' ? i : { ...i, state: 'done' },
        ),
        platform: 'linkedin',
      }),
    ).toBe(
      'None of your playbooks runs on LinkedIn yet. Turn LinkedIn on under Where in one on the Playbooks tab, or write one for it.',
    );
    // LinkedIn's checklist has About; Facebook's doesn't.
    expect(PROFILE_ITEMS_ON.linkedin).toContain('about');
    expect(PROFILE_ITEMS).not.toContain('about');
  });
});

describe('growing on LinkedIn', () => {
  const linkedIn = (slug: string) => ({
    id: null,
    username: slug,
    url: `https://www.linkedin.com/in/${slug}/`,
  });

  it('keeps posts found by LinkedIn’s search, in no group, and never Facebook’s without one', async () => {
    const ana = await teammate('Ana Ruiz');
    const saved = (await runAs(ana, ws, 'outreach.posts.save', {
      platform: 'linkedin',
      found: 'search',
      posts: [
        {
          url: 'https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000001/',
          author: linkedIn('jo-park-ops'),
          name: 'Jo Park',
          text: 'Can anyone recommend a CRM for a small team? Looking for something simple.',
        },
      ],
    })) as { groupId: string | null; posts: { check: string | null }[] };
    expect(saved.groupId).toBeNull();
    expect(saved.posts[0]!.check).toBe('waiting');
    const [kept] = await rows<{ group_id: string | null; found: string; platform: string }>(
      admin(),
      sql`select po.group_id, po.found, pr.platform from addon_outreach.posts po
          join addon_outreach.profiles pr on pr.id = po.profile_id
          where po.workspace_id = ${ws} and po.user_id = ${ana.id}`,
    );
    expect(kept).toEqual({ group_id: null, found: 'search', platform: 'linkedin' });
    expect(
      await refused(
        runAs(ana, ws, 'outreach.posts.save', {
          posts: [
            {
              url: 'https://www.facebook.com/groups/1/posts/2/',
              author: {
                id: null,
                username: 'jo.park.1',
                url: 'https://www.facebook.com/jo.park.1',
              },
              name: 'Jo Park',
              text: 'Can anyone recommend a CRM?',
            },
          ],
        }),
      ),
    ).toBe('validation');
  });

  it('writes LinkedIn’s helpful post for the person’s own feed, its day apart from Facebook’s', async () => {
    const rae = await teammate('Rae Kim');
    const asked = (await runAs(rae, ws, 'outreach.helpful.ask', { platform: 'linkedin' })) as {
      helpfulId: string;
      groupName: string | null;
      fresh: boolean;
    };
    expect(asked).toMatchObject({ groupName: null, fresh: true });
    expect(await runAs(rae, ws, 'outreach.helpful.ask', { platform: 'linkedin' })).toMatchObject({
      helpfulId: asked.helpfulId,
      fresh: false,
    });
    // Facebook's is its own: Rae is in no group there, so none goes up.
    expect(await refused(runAs(rae, ws, 'outreach.helpful.ask', {}))).toBe(
      'outreach_helpful_no_group',
    );
    expect(
      await refused(
        runAs(rae, ws, 'outreach.helpful.ask', { platform: 'linkedin', groupId: randomUUID() }),
      ),
    ).toBe('validation');
    const list = (await runAs(rae, ws, 'outreach.helpful', { platform: 'linkedin' })) as {
      posts: { platform: string; groupId: string | null; state: string }[];
    };
    expect(list.posts).toEqual([
      expect.objectContaining({ platform: 'linkedin', groupId: null, state: 'drafting' }),
    ]);
    expect(((await runAs(rae, ws, 'outreach.helpful', {})) as { posts: unknown[] }).posts).toEqual(
      [],
    );

    // Written, posted on the feed, and whoever comments is a warm lead on LinkedIn's Today alone.
    await runAsSystem(ws, 'outreach.helpful.draft', {
      helpfulId: asked.helpfulId,
      draft: {
        allowed: true,
        topic: 'Following up',
        text: 'Most deals are lost in the follow-up.\n\nWhat’s your best follow-up tip?',
        why: 'People ask how to follow up',
      },
    });
    await runAs(rae, ws, 'outreach.helpful.posted', {
      helpfulId: asked.helpfulId,
      posted: true,
      url: 'https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000002/',
    });
    expect(
      await runAs(rae, ws, 'outreach.helpful.engaged', {
        helpfulId: asked.helpfulId,
        comments: [
          {
            profile: linkedIn('mo-lane-cpa'),
            name: 'Mo Lane',
            comment: 'Great tip, we struggle with this too.',
          },
        ],
      }),
    ).toMatchObject({ added: 1 });
    const today = async (platform?: 'linkedin') =>
      (await runAs(rae, ws, 'outreach.today', platform ? { platform } : {})).items.map(
        (i: { kind: string; name: string }) => `${i.kind}: ${i.name}`,
      );
    expect(await today('linkedin')).toContain('warm_lead: Mo Lane');
    expect(await today()).not.toContain('warm_lead: Mo Lane');
  });

  it('writes one helpful post a week on Instagram, with its picture, posted from the phone', async () => {
    const sky = await teammate('Sky Ortiz');
    const asked = (await runAs(sky, ws, 'outreach.helpful.ask', { platform: 'instagram' })) as {
      helpfulId: string;
      fresh: boolean;
    };
    expect(asked.fresh).toBe(true);
    const list = async (platform: 'instagram' | 'alignable') =>
      (await runAs(sky, ws, 'outreach.helpful', { platform })) as {
        posts: { helpfulId: string; how: string; state: string; picture: string | null }[];
        every: number;
        posting: string;
      };
    // Whatever their posting choice, Instagram's is copied and posted from the phone.
    expect(await list('instagram')).toMatchObject({ every: 7, posting: 'copy' });
    await runAsSystem(ws, 'outreach.helpful.draft', {
      helpfulId: asked.helpfulId,
      draft: {
        allowed: true,
        topic: 'Following up',
        text: 'Most jobs are won in the follow-up. #smallbusiness',
        why: 'People ask how to follow up',
        picture: 'Your notebook of follow-up dates on the dashboard',
      },
    });
    expect((await list('instagram')).posts[0]).toMatchObject({
      how: 'copy',
      state: 'draft',
      picture: 'Your notebook of follow-up dates on the dashboard',
    });
    expect(
      await refused(runAs(sky, ws, 'outreach.helpful.ok', { helpfulId: asked.helpfulId })),
    ).toBe('outreach_helpful_phone');
    await runAs(sky, ws, 'outreach.helpful.posted', { helpfulId: asked.helpfulId, posted: true });
    // One a week: the next waits till its week is done.
    expect(await refused(runAs(sky, ws, 'outreach.helpful.ask', { platform: 'instagram' }))).toBe(
      'outreach_helpful_week',
    );
    await admin().execute(
      sql`update addon_outreach.helpful set asked_at = asked_at - interval '7 days'
          where id = ${asked.helpfulId}`,
    );
    expect(await runAs(sky, ws, 'outreach.helpful.ask', { platform: 'instagram' })).toMatchObject({
      fresh: true,
    });

    // Alignable's is for their own profile, OK'd for their computer, and never goes on its own.
    const onAlignable = (await runAs(sky, ws, 'outreach.helpful.ask', {
      platform: 'alignable',
    })) as { helpfulId: string };
    expect(await list('alignable')).toMatchObject({ every: 7, posting: 'after_ok' });
    await runAsSystem(ws, 'outreach.helpful.draft', {
      helpfulId: onAlignable.helpfulId,
      draft: { allowed: true, topic: 'Follow-ups', text: 'A tip for local owners.', why: 'Asked' },
    });
    expect(
      await runAs(sky, ws, 'outreach.helpful.ok', { helpfulId: onAlignable.helpfulId }),
    ).toMatchObject({ state: 'approved' });
    expect((await list('alignable')).posts[0]).toMatchObject({ how: 'after_ok', picture: null });
  });
});

describe('LinkedIn’s data file', () => {
  const DAY = 86_400_000;
  const li = (slug: string) => ({
    id: null,
    username: slug,
    url: `https://www.linkedin.com/in/${slug}/`,
  });
  const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();
  const sinceOf = async (u: TestUser, slug: string) => {
    const [row] = await rows<{ state: string; since: Date }>(
      admin(),
      sql`select f.state, f.since from addon_outreach.friends f
          join addon_outreach.profiles p on p.id = f.profile_id
          where f.user_id = ${u.id} and p.username = ${slug}`,
    );
    return row ? { state: row.state, since: new Date(row.since).toISOString() } : null;
  };

  it('keeps when each began, so an invitation sent long ago is old at once', async () => {
    const kai = await teammate('Kai Morgan');
    const longAgo = daysAgo(60);
    const before = Date.now();
    await runAs(kai, ws, 'outreach.friends.save', {
      platform: 'linkedin',
      list: 'sent',
      people: [
        { profile: li('ava-long-ago'), name: 'Ava Long', mutualFriends: null, since: longAgo },
        { profile: li('ben-new-one'), name: 'Ben New', mutualFriends: null },
        // A date ahead of now is taken as now.
        { profile: li('cy-ahead'), name: 'Cy Ahead', mutualFriends: null, since: daysAgo(-3) },
      ],
    });
    expect(await sinceOf(kai, 'ava-long-ago')).toEqual({ state: 'request_sent', since: longAgo });
    expect(Date.parse((await sinceOf(kai, 'cy-ahead'))!.since)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse((await sinceOf(kai, 'cy-ahead'))!.since)).toBeGreaterThanOrEqual(
      before - 1000,
    );
    const tidy = await runAs(kai, ws, 'outreach.friends.tidy', { platform: 'linkedin' });
    expect(tidy.cancel.map((c: { name: string }) => c.name)).toEqual(['Ava Long']);

    // Seen again: a later look keeps when it began; a list that says an earlier beginning moves it back.
    await runAs(kai, ws, 'outreach.friends.save', {
      platform: 'linkedin',
      list: 'sent',
      people: [{ profile: li('ava-long-ago'), name: 'Ava Long', mutualFriends: null }],
    });
    expect((await sinceOf(kai, 'ava-long-ago'))!.since).toBe(longAgo);
    const earlier = daysAgo(90);
    await runAs(kai, ws, 'outreach.friends.save', {
      platform: 'linkedin',
      list: 'sent',
      people: [
        { profile: li('ben-new-one'), name: 'Ben New', mutualFriends: null, since: earlier },
      ],
    });
    expect((await sinceOf(kai, 'ben-new-one'))!.since).toBe(earlier);
    // A connection since a year ago is one since then.
    const connected = daysAgo(400);
    await runAs(kai, ws, 'outreach.friends.save', {
      platform: 'linkedin',
      list: 'friends',
      people: [
        { profile: li('cy-ahead'), name: 'Cy Ahead', mutualFriends: null, since: connected },
      ],
    });
    expect(await sinceOf(kai, 'cy-ahead')).toEqual({ state: 'friends', since: connected });
  });
});
