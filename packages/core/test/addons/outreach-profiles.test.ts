/**
 * Every network's profile, kept (decision 84): a new check keeps what the person said they want, Show me more's rounds
 * are the worker's alone, what the person's computer found of usernames is the person's own, and the profiles query
 * brings every network's check with the booking links. Against the local database.
 */
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROFILE_ITEMS_ON } from '../../src/addons/outreach/profile-check';
import { outreachBusiness, refused, runAs, runAsSystem } from './outreach-fixture';

let owner: TestUser;
let other: TestUser;
let ws: string;

const check = (more: Record<string, unknown> = {}) => ({
  items: Object.fromEntries(
    PROFILE_ITEMS_ON.instagram.map((i) => [i, { ok: false, why: 'Not yet.', fix: 'Change it.' }]),
  ),
  bios: ['I help Columbus roofers book inspections.'],
  nameDraft: 'Casey | Booked jobs for roofers',
  names: ['Casey | Booked jobs for roofers'],
  usernames: [{ value: 'casey.roofs', free: null }],
  coverLine: null,
  feature: [],
  look: {
    reads: 'personal',
    ok: false,
    title: 'This looks like a personal account.',
    clashes: [],
    unlike: ['name'],
  },
  seen: {
    url: 'https://www.instagram.com/caseyskates22/',
    name: 'Case',
    username: 'caseyskates22',
    line: 'Skating and tacos',
    links: [],
  },
  at: new Date().toISOString(),
  version: null,
  ...more,
});

const saved = (userId: string, more: Record<string, unknown> = {}) =>
  runAsSystem(ws, 'outreach.profile.check_save', {
    userId,
    platform: 'instagram',
    check: check(more),
  });

beforeAll(async () => {
  [owner, other] = await Promise.all([
    createTestUser('profiles-owner', { fullName: 'Casey Owner' }),
    createTestUser('profiles-other', { fullName: 'Jordan Other' }),
  ]);
  ws = await outreachBusiness(owner, 'Profiles Roofing Co');
  await testDbs()
    .admin.db.insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: other.id, role: 'member' });
}, 60_000);

afterAll(closeTestDbs);

describe('every network’s profile, kept', () => {
  it('keeps a round of more, the worker’s alone, newest first with the note', async () => {
    await saved(owner.id);
    const more = await runAsSystem(ws, 'outreach.profile.more_save', {
      userId: owner.id,
      platform: 'instagram',
      part: 'username',
      options: ['caseyl', 'casey_lee'],
      note: 'Shorter.',
    });
    expect(more.usernames.map((u: { value: string }) => u.value)).toEqual([
      'caseyl',
      'casey_lee',
      'casey.roofs',
    ]);
    expect(more.notes).toEqual({ username: ['Shorter.'] });
    expect(
      await refused(
        runAs(owner, ws, 'outreach.profile.more_save', {
          userId: owner.id,
          part: 'bio',
          options: [],
          note: null,
        }),
      ),
    ).toBe('forbidden');
  });

  it('keeps what the person’s computer found of usernames, on their own check only', async () => {
    const found = await runAs(owner, ws, 'outreach.profile.usernames_save', {
      platform: 'instagram',
      found: [
        { value: 'caseyl', free: true },
        { value: 'casey.roofs', free: false },
      ],
    });
    expect(found.usernames.slice(0, 3)).toEqual([
      { value: 'caseyl', free: true },
      { value: 'casey_lee', free: null },
      { value: 'casey.roofs', free: false },
    ]);
    // Someone with no check there has nothing to keep it on.
    expect(
      await refused(
        runAs(other, ws, 'outreach.profile.usernames_save', {
          platform: 'instagram',
          found: [{ value: 'caseyl', free: true }],
        }),
      ),
    ).toBe('outreach_profile_not_read');
  });

  it('keeps the person’s notes, and what their computer found, when the profile’s read again', async () => {
    const again = await saved(owner.id, { usernames: [{ value: 'casey.roofs', free: null }] });
    expect(again.profileCheck.notes).toEqual({ username: ['Shorter.'] });
    expect(again.profileCheck.usernames).toEqual([{ value: 'casey.roofs', free: false }]);
  });

  it('brings every network’s check, the booking links and the website, each person their own', async () => {
    const mine = await runAs(owner, ws, 'outreach.profiles', {});
    expect(mine.checks.instagram.seen.username).toBe('caseyskates22');
    expect(mine.checks.linkedin).toBeNull();
    expect(Object.keys(mine.booking)).toEqual(['facebook', 'linkedin', 'instagram', 'alignable']);
    const theirs = await runAs(other, ws, 'outreach.profiles', {});
    expect(theirs.checks.instagram).toBeNull();
  });
});
