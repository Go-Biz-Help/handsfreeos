/**
 * Social Outreach: groups (the plan's Phase 1 step 4). A group is scored against the playbooks in use as Work these,
 * Maybe or Skip with why, from what the page showed: its words, its area, its size and whether the person is in it.
 * The people on its People tab are saved with it, admins and moderators kept as such for good, and the full list of
 * them marks the group's admins as read. Nobody goes in Contacts.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bestGroupFit, groupFitFor, type GroupFitPlaybook } from '../../src/addons/outreach/groups';
import { outreachBusiness, runAs } from './outreach-fixture';

const admin = () => testDbs().admin.db;

const crm: GroupFitPlaybook = {
  id: 'p1',
  name: 'CRM demos',
  details: {
    signs: ['“Owner” in their intro'],
    skip: ['Competitors: “CRM consultants”'],
    area: 'Austin and Round Rock',
    groupWords: ['small business owners', 'contractors'],
  },
};
const facts = (name: string, more: Partial<Parameters<typeof groupFitFor>[1]> = {}) => ({
  name,
  detail: null,
  members: null,
  privacy: null,
  joined: null,
  ...more,
});

describe('how a group fits', () => {
  it('works the groups a playbook looks for, with why', () => {
    expect(
      groupFitFor(crm, facts('Austin Small Business Owners', { members: 34_718, joined: true })),
    ).toMatchObject({
      verdict: 'work',
      reasons: [
        '“small business owners” in its name',
        'In Austin',
        '34,718 members',
        'You’re in it',
      ],
    });
    expect(groupFitFor(crm, facts('Contractors Lounge', { members: 50 }))).toMatchObject({
      verdict: 'maybe',
      reasons: ['“contractors” in its name', 'Only 50 members'],
    });
    expect(groupFitFor(crm, facts('Dog Lovers', { members: 9_000 })).verdict).toBe('maybe');
    expect(groupFitFor(crm, facts('Knitting Circle')).verdict).toBe('skip');
    expect(groupFitFor(crm, facts('CRM Consultants of Texas')).reasons).toEqual([
      '“CRM consultants” in its name',
    ]);
    // With no playbook yet, size and being in it say maybe at most.
    expect(
      bestGroupFit([], facts('Austin Small Business Owners', { members: 5_000, joined: true })),
    ).toMatchObject({ verdict: 'maybe', playbookId: null });
  });
});

describe('saving groups and the people in them', () => {
  let owner: TestUser;
  let ws: string;
  const group = {
    id: '123456789',
    slug: null,
    url: 'https://www.facebook.com/groups/123456789/',
    name: 'Austin Small Business Owners',
  };
  const person = (username: string, name: string, more: Record<string, unknown> = {}) => ({
    profile: { id: null, username, url: `https://www.facebook.com/${username}` },
    name,
    lines: ['Owner at Pine Street Bakery'],
    part: 'Members near you',
    ...more,
  });

  beforeAll(async () => {
    owner = await createTestUser('outg-owner', { fullName: 'Pat Owner' });
    ws = await outreachBusiness(owner, 'Outreach Groups Co');
  }, 60_000);
  afterAll(closeTestDbs);

  it('keeps the groups on a page, and whether the person is in them', async () => {
    expect(
      await runAs(owner, ws, 'outreach.groups.save', {
        groups: [
          { group, members: 34_718, privacy: 'public', joined: true },
          {
            group: {
              id: null,
              slug: 'knitting.circle',
              url: 'https://www.facebook.com/groups/knitting.circle/',
              name: 'Knitting Circle',
            },
            detail: 'Private group · 40 members',
          },
        ],
      }),
    ).toEqual({ saved: 2 });
    const list = await runAs(owner, ws, 'outreach.groups', { view: 'all' });
    expect(list.counts.all).toBe(2);
    expect(list.groups[0]).toMatchObject({
      name: 'Austin Small Business Owners',
      members: 34_718,
      joined: true,
      adminsRead: false,
    });
  });

  it('saves its people, keeps who runs it, and knows when its admins are all read', async () => {
    expect(
      await runAs(owner, ws, 'outreach.group.save', {
        group,
        people: [
          person('dana.reyes.12', 'Dana Reyes'),
          person('lee.park.3', 'Lee Park', { part: 'Admins and moderators', runsGroup: true }),
        ],
      }),
    ).toMatchObject({ people: 2, runsGroup: 1 });
    // Seen again as a member, Lee still runs it.
    await runAs(owner, ws, 'outreach.group.save', {
      group,
      people: [person('lee.park.3', 'Lee Park')],
      adminsPage: true,
    });
    const kept = await rows<{ name: string; runs_group: boolean; group_id: string | null }>(
      admin(),
      sql`select p.name, gp.runs_group, p.group_id from addon_outreach.group_people gp
          join addon_outreach.profiles p on p.id = gp.profile_id
          where gp.workspace_id = ${ws} order by p.name`,
    );
    expect(kept.map((k) => [k.name, k.runs_group])).toEqual([
      ['Dana Reyes', false],
      ['Lee Park', true],
    ]);
    expect(kept.every((k) => k.group_id !== null)).toBe(true);
    const list = await runAs(owner, ws, 'outreach.groups', { view: 'all' });
    expect(
      list.groups.find((g: { name: string }) => g.name === 'Austin Small Business Owners'),
    ).toMatchObject({ people: 2, runsGroup: 1, adminsRead: true });
    const [people] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.people where workspace_id = ${ws}`,
    );
    expect(people!.n).toBe(0);
  });
});
