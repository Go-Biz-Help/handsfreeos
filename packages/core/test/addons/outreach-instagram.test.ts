/**
 * Social Outreach on Instagram (the Instagram and Alignable plan's part 12, and its "The steps"): a follow network.
 * Someone the person followed who's among their saved followers has followed back, which counts as accepting, and
 * their first message comes as on the other networks. Someone who hasn't followed back in 3 days gets one short message
 * marked as going to their Requests (no link, no video, one text), at most 5 of the day's 10 first messages, and no
 * follow-up goes in a chat they haven't answered or accepted. Tidying unfollows those who didn't follow back in the
 * business's wait, never anyone who wrote back or a customer.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { askNameOn } from '../../src/addons/outreach/asks';
import { NETWORKS } from '../../src/addons/outreach/networks';
import { todayKindsOn, tidyWordsOn } from '../../src/addons/outreach/network-words';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
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
