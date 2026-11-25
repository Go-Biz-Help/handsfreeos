/**
 * Alignable's runner asking HandsFreeOS for its next move (src/auto/alignable.ts `go`, src/hfos/plan.ts `planNext`;
 * docs/outreach.md decision 195, step 2), with the extension's storage, HandsFreeOS, Alignable's tab and each of the
 * runner's reads stood in for, so what a go chose to do is what's seen. Once its own checks let it work it asks, with
 * what only this computer knows, and does the move it's sent as it does its own: the read, the wait, the piece of its
 * list's work HandsFreeOS picked, and what the move changed in its day. It plans the go itself, as it always has,
 * whenever HandsFreeOS doesn't decide, can't be reached, or sends a move it can't do; and it never asks while its own
 * checks hold it. Unlike Threads and X, a save of the person's lists is tried whenever it's due, and puts itself off
 * when its page needs the screen.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TodayList, TodayListItem } from '../src/hfos/messages';

const AL = 'https://www.alignable.com';
const ME = { userId: 'u-casey', businessId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' };
const COMPUTER = '5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f';
const TZ = 'America/Chicago';
const MIN = 60_000;
const NEXT = '/v1/queries/outreach.plan.next';
const TODAY_LIST = '/v1/queries/outreach.today';
/** What a read says when it's put off till the person is away. */
const PUT_OFF = 'Put off till you’re away.';

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
  /** The reads that need their window on screen: put off while the person's at their computer. */
  screen: new Set<string>(),
  /** The move HandsFreeOS last sent, where this test works its answer out. */
  sent: null as Record<string, unknown> | null,
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
      voice: { split: false },
      hours: world.hours,
      networks: { alignable: world.choices },
    },
  }),
}));
vi.mock('../src/hfos/live', async (original) => ({
  ...(await original<object>()),
  keptFor: async () => world.kept,
  onBeat: () => undefined,
  feed: async () => undefined,
  computer: async () => ({ id: COMPUTER, fresh: false, name: 'Chrome on Mac', version: '0.157.0' }),
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

// Each of its reads, stood in for: what's seen here is which one a go chose. One that needs its window on screen is
// put off while the person's at their computer, as its tab puts it off (decision 120).
const read = (name: string) => async (job?: { round?: number }) => {
  if (world.screen.has(name) && !world.away) return { line: PUT_OFF, warned: false, away: true };
  world.did.push(name === 'search' ? `search:${job?.round ?? 0}` : name);
  return { line: `Did ${name}.`, warned: false };
};
vi.mock('../src/jobs/alignable/chats', async (original) => ({
  ...(await original<object>()),
  readAlignableChats: read('chats'),
}));
vi.mock('../src/jobs/alignable/checks', async (original) => ({
  ...(await original<object>()),
  checkConnections: read('checks'),
}));
vi.mock('../src/jobs/alignable/customer-search', async (original) => ({
  ...(await original<object>()),
  searchForCustomers: read('search'),
}));
vi.mock('../src/jobs/alignable/events', async (original) => ({
  ...(await original<object>()),
  readEventsNear: read('events'),
}));
vi.mock('../src/jobs/alignable/groups', async (original) => ({
  ...(await original<object>()),
  readMyGroups: read('my_groups'),
  checkGroupsOn: read('group_checks'),
  joinGroupsOn: read('join'),
  readMembers: read('members'),
  readGroupPosts: read('group_posts'),
}));
vi.mock('../src/jobs/alignable/post-people', () => ({
  readAlignablePostPeople: read('post_people'),
}));
vi.mock('../src/jobs/alignable/people', async (original) => ({
  ...(await original<object>()),
  checkRequests: read('requests'),
}));
vi.mock('../src/jobs/alignable/engaged', async (original) => ({
  ...(await original<object>()),
  readWarmLeads: read('helpful'),
}));
vi.mock('../src/jobs/alignable/posts', async (original) => ({
  ...(await original<object>()),
  findPostsInTown: read('posts'),
}));
vi.mock('../src/jobs/alignable/withdraw', async (original) => ({
  ...(await original<object>()),
  withdrawOnItsOwn: read('tidy'),
}));
vi.mock('../src/jobs/alignable/comment-research', () => ({
  readAlignableComments: read('comment_research'),
}));
vi.mock('../src/jobs/found-checks', () => ({ checkFound: read('found_checks') }));
vi.mock('../src/jobs/own-read', () => ({ readProfileOnItsOwn: read('profile') }));
vi.mock('../src/jobs/partners', async (original) => ({
  ...(await original<object>()),
  checkPartners: read('partners'),
}));
vi.mock('../src/jobs/weekly-post', async (original) => ({
  ...(await original<object>()),
  askWeeklyPost: read('weekly_post'),
}));
vi.mock('../src/auto/lists', async (original) => {
  const { NotAway } = await import('../src/away');
  return {
    ...(await original<object>()),
    doBeforeDay: async (step: { do: string; list?: string }) => {
      const name = `before:${step.list ?? step.do}`;
      // As its tab does when a page of the save needs the screen and they're at their computer.
      if (world.screen.has(name) && !world.away) throw new NotAway();
      world.did.push(name);
      return { line: 'Saved 3 connections.', warned: false };
    },
  };
});
// Alignable's tab opens no page here: a step on the list gets as far as its first page, which is what's seen.
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
      getManifest: () => ({ version: '0.157.0' }),
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

const { alignableTick, ALIGNABLE_ALARM } = await import('../src/auto/alignable');
const { ALIGNABLE_STATE_KEY, freshState, workKey } = await import('../src/auto/plan');
const { businessDay } = await import('@hfos/core/addons/outreach/automation');
const { markOf } = await import('../src/auto/lists');
const { ASK_FIRST_WORDS } = await import('@hfos/core/addons/outreach/asks');
const { LIST_MARKS_ON, NO_LISTS } = await import('@hfos/core/addons/outreach/lists');
const { ALIGNABLE_DAILY, ALIGNABLE_FINDING, ALIGNABLE_GAP_MS, RUNNERS } =
  await import('@hfos/core/addons/outreach/runners');
const { nextMove, planDayOf, PlanState } = await import('@hfos/core/addons/outreach/plan');
const { changeSent, moveSent } = await import('@hfos/core/addons/outreach/plan-next');

type State = ReturnType<typeof freshState>;
const KEY = ALIGNABLE_STATE_KEY;
const today = () => businessDay(Date.now(), TZ);
const iso = (ms: number) => new Date(ms).toISOString();
/** Their connections and requests saved and the first checks done, today: nothing's due before the day. */
const savedLists = () => ({
  ...NO_LISTS,
  friendsAt: iso(Date.now()),
  requestsAt: iso(Date.now()),
  checksAt: iso(Date.now()),
});
const stateNow = () => store.get(KEY) as State;
const begin = (more: Partial<State> = {}) => store.set(KEY, { ...freshState(today()), ...more });
const asks = () => world.posted.filter((p) => p.path === NEXT);
const told = (move: Record<string, unknown>, more: Record<string, unknown> = {}) => {
  world.answers[NEXT] = () => ({ decides: true, move, change: null, list: null, ...more });
};

const business = (name: string, id: string): TodayListItem =>
  ({
    kind: 'friend_request',
    name,
    profileId: `p-${id}`,
    platformId: id,
    profileUrl: `${AL}/biz/businesses/${id}`,
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
const DANA = business('Dana Reyes', '42');
const SAM = business('Sam Lee', '43');
const listOf = (items: TodayListItem[]): TodayList =>
  ({
    items,
    partners: [],
    auto: ['confirm', 'warm_up', 'friend_request'],
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
  world.screen.clear();
  world.sent = null;
  begin();
});

describe('a go that HandsFreeOS decides (decision 195, step 2)', () => {
  it('asks with where its day is up to, its own clock, and what only this computer knows', async () => {
    world.away = false;
    told({ do: 'wait', why: 'idle', until: Date.now() + 30 * MIN });
    const before = Date.now();
    await alignableTick();
    expect(asks()).toHaveLength(1);
    const { body } = asks()[0]!;
    expect(body).toMatchObject({
      workspaceId: ME.businessId,
      platform: 'alignable',
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
    told({ do: 'daily', job: 'chats', gap: 5 * MIN });
    const before = Date.now();
    await alignableTick();
    // By itself, their own groups come first.
    expect(world.did).toEqual(['chats']);
    const state = stateNow();
    expect(state.daily).toMatchObject({ chats: 'Did chats.' });
    expect(state.daily).not.toHaveProperty('my_groups');
    expect(state.readLast).toBe(true);
    expect(alarms.get(ALIGNABLE_ALARM)).toBeGreaterThanOrEqual(before + 5 * MIN);
    expect(alarms.get(ALIGNABLE_ALARM)).toBeLessThan(Date.now() + 5 * MIN + 1_000);
  });

  it('never goes again sooner than its own pace, whatever wait comes with a read', async () => {
    told({ do: 'daily', job: 'requests', gap: 1_000 });
    const before = Date.now();
    await alignableTick();
    expect(world.did).toEqual(['requests']);
    expect(alarms.get(ALIGNABLE_ALARM)).toBeGreaterThanOrEqual(before + ALIGNABLE_GAP_MS.least);
  });

  it('does the step before its day it’s sent, at their computer too: a save puts itself off when it must', async () => {
    world.away = false;
    world.hfos['hfos-lists'] = () => NO_LISTS;
    told({ do: 'before', step: { do: 'save', list: 'friends', first: true }, gap: 4 * MIN });
    await alignableTick();
    expect(world.did).toEqual(['before:friends']);
    expect(stateNow().before).toMatchObject({ friends: 'Saved 3 connections.' });
    // One whose page needs the screen is put off by its own tab, and the list has its turn next.
    world.did.length = 0;
    begin();
    world.screen.add('before:friends');
    await alignableTick();
    expect(world.did).toEqual([]);
    expect(stateNow().before ?? {}).not.toHaveProperty('friends');
    expect(stateNow().readLast).toBe(true);
    // And one it wouldn't have picked: with their lists saved, by itself it would read their groups.
    world.hfos['hfos-lists'] = savedLists;
    begin();
    told({ do: 'before', step: { do: 'checks' }, gap: 4 * MIN });
    await alignableTick();
    expect(world.did).toEqual(['before:checks']);
  });

  it('waits as it’s told, with its own words for each wait, and looks again when HandsFreeOS said', async () => {
    const until = Date.now() + 7 * MIN;
    told({ do: 'wait', why: 'asks', until });
    await alignableTick();
    expect(world.did).toEqual([]);
    expect(stateNow()).toMatchObject({ line: ASK_FIRST_WORDS, nextAt: until });
    expect(alarms.get(ALIGNABLE_ALARM)).toBe(until);

    told({ do: 'wait', why: 'idle', until: until + MIN });
    await alignableTick();
    expect(stateNow().line).toMatch(/^Nothing on your Alignable list for it to do yet\./);
    expect(stateNow().nextAt).toBe(until + MIN);

    told({ do: 'wait', why: 'hours', until: until + 2 * MIN });
    await alignableTick();
    expect(stateNow().line).toMatch(/Start my day for Alignable/);
    expect(stateNow().nextAt).toBe(until + 2 * MIN);

    // A warning HandsFreeOS knows of holds it till it asks again: its own state is left to what this computer saw.
    told({ do: 'wait', why: 'warned', until: until + 3 * MIN });
    await alignableTick();
    expect(stateNow().line).toMatch(/^Stopped: Alignable warned you today\./);
    expect(stateNow().stopped).toBeNull();
    expect(stateNow().nextAt).toBe(until + 3 * MIN);

    told({ do: 'wait', why: 'noting', until: until + 4 * MIN });
    await alignableTick();
    expect(stateNow().line).toMatch(/^Turn on noting your steps/);
    expect(stateNow().needs).toBe(true);
    expect(stateNow().nextAt).toBe(until + 4 * MIN);

    told({ do: 'wait', why: 'off', until: null });
    await alignableTick();
    expect(stateNow().nextAt).toBeNull();
    expect(alarms.has(ALIGNABLE_ALARM)).toBe(false);
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
    await alignableTick();
    // By itself, Dana is first on the list.
    expect(world.opened[0]).toBe(SAM.profileUrl);
    expect(world.opened).not.toContain(DANA.profileUrl);
    expect(stateNow().tried).toEqual([key]);
    // The list came with the answer: it isn't asked for again.
    expect(world.posted.map((p) => p.path)).not.toContain(TODAY_LIST);
    expect(world.did).toEqual([]);
  });

  it('keeps what the move changed in its day: a round of finding again begun', async () => {
    const lines = Object.fromEntries(ALIGNABLE_DAILY.map((job) => [job, `Own line for ${job}.`]));
    begin({ daily: lines });
    const still = Object.fromEntries(
      Object.entries(lines)
        .filter(([job]) => !(ALIGNABLE_FINDING as readonly string[]).includes(job))
        .map(([job]) => [job, 'Clipped.']),
    );
    const roundAt = Date.now() - 1_000;
    told(
      { do: 'daily', job: 'search', gap: 4 * MIN },
      { change: { daily: still, round: 1, roundAt } },
    );
    await alignableTick();
    // The read asks HandsFreeOS with the round it's in.
    expect(world.did).toEqual(['search:1']);
    const state = stateNow();
    expect(state).toMatchObject({ round: 1, roundAt });
    // Each line stays its own; the finding jobs are to do once more, and the one it did is done again.
    expect(state.daily).toMatchObject({
      requests: 'Own line for requests.',
      chats: 'Own line for chats.',
      search: 'Did search.',
    });
    expect(state.daily).not.toHaveProperty('found_checks');
    expect(state.daily).not.toHaveProperty('members');
  });

  it('answers outside its hours only as it’s sent: it waits, or reads a comment research', async () => {
    // No working hours today, and nothing pressed.
    world.hours = { start: 9, end: 17, days: [(new Date().getDay() + 3) % 7], everyDay: false };
    const until = Date.now() + 90 * MIN;
    told({ do: 'wait', why: 'hours', until });
    await alignableTick();
    expect(world.did).toEqual([]);
    expect(stateNow().nextAt).toBe(until);

    told({ do: 'daily', job: 'comment_research', gap: 4 * MIN });
    await alignableTick();
    expect(world.did).toEqual(['comment_research']);
    // Outside the hours the list has no turn to take.
    expect(stateNow().readLast).not.toBe(true);
  });
});

describe('a go it plans itself, as it always has', () => {
  const itsOwn = async () => {
    world.did.length = 0;
    world.opened.length = 0;
    begin();
    await alignableTick();
    return [...world.did];
  };

  it('goes on by its own order when HandsFreeOS can’t be reached, or leaves the order to it', async () => {
    // No answer at all: no connection, or a HandsFreeOS from before runners asked.
    expect(await itsOwn()).toEqual(['my_groups']);
    expect(asks()).toHaveLength(1);
    // As HandsFreeOS answers while Alignable isn't switched on.
    world.answers[NEXT] = () => ({ decides: false, move: null, change: null, list: null });
    expect(await itsOwn()).toEqual(['my_groups']);
    world.answers[NEXT] = () => {
      throw new Error('The answer never came.');
    };
    expect(await itsOwn()).toEqual(['my_groups']);
    expect(stateNow().daily).toMatchObject({ my_groups: 'Did my_groups.' });
  });

  it('plans for itself when it’s sent a move it can’t do as things stand', async () => {
    // A read that isn't Alignable's.
    told({ do: 'daily', job: 'follow_backs', gap: 4 * MIN });
    expect(await itsOwn()).toEqual(['my_groups']);
    // A move from a later HandsFreeOS.
    told({ do: 'dance', gap: 4 * MIN });
    expect(await itsOwn()).toEqual(['my_groups']);
    // Threads' and X's hourly search, and Facebook's newest posts, aren't Alignable's.
    told({ do: 'search', gap: 4 * MIN });
    expect(await itsOwn()).toEqual(['my_groups']);
    told({ do: 'watch', gap: 4 * MIN });
    expect(await itsOwn()).toEqual(['my_groups']);
    // A wait for the screen is Threads' and X's: a save here is tried, and puts itself off.
    told({ do: 'wait', why: 'screen', until: Date.now() + 10 * MIN });
    expect(await itsOwn()).toEqual(['my_groups']);
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
    expect(await itsOwn()).toEqual(['my_groups']);
    expect(world.opened).toEqual([]);
    told(work);
    expect(await itsOwn()).toEqual(['my_groups']);
    // A step before the day that isn't one of Alignable's.
    told({ do: 'before', step: { do: 'tidy' }, gap: 4 * MIN });
    expect(await itsOwn()).toEqual(['my_groups']);
    told({ do: 'before', step: { do: 'save', list: 'sent', first: false }, gap: 4 * MIN });
    expect(await itsOwn()).toEqual(['my_groups']);
  });

  it('never asks while its own checks hold it: an ask of theirs in line, noting off, a warning, standby, Sending off', async () => {
    told({ do: 'daily', job: 'chats', gap: 4 * MIN });
    world.asking = true;
    expect(await itsOwn()).toEqual([]);
    expect(stateNow().line).toBe(ASK_FIRST_WORDS);
    world.asking = false;

    world.noting = false;
    expect(await itsOwn()).toEqual([]);
    expect(stateNow().needs).toBe(true);
    world.noting = true;

    world.warned = { words: ['Slow down'] };
    expect(await itsOwn()).toEqual([]);
    expect(stateNow().stopped).toBe('warning');
    world.warned = null;

    world.kept = { working: false, workingName: 'Chrome on Windows', days: {} };
    expect(await itsOwn()).toEqual([]);
    world.kept = { working: true, workingName: null, days: {} };

    world.choices = { ...world.choices, sending: 'off' };
    expect(await itsOwn()).toEqual([]);
    expect(asks()).toEqual([]);

    // Free again, it asks and does as it's sent.
    world.choices = { ...world.choices, sending: 'steps' };
    expect(await itsOwn()).toEqual(['chats']);
    expect(asks()).toHaveLength(1);
  });
});

/**
 * HandsFreeOS's answer, worked out as `outreach.plan.next` does (packages/core/src/addons/outreach/ops/plan.ts): the
 * day's rules on what it knows (here, what this test's world says) and what the runner said.
 */
const asHandsFreeOS = (list: TodayList) => {
  world.answers[NEXT] = (body) => {
    const kept = planDayOf(PlanState.parse(body.state));
    const facts = {
      platform: 'alignable' as const,
      now: body.now as number,
      timeZone: TZ,
      hours: world.hours as never,
      choices: world.choices as never,
      noting: world.noting,
      day: ((world.kept?.days as Record<string, never> | undefined) ?? {}).alignable ?? null,
      warned: world.warned !== null,
      asks: 0,
      lists: world.hfos['hfos-lists']!({}) as never,
      list: list as never,
    };
    const { move, state } = nextMove(facts, kept, body.random as number, body.here as never);
    world.sent = moveSent(move, 0) as Record<string, unknown>;
    return {
      decides: true,
      move: world.sent,
      change: changeSent(kept, state, 0),
      list: move.do === 'work' ? list : null,
    };
  };
};

/**
 * Whether the go just gone did the move HandsFreeOS sent, and didn't turn it down to plan for itself: a go that
 * plans for itself comes to the same as itself whatever it was sent, which would compare nothing.
 */
const didAsSent = (): boolean => {
  const move = world.sent;
  switch (move?.do) {
    case 'wait':
      return move.why !== 'screen';
    case 'daily':
      return (ALIGNABLE_DAILY as readonly string[]).includes(move.job as string);
    case 'before':
      return LIST_MARKS_ON.alignable.includes(markOf(move.step as never));
    // Its list came with the move, and the piece of work was on it: the runner never asked for the list itself.
    case 'work':
      return !world.posted.some((p) => p.path === TODAY_LIST);
    default:
      return false;
  }
};

/** One go from where a day stands, by itself or as HandsFreeOS decides, and what it came to. */
const goFrom = async (state: Partial<State>, list: TodayList, decided: boolean) => {
  store.clear();
  alarms.clear();
  world.did.length = 0;
  world.opened.length = 0;
  world.posted.length = 0;
  begin(state);
  world.answers = { [TODAY_LIST]: () => list };
  if (decided) asHandsFreeOS(list);
  await alignableTick();
  const now = stateNow();
  const wake = alarms.get(ALIGNABLE_ALARM);
  return {
    did: [...world.did],
    opened: [...world.opened],
    line: now.line,
    tried: now.tried,
    read: Object.keys(now.daily ?? {}).sort(),
    before: Object.keys(now.before ?? {}).sort(),
    round: now.round ?? 0,
    stopped: now.stopped,
    readLast: now.readLast ?? false,
    needs: now.needs ?? false,
    /** When it goes next. */
    wake: wake ?? null,
  };
};

/**
 * A go HandsFreeOS decided came to what the go planned by itself did, and goes next at the same time: its pace after
 * a read or a step, and each wait's end. The two goes are a moment apart, so their times are too.
 */
const expectSame = (
  sent: Awaited<ReturnType<typeof goFrom>>,
  itself: Awaited<ReturnType<typeof goFrom>>,
) => {
  const { wake: sentWake, ...sentCame } = sent;
  const { wake: ownWake, ...ownCame } = itself;
  expect(sentCame).toEqual(ownCame);
  if (ownWake === null) expect(sentWake).toBeNull();
  else expect(Math.abs((sentWake ?? 0) - ownWake)).toBeLessThan(2_000);
};

describe('the move HandsFreeOS’s rules send is the one the runner would have picked', () => {
  // One pace for both goes of a scene, so their waits can be compared too.
  beforeAll(() => void vi.spyOn(Math, 'random').mockReturnValue(0.5));
  afterAll(() => vi.restoreAllMocks());

  const allRead = () => Object.fromEntries(ALIGNABLE_DAILY.map((job) => [job, `Read ${job}.`]));
  const notToday = () => ({
    start: 9,
    end: 17,
    days: [(new Date().getDay() + 3) % 7],
    everyDay: false,
  });
  const reply = { ...business('Lee Ortiz', '44'), kind: 'reply', threadKey: 't-9' };

  /** Each: the day so far, today's list, and what else is so. */
  const scenes: Record<
    string,
    {
      readonly state?: () => Partial<State>;
      readonly list?: () => TodayList;
      readonly world?: () => void;
    }
  > = {
    'a once-a-day read is next': {},
    'the next once-a-day read, with some done': {
      state: () => ({ daily: { my_groups: 'Read.', requests: 'Read.', tidy: 'Read.' } }),
    },
    'the list’s turn, after a read': {
      state: () => ({ readLast: true }),
      list: () => listOf([DANA, SAM]),
    },
    'the reading’s turn, with a list to work': { list: () => listOf([DANA, SAM]) },
    'the day’s reading done, and a list to work': {
      state: () => ({ daily: allRead() }),
      list: () => listOf([DANA, SAM]),
    },
    'someone on the list tried already today': {
      state: () => ({ daily: allRead(), tried: [workKey({ do: 'step', item: DANA })] }),
      list: () => listOf([DANA, SAM]),
    },
    'nothing left to do': { state: () => ({ daily: allRead() }) },
    'a first day, with the person at their computer': {
      world: () => {
        world.away = false;
        world.hfos['hfos-lists'] = () => NO_LISTS;
      },
    },
    'a first day at their computer, where the save needs the screen': {
      list: () => listOf([DANA]),
      world: () => {
        world.away = false;
        world.screen.add('before:friends');
        world.hfos['hfos-lists'] = () => NO_LISTS;
      },
    },
    'a first day, with the person away': {
      world: () => void (world.hfos['hfos-lists'] = () => NO_LISTS),
    },
    'their connections saved, their requests not yet': {
      world: () =>
        void (world.hfos['hfos-lists'] = () => ({ ...NO_LISTS, friendsAt: iso(Date.now()) })),
    },
    'their connections due again at their computer, where the save needs the screen': {
      state: () => ({ readLast: true }),
      list: () => listOf([DANA]),
      world: () => {
        world.away = false;
        world.screen.add('before:friends');
        const old = iso(Date.now() - 8 * 24 * 60 * MIN);
        world.hfos['hfos-lists'] = () => ({ ...savedLists(), friendsAt: old });
      },
    },
    'their connections due again, put off a moment ago, and no list to work': {
      state: () => ({ readLast: true }),
      world: () => {
        world.away = false;
        world.screen.add('before:friends');
        const old = iso(Date.now() - 8 * 24 * 60 * MIN);
        world.hfos['hfos-lists'] = () => ({ ...savedLists(), friendsAt: old });
      },
    },
    'the first check of their connections not done yet': {
      world: () =>
        void (world.hfos['hfos-lists'] = () => ({
          ...NO_LISTS,
          friendsAt: iso(Date.now()),
          requestsAt: iso(Date.now()),
        })),
    },
    'short of good fits, with the day’s reading done': {
      state: () => ({ daily: allRead(), more: true }),
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
      state: () => ({ daily: allRead() }),
      world: () => {
        world.hours = notToday();
        world.kept = {
          working: true,
          workingName: null,
          days: { alignable: { date: today(), state: 'started', why: null } },
        };
      },
    },
    'outside the hours, with only new people on the list': {
      list: () => listOf([DANA]),
      world: () => void (world.hours = notToday()),
    },
    'outside the hours, with someone who wrote back': {
      list: () =>
        ({
          ...listOf([DANA, reply as TodayListItem]),
          messages: ['reply'],
        }) as unknown as TodayList,
      world: () => void (world.hours = notToday()),
    },
    'outside the hours, with a comment research reading': {
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
          days: { alignable: { date: today(), state: 'stopped', why: null } },
        }),
    },
  };

  for (const [name, scene] of Object.entries(scenes))
    it(`${name}`, async () => {
      scene.world?.();
      const list = scene.list?.() ?? listOf([]);
      const itself = await goFrom(scene.state?.() ?? {}, list, false);
      const sent = await goFrom(scene.state?.() ?? {}, list, true);
      // After Stop for today its own checks hold it: it never asks.
      const held = name === 'Stop for today pressed';
      expect(asks()).toHaveLength(held ? 0 : 1);
      if (!held) expect(didAsSent()).toBe(true);
      expectSame(sent, itself);
    });

  it('covers what a go can come to: each kind of read, a save put off, the list’s work, and each wait', async () => {
    // What the scenes above came to, by themselves: a guard that they stay worth comparing.
    const seen = new Set<string>();
    for (const [name, scene] of Object.entries(scenes)) {
      world.choices = { on: true, sending: 'steps', collect: true, warmUp: true };
      world.hours = { start: 0, end: 24, days: [0, 1, 2, 3, 4, 5, 6] };
      world.kept = { working: true, workingName: null, days: {} };
      world.away = true;
      world.screen.clear();
      world.hfos = {
        'hfos-lists': savedLists,
        'hfos-comment-research-next': () => ({ research: null }),
      };
      scene.world?.();
      const came = await goFrom(scene.state?.() ?? {}, scene.list?.() ?? listOf([]), false);
      seen.add(
        came.did[0]?.replace(/:.*/, '') ??
          (came.opened.length ? 'work' : came.line === PUT_OFF ? 'put off' : `wait: ${name}`),
      );
    }
    for (const kind of ['my_groups', 'checks', 'before', 'search', 'comment_research', 'work'])
      expect([...seen]).toContain(kind);
    expect([...seen].filter((kind) => kind.startsWith('wait')).length).toBeGreaterThanOrEqual(4);
  });
});

// Last in this file: a read put off stays put off for 10 minutes, whichever test comes next.
describe('a read put off till the person’s away', () => {
  beforeAll(() => void vi.spyOn(Math, 'random').mockReturnValue(0.5));
  afterAll(() => vi.restoreAllMocks());

  it('is passed over by HandsFreeOS as the runner passes it over, and holds a round of finding again', async () => {
    // Their groups' read needs its window on screen, and they're at their computer: it's put off.
    world.away = false;
    world.screen.add('my_groups');
    await alignableTick();
    expect(world.did).toEqual([]);
    expect(stateNow().daily ?? {}).not.toHaveProperty('my_groups');

    // The next read goes meanwhile, by itself and as HandsFreeOS decides, which is told what's passed over.
    const itself = await goFrom({}, listOf([]), false);
    const sent = await goFrom({}, listOf([]), true);
    expect(itself.did).toEqual(['requests']);
    expectSame(sent, itself);
    expect(didAsSent()).toBe(true);
    expect(asks()[0]!.body.here).toMatchObject({ away: false, passOver: ['my_groups'] });

    // With the rest of the day read, it waits for them to be away: no round of finding again begins meanwhile.
    const rest = Object.fromEntries(
      ALIGNABLE_DAILY.filter((job) => job !== 'my_groups').map((job) => [job, `Read ${job}.`]),
    );
    const short = { ...listOf([]), goal: { more: true } } as unknown as TodayList;
    const waits = await goFrom({ daily: rest, more: true }, short, false);
    const waitsSent = await goFrom({ daily: rest, more: true }, short, true);
    expect(waits.did).toEqual([]);
    expect(waits.round).toBe(0);
    expect(waits.line).toMatch(/One part waits till you’ve been away from your computer/);
    expectSame(waitsSent, waits);
    expect(world.sent).toMatchObject({ do: 'wait', why: 'idle' });

    // Once they're away it's read, either way.
    world.away = true;
    const back = await goFrom({ daily: rest }, listOf([]), false);
    const backSent = await goFrom({ daily: rest }, listOf([]), true);
    expect(back.did).toEqual(['my_groups']);
    expectSame(backSent, back);
    expect(world.sent).toMatchObject({ do: 'daily', job: 'my_groups' });
  });

  it('is where Alignable’s rules part from Threads’ and X’s: only those hold a save till they’re away', () => {
    expect(RUNNERS.alignable.savesAway).toBe(false);
    expect(RUNNERS.threads.savesAway).toBe(true);
    expect(RUNNERS.x.savesAway).toBe(true);
  });
});
