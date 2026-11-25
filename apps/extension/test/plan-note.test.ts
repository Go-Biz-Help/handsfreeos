/**
 * Where each network's day is up to, as the extension says it (src/hfos/plan.ts, decision 195): which runner's state
 * changed, what's said of it, and when it's worth saying again.
 */
import { describe, expect, it } from 'vitest';
import { PLATFORM_KEYS } from '@hfos/core/addons/outreach/networks';
import { PlanNoteInput, PLAN_LINE_MOST } from '@hfos/core/addons/outreach/plan';
import {
  AUTO_STATE_KEY,
  freshState,
  LINKEDIN_STATE_KEY,
  X_STATE_KEY,
  type AutoState,
} from '../src/auto/plan';
import { NO_RESEARCH } from '../src/jobs/comment-research';
import { PLAN_STATE_KEYS, planNote, planPlatforms, shortMark } from '../src/hfos/plan';

const ME = { userId: 'u-dana', businessId: 'b-one' };
const DAY = '2026-11-25';
const state = (more: Partial<AutoState> = {}): AutoState => ({ ...freshState(DAY), ...more });

describe('which networks’ days moved on', () => {
  it('knows every network’s runner by where it keeps its state', () => {
    expect(Object.keys(PLAN_STATE_KEYS).sort()).toEqual([...PLATFORM_KEYS].sort());
    expect(new Set(Object.values(PLAN_STATE_KEYS)).size).toBe(PLATFORM_KEYS.length);
  });

  it('picks them out of what changed in storage, and nothing else', () => {
    expect(
      planPlatforms({ [LINKEDIN_STATE_KEY]: {}, [AUTO_STATE_KEY]: {}, 'hfos.live': {} }),
    ).toEqual(['facebook', 'linkedin']);
    expect(planPlatforms({ [X_STATE_KEY]: {} })).toEqual(['x']);
    expect(planPlatforms({ 'hfos.settings': {} })).toEqual([]);
  });
});

describe('what’s said of a runner’s day', () => {
  it('is nothing for what isn’t a runner’s state', () => {
    expect(planNote(ME, undefined)).toBeNull();
    expect(planNote(ME, { tried: 'no' })).toBeNull();
  });

  it('is a note HandsFreeOS takes, whatever the day held', () => {
    const long = 'x'.repeat(PLAN_LINE_MOST + 80);
    const note = planNote(
      ME,
      state({
        started: true,
        working: true,
        tried: ['step:friend_request:abc'],
        done: { friend_request: 3 },
        daily: { requests: long, posts: 'Found 4 posts.' },
        line: long,
        lineAt: 1_795_000_000_000,
        nextAt: null,
      }),
    )!;
    const taken = PlanNoteInput.safeParse({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      platform: 'facebook',
      computer: '22222222-2222-4222-8222-222222222222',
      state: note.state,
    });
    expect(taken.success).toBe(true);
    expect(note.state.daily?.requests).toHaveLength(PLAN_LINE_MOST);
    expect(note.state.tried).toEqual(['step:friend_request:abc']);
  });

  it('leaves out the comment research when none runs for this person', () => {
    const none = planNote(
      ME,
      state({ daily: { comment_research: NO_RESEARCH, posts: 'Found 4.' } }),
    )!;
    expect(none.state.daily).toEqual({ posts: 'Found 4.' });
    const some = planNote(ME, state({ daily: { comment_research: 'Read 12 comments.' } }))!;
    expect(some.state.daily).toEqual({ comment_research: 'Read 12 comments.' });
  });
});

describe('when it’s worth saying again', () => {
  const before = planNote(ME, state({ working: true, line: 'Reading Austin Makers: 12 posts' }))!;

  it('isn’t for a new line alone', () => {
    const after = planNote(
      ME,
      state({ working: true, line: 'Reading Austin Makers: 40 posts', lineAt: 5 }),
    )!;
    expect(after.mark).toBe(before.mark);
  });

  it('is when a step is tried, a job ends, it stops working or its next time moves', () => {
    for (const more of [
      { working: true, tried: ['step:like:abc'] },
      { working: true, daily: { posts: 'Found 4 posts.' } },
      { working: false },
      { working: true, nextAt: 1_795_000_000_000 },
    ] satisfies Partial<AutoState>[])
      expect(planNote(ME, state(more))!.mark).not.toBe(before.mark);
  });

  it('is for someone else, or another business, whatever the day', () => {
    const same = state({ working: true });
    expect(planNote({ ...ME, userId: 'u-sam' }, same)!.mark).not.toBe(before.mark);
    expect(planNote({ ...ME, businessId: 'b-two' }, same)!.mark).not.toBe(before.mark);
  });

  it('is remembered by a short mark, never the day itself', () => {
    const mark = shortMark('x'.repeat(100_000));
    expect(mark.length).toBeLessThan(20);
    expect(shortMark('a')).not.toBe(shortMark('b'));
    expect(shortMark('abc')).toBe(shortMark('abc'));
  });
});
