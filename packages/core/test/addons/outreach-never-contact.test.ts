/**
 * Social Outreach: who's never reached (docs/outreach.md, "Never contact, and Don't pitch on a chat").
 * - Never contact is the business's, and stronger than Don't pitch: no step to them counts, no message is drafted for
 *   them and any waiting is skipped, their friend requests are neither confirmed nor shown to decide, a reply of
 *   theirs is off Today, and only whoever put them on it, or an owner or admin, takes them off. It covers a profile
 *   kept twice under the same name.
 * - Don't pitch and Never contact are switched on a chat's row as on a friend's: each chat says whether who it's
 *   with is on either list, and Don't pitch takes their follow-ups and pitches off Today until it's switched off.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { outreachBusiness, refused, runAs, runWith } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();
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
    createTestUser('outn-owner', { fullName: 'Morgan Owner' }),
    createTestUser('outn-member', { fullName: 'Riley Member' }),
  ]);
}, 60_000);
afterAll(closeTestDbs);

async function business(name: string): Promise<string> {
  const ws = await outreachBusiness(owner, name);
  await admin()
    .insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: member.id, role: 'member' });
  const crm = PLAYBOOK_TEMPLATES.crm_demos;
  await runAs(owner, ws, 'outreach.playbook.save', {
    name: crm.name,
    template: 'crm_demos',
    details: crm.details,
  });
  return ws;
}

/** Chats the person read in Messenger, read by the AI as likely prospects. */
async function chats(
  ws: string,
  list: { name: string; thread: string; profile: unknown; fromMeLast: boolean }[],
) {
  await runAs(owner, ws, 'outreach.chats.collect', {
    chats: list.map((c) => ({
      name: c.name,
      thread: { id: c.thread, encrypted: false },
      profile: c.profile,
      messages: c.fromMeLast
        ? [
            { fromMe: false, text: 'How much is it?', at: daysAgo(6) },
            { fromMe: true, text: 'Happy to show you, want a demo?', at: daysAgo(5) },
          ]
        : [{ fromMe: false, text: 'Do you do demos?', at: daysAgo(1) }],
    })),
  });
  await rows(
    admin(),
    sql`update addon_outreach.file_chats set read_state = 'read', prospect = true
        where workspace_id = ${ws}`,
  );
}

const profileId = async (ws: string, name: string) => {
  const [p] = await rows<{ id: string }>(
    admin(),
    sql`select id from addon_outreach.profiles where workspace_id = ${ws} and name = ${name}
        order by created_at limit 1`,
  );
  return p!.id;
};

describe('Never contact', () => {
  let ws: string;
  const today = async (u: TestUser = owner) =>
    ((await runAs(u, ws, 'outreach.today', {})).items as { kind: string; name: string }[]).map(
      (i) => `${i.kind}: ${i.name}`,
    );

  beforeAll(async () => {
    ws = await business('Outreach Never Co');
    // Two ask to be friends: one fits the playbook well. One wrote back and is owed a reply.
    await runAs(owner, ws, 'outreach.friends.save', {
      list: 'requests',
      people: [
        { profile: fb('jo.banks.2'), name: 'Jo Banks', mutualFriends: 3 },
        { profile: fb('kit.lowe.7'), name: 'Kit Lowe', mutualFriends: 1 },
      ],
    });
    // They asked two days ago, so they show to decide though the AI hasn't read them (decision 136).
    await rows(
      admin(),
      sql`update addon_outreach.friends set since = now() - interval '2 days' where workspace_id = ${ws}`,
    );
    await chats(ws, [
      { name: 'Ash Quill', thread: '3000111', profile: fb('ash.quill.4'), fromMeLast: false },
    ]);
  }, 60_000);

  it('takes them off Today, Waiting for you’s requests, and every step', async () => {
    expect(await today()).toContain('reply: Ash Quill');
    const before = await runAs(owner, ws, 'outreach.waiting', {});
    const asked = (w: { items: { request?: { name: string } }[] }) =>
      w.items.flatMap((i) => (i.request ? [i.request.name] : []));
    expect(asked(before)).toEqual(expect.arrayContaining(['Jo Banks', 'Kit Lowe']));

    const marked = await runAs(member, ws, 'outreach.friend.set', {
      profile: fb('ash.quill.4'),
      name: 'Ash Quill',
      neverContact: true,
    });
    expect(marked).toMatchObject({
      dontPitch: null,
      neverContact: { by: 'Riley Member', at: expect.any(String) },
    });
    await runAs(member, ws, 'outreach.friend.set', {
      profile: fb('kit.lowe.7'),
      name: 'Kit Lowe',
      neverContact: true,
    });
    expect(await today()).not.toContain('reply: Ash Quill');
    expect(asked(await runAs(owner, ws, 'outreach.waiting', {}))).toEqual(['Jo Banks']);
    for (const kind of ['friend_request', 'like', 'comment', 'message'])
      expect(
        await refused(
          runAs(owner, ws, 'outreach.touch.save', {
            kind,
            profile: fb('ash.quill.4'),
            name: 'Ash Quill',
          }),
        ),
      ).toBe('outreach_never_contact');
    expect(
      await refused(
        runAs(owner, ws, 'outreach.send.queue', {
          profileId: marked.profileId,
          kind: 'reply',
          text: 'Yes, happy to show you.',
        }),
      ),
    ).toBe('outreach_never_contact');
  });

  it('skips a message drafted for them before, anyone’s', async () => {
    const jo = await profileId(ws, 'Jo Banks');
    const sent = await runAs(owner, ws, 'outreach.send.queue', {
      profileId: jo,
      kind: 'opener',
      text: 'Hi Jo, thanks for the add!',
    });
    expect(sent.state).toBe('waiting');
    await runAs(member, ws, 'outreach.friend.set', { profileId: jo, neverContact: true });
    const [row] = await rows<{ state: string }>(
      admin(),
      sql`select state from addon_outreach.sends where id = ${sent.sendId}`,
    );
    expect(row?.state).toBe('skipped');
    expect((await runAs(owner, ws, 'outreach.sends', {})).sends).toEqual([]);
  });

  it('covers someone kept twice under the same name', async () => {
    // Messenger shows Ash by number: the same name on the same network is never reached either.
    expect(
      await refused(
        runAs(owner, ws, 'outreach.touch.save', {
          kind: 'message',
          profile: byNumber('100077712345'),
          name: 'Ash  Quill',
        }),
      ),
    ).toBe('outreach_never_contact');
  });

  it('lists them on the Friends tab, and lets only whoever added them, or an owner, take them off', async () => {
    const tab = await runAs(owner, ws, 'outreach.friends', { view: 'never_contact' });
    expect(tab.counts.neverContact).toBe(3);
    expect(tab.people.map((p: { name: string }) => p.name).sort()).toEqual([
      'Ash Quill',
      'Jo Banks',
      'Kit Lowe',
    ]);
    expect(tab.people[0].neverContact).toEqual({ by: 'Riley Member', at: expect.any(String) });
    const other = await createTestUser('outn-other', { fullName: 'Sam Other' });
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: other.id, role: 'member' });
    const kit = await profileId(ws, 'Kit Lowe');
    expect(
      await refused(
        runAs(other, ws, 'outreach.friend.set', { profileId: kit, neverContact: false }),
      ),
    ).toBe('outreach_never_contact_not_yours');
    const off = await runAs(owner, ws, 'outreach.friend.set', {
      profileId: kit,
      neverContact: false,
    });
    expect(off.neverContact).toBeNull();
    expect(
      (
        await runAs(owner, ws, 'outreach.touch.save', {
          kind: 'like',
          profile: fb('kit.lowe.7'),
          name: 'Kit Lowe',
        })
      ).repeated,
    ).toBe(false);
  });

  it('refuses to research them', async () => {
    const ash = await profileId(ws, 'Ash Quill');
    await runWith(
      owner,
      ws,
      'outreach.live.beat',
      {
        computer: { id: randomUUID(), name: 'Chrome on Linux', version: '0.27.0' },
        active: true,
        status: { state: 'idle', line: null, lineAt: null, nextAt: null },
      },
      { channel: 'extension', commandId: randomUUID(), occurredAt: new Date(), sentAt: new Date() },
    );
    expect(
      await refused(
        runAs(owner, ws, 'outreach.ask.make', { ask: { kind: 'research', profileId: ash } }),
      ),
    ).toBe('outreach_research_not_pitched');
  });
});

describe('Don’t pitch on a chat', () => {
  let ws: string;
  const today = async () =>
    ((await runAs(owner, ws, 'outreach.today', {})).items as { kind: string; name: string }[]).map(
      (i) => `${i.kind}: ${i.name}`,
    );
  const chatRows = async () =>
    (
      (await runAs(owner, ws, 'outreach.chats', { view: 'read' })).chats as {
        name: string;
        profileId: string | null;
        dontPitch: boolean;
        neverContact: boolean;
      }[]
    ).sort((a, b) => a.name.localeCompare(b.name));

  beforeAll(async () => {
    ws = await business('Outreach Chats Co');
    await chats(ws, [
      { name: 'Drew Moss', thread: '4000222', profile: fb('drew.moss.3'), fromMeLast: true },
      { name: 'Noor Vale', thread: '4000444', profile: fb('noor.vale.5'), fromMeLast: true },
    ]);
    // Noor's chat reads ready for the offer.
    await rows(
      admin(),
      sql`update addon_outreach.file_chats set pitch = 'ready', pitch_why = 'Asked how to start'
          where workspace_id = ${ws} and name = 'Noor Vale'`,
    );
  }, 60_000);

  it('says on each chat whether who it’s with is on Don’t pitch or Never contact', async () => {
    expect((await chatRows()).map((c) => [c.name, c.dontPitch, c.neverContact])).toEqual([
      ['Drew Moss', false, false],
      ['Noor Vale', false, false],
    ]);
    expect(await today()).toEqual(
      expect.arrayContaining(['follow_up: Drew Moss', 'pitch: Noor Vale']),
    );
  });

  it('takes someone switched to Don’t pitch from their chat off Today, and back on when switched off', async () => {
    const [drew, noor] = await chatRows();
    await runAs(owner, ws, 'outreach.friend.set', { profileId: drew!.profileId, dontPitch: true });
    await runAs(owner, ws, 'outreach.friend.set', { profileId: noor!.profileId, dontPitch: true });
    expect((await chatRows()).map((c) => c.dontPitch)).toEqual([true, true]);
    const list = await today();
    expect(list).not.toContain('follow_up: Drew Moss');
    expect(list).not.toContain('pitch: Noor Vale');
    await runAs(owner, ws, 'outreach.friend.set', { profileId: drew!.profileId, dontPitch: false });
    expect((await chatRows())[0]!.dontPitch).toBe(false);
    expect(await today()).toContain('follow_up: Drew Moss');
  });

  it('shows Never contact on the chat too', async () => {
    const [drew] = await chatRows();
    await runAs(owner, ws, 'outreach.friend.set', {
      profileId: drew!.profileId,
      neverContact: true,
    });
    expect((await chatRows())[0]).toMatchObject({ name: 'Drew Moss', neverContact: true });
    expect(await today()).not.toContain('follow_up: Drew Moss');
  });
});
