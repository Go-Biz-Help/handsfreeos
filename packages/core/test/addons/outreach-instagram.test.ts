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
  fitsComment,
  fitsRequests,
  REQUESTS_TASK,
  REQUESTS_WHY,
  todayDraftPrompt,
  todayDraftSystem,
  type TodayItem,
} from '../../src/addons/outreach/today';
import { checkedAs, computerOn, outreachBusiness, runAs, runAsSystem } from './outreach-fixture';

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
      // Who followed back, from the accounts they followed: its own count, beside the 20 profiles checked a day.
      followBackLooksPerDay: 30,
      checksPerDay: 20,
    });
    for (const p of ['facebook', 'linkedin', 'alignable'] as const)
      expect([
        NETWORKS[p].requestsMessageAfterDays,
        NETWORKS[p].requestsMessagesPerDay,
        NETWORKS[p].followBackLooksPerDay,
      ]).toEqual([null, null, null]);
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
    // Comments go through Waiting for you, each waiting for an OK at first (decision 92).
    expect(sendingModesOn('instagram').everything).toBe(
      'Everything on its own, messages too. Each comment waits for your OK until you’ve OK’d 25 and a week has gone by.',
    );
    expect(ticksShownOn('instagram')).toEqual(['warmUp', 'collect']);
    expect(ticksOn('instagram').warmUp[0]).toBe(
      'Like one or two of their posts a day before following them',
    );
    expect(ticksOn('instagram').collect[1]).toContain(
      'It looks at the accounts you followed to see who followed you back',
    );
    // Before its first day: the newest followers, then who to unfollow worked out for the person to tick, then one
    // check.
    expect(listsWaitWords(NO_LISTS, true, 'instagram')).toBe(
      'It’s saving your newest followers first, the first time only. Your day starts once they’re saved.',
    );
    expect(preDaySteps(NO_LISTS, {}, 'instagram').map((s) => s.label)).toEqual([
      'Save your newest followers',
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

  it('writes a comment that waits to be posted short, as a peer in the owner’s own field, with no link or hashtag (decisions 92, 141 and 143)', () => {
    const comment = (platform: Platform) =>
      todayDraftPrompt({
        kind: 'comment',
        business: 'Bright Books',
        name: 'sage.plumbing',
        facts: [],
        recent: [],
        playbook: { name: 'CRM demos', ...PLAYBOOK_TEMPLATES.crm_demos.details },
        post: { text: 'What do small crews use to keep track of calls?', group: null },
        platform,
      });
    // As a peer who knows the owner's own field (decisions 141 and 143): a useful point, what the business does in a
    // few words only when asked, and never a link where a comment waits to be posted.
    expect(comment('instagram')).toContain(
      'They posted this on Instagram. Write the owner’s public comment under it, from the owner’s own field:',
    );
    expect(comment('instagram')).toContain(
      'with no pitch beyond that and no link or web address. When the owner’s field has nothing real to add',
    );
    expect(comment('instagram')).toContain('Never open with praise or thanks');
    expect(comment('instagram')).toContain('Under 30 words.');
    expect(comment('alignable')).toContain('no link or web address');
    expect(comment('alignable')).toContain('Under 50 words.');
    // LinkedIn's wait for an OK at first too, from 0.99.0 (decision 102), with no link.
    expect(comment('linkedin')).toContain(
      'They posted this on LinkedIn. Write the owner’s public comment under it, from the owner’s own field:',
    );
    expect(comment('linkedin')).toContain('no pitch beyond that and no link or web address');
    expect(comment('linkedin')).toContain('Under 50 words.');
    // Facebook's in a group: a link only when they asked for one.
    expect(comment('facebook')).toContain('no hard pitch and no link unless they asked for one');
    expect(todayDraftSystem('instagram')).toContain(
      'A comment on Instagram is under 30 words, with no link, no web address and no hashtags',
    );
    expect(todayDraftSystem('alignable')).toContain(
      'A comment on Alignable reads like a peer who knows the owner’s own field',
    );
    expect(todayDraftSystem('linkedin')).toContain(
      'A comment on LinkedIn reads like a peer who knows the owner’s own field',
    );
    expect(todayDraftSystem('facebook')).not.toContain('A comment on');
    expect(fitsComment('Same here! A shared call list helped our crew.', 'instagram')).toBe(true);
    expect(fitsComment('Love this #plumbing', 'instagram')).toBe(false);
    expect(fitsComment('See bright.com for more', 'instagram')).toBe(false);
    expect(fitsComment('word '.repeat(31), 'instagram')).toBe(false);
    expect(fitsComment('word '.repeat(60), 'alignable')).toBe(true);
    expect(fitsComment('Details at https://bright.com', 'alignable')).toBe(false);
    expect(fitsComment('Details at https://bright.com', 'linkedin')).toBe(false);
    // Elsewhere a draft is as the AI wrote it.
    expect(fitsComment('Details at https://bright.com', 'facebook')).toBe(true);
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
  /** A playbook with hashtags of its own (data version 8), and the networks the AI has written for. */
  const tagged = (
    area: string,
    hashtags: readonly string[],
    wordsWritten: readonly ('instagram' | 'linkedin' | 'alignable')[] = ['instagram'],
  ) => ({
    details: {
      ...playbook(area, ['roofing']).details,
      hashtags: [...hashtags],
      wordsWritten: [...wordsWritten],
    },
  });

  it('makes local hashtags from the area and the words for groups, 5 a day in turn', () => {
    const looks = (day: number) =>
      postLooks(
        [playbook('Austin and Round Rock, TX', ['plumbing', 'drain cleaning', 'water heaters'])],
        'instagram',
        day,
      );
    expect(looks(0)).toEqual({
      tags: [
        'austinplumbing',
        'austindraincleaning',
        'austinwaterheaters',
        'roundrockplumbing',
        'roundrockdraincleaning',
      ],
      places: ['Austin', 'Round Rock'],
    });
    // The next day goes on round them.
    expect(looks(1).tags).toEqual([
      'roundrockwaterheaters',
      'austinplumbing',
      'austindraincleaning',
      'austinwaterheaters',
      'roundrockplumbing',
    ]);
    expect(TAG_LOOKS_PER_DAY).toBe(5);
  });

  it('looks at the playbooks’ own hashtags first, 5 a day in turn (decision 92)', () => {
    const own = tagged('Austin', [
      'austinroofing',
      'roofrepair',
      'atxhomeowners',
      'stormdamage',
      'newroof',
      'roofleak',
      'homerepairtips',
    ]);
    expect(postLooks([own], 'instagram', 0)).toEqual({
      tags: ['austinroofing', 'roofrepair', 'atxhomeowners', 'stormdamage', 'newroof'],
      places: ['Austin'],
    });
    expect(postLooks([own], 'instagram', 1).tags).toEqual([
      'roofleak',
      'homerepairtips',
      'austinroofing',
      'roofrepair',
      'atxhomeowners',
    ]);
    // A playbook the AI hasn't written for yet adds its made-up ones after them.
    expect(
      postLooks(
        [tagged('Austin', ['austinroofing']), playbook('Denver', ['plumbing'])],
        'instagram',
        0,
      ),
    ).toEqual({ tags: ['austinroofing', 'denverplumbing'], places: ['Austin', 'Denver'] });
    // Hashtags the person wrote before the AI did are the playbook's own all the same.
    expect(postLooks([tagged('Austin', ['roofrepair'], [])], 'instagram', 0).tags).toEqual([
      'roofrepair',
    ]);
  });

  it('makes them up only while the AI hasn’t written Instagram’s, and an emptied list gives none', () => {
    // Emptied by the person once the AI wrote them: that playbook looks at nothing on Instagram, not even its places.
    expect(postLooks([tagged('Austin', [])], 'instagram', 0)).toEqual({ tags: [], places: [] });
    expect(
      postLooks([tagged('Austin', []), playbook('Denver', ['plumbing'])], 'instagram', 0),
    ).toEqual({ tags: ['denverplumbing'], places: ['Denver'] });
    // Written for LinkedIn alone: Instagram still makes its own up.
    expect(postLooks([tagged('Austin', [], ['linkedin'])], 'instagram', 0).tags).toEqual([
      'austinroofing',
    ]);
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

  it('likes a post of each author a hashtag’s look found, then follows them a day after, for a computer before 0.95.0', async () => {
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

/**
 * Instagram's people found by topic (decision 92): for a computer on 0.95.0 or later, a good post's writer and who
 * commented on it reach Today only after the AI's check of them from their own page. The writer's like goes on the
 * post the hashtag's look found; a commenter's on their comment on it (decision 116); the follow comes a day after.
 */
describe('Instagram’s people found by topic (decision 92)', () => {
  let owner: TestUser;
  let ws: string;
  let playbookId: string;

  beforeAll(async () => {
    owner = await createTestUser('outig-found', { fullName: 'Morgan Owner' });
    ws = await outreachBusiness(owner, 'Outreach Instagram Found Co');
    const details = PLAYBOOK_TEMPLATES.crm_demos.details;
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: 'CRM demos',
      template: 'crm_demos',
      details: {
        ...details,
        platforms: ['instagram'],
        area: 'Austin, TX',
        hashtags: ['austinplumbing'],
      },
    });
    const [playbook] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_outreach.playbooks where workspace_id = ${ws} and name = 'CRM demos'`,
    );
    playbookId = playbook!.id;
    await computerOn(owner, ws, '0.95.0');
  }, 60_000);

  afterAll(closeTestDbs);

  const POST = `${IG}/p/DQfound0001/`;
  const account = (username: string) => ({ id: null, username, url: `${IG}/${username}/` });
  const profileOf = async (username: string) =>
    (
      await rows<{ id: string }>(
        admin(),
        sql`select id from addon_outreach.profiles
            where workspace_id = ${ws} and platform = 'instagram' and username = ${username}`,
      )
    )[0]!.id;
  const listed = async () =>
    ((await runAs(owner, ws, 'outreach.today', { platform: 'instagram' })).items as TodayItem[])
      .filter((i) => i.kind === 'warm_up' || i.kind === 'friend_request')
      .map((i) => ({
        name: i.name,
        kind: i.kind,
        why: i.why,
        postUrl: i.postUrl,
        post: i.post,
        likeComment: i.likeComment,
      }));

  it('likes the writer’s found post and a commenter’s comment on it once the AI checked them good, then follows', async () => {
    await runAs(owner, ws, 'outreach.posts.save', {
      platform: 'instagram',
      found: 'search',
      words: 'austinplumbing',
      posts: [
        {
          url: POST,
          author: account('sage.plumbing'),
          name: 'sage.plumbing',
          text: 'Three of us run a plumbing crew around Austin and the calls get lost. What do other small crews use to keep track?',
        },
      ],
    });
    const [post] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_outreach.posts where workspace_id = ${ws} and url = ${POST}`,
    );
    // The AI said the post was worth a comment: its writer is found.
    await rows(
      admin(),
      sql`update addon_outreach.posts set check_state = 'waiting' where id = ${post!.id}`,
    );
    await runAsSystem(ws, 'outreach.post.check', {
      postId: post!.id,
      check: { good: true, strong: false, why: 'Asking how to keep track of calls' },
    });
    await runAs(owner, ws, 'outreach.finds.save', {
      platform: 'instagram',
      how: 'commented',
      postId: post!.id,
      people: [{ profile: account('tate.drains'), name: 'tate.drains' }],
    });
    // Nobody before the AI's check of them.
    expect(await listed()).toEqual([]);

    await checkedAs(owner, ws, await profileOf('sage.plumbing'), {
      fit: 'good',
      why: ['Runs a three-person plumbing crew'],
      playbookId,
    });
    await checkedAs(owner, ws, await profileOf('tate.drains'), {
      fit: 'good',
      why: ['Owns a drain cleaning business in Austin'],
      playbookId,
    });
    expect(await listed()).toEqual([
      {
        name: 'sage.plumbing',
        kind: 'warm_up',
        why: [
          'Wrote a post under #austinplumbing',
          'Runs a three-person plumbing crew',
          'Like the post it found: their follow comes a day after',
        ],
        postUrl: POST,
        post: expect.stringMatching(/^Three of us run a plumbing crew/),
      },
      {
        name: 'tate.drains',
        kind: 'warm_up',
        why: [
          'Commented on a post under #austinplumbing',
          'Owns a drain cleaning business in Austin',
          'Like their comment on the post it found: their follow comes a day after',
        ],
        postUrl: POST,
        post: expect.stringMatching(/^Three of us run a plumbing crew/),
        likeComment: true,
      },
    ]);

    // The writer's like was yesterday: the follow comes.
    await rows(
      admin(),
      sql`insert into addon_outreach.touches (workspace_id, profile_id, user_id, kind, at)
          values (${ws}, ${await profileOf('sage.plumbing')}, ${owner.id}, 'like', now() - interval '21 hours')`,
    );
    // Today lists likes before requests (TODAY_KINDS).
    expect((await listed()).map((i) => [i.name, i.kind, i.why.at(-1)])).toEqual([
      [
        'tate.drains',
        'warm_up',
        'Like their comment on the post it found: their follow comes a day after',
      ],
      ['sage.plumbing', 'friend_request', 'You liked the post it found'],
    ]);
    // And the commenter's, liked yesterday on their comment: their follow comes, saying so.
    await rows(
      admin(),
      sql`insert into addon_outreach.touches (workspace_id, profile_id, user_id, kind, at)
          values (${ws}, ${await profileOf('tate.drains')}, ${owner.id}, 'like', now() - interval '21 hours')`,
    );
    expect((await listed()).map((i) => [i.name, i.kind, i.why.at(-1), i.likeComment])).toEqual([
      ['sage.plumbing', 'friend_request', 'You liked the post it found', undefined],
      ['tate.drains', 'friend_request', 'You liked their comment on the post it found', undefined],
    ]);
  });
});

/**
 * The owner's design of 21 Oct 2026: Save my followers reads only the newest (300 the first time, then those new since
 * the last save), and who followed back is seen on their own account instead, so the first message, the one to their
 * Requests and the unfollow list never wait on the whole list of followers.
 */
describe('Instagram’s newest followers, and follow-backs from their own accounts (21 Oct 2026)', () => {
  let owner: TestUser;
  let ws: string;

  beforeAll(async () => {
    owner = await createTestUser('outig-backs', { fullName: 'Robin Owner' });
    ws = await outreachBusiness(owner, 'Outreach Follow Backs Co');
    const details = PLAYBOOK_TEMPLATES.crm_demos.details;
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: 'CRM demos',
      template: 'crm_demos',
      details: {
        ...details,
        platforms: ['instagram'],
        link: 'https://cal.com/robin/demo',
        pace: { ...details.pace, messageAfterDays: 0 },
      },
    });
  }, 60_000);

  afterAll(closeTestDbs);

  const account = (username: string) => ({ id: null, username, url: `${IG}/${username}/` });
  const follow = (username: string, name: string, at: Date) =>
    runAs(
      owner,
      ws,
      'outreach.touch.save',
      { platform: 'instagram', kind: 'friend_request', profile: account(username), name },
      at,
    );
  /** A list the extension saved: its newest followers (`friends`), or a look that saw a follow waiting (`sent`). */
  const saved = (list: 'friends' | 'sent', people: readonly (readonly [string, string])[]) =>
    runAs(owner, ws, 'outreach.friends.save', {
      platform: 'instagram',
      list,
      people: people.map(([username, name]) => ({
        name,
        profile: account(username),
        mutualFriends: null,
      })),
    });
  const states = async () =>
    Object.fromEntries(
      (
        await rows<{ username: string; state: string; since: Date }>(
          admin(),
          sql`select p.username, f.state, f.since from addon_outreach.friends f
              join addon_outreach.profiles p on p.id = f.profile_id
              where f.workspace_id = ${ws} and f.user_id = ${owner.id}`,
        )
      ).map((f) => [f.username, [f.state, new Date(f.since).toISOString()]]),
    );
  const next = async (input: Record<string, unknown> = {}) => {
    const got = (await runAs(owner, ws, 'outreach.follow_backs.next', input)) as {
      people: { name: string; username: string | null; followedAt: string }[];
      perDay: number;
    };
    return { names: got.people.map((p) => p.name), perDay: got.perDay, people: got.people };
  };
  const today = async (names: readonly string[]) =>
    ((await runAs(owner, ws, 'outreach.today', { platform: 'instagram' })).items as TodayItem[])
      .filter((i) => names.includes(i.name))
      .map((i) => [i.name, i.kind, i.requests, i.why[0]]);
  const unfollowList = async () =>
    (
      (await runAs(owner, ws, 'outreach.friends.tidy', { platform: 'instagram' })).cancel as {
        name: string;
      }[]
    ).map((c) => c.name);

  it('saves part of the followers without marking anyone it didn’t read as gone', async () => {
    await saved('friends', [
      ['ana.old', 'Ana Old'],
      ['ben.old', 'Ben Old'],
    ]);
    await follow('cara.waits', 'Cara Waits', ago(2));
    const before = await states();
    // Later: only the newest, Dee, is read and saved.
    expect(await saved('friends', [['dee.new', 'Dee New']])).toMatchObject({
      saved: 1,
      added: 1,
    });
    const after = await states();
    // Those it didn't read are as they were: followers still, and a follow still waiting since it went.
    expect(after['ana.old']).toEqual(before['ana.old']);
    expect(after['ben.old']).toEqual(before['ben.old']);
    expect(after['cara.waits']).toEqual(before['cara.waits']);
    expect(after['dee.new']![0]).toBe('friends');
    const counts = (await runAs(owner, ws, 'outreach.friends', { platform: 'instagram' })).counts;
    expect(counts).toMatchObject({ friends: 3, sent: 1 });
  });

  it('lists those followed a day ago or more who haven’t followed back, the longest since a look first', async () => {
    await follow('eve.five', 'Eve Five', ago(5));
    await follow('fay.half', 'Fay Half', new Date(Date.now() - DAY / 2));
    // Cara (2 days ago) and Eve (5) wait; Fay was followed today, so she's left a day.
    expect(await next()).toMatchObject({ names: ['Eve Five', 'Cara Waits'], perDay: 30 });
    expect((await next({ most: 1 })).names).toEqual(['Eve Five']);
    const [eve] = (await next()).people;
    expect(eve).toMatchObject({ username: 'eve.five' });
    expect(new Date(eve!.followedAt).getTime()).toBeLessThan(Date.now() - 4 * DAY);
  });

  it('notes a look that saw them still waiting, keeping when they were followed, and leaves them a day', async () => {
    const before = await states();
    expect(await saved('sent', [['eve.five', 'Eve Five']])).toMatchObject({
      saved: 1,
      added: 0,
      changed: 0,
    });
    // Still followed 5 days ago: her Requests message and the unfollow list's wait go by that.
    expect((await states())['eve.five']).toEqual(before['eve.five']);
    expect((await next()).names).toEqual(['Cara Waits']);
    expect(await today(['Eve Five'])).toEqual([
      ['Eve Five', 'opener', true, 'You followed them 5 days ago, and they haven’t followed back'],
    ]);
  });

  it('takes a follow-back seen on their account as accepting: the first message comes, and nobody unfollows them', async () => {
    await follow('gus.old', 'Gus Old', ago(25));
    await follow('hal.old', 'Hal Old', ago(25));
    expect(await unfollowList()).toEqual(['Gus Old', 'Hal Old']);
    // Gus's account says he follows them, with no list of followers saved.
    expect(await saved('friends', [['gus.old', 'Gus Old']])).toMatchObject({ changed: 1 });
    expect(await unfollowList()).toEqual(['Hal Old']);
    expect(await today(['Gus Old'])).toEqual([
      ['Gus Old', 'opener', false, 'Followed you back today'],
    ]);
    expect((await next()).names).not.toContain('Gus Old');
    // Hal no longer followed when his account was looked at: ended already, not counted, and off both lists.
    expect(
      await runAs(owner, ws, 'outreach.friend.end', {
        platform: 'instagram',
        kind: 'cancel_request',
        profile: account('hal.old'),
        name: 'Hal Old',
        already: true,
      }),
    ).toMatchObject({ counted: false });
    expect(await unfollowList()).toEqual([]);
    expect((await next()).names).not.toContain('Hal Old');
  });

  it('looks at half as many for a week after an Instagram warning, and at nobody off a follow network', async () => {
    expect(await next({ platform: 'facebook' })).toMatchObject({ names: [], perDay: 0 });
    await runAs(owner, ws, 'outreach.warning.note', {
      platform: 'instagram',
      words: ['Try again later'],
    });
    expect((await next()).perDay).toBe(15);
  });
});
