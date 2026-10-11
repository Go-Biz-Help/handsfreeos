/**
 * Social Outreach: friends (docs/outreach.md, decisions 10 to 13).
 * - Saving the friends list, the friend requests someone's got, or the ones they've sent, keeps each person's own
 *   state with them and adds nobody to Contacts; saving the same list again changes nothing.
 * - Confirm makes them friends and Delete turns the request down; a friend request sent says so; a profile saved
 *   says where things stand; an answer that waited to send never undoes a later look.
 * - Keep is the person's own; Don't pitch is the business's, and only whoever put someone on it, or an owner or
 *   admin, takes them off. Steps to someone on it, or to a customer tagged Friend or family, aren't counted.
 * - The Friends tab counts and lists each view, the friend requests best fit first, and the look-up marks the people
 *   on a page.
 */
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { outreachBusiness, refused, runAs, setOutreach } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const HOUR = 60 * 60 * 1000;

let owner: TestUser;
let member: TestUser;

/** A made-up person's profile, known by its username, or by its number. */
const byName = (username: string, name: string) => ({
  profile: { id: null, username, url: `https://www.facebook.com/${username}` },
  name,
});
const byNumber = (id: string, name: string) => ({
  profile: { id, username: null, url: `https://www.facebook.com/profile.php?id=${id}` },
  name,
});

async function business(name: string): Promise<string> {
  const ws = await outreachBusiness(owner, name);
  await admin()
    .insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: member.id, role: 'member' });
  return ws;
}

/** Where someone's Facebook stands with a profile, as kept: state, keep. */
async function stateOf(ws: string, u: TestUser, username: string) {
  const [row] = await rows<{ state: string; keep: boolean; since: Date }>(
    admin(),
    sql`select f.state, f.keep, f.since from addon_outreach.friends f
        join addon_outreach.profiles p on p.id = f.profile_id
        where p.workspace_id = ${ws} and f.user_id = ${u.id} and p.username = ${username}`,
  );
  return row ?? null;
}

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('outf-owner', { fullName: 'Jordan Owner' }),
    createTestUser('outf-member', { fullName: 'Taylor Member' }),
  ]);
}, 60_000);

afterAll(closeTestDbs);

describe('saving a list', () => {
  let ws: string;
  const save = (u: TestUser, input: Record<string, unknown>) =>
    runAs(u, ws, 'outreach.friends.save', input);

  beforeAll(async () => {
    ws = await business('Outreach Friends Co');
  }, 60_000);

  it('keeps each friend as the person’s own, and adds nobody to Contacts', async () => {
    const people = [
      { ...byName('avery.lane.4', 'Avery Lane'), mutualFriends: 12 },
      { ...byNumber('100004000000001', 'Quinn Harper'), mutualFriends: null },
      // The same person twice, as a long list loads, is one.
      { ...byName('avery.lane.4', 'Avery Lane'), mutualFriends: 12 },
    ];
    expect(await save(owner, { list: 'friends', people })).toEqual({
      saved: 2,
      added: 2,
      changed: 0,
    });
    expect(await stateOf(ws, owner, 'avery.lane.4')).toMatchObject({
      state: 'friends',
      keep: false,
    });
    const [kept] = await rows(
      admin(),
      sql`select person_id, friendship, mutual_friends from addon_outreach.profiles
          where workspace_id = ${ws} and username = 'avery.lane.4'`,
    );
    expect(kept).toEqual({ person_id: null, friendship: 'friends', mutual_friends: 12 });
    expect(await rows(admin(), sql`select id from app.people where workspace_id = ${ws}`)).toEqual(
      [],
    );
    // Again: nothing new. A teammate's list is their own.
    expect(await save(owner, { list: 'friends', people })).toEqual({
      saved: 2,
      added: 0,
      changed: 0,
    });
    expect(await stateOf(ws, member, 'avery.lane.4')).toBeNull();
  });

  it('keeps the friend requests someone’s got, and someone known already who asks', async () => {
    // Noted from a step before: known, with no state of the owner's yet.
    await runAs(member, ws, 'outreach.touch.save', {
      kind: 'like',
      ...byName('rowan.blake.9', 'Rowan Blake'),
    });
    const saved = await save(owner, {
      list: 'requests',
      people: [
        { ...byName('rowan.blake.9', 'Rowan Blake'), mutualFriends: 3 },
        { ...byName('sky.patel.21', 'Sky Patel'), mutualFriends: 0 },
      ],
    });
    expect(saved).toEqual({ saved: 2, added: 1, changed: 1 });
    expect((await stateOf(ws, owner, 'rowan.blake.9'))?.state).toBe('request_received');
  });

  it('keeps the friend requests someone’s sent', async () => {
    const saved = await save(owner, {
      list: 'sent',
      people: [
        { ...byName('morgan.ellis.7', 'Morgan Ellis'), mutualFriends: 4 },
        { ...byNumber('100004000000009', 'Casey Brooks'), mutualFriends: null },
      ],
    });
    expect(saved).toEqual({ saved: 2, added: 2, changed: 0 });
    expect((await stateOf(ws, owner, 'morgan.ellis.7'))?.state).toBe('request_sent');
    const [kept] = await rows(
      admin(),
      sql`select friendship from addon_outreach.profiles
          where workspace_id = ${ws} and username = 'morgan.ellis.7'`,
    );
    expect(kept).toEqual({ friendship: 'request_sent' });
  });

  it('refuses an empty list, and one too long for a save', async () => {
    expect(await refused(save(owner, { list: 'friends', people: [] }))).toBe('validation');
    const many = Array.from({ length: 501 }, (_, i) => ({
      ...byNumber(String(100005000000000 + i), `Made Up ${i}`),
      mutualFriends: null,
    }));
    expect(await refused(save(owner, { list: 'friends', people: many }))).toBe('validation');
  });
});

describe('answering a friend request, and what else says where things stand', () => {
  let ws: string;
  const note = (u: TestUser, input: Record<string, unknown>, at?: Date) =>
    runAs(u, ws, 'outreach.friend.note', input, at);

  beforeAll(async () => {
    ws = await business('Outreach Answers Co');
    await runAs(owner, ws, 'outreach.friends.save', {
      list: 'requests',
      people: [
        { ...byName('jamie.cole.3', 'Jamie Cole'), mutualFriends: 2 },
        { ...byName('parker.reed.8', 'Parker Reed'), mutualFriends: null },
      ],
    });
  }, 60_000);

  it('makes them friends on Confirm, and turns the request down on Delete', async () => {
    expect(
      await note(owner, { answer: 'confirm', ...byName('jamie.cole.3', 'Jamie Cole') }),
    ).toEqual({ profileId: expect.any(String), personId: null, state: 'friends' });
    expect((await stateOf(ws, owner, 'jamie.cole.3'))?.state).toBe('friends');
    await note(owner, { answer: 'delete', ...byName('parker.reed.8', 'Parker Reed') });
    expect((await stateOf(ws, owner, 'parker.reed.8'))?.state).toBe('declined');
  });

  it('keeps a turned-down request when their profile later shows they aren’t friends', async () => {
    await runAs(owner, ws, 'outreach.profile.save', {
      ...byName('parker.reed.8', 'Parker Reed'),
      friendship: 'not_friends',
    });
    expect((await stateOf(ws, owner, 'parker.reed.8'))?.state).toBe('declined');
    // Their profile saved as friends after all: they asked again, and the person said yes.
    await runAs(owner, ws, 'outreach.profile.save', {
      ...byName('parker.reed.8', 'Parker Reed'),
      friendship: 'friends',
    });
    expect((await stateOf(ws, owner, 'parker.reed.8'))?.state).toBe('friends');
  });

  it('says a friend request was sent, and never lets an answer that waited undo a later look', async () => {
    await runAs(owner, ws, 'outreach.touch.save', {
      kind: 'friend_request',
      ...byName('morgan.ellis.2', 'Morgan Ellis'),
    });
    const sent = await stateOf(ws, owner, 'morgan.ellis.2');
    expect(sent?.state).toBe('request_sent');
    // Deleted on Facebook a day ago, sent only now: what's kept is newer.
    await note(
      owner,
      { answer: 'delete', ...byName('morgan.ellis.2', 'Morgan Ellis') },
      new Date(Date.now() - 24 * HOUR),
    );
    expect(await stateOf(ws, owner, 'morgan.ellis.2')).toEqual(sent);
  });
});

describe('Keep and Don’t pitch', () => {
  let ws: string;
  const set = (u: TestUser, input: Record<string, unknown>) =>
    runAs(u, ws, 'outreach.friend.set', input);
  const avery = byName('avery.lane.4', 'Avery Lane');

  beforeAll(async () => {
    ws = await business('Outreach Marks Co');
    await runAs(owner, ws, 'outreach.friends.save', {
      list: 'friends',
      people: [{ ...avery, mutualFriends: 5 }],
    });
  }, 60_000);

  it('keeps a friend for the person alone', async () => {
    const kept = await set(owner, { ...avery, keep: true });
    expect(kept).toEqual({ profileId: expect.any(String), keep: true, dontPitch: null });
    expect((await stateOf(ws, owner, 'avery.lane.4'))?.keep).toBe(true);
    // A teammate keeping them too keeps their own friend.
    await set(member, { profileId: kept.profileId, keep: true });
    expect(await stateOf(ws, member, 'avery.lane.4')).toMatchObject({
      state: 'friends',
      keep: true,
    });
    expect(await refused(set(owner, { profileId: kept.profileId }))).toBe('validation');
  });

  it('stops every step to someone on Don’t pitch from counting, for the whole business', async () => {
    const marked = await set(member, { ...byName('sky.patel.21', 'Sky Patel'), dontPitch: true });
    expect(marked.dontPitch).toEqual({
      by: 'Taylor Member',
      at: expect.any(String),
      tagged: false,
    });
    for (const kind of ['friend_request', 'like', 'comment', 'message'])
      expect(
        await refused(
          runAs(owner, ws, 'outreach.touch.save', { kind, ...byName('sky.patel.21', 'Sky Patel') }),
        ),
      ).toBe('outreach_dont_pitch');
    // Only whoever put them on it, or an owner or admin, takes them off.
    await runAs(member, ws, 'outreach.friend.set', { ...avery, dontPitch: true });
    const other = await createTestUser('outf-other', { fullName: 'Casey Other' });
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: other.id, role: 'member' });
    expect(
      await refused(runAs(other, ws, 'outreach.friend.set', { ...avery, dontPitch: false })),
    ).toBe('outreach_dont_pitch_not_yours');
    expect(
      (await runAs(owner, ws, 'outreach.friend.set', { ...avery, dontPitch: false })).dontPitch,
    ).toBeNull();
    expect(
      (await runAs(owner, ws, 'outreach.touch.save', { kind: 'like', ...avery })).repeated,
    ).toBe(false);
  });

  it('treats a customer tagged Friend or family as Don’t pitch', async () => {
    const saved = await runAs(owner, ws, 'outreach.profile.save', {
      ...byName('drew.palmer.6', 'Drew Palmer'),
      friendship: 'friends',
    });
    const [tag] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.tags (workspace_id, name) values (${ws}, 'friend or family') returning id`,
    );
    await rows(
      admin(),
      sql`insert into app.record_tags (workspace_id, tag_id, record_type, record_id)
          values (${ws}, ${tag!.id}, 'person', ${saved.personId})`,
    );
    expect(
      await refused(
        runAs(owner, ws, 'outreach.touch.save', {
          kind: 'message',
          ...byName('drew.palmer.6', 'Drew Palmer'),
        }),
      ),
    ).toBe('outreach_dont_pitch');
    const dontPitch = await runAs(owner, ws, 'outreach.friends', { view: 'dont_pitch' });
    expect(dontPitch.counts.dontPitch).toBe(2);
    expect(
      dontPitch.people.map((p: { name: string; dontPitch: unknown }) => [p.name, p.dontPitch]),
    ).toEqual([
      ['Sky Patel', { by: 'Taylor Member', at: expect.any(String), tagged: false }],
      ['Drew Palmer', { by: null, at: null, tagged: true }],
    ]);
  });
});

describe('the Friends tab and the look-up', () => {
  let ws: string;
  const tab = (u: TestUser, input: Record<string, unknown> = {}) =>
    runAs(u, ws, 'outreach.friends', input);

  beforeAll(async () => {
    ws = await business('Outreach Tab Co');
    const crm = PLAYBOOK_TEMPLATES.crm_demos;
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: crm.name,
      template: 'crm_demos',
      details: { ...crm.details, area: 'Austin and Round Rock, TX' },
    });
    await runAs(owner, ws, 'outreach.friends.save', {
      list: 'friends',
      people: [
        { ...byName('quinn.harper.5', 'Quinn Harper'), mutualFriends: 40 },
        { ...byName('avery.lane.4', 'Avery Lane'), mutualFriends: 1 },
      ],
    });
    await runAs(owner, ws, 'outreach.friends.save', {
      list: 'requests',
      people: [
        { ...byName('sky.patel.21', 'Sky Patel'), mutualFriends: null },
        { ...byName('rowan.blake.9', 'Rowan Blake'), mutualFriends: 2 },
        { ...byName('jamie.cole.3', 'Jamie Cole'), mutualFriends: null },
      ],
    });
    // What their profiles said, saved: an owner in Round Rock, and someone selling CRMs.
    await runAs(owner, ws, 'outreach.profile.save', {
      ...byName('jamie.cole.3', 'Jamie Cole'),
      intro: ['Owner at Cole Landscaping', 'Lives in Round Rock, Texas'],
      friendship: 'request_received',
    });
    await runAs(owner, ws, 'outreach.touch.save', {
      kind: 'friend_request',
      ...byName('parker.reed.8', 'Parker Reed'),
    });
  }, 60_000);

  it('counts each view, with Facebook’s cap', async () => {
    const friends = await tab(owner);
    expect(friends.counts).toEqual({
      friends: 2,
      fits: 0,
      requests: 3,
      sent: 1,
      keep: 0,
      dontPitch: 0,
    });
    expect(friends.cap).toBe(5000);
    expect(friends.people.map((p: { name: string }) => p.name)).toEqual([
      'Avery Lane',
      'Quinn Harper',
    ]);
    expect((await tab(owner, { search: 'harp' })).people).toHaveLength(1);
    expect((await tab(owner, { view: 'sent' })).people[0]).toMatchObject({
      name: 'Parker Reed',
      state: 'request_sent',
    });
    // A teammate's Friends tab is their own.
    expect((await tab(member)).counts).toEqual({
      friends: 0,
      fits: 0,
      requests: 0,
      sent: 0,
      keep: 0,
      dontPitch: 0,
    });
  });

  it('puts the friend requests best fit first, and says why', async () => {
    const requests = await tab(owner, { view: 'requests' });
    expect(
      requests.people.map((p: { name: string; fit: { level: string } }) => [p.name, p.fit.level]),
    ).toEqual([
      ['Jamie Cole', 'good'],
      ['Rowan Blake', 'maybe'],
      ['Sky Patel', 'unknown'],
    ]);
    expect(requests.people[0].fit).toEqual({
      level: 'good',
      score: 4,
      playbookName: 'CRM demos',
      reasons: ['“Owner” on their profile', 'In Round Rock'],
    });
    expect(requests.people[0].intro).toEqual([
      'Owner at Cole Landscaping',
      'Lives in Round Rock, Texas',
    ]);
  });

  it('lists a long list a page at a time, and a search looks through all of it', async () => {
    const big = await business('Outreach Pages Co');
    // 205 made-up friends, Friend 001 to Friend 205: two full pages, and five on the third.
    const numbered = (n: number) => String(n).padStart(3, '0');
    await runAs(owner, big, 'outreach.friends.save', {
      list: 'friends',
      people: Array.from({ length: 205 }, (_, i) =>
        byName(`friend.${numbered(i + 1)}`, `Friend ${numbered(i + 1)}`),
      ),
    });
    const names = (got: { people: { name: string }[] }) => got.people.map((p) => p.name);

    const first = await runAs(owner, big, 'outreach.friends', {});
    expect(first).toMatchObject({ page: 1, pages: 3, total: 205, more: 105 });
    expect(names(first)).toHaveLength(100);
    expect([names(first)[0], names(first)[99]]).toEqual(['Friend 001', 'Friend 100']);
    expect(names(await runAs(owner, big, 'outreach.friends', { page: 2 }))[0]).toBe('Friend 101');
    const last = await runAs(owner, big, 'outreach.friends', { page: 3 });
    expect(last).toMatchObject({ page: 3, pages: 3, total: 205, more: 0 });
    expect(names(last)).toEqual([
      'Friend 201',
      'Friend 202',
      'Friend 203',
      'Friend 204',
      'Friend 205',
    ]);
    // A page past the end shows the last one.
    expect(await runAs(owner, big, 'outreach.friends', { page: 9 })).toMatchObject({
      page: 3,
      people: last.people,
    });

    // A search looks through every page, and has pages of its own.
    const found = await runAs(owner, big, 'outreach.friends', { search: '20', page: 2 });
    expect(found).toMatchObject({ page: 1, pages: 1, total: 8, more: 0 });
    expect(names(found)).toEqual([
      'Friend 020',
      'Friend 120',
      'Friend 200',
      'Friend 201',
      'Friend 202',
      'Friend 203',
      'Friend 204',
      'Friend 205',
    ]);
    // An empty list is one empty page.
    expect(await runAs(owner, big, 'outreach.friends', { view: 'keep' })).toMatchObject({
      people: [],
      page: 1,
      pages: 1,
      total: 0,
      more: 0,
    });

    // The friend requests are put in order of fit before they're cut into pages.
    await runAs(owner, big, 'outreach.friends.save', {
      list: 'requests',
      people: Array.from({ length: 105 }, (_, i) => ({
        ...byName(`asker.${numbered(i + 1)}`, `Asker ${numbered(i + 1)}`),
        mutualFriends: i + 1,
      })),
    });
    const asked = await runAs(owner, big, 'outreach.friends', { view: 'requests', page: 2 });
    expect(asked).toMatchObject({ page: 2, pages: 2, total: 105, more: 0 });
    expect(names(asked)).toEqual(['Asker 005', 'Asker 004', 'Asker 003', 'Asker 002', 'Asker 001']);
  });

  it('marks the people on a page: where things stand, Keep and Don’t pitch, with a customer or not', async () => {
    await runAs(owner, ws, 'outreach.friend.set', {
      ...byName('quinn.harper.5', 'Quinn Harper'),
      keep: true,
      dontPitch: true,
    });
    const looked = await runAs(owner, ws, 'outreach.lookup', {
      profiles: [
        { id: null, username: 'quinn.harper.5' },
        { id: null, username: 'JAMIE.COLE.3' },
        { id: null, username: 'nobody.here' },
      ],
    });
    const marks = Object.fromEntries(
      looked.marks.map((m: { username: string }) => [m.username, m]),
    );
    expect(Object.keys(marks).sort()).toEqual(['jamie.cole.3', 'quinn.harper.5']);
    expect(marks['quinn.harper.5']).toMatchObject({
      state: 'friends',
      keep: true,
      dontPitch: { by: 'Jordan Owner', tagged: false },
      mutualFriends: 40,
    });
    expect(marks['jamie.cole.3']).toMatchObject({
      state: 'request_received',
      keep: false,
      dontPitch: null,
      intro: ['Owner at Cole Landscaping', 'Lives in Round Rock, Texas'],
    });
    // Only Jamie is a customer: saving their profile added them.
    expect(looked.profiles.map((p: { username: string }) => p.username)).toEqual(['jamie.cole.3']);
  });
});

describe('with the add-on off', () => {
  it('keeps and shows nothing', async () => {
    const ws = await business('Outreach Friends Off Co');
    await setOutreach(ws, 'disabled');
    expect(
      await refused(
        runAs(owner, ws, 'outreach.friend.note', {
          answer: 'confirm',
          ...byName('avery.lane.4', 'Avery Lane'),
        }),
      ),
    ).toBe('addon_inactive');
    expect(await refused(runAs(owner, ws, 'outreach.friends', {}))).toBe('addon_inactive');
  });
});
