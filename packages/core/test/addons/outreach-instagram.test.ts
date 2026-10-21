/**
 * Social Outreach on Instagram (the Instagram and Alignable plan’s parts 12, 14 and 15, and its "The steps"): a follow network.
 * Someone the person followed who's among their saved followers has followed back, which counts as accepting, and
 * their first message comes as on the other networks. Someone who hasn't followed back in 3 days gets one short message
 * marked as going to their Requests (no link, no video, one text), at most 5 of the day's 10 first messages, and no
 * follow-up goes in a chat they haven't answered or accepted. Tidying unfollows those who didn't follow back in the
 * business's wait, never anyone who wrote back or a customer. Its growing (part 15): hashtags made from the area and the
 * playbook's words, posts found there whose authors get a like and then a follow, and whoever followed the person
 * followed back at once.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { askNameOn } from '../../src/addons/outreach/asks';
import { autoKinds, AUTOMATION_DEFAULTS } from '../../src/addons/outreach/automation';
import {
  afterFirstSave,
  listsWaitWords,
  NO_LISTS,
  preDaySteps,
} from '../../src/addons/outreach/lists';
import { NETWORKS, runsOnItsOwn, type Platform } from '../../src/addons/outreach/networks';
import {
  sendingModesOn,
  ticksOn,
  ticksShownOn,
  todayKindsOn,
  tidyWordsOn,
} from '../../src/addons/outreach/network-words';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { hashtagOf, postLooks, TAG_LOOKS_PER_DAY } from '../../src/addons/outreach/posts';
import {
  fitsRequests,
  REQUESTS_TASK,
  REQUESTS_WHY,
  todayDraftPrompt,
  type TodayItem,
} from '../../src/addons/outreach/today';
import { outreachBusiness, runAs } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const IG = 'https://www.instagram.com';
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

describe('Instagram’s kit and words', () => {
  it('sends one message to Requests after 3 days, at most 5 a day, and only on Instagram', () => {
    expect(NETWORKS.instagram).toMatchObject({
      stage: 'working',
      requestsMessageAfterDays: 3,
      requestsMessagesPerDay: 5,
      tidyLimits: { cancel_request: 20, unfriend: 0 },
    });
    for (const p of ['facebook', 'linkedin', 'alignable'] as const)
      expect([NETWORKS[p].requestsMessageAfterDays, NETWORKS[p].requestsMessagesPerDay]).toEqual([
        null,
        null,
      ]);
  });

  it('says Follow them, Save my followers and Unfollow on Instagram', () => {
    expect(todayKindsOn('instagram').friend_request).toBe('Follow them');
    expect(todayKindsOn('linkedin').friend_request).toBe('Send an invitation to connect');
    expect(askNameOn('friends', 'instagram')).toBe('Save my followers');
    expect(askNameOn('cancel', 'instagram')).toBe('Unfollow the ones you ticked');
    const tidy = tidyWordsOn('instagram');
    expect(tidy.kinds).toEqual(['cancel']);
    expect(tidy.cancel).toMatchObject({
      title: 'Not following you back',
      button: 'Unfollow the ticked',
      done: 'unfollowed',
      since: 'followed',
    });
    expect(tidy.cancel.about(3)).toMatch(
      /^Followed more than 3 weeks ago and not following you back\. Never anyone who wrote back, a customer/,
    );
    expect(tidy.about).toContain('in an Instagram tab you can see');
    // Facebook's are as they were.
    expect(tidyWordsOn('facebook').cancel.about(3)).toBe(
      'Sent more than 3 weeks ago and not answered. Facebook pauses your requests when too many wait.',
    );
  });

  it('likes and follows on its own once let, comments staying the person’s, its followers saved first (part 14)', () => {
    expect(runsOnItsOwn('instagram')).toBe(true);
    expect(NETWORKS.instagram.runs).toEqual({
      auto: ['warm_up', 'friend_request'],
      ticks: ['warmUp', 'collect'],
    });
    expect(
      autoKinds(
        { ...AUTOMATION_DEFAULTS.networks.instagram, on: true, sending: 'steps' },
        'instagram',
      ),
    ).toEqual(['warm_up', 'friend_request']);
    expect(sendingModesOn('instagram').everything).toBe(
      'Everything on its own, messages too; you post each comment',
    );
    expect(ticksShownOn('instagram')).toEqual(['warmUp', 'collect']);
    expect(ticksOn('instagram').warmUp[0]).toBe(
      'Like one or two of their posts a day before following them',
    );
    // Before its first day: the followers, then who to unfollow worked out for the person to tick, then one check.
    expect(listsWaitWords(NO_LISTS, true, 'instagram')).toBe(
      'It’s saving your followers first, the first time only. Your day starts once they’re saved.',
    );
    expect(preDaySteps(NO_LISTS, {}, 'instagram').map((s) => s.label)).toEqual([
      'Save your followers',
      'Work out who to unfollow',
      'Check your followers for good fits',
    ]);
    const followers = { ...NO_LISTS, friendsAt: new Date().toISOString() };
    expect(afterFirstSave(followers, 'instagram')).toBe('tidy');
    expect(afterFirstSave({ ...followers, tidyAt: followers.friendsAt }, 'instagram')).toBe(
      'checks',
    );
  });

  it('writes a message to their Requests as one short text, with no link or video', () => {
    const prompt = todayDraftPrompt({
      kind: 'opener',
      business: 'Bright Books',
      name: 'Sam Lee',
      facts: [],
      recent: [],
      playbook: {
        name: 'CRM demos',
        ...PLAYBOOK_TEMPLATES.crm_demos.details,
        link: 'https://cal.com/bright/demo',
      },
      platform: 'instagram',
      requests: true,
    });
    expect(prompt).toContain(REQUESTS_TASK);
    expect(prompt).not.toContain('cal.com');
    expect(prompt).toContain('Write it as one message, with no blank lines.');
    // A first message once they follow back is told so, and carries the link as on any network.
    const back = todayDraftPrompt({
      kind: 'opener',
      business: 'Bright Books',
      name: 'Sam Lee',
      facts: [],
      recent: [],
      playbook: {
        name: 'CRM demos',
        ...PLAYBOOK_TEMPLATES.crm_demos.details,
        link: 'https://cal.com/bright/demo',
      },
      platform: 'instagram',
    });
    expect(back).toContain('They just followed the owner back.');
    expect(back).not.toContain(REQUESTS_TASK);
    expect(back).toContain('cal.com');
    expect(fitsRequests('Hi Sam, are you open to more booked calls?')).toBe(true);
    expect(fitsRequests('Hi Sam, book here: https://cal.com/bright')).toBe(false);
    expect(fitsRequests('Hi Sam, see bright.com')).toBe(false);
    expect(fitsRequests('Hi Sam.\n\nAre you open to it?')).toBe(false);
    expect(fitsRequests('x'.repeat(301))).toBe(false);
  });
});

describe('Today on Instagram', () => {
  let owner: TestUser;
  let ws: string;

  beforeAll(async () => {
    owner = await createTestUser('outig-owner', { fullName: 'Casey Owner' });
    ws = await outreachBusiness(owner, 'Outreach Instagram Co');
    // A playbook in use on Instagram, whose first message goes the day they follow back.
    const details = PLAYBOOK_TEMPLATES.crm_demos.details;
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: 'CRM demos',
      template: 'crm_demos',
      details: {
        ...details,
        platforms: ['facebook', 'instagram'],
        link: 'https://cal.com/casey/demo',
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
  const message = (username: string, name: string, at: Date = new Date()) =>
    runAs(
      owner,
      ws,
      'outreach.touch.save',
      { platform: 'instagram', kind: 'message', profile: account(username), name },
      at,
    );
  /** Their followers, saved from Instagram as its friends list. */
  const followers = (people: readonly (readonly [string, string])[]) =>
    runAs(owner, ws, 'outreach.friends.save', {
      platform: 'instagram',
      list: 'friends',
      people: people.map(([username, name]) => ({
        name,
        profile: account(username),
        mutualFriends: null,
      })),
    });
  const today = async () =>
    ((await runAs(owner, ws, 'outreach.today', { platform: 'instagram' })).items as TodayItem[])
      .filter((i) => i.kind === 'opener' || i.kind === 'follow_up')
      .map((i) => ({
        kind: i.kind,
        name: i.name,
        requests: i.requests,
        why: i.why,
        link: i.demoLink,
      }));
  const profileOf = async (username: string) =>
    (
      await rows<{ id: string }>(
        admin(),
        sql`select id from addon_outreach.profiles
            where workspace_id = ${ws} and platform = 'instagram' and username = ${username}`,
      )
    )[0]!.id;

  it('gives someone followed a first message once they’re among the followers saved', async () => {
    await follow('dana.reyes', 'Dana Reyes', ago(2));
    // Not following back yet, two days on: nothing to send.
    expect((await today()).filter((i) => i.name === 'Dana Reyes')).toEqual([]);
    expect(await followers([['dana.reyes', 'Dana Reyes']])).toMatchObject({ saved: 1, added: 0 });
    const [first] = (await today()).filter((i) => i.name === 'Dana Reyes');
    expect(first).toMatchObject({
      kind: 'opener',
      requests: false,
      why: ['Followed you back today'],
    });
    expect(first!.link).not.toBeNull();
  });

  it('gives someone who hasn’t followed back in 3 days one message to their Requests, never sooner', async () => {
    await follow('sam.lee', 'Sam Lee', ago(4));
    await follow('kim_bakes', 'Kim Bakes', ago(1));
    const listed = (await today()).filter((i) => i.name === 'Sam Lee' || i.name === 'Kim Bakes');
    expect(listed).toEqual([
      {
        kind: 'opener',
        name: 'Sam Lee',
        requests: true,
        why: ['You followed them 4 days ago, and they haven’t followed back', REQUESTS_WHY],
        link: null,
      },
    ]);
  });

  it('sends at most 5 of the day’s first messages to Requests, those sent there today counted', async () => {
    for (const n of [1, 2, 3, 4, 5, 6])
      await follow(`lead.${n}`, `Lead ${n}`, new Date(Date.now() - 4 * DAY - n * 60_000));
    const there = async () => (await today()).filter((i) => i.requests);
    // Sam and six more wait; five go.
    expect(await there()).toHaveLength(5);
    // One sent there today: four more today.
    const first = (await there())[0]!;
    const username = first.name === 'Sam Lee' ? 'sam.lee' : `lead.${first.name.split(' ')[1]}`;
    expect(await message(username, first.name)).toMatchObject({ step: 'first_message' });
    const after = await there();
    expect(after).toHaveLength(4);
    expect(after.map((i) => i.name)).not.toContain(first.name);
  });

  it('follows up only once they’ve followed back or answered, never in their Requests', async () => {
    await follow('ivy.cole', 'Ivy Cole', ago(12));
    await message('ivy.cole', 'Ivy Cole', ago(10));
    const ivy = await profileOf('ivy.cole');
    // Their first message went 10 days ago: its follow-up is due.
    await runAs(owner, ws, 'outreach.conversation.note', { profileId: ivy, kind: 'opener' });
    await rows(
      admin(),
      sql`update addon_outreach.follow_ups
          set step_at = now() - interval '10 days', last_at = now() - interval '10 days',
            due_at = now() - interval '1 day'
          where workspace_id = ${ws} and profile_id = ${ivy}`,
    );
    const ivys = async () => (await today()).filter((i) => i.name === 'Ivy Cole');
    expect(await ivys()).toEqual([]);
    // They followed back: the follow-up comes.
    await followers([
      ['dana.reyes', 'Dana Reyes'],
      ['ivy.cole', 'Ivy Cole'],
    ]);
    expect((await ivys()).map((i) => i.kind)).toEqual(['follow_up']);
  });

  it('lists for unfollowing those who didn’t follow back in 3 weeks, never a customer or someone who wrote back', async () => {
    await follow('old.one', 'Old One', ago(25));
    await follow('old.customer', 'Old Customer', ago(25));
    await follow('old.talker', 'Old Talker', ago(25));
    await follow('new.one', 'New One', ago(5));
    const [person] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.people (workspace_id, first_name, last_name) values (${ws}, 'Old', 'Customer')
          returning id`,
    );
    await rows(
      admin(),
      sql`update addon_outreach.profiles set person_id = ${person!.id}
          where workspace_id = ${ws} and username = 'old.customer'`,
    );
    await rows(
      admin(),
      sql`insert into addon_outreach.replies (workspace_id, user_id, profile_id, after_at, seen_at, pushed)
          values (${ws}, ${owner.id}, ${await profileOf('old.talker')}, now() - interval '3 days',
            now() - interval '3 days', false)`,
    );
    const tidy = await runAs(owner, ws, 'outreach.friends.tidy', { platform: 'instagram' });
    expect(tidy.cancel.map((c: { name: string }) => c.name)).toEqual(['Old One']);
    expect(tidy).toMatchObject({
      cancelAfterWeeks: 3,
      limits: { cancel_request: { done: 0, most: 20 } },
    });
    // Unfollowed by the extension once ticked: off the list, and counted.
    expect(
      await runAs(owner, ws, 'outreach.friend.end', {
        platform: 'instagram',
        kind: 'cancel_request',
        profile: account('old.one'),
        name: 'Old One',
        already: false,
      }),
    ).toMatchObject({ counted: true, doneToday: 1 });
    expect(
      (await runAs(owner, ws, 'outreach.friends.tidy', { platform: 'instagram' })).cancel,
    ).toEqual([]);
  });
});

describe('Instagram’s hashtags and places (part 15)', () => {
  const playbook = (
    area: string,
    groupWords: readonly string[],
    signs: readonly string[] = [],
    platforms: readonly Platform[] = ['instagram'],
  ) => ({ details: { area, groupWords: [...groupWords], signs: [...signs], platforms } });

  it('makes local hashtags from the area and the words for groups, a few a day in turn', () => {
    const looks = (day: number) =>
      postLooks(
        [playbook('Austin and Round Rock, TX', ['plumbing', 'drain cleaning'])],
        'instagram',
        day,
      );
    expect(looks(0)).toEqual({
      tags: ['austinplumbing', 'austindraincleaning', 'roundrockplumbing'],
      places: ['Austin', 'Round Rock'],
    });
    // The next day goes on round them.
    expect(looks(1).tags).toEqual([
      'roundrockdraincleaning',
      'austinplumbing',
      'austindraincleaning',
    ]);
    expect(TAG_LOOKS_PER_DAY).toBe(3);
  });

  it('keeps words that name the area as they are, and the signs’ quoted words when there are no words for groups', () => {
    expect(
      postLooks([playbook('Austin', ['Austin homeowners', 'plumbing'])], 'instagram', 0).tags,
    ).toEqual(['austinhomeowners', 'austinplumbing']);
    expect(
      postLooks([playbook('Denver', [], ['Says “water heater” in a post'])], 'instagram', 0).tags,
    ).toEqual(['denverwaterheater']);
  });

  it('falls back to the words alone with no area, or the places alone with no words', () => {
    expect(postLooks([playbook('', ['plumbing', 'drain cleaning'])], 'instagram', 0)).toEqual({
      tags: ['plumbing', 'draincleaning'],
      places: [],
    });
    expect(postLooks([playbook('Round Rock', [])], 'instagram', 0).tags).toEqual(['roundrock']);
    // A playbook that doesn't run on Instagram has no say there.
    expect(postLooks([playbook('Austin', ['plumbing'], [], ['facebook'])], 'instagram', 0)).toEqual(
      { tags: [], places: [] },
    );
  });

  it('makes a hashtag as people tag one: no spaces, accents or marks, and never too short or all numbers', () => {
    expect(hashtagOf('Café Owners!')).toBe('cafeowners');
    expect(hashtagOf('Round Rock', 'HVAC')).toBe('roundrockhvac');
    expect(hashtagOf('a')).toBeNull();
    expect(hashtagOf('2026')).toBeNull();
  });
});

describe('Instagram’s growing on Today (part 15)', () => {
  let owner: TestUser;
  let ws: string;

  beforeAll(async () => {
    owner = await createTestUser('outig-grow', { fullName: 'Riley Owner' });
    ws = await outreachBusiness(owner, 'Outreach Instagram Growing Co');
    const details = PLAYBOOK_TEMPLATES.crm_demos.details;
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: 'CRM demos',
      template: 'crm_demos',
      details: {
        ...details,
        platforms: ['instagram'],
        area: 'Austin and Round Rock, TX',
        groupWords: ['plumbing'],
      },
    });
  }, 60_000);

  afterAll(closeTestDbs);

  const account = (username: string) => ({ id: null, username, url: `${IG}/${username}/` });
  const listed = async (names: readonly string[]) =>
    ((await runAs(owner, ws, 'outreach.today', { platform: 'instagram' })).items as TodayItem[])
      .filter((i) => names.includes(i.name))
      .map((i) => [i.name, i.kind, i.why]);

  it('gives the day’s hashtags and the area’s places to look at', async () => {
    const looks = await runAs(owner, ws, 'outreach.posts.words', { platform: 'instagram' });
    expect(looks.places).toEqual(['Austin', 'Round Rock']);
    expect([...looks.tags].sort()).toEqual(['austinplumbing', 'roundrockplumbing']);
  });

  it('follows back at once whoever followed them, and likes a post first for whoever liked theirs', async () => {
    const saved = await runAs(owner, ws, 'outreach.engaged.save', {
      platform: 'instagram',
      engaged: [
        { profile: account('nia.fox'), name: 'nia.fox', kind: 'follow' },
        { profile: account('omar.diaz'), name: 'omar.diaz', kind: 'reaction' },
        { profile: account('pat.lin'), name: 'pat.lin', kind: 'follow' },
      ],
    });
    expect(saved).toEqual({ added: 3 });
    // Nia is among the followers saved, which says nothing of following her back. The person followed Pat already.
    await runAs(owner, ws, 'outreach.friends.save', {
      platform: 'instagram',
      list: 'friends',
      people: [{ name: 'nia.fox', profile: account('nia.fox'), mutualFriends: null }],
    });
    await runAs(owner, ws, 'outreach.touch.save', {
      platform: 'instagram',
      kind: 'friend_request',
      profile: account('pat.lin'),
      name: 'pat.lin',
    });
    expect(await listed(['nia.fox', 'omar.diaz', 'pat.lin'])).toEqual([
      [
        'omar.diaz',
        'warm_up',
        [
          'Reacted to your post on Instagram',
          'Like one of theirs back: their follow comes a day after',
        ],
      ],
      ['nia.fox', 'friend_request', ['Followed you on Instagram']],
    ]);
  });

  it('likes a post of each author a hashtag’s look found, then follows them a day after', async () => {
    const saved = await runAs(owner, ws, 'outreach.posts.save', {
      platform: 'instagram',
      found: 'search',
      posts: [
        {
          url: `${IG}/p/DQgrow0001/`,
          author: account('quinn.plumbing'),
          name: 'quinn.plumbing',
          text: 'Busy week of plumbing jobs around Austin. Can anyone recommend a simple CRM for a small crew?',
        },
      ],
    });
    expect(saved.checking).toBe(1);
    // The AI said the post was worth a comment.
    await rows(
      admin(),
      sql`update addon_outreach.posts set check_state = 'good'
          where workspace_id = ${ws} and user_id = ${owner.id}`,
    );
    const quinn = async () =>
      (await listed(['quinn.plumbing'])).map(([, kind, why]) => [kind, (why as string[])[0]]);
    // A like first, for the runner to do; their post's comment stays the person's to write.
    expect(await quinn()).toEqual([
      ['comment', 'On Instagram'],
      ['warm_up', 'Wrote a post your search on Instagram found'],
    ]);
    // Liked yesterday: the follow comes.
    await rows(
      admin(),
      sql`insert into addon_outreach.touches (workspace_id, profile_id, user_id, kind, at)
          select ${ws}, po.profile_id, ${owner.id}, 'like', now() - interval '21 hours'
          from addon_outreach.posts po where po.workspace_id = ${ws} and po.user_id = ${owner.id}`,
    );
    expect(await quinn()).toContainEqual([
      'friend_request',
      'Wrote a post your search on Instagram found',
    ]);
    expect((await quinn()).map(([kind]) => kind)).not.toContain('warm_up');
  });
});
