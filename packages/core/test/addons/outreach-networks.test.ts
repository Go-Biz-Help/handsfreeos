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
import { preDaySteps } from '../../src/addons/outreach/lists';
import { networkOfLink, NETWORKS, profileMisfit } from '../../src/addons/outreach/networks';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { outreachBusiness, refused, runAs, runWith } from './outreach-fixture';

const admin = () => testDbs().admin.db;

let owner: TestUser;
let ws: string;

beforeAll(async () => {
  owner = await createTestUser('outn-owner', { fullName: 'Morgan Owner' });
  ws = await outreachBusiness(owner, 'Outreach Networks Co');
  // A playbook with a niche: one of the things a person needs before their day starts (decision 63).
  await runAs(owner, ws, 'outreach.playbook.save', {
    name: 'CRM demos',
    template: 'crm_demos',
    details: PLAYBOOK_TEMPLATES.crm_demos.details,
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
      settings: { ...AUTOMATION_DEFAULTS, sending: 'everything' },
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
    expect(team.people.find((p: { userId: string }) => p.userId === dana.id)).toMatchObject({
      warned: false,
      day: { state: 'none' },
    });
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
    // Facebook does nothing on its own; LinkedIn does its own steps, without liking a post first.
    expect((await runAs(dana, ws, 'outreach.today', {})).auto).toEqual([]);
    expect((await runAs(dana, ws, 'outreach.today', { platform: 'linkedin' })).auto).toEqual([
      'confirm',
      'friend_request',
      'comment',
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
    // The business stops allowing LinkedIn: theirs reads as off, and its day won't start.
    await setRules({ networksAllowed: ['facebook'] });
    expect((await runAs(dana, ws, 'outreach.automation', {})).settings.networks.linkedin.on).toBe(
      false,
    );
    expect(await refused(runAs(dana, ws, 'outreach.day.start', { platform: 'linkedin' }))).toBe(
      'outreach_network_off',
    );
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
