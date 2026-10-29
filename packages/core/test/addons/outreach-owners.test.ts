/**
 * Social Outreach on a team (docs/outreach.md decision 107, the owner's pick 4a): each group is the teammate's who
 * works it first, and each person whoever reached them first. Another teammate's Today leaves them out, and no
 * outreach goes to someone else's person, only replies; an owner or admin moves either, and a teammate who leaves
 * holds nothing.
 */
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTOMATION_DEFAULTS } from '../../src/addons/outreach/automation';
import { personMenuItems } from '../../src/addons/outreach/person-menu';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { outreachBusiness, refused, runAs } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const fb = (username: string) => ({
  id: null,
  username,
  url: `https://www.facebook.com/${username}`,
});
const group = {
  id: '723456789',
  slug: null,
  url: 'https://www.facebook.com/groups/723456789/',
  name: 'Round Rock Contractors',
};
const member = (username: string, name: string, lines: string[]) => ({
  profile: fb(username),
  name,
  lines,
  part: 'Members near you',
  runsGroup: false,
});

describe('a team working the same groups', () => {
  let owner: TestUser;
  let ana: TestUser;
  let ben: TestUser;
  let ws: string;
  let groupId: string;
  let dana: string;
  const requests = async (u: TestUser) =>
    ((await runAs(u, ws, 'outreach.today', {})).items as { kind: string; name: string }[])
      .filter((i) => i.kind === 'friend_request')
      .map((i) => i.name)
      .sort();
  const page = (u: TestUser) => runAs(u, ws, 'outreach.group.people', { groupId });

  beforeAll(async () => {
    [owner, ana, ben] = await Promise.all([
      createTestUser('outo-owner', { fullName: 'Pat Owner' }),
      createTestUser('outo-ana', { fullName: 'Ana Ortiz' }),
      createTestUser('outo-ben', { fullName: 'Ben Hale' }),
    ]);
    ws = await outreachBusiness(owner, 'Outreach Owners Co');
    await admin()
      .insert(workspaceMemberships)
      .values([
        { workspaceId: ws, userId: ana.id, role: 'member' },
        { workspaceId: ws, userId: ben.id, role: 'member' },
      ]);
    for (const u of [ana, ben])
      await runAs(u, ws, 'outreach.automation.save', {
        settings: { ...AUTOMATION_DEFAULTS, warmUp: false },
      });
    const crm = PLAYBOOK_TEMPLATES.crm_demos;
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: crm.name,
      template: 'crm_demos',
      details: crm.details,
    });
    await runAs(ana, ws, 'outreach.group.save', {
      group,
      members: 12_000,
      people: [
        member('dana.reyes.71', 'Dana Reyes', ['Owner at Reyes Plumbing']),
        member('casey.m.71', 'Casey Moreno', ['CEO at Moreno Roofing']),
      ],
    });
    await runAs(ana, ws, 'outreach.group.save', { group, people: [], adminsPage: true });
    const [g] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_outreach.groups where workspace_id = ${ws} and platform_id = ${group.id}`,
    );
    groupId = g!.id;
    const [d] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_outreach.profiles where workspace_id = ${ws} and username = 'dana.reyes.71'`,
    );
    dana = d!.id;
  }, 90_000);
  afterAll(closeTestDbs);

  it('offers a group nobody works yet to everyone', async () => {
    expect(await requests(ana)).toEqual(['Casey Moreno', 'Dana Reyes']);
    expect(await requests(ben)).toEqual(['Casey Moreno', 'Dana Reyes']);
    expect((await page(ben)).group.owner).toBeNull();
  });

  it('gives the group, and the person, to whoever works them first', async () => {
    await runAs(ana, ws, 'outreach.touch.save', {
      kind: 'friend_request',
      profile: fb('dana.reyes.71'),
      name: 'Dana Reyes',
      group,
    });
    expect(await requests(ana)).toEqual(['Casey Moreno']);
    // Ben gets nobody from Ana's group.
    expect(await requests(ben)).toEqual([]);
    expect((await page(ben)).group.owner).toMatchObject({ name: 'Ana Ortiz', you: false });
    expect((await page(ana)).group.owner).toMatchObject({ you: true });
    // Only an owner or admin may move it.
    expect((await page(ben)).moveTo).toEqual([]);
    expect(((await page(owner)).moveTo as { name: string }[]).map((t) => t.name)).toEqual([
      'Ana Ortiz',
      'Ben Hale',
      'Pat Owner',
    ]);
  });

  it('sends no outreach to someone else’s person, but a reply still goes', async () => {
    expect(
      await refused(
        runAs(ben, ws, 'outreach.send.queue', {
          profileId: dana,
          kind: 'opener',
          text: 'Hi Dana!',
        }),
      ),
    ).toBe('outreach_someone_elses');
    expect(
      await runAs(ben, ws, 'outreach.send.queue', {
        profileId: dana,
        kind: 'reply',
        text: 'Thanks, Dana!',
      }),
    ).toMatchObject({ kind: 'reply' });
    // Ben's menu on Dana says whose she is, with nothing to move; the owner's offers the others.
    const marks = await runAs(ben, ws, 'outreach.profile.marks', { profileId: dana });
    expect(marks.owner).toMatchObject({ name: 'Ana Ortiz', you: false });
    expect(marks.moveTo).toEqual([]);
    const theirs = await runAs(owner, ws, 'outreach.profile.marks', { profileId: dana });
    const items = personMenuItems({
      row: { url: null, platform: 'facebook' },
      marks: theirs,
      contactsWrite: true,
      online: true,
    });
    expect(items.filter((i) => i.key.startsWith('owner-')).map((i) => i.label)).toEqual([
      'Reached first by Ana Ortiz',
      'Give them to Ben Hale',
      'Make them yours',
    ]);
  });

  it('lets an owner move a group and a person, and the teammate before stops', async () => {
    const opener = await runAs(ana, ws, 'outreach.send.queue', {
      profileId: dana,
      kind: 'opener',
      text: 'Hi Dana!',
    });
    expect(opener).toMatchObject({ state: 'waiting' });
    expect(
      await refused(
        runAs(ana, ws, 'outreach.owner.move', { kind: 'group', id: groupId, userId: ben.id }),
      ),
    ).toBe('forbidden');

    await runAs(owner, ws, 'outreach.owner.move', { kind: 'group', id: groupId, userId: ben.id });
    expect(await requests(ben)).toEqual(['Casey Moreno']);
    expect(await requests(ana)).toEqual([]);

    const moved = await runAs(owner, ws, 'outreach.owner.move', {
      kind: 'person',
      id: dana,
      userId: ben.id,
    });
    expect(moved).toMatchObject({ owner: { name: 'Ben Hale' }, skipped: 1 });
    expect(
      await runAs(ben, ws, 'outreach.send.queue', { profileId: dana, kind: 'opener', text: 'Hi!' }),
    ).toMatchObject({ state: 'waiting' });
    expect(
      await refused(
        runAs(ana, ws, 'outreach.send.queue', { profileId: dana, kind: 'opener', text: 'Hi!' }),
      ),
    ).toBe('outreach_someone_elses');

    const stranger = await createTestUser('outo-stranger');
    expect(
      await refused(
        runAs(owner, ws, 'outreach.owner.move', {
          kind: 'group',
          id: groupId,
          userId: stranger.id,
        }),
      ),
    ).toBe('outreach_owner_not_on_team');
  });

  it('leaves nothing held by a teammate who left', async () => {
    await runAs(owner, ws, 'outreach.owner.move', { kind: 'group', id: groupId, userId: ana.id });
    expect(await requests(ben)).toEqual([]);
    await rows(
      admin(),
      sql`delete from app.workspace_memberships where workspace_id = ${ws} and user_id = ${ana.id}`,
    );
    expect((await page(ben)).group.owner).toBeNull();
    expect(await requests(ben)).toEqual(['Casey Moreno']);
    // The next to work it has it.
    await runAs(ben, ws, 'outreach.touch.save', {
      kind: 'friend_request',
      profile: fb('casey.m.71'),
      name: 'Casey Moreno',
      group,
    });
    expect((await page(ben)).group.owner).toMatchObject({ you: true });
  });
});
