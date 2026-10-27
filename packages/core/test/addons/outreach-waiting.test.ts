/**
 * Social Outreach: Waiting for you (docs/outreach.md, decisions 40 and 42). One list of what waits for the person:
 * replies handed over, messages to OK, steps the extension needs them for, and friend requests that are theirs to
 * decide (every request lately that Today doesn't list to confirm, so none is on neither). A need is the same need
 * when noted again, stays quiet a week after Let it go, and clears when its step is noted; a message that didn't go
 * becomes one. Each is on its profile's network and links there: the link given on it, else their page. Approve all leaves the messages that wait one at a time, and Today counts them the same way. A press
 * that waited keeps its moment. The Live tab and the team view count what waits as the list does.
 */
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTOMATION_DEFAULTS } from '../../src/addons/outreach/automation';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { oneByOne } from '../../src/addons/outreach/waiting';
import { outreachBusiness, refused, runAs } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const MIN = 60_000;
const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms);
const fb = (username: string) => ({
  id: null,
  username,
  url: `https://www.facebook.com/${username}`,
});

type Item = {
  kind: 'reply' | 'message' | 'need' | 'request';
  send?: { sendId: string; name: string; handedOver: boolean; needsYou: string | null };
  need?: {
    needId: string;
    step: string;
    platform: string;
    name: string;
    url: string | null;
    text: string | null;
    why: string;
  };
  request?: { profileId: string; name: string; held: string | null; why: string[] };
};
const named = (items: Item[]) =>
  items.map((i) => `${i.kind}: ${i.send?.name ?? i.need?.name ?? i.request?.name ?? '?'}`);

let owner: TestUser;
let member: TestUser;

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('outw-owner', { fullName: 'Morgan Owner' }),
    createTestUser('outw-member', { fullName: 'Riley Member' }),
  ]);
}, 60_000);
afterAll(closeTestDbs);

/** A business with the owner and member in it, and the CRM demos playbook in use unless asked not to. */
async function business(name: string, playbook = true): Promise<string> {
  const ws = await outreachBusiness(owner, name);
  await admin()
    .insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: member.id, role: 'member' });
  if (playbook) {
    const crm = PLAYBOOK_TEMPLATES.crm_demos;
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: crm.name,
      template: 'crm_demos',
      details: crm.details,
    });
  }
  return ws;
}

const profileOf = async (ws: string, username: string) => {
  const [p] = await rows<{ id: string }>(
    admin(),
    sql`select id from addon_outreach.profiles where workspace_id = ${ws} and username = ${username}`,
  );
  return p!.id;
};
const intro = (ws: string, username: string, line: string) =>
  rows(
    admin(),
    sql`update addon_outreach.profiles set intro = array[${line}]
        where workspace_id = ${ws} and username = ${username}`,
  );
const events = async (ws: string, type: string) =>
  (
    await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.events where workspace_id = ${ws} and event_type = ${type}`,
    )
  )[0]!.n;
const requests = (
  u: TestUser,
  ws: string,
  people: { username: string; name: string; mutual?: number }[],
  at?: Date,
) =>
  runAs(
    u,
    ws,
    'outreach.friends.save',
    {
      list: 'requests',
      people: people.map((p) => ({
        profile: fb(p.username),
        name: p.name,
        mutualFriends: p.mutual ?? null,
      })),
    },
    at,
  );

describe('Waiting for you', () => {
  let ws: string;
  const waiting = (u: TestUser = owner, items = true) =>
    runAs(u, ws, 'outreach.waiting', { items });
  const list = async (u: TestUser = owner) => named((await waiting(u)).items as Item[]);
  let dana: string;
  let ana: string;
  let eli: string;
  let opener: { sendId: string };
  let reply: { sendId: string };

  beforeAll(async () => {
    ws = await business('Outreach Waiting Co');
    await runAs(owner, ws, 'outreach.automation.save', {
      settings: { ...AUTOMATION_DEFAULTS, sending: 'steps', replies: 'simple' },
    });
    await runAs(owner, ws, 'outreach.wheels.end', { userId: owner.id });
    // A first message to someone who accepted two days ago, waiting for an OK.
    await runAs(
      owner,
      ws,
      'outreach.touch.save',
      { kind: 'friend_request', profile: fb('dana.reyes.4'), name: 'Dana Reyes' },
      ago(3 * DAY),
    );
    dana = await profileOf(ws, 'dana.reyes.4');
    await rows(
      admin(),
      sql`update addon_outreach.friends set state = 'friends', since = now() - interval '2 days'
          where workspace_id = ${ws} and user_id = ${owner.id} and profile_id = ${dana}`,
    );
    opener = await runAs(owner, ws, 'outreach.send.queue', {
      profileId: dana,
      kind: 'opener',
      text: 'Hi Dana! How do you keep track of customers?',
    });
    // A reply to someone asking for a refund: handed over, with why.
    await runAs(owner, ws, 'outreach.chats.collect', {
      chats: [
        {
          name: 'Ana Moss',
          thread: { id: '4001', encrypted: false },
          profile: fb('ana.moss.3'),
          messages: [{ fromMe: false, text: 'Can I get a refund?', at: new Date().toISOString() }],
        },
      ],
    });
    ana = await profileOf(ws, 'ana.moss.3');
    const [chat] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_outreach.file_chats where workspace_id = ${ws} and profile_id = ${ana}`,
    );
    reply = await runAs(owner, ws, 'outreach.send.queue', {
      profileId: ana,
      kind: 'reply',
      chatId: chat!.id,
      text: 'Sure, let me look into it.',
      simple: true,
    });
    // Someone the extension couldn't send a friend request to.
    await runAs(owner, ws, 'outreach.friend.set', {
      profile: fb('eli.brook.2'),
      name: 'Eli Brook',
      keep: false,
    });
    eli = await profileOf(ws, 'eli.brook.2');
  }, 60_000);

  it('lists each kind once, in order, and counts them', async () => {
    const noted = await runAs(owner, ws, 'outreach.need.note', {
      step: 'friend_request',
      profileId: eli,
      name: 'Eli Brook',
      url: 'https://www.facebook.com/eli.brook.2',
      why: 'couldn’t find “Add friend”',
    });
    expect(noted).toEqual({ needId: expect.any(String), fresh: true });
    await requests(owner, ws, [
      { username: 'rowan.vale.4', name: 'Rowan Vale', mutual: 6 },
      { username: 'kit.morrow.8', name: 'Kit Morrow', mutual: 0 },
      { username: 'sage.hill.1', name: 'Sage Hill' },
      { username: 'lane.park.5', name: 'Lane Park' },
      { username: 'quinn.ray.6', name: 'Quinn Ray', mutual: 6 },
    ]);
    // Rowan fits well: Today's to confirm. Quinn fits well but is on Don't pitch: theirs to decide.
    await intro(ws, 'rowan.vale.4', 'Owner at Vale Roofing');
    await intro(ws, 'quinn.ray.6', 'Owner at Ray Painting');
    await runAs(owner, ws, 'outreach.friend.set', {
      profileId: await profileOf(ws, 'quinn.ray.6'),
      dontPitch: true,
    });
    // Sage asked three weeks ago; Lane is set aside.
    await rows(
      admin(),
      sql`update addon_outreach.friends f set since = now() - interval '21 days'
          from addon_outreach.profiles p
          where p.id = f.profile_id and p.workspace_id = ${ws} and p.username = 'sage.hill.1'`,
    );
    await runAs(owner, ws, 'outreach.request.set_aside', {
      profileId: await profileOf(ws, 'lane.park.5'),
    });
    // The member's own of each kind are theirs.
    await requests(member, ws, [{ username: 'jo.west.2', name: 'Jo West' }]);
    await runAs(member, ws, 'outreach.need.note', {
      step: 'warm_up',
      profileId: dana,
      name: 'Dana Reyes',
      url: null,
      why: 'couldn’t find “Like”',
    });

    expect(await list()).toEqual([
      'reply: Ana Moss',
      'message: Dana Reyes',
      'need: Eli Brook',
      'request: Kit Morrow',
      'request: Quinn Ray',
    ]);
    const all = await waiting();
    const handed = (all.items as Item[]).find((i) => i.kind === 'reply')!.send!;
    expect(handed).toMatchObject({ handedOver: true, needsYou: expect.any(String) });
    const quinn = (all.items as Item[]).find((i) => i.request?.name === 'Quinn Ray')!.request!;
    expect(quinn.held).toBe('dont_pitch');
    const kit = (all.items as Item[]).find((i) => i.request?.name === 'Kit Morrow')!.request!;
    expect(kit).toMatchObject({ held: null, why: ['Nothing on their profile fits a playbook'] });
    expect(all.kinds).toMatchObject({
      reply: { count: 1 },
      message: { count: 1 },
      need: { count: 1 },
      request: { count: 2 },
    });
    expect(all.count).toBe(5);
    expect(all).toMatchObject({ pushes: 'bundled', hours: AUTOMATION_DEFAULTS.hours });
    // The counts alone, the same.
    const counts = await waiting(owner, false);
    expect(counts).toMatchObject({ count: 5, items: [] });
    expect(counts.kinds).toEqual(all.kinds);
    expect(await list(member)).toEqual(['need: Dana Reyes', 'request: Jo West']);
    // Rowan is on Today, so not here.
    const today = await runAs(owner, ws, 'outreach.today', {});
    expect(
      today.items
        .filter((i: { kind: string }) => i.kind === 'confirm')
        .map((i: { name: string }) => i.name),
    ).toEqual(['Rowan Vale']);
  });

  it('keeps a step noted again as the same need, and quiet a week after Let it go', async () => {
    const before = await events(ws, 'outreach.need.noted');
    const again = await runAs(owner, ws, 'outreach.need.note', {
      step: 'friend_request',
      profileId: eli,
      name: 'Eli Brook',
      url: null,
      why: 'Facebook showed a different page',
    });
    expect(again.fresh).toBe(false);
    expect(await events(ws, 'outreach.need.noted')).toBe(before);
    const need = ((await waiting()).items as Item[]).find((i) => i.kind === 'need')!.need!;
    expect(need).toMatchObject({ needId: again.needId, why: 'Facebook showed a different page' });

    expect(
      await runAs(owner, ws, 'outreach.need.clear', { needId: need.needId, how: 'dismissed' }),
    ).toEqual({ needId: need.needId, state: 'dismissed' });
    expect(await list()).not.toContain('need: Eli Brook');
    // Let go: the same step for them within the week keeps nothing.
    expect(
      await runAs(owner, ws, 'outreach.need.note', {
        step: 'friend_request',
        profileId: eli,
        name: 'Eli Brook',
        url: null,
        why: 'couldn’t find “Add friend”',
      }),
    ).toEqual({ needId: null, fresh: false });
    // Cleared already, or someone else's: not found.
    expect(
      await refused(runAs(owner, ws, 'outreach.need.clear', { needId: need.needId, how: 'done' })),
    ).toBe('not_found');
    const theirs = ((await waiting(member)).items as Item[]).find((i) => i.kind === 'need')!.need!;
    expect(
      await refused(
        runAs(owner, ws, 'outreach.need.clear', { needId: theirs.needId, how: 'done' }),
      ),
    ).toBe('not_found');
    // Someone not kept here, or a post not on their list: not found.
    const elsewhere = await business('Outreach Waiting Elsewhere Co', false);
    const stranger = (
      await runAs(owner, elsewhere, 'outreach.friend.set', {
        profile: fb('zed.far.1'),
        name: 'Zed Far',
        keep: true,
      })
    ).profileId as string;
    expect(
      await refused(
        runAs(owner, ws, 'outreach.need.note', {
          step: 'confirm',
          profileId: stranger,
          name: 'Zed Far',
          url: null,
          why: 'couldn’t find “Confirm”',
        }),
      ),
    ).toBe('not_found');
    expect(
      await refused(
        runAs(owner, ws, 'outreach.need.note', {
          step: 'comment',
          profileId: eli,
          postId: crypto.randomUUID(),
          name: 'Eli Brook',
          url: null,
          why: 'couldn’t find the box to comment in',
        }),
      ),
    ).toBe('not_found');
  });

  it('comes back, and says so, once it has been off the list a week', async () => {
    const kit = await profileOf(ws, 'kit.morrow.8');
    const first = await runAs(
      owner,
      ws,
      'outreach.need.note',
      {
        step: 'confirm',
        profileId: kit,
        name: 'Kit Morrow',
        url: null,
        why: 'couldn’t find “Confirm”',
      },
      ago(9 * DAY),
    );
    expect(first.fresh).toBe(true);
    expect(await list()).not.toContain('need: Kit Morrow');
    const back = await runAs(owner, ws, 'outreach.need.note', {
      step: 'confirm',
      profileId: kit,
      name: 'Kit Morrow',
      url: null,
      why: 'couldn’t find “Confirm”',
    });
    expect(back).toEqual({ needId: first.needId, fresh: true });
    expect(await list()).toContain('need: Kit Morrow');
    // Confirm pressed: it's done.
    await runAs(owner, ws, 'outreach.friend.note', {
      answer: 'confirm',
      profile: fb('kit.morrow.8'),
      name: 'Kit Morrow',
    });
    expect(await list()).not.toContain('need: Kit Morrow');
    expect(await list()).not.toContain('request: Kit Morrow');
  });

  it('clears a need when its step is noted: a friend request by profile, a comment by its post', async () => {
    const noor = (
      await runAs(owner, ws, 'outreach.friend.set', {
        profile: fb('noor.haddad.2'),
        name: 'Noor Haddad',
        keep: false,
      })
    ).profileId as string;
    const [one, two] = await rows<{ id: string; url: string }>(
      admin(),
      sql`insert into addon_outreach.posts (workspace_id, user_id, profile_id, url, body, found, seen_at)
          values (${ws}, ${owner.id}, ${noor}, 'https://www.facebook.com/groups/77/posts/1/', 'Any CRM tips?', 'find', now()),
                 (${ws}, ${owner.id}, ${noor}, 'https://www.facebook.com/groups/77/posts/2/', 'Who does follow-ups?', 'find', now())
          returning id, url`,
    );
    for (const post of [one!, two!])
      await runAs(owner, ws, 'outreach.need.note', {
        step: 'comment',
        profileId: noor,
        postId: post.id,
        name: 'Noor Haddad',
        url: post.url,
        why: 'Facebook didn’t take the comment',
      });
    await runAs(owner, ws, 'outreach.need.note', {
      step: 'friend_request',
      profileId: noor,
      name: 'Noor Haddad',
      url: null,
      why: 'couldn’t find “Add friend”',
    });
    expect((await list()).filter((n) => n === 'need: Noor Haddad')).toHaveLength(3);
    await runAs(owner, ws, 'outreach.touch.save', {
      kind: 'comment',
      profile: fb('noor.haddad.2'),
      name: 'Noor Haddad',
      postUrl: one!.url,
    });
    const left = ((await waiting()).items as Item[]).filter((i) => i.need?.name === 'Noor Haddad');
    expect(left.map((i) => i.need!.step).sort()).toEqual(['comment', 'friend_request']);
    await runAs(owner, ws, 'outreach.touch.save', {
      kind: 'friend_request',
      profile: fb('noor.haddad.2'),
      name: 'Noor Haddad',
    });
    const after = ((await waiting()).items as Item[]).filter((i) => i.need?.name === 'Noor Haddad');
    expect(after.map((i) => i.need!.step)).toEqual(['comment']);
  });

  it('clears a comment with no post kept by its link, links only on its network, and waits from when it arrived', async () => {
    const ivy = (
      await runAs(owner, ws, 'outreach.friend.set', {
        profile: fb('ivy.stone.3'),
        name: 'Ivy Stone',
        keep: false,
      })
    ).profileId as string;
    const postUrl = 'https://www.facebook.com/groups/77/posts/9/';
    // Noted offline three hours ago, with no post kept.
    const noted = await runAs(
      owner,
      ws,
      'outreach.need.note',
      { step: 'comment', profileId: ivy, name: 'Ivy Stone', url: postUrl, why: 'no comment box' },
      ago(3 * 60 * MIN),
    );
    const [kept] = await rows<{ seen_at: Date; created_at: Date }>(
      admin(),
      sql`select seen_at, created_at from addon_outreach.needs where id = ${noted.needId}`,
    );
    expect(Date.now() - new Date(kept!.seen_at).getTime()).toBeGreaterThan(2 * 60 * MIN);
    // It began to wait when it reached HandsFreeOS: the bundled push takes it for new.
    expect(Date.now() - new Date(kept!.created_at).getTime()).toBeLessThan(5 * MIN);
    // A link on no network of theirs isn't kept: their page on Facebook is.
    const elsewhere = await runAs(owner, ws, 'outreach.need.note', {
      step: 'warm_up',
      profileId: ivy,
      name: 'Ivy Stone',
      url: 'https://example.com/ivy',
      why: 'couldn’t find “Like”',
    });
    const shown = ((await waiting()).items as Item[]).filter((i) => i.need?.name === 'Ivy Stone');
    expect(shown.find((i) => i.need!.needId === elsewhere.needId)!.need).toMatchObject({
      platform: 'facebook',
      url: 'https://www.facebook.com/ivy.stone.3',
    });
    // The comment's post, kept as its link.
    expect(shown.find((i) => i.need!.needId === noted.needId)!.need!.url).toBe(postUrl);
    await runAs(owner, ws, 'outreach.touch.save', {
      kind: 'comment',
      profile: fb('ivy.stone.3'),
      name: 'Ivy Stone',
      postUrl,
    });
    const left = ((await waiting()).items as Item[]).filter((i) => i.need?.name === 'Ivy Stone');
    expect(left.map((i) => i.need!.step)).toEqual(['warm_up']);
  });

  it('links each step on its own network: Alignable’s keeps its link, and one kept with none opens their page', async () => {
    const page = 'https://www.alignable.com/springfield-il/lane-landscaping-co';
    const lane = (
      await runAs(owner, ws, 'outreach.friend.set', {
        platform: 'alignable',
        profile: { id: null, username: 'lane-landscaping-co', url: page },
        name: 'Lane Landscaping Co',
        keep: false,
      })
    ).profileId as string;
    const noted = await runAs(owner, ws, 'outreach.need.note', {
      step: 'friend_request',
      profileId: lane,
      name: 'Lane Landscaping Co',
      url: page,
      why: 'couldn’t find Connect on their page',
    });
    const shown = async () =>
      ((await waiting()).items as Item[]).find((i) => i.need?.needId === noted.needId)!.need!;
    expect(await shown()).toMatchObject({
      step: 'friend_request',
      platform: 'alignable',
      url: page,
    });
    // One kept with no link, as every network's but Facebook's were till now: it opens their page, on Alignable.
    await rows(admin(), sql`update addon_outreach.needs set url = null where id = ${noted.needId}`);
    expect(await shown()).toMatchObject({ platform: 'alignable', url: page });
    // Seen again with a link on another network: their page is kept instead.
    await runAs(owner, ws, 'outreach.need.note', {
      step: 'friend_request',
      profileId: lane,
      name: 'Lane Landscaping Co',
      url: 'https://www.facebook.com/lane.landscaping',
      why: 'couldn’t find Connect on their page',
    });
    const [kept] = await rows<{ url: string | null }>(
      admin(),
      sql`select url from addon_outreach.needs where id = ${noted.needId}`,
    );
    expect(kept!.url).toBe(page);
    await runAs(owner, ws, 'outreach.need.clear', { needId: noted.needId, how: 'dismissed' });
  });

  it('keeps a press that waited at its moment: the extension couldn’t again after it, so it stays', async () => {
    const lee = (
      await runAs(owner, ws, 'outreach.friend.set', {
        profile: fb('lee.ford.7'),
        name: 'Lee Ford',
        keep: false,
      })
    ).profileId as string;
    const noted = await runAs(
      owner,
      ws,
      'outreach.need.note',
      { step: 'warm_up', profileId: lee, name: 'Lee Ford', url: null, why: 'couldn’t find “Like”' },
      ago(2 * 60 * MIN),
    );
    // Seen again after the person pressed I did it on a phone with no signal.
    await runAs(
      owner,
      ws,
      'outreach.need.note',
      { step: 'warm_up', profileId: lee, name: 'Lee Ford', url: null, why: 'couldn’t find “Like”' },
      ago(30 * MIN),
    );
    expect(
      await runAs(
        owner,
        ws,
        'outreach.need.clear',
        { needId: noted.needId, how: 'done' },
        ago(60 * MIN),
      ),
    ).toEqual({ needId: noted.needId, state: 'open' });
    expect(await list()).toContain('need: Lee Ford');
    expect(
      await runAs(owner, ws, 'outreach.need.clear', { needId: noted.needId, how: 'done' }),
    ).toEqual({ needId: noted.needId, state: 'done' });
  });

  it('makes a message that didn’t go a need, with its words', async () => {
    await runAs(owner, ws, 'outreach.touch.save', {
      kind: 'friend_request',
      profile: fb('fern.ash.9'),
      name: 'Fern Ash',
    });
    const fern = await profileOf(ws, 'fern.ash.9');
    const s = await runAs(owner, ws, 'outreach.send.queue', {
      profileId: fern,
      kind: 'opener',
      text: 'Hi Fern!',
    });
    await runAs(owner, ws, 'outreach.send.approve', { sends: [{ sendId: s.sendId }] });
    await runAs(owner, ws, 'outreach.send.done', {
      sendId: s.sendId,
      sent: false,
      why: 'couldn’t find the box to write in',
    });
    const need = ((await waiting()).items as Item[]).find(
      (i) => i.need?.name === 'Fern Ash',
    )!.need!;
    expect(need).toMatchObject({
      step: 'message',
      text: 'Hi Fern!',
      why: 'couldn’t find the box to write in',
      // No chat with them yet: their page, on their network.
      platform: 'facebook',
      url: 'https://www.facebook.com/fern.ash.9',
    });
    // Sent by hand: noted, and done.
    await runAs(owner, ws, 'outreach.touch.save', {
      kind: 'message',
      profile: fb('fern.ash.9'),
      name: 'Fern Ash',
    });
    expect(await list()).not.toContain('need: Fern Ash');
  });

  it('leaves replies handed over out of Approve all, and Today counts Approve all the same', async () => {
    // Today lists Ana's reply from her chat, read as a likely prospect's.
    await rows(
      admin(),
      sql`update addon_outreach.file_chats set read_state = 'read', prospect = true, last_from_me = false,
            last_at = now() where workspace_id = ${ws} and profile_id = ${ana}`,
    );
    const today = await runAs(owner, ws, 'outreach.today', {});
    const sends = today.items
      .map(
        (i: { send: { state: string; handedOver: boolean; needsYou: string | null } | null }) =>
          i.send,
      )
      .filter(Boolean);
    expect(sends.some((s: { handedOver: boolean }) => s.handedOver)).toBe(true);
    const counted = sends.filter(
      (s: { state: string; handedOver: boolean; needsYou: string | null }) =>
        s.state === 'waiting' && !oneByOne(s),
    ).length;
    const ok = await runAs(owner, ws, 'outreach.send.approve', {});
    expect(ok.approved).toEqual([opener.sendId]);
    expect(ok.approved).toHaveLength(counted);
    expect(await list()).toContain('reply: Ana Moss');
    expect(await list()).not.toContain('message: Dana Reyes');
    // Named in an Approve all (the phone's, `partial`, any build) it's passed over too; named among others, refused.
    expect(
      (
        await runAs(owner, ws, 'outreach.send.approve', {
          sends: [{ sendId: reply.sendId }],
          partial: true,
        })
      ).approved,
    ).toEqual([]);
    expect(
      await refused(
        runAs(owner, ws, 'outreach.send.approve', {
          sends: [{ sendId: reply.sendId }, { sendId: opener.sendId }],
        }),
      ),
    ).toBe('outreach_send_one_by_one');
    expect(await list()).toContain('reply: Ana Moss');
    // Named alone, it's OK'd.
    expect(
      (await runAs(owner, ws, 'outreach.send.approve', { sends: [{ sendId: reply.sendId }] }))
        .approved,
    ).toEqual([reply.sendId]);
    expect(await list()).not.toContain('reply: Ana Moss');
  });

  it('sets a request aside until they ask again; a press that waited never hides a newer request', async () => {
    const jamie = 'jamie.cole.3';
    await requests(owner, ws, [{ username: jamie, name: 'Jamie Cole' }]);
    const id = await profileOf(ws, jamie);
    // Pressed before they asked (it waited on a phone): it stays.
    expect(
      await runAs(owner, ws, 'outreach.request.set_aside', { profileId: id }, ago(30 * MIN)),
    ).toEqual({ profileId: id });
    expect(await list()).toContain('request: Jamie Cole');
    await runAs(owner, ws, 'outreach.request.set_aside', { profileId: id });
    expect(await list()).not.toContain('request: Jamie Cole');
    // Turned down on Facebook, then they ask again: back.
    await runAs(owner, ws, 'outreach.friend.note', {
      answer: 'delete',
      profile: fb(jamie),
      name: 'Jamie Cole',
    });
    expect(await refused(runAs(owner, ws, 'outreach.request.set_aside', { profileId: id }))).toBe(
      'not_found',
    );
    await requests(owner, ws, [{ username: jamie, name: 'Jamie Cole' }]);
    expect(await list()).toContain('request: Jamie Cole');
  });

  it('counts the same on the Live tab and the team view', async () => {
    const mine = await waiting(owner, false);
    const theirs = await waiting(member, false);
    expect((await runAs(owner, ws, 'outreach.live', {})).waiting).toBe(mine.count);
    const team = await runAs(owner, ws, 'outreach.live.team', {});
    const of = (u: TestUser) =>
      team.people.find((p: { userId: string }) => p.userId === u.id)?.waiting;
    expect(of(owner)).toBe(mine.count);
    expect(of(member)).toBe(theirs.count);
  });
});

describe('friend requests to decide', () => {
  it('has every request Today doesn’t: with no playbook, a good fit is the person’s', async () => {
    const ws = await business('Outreach No Playbook Co', false);
    await requests(owner, ws, [{ username: 'ari.lake.2', name: 'Ari Lake', mutual: 14 }]);
    await rows(
      admin(),
      sql`insert into addon_outreach.groups (workspace_id, platform, platform_id, url, name)
          values (${ws}, 'facebook', '88', 'https://www.facebook.com/groups/88/', 'Lakeside Owners')`,
    );
    await rows(
      admin(),
      sql`update addon_outreach.profiles set group_id = (select id from addon_outreach.groups
            where workspace_id = ${ws}) where workspace_id = ${ws} and username = 'ari.lake.2'`,
    );
    const got = await runAs(owner, ws, 'outreach.waiting', {});
    expect(got.items).toHaveLength(1);
    expect(got.items[0].request).toMatchObject({
      name: 'Ari Lake',
      fit: 'good',
      held: 'no_playbook',
    });
    expect(
      (await runAs(owner, ws, 'outreach.today', {})).items.filter(
        (i: { kind: string }) => i.kind === 'confirm',
      ),
    ).toEqual([]);
  });

  it('leaves out the good fits past the most Today lists at once: Today confirms them on a later day', async () => {
    const ws = await business('Outreach Many Requests Co');
    const people = Array.from({ length: 21 }, (_, i) => ({
      username: `sam.shop.${String(i).padStart(2, '0')}`,
      name: `Sam Shop ${String(i).padStart(2, '0')}`,
      mutual: 2,
    }));
    await requests(owner, ws, people);
    await rows(
      admin(),
      sql`update addon_outreach.profiles set intro = array['Owner at a shop'] where workspace_id = ${ws}`,
    );
    const today = await runAs(owner, ws, 'outreach.today', {});
    const confirmed = today.items.filter((i: { kind: string }) => i.kind === 'confirm');
    expect(confirmed).toHaveLength(20);
    const got = await runAs(owner, ws, 'outreach.waiting', {});
    expect(got.items).toEqual([]);
    expect(got.count).toBe(0);
  });
});

describe('a friend request accepted', () => {
  it('clears the need to send it once their friends list has them, but one noted after that look', async () => {
    const ws = await business('Outreach Accepted Co', false);
    const opal = (
      await runAs(owner, ws, 'outreach.friend.set', {
        profile: fb('opal.reed.3'),
        name: 'Opal Reed',
        keep: false,
      })
    ).profileId as string;
    const need = (u: TestUser) =>
      runAs(u, ws, 'outreach.need.note', {
        step: 'friend_request',
        profileId: opal,
        name: 'Opal Reed',
        url: null,
        why: 'couldn’t find “Add friend”',
      });
    const needs = async (u: TestUser) =>
      ((await runAs(u, ws, 'outreach.waiting', {})).items as Item[]).flatMap((i) =>
        i.need ? [`${i.need.step}: ${i.need.name}`] : [],
      );
    const friends = (u: TestUser, at?: Date) =>
      runAs(
        u,
        ws,
        'outreach.friends.save',
        { list: 'friends', people: [{ profile: fb('opal.reed.3'), name: 'Opal Reed' }] },
        at,
      );
    await need(owner);
    await need(member);
    // A look at the friends list from before the need leaves it.
    await friends(owner, ago(60 * MIN));
    expect(await needs(owner)).toEqual(['friend_request: Opal Reed']);
    const cleared = await events(ws, 'outreach.need.cleared');
    await friends(owner);
    expect(await needs(owner)).toEqual([]);
    expect(await events(ws, 'outreach.need.cleared')).toBe(cleared + 1);
    // The member's own need is theirs, till their list has Opal.
    expect(await needs(member)).toEqual(['friend_request: Opal Reed']);
    await friends(member);
    expect(await needs(member)).toEqual([]);
  });
});
