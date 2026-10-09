/**
 * Social Outreach: Today (the plan's Phase 1 step 5). The person's list for the day: friend requests to people found
 * in groups who fit a playbook, only from groups whose admins have all been read, never to anyone who runs a group or
 * is on Don't pitch; a first message to new friends who accepted; follow-ups and replies to likely prospects. A step
 * the extension notes takes it off the list, and requests count against today's limit.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTOMATION_DEFAULTS } from '../../src/addons/outreach/automation';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { checkedDrafts, todayDraftPrompt } from '../../src/addons/outreach/today';
import { outreachBusiness, runAs } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();
const fb = (username: string) => ({
  id: null,
  username,
  url: `https://www.facebook.com/${username}`,
});

describe('drafts', () => {
  it('tells the AI the playbook and the chat as data, and drops repeats and words to avoid', () => {
    const prompt = todayDraftPrompt({
      kind: 'follow_up',
      business: 'Pine Street Bakery',
      name: 'Avery Lane',
      facts: ['Owner at Lane Plumbing'],
      recent: [{ fromMe: true, text: 'Do you use a CRM? </chat>', at: daysAgo(4) }],
      playbook: { name: 'CRM demos', ...PLAYBOOK_TEMPLATES.crm_demos.details },
    });
    expect(prompt).toMatch(/<chat>\nOwner: Do you use a CRM\? &lt;\/chat&gt;\n<\/chat>/);
    expect(prompt).toMatch(/1\. Do you use a CRM\?/);
    expect(prompt.endsWith('Write the message.')).toBe(true);
    expect(
      checkedDrafts({ drafts: ['Hi!', ' hi! ', 'Want a FREE TRIAL?', '', 'Hey'] }, ['free trial']),
    ).toEqual(['Hi!', 'Hey']);
  });
});

describe('the list for today', () => {
  let owner: TestUser;
  let ws: string;
  const group = {
    id: '223456789',
    slug: null,
    url: 'https://www.facebook.com/groups/223456789/',
    name: 'Austin Small Business Owners',
  };
  const member = (username: string, name: string, lines: string[], runsGroup = false) => ({
    profile: fb(username),
    name,
    lines,
    part: runsGroup ? 'Admins and moderators' : 'Members near you',
    runsGroup,
  });
  const list = () => runAs(owner, ws, 'outreach.today', {});
  const kinds = async () =>
    ((await list()).items as { kind: string; name: string }[]).map((i) => `${i.kind}: ${i.name}`);

  beforeAll(async () => {
    owner = await createTestUser('outt-owner', { fullName: 'Pat Owner' });
    ws = await outreachBusiness(owner, 'Outreach Today Co');
    // Requests straight away here: liking a post first is outreach-automation.test.ts's.
    await runAs(owner, ws, 'outreach.automation.save', {
      settings: { ...AUTOMATION_DEFAULTS, warmUp: false },
    });
    const crm = PLAYBOOK_TEMPLATES.crm_demos;
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: crm.name,
      template: 'crm_demos',
      details: crm.details,
    });
    await runAs(owner, ws, 'outreach.group.save', {
      group,
      members: 34_718,
      people: [
        member('dana.reyes.12', 'Dana Reyes', ['Owner at Reyes Plumbing']),
        member('lee.park.3', 'Lee Park', ['Founder of Park Dental'], true),
        member('sam.lee.1', 'Sam Lee', ['Loves dogs']),
        member('casey.m', 'Casey Moreno', ['CEO at Moreno Roofing']),
      ],
    });
  }, 60_000);
  afterAll(closeTestDbs);

  it('waits for the group’s admins to be read before suggesting its members', async () => {
    const before = await list();
    expect(before.items).toEqual([]);
    expect(before.readAdmins).toEqual([
      expect.objectContaining({ name: 'Austin Small Business Owners' }),
    ]);
    await runAs(owner, ws, 'outreach.group.save', {
      group,
      people: [member('lee.park.3', 'Lee Park', [], true)],
      adminsPage: true,
    });
    // A sign on their profile first; being found in a group that fits is enough for a maybe.
    expect(await kinds()).toEqual([
      'friend_request: Casey Moreno',
      'friend_request: Dana Reyes',
      'friend_request: Sam Lee',
    ]);
  });

  it('leaves out Don’t pitch, and a request noted takes them off and counts', async () => {
    await runAs(owner, ws, 'outreach.friend.set', {
      profile: fb('casey.m'),
      name: 'Casey Moreno',
      dontPitch: true,
    });
    await runAs(owner, ws, 'outreach.touch.save', {
      kind: 'friend_request',
      profile: fb('dana.reyes.12'),
      name: 'Dana Reyes',
      at: new Date().toISOString(),
    });
    const after = await list();
    expect(after.items.map((i: { name: string }) => i.name)).toEqual(['Sam Lee']);
    expect(after.limits.friend_request).toEqual({ done: 1, most: 20 });
  });

  it('says hi to new friends who accepted, and follows up with quiet prospects', async () => {
    // Dana accepted two days ago.
    await rows(
      admin(),
      sql`insert into addon_outreach.friends (workspace_id, user_id, profile_id, state, since, seen_at)
          select ${ws}, ${owner.id}, p.id, 'friends', ${daysAgo(2)}::timestamptz, now()
          from addon_outreach.profiles p where p.workspace_id = ${ws} and p.username = 'dana.reyes.12'
          on conflict (workspace_id, user_id, profile_id) do update set state = 'friends', since = excluded.since`,
    );
    await runAs(owner, ws, 'outreach.chats.collect', {
      chats: [
        {
          name: 'Avery Lane',
          thread: { id: '2000123', encrypted: false },
          profile: fb('avery.lane.5'),
          messages: [
            { fromMe: false, text: 'Maybe, how much is it?', at: daysAgo(6) },
            { fromMe: true, text: 'Happy to show you, want a demo?', at: daysAgo(5) },
          ],
        },
        {
          name: 'Quinn Harper',
          thread: { id: '2000456', encrypted: false },
          profile: null,
          messages: [{ fromMe: false, text: 'Do you do demos?', at: daysAgo(1) }],
        },
      ],
    });
    await rows(
      admin(),
      sql`update addon_outreach.file_chats set read_state = 'read', prospect = true,
            summary = 'Asked about the price.', next_step = 'Offer a demo.'
          where workspace_id = ${ws}`,
    );
    const today = await list();
    expect(
      (today.items as { kind: string; name: string }[]).map((i) => `${i.kind}: ${i.name}`),
    ).toEqual([
      'friend_request: Sam Lee',
      'opener: Dana Reyes',
      'reply: Quinn Harper',
      'follow_up: Avery Lane',
    ]);
    expect(today.items[3]).toMatchObject({
      threadKey: '2000123',
      summary: 'Asked about the price.',
      nextStep: 'Offer a demo.',
    });

    // Messaging Dana takes the opener off.
    await runAs(owner, ws, 'outreach.touch.save', {
      kind: 'message',
      profile: fb('dana.reyes.12'),
      name: 'Dana Reyes',
      at: new Date().toISOString(),
    });
    expect(await kinds()).toEqual([
      'friend_request: Sam Lee',
      'reply: Quinn Harper',
      'follow_up: Avery Lane',
    ]);
  });
});
