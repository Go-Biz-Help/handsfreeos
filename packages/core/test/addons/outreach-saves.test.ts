/**
 * Social Outreach: Add to Contacts, Save to their card's look-up, and playbooks (docs/outreach.md).
 * - Adding someone kept as a profile to Contacts adds a customer (source Facebook, texting consent unknown) with one
 *   line on their timeline, or ties the profile to the customer picked; adding them again changes nothing.
 * - The look-up says which profiles and chats on a page are saved, and who else in Contacts has a name; a customer's
 *   Social card shows their profiles and everyone's chats saved to it.
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
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();
const them = (text: string, at: string) => ({ fromMe: false, text, at });
const me = (text: string, at: string) => ({ fromMe: true, text, at });

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
const lee = {
  profile: {
    id: '100000000000123',
    username: null,
    url: 'https://www.facebook.com/profile.php?id=100000000000123',
  },
  name: 'Lee Park',
};

/** The add-on's lines on a customer's timeline, oldest first; lines written by one save in the order of their words. */
async function timeline(personId: string) {
  return rows<{ words: string; body: string | null }>(
    admin(),
    sql`select meta->>'words' as words, body from app.activities
        where person_id = ${personId} and subtype = 'addon_line' order by created_at, meta->>'words'`,
  );
}

/** The profile kept for someone, by its username or its number. */
async function profileOf(key: { id: string | null; username: string | null }) {
  const [row] = await rows<{ id: string }>(
    admin(),
    sql`select id from addon_outreach.profiles
        where workspace_id = ${ws}
          and (platform_id = ${key.id}::text or lower(username) = lower(${key.username}::text))`,
  );
  return row!.id;
}

/** Kept as profiles with no customer, the way a friends list keeps everyone on it. */
const keep = (people: { profile: typeof lee.profile | typeof dana.profile; name: string }[]) =>
  runAs(owner, ws, 'outreach.friends.save', {
    list: 'friends',
    people: people.map((p) => ({ ...p, mutualFriends: null })),
  });

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('out-owner', { fullName: 'Chris Owner' }),
    createTestUser('out-member', { fullName: 'Sam Member' }),
  ]);
  ws = await outreachBusiness(owner, 'Outreach Test Co');
  await testDbs()
    .admin.db.insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: member.id, role: 'member' });
  await keep([dana, lee]);
}, 60_000);

afterAll(closeTestDbs);

describe('adding a kept profile to Contacts', () => {
  it('adds them from Facebook the first time, and changes nothing after', async () => {
    const profileId = await profileOf(dana.profile);
    const first = await runAs(owner, ws, 'outreach.profile.contact', { profileId });
    expect(first).toMatchObject({ personName: 'Dana Reyes', profileId, addedPerson: true });
    const [person] = await rows<{ source: string; sms_consent: string; first_name: string }>(
      admin(),
      sql`select source, sms_consent::text, first_name from app.people where id = ${first.personId}`,
    );
    expect(person).toEqual({ source: 'Facebook', sms_consent: 'unknown', first_name: 'Dana' });
    expect(await timeline(first.personId)).toEqual([
      { words: 'added them from Facebook', body: dana.profile.url },
    ]);

    const again = await runAs(member, ws, 'outreach.profile.contact', { profileId });
    expect(again).toMatchObject({ personId: first.personId, profileId, addedPerson: false });
    expect(await timeline(first.personId)).toHaveLength(1);
  });

  it('ties a profile to a customer already in Contacts when the person picks them', async () => {
    const [existing] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.people (workspace_id, first_name, last_name, email)
          values (${ws}, 'Lee', 'Park', 'lee@example.com') returning id`,
    );
    const saved = await runAs(owner, ws, 'outreach.profile.contact', {
      profileId: await profileOf(lee.profile),
      personId: existing!.id,
    });
    expect(saved).toMatchObject({ personId: existing!.id, addedPerson: false });
    expect(await timeline(existing!.id)).toEqual([
      { words: 'linked their Facebook profile', body: lee.profile.url },
    ]);
  });
});

describe('the look-up', () => {
  const morgan = {
    name: 'Morgan Lane',
    thread: { id: '100000000000777', encrypted: false },
    profile: { id: null, username: 'morgan.lane', url: 'https://www.facebook.com/morgan.lane' },
  };
  /** A chat read in Messenger, saved to Morgan's card by whoever read it. */
  const saveChat = async (who: TestUser, messages: ReturnType<typeof me>[], add: boolean) => {
    await runAs(who, ws, 'outreach.chats.collect', { chats: [{ ...morgan, messages }] });
    const [chat] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_outreach.file_chats
          where workspace_id = ${ws} and user_id = ${who.id} and name = ${morgan.name}`,
    );
    return runAs(who, ws, 'outreach.chat.keep', { chatId: chat!.id, add });
  };

  beforeAll(async () => {
    await saveChat(
      owner,
      [
        me('Hi Morgan, saw your post about missed calls.', daysAgo(3)),
        them('Yes! It’s been a mess.', daysAgo(2)),
        me('Do you use a CRM?', daysAgo(1)),
      ],
      true,
    );
    // The teammate's own chat with them goes on the same card.
    await saveChat(member, [me('Hey Morgan, Sam here.', daysAgo(1))], false);
  }, 60_000);

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
    const [person] = await rows<{ id: string }>(
      admin(),
      sql`select id from app.people where workspace_id = ${ws} and first_name = 'Morgan'`,
    );
    const social = await runAs(owner, ws, 'outreach.person', { personId: person!.id });
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
    expect(got.details.pace).toEqual({
      messageAfterDays: 1,
      followUps: 6,
      followUpGaps: [1, 1, 1, 2, 2, 2],
    });

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

describe('a playbook’s niche, problem, proof and something useful (data version 3)', () => {
  const crm = PLAYBOOK_TEMPLATES.crm_demos;

  it('keeps them when a save leaves them out, as a phone built before them does, and clears them when asked', async () => {
    const saved = await runAs(owner, ws, 'outreach.playbook.save', {
      name: 'Roofers',
      details: {
        ...crm.details,
        niche: 'Roofers with 2 to 3 crews',
        proof: ['A 3-crew roofer got 14 inspections in 30 days'],
        usefulWhat: 'A storm-season checklist',
        usefulLink: 'https://example.com/checklist',
      },
    });
    const { niche, problem, proof, usefulWhat, usefulLink, ...older } = crm.details;
    void [niche, problem, proof, usefulWhat, usefulLink];
    const again = await runAs(owner, ws, 'outreach.playbook.save', {
      playbookId: saved.id,
      name: 'Roofers',
      details: { ...older, offer: 'A 15-minute call' },
    });
    expect(again.details).toMatchObject({
      offer: 'A 15-minute call',
      niche: 'Roofers with 2 to 3 crews',
      problem: crm.details.problem,
      proof: ['A 3-crew roofer got 14 inspections in 30 days'],
      usefulLink: 'https://example.com/checklist',
    });

    const cleared = await runAs(owner, ws, 'outreach.playbook.save', {
      playbookId: saved.id,
      name: 'Roofers',
      details: { ...again.details, niche: null, proof: [] },
    });
    expect(cleared.details).toMatchObject({
      niche: null,
      proof: [],
      usefulWhat: 'A storm-season checklist',
    });

    // A new one saved without them starts with them empty.
    const fresh = await runAs(owner, ws, 'outreach.playbook.save', {
      name: 'Older phone',
      details: older,
    });
    expect(fresh.details).toMatchObject({ niche: null, problem: null, proof: [] });
  });
});

describe('each network’s own words on a playbook (data version 8, decision 92)', () => {
  const crm = PLAYBOOK_TEMPLATES.crm_demos;

  it('cleans hashtags as people tag them, and refuses one that makes none', async () => {
    const saved = await runAs(owner, ws, 'outreach.playbook.save', {
      name: 'Hail season',
      details: {
        ...crm.details,
        platforms: ['facebook', 'instagram'],
        hashtags: ['#Austin Roofing!', 'austinroofing', 'Hail Repair'],
      },
    });
    expect(saved.details.hashtags).toEqual(['austinroofing', 'hailrepair']);
    expect(
      await refused(
        runAs(owner, ws, 'outreach.playbook.save', {
          playbookId: saved.id,
          name: 'Hail season',
          details: { ...saved.details, hashtags: ['austinroofing', '#!?'] },
        }),
      ),
    ).toBe('outreach_playbook_hashtag');
  });

  it('keeps them when a save leaves them out, and never lets a save say what the AI wrote', async () => {
    const saved = await runAs(owner, ws, 'outreach.playbook.save', {
      name: 'Storm leads',
      details: {
        ...crm.details,
        platforms: ['linkedin', 'alignable'],
        postSearches: ['roof leak'],
        businessKinds: ['Property Management'],
        worksOnline: true,
        // Only the AI's words command says this.
        wordsWritten: ['linkedin'],
      },
    });
    expect(saved.details).toMatchObject({
      postSearches: ['roof leak'],
      businessKinds: ['Property Management'],
      worksOnline: true,
      wordsWritten: [],
    });
    // As if the AI had written LinkedIn's: a save from the builder, or a phone, keeps it.
    await rows(
      admin(),
      sql`update addon_outreach.playbooks
          set details = jsonb_set(details, '{wordsWritten}', '["linkedin"]')
          where id = ${saved.id}`,
    );
    const { hashtags, postSearches, businessKinds, worksOnline, wordsWritten, ...older } =
      saved.details;
    void [hashtags, postSearches, businessKinds, worksOnline, wordsWritten];
    const again = await runAs(owner, ws, 'outreach.playbook.save', {
      playbookId: saved.id,
      name: 'Storm leads',
      details: { ...older, offer: 'A free roof check', wordsWritten: [] },
    });
    expect(again.details).toMatchObject({
      offer: 'A free roof check',
      postSearches: ['roof leak'],
      businessKinds: ['Property Management'],
      worksOnline: true,
      wordsWritten: ['linkedin'],
    });
    // The person empties a list: it stays empty, and the AI's mark stays with it.
    const emptied = await runAs(owner, ws, 'outreach.playbook.save', {
      playbookId: saved.id,
      name: 'Storm leads',
      details: { ...again.details, postSearches: [] },
    });
    expect(emptied.details).toMatchObject({ postSearches: [], wordsWritten: ['linkedin'] });
  });
});

describe('with the add-on off', () => {
  it('saves nothing and shows nothing', async () => {
    await setOutreach(ws, 'disabled');
    try {
      expect(
        await refused(
          runAs(owner, ws, 'outreach.profile.contact', {
            profileId: await profileOf(dana.profile),
          }),
        ),
      ).toBe('addon_inactive');
      expect(await refused(runAs(owner, ws, 'outreach.lookup', {}))).toBe('addon_inactive');
    } finally {
      await setOutreach(ws, 'enabled');
    }
  });
});
