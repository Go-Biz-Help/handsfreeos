/**
 * The day's first messages on the extension's side (docs/outreach.md, decision 126): checks a batch at a time through
 * the hours while the day needs more good fits (answer 4a), and the finding jobs done again, with the next words, while
 * a network is short (6a).
 */
import { describe, expect, it } from 'vitest';
import { SEARCH_AGAIN } from '@hfos/core/addons/outreach/goal';
import {
  afterDaily,
  AGAIN_MINUTES,
  FINDING_JOBS,
  freshState,
  nextDaily,
  nextRound,
  roundDue,
  soonestAgain,
  waitsAgain,
} from '../src/auto/plan';
import { moreToCome } from '../src/jobs/checks';
import { nextAlignableDaily, ALIGNABLE_FINDING } from '../src/auto/alignable';
import { nextInstagramDaily, INSTAGRAM_FINDING } from '../src/auto/instagram';
import { LINKEDIN_FINDING, nextLinkedInDaily } from '../src/auto/linkedin';

const NOW = Date.UTC(2026, 9, 29, 15, 0);
const MIN = 60_000;
const person = (i: number) => ({
  profileId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  name: `Person ${i}`,
  url: `https://www.facebook.com/person.${i}`,
  reason: 'friend' as const,
  mutual: false,
});

describe('checks a batch at a time (answer 4a)', () => {
  it('leaves more for later only when it got all it asked for and today has room', () => {
    const people = Array.from({ length: 40 }, (_, i) => person(i));
    expect(moreToCome({ people, today: 0, perDay: 150 }, 40)).toBe(true);
    // A usual day: the 40 are the day's.
    expect(moreToCome({ people, today: 0, perDay: 40 }, 40)).toBe(false);
    // Fewer to check than it asked for: nobody left.
    expect(moreToCome({ people: people.slice(0, 12), today: 0, perDay: 150 }, 40)).toBe(false);
    expect(moreToCome({ people, today: 110, perDay: 150 }, 40)).toBe(false);
  });

  it('keeps a batch with more to come for 35 to 60 minutes on, not done for the day', () => {
    const state = freshState('2026-10-29');
    const end = { line: 'Done. Checked 40 people for the AI.', warned: false, again: true };
    const soon = afterDaily(state, 'checks', end, NOW, 0);
    expect(soon.daily).toEqual({});
    expect(soon.againAt).toEqual({ checks: NOW + AGAIN_MINUTES[0] * MIN });
    expect(afterDaily(state, 'checks', end, NOW, 1).againAt).toEqual({
      checks: NOW + AGAIN_MINUTES[1] * MIN,
    });
    // The last batch, a warning, or one that went wrong: done for the day, nothing left to come.
    const last = afterDaily(soon, 'checks', { ...end, again: false }, NOW + 40 * MIN, 0.5);
    expect(last).toEqual({ daily: { checks: end.line }, againAt: {} });
    expect(afterDaily(soon, 'checks', { ...end, warned: true }, NOW, 0.5).daily).toEqual({
      checks: end.line,
    });
    expect(afterDaily(soon, 'checks', { ...end, failed: true }, NOW, 0.5).againAt).toEqual({});
  });

  it('passes over a job till its next batch is due, on every network', () => {
    const daily = {
      requests: '',
      tidy: '',
      occasions: '',
      group_checks: '',
      join: '',
      members: '',
      posts: '',
      active: '',
      chats: '',
      followers: '',
    };
    const waiting = { daily, againAt: { checks: NOW + 30 * MIN } };
    expect(waitsAgain(waiting, 'checks', NOW)).toBe(true);
    expect(nextDaily(waiting, NOW)).toBe('partners');
    expect(nextDaily(waiting, NOW + 30 * MIN)).toBe('checks');
    expect(soonestAgain(waiting, NOW)).toBe(NOW + 30 * MIN);
    // Done for the day: no batch to wait for.
    expect(soonestAgain({ ...waiting, daily: { ...daily, checks: 'Done.' } }, NOW)).toBeNull();
    expect(soonestAgain(waiting, NOW + 31 * MIN)).toBeNull();
    const others = { daily: { requests: '', tidy: '' }, againAt: { checks: NOW + MIN } };
    expect(nextLinkedInDaily(others, [], NOW)).toBe('occasions');
    expect(
      nextLinkedInDaily({ ...others, daily: { ...others.daily, occasions: '' } }, [], NOW),
    ).toBe('chats');
    expect(
      nextInstagramDaily(
        { daily: { requests: '', follow_backs: '', tidy: '' }, againAt: others.againAt },
        [],
        NOW,
      ),
    ).toBe('chats');
    expect(
      nextAlignableDaily(
        { daily: { my_groups: '', requests: '', tidy: '' }, againAt: others.againAt },
        [],
        NOW,
      ),
    ).toBe('chats');
  });

  it('starts each day with nothing to come', () => {
    expect(freshState('2026-10-30')).toMatchObject({
      againAt: {},
      more: false,
      round: 0,
      roundAt: null,
    });
  });
});

describe('finding people again while short (answer 6a)', () => {
  it('goes again while today’s list says more is needed, at most twice, 90 minutes apart', () => {
    expect(roundDue({ more: true }, NOW)).toBe(true);
    expect(roundDue({ more: false }, NOW)).toBe(false);
    expect(roundDue({ more: true, round: 1, roundAt: NOW - 89 * MIN }, NOW)).toBe(false);
    expect(roundDue({ more: true, round: 1, roundAt: NOW - SEARCH_AGAIN.minutes * MIN }, NOW)).toBe(
      true,
    );
    expect(roundDue({ more: true, round: SEARCH_AGAIN.rounds, roundAt: 0 }, NOW)).toBe(false);
  });

  it('does the network’s finding jobs once more, and notes the round', () => {
    const daily = {
      requests: 'Saved 2.',
      group_checks: '',
      join: '',
      members: '',
      checks: '',
      chats: '',
    };
    expect(nextRound({ daily, round: 0 }, FINDING_JOBS, NOW)).toEqual({
      daily: { requests: 'Saved 2.', chats: '' },
      round: 1,
      roundAt: NOW,
    });
    const after = nextRound({ daily, round: 0 }, FINDING_JOBS, NOW);
    expect(nextDaily(after, NOW)).toBe('tidy');
    expect(LINKEDIN_FINDING).toEqual(['posts', 'post_people', 'found_checks']);
    expect(INSTAGRAM_FINDING).toContain('like_yours');
    expect(ALIGNABLE_FINDING).toContain('search');
  });
});
