/**
 * The day's first messages (docs/outreach.md, decision 126): why a network is short, what to try and where, the words
 * on Today, in the pushes and in the day's report, when the worker looks, and Cancel all's pace while requests are held.
 */
import { describe, expect, it } from 'vitest';
import type { WorkingHours } from '../../src/addons/outreach/automation';
import {
  fewAhead,
  GOAL_AHEAD_DAYS,
  GOAL_KNOWN_EARLY,
  GOAL_LATE_MS,
  GOAL_START_MINUTES,
  goalNote,
  goalPushWords,
  goalReportLine,
  goalStartDue,
  goalTimes,
  goalTries,
  goalTryPlace,
  goalWhy,
  goalWhyWords,
  nextGoalStart,
  NO_GOAL_FACTS,
  type GoalFacts,
  type GoalShort,
  type TodayGoal,
} from '../../src/addons/outreach/goal';
import { requestsHeldWords } from '../../src/addons/outreach/network-words';
import { NETWORKS } from '../../src/addons/outreach/networks';
import { cancelMostNow, CANCEL_FAST } from '../../src/addons/outreach/tidy';

const facts = (more: Partial<GoalFacts> = {}): GoalFacts => ({ ...NO_GOAL_FACTS, ...more });
const why = (more: Partial<Parameters<typeof goalWhy>[0]> = {}) =>
  goalWhy({
    short: 10,
    ready: true,
    facts: facts(),
    checksRoom: 0,
    requestsHeld: false,
    requests: { listed: 15, left: 15 },
    ...more,
  });

describe('why a network is short (decision 126)', () => {
  it('is nothing while it isn’t short', () => {
    expect(why({ short: 0, ready: false })).toBeNull();
  });

  it('takes the first reason that holds, in order', () => {
    expect(why({ ready: false, facts: facts({ weekChecked: 40, weekFit: 1 }) })).toBe('not_ready');
    // 3 of 40 fit this week: under 1 in 10.
    expect(why({ facts: facts({ weekChecked: 40, weekFit: 3 }), checksRoom: 20 })).toBe('few_fits');
    // Too few checked yet to say.
    expect(
      why({ facts: facts({ weekChecked: 19, weekFit: 0, unchecked: 5 }), checksRoom: 20 }),
    ).toBe('checking');
    expect(why({ facts: facts({ unchecked: 5 }), checksRoom: 0, requestsHeld: true })).toBe(
      'requests_held',
    );
    expect(why({ facts: facts({ sent: 30, accepted: 3 }) })).toBe('few_accepts');
    expect(why({ facts: facts({ sent: 9, accepted: 0 }), requests: { listed: 4, left: 15 } })).toBe(
      'few_found',
    );
    expect(why({ facts: facts({ sent: 30, accepted: 10 }) })).toBe('waiting_accepts');
  });

  it('says in the morning only what won’t fix itself as the day goes', () => {
    expect(GOAL_KNOWN_EARLY).not.toContain('checking');
    expect(GOAL_KNOWN_EARLY).not.toContain('waiting_accepts');
    expect(GOAL_KNOWN_EARLY).toContain('few_fits');
  });

  it('keeps two days ready ahead before it checks and searches no more than usual', () => {
    expect(GOAL_AHEAD_DAYS).toBe(2);
    expect(fewAhead(29, 15)).toBe(true);
    expect(fewAhead(30, 15)).toBe(false);
    // A network that sends none today needs none.
    expect(fewAhead(0, 0)).toBe(false);
  });
});

describe('what to try, and where', () => {
  it('joins groups where the network has them, else adds search words', () => {
    expect(goalTries('few_found', 'facebook', true)).toEqual(['groups', 'playbook', 'networks']);
    expect(goalTries('few_found', 'linkedin', true)).toEqual(['words', 'playbook', 'networks']);
    expect(goalTries('few_accepts', 'alignable', false)).toEqual(['profile', 'groups']);
  });

  it('offers another network only while one is off, and nothing while not ready or checking', () => {
    expect(goalTries('few_fits', 'facebook', false)).toEqual(['niche', 'playbook']);
    expect(goalTries('requests_held', 'facebook', false)).toEqual([]);
    expect(goalTries('not_ready', 'facebook', true)).toEqual([]);
    expect(goalTries('checking', 'facebook', true)).toEqual([]);
    expect(goalTries(null, 'facebook', true)).toEqual([]);
  });

  it('opens each where it’s done, the same on the web and the phone', () => {
    expect(goalTryPlace('niche', 'facebook')).toEqual({ view: 'playbooks' });
    expect(goalTryPlace('words', 'linkedin')).toEqual({ view: 'playbooks' });
    expect(goalTryPlace('groups', 'facebook')).toEqual({ view: 'groups' });
    expect(goalTryPlace('groups', 'alignable')).toEqual({ view: 'settings', part: 'alignable' });
    expect(goalTryPlace('profile', 'instagram')).toEqual({ view: 'settings', part: 'instagram' });
    expect(goalTryPlace('networks', 'linkedin')).toEqual({ view: 'settings', part: 'general' });
  });
});

const goal = (more: Partial<TodayGoal> = {}): TodayGoal => ({
  most: 15,
  done: 2,
  listed: 1,
  waitingOk: 1,
  short: 12,
  ahead: 3,
  requests: { listed: 15, left: 15 },
  more: true,
  why: 'few_fits',
  tries: ['niche', 'playbook'],
  facts: facts({ weekChecked: 40, weekFit: 3 }),
  ...more,
});

describe('the words', () => {
  it('says on Today how many short, the real reason, and that it’s looking for more', () => {
    expect(goalNote(goal(), 'facebook')).toBe(
      'Facebook is 12 short of today’s 15 first messages. Only 3 of the 40 people it checked this week fit your playbooks. It’s checking more people and searching again today on its own.',
    );
    expect(goalNote(goal({ short: 0 }), 'facebook')).toBeNull();
    expect(goalNote(goal({ why: null }), 'facebook')).toBeNull();
  });

  it('speaks each network’s own words', () => {
    expect(goalWhyWords('requests_held', facts(), 'linkedin')).toBe(
      'New invitations to connect are on hold, so fewer new connections come in to write to.',
    );
    expect(goalWhyWords('few_accepts', facts({ sent: 30, accepted: 3 }), 'facebook')).toBe(
      'Only 3 of the 30 friend requests sent in the last 14 days were accepted.',
    );
  });

  const short = (platform: GoalShort['platform'], more: Partial<GoalShort> = {}): GoalShort => ({
    platform,
    short: 12,
    most: 15,
    why: 'few_fits',
    facts: facts({ weekChecked: 40, weekFit: 3 }),
    ...more,
  });

  it('pushes the messages waiting for an OK, and a network that won’t reach the day’s', () => {
    expect(goalPushWords(0, [])).toBeNull();
    expect(goalPushWords(5, [])).toEqual({
      title: 'Today’s first messages',
      body: '5 messages are ready for your OK.',
    });
    expect(goalPushWords(1, [short('facebook')])?.body).toBe(
      '1 message is ready for your OK. Facebook won’t reach today’s 15 first messages: only 3 of the 40 people it checked this week fit your playbooks.',
    );
    expect(goalPushWords(0, [short('facebook'), short('linkedin')])?.body).toBe(
      'Facebook and LinkedIn won’t reach today’s first messages. Today says why, and what to try.',
    );
  });

  it('says it again in the day’s report', () => {
    expect(goalReportLine([])).toBe('');
    expect(goalReportLine([short('instagram', { short: 4 })])).toBe(
      ' Instagram fell 4 short: only 3 of the 40 people it checked this week fit your playbooks.',
    );
    expect(goalReportLine([short('facebook'), short('alignable')])).toBe(
      ' Facebook and Alignable fell short of today’s first messages. Today says why.',
    );
  });
});

describe('when the worker looks', () => {
  const hours: WorkingHours = { start: 9, end: 17, days: [1, 2, 3, 4, 5] };
  const tz = 'America/Chicago';
  // Thursday 29 October 2026, 9:00 in Chicago (CDT, UTC-5).
  const nine = Date.UTC(2026, 9, 29, 14, 0);

  it('looks half an hour into the hours, and again in the middle', () => {
    const { start, midday } = goalTimes('2026-10-29', hours, tz);
    expect(start).toBe(nine + GOAL_START_MINUTES * 60_000);
    expect(midday).toBe(nine + 4 * 3_600_000);
  });

  it('is due from the first look till a couple of hours after', () => {
    const start = nine + GOAL_START_MINUTES * 60_000;
    expect(goalStartDue(hours, tz, start - 1)).toBeNull();
    expect(goalStartDue(hours, tz, start)).toBe('2026-10-29');
    expect(goalStartDue(hours, tz, start + GOAL_LATE_MS - 1)).toBe('2026-10-29');
    expect(goalStartDue(hours, tz, start + GOAL_LATE_MS)).toBeNull();
  });

  it('comes back on the next working day, past the weekend', () => {
    const start = nine + GOAL_START_MINUTES * 60_000;
    expect(nextGoalStart(hours, tz, nine).getTime()).toBe(start);
    // Friday's look gone: Monday 2 November, after the clocks go back (CST, UTC-6).
    const friday = start + 86_400_000;
    expect(nextGoalStart(hours, tz, friday).toISOString()).toBe('2026-11-02T15:30:00.000Z');
  });
});

describe('Cancel all while requests are held (answer 9a)', () => {
  const most = NETWORKS.facebook.tidyLimits.cancel_request;
  const pace = (more: Partial<Parameters<typeof cancelMostNow>[1]> = {}) =>
    cancelMostNow('facebook', { going: true, waiting: 197, warned: false, slower: false, ...more });

  it('clears twice as many a day while 100 or more wait, back to the usual after', () => {
    expect(pace()).toBe(most * CANCEL_FAST.times);
    expect(pace({ waiting: 99 })).toBe(most);
    expect(pace({ going: false })).toBe(most);
  });

  it('halves on a warning, and only the usual pace while new there', () => {
    expect(pace({ warned: true })).toBe(most);
    expect(pace({ slower: true })).toBe(most * CANCEL_FAST.times);
    expect(pace({ waiting: 50, slower: true })).toBe(most / 2);
  });

  it('says the pace in Today’s note', () => {
    const held = { why: 'waiting' as const, count: 207, most: 200, extension: 0 };
    expect(requestsHeldWords({ ...held, cancelling: 187, cancelMost: 60 }, 'facebook')).toContain(
      '187 left, 60 a day.',
    );
    expect(requestsHeldWords(held, 'facebook')).toContain(`${most * CANCEL_FAST.times} a day`);
  });
});
