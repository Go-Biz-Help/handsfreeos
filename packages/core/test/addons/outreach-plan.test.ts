/**
 * The day's plan on a network, worked out in HandsFreeOS (src/addons/outreach/plan.ts, docs/outreach.md decision 195):
 * the runner's own rules (src/addons/outreach/plan-rules.ts) decide the next move, and the rest of the day follows
 * from it, each move in about its time. The extension's tests hold the rules themselves (apps/extension/test).
 */
import { describe, expect, it } from 'vitest';
import { NO_LISTS, type ListsSaved } from '../../src/addons/outreach/lists';
import {
  freshPlanDay,
  leftOn,
  nextMove,
  onPlanClock,
  PLAN_LINE_MOST,
  PLAN_ROWS_MOST,
  PLAN_SINCE,
  PLAN_WORDS,
  planAhead,
  planCounts,
  planMoreWords,
  planNoteKey,
  planRow,
  planShown,
  PlanState,
  planStateOf,
  planWhen,
  rowWords,
  standsFor,
  type PlanDay,
  type PlanFacts,
} from '../../src/addons/outreach/plan';
import {
  changeSent,
  moveSent,
  NEXT_SINCE,
  PLAN_DECIDES,
  PlanNextInput,
  PlanNextOutput,
} from '../../src/addons/outreach/plan-next';
import { freshState, itemKey, workKey, type PlanItem } from '../../src/addons/outreach/plan-rules';
import { RUNNERS } from '../../src/addons/outreach/runners';
import type { TodayKind } from '../../src/addons/outreach/today';

const TZ = 'America/Chicago';
/** 10 a.m. on Tuesday, October 13 2026, in Chicago: an hour into the working hours. */
const NOW = Date.parse('2026-10-13T15:00:00Z');
const TODAY = '2026-10-13';
const FIVE_PM = Date.parse('2026-10-13T22:00:00Z');
const MIN = 60_000;
const at = (ms: number) => new Date(ms).toISOString();
const HOURS = { start: 9, end: 17, days: [1, 2, 3, 4, 5] };

/** Every list saved today, and the first checks done: nothing's due before the day. */
const SAVED: ListsSaved = {
  friendsAt: at(NOW),
  requestsAt: at(NOW),
  sentAt: at(NOW),
  groupsAt: at(NOW),
  groupChecksAt: at(NOW),
  tidyAt: at(NOW),
  checksAt: at(NOW),
};

let made = 0;
const item = (kind: TodayKind, name: string, more: Partial<PlanItem> = {}): PlanItem => ({
  kind,
  name,
  profileId: `00000000-0000-4000-8000-${String(++made).padStart(12, '0')}`,
  profileUrl: `https://www.facebook.com/${name.replace(/\s+/g, '.').toLowerCase()}`,
  threadKey: null,
  postId: null,
  postUrl: null,
  asking: false,
  send: null,
  ...more,
});

const DANA = item('friend_request', 'Dana Reyes');
const SAM = item('friend_request', 'Sam Lee');
const KIM = item('warm_up', 'Kim Park');

const facts = (more: Partial<PlanFacts> = {}): PlanFacts => ({
  platform: 'facebook',
  now: NOW,
  timeZone: TZ,
  hours: HOURS,
  choices: { on: true, sending: 'steps', collect: true, watchPosts: true },
  noting: true,
  day: { date: TODAY, state: 'none', why: null },
  warned: false,
  asks: 0,
  lists: SAVED,
  list: {
    items: [DANA, SAM, KIM],
    partners: [],
    auto: ['friend_request', 'warm_up'],
    messages: [],
    sending: 'steps',
  },
  ...more,
});
const fresh = (more: Partial<PlanDay> = {}): PlanDay => ({ ...freshPlanDay(TODAY), ...more });
/** A day with all of Facebook's reading done. */
const read = (more: Partial<PlanDay> = {}): PlanDay =>
  fresh({
    daily: Object.fromEntries(RUNNERS.facebook.daily.map((job) => [job, 'Done.'])),
    watchAt: NOW + 90 * MIN,
    ...more,
  });

describe('the next move, by the runner’s rules', () => {
  it('is nothing while the network is off for the person, or Sending is', () => {
    const off = facts({ choices: { on: true, sending: 'off', collect: true, watchPosts: true } });
    expect(nextMove(off, fresh()).move).toEqual({ do: 'wait', why: 'off', until: null });
    const notOn = facts({
      choices: { on: false, sending: 'steps', collect: true, watchPosts: true },
    });
    expect(nextMove(notOn, fresh()).move).toMatchObject({ do: 'wait', why: 'off' });
  });

  it('starts the day with its reading, then takes turns with the list (decision 123)', () => {
    const first = nextMove(facts(), fresh());
    expect(first.move).toMatchObject({ do: 'daily', job: 'requests' });
    // A part of the reading went last: the list has its turn, a friend request first (decision 138).
    const second = nextMove(facts(), fresh({ daily: { requests: 'None new.' }, readLast: true }));
    expect(second.move).toMatchObject({ do: 'work', work: { do: 'step', item: DANA }, left: 2 });
    // And back to the reading.
    const third = nextMove(
      facts(),
      fresh({ daily: { requests: 'None new.' }, tried: [itemKey(DANA)], readLast: false }),
    );
    expect(third.move).toMatchObject({ do: 'daily', job: 'tidy' });
  });

  it('never plans the comment research, HandsFreeOS’s own staff’s, unless a batch of it waits', () => {
    const all = Object.fromEntries(
      RUNNERS.facebook.daily.filter((j) => j !== 'comment_research').map((j) => [j, 'Done.']),
    );
    const none = nextMove(facts({ list: { ...facts().list, items: [] } }), fresh({ daily: all }));
    expect(none.move).not.toMatchObject({ do: 'daily' });
    const waits = nextMove(
      facts({ list: { ...facts().list, items: [] } }),
      fresh({ daily: all, againAt: { comment_research: NOW - MIN } }),
    );
    expect(waits.move).toMatchObject({ do: 'daily', job: 'comment_research' });
  });

  it('reads a comment research’s batch first when it’s due, and outside the hours too (decision 194)', () => {
    const due = { againAt: { comment_research: NOW - MIN } };
    // Before the day's other once-a-day jobs.
    expect(nextMove(facts(), fresh(due)).move).toMatchObject({
      do: 'daily',
      job: 'comment_research',
    });
    // Outside the hours, as it only reads; and the plan waits for its next batch there.
    const seven = Date.parse('2026-10-13T12:00:00Z');
    const early = { againAt: { comment_research: seven - MIN } };
    expect(nextMove(facts({ now: seven }), fresh(early)).move).toMatchObject({
      do: 'daily',
      job: 'comment_research',
    });
    const later = nextMove(
      facts({ now: seven }),
      fresh({ againAt: { comment_research: seven + 30 * MIN } }),
    );
    expect(later.move).toEqual({ do: 'wait', why: 'hours', until: seven + 30 * MIN });
    // Never after Stop for today, nor before what the person asked.
    const stopped = facts({ now: seven, day: { date: TODAY, state: 'stopped', why: 'person' } });
    expect(nextMove(stopped, fresh(early)).move).toMatchObject({ do: 'wait', why: 'stopped' });
    expect(nextMove(facts({ now: seven, asks: 1 }), fresh(early)).move).toMatchObject({
      do: 'wait',
      why: 'hours',
    });
  });

  it('spreads the list over what’s left of the hours once the reading is done', () => {
    const { move } = nextMove(facts(), read());
    expect(move).toMatchObject({ do: 'work', left: 2 });
    // Seven hours shared among the three left, give or take: far more than a person's pace, never over 45 minutes.
    expect(move.do === 'work' && move.gap).toBe(45 * MIN);
    // After Start my day it goes at a person's pace.
    const started = nextMove(facts({ day: { date: TODAY, state: 'started', why: null } }), read());
    expect(started.move.do === 'work' && started.move.gap).toBe(2 * MIN);
  });

  it('holds everything for the first save of the person’s lists', () => {
    const { move } = nextMove(facts({ lists: NO_LISTS }), fresh({ readLast: true }));
    expect(move).toMatchObject({
      do: 'before',
      step: { do: 'save', list: 'friends', first: true },
    });
  });

  it('waits for the working hours, where only a reply to someone who wrote back goes (decision 133)', () => {
    const seven = Date.parse('2026-10-13T12:00:00Z');
    const early = nextMove(facts({ now: seven }), fresh());
    expect(early.move).toMatchObject({ do: 'wait', why: 'hours' });
    // The hours' start, and a little after it: never on the hour.
    const nine = Date.parse('2026-10-13T14:00:00Z');
    expect(early.move.do === 'wait' && early.move.until).toBe(nine + 10 * MIN);

    const reply = item('reply', 'Lee Ortiz', { threadKey: 't-1' });
    const list = { ...facts().list, items: [DANA, reply], messages: ['reply'] };
    const answering = nextMove(facts({ now: seven, list }), fresh());
    expect(answering.move).toMatchObject({ do: 'work', work: { do: 'draft', item: reply } });
    // What the person asked of the extension goes before it.
    expect(nextMove(facts({ now: seven, list, asks: 1 }), fresh()).move).toMatchObject({
      do: 'wait',
      why: 'hours',
    });
  });

  it('stops for the day on Stop for today or a warning, till the next working hours', () => {
    const wednesdayNine = Date.parse('2026-10-14T14:00:00Z');
    const stopped = nextMove(facts({ day: { date: TODAY, state: 'stopped', why: null } }), fresh());
    expect(stopped.move).toEqual({ do: 'wait', why: 'stopped', until: wednesdayNine + 10 * MIN });
    const warning = nextMove(
      facts({ day: { date: TODAY, state: 'stopped', why: 'warning' } }),
      fresh(),
    );
    expect(warning.move).toMatchObject({ do: 'wait', why: 'warned' });
    expect(nextMove(facts({ warned: true }), fresh()).move).toMatchObject({ why: 'warned' });
  });

  it('gives way to what the person asked, and to noting being off', () => {
    expect(nextMove(facts({ asks: 2 }), fresh()).move).toEqual({
      do: 'wait',
      why: 'asks',
      until: NOW + 2 * MIN,
    });
    expect(nextMove(facts({ noting: false }), fresh()).move).toMatchObject({ why: 'noting' });
  });

  it('starts a new day afresh when the state kept is yesterday’s', () => {
    const yesterday = fresh({
      day: '2026-10-12',
      tried: [itemKey(DANA)],
      daily: { requests: 'x' },
    });
    const { move, state } = nextMove(facts(), yesterday);
    expect(state.day).toBe(TODAY);
    expect(state.tried).toEqual([]);
    expect(move).toMatchObject({ do: 'daily', job: 'requests' });
  });

  it('looks at the newest posts when that’s due, and again within the hour when nothing’s left', () => {
    const empty = facts({ list: { ...facts().list, items: [] } });
    expect(nextMove(empty, read({ watchAt: NOW - MIN })).move).toMatchObject({ do: 'watch' });
    expect(nextMove(empty, read({ watchAt: NOW + 20 * MIN })).move).toEqual({
      do: 'wait',
      why: 'idle',
      until: NOW + 20 * MIN,
    });
    expect(nextMove(empty, read({ watchAt: NOW + 3 * 60 * MIN })).move).toEqual({
      do: 'wait',
      why: 'idle',
      until: NOW + 60 * MIN,
    });
  });

  it('looks again when the hours end on Facebook, and within the hour anywhere else, as each runner does', () => {
    // 4:40 p.m.: 20 minutes of the working hours are left.
    const late = FIVE_PM - 20 * MIN;
    const nothing = { ...facts().list, items: [] };
    const idle = (platform: 'facebook' | 'alignable') => {
      const daily = Object.fromEntries(RUNNERS[platform].daily.map((job) => [job, 'Done.']));
      const state = fresh({ daily, watchAt: late + 3 * 60 * MIN });
      return nextMove(facts({ platform, now: late, list: nothing }), state).move;
    };
    expect(idle('facebook')).toEqual({ do: 'wait', why: 'idle', until: FIVE_PM });
    // Alignable's own next look finds the hours over, and waits for the next ones then.
    expect(idle('alignable')).toEqual({ do: 'wait', why: 'idle', until: late + 60 * MIN });
  });

  it('searches every hour on Threads and X, and writes no messages on X', () => {
    const threads = facts({
      platform: 'threads',
      lists: { ...NO_LISTS, friendsAt: at(NOW), tidyAt: at(NOW) },
    });
    expect(nextMove(threads, fresh()).move).toMatchObject({ do: 'search' });
    expect(nextMove(threads, fresh({ watchAt: NOW + 30 * MIN })).move).toMatchObject({
      do: 'daily',
      job: 'requests',
    });
    const opener = item('opener', 'Ana Ruiz', { threadKey: 't-2' });
    const list = { ...facts().list, items: [opener, KIM], messages: ['opener'] };
    const state = { tried: [], replied: [], requestsOff: false };
    expect(leftOn(RUNNERS.threads, list, state).map((w) => w.do)).toEqual(['step', 'draft']);
    expect(leftOn(RUNNERS.x, list, state).map((w) => w.do)).toEqual(['step']);
  });

  it('knows which once-a-day job a step before the day stands for', () => {
    expect(standsFor('facebook', { do: 'save', list: 'requests', first: false })).toBe('requests');
    expect(standsFor('facebook', { do: 'save', list: 'friends', first: false })).toBeNull();
    expect(standsFor('facebook', { do: 'group_checks' })).toBe('group_checks');
    expect(standsFor('instagram', { do: 'save', list: 'friends', first: true })).toBe('requests');
    expect(standsFor('linkedin', { do: 'checks' })).toBe('checks');
  });
});

describe('a runner’s own ask for its next move (decision 195, step 2)', () => {
  const DAY = 24 * 60 * MIN;
  const READY = { ...NO_LISTS, friendsAt: at(NOW), tidyAt: at(NOW) };
  const onThreads = (more: Partial<PlanFacts> = {}) =>
    facts({ platform: 'threads', lists: READY, ...more });
  /** A day on Threads or X with all its reading done, and its search not due for a while. */
  const allRead = (platform: 'threads' | 'x', more: Partial<PlanDay> = {}): PlanDay =>
    fresh({
      daily: Object.fromEntries(RUNNERS[platform].daily.map((job) => [job, 'Done.'])),
      watchAt: NOW + 40 * MIN,
      ...more,
    });
  const HERE = { away: false, passOver: [] } as const;

  it('holds a first day’s lists till the person is away, as saving them needs the window on screen', () => {
    const first = onThreads({ lists: NO_LISTS });
    expect(nextMove(first, fresh(), 0.5, HERE).move).toEqual({
      do: 'wait',
      why: 'screen',
      until: NOW + 10 * MIN,
    });
    expect(nextMove(first, fresh(), 0.5, { away: true, passOver: [] }).move).toMatchObject({
      do: 'before',
      step: { do: 'save', list: 'friends', first: true },
    });
    // The plan that's shown takes them as away: the save is planned.
    expect(nextMove(first, fresh()).move).toMatchObject({ do: 'before' });
  });

  it('leaves a later save of their lists till they’re away, and goes on with the rest', () => {
    const weekly = onThreads({ lists: { ...READY, friendsAt: at(NOW - 8 * DAY) } });
    const state = fresh({ watchAt: NOW + 40 * MIN });
    expect(nextMove(weekly, state, 0.5, { away: true, passOver: [] }).move).toMatchObject({
      do: 'before',
      step: { do: 'save', list: 'friends', first: false },
    });
    expect(nextMove(weekly, state, 0.5, HERE).move).toMatchObject({ do: 'daily', job: 'requests' });
    // With nothing else to read, the save isn't reading that's left: the list goes at its own pace.
    const listOnly = nextMove(weekly, allRead('threads'), 0.5, HERE).move;
    expect(listOnly).toMatchObject({ do: 'work', reading: false, answering: false });
  });

  it('holds a save for the screen where followers are saved: elsewhere it’s tried when due, and puts itself off', () => {
    const held = Object.entries(RUNNERS).filter(([, kit]) => kit.savesAway);
    expect(held.map(([platform]) => platform)).toEqual(['instagram', 'threads', 'x']);
    // Instagram's first day waits for the person to be away, as its runner does, and a later save is left till then.
    const onInstagram = (lists: ListsSaved) => facts({ platform: 'instagram', lists });
    expect(nextMove(onInstagram(NO_LISTS), fresh(), 0.5, HERE).move).toEqual({
      do: 'wait',
      why: 'screen',
      until: NOW + 10 * MIN,
    });
    const followersDue = onInstagram({ ...SAVED, friendsAt: at(NOW - 8 * DAY) });
    expect(nextMove(followersDue, fresh(), 0.5, HERE).move).toMatchObject({
      do: 'daily',
      job: 'requests',
    });
    expect(nextMove(followersDue, fresh(), 0.5, { away: true, passOver: [] }).move).toMatchObject({
      do: 'before',
      step: { do: 'save', list: 'friends', first: false },
    });
    // Alignable's first day, with the person at their computer: the save is sent, as its own runner tries it.
    const onAlignable = (lists: ListsSaved) => facts({ platform: 'alignable', lists });
    expect(nextMove(onAlignable(NO_LISTS), fresh(), 0.5, HERE).move).toMatchObject({
      do: 'before',
      step: { do: 'save', list: 'friends', first: true },
    });
    // And a later one, due again, goes before the rest of the day's reading, not after it.
    const weekly = onAlignable({ ...SAVED, friendsAt: at(NOW - 8 * DAY) });
    expect(nextMove(weekly, fresh(), 0.5, HERE).move).toMatchObject({
      do: 'before',
      step: { do: 'save', list: 'friends', first: false },
    });
    // It still takes turns with the list (decision 123): after a part of the reading, a step on the list goes.
    expect(nextMove(weekly, fresh({ readLast: true }), 0.5, HERE).move).toMatchObject({
      do: 'work',
      reading: true,
    });
  });

  it('sends a runner today’s helpful post once the day’s reading is done, where it posts on its own', () => {
    const CHOICES = { on: true, sending: 'steps', collect: true, watchPosts: true } as const;
    const posting = (more: Partial<PlanFacts> = {}) =>
      facts({ platform: 'linkedin', choices: { ...CHOICES, posting: 'own' }, ...more });
    const done = (platform: 'linkedin' | 'facebook' | 'instagram', more: Partial<PlanDay> = {}) =>
      fresh({
        daily: Object.fromEntries(RUNNERS[platform].daily.map((job) => [job, 'Done.'])),
        watchAt: NOW + 90 * MIN,
        ...more,
      });
    // After the reading, before the list, at LinkedIn's pace.
    expect(nextMove(posting(), done('linkedin'), 0.5, HERE).move).toEqual({
      do: 'post',
      gap: 4 * MIN,
    });
    // Never while a part of the reading is left: the AI writes the post from what was read.
    expect(nextMove(posting(), fresh(), 0.5, HERE).move).toMatchObject({ do: 'daily' });
    // With Collect off there's no reading to wait for.
    const noReading = posting({ choices: { ...CHOICES, collect: false, posting: 'own' } });
    expect(nextMove(noReading, fresh(), 0.5, HERE).move).toMatchObject({ do: 'post' });
    // Once it's up, or while none's written yet and it looks again later, the list goes on.
    const up = done('linkedin', { helpfulUp: true });
    expect(nextMove(posting(), up, 0.5, HERE).move).toMatchObject({ do: 'work', reading: false });
    const later = done('linkedin', { helpfulAt: NOW + 20 * MIN });
    expect(nextMove(posting(), later, 0.5, HERE).move).toMatchObject({ do: 'work' });
    expect(
      nextMove(posting(), done('linkedin', { helpfulAt: NOW - MIN }), 0.5, HERE).move,
    ).toMatchObject({
      do: 'post',
    });
    // Not where a post waits for their OK, which is how it starts, nor where the runner puts none up.
    const afterOk = posting({ choices: { ...CHOICES, posting: 'after_ok' } });
    expect(nextMove(afterOk, done('linkedin'), 0.5, HERE).move).toMatchObject({ do: 'work' });
    expect(
      nextMove(facts({ platform: 'linkedin' }), done('linkedin'), 0.5, HERE).move,
    ).toMatchObject({
      do: 'work',
    });
    const onInstagram = posting({ platform: 'instagram' });
    expect(nextMove(onInstagram, done('instagram'), 0.5, HERE).move).toMatchObject({ do: 'work' });
    // Facebook's goes only in its hours: with its day started by hand after them, the list goes on. A referral
    // looked for a moment ago leaves the post its turn.
    const onFacebook = posting({ platform: 'facebook' });
    const referred = { referAt: NOW + 20 * MIN };
    expect(nextMove(onFacebook, done('facebook', referred), 0.5, HERE).move).toMatchObject({
      do: 'post',
    });
    const pressed = posting({
      platform: 'facebook',
      now: FIVE_PM + 30 * MIN,
      day: { date: TODAY, state: 'started', why: null },
    });
    expect(nextMove(pressed, done('facebook'), 0.5, HERE).move).not.toMatchObject({ do: 'post' });
    // The plan that's shown leaves the post out, and says so.
    expect(nextMove(posting(), done('linkedin')).move).toMatchObject({ do: 'work' });
  });

  it('sends Facebook’s runner to look for a referral to do, every half hour in its hours', () => {
    const CHOICES = { on: true, sending: 'steps', collect: true, watchPosts: true } as const;
    const onFacebook = (more: Partial<PlanFacts> = {}) =>
      facts({ platform: 'facebook', choices: { ...CHOICES, posting: 'own' }, ...more });
    const done = (more: Partial<PlanDay> = {}) =>
      fresh({
        daily: Object.fromEntries(RUNNERS.facebook.daily.map((job) => [job, 'Done.'])),
        watchAt: NOW + 90 * MIN,
        ...more,
      });
    // After the day's reading, before the helpful post, the newest posts and the list, at a person's pace.
    expect(nextMove(onFacebook(), done(), 0.5, HERE).move).toEqual({ do: 'refer', gap: 2 * MIN });
    expect(nextMove(onFacebook(), done({ watchAt: NOW - MIN }), 0.5, HERE).move).toMatchObject({
      do: 'refer',
    });
    // Never while a part of the reading is left.
    expect(nextMove(onFacebook(), fresh(), 0.5, HERE).move).not.toMatchObject({ do: 'refer' });
    // One looked for in the last half hour isn't again: the post, the newest posts and the list have their turn.
    const looked = done({ referAt: NOW + 20 * MIN });
    expect(nextMove(onFacebook(), looked, 0.5, HERE).move).toMatchObject({ do: 'post' });
    expect(nextMove(onFacebook(), done({ referAt: NOW - MIN }), 0.5, HERE).move).toMatchObject({
      do: 'refer',
    });
    // Only in its hours: with its day started by hand after them, none is looked for.
    const pressed = onFacebook({
      now: FIVE_PM + 30 * MIN,
      day: { date: TODAY, state: 'started', why: null },
    });
    expect(nextMove(pressed, done(), 0.5, HERE).move).not.toMatchObject({ do: 'refer' });
    // Only Facebook's runner does them.
    for (const platform of ['linkedin', 'instagram', 'alignable', 'threads', 'x'] as const) {
      expect(RUNNERS[platform].refers).toBe(false);
      const all = fresh({
        daily: Object.fromEntries(RUNNERS[platform].daily.map((job) => [job, 'Done.'])),
        watchAt: NOW + 90 * MIN,
      });
      expect(nextMove(facts({ platform }), all, 0.5, HERE).move).not.toMatchObject({ do: 'refer' });
    }
    // The plan that's shown leaves the look out, and says so.
    expect(nextMove(onFacebook(), done()).move).not.toMatchObject({ do: 'refer' });
    // And it's sent as it is.
    expect(moveSent({ do: 'refer', gap: 120_000.4 }, 10 * MIN)).toEqual({
      do: 'refer',
      gap: 120_000,
    });
    expect(
      PlanNextOutput.parse({
        decides: true,
        move: { do: 'refer', gap: 1 },
        change: null,
        list: null,
      }).move,
    ).toEqual({ do: 'refer', gap: 1 });
  });

  it('sends the helpful post as it is, its gap a whole number', () => {
    expect(moveSent({ do: 'post', gap: 240_000.4 }, 10 * MIN)).toEqual({
      do: 'post',
      gap: 240_000,
    });
    expect(
      PlanNextOutput.parse({
        decides: true,
        move: { do: 'post', gap: 1 },
        change: null,
        list: null,
      }).move,
    ).toEqual({ do: 'post', gap: 1 });
  });

  it('passes over a job put off till they’re away, and looks again in a few minutes for it', () => {
    const state = fresh({ watchAt: NOW + 40 * MIN });
    const putOff = { away: false, passOver: ['requests'] };
    expect(nextMove(onThreads(), state, 0.5, putOff).move).toMatchObject({
      do: 'daily',
      job: 'follow_backs',
    });
    // Nothing else left: it's tried again in 10 minutes, not within the hour.
    const nothing = onThreads({ list: { ...facts().list, items: [] } });
    const rest = allRead('threads');
    const { requests: _put, ...others } = rest.daily;
    const waiting = nextMove(nothing, { ...rest, daily: others }, 0.5, putOff).move;
    expect(waiting).toEqual({ do: 'wait', why: 'idle', until: NOW + 10 * MIN });
    expect(nextMove(nothing, rest, 0.5, HERE).move).toEqual({
      do: 'wait',
      why: 'idle',
      until: NOW + 40 * MIN,
    });
  });

  it('never finds people again while a job put off is still to do', () => {
    const short = onThreads({
      list: { ...facts().list, items: [], goal: { more: true } },
    });
    const rest = allRead('threads');
    const again = nextMove(short, rest, 0.5, HERE);
    expect(again.state.round).toBe(1);
    expect(again.move).toMatchObject({ do: 'daily' });
    const { tidy: _put, ...others } = rest.daily;
    const held = nextMove(short, { ...rest, daily: others }, 0.5, {
      away: false,
      passOver: ['tidy'],
    });
    expect(held.state.round).toBe(0);
    expect(held.move).toMatchObject({ do: 'wait', why: 'idle' });
  });

  it('reads a comment research when HandsFreeOS told the runner one reads, and never by guessing', () => {
    const state = fresh({ watchAt: NOW + 40 * MIN, againAt: { comment_research: NOW - MIN } });
    expect(nextMove(onThreads(), state, 0.5, { ...HERE, research: true }).move).toMatchObject({
      do: 'daily',
      job: 'comment_research',
    });
    // Told none reads, a batch that looks due in the state isn't read.
    expect(nextMove(onThreads(), state, 0.5, { ...HERE, research: false }).move).toMatchObject({
      do: 'daily',
      job: 'requests',
    });
    // Outside the hours too, as it only reads (decision 194).
    const seven = Date.parse('2026-10-13T12:00:00Z');
    expect(
      nextMove(onThreads({ now: seven }), fresh(), 0.5, { ...HERE, research: true }).move,
    ).toMatchObject({ do: 'daily', job: 'comment_research' });
  });

  it('says how a piece of the list’s work goes: by turns with the reading, in whose day, or only answering', () => {
    const turn = nextMove(
      onThreads(),
      fresh({ watchAt: NOW + 40 * MIN, readLast: true }),
      0.5,
      HERE,
    ).move;
    expect(turn).toMatchObject({
      do: 'work',
      reading: true,
      answering: false,
      day: { started: false, until: FIVE_PM },
    });
    const started = nextMove(
      onThreads({ day: { date: TODAY, state: 'started', why: null } }),
      allRead('threads'),
      0.5,
      HERE,
    ).move;
    expect(started).toMatchObject({
      do: 'work',
      reading: false,
      day: { started: true, until: null },
    });
    // Outside the hours on Threads, only a reply to someone who wrote back.
    const seven = Date.parse('2026-10-13T12:00:00Z');
    const reply = item('reply', 'Lee Ortiz', { threadKey: 't-9' });
    const list = { ...facts().list, items: [KIM, reply], messages: ['reply'] };
    const answering = nextMove(onThreads({ now: seven, list }), fresh(), 0.5, HERE).move;
    expect(answering).toMatchObject({
      do: 'work',
      work: { do: 'draft', item: reply },
      left: 0,
      answering: true,
      day: { started: true, until: null },
    });
  });

  it('takes the runner’s word for whether something asked is in line, over HandsFreeOS’s own count', () => {
    const state = fresh({ watchAt: NOW + 40 * MIN });
    // One no computer took yet is counted by HandsFreeOS, and holds no runner.
    const counted = onThreads({ asks: 1 });
    expect(nextMove(counted, state, 0.5, { ...HERE, asking: false }).move).toMatchObject({
      do: 'daily',
      job: 'requests',
    });
    expect(nextMove(onThreads(), state, 0.5, { ...HERE, asking: true }).move).toEqual({
      do: 'wait',
      why: 'asks',
      until: NOW + 2 * MIN,
    });
    // Left unsaid, as for the plan that's shown, the count says.
    expect(nextMove(counted, state, 0.5, HERE).move).toMatchObject({ do: 'wait', why: 'asks' });
    expect(nextMove(counted, state).move).toMatchObject({ do: 'wait', why: 'asks' });
  });

  it('waits outside the hours as the runner does: till they start, with what was asked first', () => {
    const seven = Date.parse('2026-10-13T12:00:00Z');
    const nine = Date.parse('2026-10-13T14:00:00Z');
    const reply = item('reply', 'Lee Ortiz', {
      threadKey: 't-8',
      send: { state: 'waiting' } as never,
    });
    const list = { ...facts().list, items: [reply], messages: [], retryAt: at(seven + 5 * MIN) };
    // On X nothing is written in anyone's messages: no reply to look for, and no message tried again.
    expect(
      nextMove(facts({ platform: 'x', lists: READY, now: seven, list }), fresh(), 0.5, HERE).move,
    ).toEqual({ do: 'wait', why: 'hours', until: nine + 10 * MIN });
    // What the person asked goes first: nothing of the runner's own till the hours start.
    expect(nextMove(onThreads({ now: seven, list, asks: 1 }), fresh(), 0.5, HERE).move).toEqual({
      do: 'wait',
      why: 'hours',
      until: nine + 10 * MIN,
    });
  });
});

describe('the move as it’s sent to a runner (decision 195, step 2)', () => {
  /** HandsFreeOS's clock is 10 minutes ahead of the runner's. */
  const SKEW = 10 * MIN;

  it('is switched on for no network yet, and answers only a build that asks', () => {
    // Threads' and X's runners ask from 0.156.0, Alignable's from 0.157.0, and Instagram's from 0.158.0. Each goes in
    // here by itself, once a day's plan is checked against a real day.
    expect(PLAN_DECIDES).toEqual([]);
    expect(NEXT_SINCE).toBe('0.156.0');
  });

  it('names a piece of the list’s work by its key, and says how it goes', () => {
    const { move } = nextMove(facts(), read({ readLast: true }));
    if (move.do !== 'work') throw new Error('a step on the list was expected');
    const sent = moveSent(move, SKEW);
    expect(sent).toEqual({
      do: 'work',
      key: workKey({ do: 'step', item: DANA }),
      left: 2,
      gap: Math.round(move.gap),
      reading: false,
      day: { started: false, until: FIVE_PM - SKEW },
      answering: false,
    });
    // It goes over the wire as it is.
    expect(
      PlanNextOutput.parse({ decides: true, move: sent, change: null, list: null }).move,
    ).toEqual(sent);
  });

  it('puts every time on the runner’s clock, and keeps a wait with no end', () => {
    expect(moveSent({ do: 'wait', why: 'asks', until: NOW + 2 * MIN }, SKEW)).toEqual({
      do: 'wait',
      why: 'asks',
      until: NOW - 8 * MIN,
    });
    expect(moveSent({ do: 'wait', why: 'off', until: null }, SKEW)).toEqual({
      do: 'wait',
      why: 'off',
      until: null,
    });
    // A clock behind the runner's moves them the other way.
    expect(moveSent({ do: 'wait', why: 'idle', until: NOW }, -SKEW)).toMatchObject({
      until: NOW + SKEW,
    });
  });

  it('sends the reading’s moves as they are, each gap a whole number', () => {
    const step = { do: 'save', list: 'friends', first: true } as const;
    expect(moveSent({ do: 'before', step, gap: 1200.4 }, SKEW)).toEqual({
      do: 'before',
      step,
      gap: 1200,
    });
    expect(moveSent({ do: 'daily', job: 'requests', gap: 90_000.6 }, SKEW)).toEqual({
      do: 'daily',
      job: 'requests',
      gap: 90_001,
    });
    expect(moveSent({ do: 'search', gap: 5 }, SKEW)).toEqual({ do: 'search', gap: 5 });
    expect(moveSent({ do: 'watch', gap: 5 }, SKEW)).toEqual({ do: 'watch', gap: 5 });
  });

  it('says only what the move changed in the day: a round of finding again begun, who still waits', () => {
    const day = fresh({
      daily: { requests: 'Done.', post_people: 'Read 3.' },
      replied: ['a', 'b'],
    });
    expect(changeSent(day, day, SKEW)).toBeNull();
    expect(changeSent(day, { ...day }, SKEW)).toBeNull();
    const round = { ...day, daily: { requests: 'Done.' }, round: 1, roundAt: NOW };
    expect(changeSent(day, round, SKEW)).toEqual({
      daily: { requests: 'Done.' },
      round: 1,
      roundAt: NOW - SKEW,
    });
    expect(changeSent(day, { ...day, replied: ['b'] }, SKEW)).toEqual({ replied: ['b'] });
    // HandsFreeOS's day isn't the runner's, around midnight: the runner begins its own new day itself.
    expect(changeSent(fresh({ day: '2026-10-12' }), round, SKEW)).toBeNull();
  });

  it('begins a round of finding again in what it sends, as the runner did for itself', () => {
    const short = facts({
      platform: 'threads',
      lists: { ...NO_LISTS, friendsAt: at(NOW), tidyAt: at(NOW) },
      list: { ...facts().list, items: [], goal: { more: true } },
    });
    const kept = fresh({
      daily: Object.fromEntries(RUNNERS.threads.daily.map((job) => [job, 'Done.'])),
      watchAt: NOW + 40 * MIN,
    });
    const { move, state } = nextMove(short, kept, 0.5, { away: false, passOver: [] });
    expect(moveSent(move, SKEW)).toMatchObject({ do: 'daily', job: RUNNERS.threads.finding[0] });
    const change = changeSent(kept, state, SKEW)!;
    expect(change).toMatchObject({ round: 1, roundAt: NOW - SKEW });
    for (const job of RUNNERS.threads.finding) expect(change.daily).not.toHaveProperty(job);
    expect(change.daily).toHaveProperty('requests', 'Done.');
    expect(change.replied).toBeUndefined();
  });

  it('takes a runner’s ask with what only its computer knows, and nothing it couldn’t say', () => {
    const ask = {
      workspaceId: '00000000-0000-4000-8000-000000000001',
      platform: 'x',
      computer: '00000000-0000-4000-8000-000000000002',
      state: planStateOf(freshState(TODAY, null)),
      now: NOW,
      random: 0.25,
      here: { away: true },
    };
    expect(PlanNextInput.parse(ask).here).toEqual({ away: true, passOver: [] });
    expect(PlanNextInput.safeParse({ ...ask, random: 1.5 }).success).toBe(false);
    expect(PlanNextInput.safeParse({ ...ask, computer: 'home' }).success).toBe(false);
    expect(
      PlanNextInput.safeParse({ ...ask, here: { away: false, passOver: ['tidy'], research: true } })
        .success,
    ).toBe(true);
  });
});

describe('the rest of the day, worked out', () => {
  it('goes move by move, the reading and the list by turns, each later than the last', () => {
    const { moves, until } = planAhead(facts(), fresh());
    expect(until).toBe(FIVE_PM);
    expect(moves.slice(0, 6).map((m) => m.move.do)).toEqual([
      'daily',
      'work',
      'daily',
      'work',
      'daily',
      'work',
    ]);
    expect(moves[0]).toMatchObject({ at: NOW, about: true, now: false });
    for (let i = 1; i < moves.length; i++) expect(moves[i]!.at).toBeGreaterThan(moves[i - 1]!.at);
    expect(moves.every((m) => m.at < until)).toBe(true);
    // Each of the three on the list once, and every once-a-day job but the comment research once.
    expect(moves.filter((m) => m.move.do === 'work')).toHaveLength(3);
    const jobs = moves.flatMap((m) => (m.move.do === 'daily' ? [m.move.job] : []));
    expect(jobs).toEqual(RUNNERS.facebook.daily.filter((job) => job !== 'comment_research'));
    // Then the newest posts, every hour or two, till the hours end.
    expect(moves.filter((m) => m.move.do === 'watch').length).toBeGreaterThan(1);
  });

  it('takes the extension’s own time for the next move, and says the rest are about', () => {
    const nextAt = NOW + 7 * MIN;
    const { moves } = planAhead(facts(), read({ nextAt }));
    expect(moves[0]).toMatchObject({ at: nextAt, about: false, now: false });
    expect(moves[1]).toMatchObject({ about: true });
    // A step under way is now.
    const working = planAhead(facts(), read({ working: true, nextAt: null }));
    expect(working.moves[0]).toMatchObject({ at: NOW, about: false, now: true });
  });

  it('plans from the hours’ start before they begin, and nothing after Stop for today', () => {
    const seven = Date.parse('2026-10-13T12:00:00Z');
    const nine = Date.parse('2026-10-13T14:00:00Z');
    const early = planAhead(facts({ now: seven }), fresh());
    expect(early.first).toMatchObject({ do: 'wait', why: 'hours' });
    expect(early.moves[0]!.at).toBe(nine + 10 * MIN);
    const stopped = planAhead(
      facts({ day: { date: TODAY, state: 'stopped', why: null } }),
      fresh(),
    );
    expect(stopped.moves).toEqual([]);
  });

  it('lists only so many, and counts the rest', () => {
    const many = Array.from({ length: 60 }, (_, i) => item('friend_request', `Person ${i}`));
    const list = { ...facts().list, items: many };
    const { moves, more } = planAhead(
      facts({ list, day: { date: TODAY, state: 'started', why: null } }),
      read({ watchAt: NOW + 24 * 60 * MIN }),
    );
    expect(moves).toHaveLength(PLAN_ROWS_MOST);
    expect(more).toBe(60 - PLAN_ROWS_MOST);
  });
});

describe('the plan as the app shows it', () => {
  const computer = { state: 'working' as const, lastSeenAt: at(NOW - 30_000), version: PLAN_SINCE };

  it('says so when there’s no computer, or it’s signed out or offline', () => {
    expect(planShown({ facts: facts(), reported: fresh(), computer: null })).toMatchObject({
      stand: 'none',
      coming: [],
    });
    expect(
      planShown({
        facts: facts(),
        reported: fresh(),
        computer: { ...computer, state: 'signed_out' },
      }).stand,
    ).toBe('signed_out');
    const offline = planShown({
      facts: facts(),
      reported: fresh({ daily: { requests: 'None new.' } }),
      computer: { ...computer, lastSeenAt: at(NOW - 20 * MIN) },
    });
    expect(offline).toMatchObject({ stand: 'offline', coming: [] });
    // What it did before it went offline still shows.
    expect(offline.done).toEqual([{ title: 'Friend requests', line: 'None new.' }]);
  });

  it('asks for an update while the extension is from before it says where its day is up to', () => {
    const old = planShown({
      facts: facts(),
      reported: null,
      computer: { ...computer, version: '0.154.0' },
    });
    expect(old).toMatchObject({ reported: false, line: PLAN_WORDS.update, coming: [] });
    const soon = planShown({ facts: facts(), reported: null, computer });
    expect(soon.line).toBe(PLAN_WORDS.notYet);
  });

  it('shows what’s next, what’s coming, and what’s done so far', () => {
    const plan = planShown({
      facts: facts(),
      reported: read({
        nextAt: NOW + 7 * MIN,
        tried: [itemKey(SAM)],
        done: { friend_request: 1, warm_up: 2, drafted: 1 },
      }),
      computer,
    });
    expect(plan.stand).toBe('going');
    // A friend request went last, so a like has the next turn (decision 138).
    expect(plan.line).toBe('Next at 10:07 AM: Like a post first (Kim Park).');
    expect(plan.coming[0]).toMatchObject({
      kind: 'step',
      title: 'Like a post first',
      who: 'Kim Park',
      about: false,
    });
    expect(plan.coming[1]).toMatchObject({
      kind: 'step',
      title: 'Send a friend request',
      who: 'Dana Reyes',
      about: true,
    });
    expect(plan.until).toBe(at(FIVE_PM));
    expect(plan.done[0]).toEqual({ title: 'Friend requests', line: 'Done.' });
    expect(plan.counts).toEqual([
      { label: 'friend request sent', count: 1 },
      { label: 'likes', count: 2 },
      { label: 'message written', count: 1 },
    ]);
  });

  it('says what it’s doing while a step is under way', () => {
    const plan = planShown({
      facts: facts(),
      reported: read({ working: true, line: 'Sending Dana Reyes a friend request…' }),
      computer,
    });
    expect(plan).toMatchObject({
      stand: 'working',
      doing: 'Sending Dana Reyes a friend request…',
    });
    expect(plan.coming[0]).toMatchObject({ now: true, about: false, who: 'Dana Reyes' });
  });

  it('says when it starts on its own, why it stopped, and what it waits for', () => {
    const seven = Date.parse('2026-10-13T12:00:00Z');
    const early = planShown({
      facts: facts({ now: seven }),
      reported: fresh(),
      computer: { ...computer, lastSeenAt: at(seven) },
    });
    expect(early.stand).toBe('waiting');
    expect(early.line).toContain('Starts on its own on Facebook at 9:00 AM.');
    expect(early.coming.length).toBeGreaterThan(0);

    const stopped = planShown({
      facts: facts({ day: { date: TODAY, state: 'stopped', why: null } }),
      reported: fresh(),
      computer,
    });
    expect(stopped.stand).toBe('stopped');
    expect(stopped.line).toBe(
      'Stopped on Facebook for today. It starts again on its own tomorrow at 9:00 AM.',
    );

    const asked = planShown({ facts: facts({ asks: 1 }), reported: fresh(), computer });
    expect(asked.stand).toBe('asks');
    expect(asked.notes[0]).toContain('What you asked for goes first');
    // The rest of the day is still listed after it.
    expect(asked.coming.length).toBeGreaterThan(0);

    const idle = planShown({
      facts: facts({ list: { ...facts().list, items: [] } }),
      reported: read({ tried: ['x'], watchAt: NOW + 20 * MIN }),
      computer,
    });
    expect(idle.stand).toBe('idle');
    expect(idle.line).toBe('Done for now. It looks again by 10:20 AM.');
  });

  it('names each row, each network in its own words', () => {
    const row = (platform: 'facebook' | 'linkedin', move: Parameters<typeof planRow>[1]['move']) =>
      planRow(platform, { at: NOW, about: true, now: false, move });
    expect(row('linkedin', { do: 'daily', job: 'requests', gap: 0 }).title).toBe('Invitations');
    expect(
      row('facebook', { do: 'before', step: { do: 'save', list: 'friends', first: true }, gap: 0 }),
    ).toMatchObject({ kind: 'lists', title: 'Save your friends list' });
    const going = {
      left: 0,
      gap: 0,
      reading: false,
      day: { started: false, until: null },
      answering: false,
    } as const;
    const reply = item('reply', 'Lee Ortiz');
    expect(
      row('facebook', { do: 'work', work: { do: 'draft', item: reply }, ...going }),
    ).toMatchObject({ kind: 'draft', title: 'Write a message', who: 'Lee Ortiz', detail: 'Reply' });
    const comment = item('comment', 'Ana Ruiz');
    expect(
      row('facebook', { do: 'work', work: { do: 'send', item: comment }, ...going }),
    ).toMatchObject({ kind: 'send', title: 'Post the comment', detail: null });
    expect(rowWords({ title: 'Check my friends', who: null })).toBe('Check my friends');
  });

  it('says when, and how many more', () => {
    const base = { at: at(NOW + 15 * MIN), about: true, now: false };
    expect(planWhen(base, TZ)).toBe('About 10:15 AM');
    expect(planWhen({ ...base, about: false }, TZ)).toBe('10:15 AM');
    expect(planWhen({ ...base, now: true }, TZ)).toBe('Now');
    expect(planMoreWords(14, at(FIVE_PM), TZ)).toBe('And 14 more before 5:00 PM.');
    expect(planMoreWords(0, at(FIVE_PM), TZ)).toBe('');
    expect(planCounts('linkedin', { friend_request: 2 })).toEqual([
      { label: 'invitations to connect sent', count: 2 },
    ]);
  });
});

describe('what the extension says of its day', () => {
  const state = {
    ...freshState(TODAY, 12),
    tried: ['friend_request:a'],
    done: { friend_request: 1 },
    daily: { requests: 'None new.', comment_research: 'No comment research is running.' },
    line: 'Reading chat 3 of 60…',
    lineAt: NOW,
    nextAt: NOW + MIN,
  };

  it('is the part the day is planned from, and nothing of its window', () => {
    const said = planStateOf(state, { comment_research: 'No comment research is running.' });
    expect(said).not.toHaveProperty('tabId');
    expect(said).not.toHaveProperty('lists');
    // A job that didn't run for this person is left out.
    expect(said.daily).toEqual({ requests: 'None new.' });
    const kept = PlanState.parse(said);
    expect(kept).toMatchObject({ day: TODAY, tried: ['friend_request:a'], nextAt: NOW + MIN });
  });

  it('is worth sending again only when more than its line changed', () => {
    const before = planNoteKey(planStateOf(state));
    expect(
      planNoteKey(planStateOf({ ...state, line: 'Reading chat 4 of 60…', lineAt: NOW + 5 })),
    ).toBe(before);
    expect(planNoteKey(planStateOf({ ...state, working: true }))).not.toBe(before);
    expect(planNoteKey(planStateOf({ ...state, nextAt: NOW + 2 * MIN }))).not.toBe(before);
  });

  it('cuts a long line, and keeps the newest of a very long day', () => {
    const long = planStateOf({ ...state, daily: { requests: 'x'.repeat(2000) } });
    expect(long.daily!.requests).toHaveLength(PLAN_LINE_MOST);
    expect(PlanState.safeParse(long).success).toBe(true);
  });

  it('moves its times onto HandsFreeOS’s clock', () => {
    const kept = PlanState.parse(planStateOf({ ...state, againAt: { checks: NOW + 40 * MIN } }));
    const moved = onPlanClock(kept, -5000);
    expect(moved.nextAt).toBe(NOW + MIN - 5000);
    expect(moved.againAt.checks).toBe(NOW + 40 * MIN - 5000);
    expect(moved.roundAt).toBeNull();
    expect(onPlanClock(kept, 0)).toBe(kept);
  });
});
