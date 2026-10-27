/**
 * Social Outreach: Mark as client, from the person menu on anyone's name (docs/outreach.md decision 91).
 * - Mark as client adds them to Contacts when they aren't there, or ties them to the customer named, and puts core's
 *   Client tag on their customer: one tag, whatever its capitals. Anyone's outreach to them waiting for an OK is
 *   skipped, on every profile the rule covers (their customer's on any network, and any kept under the same name on
 *   the same network). Replies stay.
 * - It needs Add and edit customers, and the add-on on. Not a client after all takes the tag off alone, and says when
 *   Contacts still counts them a client for another reason.
 * - `outreach.profile.marks` says where someone stands as their menu opens, and whether the person may take them off
 *   a list.
 * - On Today a client gets no outreach, only a reply they're owed (with no demo link), and their request is still
 *   confirmed. The Pipeline shows them as clients, with why, out of All in play.
 * - Don't pitch skips outreach waiting for an OK too, never a reply (the owner's answer, 26 Oct 2026).
 */
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTOMATION_DEFAULTS } from '../../src/addons/outreach/automation';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { outreachBusiness, refused, runAs, setOutreach } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();
const DEMO = 'https://book.example.com/s/pine-street/demo';
const fb = (username: string) => ({
  id: null,
  username,
  url: `https://www.facebook.com/${username}`,
});
const byNumber = (id: string) => ({
  id,
  username: null,
  url: `https://www.facebook.com/profile.php?id=${id}`,
});

let owner: TestUser;
let member: TestUser;

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('outc-owner', { fullName: 'Morgan Owner' }),
    createTestUser('outc-member', { fullName: 'Riley Member' }),
  ]);
}, 60_000);
afterAll(closeTestDbs);

/** A business with the owner and the member in it, and the CRM demos playbook in use, with a demo link. */
async function business(name: string): Promise<string> {
  const ws = await outreachBusiness(owner, name);
  await admin()
    .insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: member.id, role: 'member' });
  const crm = PLAYBOOK_TEMPLATES.crm_demos;
  await runAs(owner, ws, 'outreach.playbook.save', {
    name: crm.name,
    template: 'crm_demos',
    details: { ...crm.details, link: DEMO },
  });
  return ws;
}

/** Someone kept in Social Outreach, nothing more: their profile's id. */
const kept = async (ws: string, profile: unknown, name: string): Promise<string> =>
  (await runAs(owner, ws, 'outreach.friend.set', { profile, name, keep: false })).profileId;

const events = async (ws: string, type: string) =>
  (
    await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.events where workspace_id = ${ws} and event_type = ${type}`,
    )
  )[0]!.n;

const stateOf = async (sendId: string) =>
  (
    await rows<{ state: string }>(
      admin(),
      sql`select state from addon_outreach.sends where id = ${sendId}`,
    )
  )[0]?.state;

/** The business's tags named Client, any capitals, and the customers that carry each. */
const clientTags = (ws: string) =>
  rows<{ id: string; name: string; carried: string[] }>(
    admin(),
    sql`select tg.id, tg.name::text as name,
          coalesce(array_agg(rt.record_id::text) filter (where rt.record_id is not null), '{}') as carried
        from app.tags tg left join app.record_tags rt on rt.tag_id = tg.id and rt.record_type = 'person'
        where tg.workspace_id = ${ws} and lower(tg.name::text) = 'client'
        group by tg.id, tg.name`,
  );

describe('Mark as client', () => {
  let ws: string;
  let avery: string;
  let averyOnLinkedIn: string;
  let averyPerson: string;
  let danaGroup: string;
  let danaTwin: string;
  let kit: string;
  const sent: Record<string, string> = {};
  const set = (u: TestUser, profileId: string, client: boolean, personId?: string) =>
    runAs(u, ws, 'outreach.client.set', {
      profileId,
      client,
      ...(personId ? { personId } : {}),
    });

  beforeAll(async () => {
    ws = await business('Outreach Client Co');
    // Avery is in Contacts already, on Facebook and on LinkedIn.
    avery = await kept(ws, fb('avery.lane.5'), 'Avery Lane');
    averyPerson = (await runAs(owner, ws, 'outreach.profile.contact', { profileId: avery }))
      .personId;
    const [li] = await rows<{ id: string }>(
      admin(),
      sql`insert into addon_outreach.profiles (workspace_id, platform, username, url, name, person_id)
          values (${ws}, 'linkedin', 'avery-lane-5', 'https://www.linkedin.com/in/avery-lane-5/',
            'Avery Lane', ${averyPerson})
          returning id`,
    );
    averyOnLinkedIn = li!.id;
    // Dana is kept twice on Facebook: by name, and by number.
    danaGroup = await kept(ws, fb('dana.reyes.12'), 'Dana Reyes');
    danaTwin = await kept(ws, byNumber('100077712345'), 'Dana Reyes');
    kit = await kept(ws, fb('kit.lowe.7'), 'Kit Lowe');
    // Messages waiting for an OK, the owner's and the member's.
    const queue = async (u: TestUser, key: string, profileId: string, kind: string) => {
      const made = await runAs(u, ws, 'outreach.send.queue', {
        profileId,
        kind,
        text: `A ${kind} for them.`,
      });
      expect(made.state).toBe('waiting');
      sent[key] = made.sendId;
    };
    await queue(owner, 'averyOpener', avery, 'opener');
    await queue(owner, 'averyReply', avery, 'reply');
    await queue(member, 'averyPitch', averyOnLinkedIn, 'pitch');
    await queue(member, 'danaOpener', danaGroup, 'opener');
  }, 60_000);

  it('adds them to Contacts, tags them Client with the tag the business has, and skips the outreach waiting for their name', async () => {
    // The business has a tag of that name already, in its own capitals.
    const made = await runAs(owner, ws, 'tag.create', { name: 'client' });
    const skippedBefore = await events(ws, 'outreach.send.skipped');
    const marked = await set(owner, danaTwin, true);
    expect(marked).toEqual({
      profileId: danaTwin,
      personId: expect.any(String),
      client: true,
      tagged: true,
      because: null,
      addedPerson: true,
      skipped: 1,
    });
    const [person] = await rows<{ first_name: string; last_name: string; source: string }>(
      admin(),
      sql`select first_name, last_name, source from app.people where id = ${marked.personId}`,
    );
    expect(person).toEqual({ first_name: 'Dana', last_name: 'Reyes', source: 'Facebook' });
    expect(await clientTags(ws)).toEqual([
      { id: made.tagId, name: 'client', carried: [marked.personId] },
    ]);
    // Dana kept by name is the same person: the member's first message to her waits no more.
    expect(await stateOf(sent.danaOpener!)).toBe('skipped');
    expect(await events(ws, 'outreach.send.skipped')).toBe(skippedBefore + 1);
    expect(await events(ws, 'outreach.client.marked')).toBe(1);
  });

  it('skips anyone’s outreach to them on every network, keeps a reply, and is the same done twice', async () => {
    const marked = await set(owner, avery, true);
    expect(marked).toMatchObject({
      personId: averyPerson,
      client: true,
      tagged: true,
      addedPerson: false,
      skipped: 2,
    });
    expect(await stateOf(sent.averyOpener!)).toBe('skipped');
    expect(await stateOf(sent.averyPitch!)).toBe('skipped');
    expect(await stateOf(sent.averyReply!)).toBe('waiting');
    const again = await set(member, avery, true);
    expect(again).toMatchObject({ client: true, tagged: true, addedPerson: false, skipped: 0 });
    // Still the one tag, on Dana and Avery once each.
    const tags = await clientTags(ws);
    expect(tags).toHaveLength(1);
    expect(tags[0]!.carried).toHaveLength(2);
    expect(tags[0]!.carried).toContain(averyPerson);
  });

  it('refuses outreach to a client, and still lets a reply go', async () => {
    for (const [profileId, kind] of [
      [avery, 'pitch'],
      [averyOnLinkedIn, 'follow_up'],
      [danaGroup, 'opener'],
    ] as const)
      expect(
        await refused(
          runAs(owner, ws, 'outreach.send.queue', { profileId, kind, text: 'Want a demo?' }),
        ),
      ).toBe('outreach_client');
    const reply = await runAs(owner, ws, 'outreach.send.queue', {
      profileId: danaGroup,
      kind: 'reply',
      text: 'Thanks, Dana!',
    });
    expect(reply.state).toBe('waiting');
  });

  it('ties them to the customer named instead', async () => {
    const named = (await runAs(owner, ws, 'person.create', { firstName: 'Kit', lastName: 'Lowe' }))
      .personId;
    const marked = await set(owner, kit, true, named);
    expect(marked).toMatchObject({ personId: named, client: true, addedPerson: false });
  });

  it('takes the Client tag off alone, and says when Contacts counts them a client besides', async () => {
    const off = await set(owner, avery, false);
    expect(off).toMatchObject({ client: false, tagged: false, because: null, skipped: 0 });
    // What was skipped stays skipped.
    expect(await stateOf(sent.averyOpener!)).toBe('skipped');
    // A job done for Kit: Contacts counts them a client whatever the tag.
    const [kitNow] = await rows<{ person_id: string }>(
      admin(),
      sql`select person_id from addon_outreach.profiles where id = ${kit}`,
    );
    await rows(
      admin(),
      sql`insert into app.jobs (workspace_id, person_id, title, status)
          values (${ws}, ${kitNow!.person_id}, 'Tune-up', 'done')`,
    );
    expect(await set(owner, kit, false)).toMatchObject({
      client: true,
      tagged: false,
      because: 'job',
    });
    expect(
      await refused(
        runAs(owner, ws, 'outreach.send.queue', { profileId: kit, kind: 'pitch', text: 'Hi!' }),
      ),
    ).toBe('outreach_client');
  });

  it('says where someone stands as their menu opens', async () => {
    expect(await runAs(owner, ws, 'outreach.profile.marks', { profileId: kit })).toEqual({
      profileId: kit,
      name: 'Kit Lowe',
      platform: 'facebook',
      url: 'https://www.facebook.com/kit.lowe.7',
      personId: expect.any(String),
      partner: false,
      demoBooked: false,
      client: { on: true, tagged: false, because: 'job' },
      dontPitch: null,
      neverContact: null,
      canTakeOff: { dontPitch: false, neverContact: false },
    });
    // Kept under a client's name: one, with no reason of their own.
    expect(
      (await runAs(owner, ws, 'outreach.profile.marks', { profileId: danaGroup })).client,
    ).toEqual({ on: true, tagged: false, because: null });
    // Only whoever put them on a list, or an owner or admin, may take them off it.
    await runAs(member, ws, 'outreach.friend.set', { profileId: avery, dontPitch: true });
    const theirs = await runAs(member, ws, 'outreach.profile.marks', { profileId: avery });
    expect(theirs).toMatchObject({
      dontPitch: { by: 'Riley Member', tagged: false },
      canTakeOff: { dontPitch: true, neverContact: false },
    });
    expect(
      (await runAs(owner, ws, 'outreach.profile.marks', { profileId: avery })).canTakeOff,
    ).toEqual({ dontPitch: true, neverContact: false });
    const other = await createTestUser('outc-other', { fullName: 'Sam Other' });
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: other.id, role: 'member' });
    expect(
      (await runAs(other, ws, 'outreach.profile.marks', { profileId: avery })).canTakeOff,
    ).toEqual({ dontPitch: false, neverContact: false });
    // Someone in another business isn't found.
    const elsewhere = await business('Outreach Client Elsewhere Co');
    expect(
      await refused(runAs(owner, elsewhere, 'outreach.profile.marks', { profileId: avery })),
    ).toBe('not_found');
    expect(
      await refused(
        runAs(owner, elsewhere, 'outreach.client.set', { profileId: avery, client: true }),
      ),
    ).toBe('not_found');
  });

  it('needs Add and edit customers, and the add-on on', async () => {
    await runAs(owner, ws, 'permission.set_member', {
      userId: member.id,
      permission: 'records.write',
      allowed: false,
    });
    try {
      expect(await refused(set(member, danaGroup, false))).toBe('outreach_client_needs_contacts');
      // Where they stand is still theirs to see.
      expect(
        (await runAs(member, ws, 'outreach.profile.marks', { profileId: danaGroup })).client.on,
      ).toBe(true);
    } finally {
      await runAs(owner, ws, 'permission.set_member', {
        userId: member.id,
        permission: 'records.write',
        allowed: null,
      });
    }
    await setOutreach(ws, 'disabled');
    try {
      expect(await refused(set(owner, kit, true))).toBe('addon_inactive');
    } finally {
      await setOutreach(ws, 'enabled');
    }
  });
});

describe('a client on Today and in the Pipeline', () => {
  let ws: string;
  const group = {
    id: '523456789',
    slug: null,
    url: 'https://www.facebook.com/groups/523456789/',
    name: 'Austin Small Business Owners',
  };
  const inGroup = (username: string, name: string, lines: string[], runsGroup = false) => ({
    profile: fb(username),
    name,
    lines,
    part: runsGroup ? 'Admins and moderators' : 'Members near you',
    runsGroup,
  });
  type Item = { kind: string; name: string; demoLink: string | null };
  const items = async () => (await runAs(owner, ws, 'outreach.today', {})).items as Item[];
  const today = async () => (await items()).map((i) => `${i.kind}: ${i.name}`);
  const pipeline = (view = 'all') =>
    runAs(owner, ws, 'outreach.stages', { view }) as Promise<{
      counts: Record<string, number>;
      people: { name: string; stage: string; why: string[]; nextStep: string | null }[];
    }>;
  const profileOf = async (username: string) =>
    (
      await rows<{ id: string }>(
        admin(),
        sql`select id from addon_outreach.profiles where workspace_id = ${ws} and username = ${username}`,
      )
    )[0]!.id;

  beforeAll(async () => {
    ws = await business('Outreach Client Today Co');
    await runAs(owner, ws, 'outreach.automation.save', {
      settings: { ...AUTOMATION_DEFAULTS, warmUp: false },
    });
    // Found in a group whose admins were read: Dana, Sam and Casey to send friend requests to.
    await runAs(owner, ws, 'outreach.group.save', {
      group,
      members: 34_718,
      people: [
        inGroup('dana.reyes.12', 'Dana Reyes', ['Owner at Reyes Plumbing']),
        inGroup('sam.lee.1', 'Sam Lee', ['Owner at Lee Bakery']),
        inGroup('casey.m', 'Casey Moreno', ['CEO at Moreno Roofing']),
        inGroup('lee.park.3', 'Lee Park', ['Founder of Park Dental'], true),
      ],
    });
    await runAs(owner, ws, 'outreach.group.save', {
      group,
      people: [inGroup('lee.park.3', 'Lee Park', [], true)],
      adminsPage: true,
    });
    // Casey's post was liked.
    await runAs(owner, ws, 'outreach.touch.save', {
      kind: 'like',
      profile: fb('casey.m'),
      name: 'Casey Moreno',
    });
    // Avery accepted a friend request two days ago: a first message is due.
    await runAs(
      owner,
      ws,
      'outreach.touch.save',
      { kind: 'friend_request', profile: fb('avery.lane.5'), name: 'Avery Lane' },
      new Date(Date.now() - 3 * DAY),
    );
    await rows(
      admin(),
      sql`update addon_outreach.friends set state = 'friends', since = now() - interval '2 days'
          where workspace_id = ${ws} and user_id = ${owner.id}
            and profile_id = (select id from addon_outreach.profiles
              where workspace_id = ${ws} and username = 'avery.lane.5')`,
    );
    // Quinn wrote yesterday, and is owed a reply.
    await runAs(owner, ws, 'outreach.chats.collect', {
      chats: [
        {
          name: 'Quinn Harper',
          thread: { id: '5000123', encrypted: false },
          profile: fb('quinn.harper.4'),
          messages: [{ fromMe: false, text: 'Do you do demos?', at: daysAgo(1) }],
        },
      ],
    });
    await rows(
      admin(),
      sql`update addon_outreach.file_chats set read_state = 'read', prospect = true
          where workspace_id = ${ws}`,
    );
    // Jo asked to be friends, and fits the playbook well: Today's to confirm.
    await runAs(owner, ws, 'outreach.friends.save', {
      list: 'requests',
      people: [{ profile: fb('jo.banks.2'), name: 'Jo Banks', mutualFriends: 6 }],
    });
    await rows(
      admin(),
      sql`update addon_outreach.profiles set intro = array['Owner at Banks Roofing']
          where workspace_id = ${ws} and username = 'jo.banks.2'`,
    );
  }, 60_000);

  it('leaves a client out of every outreach step, but a reply they’re owed and their request to confirm', async () => {
    expect(await today()).toEqual(
      expect.arrayContaining([
        'confirm: Jo Banks',
        'opener: Avery Lane',
        'reply: Quinn Harper',
        'friend_request: Dana Reyes',
        'friend_request: Sam Lee',
      ]),
    );
    expect((await items()).find((i) => i.name === 'Quinn Harper')!.demoLink).toContain(
      'book.example.com',
    );
    const before = await pipeline();
    expect(before.people.map((p) => [p.name, p.stage]).sort()).toEqual([
      ['Avery Lane', 'friends'],
      ['Casey Moreno', 'warming'],
      ['Quinn Harper', 'talking'],
    ]);

    // Dana and Casey are clients kept by number; Avery, Quinn and Jo are marked by name.
    for (const [id, name] of [
      ['100077712345', 'Dana Reyes'],
      ['100077799999', 'Casey Moreno'],
    ] as const) {
      const twin = await kept(ws, byNumber(id), name);
      await runAs(owner, ws, 'outreach.client.set', { profileId: twin, client: true });
    }
    for (const username of ['avery.lane.5', 'quinn.harper.4', 'jo.banks.2'])
      await runAs(owner, ws, 'outreach.client.set', {
        profileId: await profileOf(username),
        client: true,
      });

    const after = await today();
    for (const gone of [
      'friend_request: Dana Reyes',
      'friend_request: Casey Moreno',
      'opener: Avery Lane',
    ])
      expect(after).not.toContain(gone);
    expect(after).toEqual(
      expect.arrayContaining([
        'reply: Quinn Harper',
        'confirm: Jo Banks',
        'friend_request: Sam Lee',
      ]),
    );
    // A client's reply carries no demo link.
    expect((await items()).find((i) => i.name === 'Quinn Harper')!.demoLink).toBeNull();
  });

  it('shows clients in the Pipeline with why, and leaves them out of All in play', async () => {
    const all = await pipeline();
    expect(all.people).toEqual([]);
    expect(all.counts).toMatchObject({ all: 0, client: 3, lost: 0 });
    const clients = await pipeline('client');
    expect(clients.people.map((p) => [p.name, p.stage, p.why, p.nextStep]).sort()).toEqual([
      ['Avery Lane', 'client', ['A client in Contacts: they’re tagged Client'], null],
      ['Casey Moreno', 'client', ['Same name as a client in Contacts'], null],
      ['Quinn Harper', 'client', ['A client in Contacts: they’re tagged Client'], null],
    ]);
  });

  it('puts them back when the tag comes off', async () => {
    await runAs(owner, ws, 'outreach.client.set', {
      profileId: await profileOf('avery.lane.5'),
      client: false,
    });
    expect(await today()).toContain('opener: Avery Lane');
    expect((await pipeline()).people.map((p) => [p.name, p.stage])).toEqual([
      ['Avery Lane', 'friends'],
    ]);
  });
});

describe('Don’t pitch', () => {
  it('skips outreach waiting for an OK, anyone’s, but never a reply', async () => {
    const ws = await business('Outreach Dont Pitch Co');
    const ash = await kept(ws, fb('ash.quill.4'), 'Ash Quill');
    const opener = await runAs(member, ws, 'outreach.send.queue', {
      profileId: ash,
      kind: 'opener',
      text: 'Hi Ash, thanks for the add!',
    });
    const reply = await runAs(owner, ws, 'outreach.send.queue', {
      profileId: ash,
      kind: 'reply',
      text: 'Sure, happy to help.',
    });
    await runAs(owner, ws, 'outreach.friend.set', { profileId: ash, dontPitch: true });
    expect(await stateOf(opener.sendId)).toBe('skipped');
    expect(await stateOf(reply.sendId)).toBe('waiting');
    expect(await events(ws, 'outreach.send.skipped')).toBe(1);
  });
});
