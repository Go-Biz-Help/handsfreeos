/**
 * The person's own lists, saved before their day (src/addons/outreach/lists.ts, docs/outreach.md "Lists first"). The
 * owner's decision: first day only. The first time, Start my day waits until friends, requests got and sent, and the
 * groups are all saved, and the groups checked; after that, the requests each morning, and the friends list and the
 * groups weekly. While it gets ready, a live checklist shows each step.
 */
import { describe, expect, it } from 'vitest';
import {
  afterFirstSave,
  firstSaveDone,
  FRIENDS_AGAIN_DAYS,
  ListSavedInput,
  listsDue,
  listsWaitWords,
  NO_LISTS,
  PRE_DAY_WORDS,
  preDayCount,
  preDayDone,
  preDaySteps,
  ListsSaved,
} from '../../src/addons/outreach/lists';
import { dayWords, type LiveDay } from '../../src/addons/outreach/live';

const TZ = 'America/Chicago';
/** 10 a.m. on Tuesday, October 13 2026, in Chicago. */
const NOW = Date.parse('2026-10-13T15:00:00Z');
const DAY = 86_400_000;
const at = (ms: number) => new Date(ms).toISOString();
const all = {
  ...NO_LISTS,
  friendsAt: at(NOW),
  requestsAt: at(NOW),
  sentAt: at(NOW),
  groupsAt: at(NOW),
};

describe('the lists due before the day', () => {
  it('the first time, all four, friends first and groups last', () => {
    expect(listsDue(NO_LISTS, NOW, TZ)).toEqual(['friends', 'requests', 'sent', 'groups']);
    expect(firstSaveDone(NO_LISTS)).toBe(false);
    expect(firstSaveDone({ ...all, sentAt: null })).toBe(false);
    expect(firstSaveDone({ ...all, groupsAt: null })).toBe(false);
    expect(firstSaveDone(all)).toBe(true);
  });

  it('the requests again on each business day, by its own clock', () => {
    expect(listsDue(all, NOW, TZ)).toEqual([]);
    // 11 p.m. yesterday in Chicago, though it's already the 13th in UTC.
    const lateYesterday = at(Date.parse('2026-10-13T04:00:00Z'));
    expect(listsDue({ ...all, requestsAt: lateYesterday, sentAt: lateYesterday }, NOW, TZ)).toEqual(
      ['requests', 'sent'],
    );
    // 1 a.m. today in Chicago counts as today.
    const earlyToday = at(Date.parse('2026-10-13T06:00:00Z'));
    expect(listsDue({ ...all, requestsAt: earlyToday }, NOW, TZ)).toEqual([]);
  });

  it('the friends list once its last full save is a week old', () => {
    expect(FRIENDS_AGAIN_DAYS).toBe(7);
    expect(listsDue({ ...all, friendsAt: at(NOW - 7 * DAY + 60_000) }, NOW, TZ)).toEqual([]);
    expect(listsDue({ ...all, friendsAt: at(NOW - 7 * DAY) }, NOW, TZ)).toEqual(['friends']);
  });

  it('the groups, like the friends list, once their last save is a week old', () => {
    expect(listsDue({ ...all, groupsAt: at(NOW - 7 * DAY + 60_000) }, NOW, TZ)).toEqual([]);
    expect(listsDue({ ...all, groupsAt: at(NOW - 7 * DAY) }, NOW, TZ)).toEqual(['groups']);
  });

  it('reads an answer from an API from before the groups as never saved', () => {
    const old = ListsSaved.parse({
      friendsAt: at(NOW),
      requestsAt: at(NOW),
      sentAt: at(NOW),
      tidyAt: null,
      checksAt: null,
    });
    expect(old.groupsAt).toBeNull();
    expect(old.groupChecksAt).toBeNull();
  });

  it('after the first full save, the groups checked, then Tidy up, then the good-fits check, once each', () => {
    expect(afterFirstSave({ ...all, sentAt: null })).toBeNull();
    expect(afterFirstSave({ ...all, groupsAt: null })).toBeNull();
    expect(afterFirstSave(all)).toBe('group_checks');
    const checked = { ...all, groupChecksAt: at(NOW) };
    expect(afterFirstSave(checked)).toBe('tidy');
    expect(afterFirstSave({ ...checked, tidyAt: at(NOW) })).toBe('checks');
    expect(afterFirstSave({ ...checked, tidyAt: at(NOW), checksAt: at(NOW) })).toBeNull();
  });

  it('on Alignable, its connections and requests got first, then one check: nothing sent to save or tidy up', () => {
    expect(listsDue(NO_LISTS, NOW, TZ, 'alignable')).toEqual(['friends', 'requests']);
    const saved = { ...NO_LISTS, friendsAt: at(NOW), requestsAt: at(NOW) };
    expect(firstSaveDone(saved, 'alignable')).toBe(true);
    expect(afterFirstSave(saved, 'alignable')).toBe('checks');
    expect(afterFirstSave({ ...saved, checksAt: at(NOW) }, 'alignable')).toBeNull();
    expect(preDayDone({ ...saved, checksAt: at(NOW) }, 'alignable')).toBe(true);
    expect(preDaySteps(NO_LISTS, {}, 'alignable').map((step) => step.label)).toEqual([
      'Save your connections',
      'Save connection requests you got',
      'Check your connections for good fits',
    ]);
    expect(listsWaitWords(NO_LISTS, true, 'alignable')).toBe(
      'It’s saving your connections and connection requests first, the first time only. Your day starts once they’re saved.',
    );
  });

  it('takes only what it knows to note', () => {
    const ws = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
    expect(ListSavedInput.safeParse({ workspaceId: ws, list: 'sent' }).success).toBe(true);
    expect(ListSavedInput.safeParse({ workspaceId: ws, list: 'groups' }).success).toBe(true);
    expect(ListSavedInput.safeParse({ workspaceId: ws, list: 'group_checks' }).success).toBe(true);
    expect(ListSavedInput.safeParse({ workspaceId: ws, list: 'members' }).success).toBe(false);
  });
});

describe('why a day started waits, under Start my day', () => {
  const started: LiveDay = {
    date: '2026-10-13',
    state: 'started',
    why: null,
    via: 'web',
    at: at(NOW),
  };

  it('the first time, says it saves the lists first and the day starts after', () => {
    expect(dayWords(started, TZ, NO_LISTS)).toBe(
      'Started at 10:00 AM in HandsFreeOS. It’s saving your friends list, friend requests and groups first, the first time only. Your day starts once they’re saved.',
    );
    expect(listsWaitWords({ ...NO_LISTS, friendsAt: at(NOW) }, true)).toBe(
      'It’s saving the friend requests you’ve got, the ones you’ve sent and your groups first, the first time only. Your day starts once they’re saved.',
    );
    expect(listsWaitWords({ ...all, groupsAt: null }, true)).toBe(
      'It’s saving your groups first, the first time only. Your day starts once they’re saved.',
    );
  });

  it('says nothing more once they’re saved, or when the day isn’t started, or the API didn’t say', () => {
    expect(dayWords(started, TZ, all)).toBe('Started at 10:00 AM in HandsFreeOS.');
    expect(dayWords(started, TZ)).toBe('Started at 10:00 AM in HandsFreeOS.');
    expect(dayWords({ ...started, state: 'stopped', why: 'person' }, TZ, NO_LISTS)).toBe(
      'Stopped for today at 10:00 AM in HandsFreeOS.',
    );
    expect(listsWaitWords(NO_LISTS, false)).toBe('');
  });
});

describe('the live checklist before the first day', () => {
  it('lists every step in order, the first not done under way with its progress', () => {
    const steps = preDaySteps(NO_LISTS, { line: 'Reading your friends… 1,240 friends so far.' });
    expect(steps.map((step) => step.label)).toEqual([
      'Save your friends list',
      'Save friend requests you got',
      'Save friend requests you sent',
      'Save your groups',
      'Check your groups',
      'Work out who to unfriend',
      'Check your friends for good fits',
    ]);
    expect(steps.map((step) => step.state)).toEqual([
      'now',
      'next',
      'next',
      'next',
      'next',
      'next',
      'next',
    ]);
    expect(steps[0]!.progress).toBe('Reading your friends… 1,240 friends so far.');
    expect(steps.slice(1).every((step) => step.progress === null)).toBe(true);
    expect(preDayCount(steps)).toBe('0 of 7 done');
  });

  it('ticks each once noted, and moves on to the next', () => {
    const steps = preDaySteps(all, { line: '3 of 8 groups checked. Reading Lake Homes…' });
    expect(steps.map((step) => step.state)).toEqual([
      'done',
      'done',
      'done',
      'done',
      'now',
      'next',
      'next',
    ]);
    expect(steps.find((step) => step.state === 'now')).toMatchObject({
      key: 'group_checks',
      label: PRE_DAY_WORDS.group_checks,
      progress: '3 of 8 groups checked. Reading Lake Homes…',
    });
    expect(preDayCount(steps)).toBe('4 of 7 done');
  });

  it('follows the step the extension says is under way, and shows no progress while it isn’t working', () => {
    const steps = preDaySteps(NO_LISTS, {
      doing: 'requests',
      line: 'Opening your friend requests…',
    });
    expect(steps.find((step) => step.state === 'now')?.key).toBe('requests');
    expect(preDaySteps(NO_LISTS)[0]).toMatchObject({ state: 'now', progress: null });
    expect(preDaySteps(NO_LISTS, { line: '   ' })[0]!.progress).toBeNull();
  });

  it('is gone once every step is done, or when the API didn’t say', () => {
    const done = { ...all, groupChecksAt: at(NOW), tidyAt: at(NOW), checksAt: at(NOW) };
    expect(preDayDone(done)).toBe(true);
    expect(preDaySteps(done)).toEqual([]);
    expect(preDaySteps(null)).toEqual([]);
    expect(preDayDone(all)).toBe(false);
  });
});
