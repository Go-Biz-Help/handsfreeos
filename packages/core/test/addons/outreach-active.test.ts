/**
 * Staying active in the person's Facebook groups (docs/outreach.md decision 114, the owner's pick 19a): each day their
 * computer likes 3 to 5 recent posts in up to 3 of their groups, and keeps one question there for a reply. Today lists
 * it, the AI writes the reply, and it waits for their OK at first under the comments' hold, then goes under the post
 * like a comment. Only a build that posts it gets one. Each person's own.
 */
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asksSomething,
  GROUP_REPLIES_SINCE,
  GROUP_REPLY_WORDS,
  groupRepliesOn,
  likesToday,
  recentPost,
  REPLY_TRIES,
} from '../../src/addons/outreach/active';
import { AUTOMATION_DEFAULTS } from '../../src/addons/outreach/automation';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { commentTitle, postTitleAround } from '../../src/addons/outreach/waiting-words';
import { computerOn, getReady, outreachBusiness, refused, runAs } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const FB = 'https://www.facebook.com';
const DAY = 86_400_000;

afterAll(closeTestDbs);

describe('what staying active takes', () => {
  it('likes 3 to 5 a day, the same number all day', () => {
    const noon = Date.UTC(2026, 9, 28, 12);
    const week = Array.from({ length: 7 }, (_, i) => likesToday(noon + i * DAY));
    expect(week.every((n) => n >= 3 && n <= 5)).toBe(true);
    expect(new Set(week).size).toBe(3);
    expect(likesToday(noon + 3 * 3_600_000)).toBe(likesToday(noon));
  });

  it('takes a post as recent within three days, or when Facebook didn’t say', () => {
    expect(recentPost('3h')).toBe(true);
    expect(recentPost('Yesterday at 3:15 PM')).toBe(true);
    expect(recentPost('3d')).toBe(true);
    expect(recentPost(null)).toBe(true);
    expect(recentPost('4d')).toBe(false);
    expect(recentPost('October 3')).toBe(false);
  });

  it('takes a question mark or a call for help as asking something, links aside', () => {
    expect(asksSomething('Anyone going to the chamber mixer Thursday?')).toBe(true);
    expect(asksSomething('Can anyone recommend a bookkeeper')).toBe(true);
    expect(asksSomething('Our new shop is open! https://example.com/?ref=group')).toBe(false);
    expect(asksSomething('Happy Friday, everyone')).toBe(false);
  });

  it('gives the day’s reply only to a build that posts it', () => {
    expect(groupRepliesOn(null)).toBe(false);
    expect(groupRepliesOn('0.105.0')).toBe(false);
    expect(groupRepliesOn(GROUP_REPLIES_SINCE)).toBe(true);
  });

  it('titles it as a question of theirs in Waiting for you', () => {
    expect(commentTitle('Dana Reyes', 'group_reply')).toBe('Answer Dana Reyes’s question');
    expect(commentTitle('Dana Reyes')).toBe('Comment on Dana Reyes’s post');
    expect(postTitleAround('comment')).not.toEqual(postTitleAround('group_reply'));
  });
});

describe('staying active in your groups', () => {
  let owner: TestUser;
  let riley: TestUser;
  let ws: string;
  const fb = (username: string) => ({ id: null, username, url: `${FB}/${username}` });
  const group = (slug: string, name: string) => ({
    id: null,
    slug,
    url: `${FB}/groups/${slug}/`,
    name,
  });
  const austin = group('austinsmallbiz', 'Austin Small Business Owners');
  const roofers = group('texasroofers', 'Texas Roofers Network');
  const bakers = group('austinbakers', 'Austin Home Bakers');
  const knitting = group('knittingcircletx', 'Knitting Circle');
  const theirs = group('rileysgroup', 'Hill Country Contractors');
  let n = 0;
  const asked = (username: string, name: string, text: string, g = austin) => ({
    url: `${FB}/groups/${g.slug}/posts/${9_000_000_000 + ++n}/`,
    author: fb(username),
    name,
    when: '2h',
    text,
    comments: 3,
    reactions: 5,
    group: g,
  });
  const next = async (u = owner) =>
    (await runAs(u, ws, 'outreach.active.next', {})) as {
      likes: number;
      reply: boolean;
      groups: { name: string | null }[];
      own: { url: string | null; username: string | null } | null;
    };
  const reply = (posts: ReturnType<typeof asked>[], u = owner) =>
    runAs(u, ws, 'outreach.active.reply', { posts }) as Promise<{
      postId: string | null;
      url: string | null;
      why: string | null;
    }>;
  const profileOf = async (username: string) =>
    (
      await rows<{ id: string }>(
        admin(),
        sql`select id from addon_outreach.profiles where workspace_id = ${ws} and username = ${username}`,
      )
    )[0]!.id;
  const replies = async (u = owner) =>
    (
      (await runAs(u, ws, 'outreach.today', {})).items as {
        kind: string;
        name: string;
        postId: string | null;
        why: string[];
        send: { sendId: string; state: string } | null;
      }[]
    ).filter((i) => i.kind === 'group_reply');
  const queue = (profileId: string, postId: string | null, text: string) =>
    runAs(owner, ws, 'outreach.send.queue', {
      profileId,
      kind: 'group_reply',
      text,
      ...(postId ? { postId } : {}),
    });
  /** The day's question kept yesterday instead, so another can be kept today. */
  const keptYesterday = () =>
    admin().execute(
      sql`update addon_outreach.posts set reply_at = reply_at - interval '1 day'
          where workspace_id = ${ws} and user_id = ${owner.id} and reply_at is not null`,
    );

  beforeAll(async () => {
    owner = await createTestUser('outac-owner', { fullName: 'Pat Owner' });
    // Got ready by hand below: the fixture's would read their profile again, without what it saw.
    ws = await outreachBusiness(owner, 'Active Co', { ready: false });
    riley = await createTestUser('outac-riley', { fullName: 'Riley Member' });
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: riley.id, role: 'member' });
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: 'CRM demos',
      template: 'crm_demos',
      details: PLAYBOOK_TEMPLATES.crm_demos.details,
    });
    await runAs(owner, ws, 'outreach.automation.save', {
      settings: { ...AUTOMATION_DEFAULTS, sending: 'steps' },
    });
    await runAs(owner, ws, 'outreach.groups.save', {
      groups: [austin, roofers, bakers, knitting, theirs].map((g) => ({ group: g, joined: true })),
    });
    // The AI found their people in two, some in one, and none in Knitting Circle; Riley works the last.
    await rows(
      admin(),
      sql`update addon_outreach.groups set check_state = case slug
            when ${austin.slug} then 'good' when ${roofers.slug} then 'good' when ${bakers.slug} then 'maybe'
            when ${knitting.slug} then 'not' else 'good' end,
            owner_user_id = case slug when ${theirs.slug} then ${riley.id}::uuid end
          where workspace_id = ${ws}`,
    );
  }, 60_000);

  it('does nothing before the person is ready', async () => {
    expect(await next()).toEqual({ likes: 0, reply: false, groups: [], own: null });
    await getReady(ws, [owner.id]);
  });

  it('likes a few in up to 3 groups that fit, Work these first, never a teammate’s', async () => {
    await computerOn(owner, ws, '0.105.0');
    const day = await next();
    expect(day.likes).toBe(likesToday());
    // An older build is never given a reply to keep.
    expect(day.reply).toBe(false);
    expect(day.own).toBeNull();
    const names = day.groups.map((g) => g.name);
    expect(names).toHaveLength(3);
    expect(names.slice(0, 2).sort()).toEqual([austin.name, roofers.name]);
    expect(names[2]).toBe(bakers.name);
    // One that posts replies is.
    await computerOn(owner, ws, GROUP_REPLIES_SINCE);
    expect((await next()).reply).toBe(true);
  });

  it('counts the likes noted in a group today, and knows the person’s own profile once read', async () => {
    await runAs(owner, ws, 'outreach.touch.save', {
      kind: 'like',
      profile: fb('lee.hart.3'),
      name: 'Lee Hart',
      group: austin,
      postUrl: `${FB}/groups/${austin.slug}/posts/8000000001/`,
      auto: true,
    });
    // A like off a group isn't one of these.
    await runAs(owner, ws, 'outreach.touch.save', {
      kind: 'like',
      profile: fb('lee.hart.3'),
      name: 'Lee Hart',
      postUrl: `${FB}/lee.hart.3/posts/8000000002/`,
    });
    expect((await next()).likes).toBe(likesToday() - 1);
    await rows(
      admin(),
      sql`update addon_outreach.setup set profile_check = profile_check || jsonb_build_object('seen',
            jsonb_build_object('url', ${`${FB}/pat.owner.1`}::text, 'name', 'Pat Owner', 'username', 'pat.owner.1',
              'line', null, 'links', '[]'::jsonb))
          where workspace_id = ${ws} and user_id = ${owner.id}`,
    );
    expect((await next()).own).toEqual({ url: `${FB}/pat.owner.1`, username: 'pat.owner.1' });
  });

  it('keeps the first question it can answer: never their own, one for a comment, or a teammate’s person', async () => {
    // Sam is Riley's to reach.
    await runAs(riley, ws, 'outreach.touch.save', {
      kind: 'like',
      profile: fb('sam.ortiz.5'),
      name: 'Sam Ortiz',
      postUrl: `${FB}/sam.ortiz.5/posts/8000000003/`,
    });
    await rows(
      admin(),
      sql`update addon_outreach.profiles set owner_user_id = ${riley.id}
          where workspace_id = ${ws} and username = 'sam.ortiz.5'`,
    );
    const mine = asked('pat.owner.1', 'Pat Owner', 'Who else is going to the expo this weekend?');
    const forAComment = asked('kate.nguyen.9', 'Kate Nguyen', 'Can anyone recommend a bookkeeper?');
    const rileys = asked('sam.ortiz.5', 'Sam Ortiz', 'Is the parking garage on 5th open late?');
    const dana = asked(
      'dana.reyes.31',
      'Dana Reyes',
      'Anyone going to the chamber mixer Thursday night?',
      roofers,
    );
    const milo = asked('milo.park.2', 'Milo Park', 'What time does the farmers market open?');
    const kept = await reply([mine, forAComment, rileys, dana, milo]);
    expect(kept).toEqual({ postId: expect.any(String), url: dana.url, why: null });
    const [post] = await rows<{
      found: string;
      check_state: string;
      reasons: string[];
      kept: boolean;
      group: string;
    }>(
      admin(),
      sql`select po.found, po.check_state, po.reasons, po.reply_at is not null as kept, g.name as group
          from addon_outreach.posts po join addon_outreach.groups g on g.id = po.group_id
          where po.id = ${kept.postId}`,
    );
    expect(post).toEqual({
      found: 'active',
      check_state: 'not',
      reasons: ['Asks something'],
      kept: true,
      group: roofers.name,
    });
    // One a day: the rest wait for tomorrow, and the day's is kept already.
    expect(await reply([milo])).toEqual({
      postId: null,
      url: null,
      why: GROUP_REPLY_WORDS.keptToday,
    });
    expect((await next()).reply).toBe(false);
    // Nobody went in Contacts.
    const [people] = await rows<{ n: number }>(
      admin(),
      sql`select count(person_id)::int as n from addon_outreach.profiles where workspace_id = ${ws}`,
    );
    expect(people!.n).toBe(0);
  });

  it('says why when none of them can be kept, and takes a few at a time', async () => {
    await keptYesterday();
    const mine = asked('pat.owner.1', 'Pat Owner', 'Who has a truck I can borrow Saturday?');
    const forAComment = asked('kate.nguyen.9', 'Kate Nguyen', 'Does anyone use a CRM?');
    expect(await reply([mine, forAComment])).toEqual({
      postId: null,
      url: null,
      why: GROUP_REPLY_WORDS.noneKept,
    });
    const many = Array.from({ length: REPLY_TRIES + 1 }, (_, i) =>
      asked(`many.people.${i}`, `Person ${i}`, `Question ${i}?`),
    );
    expect(await refused(reply(many))).toBe('validation');
    // Back to today's, for Today below.
    await admin().execute(
      sql`update addon_outreach.posts set reply_at = reply_at + interval '1 day'
          where workspace_id = ${ws} and user_id = ${owner.id} and reply_at is not null`,
    );
  });

  it('puts the day’s question on Today for a build that posts the reply', async () => {
    await computerOn(owner, ws, '0.105.0');
    const before = await runAs(owner, ws, 'outreach.today', {});
    expect(before.messages).not.toContain('group_reply');
    expect(await replies()).toEqual([]);
    await computerOn(owner, ws, GROUP_REPLIES_SINCE);
    const today = await runAs(owner, ws, 'outreach.today', {});
    expect(today.messages).toContain('group_reply');
    expect(await replies()).toEqual([
      expect.objectContaining({
        name: 'Dana Reyes',
        why: [GROUP_REPLY_WORDS.asked(roofers.name)],
        send: null,
      }),
    ]);
    // A teammate never sees it.
    expect(await replies(riley)).toEqual([]);
  });

  it('waits for the person’s OK at first, then goes under the post', async () => {
    const [item] = await replies();
    const dana = await profileOf('dana.reyes.31');
    const kate = await profileOf('kate.nguyen.9');
    // A reply needs its post, kept for the day's reply, of theirs.
    expect(await refused(queue(dana, null, 'See you there!'))).toBe('validation');
    expect(await refused(queue(kate, item!.postId, 'See you there!'))).toBe(
      'outreach_group_reply_post',
    );
    // An older build would send it as a message.
    await computerOn(owner, ws, '0.105.0');
    expect(await refused(queue(dana, item!.postId, 'See you there!'))).toBe(
      'outreach_group_reply_build',
    );
    await computerOn(owner, ws, GROUP_REPLIES_SINCE);
    const queued = await queue(dana, item!.postId, 'I’ll be there! First time going.');
    expect(queued).toMatchObject({ kind: 'group_reply', state: 'waiting', postId: item!.postId });
    expect((await replies())[0]!.send).toMatchObject({ sendId: queued.sendId, state: 'waiting' });
    // In Waiting for you among the messages, under Facebook's hold.
    const waiting = await runAs(owner, ws, 'outreach.waiting', {});
    expect(waiting.kinds.message.count).toBe(1);
    expect(waiting.commentHolds).toContain('facebook');
    const ok = await runAs(owner, ws, 'outreach.send.approve', {
      sends: [{ sendId: queued.sendId }],
    });
    expect(ok.approved).toEqual([queued.sendId]);
    // The extension posts it and notes the comment: done, and off Today.
    await runAs(owner, ws, 'outreach.touch.save', {
      kind: 'comment',
      profile: fb('dana.reyes.31'),
      name: 'Dana Reyes',
      postUrl: await postUrlOf(item!.postId!),
      auto: true,
    });
    expect(
      await runAs(owner, ws, 'outreach.send.done', { sendId: queued.sendId, sent: true }),
    ).toEqual({ sendId: queued.sendId, state: 'sent' });
    expect(await replies()).toEqual([]);
  });

  it('puts the post aside when its reply is skipped', async () => {
    await keptYesterday();
    const milo = asked('milo.park.2', 'Milo Park', 'What time does the farmers market open?');
    const kept = await reply([milo]);
    expect(kept.url).toBe(milo.url);
    const queued = await queue(await profileOf('milo.park.2'), kept.postId, 'Eight, I think!');
    await runAs(owner, ws, 'outreach.send.skip', { sendId: queued.sendId });
    const [post] = await rows<{ skipped: boolean }>(
      admin(),
      sql`select skipped_at is not null as skipped from addon_outreach.posts where id = ${kept.postId}`,
    );
    expect(post!.skipped).toBe(true);
    expect(await replies()).toEqual([]);
  });

  async function postUrlOf(postId: string): Promise<string> {
    const [post] = await rows<{ url: string }>(
      admin(),
      sql`select url from addon_outreach.posts where id = ${postId}`,
    );
    return post!.url;
  }
});
