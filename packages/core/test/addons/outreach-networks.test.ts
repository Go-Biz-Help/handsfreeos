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
import { AUTOMATION_DEFAULTS } from '../../src/addons/outreach/automation';
import { networkOfLink, NETWORKS, profileMisfit } from '../../src/addons/outreach/networks';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { outreachBusiness, refused, runAs } from './outreach-fixture';

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
    expect(linkedIn.limits.friend_request.most).toBe(10);
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
      settings: { ...AUTOMATION_DEFAULTS, sending: 'steps' },
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
    expect(linkedIn.limits.friend_request.most).toBe(20);
  });
});

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
      threadKey: '2-MDA0ZTQ1YjctYTNiMy00ZjQx==',
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
    expect(touch!.thread_key).toBe('2-MDA0ZTQ1YjctYTNiMy00ZjQx==');

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
