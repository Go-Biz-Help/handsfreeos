/**
 * Social Outreach: how someone the business reached came along (docs/outreach.md, decision 103). A customer's Social
 * panel has where they stand, the groups they were found in, the chat's summary and every step either way, the
 * person's own; an owner sees a teammate's too, named. Each group has a page of who was found there and how each
 * turned out, the furthest first.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  journeyStepWords,
  type Journey,
  type JourneyStep,
} from '../../src/addons/outreach/journey';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { outreachBusiness, refused, runAs } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const HOUR = 3_600_000;
const hoursAgo = (n: number) => new Date(Date.now() - n * HOUR).toISOString();

describe('what a step says', () => {
  const step = (more: Partial<JourneyStep>): JourneyStep => ({
    kind: 'like',
    step: null,
    at: hoursAgo(1),
    auto: false,
    by: null,
    group: null,
    postUrl: null,
    ...more,
  });

  it('puts it in the network’s words, and says whose or that it was on its own', () => {
    expect(journeyStepWords(step({ kind: 'friend_request' }), 'facebook')).toBe(
      'Sent a friend request',
    );
    expect(journeyStepWords(step({ kind: 'friend_request' }), 'instagram')).toBe('Followed them');
    expect(journeyStepWords(step({ kind: 'friend_request' }), 'linkedin')).toBe(
      'Sent an invitation to connect',
    );
    expect(
      journeyStepWords(step({ kind: 'message', step: 'follow_up', auto: true }), 'facebook'),
    ).toBe('Followed up (on its own)');
    expect(journeyStepWords(step({ kind: 'comment', by: 'Riley Member' }), 'facebook')).toBe(
      'Commented on a post of theirs (Riley Member)',
    );
    expect(journeyStepWords(step({ kind: 'reply', by: 'Riley Member' }), 'facebook')).toBe(
      'They wrote back',
    );
  });
});

describe('a customer’s way so far, and a group’s page', () => {
  let owner: TestUser;
  let riley: TestUser;
  let ws: string;
  let groupId: string;
  let danaPerson: string;
  const group = {
    id: '223344556',
    slug: null,
    url: 'https://www.facebook.com/groups/223344556/',
    name: 'Round Rock Contractors',
  };
  const person = (username: string, name: string) => ({
    profile: { id: null, username, url: `https://www.facebook.com/${username}` },
    name,
  });
  const dana = person('dana.reyes.12', 'Dana Reyes');
  const lee = person('lee.park.3', 'Lee Park');
  const sam = person('sam.ortiz.7', 'Sam Ortiz');
  const kai = person('kai.brooks.9', 'Kai Brooks');
  const idOf = async (username: string) =>
    (
      await rows<{ id: string }>(
        admin(),
        sql`select id from addon_outreach.profiles where workspace_id = ${ws} and username = ${username}`,
      )
    )[0]!.id;
  const journeyAs = async (u: TestUser): Promise<Journey> =>
    (
      (await runAs(u, ws, 'outreach.person', { personId: danaPerson })) as {
        profiles: { journey: Journey }[];
      }
    ).profiles[0]!.journey;
  type Page = {
    group: { name: string; members: number | null };
    counts: Record<string, number>;
    people: {
      name: string;
      runsGroup: boolean;
      stage: string | null;
      why: string[];
      personId: string | null;
    }[];
    page: number;
    pages: number;
    total: number;
  };
  const groupPage = (u: TestUser, more: Record<string, unknown> = {}) =>
    runAs(u, ws, 'outreach.group.people', { groupId, ...more }) as Promise<Page>;

  beforeAll(async () => {
    owner = await createTestUser('outj-owner', { fullName: 'Pat Owner' });
    riley = await createTestUser('outj-riley', { fullName: 'Riley Member' });
    ws = await outreachBusiness(owner, 'Outreach Journey Co');
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: riley.id, role: 'member' });
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: 'CRM demos',
      template: 'crm_demos',
      details: { ...PLAYBOOK_TEMPLATES.crm_demos.details, link: 'https://example.com/book' },
    });
    // Dana, Lee (an admin there) and Sam were found in the group; Kai was found somewhere else.
    await runAs(owner, ws, 'outreach.groups.save', {
      groups: [{ group, members: 4_210, privacy: 'public', joined: true }],
    });
    await runAs(owner, ws, 'outreach.group.save', {
      group,
      people: [
        { ...dana, lines: [], part: 'Members near you' },
        { ...lee, lines: [], part: 'Admins and moderators', runsGroup: true },
        { ...sam, lines: [], part: 'Members near you' },
      ],
    });
    groupId = (
      await rows<{ id: string }>(
        admin(),
        sql`select id from addon_outreach.groups where workspace_id = ${ws} and url = ${group.url}`,
      )
    )[0]!.id;
    // The owner's steps with Dana: a friend request on its own from the group, then a like; Riley wrote to her.
    await runAs(
      owner,
      ws,
      'outreach.touch.save',
      { kind: 'friend_request', ...dana, group, auto: true },
      new Date(hoursAgo(5)),
    );
    await runAs(
      owner,
      ws,
      'outreach.touch.save',
      { kind: 'like', ...dana, postUrl: 'https://www.facebook.com/dana.reyes.12/posts/1' },
      new Date(hoursAgo(4)),
    );
    await runAs(
      riley,
      ws,
      'outreach.touch.save',
      { kind: 'message', ...dana, threadKey: '5566778899' },
      new Date(hoursAgo(3)),
    );
    await runAs(owner, ws, 'outreach.touch.save', { kind: 'like', ...kai, postUrl: null });
    // Dana wrote back to the owner, and their chat was read.
    await runAs(owner, ws, 'outreach.chats.collect', {
      chats: [
        {
          name: dana.name,
          thread: { id: '6677889900', encrypted: false },
          profile: dana.profile,
          messages: [{ fromMe: false, text: 'What does it cost?', at: hoursAgo(2) }],
        },
      ],
    });
    const danaId = await idOf(dana.profile.username);
    await rows(
      admin(),
      sql`update addon_outreach.file_chats set summary = 'Asked what it costs.', next_step = 'Send the price list'
          where workspace_id = ${ws} and name = ${dana.name}`,
    );
    await rows(
      admin(),
      sql`insert into addon_outreach.replies (workspace_id, user_id, profile_id, after_at, seen_at, pushed)
          values (${ws}, ${owner.id}, ${danaId}, ${hoursAgo(4)}, ${hoursAgo(2)}, true)`,
    );
    danaPerson = (await runAs(owner, ws, 'outreach.profile.contact', { profileId: danaId }))
      .personId;
  }, 60_000);
  afterAll(closeTestDbs);

  it('has where they stand, the group, the chat and every step on their panel', async () => {
    const got = await journeyAs(owner);
    expect(got.stage).toBe('talking');
    expect(got.why.length).toBeGreaterThan(0);
    expect(got.groups).toEqual([{ groupId, name: 'Round Rock Contractors', url: group.url }]);
    expect(got.chat).toMatchObject({
      summary: 'Asked what it costs.',
      nextStep: 'Send the price list',
      lastFromMe: false,
    });
    // The latest first: her reply, Riley's message (named for the owner), the like, the request from the group.
    expect(got.steps.map((s) => [s.kind, s.by, s.auto])).toEqual([
      ['reply', null, false],
      ['message', 'Riley Member', false],
      ['like', null, false],
      ['friend_request', null, true],
    ]);
    expect(got.steps[3]!.group).toEqual({ name: 'Round Rock Contractors', url: group.url });
    expect(got.steps[2]!.postUrl).toBe('https://www.facebook.com/dana.reyes.12/posts/1');
    expect(got.moreSteps).toBe(0);
    expect(got.steps.map((s) => journeyStepWords(s, 'facebook'))).toEqual([
      'They wrote back',
      'Started a chat (Riley Member)',
      'Liked a post of theirs',
      'Sent a friend request (on its own)',
    ]);
  });

  it('shows a teammate only their own steps, and none of the owner’s chat', async () => {
    const got = await journeyAs(riley);
    expect(got.steps.map((s) => [s.kind, s.by])).toEqual([['message', null]]);
    expect(got.chat).toBeNull();
    expect(got.groups).toHaveLength(1);
  });

  it('lists who was found in a group and how each turned out, the furthest first', async () => {
    const got = await groupPage(owner);
    expect(got.group).toMatchObject({ name: 'Round Rock Contractors', members: 4_210 });
    expect(got.counts).toMatchObject({ all: 3, not_reached: 2, talking: 1, client: 0 });
    // Dana's talking; of those not reached, Lee runs the group so comes first.
    expect(got.people.map((p) => [p.name, p.stage, p.runsGroup])).toEqual([
      ['Dana Reyes', 'talking', false],
      ['Lee Park', null, true],
      ['Sam Ortiz', null, false],
    ]);
    expect(got.people[0]!.personId).toBe(danaPerson);
    expect(got.people[1]!.why).toEqual(['Runs the group', 'Not reached yet']);
    expect(got.people[2]!.why).toEqual(['Not reached yet']);
    expect(got).toMatchObject({ page: 1, pages: 1, total: 3 });
  });

  it('shows one outcome at a time, and pages past the last', async () => {
    const left = await groupPage(owner, { view: 'not_reached' });
    expect(left.people.map((p) => p.name)).toEqual(['Lee Park', 'Sam Ortiz']);
    expect(left.total).toBe(2);
    expect((await groupPage(owner, { view: 'talking', page: 9 })).page).toBe(1);
    expect((await groupPage(owner, { view: 'client' })).people).toEqual([]);
  });

  it('works out each outcome for the person asking', async () => {
    // Riley wrote to Dana but she never answered Riley: not talking for Riley yet.
    const got = await groupPage(riley);
    expect(got.counts.all).toBe(3);
    expect(got.people[0]!.name).toBe('Dana Reyes');
    expect(got.people[0]!.stage).not.toBeNull();
    expect(got.counts.not_reached).toBe(2);
  });

  it('says so when the group isn’t kept any more', async () => {
    expect(await refused(groupPage(owner, { groupId: randomUUID() }))).toBe('not_found');
  });
});
