/**
 * People in the business's Facebook groups get the AI's check too (docs/outreach.md decision 116, the owner's pick
 * 34a): checked like friends, last of all and the best fit first, counted with the day's checks; Today's friend
 * requests from the groups leave off anyone the AI says doesn't fit and put a good fit ahead, with what it said. Never
 * on the Friends tab's fits nor Reconnect until they're friends.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTOMATION_DEFAULTS } from '../../src/addons/outreach/automation';
import { memberFact } from '../../src/addons/outreach/checks';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { checkedAs, outreachBusiness, runAs } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const crm = PLAYBOOK_TEMPLATES.crm_demos;

afterAll(closeTestDbs);

describe('Facebook group members get the AI’s check', () => {
  let owner: TestUser;
  let ws: string;
  let playbookId: string;
  const fb = (username: string) => ({
    id: null,
    username,
    url: `https://www.facebook.com/${username}`,
  });
  const group = {
    id: '323456789',
    slug: null,
    url: 'https://www.facebook.com/groups/323456789/',
    name: 'Austin Small Business Owners',
  };
  const member = (username: string, name: string, lines: string[], runsGroup = false) => ({
    profile: fb(username),
    name,
    lines,
    part: runsGroup ? 'Admins and moderators' : 'Members near you',
    runsGroup,
  });
  const idOf = async (username: string) =>
    (
      await rows<{ id: string }>(
        admin(),
        sql`select id from addon_outreach.profiles where workspace_id = ${ws} and username = ${username}`,
      )
    )[0]!.id;
  const checksNext = async () =>
    (
      (await runAs(owner, ws, 'outreach.checks.next', {})) as {
        people: { name: string; reason: string }[];
      }
    ).people.map((p) => [p.name, p.reason]);
  const requests = async () =>
    (
      (await runAs(owner, ws, 'outreach.today', {})).items as {
        kind: string;
        name: string;
        why: string[];
        playbookName: string | null;
      }[]
    ).filter((i) => i.kind === 'friend_request');

  beforeAll(async () => {
    owner = await createTestUser('outmem-owner', { fullName: 'Pat Owner' });
    ws = await outreachBusiness(owner, 'Members Co');
    await runAs(owner, ws, 'outreach.automation.save', {
      settings: { ...AUTOMATION_DEFAULTS, warmUp: false },
    });
    playbookId = (
      await runAs(owner, ws, 'outreach.playbook.save', {
        name: crm.name,
        template: 'crm_demos',
        details: crm.details,
      })
    ).id;
    await runAs(owner, ws, 'outreach.friends.save', {
      list: 'friends',
      people: [{ profile: fb('kate.nguyen.9'), name: 'Kate Nguyen', mutualFriends: null }],
    });
    await runAs(owner, ws, 'outreach.group.save', {
      group,
      members: 12_400,
      people: [
        member('ari.bell.4', 'Ari Bell', ['Owner at Bell Bakery']),
        member('dana.reyes.12', 'Dana Reyes', ['Owner at Reyes Plumbing']),
        member('casey.m', 'Casey Moreno', ['CEO at Moreno Roofing']),
        member('sam.lee.1', 'Sam Lee', ['Loves dogs']),
        member('lee.park.3', 'Lee Park', ['Founder of Park Dental'], true),
        member('kate.nguyen.9', 'Kate Nguyen', ['Owner at Nguyen Cafe']),
      ],
    });
  }, 60_000);

  it('waits for the group’s admins to be read, then checks its members after the friends, the best fit first', async () => {
    expect(await checksNext()).toEqual([['Kate Nguyen', 'group']]);
    await runAs(owner, ws, 'outreach.group.save', {
      group,
      people: [member('lee.park.3', 'Lee Park', [], true)],
      adminsPage: true,
    });
    // Never Lee, who runs the group; Kate once, as a friend from the group.
    expect(await checksNext()).toEqual([
      ['Kate Nguyen', 'group'],
      ['Ari Bell', 'member'],
      ['Casey Moreno', 'member'],
      ['Dana Reyes', 'member'],
      ['Sam Lee', 'member'],
    ]);
  });

  it('says a check is of a member, counts it with the day’s, and never lists them as someone known', async () => {
    const casey = await idOf('casey.m');
    const dana = await idOf('dana.reyes.12');
    await checkedAs(owner, ws, casey, { fit: 'not', why: ['Sells roofing software'], playbookId });
    await checkedAs(owner, ws, dana, {
      fit: 'good',
      why: ['Runs a plumbing crew of six'],
      playbookId,
    });
    const via = await rows<{ via: string }>(
      admin(),
      sql`select via from addon_outreach.checks where workspace_id = ${ws} and user_id = ${owner.id}
          order by via`,
    );
    expect(via.map((v) => v.via)).toEqual(['member', 'member']);
    const after = (await runAs(owner, ws, 'outreach.checks.next', {})) as {
      today: number;
      people: { name: string }[];
    };
    expect(after.today).toBe(2);
    // Checked lately: not again.
    expect(after.people.map((p) => p.name)).toEqual(['Kate Nguyen', 'Ari Bell', 'Sam Lee']);
    const fits = await runAs(owner, ws, 'outreach.friends', { view: 'fits' });
    expect((fits.people as { name: string }[]).map((p) => p.name)).not.toContain('Dana Reyes');
    expect(
      ((await runAs(owner, ws, 'outreach.today', {})).items as { kind: string; name: string }[])
        .filter((i) => i.kind === 'reconnect')
        .map((i) => i.name),
    ).toEqual([]);
  });

  it('leaves off a member the AI says doesn’t fit, and puts a good fit ahead with what it said', async () => {
    const list = await requests();
    expect(list.map((i) => i.name)).toEqual(['Dana Reyes', 'Ari Bell', 'Sam Lee']);
    expect(list[0]).toMatchObject({ playbookName: crm.name });
    expect(list[0]!.why[0]).toBe('Runs a plumbing crew of six');
  });

  it('tells the AI which group they’re in', () => {
    expect(memberFact('Austin Small Business Owners')).toBe(
      'In Austin Small Business Owners, one of the owner’s groups on Facebook, though they aren’t friends',
    );
    expect(memberFact(null)).toMatch(/^In one of the owner’s groups/);
  });
});
