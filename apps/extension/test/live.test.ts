/**
 * What the extension tells HandsFreeOS about this computer (src/hfos/live.ts): the state it reports, the feed's cap,
 * how the runner's day follows HandsFreeOS's, which changes heard live it looks at, and how often a line alone goes.
 */
import { describe, expect, it } from 'vitest';
import {
  LINE_BEAT_SECONDS,
  LIVE_STEPS_UNSENT_MOST,
  PRE_DAY_LINE_SECONDS,
} from '@hfos/core/addons/outreach/live';
import { WATCHED_LINE_SECONDS } from '@hfos/core/addons/outreach/tallies';
import { freshState, type AutoState } from '../src/auto/plan';
import {
  beatWait,
  dayChange,
  liveEventFor,
  reportedStatus,
  samePlace,
  withStep,
  type Status,
  type Told,
  type Unsent,
} from '../src/hfos/live';

const ME = { userId: 'u-dana', businessId: 'b-one' };
const DAY = '2026-10-27';
const state = (more: Partial<AutoState> = {}): AutoState => ({ ...freshState(DAY), ...more });

describe('what it reports', () => {
  const on = { sending: 'steps' as const };

  it('says off when sending is off, whatever the runner shows', () => {
    expect(reportedStatus(state({ working: true }), { sending: 'off' }).state).toBe('off');
  });

  it('says stopped, working, trouble, waiting or idle, in that order', () => {
    expect(reportedStatus(state({ stopped: 'person', working: true }), on).state).toBe('stopped');
    expect(reportedStatus(state({ working: true, needs: true }), on).state).toBe('working');
    expect(reportedStatus(state({ needs: true, nextAt: 1 }), on).state).toBe('trouble');
    expect(reportedStatus(state({ nextAt: Date.UTC(2026, 9, 27, 15) }), on)).toMatchObject({
      state: 'waiting',
      nextAt: '2026-10-27T15:00:00.000Z',
    });
    expect(reportedStatus(state(), null).state).toBe('idle');
  });

  it('says it stands by while another computer works, unless it’s off or stopped', () => {
    expect(reportedStatus(state({ nextAt: 1 }), on, true).state).toBe('standby');
    expect(reportedStatus(state({ stopped: 'person' }), on, true).state).toBe('stopped');
    expect(reportedStatus(state(), { sending: 'off' }, true).state).toBe('off');
  });

  it('says which step before the first day it’s doing, only while it works on it', () => {
    expect(reportedStatus(state({ working: true, beforeNow: 'groups' }), on).doing).toBe('groups');
    expect(reportedStatus(state({ working: true }), on).doing).toBeNull();
    expect(reportedStatus(state({ beforeNow: 'groups', nextAt: 1 }), on).doing).toBeNull();
    expect(
      reportedStatus(state({ working: true, beforeNow: 'groups' }), on, true).doing,
    ).toBeNull();
  });

  it('keeps the line and when it was said', () => {
    const at = Date.UTC(2026, 9, 27, 14, 30);
    expect(reportedStatus(state({ line: 'Liked a post', lineAt: at }), on)).toMatchObject({
      line: 'Liked a post',
      lineAt: '2026-10-27T14:30:00.000Z',
    });
  });
});

describe('the feed waiting to go', () => {
  const step = (n: number): Unsent => ({
    ...ME,
    id: `id-${n}`,
    at: new Date(n).toISOString(),
    kind: 'done',
    line: `Step ${n}`,
  });

  it('lets the oldest go past the most it keeps', () => {
    let unsent: Unsent[] = [];
    for (let n = 0; n < LIVE_STEPS_UNSENT_MOST + 5; n++) unsent = withStep(unsent, step(n));
    expect(unsent).toHaveLength(LIVE_STEPS_UNSENT_MOST);
    expect(unsent[0]!.id).toBe('id-5');
  });

  it('tells one person and business from another', () => {
    expect(samePlace(ME, { ...ME })).toBe(true);
    expect(samePlace(ME, { ...ME, userId: 'u-riley' })).toBe(false);
    expect(samePlace(ME, { ...ME, businessId: 'b-two' })).toBe(false);
    expect(samePlace(ME, null)).toBe(false);
  });
});

describe('the runner’s day follows HandsFreeOS’s', () => {
  const server = (more: object) => ({
    date: DAY,
    state: 'none' as const,
    why: null,
    via: null,
    at: null,
    ...more,
  });

  it('starts and stops as pressed in the app', () => {
    expect(dayChange(state(), server({ state: 'started' }), false)).toEqual({
      started: true,
      stopped: null,
    });
    expect(
      dayChange(state({ started: true }), server({ state: 'stopped', why: 'person' }), false),
    ).toEqual({
      started: false,
      stopped: 'person',
    });
  });

  it('changes nothing when it’s already so', () => {
    expect(dayChange(state({ started: true }), server({ state: 'started' }), false)).toBeNull();
    expect(
      dayChange(state({ stopped: 'person' }), server({ state: 'stopped', why: 'person' }), false),
    ).toBeNull();
    expect(dayChange(state(), server({}), false)).toBeNull();
  });

  it('never undoes a warning seen here', () => {
    expect(
      dayChange(state({ stopped: 'warning' }), server({ state: 'started' }), false),
    ).toBeNull();
    expect(dayChange(state({ stopped: 'warning' }), server({}), false)).toBeNull();
  });

  it('stops for a warning seen on another computer', () => {
    expect(
      dayChange(state({ started: true }), server({ state: 'stopped', why: 'warning' }), false),
    ).toEqual({
      started: false,
      stopped: 'warning',
    });
  });

  it('waits while a press here is still to be sent, and for another day', () => {
    expect(
      dayChange(state({ started: true }), server({ state: 'stopped', why: 'person' }), true),
    ).toBeNull();
    expect(dayChange(state({ day: '2026-10-26' }), server({ state: 'started' }), false)).toBeNull();
  });

  it('goes back to the working hours when nothing was pressed today', () => {
    expect(dayChange(state({ started: true }), server({}), false)).toEqual({
      started: false,
      stopped: null,
    });
  });
});

describe('changes heard live', () => {
  it('looks at the person’s own, but not its own beat coming back', () => {
    const own = { type: 'outreach.live.changed', actorId: 'u-dana', entityId: 'c-here' };
    expect(liveEventFor(own, 'u-dana', 'c-here')).toBe(false);
    expect(liveEventFor({ ...own, entityId: 'c-other' }, 'u-dana', 'c-here')).toBe(true);
    expect(
      liveEventFor({ type: 'outreach.day.started', actorId: 'u-dana' }, 'u-dana', 'c-here'),
    ).toBe(true);
    // A ticker came on screen: this computer tells every few seconds from now. Another's line alone moves nothing.
    expect(
      liveEventFor({ type: 'outreach.live.watched', actorId: 'u-dana' }, 'u-dana', 'c-here'),
    ).toBe(true);
    expect(
      liveEventFor(
        { ...own, entityId: 'c-other', entityType: 'outreach_line' },
        'u-dana',
        'c-here',
      ),
    ).toBe(false);
  });

  it('leaves someone else’s alone, and hears nothing signed out', () => {
    expect(liveEventFor({ type: 'outreach.day.stopped', actorId: 'u-riley' }, 'u-dana', null)).toBe(
      false,
    );
    expect(liveEventFor({ type: 'outreach.day.stopped', actorId: 'u-dana' }, null, null)).toBe(
      false,
    );
  });
});

describe('how often it tells', () => {
  const at = Date.UTC(2026, 9, 27, 14);
  const last: Told = { state: 'waiting', line: 'Waiting', nextAt: null, at };
  const now = (more: Partial<Status> = {}): Status => ({
    state: 'waiting',
    line: 'Waiting',
    lineAt: null,
    nextAt: null,
    doing: null,
    ...more,
  });
  const none = { steps: 0, active: false, force: false };

  it('goes now the first time, for the heartbeat, a step, the person, or a new state', () => {
    expect(beatWait(null, now(), none, at)).toBe(0);
    expect(beatWait(last, now(), { ...none, force: true }, at)).toBe(0);
    expect(beatWait(last, now(), { ...none, steps: 1 }, at)).toBe(0);
    expect(beatWait(last, now(), { ...none, active: true }, at)).toBe(0);
    expect(beatWait(last, now({ state: 'working' }), none, at)).toBe(0);
  });

  it('has nothing to tell when nothing changed, or the next step moved by a moment', () => {
    expect(beatWait(last, now(), none, at + 1000)).toBe(-1);
    const next = { ...last, nextAt: '2026-10-27T15:00:00.000Z' };
    expect(beatWait(next, now({ nextAt: '2026-10-27T15:00:02.000Z' }), none, at)).toBe(-1);
  });

  it('sends a line alone at most every so often', () => {
    expect(beatWait(last, now({ line: 'Liked a post' }), none, at + 5_000)).toBe(
      LINE_BEAT_SECONDS * 1000 - 5_000,
    );
    expect(beatWait(last, now({ line: 'Liked a post' }), none, at + LINE_BEAT_SECONDS * 1000)).toBe(
      0,
    );
  });

  it('sends a line alone every few seconds while a ticker of the person’s is on screen (decision 140)', () => {
    const watched = { ...none, watched: true };
    expect(beatWait(last, now({ line: 'Liked a post' }), watched, at + 1_000)).toBe(
      WATCHED_LINE_SECONDS * 1000 - 1_000,
    );
    expect(
      beatWait(last, now({ line: 'Liked a post' }), watched, at + WATCHED_LINE_SECONDS * 1000),
    ).toBe(0);
    // Nothing new is still nothing to tell.
    expect(beatWait(last, now(), watched, at + 60_000)).toBe(-1);
  });

  it('sends a step before the first day’s count every few seconds, and goes now when that step changes', () => {
    const counting: Told = { ...last, state: 'working', doing: 'friends' };
    const reading = (n: number) =>
      now({
        state: 'working',
        doing: 'friends',
        line: `Reading your friends… ${n} friends so far.`,
      });
    expect(beatWait(counting, reading(40), none, at + 1_000)).toBe(
      PRE_DAY_LINE_SECONDS * 1000 - 1_000,
    );
    expect(beatWait(counting, reading(40), none, at + PRE_DAY_LINE_SECONDS * 1000)).toBe(0);
    expect(beatWait(counting, reading(40), none, at + 1_000)).toBeLessThan(
      LINE_BEAT_SECONDS * 1000 - 1_000,
    );
    expect(beatWait(counting, now({ state: 'working', doing: 'requests' }), none, at)).toBe(0);
    expect(beatWait(counting, now({ state: 'working' }), none, at)).toBe(0);
  });
});
