/**
 * Threads' and X's runners asking HandsFreeOS for their next move (src/auto/follows.ts `go`, src/hfos/plan.ts
 * `planNext`; docs/outreach.md decision 195, step 2), with the extension's storage, HandsFreeOS, the network's tab
 * and each of the runner's reads stood in for, so what a go chose to do is what's seen. Once its own checks let it
 * work it asks, with what only this computer knows, and does the move it's sent as it does its own: the read, the
 * wait, the piece of its list's work HandsFreeOS picked, and what the move changed in its day. It plans the go itself,
 * as it always has, whenever HandsFreeOS doesn't decide, can't be reached, or sends a move it can't do; it never asks
 * while its own checks hold it; and it never saves the person's lists while they're at their computer.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TodayList, TodayListItem } from '../src/hfos/messages';

const X = 'https://x.com';
const ME = { userId: 'u-casey', businessId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' };
const COMPUTER = '5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f';
const TZ = 'America/Chicago';
const MIN = 60_000;
const NEXT = '/v1/queries/outreach.plan.next';
const TODAY_LIST = '/v1/queries/outreach.today';

vi.setConfig({ testTimeout: 30_000 });

const world = vi.hoisted(() => ({
  /** What the runner did, in order: each read by its name, each page it opened. */
  did: [] as string[],
  opened: [] as string[],
  asked: [] as { type: string; input?: unknown }[],
  posted: [] as { path: string; body: Record<string, unknown> }[],
  answers: {} as Record<string, (body: Record<string, unknown>) => unknown>,
  hfos: {} as Record<string, (ask: Record<string, unknown>) => unknown>,
  choices: {} as Record<string, unknown>,
  hours: { start: 0, end: 24, days: [0, 1, 2, 3, 4, 5, 6] } as Record<string, unknown>,
  kept: null as Record<string, unknown> | null,
  away: true,
  noting: true,
  asking: false,
  warned: null as { words: string[] } | null,
}));

vi.mock('../src/hfos/session', () => {
  class Refused extends Error {
    constructor(readonly problem: { readonly message: string; readonly status?: number | null }) {
      super(problem.message);
    }
  }
  return {
    Refused,
    savingTo: async () => ME,
    answer: async (ask: { type: string; input?: unknown }) => {
      world.asked.push(ask);
      const found = world.hfos[ask.type];
      return { ok: true, value: found ? found(ask as Record<string, unknown>) : {} };
    },
    answerWith: async (_t: string, fn: () => Promise<unknown>) => ({ ok: true, value: await fn() }),
    api: () => ({
      POST: async (path: string, options: { body: Record<string, unknown> }) => {
        world.posted.push({ path, body: options.body });
        const found = world.answers[path];
        return found
          ? { data: found(options.body), response: { ok: true, status: 200 } }
          : { error: {}, response: { ok: false, status: 503 } };
      },
    }),
    call: async (request: Promise<{ data?: unknown; response: { ok: boolean } }>) => {
      const result = await request;
      if (result.response.ok) return result.data;
      throw new Refused({ message: 'Couldn’t reach HandsFreeOS.' });
    },
  };
});
vi.mock('../src/hfos/follow', () => ({
  SETTINGS_KEY: 'hfos.settings',
  follow: async () => undefined,
  loadSettings: async () => ({
    timezone: 'America/Chicago',
    settings: {
      voice: { split: true },
      hours: world.hours,
      networks: { x: world.choices, threads: world.choices },
    },
  }),
}));
vi.mock('../src/hfos/live', async (original) => ({
  ...(await original<object>()),
  keptFor: async () => world.kept,
  onBeat: () => undefined,
  feed: async () => undefined,
  computer: async () => ({ id: COMPUTER, fresh: false, name: 'Chrome on Mac', version: '0.156.0' }),
}));
vi.mock('../src/hfos/noting', async (original) => ({
  ...(await original<object>()),
  isNoting: async () => world.noting,
  takeNote: async () => undefined,
  noteNeed: async () => undefined,
}));
vi.mock('../src/hfos/warned', async (original) => ({
  ...(await original<object>()),
  warnedNow: async () => world.warned,
}));
vi.mock('../src/hfos/waiting', () => ({
  POPUP_ID: 'hfos-waiting',
  popUp: async () => undefined,
  waitingSoon: () => undefined,
}));
vi.mock('../src/hfos/looked', () => ({ noteWarnings: async () => undefined }));
vi.mock('../src/networks/on', async (original) => ({
  ...(await original<object>()),
  isWorking: () => true,
  statesNow: async () => ({}),
}));
vi.mock('../src/away', async (original) => ({
  ...(await original<object>()),
  awayNow: async () => world.away,
}));
vi.mock('../src/auto/run', () => ({ tick: async () => undefined }));
vi.mock('../src/auto/turns', async (original) => ({
  ...(await original<object>()),
  askInLine: () => world.asking,
  inTurn: <T>(_who: string, work: () => Promise<T>) => work(),
}));
vi.mock('../src/auto/retry', () => ({
  retryAfterUpdate: async () => undefined,
  clearRetried: async () => undefined,
  handsOver: () => false,
}));
vi.mock('../src/auto/helper', async (original) => ({
  ...(await original<object>()),
  helpAfter: async (at: { outcome: unknown }) => ({ outcome: at.outcome, reportId: null }),
}));
vi.mock('../src/jobs/job', async (original) => ({
  ...(await original<object>()),
  pause: () => Promise.resolve(),
}));

// Each of its reads, stood in for: what's seen here is which one a go chose.
const read = (name: string) => async () => {
  world.did.push(name);
  return { line: `Did ${name}.`, warned: false };
};
vi.mock('../src/jobs/follows/search', () => ({ hourlySearch: read('search') }));
vi.mock('../src/jobs/follows/replies', () => ({
  readCommentReplies: async () => ({ line: 'No new replies.', warned: false }),
}));
vi.mock('../src/jobs/follows/people', () => ({
  saveFollowers: read('requests'),
  lookForFollowBacks: read('follow_backs'),
}));
vi.mock('../src/jobs/follows/unfollow', () => ({ unfollowOnItsOwn: read('tidy') }));
vi.mock('../src/jobs/follows/chats', () => ({
  readFollowChats: read('chats'),
  followChatPage: async () => null,
}));
vi.mock('../src/jobs/follows/post-people', () => ({
  readPostRepliers: async (job: { round?: number }) => {
    world.did.push(`post_people:${job.round ?? 0}`);
    return { line: 'Read who replied.', warned: false };
  },
}));
vi.mock('../src/jobs/found-checks', () => ({ checkFound: read('found_checks') }));
vi.mock('../src/jobs/follows/comment-research', () => ({
  readFollowComments: read('comment_research'),
}));
vi.mock('../src/jobs/own-read', () => ({ readProfileOnItsOwn: read('profile') }));
vi.mock('../src/auto/lists', async (original) => ({
  ...(await original<object>()),
  doBeforeDay: async (step: { do: string; list?: string }) => {
    world.did.push(`before:${step.list ?? step.do}`);
    return { line: 'Saved 3 followers.', warned: false };
  },
}));
// The network's tab opens no page here: a step on the list gets as far as its first page, which is what's seen.
vi.mock('../src/tab', () => ({
  WorkTab: class {
    readonly tabId = null;
    async adopt() {}
    async focus() {}
    async loaded() {}
    async keepInFront() {}
    async close() {}
    async inFront<T>(work: () => Promise<T>) {
      return work();
    }
    async open(url: string) {
      world.opened.push(url);
      throw new Error(`No page for ${url}`);
    }
    async ask() {
      return { ok: false, error: 'No tab.' };
    }
  },
}));

const store = new Map<string, unknown>();
const alarms = new Map<string, number>();
beforeAll(() => {
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (keys: string | string[]) =>
          Object.fromEntries(
            [keys]
              .flat()
              .filter((k) => store.has(k))
              .map((k) => [k, store.get(k)]),
          ),
        set: async (values: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(values)) store.set(k, JSON.parse(JSON.stringify(v)));
        },
        remove: async (keys: string | string[]) => {
          for (const k of [keys].flat()) store.delete(k);
        },
      },
      session: { get: async () => ({}), set: async () => undefined },
      onChanged: { addListener: () => undefined },
    },
    runtime: {
      getPlatformInfo: async () => ({ os: 'mac' }),
      getManifest: () => ({ version: '0.156.0' }),
    },
    alarms: {
      get: async (name: string) => (alarms.has(name) ? { name } : undefined),
      create: async (name: string, info: { when: number }) => void alarms.set(name, info.when),
      clear: async (name: string) => alarms.delete(name),
    },
    notifications: { clear: async () => true },
  });
});
afterAll(() => vi.unstubAllGlobals());

const { FOLLOW_RUNNERS } = await import('../src/auto/follows');
const { changeKept } = await import('../src/hfos/plan');
const { freshState, THREADS_STATE_KEY, workKey, X_STATE_KEY } = await import('../src/auto/plan');
const { businessDay } = await import('@hfos/core/addons/outreach/automation');
const { ASK_FIRST_WORDS } = await import('@hfos/core/addons/outreach/asks');
const { NO_LISTS } = await import('@hfos/core/addons/outreach/lists');
const { followDailyOn, FOLLOW_FINDING } = await import('@hfos/core/addons/outreach/runners');
const { nextMove, planDayOf, PlanState } = await import('@hfos/core/addons/outreach/plan');
const { changeSent, moveSent } = await import('@hfos/core/addons/outreach/plan-next');

type State = ReturnType<typeof freshState>;
const today = () => businessDay(Date.now(), TZ);
const iso = (ms: number) => new Date(ms).toISOString();
/** Their followers saved and who to unfollow worked out, today: nothing's due before the day. */
const savedLists = () => ({ ...NO_LISTS, friendsAt: iso(Date.now()), tidyAt: iso(Date.now()) });
const stateOn = (key: string) => store.get(key) as State;
/** A day on the network with its search not due for a while, so its own next move is a once-a-day read. */
const begin = (key: string, more: Partial<State> = {}) =>
  store.set(key, { ...freshState(today()), watchAt: Date.now() + 40 * MIN, ...more });
const asks = () => world.posted.filter((p) => p.path === NEXT);
const told = (move: Record<string, unknown>, more: Record<string, unknown> = {}) => {
  world.answers[NEXT] = () => ({ decides: true, move, change: null, list: null, ...more });
};

const person = (name: string, handle: string): TodayListItem =>
  ({
    kind: 'friend_request',
    name,
    profileId: `p-${handle}`,
    profileUrl: `${X}/${handle}`,
    chatId: null,
    threadKey: null,
    postId: null,
    postUrl: null,
    posted: null,
    post: null,
    asking: false,
    why: [],
    summary: null,
    nextStep: null,
    playbookName: null,
    demoLink: null,
    videoLink: null,
    personId: null,
    demoBooked: false,
    send: null,
    recent: [],
  }) as unknown as TodayListItem;
const DANA = person('Dana Reyes', 'dana_reyes');
const SAM = person('Sam Lee', 'sam_lee');
const listOf = (items: TodayListItem[]): TodayList =>
  ({
    items,
    partners: [],
    auto: ['warm_up', 'friend_request'],
    messages: [],
    sending: 'steps',
    limits: { like: { most: 80, done: 0 } },
    goal: null,
    retryAt: null,
  }) as unknown as TodayList;

beforeEach(() => {
  store.clear();
  alarms.clear();
  world.did.length = 0;
  world.opened.length = 0;
  world.asked.length = 0;
  world.posted.length = 0;
  world.answers = {};
  world.hfos = {
    'hfos-lists': savedLists,
    'hfos-comment-research-next': () => ({ research: null }),
  };
  world.choices = { on: true, sending: 'steps', collect: true, warmUp: true };
  world.hours = { start: 0, end: 24, days: [0, 1, 2, 3, 4, 5, 6] };
  world.kept = { working: true, workingName: null, days: {} };
  world.away = true;
  world.noting = true;
  world.asking = false;
  world.warned = null;
  begin(X_STATE_KEY);
});

const x = FOLLOW_RUNNERS.x;

describe('a go that HandsFreeOS decides (decision 195, step 2)', () => {
  it('asks with where its day is up to, its own clock, and what only this computer knows', async () => {
    world.away = false;
    told({ do: 'wait', why: 'idle', until: Date.now() + 30 * MIN });
    const before = Date.now();
    await x.tick();
    expect(asks()).toHaveLength(1);
    const { body } = asks()[0]!;
    expect(body).toMatchObject({
      workspaceId: ME.businessId,
      platform: 'x',
      computer: COMPUTER,
      here: { away: false, passOver: [], research: false, asking: false },
    });
    expect(body.now).toBeGreaterThanOrEqual(before);
    expect(body.now).toBeLessThanOrEqual(Date.now());
    expect(body.random).toBeGreaterThanOrEqual(0);
    expect(body.random).toBeLessThanOrEqual(1);
    // The state as it stands now: today's, with the comment research HandsFreeOS said isn't theirs kept for the day.
    const state = body.state as Record<string, unknown>;
    expect(state.day).toBe(today());
    expect(state.tried).toEqual([]);
    expect(state.daily).toHaveProperty('comment_research');
  });

  it('does the read it’s sent, not the one it would have picked, and waits as long as it’s told', async () => {
    told({ do: 'daily', job: 'follow_backs', gap: 6 * MIN });
    const before = Date.now();
    await x.tick();
    // By itself, its newest followers come first.
    expect(world.did).toEqual(['follow_backs']);
    const state = stateOn(X_STATE_KEY);
    expect(state.daily).toMatchObject({ follow_backs: 'Did follow_backs.' });
    expect(state.daily).not.toHaveProperty('requests');
    expect(state.readLast).toBe(true);
    expect(alarms.get(x.alarm)).toBeGreaterThanOrEqual(before + 6 * MIN);
    expect(alarms.get(x.alarm)).toBeLessThan(Date.now() + 6 * MIN + 1_000);
  });

  it('never goes again sooner than its own pace, whatever wait comes with a read', async () => {
    told({ do: 'search', gap: 1_000 });
    const before = Date.now();
    await x.tick();
    expect(world.did).toEqual(['search']);
    expect(alarms.get(x.alarm)).toBeGreaterThanOrEqual(before + 3 * MIN);
  });

  it('does the step before its day it’s sent, once the person’s away', async () => {
    world.hfos['hfos-lists'] = () => NO_LISTS;
    told({ do: 'before', step: { do: 'save', list: 'friends', first: true }, gap: 4 * MIN });
    await x.tick();
    expect(world.did).toEqual(['before:friends']);
    expect(stateOn(X_STATE_KEY).before).toMatchObject({ friends: 'Saved 3 followers.' });
    // And one it wouldn't have picked: with their lists saved, by itself it would read their newest followers.
    world.did.length = 0;
    world.hfos['hfos-lists'] = savedLists;
    begin(X_STATE_KEY);
    told({ do: 'before', step: { do: 'tidy' }, gap: 4 * MIN });
    await x.tick();
    expect(world.did).toEqual(['before:tidy']);
  });

  it('waits as it’s told, with its own words for each wait, and looks again when HandsFreeOS said', async () => {
    const until = Date.now() + 7 * MIN;
    told({ do: 'wait', why: 'asks', until });
    await x.tick();
    expect(world.did).toEqual([]);
    expect(stateOn(X_STATE_KEY)).toMatchObject({ line: ASK_FIRST_WORDS, nextAt: until });
    expect(alarms.get(x.alarm)).toBe(until);

    told({ do: 'wait', why: 'idle', until: until + MIN });
    await x.tick();
    expect(stateOn(X_STATE_KEY).line).toMatch(/^Nothing on your X list for it to do yet\./);
    expect(stateOn(X_STATE_KEY).nextAt).toBe(until + MIN);

    told({ do: 'wait', why: 'hours', until: until + 2 * MIN });
    await x.tick();
    expect(stateOn(X_STATE_KEY).line).toMatch(/Start my day for X/);
    expect(stateOn(X_STATE_KEY).nextAt).toBe(until + 2 * MIN);

    // A warning HandsFreeOS knows of holds it till it asks again: its own state is left to what this computer saw.
    told({ do: 'wait', why: 'warned', until: until + 3 * MIN });
    await x.tick();
    expect(stateOn(X_STATE_KEY).line).toMatch(/^Stopped: X warned you today\./);
    expect(stateOn(X_STATE_KEY).stopped).toBeNull();
    expect(stateOn(X_STATE_KEY).nextAt).toBe(until + 3 * MIN);

    told({ do: 'wait', why: 'screen', until: until + 4 * MIN });
    await x.tick();
    expect(stateOn(X_STATE_KEY).line).toMatch(
      /^Your first day on X starts once your followers are saved\./,
    );

    told({ do: 'wait', why: 'off', until: null });
    await x.tick();
    expect(stateOn(X_STATE_KEY).nextAt).toBeNull();
    expect(alarms.has(x.alarm)).toBe(false);
    expect(world.did).toEqual([]);
    expect(asks()).toHaveLength(6);
  });

  it('does the piece of its list’s work HandsFreeOS picked first, from the list sent with it', async () => {
    const list = listOf([DANA, SAM]);
    const key = workKey({ do: 'step', item: SAM });
    told(
      {
        do: 'work',
        key,
        left: 1,
        gap: 5 * MIN,
        reading: false,
        day: { started: true, until: null },
        answering: false,
      },
      { list },
    );
    await x.tick();
    // By itself, Dana is first on the list.
    expect(world.opened[0]).toBe(SAM.profileUrl);
    expect(world.opened).not.toContain(DANA.profileUrl);
    expect(stateOn(X_STATE_KEY).tried).toEqual([key]);
    // The list came with the answer: it isn't asked for again.
    expect(world.posted.map((p) => p.path)).not.toContain(TODAY_LIST);
    expect(world.did).toEqual([]);
  });

  it('keeps what the move changed in its day: a round of finding again begun', async () => {
    const lines = Object.fromEntries(
      followDailyOn('x').map((job) => [job, `Own line for ${job}.`]),
    );
    begin(X_STATE_KEY, { daily: lines });
    const still = Object.fromEntries(
      Object.entries(lines)
        .filter(([job]) => !(FOLLOW_FINDING as readonly string[]).includes(job))
        .map(([job]) => [job, 'Clipped.']),
    );
    const roundAt = Date.now() - 1_000;
    told(
      { do: 'daily', job: 'post_people', gap: 4 * MIN },
      { change: { daily: still, round: 1, roundAt } },
    );
    await x.tick();
    // The read asks HandsFreeOS with the round it's in.
    expect(world.did).toEqual(['post_people:1']);
    const state = stateOn(X_STATE_KEY);
    expect(state).toMatchObject({ round: 1, roundAt });
    // Each line stays its own; the finding jobs are to do once more, and the one it did is done again.
    expect(state.daily).toMatchObject({
      requests: 'Own line for requests.',
      tidy: 'Own line for tidy.',
      post_people: 'Read who replied.',
    });
    expect(state.daily).not.toHaveProperty('found_checks');
  });

  it('answers outside its hours only as it’s sent: Threads waits, or reads a comment research', async () => {
    const threads = FOLLOW_RUNNERS.threads;
    // No working hours today, and nothing pressed.
    world.hours = { start: 9, end: 17, days: [(new Date().getDay() + 3) % 7], everyDay: false };
    begin(THREADS_STATE_KEY);
    const until = Date.now() + 90 * MIN;
    told({ do: 'wait', why: 'hours', until });
    await threads.tick();
    expect(world.did).toEqual([]);
    expect(stateOn(THREADS_STATE_KEY).nextAt).toBe(until);
    expect(asks()[0]!.body).toMatchObject({ platform: 'threads' });

    told({ do: 'daily', job: 'comment_research', gap: 4 * MIN });
    await threads.tick();
    expect(world.did).toEqual(['comment_research']);
    // Outside the hours the list has no turn to take.
    expect(stateOn(THREADS_STATE_KEY).readLast).not.toBe(true);
  });
});

describe('a go it plans itself, as it always has', () => {
  const itsOwn = async () => {
    world.did.length = 0;
    world.opened.length = 0;
    begin(X_STATE_KEY);
    await x.tick();
    return [...world.did];
  };

  it('goes on by its own order when HandsFreeOS can’t be reached, or leaves the order to it', async () => {
    // No answer at all: no connection, or a HandsFreeOS from before runners asked.
    expect(await itsOwn()).toEqual(['requests']);
    expect(asks()).toHaveLength(1);
    world.answers[NEXT] = () => ({ decides: false, move: null, change: null, list: null });
    expect(await itsOwn()).toEqual(['requests']);
    world.answers[NEXT] = () => {
      throw new Error('The answer never came.');
    };
    expect(await itsOwn()).toEqual(['requests']);
    expect(stateOn(X_STATE_KEY).daily).toMatchObject({ requests: 'Did requests.' });
  });

  it('plans for itself when it’s sent a move it can’t do as things stand', async () => {
    // A read that isn't X's: nothing is written in anyone's messages there.
    told({ do: 'daily', job: 'chats', gap: 4 * MIN });
    expect(await itsOwn()).toEqual(['requests']);
    // A move from a later HandsFreeOS.
    told({ do: 'dance', gap: 4 * MIN });
    expect(await itsOwn()).toEqual(['requests']);
    // Facebook's newest posts aren't X's to watch.
    told({ do: 'watch', gap: 4 * MIN });
    expect(await itsOwn()).toEqual(['requests']);
    // A piece of work that isn't on the list sent with it, and one sent with no list.
    const work = {
      do: 'work',
      key: 'step:friend_request:someone-else',
      left: 0,
      gap: 4 * MIN,
      reading: false,
      day: { started: true, until: null },
      answering: false,
    };
    told(work, { list: listOf([DANA]) });
    expect(await itsOwn()).toEqual(['requests']);
    expect(world.opened).toEqual([]);
    told(work);
    expect(await itsOwn()).toEqual(['requests']);
    // A step before the day that isn't one of X's.
    told({ do: 'before', step: { do: 'group_checks' }, gap: 4 * MIN });
    expect(await itsOwn()).toEqual(['requests']);
  });

  it('never saves their lists while they’re at their computer, whatever it’s sent', async () => {
    world.away = false;
    world.hfos['hfos-lists'] = () => NO_LISTS;
    told({ do: 'before', step: { do: 'save', list: 'friends', first: true }, gap: 4 * MIN });
    expect(await itsOwn()).toEqual([]);
    expect(stateOn(X_STATE_KEY).line).toMatch(/waits till you’ve been away from your computer/);
    expect(asks()[0]!.body.here).toMatchObject({ away: false });
  });

  it('never asks while its own checks hold it: an ask of theirs in line, noting off, a warning, standby, Sending off', async () => {
    told({ do: 'daily', job: 'follow_backs', gap: 4 * MIN });
    world.asking = true;
    expect(await itsOwn()).toEqual([]);
    expect(stateOn(X_STATE_KEY).line).toBe(ASK_FIRST_WORDS);
    world.asking = false;

    world.noting = false;
    expect(await itsOwn()).toEqual([]);
    expect(stateOn(X_STATE_KEY).needs).toBe(true);
    world.noting = true;

    world.warned = { words: ['Slow down'] };
    expect(await itsOwn()).toEqual([]);
    expect(stateOn(X_STATE_KEY).stopped).toBe('warning');
    world.warned = null;

    world.kept = { working: false, workingName: 'Chrome on Windows', days: {} };
    expect(await itsOwn()).toEqual([]);
    world.kept = { working: true, workingName: null, days: {} };

    world.choices = { ...world.choices, sending: 'off' };
    expect(await itsOwn()).toEqual([]);
    expect(asks()).toEqual([]);

    // Free again, it asks and does as it's sent.
    world.choices = { ...world.choices, sending: 'steps' };
    expect(await itsOwn()).toEqual(['follow_backs']);
    expect(asks()).toHaveLength(1);
  });
});

describe('the move HandsFreeOS’s rules send is the one the runner would have picked', () => {
  /**
   * HandsFreeOS's answer, worked out as `outreach.plan.next` does (packages/core/src/addons/outreach/ops/plan.ts):
   * the day's rules on what it knows (here, what this test's world says) and what the runner said.
   */
  const asHandsFreeOS = (platform: 'x' | 'threads', list: TodayList) => {
    world.answers[NEXT] = (body) => {
      const kept = planDayOf(PlanState.parse(body.state));
      const facts = {
        platform,
        now: body.now as number,
        timeZone: TZ,
        hours: world.hours as never,
        choices: world.choices as never,
        noting: world.noting,
        day: ((world.kept?.days as Record<string, never> | undefined) ?? {})[platform] ?? null,
        warned: world.warned !== null,
        asks: 0,
        lists: world.hfos['hfos-lists']!({}) as never,
        list: list as never,
      };
      const { move, state } = nextMove(facts, kept, body.random as number, body.here as never);
      return {
        decides: true,
        move: moveSent(move, 0),
        change: changeSent(kept, state, 0),
        list: move.do === 'work' ? list : null,
      };
    };
  };
  const allRead = (platform: 'x' | 'threads') =>
    Object.fromEntries(followDailyOn(platform).map((job) => [job, `Read ${job}.`]));
  const notToday = () => ({
    start: 9,
    end: 17,
    days: [(new Date().getDay() + 3) % 7],
    everyDay: false,
  });
  const reply = { ...person('Lee Ortiz', 'lee_ortiz'), kind: 'reply', threadKey: 't-9' };

  /** Each: the network, the day so far, today's list, and what else is so. */
  const scenes: Record<
    string,
    {
      readonly on?: 'threads';
      readonly state?: () => Partial<State>;
      readonly list?: () => TodayList;
      readonly world?: () => void;
    }
  > = {
    'its hour’s search is due': { state: () => ({ watchAt: null }) },
    'a once-a-day read is next': {},
    'the list’s turn, after a read': {
      state: () => ({ readLast: true }),
      list: () => listOf([DANA, SAM]),
    },
    'the day’s reading done, and a list to work': {
      state: () => ({ daily: allRead('x') }),
      list: () => listOf([DANA, SAM]),
    },
    'someone on the list tried already today': {
      state: () => ({ daily: allRead('x'), tried: [workKey({ do: 'step', item: DANA })] }),
      list: () => listOf([DANA, SAM]),
    },
    'nothing left to do': { state: () => ({ daily: allRead('x') }) },
    'a first day, with the person at their computer': {
      world: () => {
        world.away = false;
        world.hfos['hfos-lists'] = () => NO_LISTS;
      },
    },
    'a first day, with the person away': {
      world: () => void (world.hfos['hfos-lists'] = () => NO_LISTS),
    },
    'their followers due again, with the person at their computer': {
      world: () => {
        world.away = false;
        const old = iso(Date.now() - 8 * 24 * 60 * MIN);
        world.hfos['hfos-lists'] = () => ({ ...NO_LISTS, friendsAt: old, tidyAt: old });
      },
    },
    'who to unfollow not worked out yet': {
      world: () =>
        void (world.hfos['hfos-lists'] = () => ({ ...NO_LISTS, friendsAt: iso(Date.now()) })),
    },
    'short of good fits, with the day’s reading done': {
      state: () => ({ daily: allRead('x'), more: true }),
      list: () => ({ ...listOf([]), goal: { more: true } }) as unknown as TodayList,
    },
    'Collect off, and a list to work': {
      list: () => listOf([DANA, SAM]),
      world: () => void (world.choices = { ...world.choices, collect: false }),
    },
    'Collect off, and nothing on the list': {
      world: () => void (world.choices = { ...world.choices, collect: false }),
    },
    'a comment research of theirs is reading': {
      world: () =>
        void (world.hfos['hfos-comment-research-next'] = () => ({ research: { id: 'r-1' } })),
    },
    'their day started by hand, outside the hours': {
      list: () => listOf([DANA]),
      state: () => ({ daily: allRead('x') }),
      world: () => {
        world.hours = notToday();
        world.kept = {
          working: true,
          workingName: null,
          days: { x: { date: today(), state: 'started', why: null } },
        };
      },
    },
    'outside the hours on X': {
      list: () => listOf([DANA]),
      world: () => void (world.hours = notToday()),
    },
    'outside the hours on Threads, with someone who wrote back': {
      on: 'threads',
      list: () =>
        ({
          ...listOf([DANA, reply as TodayListItem]),
          messages: ['reply'],
        }) as unknown as TodayList,
      world: () => void (world.hours = notToday()),
    },
    'outside the hours on Threads, with a comment research reading': {
      on: 'threads',
      world: () => {
        world.hours = notToday();
        world.hfos['hfos-comment-research-next'] = () => ({ research: { id: 'r-1' } });
      },
    },
    'Stop for today pressed': {
      list: () => listOf([DANA]),
      world: () =>
        void (world.kept = {
          working: true,
          workingName: null,
          days: { x: { date: today(), state: 'stopped', why: null } },
        }),
    },
  };

  for (const [name, scene] of Object.entries(scenes))
    it(`${name}`, async () => {
      const platform = scene.on ?? 'x';
      const key = platform === 'x' ? X_STATE_KEY : THREADS_STATE_KEY;
      const runner = FOLLOW_RUNNERS[platform];
      const go = async (decided: boolean) => {
        store.clear();
        alarms.clear();
        world.did.length = 0;
        world.opened.length = 0;
        world.posted.length = 0;
        begin(key, scene.state?.() ?? {});
        const list = scene.list?.() ?? listOf([]);
        world.answers = { [TODAY_LIST]: () => list };
        if (decided) asHandsFreeOS(platform, list);
        await runner.tick();
        const state = stateOn(key);
        return {
          did: [...world.did],
          opened: [...world.opened],
          line: state.line,
          tried: state.tried,
          read: Object.keys(state.daily ?? {}).sort(),
          round: state.round ?? 0,
          stopped: state.stopped,
          readLast: state.readLast ?? false,
          needs: state.needs ?? false,
          wakes: alarms.has(runner.alarm),
        };
      };
      scene.world?.();
      const itself = await go(false);
      const sent = await go(true);
      expect(asks()).toHaveLength(platform === 'x' && name === 'Stop for today pressed' ? 0 : 1);
      expect(sent).toEqual(itself);
    });

  it('covers what a go can come to: a search, each kind of read, the list’s work, and each wait', async () => {
    // What the scenes above came to, by themselves: a guard that they stay worth comparing.
    const seen = new Set<string>();
    for (const [name, scene] of Object.entries(scenes)) {
      const platform = scene.on ?? 'x';
      const key = platform === 'x' ? X_STATE_KEY : THREADS_STATE_KEY;
      store.clear();
      world.did.length = 0;
      world.opened.length = 0;
      world.choices = { on: true, sending: 'steps', collect: true, warmUp: true };
      world.hours = { start: 0, end: 24, days: [0, 1, 2, 3, 4, 5, 6] };
      world.kept = { working: true, workingName: null, days: {} };
      world.away = true;
      world.hfos = {
        'hfos-lists': savedLists,
        'hfos-comment-research-next': () => ({ research: null }),
      };
      begin(key, scene.state?.() ?? {});
      const list = scene.list?.() ?? listOf([]);
      world.answers = { [TODAY_LIST]: () => list };
      scene.world?.();
      await FOLLOW_RUNNERS[platform].tick();
      seen.add(
        world.did[0]?.replace(/:.*/, '') ?? (world.opened.length ? 'work' : `wait: ${name}`),
      );
    }
    for (const kind of ['search', 'requests', 'before', 'post_people', 'comment_research', 'work'])
      expect([...seen]).toContain(kind);
    expect([...seen].filter((kind) => kind.startsWith('wait')).length).toBeGreaterThanOrEqual(5);
  });
});

describe('what a move changed, as the runner keeps it', () => {
  it('takes which jobs are still done, never their lines, and only what changed', () => {
    const state = {
      daily: { requests: 'Read 4.', post_people: 'Read 9.', found_checks: 'Checked 2.' },
    };
    expect(changeKept(state, {})).toEqual({});
    expect(changeKept(state, { daily: { requests: 'x' }, round: 2, roundAt: null })).toEqual({
      daily: { requests: 'Read 4.' },
      round: 2,
      roundAt: null,
    });
    expect(changeKept(state, { replied: ['p-1'] })).toEqual({ replied: ['p-1'] });
  });
});
