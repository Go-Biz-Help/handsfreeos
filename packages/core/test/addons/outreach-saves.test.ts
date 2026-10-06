/**
 * Social Outreach, Phase 1: what the browser extension saves (docs/outreach.md).
 * - Saving a profile finds the customer it's saved to, or the one picked, or adds one (source Facebook, texting
 *   consent unknown), with one line on their timeline; saving it again only brings it up to date.
 * - Saving a chat finds or adds the customer from the profile it links to (or the one it was saved with before) and
 *   adds only the messages it hadn't saved; each teammate's chat with the same person is their own.
 * - The look-up says which profiles and chats on a page are saved, and who else in Contacts has a name.
 * - Playbooks: everyone using the add-on reads them, owners and admins write them, and two in use never share a name.
 * - None of it runs while the add-on is off.
 */
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { outreachBusiness, refused, runAs, setOutreach } from './outreach-fixture';

const admin = () => testDbs().admin.db;

let owner: TestUser;
let member: TestUser;
let ws: string;

const dana = {
  profile: {
    id: null,
    username: 'dana.reyes.12',
    url: 'https://www.facebook.com/dana.reyes.12',
  },
  name: 'Dana Reyes',
};

/** The add-on's lines on a customer's timeline, oldest first; lines written by one save in the order of their words. */
async function timeline(personId: string) {
  return rows<{ words: string; body: string | null }>(
    admin(),
    sql`select meta->>'words' as words, body from app.activities
        where person_id = ${personId} and subtype = 'addon_line' order by created_at, meta->>'words'`,
  );
}

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('out-owner', { fullName: 'Chris Owner' }),
    createTestUser('out-member', { fullName: 'Sam Member' }),
  ]);
  ws = await outreachBusiness(owner, 'Outreach Test Co');
  await testDbs()
    .admin.db.insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: member.id, role: 'member' });
}, 60_000);

afterAll(closeTestDbs);

describe('saving a profile', () => {
  it('adds them to Contacts from Facebook the first time, and only brings them up to date after', async () => {
    const first = await runAs(owner, ws, 'outreach.profile.save', {
      ...dana,
      intro: ['Owner at Reyes Plumbing', 'Lives in Austin, Texas'],
      friendship: 'not_friends',
      mutualFriends: 4,
    });
    expect(first).toMatchObject({ personName: 'Dana Reyes', addedPerson: true });
    const [person] = await rows<{ source: string; sms_consent: string; first_name: string }>(
      admin(),
      sql`select source, sms_consent::text, first_name from app.people where id = ${first.personId}`,
    );
    expect(person).toEqual({ source: 'Facebook', sms_consent: 'unknown', first_name: 'Dana' });
    expect(await timeline(first.personId)).toEqual([
      { words: 'added them from Facebook', body: dana.profile.url },
    ]);

    const again = await runAs(member, ws, 'outreach.profile.save', {
      ...dana,
      profile: { ...dana.profile, username: 'Dana.Reyes.12' },
      intro: ['Owner at Reyes Plumbing'],
      friendship: 'request_sent',
    });
    expect(again).toMatchObject({
      personId: first.personId,
      profileId: first.profileId,
      addedPerson: false,
    });
    const [profile] = await rows<{ intro: string[]; friendship: string; last_seen_by: string }>(
      admin(),
      sql`select intro, friendship, last_seen_by from addon_outreach.profiles where id = ${first.profileId}`,
    );
    expect(profile).toEqual({
      intro: ['Owner at Reyes Plumbing'],
      friendship: 'request_sent',
      last_seen_by: member.id,
    });
    expect(await timeline(first.personId)).toHaveLength(1);
  });

  it('links a profile to a customer already in Contacts when the person picks them', async () => {
    const [existing] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.people (workspace_id, first_name, last_name, email)
          values (${ws}, 'Lee', 'Park', 'lee@example.com') returning id`,
    );
    const saved = await runAs(owner, ws, 'outreach.profile.save', {
      profile: {
        id: '100000000000123',
        username: null,
        url: 'https://www.facebook.com/profile.php?id=100000000000123',
      },
      name: 'Lee Park',
      personId: existing!.id,
    });
    expect(saved).toMatchObject({ personId: existing!.id, addedPerson: false });
    expect(await timeline(existing!.id)).toEqual([
      {
        words: 'linked their Facebook profile',
        body: 'https://www.facebook.com/profile.php?id=100000000000123',
      },
    ]);
  });
});

describe('saving a chat', () => {
  const thread = {
    id: '100000000000777',
    encrypted: false,
    url: 'https://www.facebook.com/messages/t/100000000000777/',
  };
  const morgan = {
    thread,
    name: 'Morgan Lane',
    profile: { id: null, username: 'morgan.lane', url: 'https://www.facebook.com/morgan.lane' },
  };

  it('adds the customer from the profile it links to, and then only the messages it hadn’t saved', async () => {
    const first = await runAs(owner, ws, 'outreach.chat.save', {
      ...morgan,
      messages: [
        { from: 'me', text: 'Hi Morgan, saw your post about missed calls.' },
        { from: 'them', sender: 'Morgan', text: 'Yes! It’s been a mess.' },
      ],
    });
    expect(first).toMatchObject({
      personName: 'Morgan Lane',
      addedPerson: true,
      added: 2,
      kept: 2,
    });
    expect(await timeline(first.personId)).toEqual([
      { words: 'added them from Facebook', body: morgan.profile.url },
      { words: 'saved 2 Facebook messages', body: 'Morgan: Yes! It’s been a mess.' },
    ]);

    const again = await runAs(owner, ws, 'outreach.chat.save', {
      ...morgan,
      messages: [
        { from: 'them', sender: 'Morgan', text: 'Yes! It’s been a mess.' },
        { from: 'me', text: 'Do you use a CRM?' },
      ],
    });
    expect(again).toMatchObject({
      personId: first.personId,
      threadId: first.threadId,
      addedPerson: false,
      added: 1,
      kept: 3,
    });
    const lines = await timeline(first.personId);
    expect(lines.at(-1)).toEqual({
      words: 'saved 1 Facebook message',
      body: 'Chris Owner: Do you use a CRM?',
    });

    const same = await runAs(owner, ws, 'outreach.chat.save', {
      ...morgan,
      messages: [{ from: 'me', text: 'Do you use a CRM?' }],
    });
    expect(same).toMatchObject({ added: 0, kept: 3 });
    expect(await timeline(first.personId)).toHaveLength(lines.length);
    const [row] = await rows<{ saved_messages: number }>(
      admin(),
      sql`select saved_messages from addon_outreach.threads where id = ${first.threadId}`,
    );
    expect(row!.saved_messages).toBe(3);
  });

  it('keeps a teammate’s chat with the same person apart from yours', async () => {
    const mine = await runAs(owner, ws, 'outreach.chat.save', {
      ...morgan,
      messages: [{ from: 'me', text: 'Do you use a CRM?' }],
    });
    const theirs = await runAs(member, ws, 'outreach.chat.save', {
      ...morgan,
      messages: [{ from: 'me', text: 'Hey Morgan, Sam here.' }],
    });
    expect(theirs.personId).toBe(mine.personId);
    expect(theirs.threadId).not.toBe(mine.threadId);
    expect(theirs).toMatchObject({ added: 1, kept: 1 });
  });

  it('saves a chat read again without its profile link to the customer it was saved with', async () => {
    const before = await runAs(owner, ws, 'outreach.chat.save', {
      ...morgan,
      messages: [{ from: 'me', text: 'Do you use a CRM?' }],
    });
    const again = await runAs(owner, ws, 'outreach.chat.save', {
      ...morgan,
      profile: null,
      messages: [{ from: 'me', text: 'Do you use a CRM?' }],
    });
    expect(again).toMatchObject({
      personId: before.personId,
      threadId: before.threadId,
      added: 0,
    });
  });

  it('refuses a chat that doesn’t say who it’s with', async () => {
    expect(
      await refused(
        runAs(owner, ws, 'outreach.chat.save', {
          thread: { ...thread, id: 'group123' },
          name: 'Austin owners chat',
          profile: null,
          messages: [{ from: 'them', text: 'Welcome all' }],
        }),
      ),
    ).toBe('outreach_chat_without_profile');
  });
});

describe('the look-up', () => {
  it('says which profiles and chats are saved, and who else has a name', async () => {
    const found = await runAs(owner, ws, 'outreach.lookup', {
      profiles: [
        { id: null, username: 'DANA.REYES.12' },
        { id: '100000000000123', username: null },
        { id: '999', username: null },
      ],
      threads: ['100000000000777', 'nothing'],
      names: ['dana  reyes', 'Nobody Here'],
    });
    expect(found.profiles.map((p: { name: string }) => p.name).sort()).toEqual([
      'Dana Reyes',
      'Lee Park',
    ]);
    expect(found.threads).toHaveLength(1);
    expect(found.threads[0]).toMatchObject({
      key: '100000000000777',
      name: 'Morgan Lane',
      kept: 3,
    });
    expect(found.sameName).toEqual([
      {
        name: 'dana reyes',
        people: [
          expect.objectContaining({ name: 'Dana Reyes', source: 'Facebook', hasProfile: true }),
        ],
      },
      { name: 'Nobody Here', people: [] },
    ]);
    // Someone else's chats aren't theirs to look up.
    const member_ = await runAs(member, ws, 'outreach.lookup', { threads: ['100000000000777'] });
    expect(member_.threads).toHaveLength(1);
    expect(member_.threads[0].kept).toBe(1);
  });

  it('shows a customer’s profiles and chats', async () => {
    const [morgan] = await rows<{ id: string }>(
      admin(),
      sql`select id from app.people where workspace_id = ${ws} and first_name = 'Morgan'`,
    );
    const social = await runAs(owner, ws, 'outreach.person', { personId: morgan!.id });
    expect(social.profiles).toEqual([
      expect.objectContaining({
        platform: 'facebook',
        url: 'https://www.facebook.com/morgan.lane',
      }),
    ]);
    expect(social.chats.map((c: { ownerName: string }) => c.ownerName).sort()).toEqual([
      'Chris Owner',
      'Sam Member',
    ]);
  });
});

describe('playbooks', () => {
  const crm = PLAYBOOK_TEMPLATES.crm_demos;

  it('are written by owners and admins, read by everyone using the add-on, and never share a name', async () => {
    const saved = await runAs(owner, ws, 'outreach.playbook.save', {
      name: crm.name,
      template: 'crm_demos',
      details: { ...crm.details, link: 'https://example.com/book' },
    });
    expect(saved).toMatchObject({ name: 'CRM demos', template: 'crm_demos', archivedAt: null });

    expect(
      await refused(
        runAs(member, ws, 'outreach.playbook.save', { name: 'Mine', details: crm.details }),
      ),
    ).toBe('forbidden');
    const listed = await runAs(member, ws, 'outreach.playbook.list', {});
    expect(listed.playbooks.map((p: { name: string }) => p.name)).toEqual(['CRM demos']);
    expect(listed.playbooks[0].details.link).toBe('https://example.com/book');

    expect(
      await refused(
        runAs(owner, ws, 'outreach.playbook.save', { name: ' crm DEMOS ', details: crm.details }),
      ),
    ).toBe('outreach_playbook_name_taken');

    await runAs(owner, ws, 'outreach.playbook.archive', { playbookId: saved.id, archived: true });
    const second = await runAs(owner, ws, 'outreach.playbook.save', {
      name: 'CRM demos',
      details: crm.details,
    });
    expect(
      await refused(
        runAs(owner, ws, 'outreach.playbook.archive', { playbookId: saved.id, archived: false }),
      ),
    ).toBe('outreach_playbook_name_taken');
    const after = await runAs(owner, ws, 'outreach.playbook.list', {});
    expect(
      after.playbooks.map((p: { id: string; archivedAt: string | null }) => [p.id, !!p.archivedAt]),
    ).toEqual([
      [second.id, false],
      [saved.id, true],
    ]);
  });

  it('read one saved before its questions had answers in today’s shape, and save questions as q1, q2…', async () => {
    const { questions, pace, ...rest } = crm.details;
    void pace;
    const [old] = await rows<{ id: string }>(
      admin(),
      sql`insert into addon_outreach.playbooks (workspace_id, name, details)
          values (${ws}, 'Before answers',
                  ${JSON.stringify({ ...rest, questions: questions.map((q) => q.text) })}::jsonb)
          returning id`,
    );
    const listed = await runAs(member, ws, 'outreach.playbook.list', {});
    const got = listed.playbooks.find((p: { id: string }) => p.id === old!.id);
    expect(got.details.questions.slice(0, 2)).toEqual([
      { id: 'q1', text: 'Do you use a CRM?', answers: [] },
      { id: 'q2', text: 'Which one?', answers: [] },
    ]);
    expect(got.details.pace).toEqual({ messageAfterDays: 1, followUpAfterDays: 3 });

    // Saved with the last question moved to the front: names follow the order, and "No" still leads to it.
    const moved = [questions[3]!, ...questions.slice(0, 3)];
    const saved = await runAs(owner, ws, 'outreach.playbook.save', {
      playbookId: old!.id,
      name: 'Before answers',
      details: {
        ...crm.details,
        questions: moved.map((q) =>
          q.id === 'q1' ? { ...q, answers: q.answers.filter((a) => a.next !== 'q4') } : q,
        ),
      },
    });
    expect(
      saved.details.questions.map((q: { id: string; text: string }) => [q.id, q.text]),
    ).toEqual([
      ['q1', 'How do you keep track of follow-ups now?'],
      ['q2', 'Do you use a CRM?'],
      ['q3', 'Which one?'],
      ['q4', 'Is it doing what you need?'],
    ]);
  });
});

describe('with the add-on off', () => {
  it('saves nothing and shows nothing', async () => {
    await setOutreach(ws, 'disabled');
    try {
      expect(await refused(runAs(owner, ws, 'outreach.profile.save', { ...dana, intro: [] }))).toBe(
        'addon_inactive',
      );
      expect(await refused(runAs(owner, ws, 'outreach.lookup', {}))).toBe('addon_inactive');
    } finally {
      await setOutreach(ws, 'enabled');
    }
  });
});
