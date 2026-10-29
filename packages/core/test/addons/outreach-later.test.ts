/**
 * Social Outreach: Later, from the person menu on anyone's name (docs/outreach.md decision 100, the owner's pick 30a).
 * - Later takes someone off the person's own Today for 2 weeks; then they're back. A teammate's Today is theirs.
 * - A reply they're owed, and their friend request to confirm, still show.
 * - The person's own messages to them waiting for an OK are skipped, never a reply, and never a teammate's.
 * - Take off Later puts them back now. `outreach.profile.marks` says until when.
 */
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTOMATION_DEFAULTS } from '../../src/addons/outreach/automation';
import { LATER_DAYS } from '../../src/addons/outreach/person-menu';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { outreachBusiness, runAs } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();
const fb = (username: string) => ({
  id: null,
  username,
  url: `https://www.facebook.com/${username}`,
});

let owner: TestUser;
let member: TestUser;

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('outl-owner', { fullName: 'Morgan Owner' }),
    createTestUser('outl-member', { fullName: 'Riley Member' }),
  ]);
}, 60_000);
afterAll(closeTestDbs);

describe('Later', () => {
  let ws: string;
  const group = {
    id: '623456789',
    slug: null,
    url: 'https://www.facebook.com/groups/623456789/',
    name: 'Austin Small Business Owners',
  };
  const inGroup = (username: string, name: string, lines: string[], runsGroup = false) => ({
    profile: fb(username),
    name,
    lines,
    part: runsGroup ? 'Admins and moderators' : 'Members near you',
    runsGroup,
  });
  const today = async () =>
    ((await runAs(owner, ws, 'outreach.today', {})).items as { kind: string; name: string }[]).map(
      (i) => `${i.kind}: ${i.name}`,
    );
  const profileOf = async (username: string) =>
    (
      await rows<{ id: string }>(
        admin(),
        sql`select id from addon_outreach.profiles where workspace_id = ${ws} and username = ${username}`,
      )
    )[0]!.id;
  const stateOf = async (sendId: string) =>
    (
      await rows<{ state: string }>(
        admin(),
        sql`select state from addon_outreach.sends where id = ${sendId}`,
      )
    )[0]?.state;
  const later = (u: TestUser, profileId: string, on: boolean) =>
    runAs(u, ws, 'outreach.later.set', { profileId, later: on });

  beforeAll(async () => {
    ws = await outreachBusiness(owner, 'Outreach Later Co');
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: member.id, role: 'member' });
    const crm = PLAYBOOK_TEMPLATES.crm_demos;
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: crm.name,
      template: 'crm_demos',
      details: crm.details,
    });
    await runAs(owner, ws, 'outreach.automation.save', {
      settings: { ...AUTOMATION_DEFAULTS, warmUp: false },
    });
    // Found in a group whose admins were read: Dana and Sam to send friend requests to.
    await runAs(owner, ws, 'outreach.group.save', {
      group,
      members: 34_718,
      people: [
        inGroup('dana.reyes.12', 'Dana Reyes', ['Owner at Reyes Plumbing']),
        inGroup('sam.lee.1', 'Sam Lee', ['Owner at Lee Bakery']),
        inGroup('lee.park.3', 'Lee Park', ['Founder of Park Dental'], true),
      ],
    });
    await runAs(owner, ws, 'outreach.group.save', {
      group,
      people: [inGroup('lee.park.3', 'Lee Park', [], true)],
      adminsPage: true,
    });
    // Quinn wrote yesterday, and is owed a reply.
    await runAs(owner, ws, 'outreach.chats.collect', {
      chats: [
        {
          name: 'Quinn Harper',
          thread: { id: '6000123', encrypted: false },
          profile: fb('quinn.harper.4'),
          messages: [{ fromMe: false, text: 'Do you do demos?', at: daysAgo(1) }],
        },
      ],
    });
    await rows(
      admin(),
      sql`update addon_outreach.file_chats set read_state = 'read', prospect = true
          where workspace_id = ${ws}`,
    );
    // Jo asked to be friends, and fits the playbook well: Today's to confirm.
    await runAs(owner, ws, 'outreach.friends.save', {
      list: 'requests',
      people: [{ profile: fb('jo.banks.2'), name: 'Jo Banks', mutualFriends: 6 }],
    });
    await rows(
      admin(),
      sql`update addon_outreach.profiles set intro = array['Owner at Banks Roofing']
          where workspace_id = ${ws} and username = 'jo.banks.2'`,
    );
  }, 60_000);

  it('takes someone off the person’s Today for 2 weeks, and skips only their own outreach waiting', async () => {
    expect(await today()).toEqual(
      expect.arrayContaining(['friend_request: Dana Reyes', 'friend_request: Sam Lee']),
    );
    const dana = await profileOf('dana.reyes.12');
    const mine = await runAs(owner, ws, 'outreach.send.queue', {
      profileId: dana,
      kind: 'opener',
      text: 'Hi Dana, an opener for you.',
    });
    const myReply = await runAs(owner, ws, 'outreach.send.queue', {
      profileId: dana,
      kind: 'reply',
      text: 'Thanks, Dana!',
    });
    const theirs = await runAs(member, ws, 'outreach.send.queue', {
      profileId: dana,
      kind: 'opener',
      text: 'Hi Dana, from Riley.',
    });
    const before = Date.now();
    const out = await later(owner, dana, true);
    expect(out).toEqual({ profileId: dana, until: expect.any(String), skipped: 1 });
    const back = new Date(out.until!).getTime();
    expect(back).toBeGreaterThanOrEqual(before + LATER_DAYS * DAY - 60_000);
    expect(back).toBeLessThanOrEqual(Date.now() + LATER_DAYS * DAY + 60_000);
    expect(await today()).not.toContain('friend_request: Dana Reyes');
    expect(await today()).toContain('friend_request: Sam Lee');
    expect(await stateOf(mine.sendId)).toBe('skipped');
    expect(await stateOf(myReply.sendId)).toBe('waiting');
    expect(await stateOf(theirs.sendId)).toBe('waiting');
    // Where they stand, as the menu opens: the person's own Later, not a teammate's.
    expect((await runAs(owner, ws, 'outreach.profile.marks', { profileId: dana })).laterUntil).toBe(
      out.until,
    );
    expect(
      (await runAs(member, ws, 'outreach.profile.marks', { profileId: dana })).laterUntil,
    ).toBeNull();
    const [said] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.events
          where workspace_id = ${ws} and event_type = 'outreach.later.marked'`,
    );
    expect(said!.n).toBe(1);
  });

  it('still shows a reply they’re owed, and their friend request to confirm', async () => {
    await later(owner, await profileOf('quinn.harper.4'), true);
    await later(owner, await profileOf('jo.banks.2'), true);
    expect(await today()).toEqual(
      expect.arrayContaining(['reply: Quinn Harper', 'confirm: Jo Banks']),
    );
  });

  it('puts them back after 2 weeks on its own, or now with Take off Later', async () => {
    const sam = await profileOf('sam.lee.1');
    await later(owner, sam, true);
    expect(await today()).not.toContain('friend_request: Sam Lee');
    await rows(
      admin(),
      sql`update addon_outreach.stages set later_until = now() - interval '1 minute'
          where workspace_id = ${ws} and user_id = ${owner.id} and profile_id = ${sam}`,
    );
    expect(await today()).toContain('friend_request: Sam Lee');
    expect(
      (await runAs(owner, ws, 'outreach.profile.marks', { profileId: sam })).laterUntil,
    ).toBeNull();

    const dana = await profileOf('dana.reyes.12');
    expect(await later(owner, dana, false)).toEqual({ profileId: dana, until: null, skipped: 0 });
    expect(await today()).toContain('friend_request: Dana Reyes');
    // Later's own column alone: no mark was made, so the stage stands as worked out.
    const [kept] = await rows<{ mark: string | null; later_until: string | null }>(
      admin(),
      sql`select mark, later_until from addon_outreach.stages
          where workspace_id = ${ws} and user_id = ${owner.id} and profile_id = ${dana}`,
    );
    expect(kept).toEqual({ mark: null, later_until: null });
  });
});
