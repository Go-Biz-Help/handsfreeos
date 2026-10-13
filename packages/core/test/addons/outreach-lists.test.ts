/**
 * The person's own lists, saved before their day (src/addons/outreach/lists.ts, docs/outreach.md "Lists first"). The
 * owner's decision: first day only. The first time, Start my day waits until friends, requests got and sent are all
 * saved; after that, the requests each morning and the friends list weekly.
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
} from '../../src/addons/outreach/lists';
import { dayWords, type LiveDay } from '../../src/addons/outreach/live';

const TZ = 'America/Chicago';
/** 10 a.m. on Tuesday, October 13 2026, in Chicago. */
const NOW = Date.parse('2026-10-13T15:00:00Z');
const DAY = 86_400_000;
const at = (ms: number) => new Date(ms).toISOString();
const all = { ...NO_LISTS, friendsAt: at(NOW), requestsAt: at(NOW), sentAt: at(NOW) };

describe('the lists due before the day', () => {
  it('the first time, all three, friends first', () => {
    expect(listsDue(NO_LISTS, NOW, TZ)).toEqual(['friends', 'requests', 'sent']);
    expect(firstSaveDone(NO_LISTS)).toBe(false);
    expect(firstSaveDone({ ...all, sentAt: null })).toBe(false);
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

  it('after the first full save, Tidy up then the good-fits check, once each', () => {
    expect(afterFirstSave({ ...all, sentAt: null })).toBeNull();
    expect(afterFirstSave(all)).toBe('tidy');
    expect(afterFirstSave({ ...all, tidyAt: at(NOW) })).toBe('checks');
    expect(afterFirstSave({ ...all, tidyAt: at(NOW), checksAt: at(NOW) })).toBeNull();
  });

  it('takes only what it knows to note', () => {
    const ws = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
    expect(ListSavedInput.safeParse({ workspaceId: ws, list: 'sent' }).success).toBe(true);
    expect(ListSavedInput.safeParse({ workspaceId: ws, list: 'groups' }).success).toBe(false);
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
      'Started at 10:00 AM in HandsFreeOS. It’s saving your friends list and friend requests first, the first time only. Your day starts once they’re saved.',
    );
    expect(listsWaitWords({ ...NO_LISTS, friendsAt: at(NOW) }, true)).toBe(
      'It’s saving the friend requests you’ve got and the ones you’ve sent first, the first time only. Your day starts once they’re saved.',
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
