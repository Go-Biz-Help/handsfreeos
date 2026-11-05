/**
 * Social Outreach never mentions a group the owner and the person are both in (docs/outreach.md, decision 157): the AI
 * isn't told which group they were found in, is told never to mention one, and a draft that does anyway is thrown
 * out. A partner's messages to someone who runs a group still speak of it (2a). Every message drafted before, still
 * waiting for an OK or OK'd and not yet sent, is written again (3a): nothing lists, OKs or sends it, and it goes as the
 * next draft is queued, so Today lists them again.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  groupNameParts,
  groupNamesIn,
  namesAGroup,
  NO_GROUPS,
  noGroupsAgain,
  withoutGroupLines,
} from '../../src/addons/outreach/no-groups';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { RULES_VERSION } from '../../src/addons/outreach/sends';
import {
  TODAY_DRAFT_ASK,
  TODAY_DRAFT_SYSTEM,
  todayDraftPrompt,
  todayDraftSystem,
} from '../../src/addons/outreach/today';
import { outreachBusiness, runAs } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const GROUP = 'Denver Trades Owners | Plumbers, HVAC & Electricians';
const NAMES = [GROUP, 'Real Estate', 'Roofing'];

describe('a draft that mentions a group', () => {
  it('is one that names one of their groups, or part of its name', () => {
    expect(groupNameParts(GROUP)).toEqual([
      'denver trades owners plumbers hvac & electricians',
      'denver trades owners',
      'plumbers hvac & electricians',
    ]);
    // A name as plain as a line of work is never matched on its own.
    expect(groupNameParts('Real Estate')).toEqual([]);
    expect(groupNameParts('Roofing')).toEqual([]);
    expect(groupNameParts('Austin Realtors')).toEqual(['austin realtors']);
    expect(namesAGroup('Hey Dana, fellow Denver Trades Owners member here!', NAMES)).toBe(true);
    expect(groupNamesIn('Good to meet someone from Denver Trades Owners.', NAMES)).toEqual([GROUP]);
    expect(namesAGroup('Hey Dana, how’s the real estate business going?', NAMES)).toBe(false);
  });

  it('is one that says they share a group, or that the owner found them in one', () => {
    for (const said of [
      'Hey Dana, saw you in the Denver trades group!',
      'Loved your post in the group yesterday.',
      'Noticed your comment on the Denver group, thought I’d reach out.',
      'Since we share a group, I figured I’d say hi.',
      'We’re both in the same Facebook group, so hello!',
      'Great to see another member of our group.',
      'Hey from a fellow member!',
      'Hi Dana, a group member here.',
      'That group we’re both in has been busy lately.',
      'Looks like we have a few groups in common.',
    ])
      expect([said, namesAGroup(said)]).toEqual([said, true]);
  });

  it('is never one that only says what someone does', () => {
    for (const said of [
      'Hey Dana, if I could get you more deals while also saving you time for your plumbing business using my easy to use CRM software, would you be interested?',
      'Do you run group fitness classes too?',
      'We offer a group rate for teams of five or more.',
      'Our group coaching program starts in March.',
      'Hope things are going well at Cole Plumbing.',
      'Hey Dana, it’s been a while! Hope the new shop is keeping you busy.',
    ])
      expect([said, namesAGroup(said, NAMES)]).toEqual([said, false]);
  });
});

describe('what the AI is told', () => {
  it('leaves out every line that names one of their groups or says they’re in one', () => {
    expect(
      withoutGroupLines(
        [
          'Found in the group Denver Trades Owners',
          'Owner at Cole Plumbing',
          'In Denver Trades Owners, one of the owner’s groups on Facebook, though they aren’t friends',
          'In one of the owner’s groups on Facebook, though they aren’t friends',
          'Runs group fitness classes',
          'Mention the trades group you share',
          'Active in the Denver Trades Owners group, asks about scheduling',
          'Plumbing and drain cleaning in Denver',
        ],
        NAMES,
      ),
    ).toEqual([
      'Owner at Cole Plumbing',
      'Runs group fitness classes',
      'Plumbing and drain cleaning in Denver',
    ]);
  });

  it('tells every customer draft never to mention a group, and a partner’s none of it (2a)', () => {
    expect(TODAY_DRAFT_SYSTEM.split('\n')).toContain(NO_GROUPS);
    for (const platform of ['facebook', 'instagram', 'linkedin', 'alignable'] as const) {
      expect(todayDraftSystem(platform).split('\n')).toContain(NO_GROUPS);
      expect(todayDraftSystem(platform, { partner: true })).not.toContain(NO_GROUPS);
    }
  });

  it('never says which group a post is in, only that it’s in one', () => {
    const prompt = todayDraftPrompt({
      kind: 'comment',
      business: 'Bright Books',
      name: 'Dana Cole',
      facts: [],
      recent: [],
      playbook: null,
      post: { text: 'Can anyone recommend a CRM for a plumber?', group: GROUP },
    });
    expect(prompt).not.toContain('Denver Trades Owners');
    expect(prompt).not.toContain('<group>');
    expect(prompt).toContain('They posted this in a Facebook group.');
  });

  it('asks again without the group’s name when every draft mentioned one', () => {
    const again = todayDraftPrompt({
      kind: 'opener',
      business: 'Bright Books',
      name: 'Dana Cole',
      facts: ['Owner at Cole Plumbing'],
      recent: [],
      playbook: null,
      again: [GROUP],
    });
    expect(again).toContain(noGroupsAgain([GROUP]));
    expect(noGroupsAgain([GROUP])).toMatch(/Your last drafts mentioned a group/);
    expect(noGroupsAgain([GROUP])).toContain(`Leave out “${GROUP}”.`);
    expect(again.endsWith(TODAY_DRAFT_ASK)).toBe(true);
    const first = todayDraftPrompt({
      kind: 'opener',
      business: 'Bright Books',
      name: 'Dana Cole',
      facts: ['Owner at Cole Plumbing'],
      recent: [],
      playbook: null,
    });
    expect(first).not.toMatch(/Your last drafts mentioned a group/);
  });
});

describe('messages drafted before (3a)', () => {
  let owner: TestUser;
  let member: TestUser;
  let ws: string;
  const fb = (username: string) => ({
    id: null,
    username,
    url: `https://www.facebook.com/${username}`,
  });
  const group = {
    id: '623456789',
    slug: null,
    url: 'https://www.facebook.com/groups/623456789/',
    name: 'Denver Trades Owners',
  };
  const profileOf = async (username: string) => {
    const [p] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_outreach.profiles where workspace_id = ${ws} and username = ${username}`,
    );
    return p!.id;
  };
  /** They accepted the person's friend request two days ago: a first message is on the list. */
  const accepted = async (u: TestUser, username: string, name: string) => {
    await runAs(u, ws, 'outreach.touch.save', {
      kind: 'friend_request',
      profile: fb(username),
      name,
      at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    });
    await rows(
      admin(),
      sql`insert into addon_outreach.friends (workspace_id, user_id, profile_id, state, since, seen_at)
          select ${ws}, ${u.id}, p.id, 'friends', now() - interval '2 days', now()
          from addon_outreach.profiles p where p.workspace_id = ${ws} and p.username = ${username}
          on conflict (workspace_id, user_id, profile_id) do update set state = 'friends', since = excluded.since`,
    );
    return profileOf(username);
  };
  const queue = (u: TestUser, profileId: string, text: string) =>
    runAs(u, ws, 'outreach.send.queue', { profileId, kind: 'opener', text }) as Promise<{
      sendId: string;
      state: string;
    }>;
  /** As if drafted before decision 157. */
  const olden = (sendId: string, state: 'waiting' | 'approved' = 'waiting') =>
    rows(
      admin(),
      sql`update addon_outreach.sends set rules_version = 0, state = ${state},
            approved_at = ${state === 'approved' ? sql`now()` : sql`null`}
          where id = ${sendId}`,
    );
  const sendsOf = (profileId: string) =>
    rows<{ text: string; state: string; rules_version: number }>(
      admin(),
      sql`select text, state, rules_version from addon_outreach.sends where profile_id = ${profileId}
          order by created_at`,
    );
  const openerOn = async (u: TestUser, name: string) =>
    (
      (await runAs(u, ws, 'outreach.today', {})).items as {
        kind: string;
        name: string;
        send: unknown;
      }[]
    ).find((i) => i.kind === 'opener' && i.name === name);

  beforeAll(async () => {
    [owner, member] = await Promise.all([
      createTestUser('outng-owner', { fullName: 'Morgan Owner' }),
      createTestUser('outng-member', { fullName: 'Riley Member' }),
    ]);
    ws = await outreachBusiness(owner, 'Outreach No Groups Co');
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role)
          values (${ws}, ${member.id}, 'member')`,
    );
    const crm = PLAYBOOK_TEMPLATES.crm_demos;
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: crm.name,
      template: 'crm_demos',
      details: crm.details,
    });
    await runAs(owner, ws, 'outreach.group.save', {
      group,
      members: 9_100,
      adminsPage: true,
      people: [
        ['dana.cole.14', 'Dana Cole', 'Owner at Cole Plumbing'],
        ['eli.brook.12', 'Eli Brook', 'Founder of Brook HVAC'],
        ['fern.ash.19', 'Fern Ash', 'Owner at Ash Roofing'],
        ['gray.lund.13', 'Gray Lund', 'Owner at Lund Electric'],
      ].map(([username, name, line]) => ({
        profile: fb(username!),
        name,
        lines: [line],
        part: 'Members near you',
        runsGroup: false,
      })),
    });
  }, 60_000);
  afterAll(closeTestDbs);

  it('are passed over, then written again as the next draft is queued', async () => {
    const dana = await accepted(owner, 'dana.cole.14', 'Dana Cole');
    const eli = await accepted(owner, 'eli.brook.12', 'Eli Brook');
    const fern = await accepted(owner, 'fern.ash.19', 'Fern Ash');
    const gray = await accepted(member, 'gray.lund.13', 'Gray Lund');

    // Drafted now: kept with the rules as they are.
    const waiting = await queue(owner, dana, 'Hey Dana, saw you in Denver Trades Owners!');
    expect(waiting.state).toBe('waiting');
    expect(await sendsOf(dana)).toEqual([
      {
        text: 'Hey Dana, saw you in Denver Trades Owners!',
        state: 'waiting',
        rules_version: RULES_VERSION,
      },
    ]);
    expect((await openerOn(owner, 'Dana Cole'))?.send).toMatchObject({ state: 'waiting' });

    // Drafted before: one waiting and one OK'd, and a teammate's.
    await olden(waiting.sendId);
    const okd = await queue(owner, eli, 'Hey Eli, fellow group member here!');
    await olden(okd.sendId, 'approved');
    const theirs = await queue(member, gray, 'Hey Gray, saw you in the group!');
    await olden(theirs.sendId);

    // Nothing lists them, OKs them or sends them: Today has them as not drafted, for the extension to write again.
    expect((await runAs(owner, ws, 'outreach.sends', {})).sends).toEqual([]);
    expect((await openerOn(owner, 'Dana Cole'))?.send).toBeNull();
    expect((await openerOn(owner, 'Eli Brook'))?.send).toBeNull();
    expect((await runAs(owner, ws, 'outreach.send.approve', {})).approved).toEqual([]);
    const waitingFor = await runAs(owner, ws, 'outreach.waiting', { items: true });
    expect((waitingFor.items as { kind: string }[]).filter((i) => i.kind === 'message')).toEqual(
      [],
    );

    // The next draft queued throws out the person's own; the teammate's waits for theirs.
    const fresh = await queue(owner, fern, 'Hey Fern, if I could get you more deals…');
    expect(fresh.state).toBe('waiting');
    expect(await sendsOf(dana)).toEqual([]);
    expect(await sendsOf(eli)).toEqual([]);
    expect(await sendsOf(gray)).toEqual([
      { text: 'Hey Gray, saw you in the group!', state: 'waiting', rules_version: 0 },
    ]);

    // Written again, it waits as any other.
    const again = await queue(owner, dana, 'Hey Dana, if I could get you more deals…');
    expect(again.sendId).not.toBe(waiting.sendId);
    expect(await sendsOf(dana)).toEqual([
      {
        text: 'Hey Dana, if I could get you more deals…',
        state: 'waiting',
        rules_version: RULES_VERSION,
      },
    ]);
    await queue(member, gray, 'Hey Gray, if I could get you more deals…');
    expect(await sendsOf(gray)).toEqual([
      {
        text: 'Hey Gray, if I could get you more deals…',
        state: 'waiting',
        rules_version: RULES_VERSION,
      },
    ]);
  });
});
