/**
 * Warming people up while they decide on the person's request (decision 161, ../../src/addons/outreach/keep-warm.ts):
 * a visit every other day that likes 2 or 3 of their newest posts, one comment a visit on the first it liked, and once
 * the business's wait ends with no answer, the request withdrawn (the follow undone) on its own, after which the tool
 * leaves them alone, "Didn't follow back" in People, till they follow back or the person puts them back in play.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KEEP_WARM_SINCE,
  keepWarmOn,
  noAnswerWhy,
  VISIT_LIKES,
  visitLine,
  visitPicks,
  visitWhy,
  warmPostWhy,
  warmUpEnds,
} from '../../src/addons/outreach/keep-warm';
import { endedWarmUp } from '../../src/addons/outreach/ops/keep-warm';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { CANCEL_AFTER_WEEKS } from '../../src/addons/outreach/tidy';
import {
  todayDraftPrompt,
  todayDraftSystem,
  WARM_COMMENT_TASK,
  type TodayItem,
} from '../../src/addons/outreach/today';
import { computerOn, outreachBusiness, runAs } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const IG = 'https://www.instagram.com';
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

describe('a visit, in words and picks', () => {
  it('likes the newest posts nothing rules out and that aren’t liked yet, up to the visit’s likes', () => {
    const sad = (post: { readonly text: string }) => /passed away/i.test(post.text);
    const posts = [
      { text: 'Our new van is here!' },
      { text: 'Grandpa passed away last night' },
      { text: 'Ten years in business today', liked: true },
      { text: 'Finished a kitchen remodel' },
      { text: 'Hiring a helper' },
      { text: 'Fall special on gutters' },
    ];
    expect(visitPicks(posts, 3, sad)).toEqual([0, 3, 4]);
    expect(visitPicks(posts, 2, sad)).toEqual([0, 3]);
    expect(
      visitPicks([{ text: 'Grandpa passed away' }, { text: 'Hi', liked: true }], 3, sad),
    ).toEqual([]);
    expect(VISIT_LIKES).toEqual({ least: 2, most: 3 });
  });

  it('waits two weeks from the request, or from when warm-ups began for one already waiting', () => {
    const since = '2026-11-01T12:00:00.000Z';
    expect(warmUpEnds(since, null, 2).toISOString()).toBe('2026-11-15T12:00:00.000Z');
    // Waiting when warm-ups began: a fresh two weeks from then (the owner's 6b).
    expect(warmUpEnds(since, '2026-11-12T06:00:00.000Z', 2).toISOString()).toBe(
      '2026-11-26T06:00:00.000Z',
    );
    // A new request after one withdrawn waits from when it went.
    expect(
      warmUpEnds('2026-12-01T00:00:00.000Z', '2026-11-12T06:00:00.000Z', 2).toISOString(),
    ).toBe('2026-12-15T00:00:00.000Z');
    expect(endedWarmUp(since, null, 2, new Date('2026-11-15T12:00:00.000Z'))).toBe(true);
    expect(
      endedWarmUp(since, '2026-11-12T06:00:00.000Z', 2, new Date('2026-11-20T00:00:00.000Z')),
    ).toBe(false);
    expect(CANCEL_AFTER_WEEKS).toBe(2);
  });

  it('says why in each network’s words', () => {
    expect(noAnswerWhy('instagram')).toBe('Didn’t follow back');
    expect(noAnswerWhy('facebook')).toBe('Didn’t accept your friend request');
    expect(visitWhy('instagram', '2026-11-26T06:00:00.000Z')).toEqual([
      'Waiting for them to follow you back',
      'Like 2 or 3 of their newest posts, every other day till Nov 26',
    ]);
    expect(visitWhy('facebook', '2026-11-26T06:00:00.000Z')[0]).toBe(
      'Waiting for them to accept your friend request',
    );
    expect(warmPostWhy('instagram')).toBe('Their post, while they decide on following you back');
    expect(visitLine('Sam Lee', 'instagram', 3)).toBe(
      'Liked 3 posts of Sam Lee’s while they decide on following you back',
    );
    expect(visitLine('Sam Lee', 'facebook', 1)).toBe(
      'Liked a post of Sam Lee’s while they decide on your friend request',
    );
    expect(visitLine('Sam Lee', 'instagram', 0)).toBe(
      'No new post of Sam Lee’s to like on this visit: the next is in 2 days',
    );
  });

  it('writes a visit’s comment as a person would, about their post alone, never in the owner’s words before', () => {
    const playbook = {
      name: 'CRM demos',
      ...PLAYBOOK_TEMPLATES.crm_demos.details,
      link: 'https://cal.com/robin/demo',
    };
    const prompt = todayDraftPrompt({
      kind: 'comment',
      business: 'Bright Books',
      name: 'Sam Lee',
      facts: [],
      recent: [],
      playbook,
      post: {
        text: 'We just opened our second shop on Main Street!',
        group: null,
        warm: true,
        said: ['Congrats on the new truck!', 'That deck looks amazing'],
      },
      platform: 'instagram',
    });
    expect(prompt).toContain(WARM_COMMENT_TASK);
    expect(prompt).not.toContain('https://cal.com/robin/demo');
    expect(prompt).toContain('<owner_comments>');
    expect(prompt).toContain('Congrats on the new truck!');
    // A good post's comment is as before: no warm-up's task, and no owner's comments told.
    const plain = todayDraftPrompt({
      kind: 'comment',
      business: 'Bright Books',
      name: 'Sam Lee',
      facts: [],
      recent: [],
      playbook,
      post: { text: 'We just opened our second shop on Main Street!', group: null },
      platform: 'instagram',
    });
    expect(plain).not.toContain(WARM_COMMENT_TASK);
    expect(plain).not.toContain('<owner_comments>');
    expect(todayDraftSystem('instagram', { warm: true })).not.toEqual(
      todayDraftSystem('instagram'),
    );
  });

  it('is listed only for a computer on a build that does visits', () => {
    expect(KEEP_WARM_SINCE).toBe('0.135.0');
    expect(keepWarmOn('0.135.0')).toBe(true);
    expect(keepWarmOn('0.134.2')).toBe(false);
    expect(keepWarmOn(null)).toBe(false);
  });
});

describe('warm-ups on Instagram while they decide on following back', () => {
  let owner: TestUser;
  let ws: string;

  beforeAll(async () => {
    owner = await createTestUser('outkw-owner', { fullName: 'Robin Owner' });
    ws = await outreachBusiness(owner, 'Outreach Keep Warm Co');
    const details = PLAYBOOK_TEMPLATES.crm_demos.details;
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: 'CRM demos',
      template: 'crm_demos',
      details: {
        ...details,
        platforms: ['facebook', 'instagram'],
        link: 'https://cal.com/robin/demo',
        pace: { ...details.pace, messageAfterDays: 0 },
      },
    });
  }, 60_000);

  afterAll(closeTestDbs);

  const account = (username: string) => ({ id: null, username, url: `${IG}/${username}/` });
  /** A follow the extension noted, at a moment. */
  const follow = (username: string, name: string, at: Date = new Date()) =>
    runAs(
      owner,
      ws,
      'outreach.touch.save',
      { platform: 'instagram', kind: 'friend_request', profile: account(username), name },
      at,
    );
  /** A like the extension made on its own on a post of theirs, at a moment. */
  const like = (username: string, name: string, post: string, at: Date = new Date()) =>
    runAs(
      owner,
      ws,
      'outreach.touch.save',
      {
        platform: 'instagram',
        kind: 'like',
        profile: account(username),
        name,
        postUrl: `${IG}/p/${post}/`,
        postText: `A post called ${post}`,
        auto: true,
      },
      at,
    );
  const visits = async () =>
    ((await runAs(owner, ws, 'outreach.today', { platform: 'instagram' })).items as TodayItem[])
      .filter((i) => i.kind === 'warm_up' && i.keepWarm)
      .map((i) => ({ name: i.name, why: i.why, keepWarm: i.keepWarm }));
  const profileOf = async (username: string) =>
    (
      await rows<{ id: string }>(
        admin(),
        sql`select id from addon_outreach.profiles
            where workspace_id = ${ws} and platform = 'instagram' and username = ${username}`,
      )
    )[0]!.id;
  const sinceOf = async (username: string) =>
    (
      await rows<{ since: Date | string }>(
        admin(),
        sql`select since from addon_outreach.friends
            where workspace_id = ${ws} and profile_id = ${await profileOf(username)}`,
      )
    )[0]!.since;
  const warmPosts = async (username: string) =>
    rows<{ url: string; check_state: string; check_why: string }>(
      admin(),
      sql`select url, check_state, check_why from addon_outreach.posts
          where workspace_id = ${ws} and profile_id = ${await profileOf(username)} and warm_up
          order by url`,
    );

  it('lists a visit every other day for someone waiting on a follow, once the computer does visits', async () => {
    await follow('wait.one', 'Wait One', ago(3));
    // No computer that does visits yet: none listed, as an older build would like one post and follow after it.
    expect(await visits()).toEqual([]);
    await computerOn(owner, ws, '0.134.2');
    expect(await visits()).toEqual([]);
    await computerOn(owner, ws, KEEP_WARM_SINCE);
    const until = warmUpEnds(await sinceOf('wait.one'), null, CANCEL_AFTER_WEEKS);
    expect(await visits()).toEqual([
      {
        name: 'Wait One',
        why: visitWhy('instagram', until),
        keepWarm: { likes: VISIT_LIKES.most, until: until.toISOString() },
      },
    ]);
    // Liked today: the next visit is the day after tomorrow.
    await like('wait.one', 'Wait One', 'today1');
    expect(await visits()).toEqual([]);
  });

  it('visits again two days after the last, and never someone whose wait is over', async () => {
    await follow('wait.two', 'Wait Two', ago(6));
    await like('wait.two', 'Wait Two', 'old1', ago(2));
    await follow('long.gone', 'Long Gone', ago(20));
    expect((await visits()).map((v) => v.name)).toEqual(['Wait Two']);
  });

  it('keeps the first post a visit liked for its one comment, one a visit', async () => {
    expect(await warmPosts('wait.one')).toEqual([
      {
        url: `${IG}/p/today1/`,
        check_state: 'good',
        check_why: warmPostWhy('instagram'),
      },
    ]);
    // The visit's second like keeps no other.
    await like('wait.one', 'Wait One', 'today2');
    expect((await warmPosts('wait.one')).map((p) => p.url)).toEqual([`${IG}/p/today1/`]);
    // Two days before, the last visit's: kept too.
    expect((await warmPosts('wait.two')).map((p) => p.url)).toEqual([`${IG}/p/old1/`]);
    // Past their wait: none kept.
    await like('long.gone', 'Long Gone', 'late1');
    expect(await warmPosts('long.gone')).toEqual([]);
  });

  it('gives everyone already waiting a fresh wait from when warm-ups began', async () => {
    await follow('was.waiting', 'Was Waiting', ago(20));
    await rows(
      admin(),
      sql`update addon_outreach.friends set warm_up_from = now() - interval '1 day'
          where workspace_id = ${ws} and profile_id = ${await profileOf('was.waiting')}`,
    );
    const tidy = await runAs(owner, ws, 'outreach.friends.tidy', { platform: 'instagram' });
    expect(tidy.cancelAfterWeeks).toBe(CANCEL_AFTER_WEEKS);
    expect(tidy.cancel.map((c: { name: string }) => c.name)).toEqual(['Long Gone']);
    expect((await visits()).map((v) => v.name)).toEqual(['Wait Two', 'Was Waiting']);
  });

  it('unfollows on its own after the wait, then leaves them alone as Didn’t follow back till put back in play', async () => {
    expect(
      await runAs(owner, ws, 'outreach.friend.end', {
        platform: 'instagram',
        kind: 'cancel_request',
        profile: account('long.gone'),
        name: 'Long Gone',
        already: false,
      }),
    ).toMatchObject({ counted: true });
    const gone = await profileOf('long.gone');
    expect(
      await rows<{ after_warm_up: boolean }>(
        admin(),
        sql`select after_warm_up from addon_outreach.friend_ends
            where workspace_id = ${ws} and profile_id = ${gone}`,
      ),
    ).toEqual([{ after_warm_up: true }]);
    const row = async () =>
      (
        await runAs(owner, ws, 'outreach.stages', { view: 'lost', platform: 'instagram' })
      ).people.find((p: { profileId: string }) => p.profileId === gone) as
        { stage: string; why: string[] } | undefined;
    expect(await row()).toMatchObject({ stage: 'lost', why: ['Didn’t follow back'] });
    // Back in play: in play again.
    expect(
      await runAs(owner, ws, 'outreach.stage.mark', { profileId: gone, mark: 'open' }),
    ).not.toMatchObject({ stage: 'lost' });
    expect(await row()).toBeUndefined();
  });

  it('marks no warm-up ended for a request Cancel all withdrew sooner', async () => {
    await follow('too.soon', 'Too Soon', ago(4));
    await runAs(owner, ws, 'outreach.friend.end', {
      platform: 'instagram',
      kind: 'cancel_request',
      profile: account('too.soon'),
      name: 'Too Soon',
      already: false,
    });
    expect(
      await rows<{ after_warm_up: boolean }>(
        admin(),
        sql`select after_warm_up from addon_outreach.friend_ends
            where workspace_id = ${ws} and profile_id = ${await profileOf('too.soon')}`,
      ),
    ).toEqual([{ after_warm_up: false }]);
  });
});
