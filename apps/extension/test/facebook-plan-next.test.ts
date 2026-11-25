/**
 * Facebook's runner asking HandsFreeOS for its next move (src/auto/run.ts `go`, src/hfos/plan.ts `planNext`;
 * docs/outreach.md decision 195, step 2), with the extension's storage, HandsFreeOS, Facebook's tab and each of the
 * runner's reads stood in for, so what a go chose to do is what's seen. Once its own checks let it work it asks, with
 * what only this computer knows, and does the move it's sent as it does its own: the read, the wait, the piece of its
 * list's work HandsFreeOS picked, the newest posts in its groups, and what the move changed in its day. A look for a
 * referral to do and today's helpful post are its own to try when they're sent: done, the go ends there; with none
 * to do it asks once more, for what goes meanwhile. It plans the go itself, as it always has, whenever HandsFreeOS
 * doesn't decide, can't be reached, or sends a move it can't do; and it never asks while its own checks hold it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TodayList, TodayListItem } from '../src/hfos/messages';

const FB = 'https://www.facebook.com';
const ME = { userId: 'u-casey', businessId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' };
const COMPUTER = '5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f';
const TZ = 'America/Chicago';
const MIN = 60_000;
const NEXT = '/v1/queries/outreach.plan.next';
const TODAY_LIST = '/v1/queries/outreach.today';
const REFERRALS = '/v1/queries/outreach.referrals.due';
const REFERRAL_POSTED = '/v1/commands/outreach.referral.posted';
/** What the helpful post's job says while the AI hasn't written today's yet. */
const NONE_WRITTEN = 'No helpful post to put up on its own today.';

vi.setConfig({ testTimeout: 30_000 });

const world = vi.hoisted(() => ({
  /** What the runner did, in order: each read by its name, each page it opened. */
  did: [] as string[],
  opened: [] as string[],
  asked: [] as { type: string; input?: unknown }[],
  posted: [] as { path: string; body: Record<string, unknown> }[],
  answers: {} as Record<string, (body: Record<string, unknown>) => unknown>,
  hfos: {} as Record<string, (ask: Record<string, unknown>) => unknown>,
  /** The person's choices on Facebook, as HandsFreeOS keeps them at the top of their settings. */
  choices: {} as Record<string, unknown>,
  hours: { start: 0, end: 24, days: [0, 1, 2, 3, 4, 5, 6] } as Record<string, unknown>,
  /** What HandsFreeOS last said of their day, and whether this computer is the one that works. */
  kept: null as Record<string, unknown> | null,
  away: true,
  noting: true,
  asking: false,
  warned: null as { words: string[] } | null,
  /** How a read ends, by its name, where a scene says: a save that couldn't go, a warning from Facebook. */
  ends: {} as Record<string, () => Record<string, unknown>>,
  /** What happens while a read goes: Stop for today, pressed. */
  during: null as (() => void) | null,
  /** How putting today's helpful post up ends. */
  post: (): Record<string, unknown> => ({ line: '', warned: false }),
  /** The referrals and asks after two that are due. */
  due: (): Record<string, unknown> => ({ referrals: [], asks: [] }),
  /** The pages Facebook's tab can open, by address: any other can't be opened. */
  pages: {} as Record<string, Record<string, unknown>>,
  /** The moves HandsFreeOS sent this go, in order, where this test works its answers out. */
  sent: [] as Record<string, unknown>[],
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
    settings: { voice: { split: false }, hours: world.hours, ...world.choices, networks: {} },
  }),
}));
vi.mock('../src/hfos/live', async (original) => ({
  ...(await original<object>()),
  liveNow: async () => world.kept,
  keptFor: async () => world.kept,
  pressWaiting: async () => false,
  onBeat: () => undefined,
  onWake: () => () => undefined,
  beatSoon: () => undefined,
  feed: async () => undefined,
  computer: async () => ({ id: COMPUTER, fresh: false, name: 'Chrome on Mac', version: '0.160.0' }),
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
vi.mock('../src/away', async (original) => ({
  ...(await original<object>()),
  awayNow: async () => world.away,
}));
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

// Each of its reads, stood in for: what's seen here is which one a go chose, and how the scene says it ended.
const readEnds = (name: string, line: string) => {
  world.did.push(name);
  world.during?.();
  return world.ends[name.replace(/:\d+$/, '')]?.() ?? { line, warned: false };
};
vi.mock('../src/auto/daily', async (original) => ({
  ...(await original<object>()),
  // A round of finding again asks for the next search words: seen here beside the read's name.
  runDaily: async (kind: string, job: { round?: number }) =>
    readEnds(job.round ? `${kind}:${job.round}` : kind, `Did ${kind}.`),
}));
vi.mock('../src/auto/lists', async (original) => ({
  ...(await original<object>()),
  doBeforeDay: async (step: { do: string; list?: string }) =>
    readEnds(`before:${step.list ?? step.do}`, 'Saved 3 friends.'),
}));
vi.mock('../src/jobs/posts', async (original) => ({
  ...(await original<object>()),
  groupsToWork: async () => [],
  // The newest posts at the top of their best groups (decision 49).
  watchPosts: async () => readEnds('watch', 'Nothing new in your groups.'),
}));
vi.mock('../src/jobs/helpful', async (original) => ({
  ...(await original<object>()),
  // Today's helpful post put up on its own: up, couldn't go, none written yet, or a warning, as the scene says.
  postHelpful: async () => {
    world.did.push('post');
    return world.post();
  },
}));
// Facebook's tab opens only the pages a scene gives it: a step on the list gets as far as its first page, which is
// what's seen; a referral's post shows what the scene says is on it.
vi.mock('../src/tab', () => ({
  WorkTab: class {
    tabId: number | null = null;
    page: Record<string, unknown> | null = null;
    async adopt() {}
    async focus() {}
    async loaded() {}
    async keepInFront() {}
    async close() {
      this.tabId = null;
      this.page = null;
    }
    async inFront<T>(work: () => Promise<T>) {
      return work();
    }
    async open(url: string) {
      world.opened.push(url);
      const page = world.pages[url];
      if (!page) throw new Error(`No page for ${url}`);
      this.page = page;
      this.tabId = 9;
      return 9;
    }
    async ask(message: { type: string }) {
      if (message.type === 'hfos-read' && this.page) return { ok: true, result: this.page };
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
      getManifest: () => ({ version: '0.160.0' }),
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

const { tick, AUTO_ALARM } = await import('../src/auto/run');
const {
  AUTO_STATE_KEY,
  DAILY_JOBS,
  FINDING_JOBS,
  freshState,
  workKey,
  HELPFUL_AGAIN_MS,
  REFER_AGAIN_MS,
  STARTED_GAP_MS,
} = await import('../src/auto/plan');
const { businessDay } = await import('@hfos/core/addons/outreach/automation');
const { markOf } = await import('../src/auto/lists');
const { ASK_FIRST_WORDS } = await import('@hfos/core/addons/outreach/asks');
const { LIST_MARKS_ON, NO_LISTS } = await import('@hfos/core/addons/outreach/lists');
const { RUNNERS } = await import('@hfos/core/addons/outreach/runners');
const { nextMove, planDayOf, PlanState } = await import('@hfos/core/addons/outreach/plan');
const { changeSent, moveSent } = await import('@hfos/core/addons/outreach/plan-next');

type State = ReturnType<typeof freshState>;
const KEY = AUTO_STATE_KEY;
const today = () => businessDay(Date.now(), TZ);
const iso = (ms: number) => new Date(ms).toISOString();
/**
 * Their friends, requests and groups saved, the groups checked, the old requests to cancel worked out and the first
 * checks done, today: nothing's due before the day.
 */
const savedLists = () => ({
  ...NO_LISTS,
  friendsAt: iso(Date.now()),
  requestsAt: iso(Date.now()),
  sentAt: iso(Date.now()),
  groupsAt: iso(Date.now()),
  groupChecksAt: iso(Date.now()),
  tidyAt: iso(Date.now()),
  checksAt: iso(Date.now()),
});
const stateNow = () => store.get(KEY) as State;
const begin = (more: Partial<State> = {}) => store.set(KEY, { ...freshState(today()), ...more });
const asks = () => world.posted.filter((p) => p.path === NEXT);
const postedTo = (path: string) => world.posted.filter((p) => p.path === path).length;
const told = (move: Record<string, unknown>, more: Record<string, unknown> = {}) => {
  world.answers[NEXT] = () => ({ decides: true, move, change: null, list: null, ...more });
};
/** HandsFreeOS's answers to a go's asks, in order: the last stands for any after it. */
const toldInTurn = (...answers: Record<string, unknown>[]) => {
  let n = 0;
  world.answers[NEXT] = () => ({
    decides: true,
    change: null,
    list: null,
    ...answers[Math.min(n++, answers.length - 1)],
  });
};
const UP = () => ({ line: 'It’s up in Tile Pros.', warned: false, posted: true });
const NONE = () => ({ line: NONE_WRITTEN, warned: false });
const NO_REFERRALS = () => ({ referrals: [], asks: [] });
/** A referral due whose post has no link kept for its writer: tried, and it couldn't go, with no page opened. */
const PAT = {
  referralId: '0b6d0a52-4a51-4f1c-9a53-2f0e7c1d9a10',
  name: 'Pat Kim',
  posted: false,
  writer: 'Jo Marsh',
  writerUrl: null,
  postUrl: `${FB}/groups/tilepros/posts/1234567890/`,
  comment: 'Pat Kim does great tile work.',
  note: null,
};
const A_REFERRAL = () => ({ referrals: [PAT], asks: [] });
/** The same, with its writer's link kept: its post is opened, where Facebook shows a warning. */
const A_REFERRAL_ON_A_POST = () => ({
  referrals: [{ ...PAT, writerUrl: `${FB}/jo.marsh` }],
  asks: [],
});
const WARNING_ON_THE_POST = {
  [PAT.postUrl]: { url: PAT.postUrl, warnings: ['You’re going too fast'] },
};
/** The answers HandsFreeOS always has: who's due a referral, and a referral noted. */
const standing = () => ({ [REFERRALS]: () => world.due(), [REFERRAL_POSTED]: () => ({}) });

const member = (name: string, id: string): TodayListItem =>
  ({
    kind: 'friend_request',
    name,
    profileId: `p-${id}`,
    platformId: null,
    profileUrl: `${FB}/${id}`,
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
const DANA = member('Dana Reyes', 'dana.reyes');
const SAM = member('Sam Lee', 'sam.lee');
const listOf = (items: TodayListItem[]): TodayList =>
  ({
    items,
    partners: [],
    auto: ['confirm', 'warm_up', 'friend_request'],
    messages: [],
    sending: 'steps',
    limits: { like: { most: 80, done: 0 }, comment: { most: 20, done: 0 } },
    goal: null,
    retryAt: null,
  }) as unknown as TodayList;

const nothingPressed = () => ({
  working: true,
  workingName: null,
  day: { date: today(), state: 'none', why: null },
});
/** Start my day, pressed: their day goes now, whatever the hours. */
const startedByHand = () => ({
  ...nothingPressed(),
  day: { date: today(), state: 'started', why: null },
});
const freshWorld = () => {
  world.hfos = {
    'hfos-lists': savedLists,
    'hfos-comment-research-next': () => ({ research: null }),
  };
  world.choices = { sending: 'steps', collect: true, posting: 'after_ok', watchPosts: false };
  world.hours = { start: 0, end: 24, days: [0, 1, 2, 3, 4, 5, 6] };
  world.kept = nothingPressed();
  world.away = true;
  world.noting = true;
  world.asking = false;
  world.warned = null;
  world.ends = {};
  world.during = null;
  world.post = NONE;
  world.due = NO_REFERRALS;
  world.pages = {};
};

beforeEach(() => {
  store.clear();
  alarms.clear();
  world.did.length = 0;
  world.opened.length = 0;
  world.asked.length = 0;
  world.posted.length = 0;
  world.sent.length = 0;
  freshWorld();
  world.answers = standing();
  begin();
});

/** The day's reading done: what's next is a referral to look for, the helpful post, the newest posts, or the list. */
const allRead = () => Object.fromEntries(DAILY_JOBS.map((job) => [job, `Read ${job}.`]));
/** A referral looked for a while ago, with none to do: it isn't due again for a while. */
const looked = () => ({ referAt: Date.now() + 20 * MIN });
/** No working hours today, and nothing pressed. */
const notToday = () => ({
  start: 9,
  end: 17,
  days: [(new Date().getDay() + 3) % 7],
  everyDay: false,
});

describe('a go that HandsFreeOS decides (decision 195, step 2)', () => {
  it('asks with where its day is up to, its own clock, and what only this computer knows', async () => {
    world.away = false;
    told({ do: 'wait', why: 'idle', until: Date.now() + 30 * MIN });
    const before = Date.now();
    await tick();
    expect(asks()).toHaveLength(1);
    const { body } = asks()[0]!;
    expect(body).toMatchObject({
      workspaceId: ME.businessId,
      platform: 'facebook',
      computer: COMPUTER,
      // None of its reads is put off till they're away: nothing's ever passed over.
      here: { away: false, passOver: [], research: false, asking: false },
    });
    expect(body.now).toBeGreaterThanOrEqual(before);
    expect(body.now).toBeLessThanOrEqual(Date.now());
    expect(body.random).toBeGreaterThanOrEqual(0);
    expect(body.random).toBeLessThanOrEqual(1);
    // The state as it stands now: today's, with the comment research HandsFreeOS said isn't theirs kept for the day,
    // and when it last looked for a referral, the helpful post and the newest posts.
    const state = body.state as Record<string, unknown>;
    expect(state.day).toBe(today());
    expect(state.tried).toEqual([]);
    expect(state.daily).toHaveProperty('comment_research');
    expect(state).toMatchObject({ helpfulUp: false, helpfulAt: null, referAt: null });
  });

  it('does the read it’s sent, not the one it would have picked, and waits as long as it’s told', async () => {
    told({ do: 'daily', job: 'chats', gap: 5 * MIN });
    const before = Date.now();
    await tick();
    // By itself, their friend requests come first.
    expect(world.did).toEqual(['chats']);
    const state = stateNow();
    expect(state.daily).toMatchObject({ chats: 'Did chats.' });
    expect(state.daily).not.toHaveProperty('requests');
    expect(state.readLast).toBe(true);
    expect(alarms.get(AUTO_ALARM)).toBeGreaterThanOrEqual(before + 5 * MIN);
    expect(alarms.get(AUTO_ALARM)).toBeLessThan(Date.now() + 5 * MIN + 1_000);
  });

  it('never goes again sooner than a person’s pace, whatever wait comes with a read', async () => {
    told({ do: 'daily', job: 'requests', gap: 1_000 });
    const before = Date.now();
    await tick();
    expect(world.did).toEqual(['requests']);
    expect(alarms.get(AUTO_ALARM)).toBeGreaterThanOrEqual(before + STARTED_GAP_MS.least);
  });

  it('does the step before its day it’s sent', async () => {
    world.hfos['hfos-lists'] = () => NO_LISTS;
    told({ do: 'before', step: { do: 'save', list: 'friends', first: true }, gap: 4 * MIN });
    await tick();
    expect(world.did).toEqual(['before:friends']);
    expect(stateNow().before).toMatchObject({ friends: 'Saved 3 friends.' });
    // And one it wouldn't have picked: with their lists saved, by itself it would check their friend requests.
    world.hfos['hfos-lists'] = savedLists;
    world.did.length = 0;
    begin();
    told({ do: 'before', step: { do: 'tidy' }, gap: 4 * MIN });
    await tick();
    expect(world.did).toEqual(['before:tidy']);
  });

  it('waits as it’s told, with its own words for each wait, and looks again when HandsFreeOS said', async () => {
    const until = Date.now() + 7 * MIN;
    told({ do: 'wait', why: 'asks', until });
    await tick();
    expect(world.did).toEqual([]);
    expect(stateNow()).toMatchObject({ line: ASK_FIRST_WORDS, nextAt: until });
    expect(alarms.get(AUTO_ALARM)).toBe(until);

    told({ do: 'wait', why: 'idle', until: until + MIN });
    await tick();
    expect(stateNow().line).toMatch(/^Nothing on your list for it to do yet\./);
    expect(stateNow().nextAt).toBe(until + MIN);

    // Outside its hours, or after Stop for today pressed a moment ago, it waits without a word, as its own go does.
    const idle = stateNow().line;
    told({ do: 'wait', why: 'hours', until: until + 2 * MIN });
    await tick();
    expect(stateNow().line).toBe(idle);
    expect(stateNow().nextAt).toBe(until + 2 * MIN);
    told({ do: 'wait', why: 'stopped', until: until + 5 * MIN });
    await tick();
    expect(stateNow().line).toBe(idle);
    expect(stateNow().stopped).toBeNull();
    expect(stateNow().nextAt).toBe(until + 5 * MIN);

    // A warning HandsFreeOS knows of holds it till it asks again: its own state is left to what this computer saw.
    told({ do: 'wait', why: 'warned', until: until + 3 * MIN });
    await tick();
    expect(stateNow().line).toMatch(/^Stopped: Facebook warned you today\./);
    expect(stateNow().stopped).toBeNull();
    expect(stateNow().nextAt).toBe(until + 3 * MIN);

    told({ do: 'wait', why: 'noting', until: until + 4 * MIN });
    await tick();
    expect(stateNow().line).toMatch(/^Turn on “Note my steps on Facebook”/);
    expect(stateNow().needs).toBe(true);
    expect(stateNow().nextAt).toBe(until + 4 * MIN);

    told({ do: 'wait', why: 'off', until: null });
    await tick();
    expect(stateNow().nextAt).toBeNull();
    expect(alarms.has(AUTO_ALARM)).toBe(false);
    expect(world.did).toEqual([]);
    expect(asks()).toHaveLength(7);
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
    await tick();
    // By itself, Dana is first on the list.
    expect(world.opened[0]).toBe(SAM.profileUrl);
    expect(world.opened).not.toContain(DANA.profileUrl);
    expect(stateNow().tried).toEqual([key]);
    // The list came with the answer: it isn't asked for again.
    expect(postedTo(TODAY_LIST)).toBe(0);
    expect(world.did).toEqual([]);
  });

  it('keeps what the move changed in its day: a round of finding again begun', async () => {
    const lines = Object.fromEntries(DAILY_JOBS.map((job) => [job, `Own line for ${job}.`]));
    begin({ daily: lines });
    const still = Object.fromEntries(
      Object.entries(lines)
        .filter(([job]) => !(FINDING_JOBS as readonly string[]).includes(job))
        .map(([job]) => [job, 'Clipped.']),
    );
    const roundAt = Date.now() - 1_000;
    told(
      { do: 'daily', job: 'group_checks', gap: 4 * MIN },
      { change: { daily: still, round: 1, roundAt } },
    );
    await tick();
    // The read asks for the next search words with the round it's in.
    expect(world.did).toEqual(['group_checks:1']);
    const state = stateNow();
    expect(state).toMatchObject({ round: 1, roundAt });
    // Each line stays its own; the finding jobs are to do once more, and the one it did is done again.
    expect(state.daily).toMatchObject({
      requests: 'Own line for requests.',
      chats: 'Own line for chats.',
      group_checks: 'Did group_checks.',
    });
    expect(state.daily).not.toHaveProperty('members');
    expect(state.daily).not.toHaveProperty('checks');
  });

  it('looks at the newest posts in their groups when it’s sent, in its hours', async () => {
    told({ do: 'watch', gap: 5 * MIN });
    const before = Date.now();
    await tick();
    // By itself, with the newest posts off, it never would.
    expect(world.did).toEqual(['watch']);
    expect(stateNow().line).toBe('Newest posts: Nothing new in your groups.');
    expect(stateNow().watchAt).toBeGreaterThan(before + 59 * MIN);
    expect(alarms.get(AUTO_ALARM)).toBeGreaterThanOrEqual(before + 5 * MIN);
    expect(alarms.get(AUTO_ALARM)).toBeLessThan(Date.now() + 5 * MIN + 1_000);
  });

  it('does a referral that’s due when it’s sent to look, and goes next at the pace sent with it', async () => {
    world.due = A_REFERRAL;
    told({ do: 'refer', gap: 5 * MIN });
    const before = Date.now();
    await tick();
    // By itself, with the day's reading to do, it would check their friend requests.
    expect(world.did).toEqual([]);
    expect(postedTo(REFERRALS)).toBe(1);
    expect(postedTo(REFERRAL_POSTED)).toBe(1);
    expect(asks()).toHaveLength(1);
    const state = stateNow();
    expect(state.line).toMatch(/^Referring Pat Kim: /);
    // One done is a step: the next is looked for at the next go's turn.
    expect(state.referAt).toBeGreaterThanOrEqual(before);
    expect(state.referAt).toBeLessThanOrEqual(Date.now());
    expect(alarms.get(AUTO_ALARM)).toBeGreaterThanOrEqual(before + 5 * MIN);
    expect(alarms.get(AUTO_ALARM)).toBeLessThan(Date.now() + 5 * MIN + 1_000);

    // A warning on the referral's post stops the day there.
    begin();
    world.due = A_REFERRAL_ON_A_POST;
    world.pages = WARNING_ON_THE_POST;
    await tick();
    expect(world.opened).toEqual([PAT.postUrl]);
    expect(stateNow().stopped).toBe('warning');
    expect(stateNow().line).toMatch(/^Stopped: Facebook says “You’re going too fast”\./);
    expect(asks()).toHaveLength(2);
  });

  it('asks once more with no referral to do, and does what goes meanwhile', async () => {
    const roundAt = Date.now() - 1_000;
    toldInTurn(
      { move: { do: 'refer', gap: 5 * MIN }, change: { round: 2, roundAt } },
      { move: { do: 'daily', job: 'chats', gap: 4 * MIN } },
    );
    const before = Date.now();
    await tick();
    expect(postedTo(REFERRALS)).toBe(1);
    // The read goes in the round that came with the look.
    expect(world.did).toEqual(['chats:2']);
    expect(asks()).toHaveLength(2);
    // What came with the look is kept, and the second ask says it was looked for: it's due again in half an hour.
    const again = asks()[1]!.body.state as Record<string, unknown>;
    expect(again).toMatchObject({ round: 2, roundAt });
    expect(again.referAt).toBeGreaterThanOrEqual(before + REFER_AGAIN_MS);
    // The go keeps one clock and one pace for both asks.
    expect(asks()[1]!.body.now).toBe(asks()[0]!.body.now);
    expect(asks()[1]!.body.random).toBe(asks()[0]!.body.random);
    expect(stateNow().daily).toMatchObject({ chats: 'Did chats.' });
  });

  it('puts today’s helpful post up when it’s sent, and goes next at the pace sent with it', async () => {
    world.post = UP;
    told({ do: 'post', gap: 5 * MIN });
    const before = Date.now();
    await tick();
    // By itself, with their posts waiting for their OK, it never would: it would check their friend requests.
    expect(world.did).toEqual(['post']);
    expect(asks()).toHaveLength(1);
    const state = stateNow();
    expect(state.line).toBe('Helpful post: It’s up in Tile Pros.');
    expect(state.helpfulUp).toBe(true);
    expect(alarms.get(AUTO_ALARM)).toBeGreaterThanOrEqual(before + 5 * MIN);
    expect(alarms.get(AUTO_ALARM)).toBeLessThan(Date.now() + 5 * MIN + 1_000);

    // One that couldn't go is done for today too.
    begin();
    world.did.length = 0;
    world.post = () => ({ line: 'Couldn’t post in Tile Pros.', warned: false, failed: true });
    await tick();
    expect(world.did).toEqual(['post']);
    expect(stateNow().helpfulUp).toBe(true);
    expect(asks()).toHaveLength(2);

    // A warning as it goes up stops the day there.
    begin();
    world.did.length = 0;
    world.post = () => ({ line: 'Facebook warned you.', warned: true });
    await tick();
    expect(world.did).toEqual(['post']);
    expect(stateNow()).toMatchObject({ stopped: 'warning', line: 'Facebook warned you.' });
    expect(asks()).toHaveLength(3);
  });

  it('asks again after each look that finds nothing to do: a referral, the helpful post, then what goes meanwhile', async () => {
    toldInTurn(
      { move: { do: 'refer', gap: 5 * MIN } },
      { move: { do: 'post', gap: 5 * MIN } },
      { move: { do: 'daily', job: 'chats', gap: 4 * MIN } },
    );
    const before = Date.now();
    await tick();
    expect(postedTo(REFERRALS)).toBe(1);
    expect(world.did).toEqual(['post', 'chats']);
    expect(asks()).toHaveLength(3);
    // The third ask says both were looked for: each is due again in a while.
    const last = asks()[2]!.body.state as Record<string, unknown>;
    expect(last.referAt).toBeGreaterThanOrEqual(before + REFER_AGAIN_MS);
    expect(last.helpfulAt).toBeGreaterThanOrEqual(before + HELPFUL_AGAIN_MS);
    expect(last.helpfulUp).toBe(false);
    expect(asks()[2]!.body.now).toBe(asks()[0]!.body.now);
    expect(asks()[2]!.body.random).toBe(asks()[0]!.body.random);
  });

  it('looks for a referral and for the helpful post once a go, whatever it’s sent, and plans the rest itself', async () => {
    // Sent to look for a referral again though it just looked: it isn't looked for twice, and the go goes on by its
    // own order.
    told({ do: 'refer', gap: 5 * MIN });
    await tick();
    expect(postedTo(REFERRALS)).toBe(1);
    expect(world.did).toEqual(['requests']);
    expect(asks()).toHaveLength(2);

    // The same for the helpful post.
    begin();
    world.did.length = 0;
    world.posted.length = 0;
    told({ do: 'post', gap: 5 * MIN });
    await tick();
    expect(world.did).toEqual(['post', 'requests']);
    expect(asks()).toHaveLength(2);
    expect(stateNow().helpfulUp).toBe(false);

    // HandsFreeOS out of reach by the second ask, with the day's reading done and the post theirs to go up on its
    // own: by its own order the referral and the post would be next, and the referral was just looked for.
    begin({ daily: allRead() });
    world.did.length = 0;
    world.posted.length = 0;
    let n = 0;
    world.answers[NEXT] = () => {
      if (n++) throw new Error('The answer never came.');
      return { decides: true, move: { do: 'refer', gap: 5 * MIN }, change: null, list: null };
    };
    world.answers[TODAY_LIST] = () => listOf([]);
    world.choices = { ...world.choices, posting: 'own' };
    await tick();
    expect(postedTo(REFERRALS)).toBe(1);
    // The post is still its own order's to look for, once.
    expect(world.did).toEqual(['post']);
    expect(stateNow().line).toMatch(/^Nothing on your list for it to do yet\./);
  });

  it('answers outside its hours only as it’s sent: it waits, or reads a comment research', async () => {
    world.hours = notToday();
    const until = Date.now() + 90 * MIN;
    told({ do: 'wait', why: 'hours', until });
    await tick();
    expect(world.did).toEqual([]);
    expect(stateNow().nextAt).toBe(until);

    told({ do: 'daily', job: 'comment_research', gap: 4 * MIN });
    await tick();
    expect(world.did).toEqual(['comment_research']);
    // Outside the hours the list has no turn to take.
    expect(stateNow().readLast).not.toBe(true);

    // Nothing new goes outside the hours: a referral, a helpful post or the newest posts sent then is turned down,
    // and it waits as it would.
    world.answers[TODAY_LIST] = () => listOf([]);
    world.post = UP;
    world.due = A_REFERRAL;
    for (const move of ['refer', 'post', 'watch']) {
      world.did.length = 0;
      world.posted.length = 0;
      told({ do: move, gap: 4 * MIN });
      await tick();
      expect(world.did).toEqual([]);
      expect(postedTo(REFERRALS)).toBe(0);
      expect(asks()).toHaveLength(1);
    }
  });
});

describe('a go it plans itself, as it always has', () => {
  it('does nothing new outside its hours after Start my day either, whatever it’s sent', async () => {
    world.hours = notToday();
    world.kept = startedByHand();
    world.answers[TODAY_LIST] = () => listOf([]);
    world.post = UP;
    world.due = A_REFERRAL;
    world.choices = { ...world.choices, posting: 'own', watchPosts: true };
    for (const move of ['refer', 'post', 'watch']) {
      begin({ daily: allRead() });
      world.did.length = 0;
      world.posted.length = 0;
      told({ do: move, gap: 4 * MIN });
      await tick();
      // A referral, the helpful post and the newest posts each go only in the working hours.
      expect(world.did).toEqual([]);
      expect(postedTo(REFERRALS)).toBe(0);
      expect(asks()).toHaveLength(1);
      expect(stateNow().line).toMatch(/^Nothing on your list for it to do yet\./);
    }
  });

  const itsOwn = async (state: Partial<State> = {}) => {
    world.did.length = 0;
    world.opened.length = 0;
    world.posted.length = 0;
    begin(state);
    await tick();
    return [...world.did];
  };

  it('goes on by its own order when HandsFreeOS can’t be reached, or leaves the order to it', async () => {
    // No answer at all: no connection, or a HandsFreeOS from before runners asked.
    expect(await itsOwn()).toEqual(['requests']);
    expect(asks()).toHaveLength(1);
    // As HandsFreeOS answers while Facebook isn't switched on.
    world.answers[NEXT] = () => ({ decides: false, move: null, change: null, list: null });
    expect(await itsOwn()).toEqual(['requests']);
    world.answers[NEXT] = () => {
      throw new Error('The answer never came.');
    };
    expect(await itsOwn()).toEqual(['requests']);
    expect(stateNow().daily).toMatchObject({ requests: 'Did requests.' });
  });

  it('looks for a referral, puts the helpful post up and looks at the newest posts by itself, as it always has', async () => {
    world.choices = { ...world.choices, posting: 'own', watchPosts: true };
    world.answers[TODAY_LIST] = () => listOf([]);
    // A referral that's due is done first, once the day's reading is done.
    world.due = A_REFERRAL;
    expect(await itsOwn({ daily: allRead() })).toEqual([]);
    expect(postedTo(REFERRALS)).toBe(1);
    expect(stateNow().line).toMatch(/^Referring Pat Kim: /);
    // With none to do, the helpful post goes up.
    world.due = NO_REFERRALS;
    world.post = UP;
    expect(await itsOwn({ daily: allRead() })).toEqual(['post']);
    expect(postedTo(REFERRALS)).toBe(1);
    expect(stateNow()).toMatchObject({
      helpfulUp: true,
      line: 'Helpful post: It’s up in Tile Pros.',
    });
    // It's up, and a referral was looked for a while ago: the newest posts.
    expect(await itsOwn({ daily: allRead(), helpfulUp: true, ...looked() })).toEqual(['watch']);
    expect(postedTo(REFERRALS)).toBe(0);
  });

  it('keeps each part of its own go as it was: its pace after a read, Stop for today pressed meanwhile, a warning, a first save that couldn’t go', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      // A read, then a person's pace, and the list's turn next.
      const pace = (STARTED_GAP_MS.least + STARTED_GAP_MS.most) / 2;
      let before = Date.now();
      expect(await itsOwn()).toEqual(['requests']);
      expect(stateNow().line).toMatch(/: Did requests\.$/);
      expect(stateNow().readLast).toBe(true);
      expect(alarms.get(AUTO_ALARM)).toBeGreaterThanOrEqual(before + pace);
      expect(alarms.get(AUTO_ALARM)).toBeLessThan(Date.now() + pace + 1_000);

      // Stop for today pressed while it read: the go ends there, till its next working hours.
      world.during = () =>
        void store.set(KEY, { ...stateNow(), started: false, stopped: 'person' });
      expect(await itsOwn()).toEqual(['requests']);
      expect(stateNow().stopped).toBe('person');
      expect(alarms.get(AUTO_ALARM)).toBeGreaterThan(Date.now() + STARTED_GAP_MS.most);
      world.during = null;

      // A warning on a read stops the day, with the read's own words.
      world.ends.requests = () => ({ line: 'Facebook says to slow down.', warned: true });
      expect(await itsOwn()).toEqual(['requests']);
      expect(stateNow()).toMatchObject({ stopped: 'warning', line: 'Facebook says to slow down.' });
      expect(alarms.get(AUTO_ALARM)).toBeGreaterThan(Date.now() + STARTED_GAP_MS.most);
      world.ends = {};

      // A first day's save that couldn't go holds the day: it says so, and tries again in a few minutes.
      world.hfos['hfos-lists'] = () => NO_LISTS;
      world.ends['before:friends'] = () => ({
        line: 'Couldn’t open your friends list.',
        warned: false,
        failed: true,
      });
      before = Date.now();
      expect(await itsOwn()).toEqual(['before:friends']);
      expect(stateNow().needs).toBe(true);
      expect(stateNow().line).toMatch(/so it tries again in a few minutes\.$/);
      expect(alarms.get(AUTO_ALARM)).toBeGreaterThanOrEqual(before + 15 * MIN);
      expect(alarms.get(AUTO_ALARM)).toBeLessThan(Date.now() + 15 * MIN + 1_000);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('plans for itself when it’s sent a move it can’t do as things stand', async () => {
    // A read that isn't Facebook's.
    told({ do: 'daily', job: 'follow_backs', gap: 4 * MIN });
    expect(await itsOwn()).toEqual(['requests']);
    // A move from a later HandsFreeOS.
    told({ do: 'dance', gap: 4 * MIN });
    expect(await itsOwn()).toEqual(['requests']);
    // Threads' and X's hourly search isn't Facebook's.
    told({ do: 'search', gap: 4 * MIN });
    expect(await itsOwn()).toEqual(['requests']);
    // A wait for the screen is Instagram's, Threads' and X's: a save here is tried whenever it's due.
    told({ do: 'wait', why: 'screen', until: Date.now() + 10 * MIN });
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
    // A step before the day that isn't one it knows.
    told({ do: 'before', step: { do: 'save', list: 'pages', first: false }, gap: 4 * MIN });
    expect(await itsOwn()).toEqual(['requests']);
  });

  it('never asks while its own checks hold it: an ask of theirs in line, noting off, a warning, standby, Stop for today, Sending off', async () => {
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

    world.kept = { ...nothingPressed(), working: false, workingName: 'Chrome on Windows' };
    expect(await itsOwn()).toEqual([]);
    world.kept = {
      ...nothingPressed(),
      day: { date: today(), state: 'stopped', why: 'person' },
    };
    expect(await itsOwn()).toEqual([]);
    expect(stateNow().stopped).toBe('person');
    world.kept = nothingPressed();

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
      platform: 'facebook' as const,
      now: body.now as number,
      timeZone: TZ,
      hours: world.hours as never,
      choices: { on: true, ...world.choices } as never,
      noting: world.noting,
      day: (world.kept?.day as never) ?? null,
      warned: world.warned !== null,
      asks: 0,
      lists: world.hfos['hfos-lists']!({}) as never,
      list: list as never,
    };
    const { move, state } = nextMove(facts, kept, body.random as number, body.here as never);
    const sent = moveSent(move, 0) as Record<string, unknown>;
    world.sent.push(sent);
    return {
      decides: true,
      move: sent,
      change: changeSent(kept, state, 0),
      list: move.do === 'work' ? list : null,
    };
  };
};

/**
 * Whether the go just gone did each move HandsFreeOS sent, and didn't turn one down to plan for itself: a go that
 * plans for itself comes to the same as itself whatever it was sent, which would compare nothing. A look for a
 * referral and the helpful post are each a go's to try once, before its last move; any other move is the go's last.
 */
const didAsSent = (): boolean =>
  world.sent.length > 0 &&
  world.sent.every((move, n) => {
    const last = n === world.sent.length - 1;
    const once = world.sent.filter((other) => other.do === move.do).length === 1;
    switch (move.do) {
      // Looked for once, by the one ask of who's due; and the go ended there only with one done, or a warning.
      case 'refer':
        return (
          once &&
          postedTo(REFERRALS) === 1 &&
          last === (postedTo(REFERRAL_POSTED) > 0 || stateNow().stopped !== null)
        );
      // Up, or it couldn't go, the go ended there; with none written yet it asked once more.
      case 'post':
        return (
          once &&
          world.did.filter((name) => name === 'post').length === 1 &&
          last === (stateNow().helpfulUp === true || stateNow().stopped !== null)
        );
      case 'wait':
        return last && move.why !== 'screen';
      case 'daily':
        return last && (DAILY_JOBS as readonly string[]).includes(move.job as string);
      case 'before':
        return last && LIST_MARKS_ON.facebook.includes(markOf(move.step as never));
      case 'watch':
        return last && world.did.includes('watch');
      // Its list came with the move, and the piece of work was on it: the runner never asked for the list itself.
      case 'work':
        return last && postedTo(TODAY_LIST) === 0;
      default:
        return false;
    }
  });

/** One go from where a day stands, by itself or as HandsFreeOS decides, and what it came to. */
const goFrom = async (state: Partial<State>, list: TodayList, decided: boolean) => {
  store.clear();
  alarms.clear();
  world.did.length = 0;
  world.opened.length = 0;
  world.posted.length = 0;
  world.sent.length = 0;
  begin(state);
  world.answers = { ...standing(), [TODAY_LIST]: () => list };
  if (decided) asHandsFreeOS(list);
  const began = Date.now();
  await tick();
  const now = stateNow();
  const wake = alarms.get(AUTO_ALARM);
  /** When it's due again, in whole minutes from when the go began: the two goes of a scene are a moment apart. */
  const dueIn = (at: number | null | undefined) =>
    at == null ? null : Math.round((at - began) / MIN);
  return {
    did: [...world.did],
    opened: [...world.opened],
    line: now.line,
    tried: now.tried,
    read: Object.keys(now.daily ?? {}).sort(),
    before: Object.keys(now.before ?? {}).sort(),
    round: now.round ?? 0,
    started: now.started,
    stopped: now.stopped,
    replied: now.replied ?? [],
    readLast: now.readLast ?? false,
    needs: now.needs ?? false,
    /** How often it asked who's due a referral, and how many it did: never two looks a go. */
    referrals: postedTo(REFERRALS),
    referred: postedTo(REFERRAL_POSTED),
    /** When a referral, the helpful post and the newest posts are each looked for next. */
    referIn: dueIn(now.referAt),
    helpfulUp: now.helpfulUp ?? false,
    helpfulIn: dueIn(now.helpfulAt),
    watchIn: dueIn(now.watchAt),
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
  // A go that went wrong says so in its line: neither did.
  expect(ownCame.line ?? '').not.toMatch(/^Stopped for now/);
  expect(sentCame).toEqual(ownCame);
  if (ownWake === null) expect(sentWake).toBeNull();
  else expect(Math.abs((sentWake ?? 0) - ownWake)).toBeLessThan(2_000);
};

describe('the move HandsFreeOS’s rules send is the one the runner would have picked', () => {
  // One pace for both goes of a scene, so their waits can be compared too.
  beforeAll(() => void vi.spyOn(Math, 'random').mockReturnValue(0.5));
  afterAll(() => vi.restoreAllMocks());

  /** The hour it is now on the business's clock. */
  const hourNow = () =>
    Number(
      new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(
        new Date(),
      ),
    );
  const reply = { ...member('Lee Ortiz', 'lee.ortiz'), kind: 'reply', threadKey: 't-9' };
  const withReply = () =>
    ({ ...listOf([DANA, reply as TodayListItem]), messages: ['reply'] }) as unknown as TodayList;
  const postsOnItsOwn = () => void (world.choices = { ...world.choices, posting: 'own' });
  const watchesPosts = () => void (world.choices = { ...world.choices, watchPosts: true });
  /** Stop for today, pressed in the panel while a read goes. */
  const stopPressedMeanwhile = () =>
    void (world.during = () =>
      void store.set(KEY, { ...stateNow(), started: false, stopped: 'person' }));

  /**
   * Each: the day so far, today's list, what else is so, and the moves a go as HandsFreeOS decides is sent, in order
   * (one, unless it says: none after Stop for today; one more after each look that found nothing to do).
   */
  const scenes: Record<
    string,
    {
      readonly state?: () => Partial<State>;
      readonly list?: () => TodayList;
      readonly world?: () => void;
      readonly sends?: readonly string[];
    }
  > = {
    'a once-a-day read is next': { sends: ['daily'] },
    'the next once-a-day read, with some done': {
      state: () => ({ daily: { requests: 'Read.', tidy: 'Read.', occasions: 'Read.' } }),
      sends: ['daily'],
    },
    'the list’s turn, after a read': {
      state: () => ({ readLast: true }),
      list: () => listOf([DANA, SAM]),
      sends: ['work'],
    },
    'the reading’s turn, with a list to work': {
      list: () => listOf([DANA, SAM]),
      sends: ['daily'],
    },
    'the day’s reading done, and a list to work': {
      state: () => ({ daily: allRead(), ...looked() }),
      list: () => listOf([DANA, SAM]),
      sends: ['work'],
    },
    'someone on the list tried already today': {
      state: () => ({
        daily: allRead(),
        ...looked(),
        tried: [workKey({ do: 'step', item: DANA })],
      }),
      list: () => listOf([DANA, SAM]),
      sends: ['work'],
    },
    'nothing left to do': {
      state: () => ({ daily: allRead(), ...looked() }),
      sends: ['wait'],
    },
    'nothing left to do, and its hours end within the hour': {
      state: () => ({ daily: allRead(), ...looked() }),
      world: () =>
        void (world.hours = { start: 0, end: hourNow() + 1, days: [0, 1, 2, 3, 4, 5, 6] }),
      sends: ['wait'],
    },
    'nothing left to do, with some tried today': {
      state: () => ({
        daily: allRead(),
        ...looked(),
        tried: [workKey({ do: 'step', item: DANA })],
      }),
      list: () => listOf([DANA]),
      sends: ['wait'],
    },
    'the checks’ next few wait their turn later today': {
      state: () => ({
        daily: Object.fromEntries(Object.entries(allRead()).filter(([job]) => job !== 'checks')),
        againAt: { checks: Date.now() + 40 * MIN },
        ...looked(),
      }),
      sends: ['wait'],
    },
    'a message tried again waits its turn': {
      state: () => ({ daily: allRead(), ...looked() }),
      list: () => ({ ...listOf([]), retryAt: iso(Date.now() + 10 * MIN) }) as unknown as TodayList,
      sends: ['wait'],
    },
    'Facebook said no to two friend requests in a row today': {
      state: () => ({ daily: allRead(), ...looked(), requestsOff: true }),
      list: () => listOf([DANA, SAM]),
      sends: ['wait'],
    },
    'a first day': {
      list: () => listOf([DANA]),
      world: () => void (world.hfos['hfos-lists'] = () => NO_LISTS),
      sends: ['before'],
    },
    'a first day, where the save couldn’t go': {
      world: () => {
        world.hfos['hfos-lists'] = () => NO_LISTS;
        world.ends['before:friends'] = () => ({
          line: 'Couldn’t open your friends list.',
          warned: false,
          failed: true,
        });
      },
      sends: ['before'],
    },
    'Facebook warns as their friends are saved': {
      world: () => {
        world.hfos['hfos-lists'] = () => NO_LISTS;
        world.ends['before:friends'] = () => ({
          line: 'Facebook says to slow down.',
          warned: true,
        });
      },
      sends: ['before'],
    },
    'their friends saved, their requests not yet': {
      world: () =>
        void (world.hfos['hfos-lists'] = () => ({ ...NO_LISTS, friendsAt: iso(Date.now()) })),
      sends: ['before'],
    },
    'their friends due again, a week on, with the list’s turn': {
      state: () => ({ readLast: true }),
      list: () => listOf([DANA]),
      world: () => {
        const old = iso(Date.now() - 8 * 24 * 60 * MIN);
        world.hfos['hfos-lists'] = () => ({ ...savedLists(), friendsAt: old });
      },
      sends: ['work'],
    },
    'their groups not checked yet': {
      list: () => listOf([DANA]),
      world: () =>
        void (world.hfos['hfos-lists'] = () => ({ ...savedLists(), groupChecksAt: null })),
      sends: ['before'],
    },
    'their groups’ first check couldn’t go': {
      world: () => {
        world.hfos['hfos-lists'] = () => ({ ...savedLists(), groupChecksAt: null });
        world.ends['before:group_checks'] = () => ({
          line: 'Couldn’t open your groups.',
          warned: false,
          failed: true,
        });
      },
      sends: ['before'],
    },
    'the old requests to cancel not worked out yet': {
      list: () => listOf([DANA]),
      world: () => void (world.hfos['hfos-lists'] = () => ({ ...savedLists(), tidyAt: null })),
      sends: ['before'],
    },
    'the first check of their friends not done yet': {
      world: () => void (world.hfos['hfos-lists'] = () => ({ ...savedLists(), checksAt: null })),
      sends: ['before'],
    },
    'short of good fits, with the day’s reading done': {
      state: () => ({ daily: allRead(), more: true }),
      list: () => ({ ...listOf([]), goal: { more: true } }) as unknown as TodayList,
      sends: ['daily'],
    },
    'Collect off, and a list to work': {
      state: looked,
      list: () => listOf([DANA, SAM]),
      world: () => void (world.choices = { ...world.choices, collect: false }),
      sends: ['work'],
    },
    'Collect off, and nothing on the list': {
      state: looked,
      world: () => void (world.choices = { ...world.choices, collect: false }),
      sends: ['wait'],
    },
    'a comment research of theirs is reading': {
      world: () =>
        void (world.hfos['hfos-comment-research-next'] = () => ({ research: { id: 'r-1' } })),
      sends: ['daily'],
    },
    'Facebook warns on a once-a-day read': {
      world: () =>
        void (world.ends.requests = () => ({ line: 'Facebook says to slow down.', warned: true })),
      sends: ['daily'],
    },
    'someone wrote back, with the day’s reading to do': {
      state: () => ({ replied: ['p-dana.reyes'] }),
      list: () => listOf([DANA]),
      sends: ['work'],
    },
    'someone who wrote back isn’t on the list any more, with others to work': {
      state: () => ({ replied: ['p-gone'] }),
      list: () => listOf([DANA]),
      sends: ['work'],
    },
    'someone who wrote back isn’t on the list any more, and nothing else is': {
      state: () => ({ replied: ['p-gone'] }),
      sends: ['daily'],
    },
    'their day started by hand, outside the hours': {
      list: () => listOf([DANA]),
      state: () => ({ daily: allRead() }),
      world: () => {
        world.hours = notToday();
        world.kept = startedByHand();
      },
      sends: ['work'],
    },
    'their day started by hand in the hours, with a list to work': {
      list: () => listOf([DANA, SAM]),
      state: () => ({ daily: allRead(), ...looked() }),
      world: () => void (world.kept = startedByHand()),
      sends: ['work'],
    },
    'started by hand outside the hours, with nothing left': {
      state: () => ({ daily: allRead() }),
      world: () => {
        world.hours = notToday();
        world.kept = startedByHand();
      },
      sends: ['wait'],
    },
    'outside the hours, with only new people on the list': {
      list: () => listOf([DANA]),
      world: () => void (world.hours = notToday()),
      sends: ['wait'],
    },
    'outside the hours, with someone who wrote back': {
      list: withReply,
      world: () => void (world.hours = notToday()),
      sends: ['work'],
    },
    'outside the hours, with a comment research reading': {
      world: () => {
        world.hours = notToday();
        world.hfos['hfos-comment-research-next'] = () => ({ research: { id: 'r-1' } });
      },
      sends: ['daily'],
    },
    'outside the hours, with someone who wrote back and a comment research reading': {
      list: withReply,
      world: () => {
        world.hours = notToday();
        world.hfos['hfos-comment-research-next'] = () => ({ research: { id: 'r-1' } });
      },
      sends: ['work'],
    },
    'outside the hours, with a message tried again waiting its turn': {
      list: () => ({ ...listOf([]), retryAt: iso(Date.now() + 10 * MIN) }) as unknown as TodayList,
      world: () => void (world.hours = notToday()),
      sends: ['wait'],
    },
    'Stop for today pressed': {
      list: () => listOf([DANA]),
      world: () =>
        void (world.kept = {
          ...nothingPressed(),
          day: { date: today(), state: 'stopped', why: 'person' },
        }),
      sends: [],
    },
    'Stop for today pressed while a once-a-day read went': {
      world: stopPressedMeanwhile,
      sends: ['daily'],
    },
    'Stop for today pressed while their friends were saved': {
      world: () => {
        world.hfos['hfos-lists'] = () => NO_LISTS;
        stopPressedMeanwhile();
      },
      sends: ['before'],
    },
    // A referral, or an ask after two, to do for the person (decision 185): looked for every half hour in the hours.
    'a referral to do, with the day’s reading done': {
      state: () => ({ daily: allRead() }),
      list: () => listOf([DANA]),
      world: () => void (world.due = A_REFERRAL),
      sends: ['refer'],
    },
    'Facebook warns on the referral’s post': {
      state: () => ({ daily: allRead() }),
      list: () => listOf([DANA]),
      world: () => {
        world.due = A_REFERRAL_ON_A_POST;
        world.pages = WARNING_ON_THE_POST;
      },
      sends: ['refer'],
    },
    'no referral to do, and a list to work': {
      state: () => ({ daily: allRead() }),
      list: () => listOf([DANA, SAM]),
      sends: ['refer', 'work'],
    },
    'no referral to do, and nothing on the list': {
      state: () => ({ daily: allRead() }),
      sends: ['refer', 'wait'],
    },
    'a referral looked for half an hour ago is looked for again': {
      state: () => ({ daily: allRead(), referAt: Date.now() - MIN }),
      list: () => listOf([DANA]),
      world: () => void (world.due = A_REFERRAL),
      sends: ['refer'],
    },
    'a referral to do, with the day’s reading still to do': {
      world: () => void (world.due = A_REFERRAL),
      sends: ['daily'],
    },
    'a referral to do, their day started by hand outside the hours': {
      state: () => ({ daily: allRead() }),
      list: () => listOf([DANA]),
      world: () => {
        world.due = A_REFERRAL;
        world.hours = notToday();
        world.kept = startedByHand();
      },
      sends: ['work'],
    },
    // Today's helpful post, where they let it go up on its own (decision 50): in the hours only.
    'the helpful post goes up on its own, with the day’s reading done': {
      state: () => ({ daily: allRead(), ...looked() }),
      list: () => listOf([DANA]),
      world: () => {
        postsOnItsOwn();
        world.post = UP;
      },
      sends: ['post'],
    },
    'the helpful post couldn’t go up': {
      state: () => ({ daily: allRead(), ...looked() }),
      list: () => listOf([DANA]),
      world: () => {
        postsOnItsOwn();
        world.post = () => ({ line: 'Couldn’t post in Tile Pros.', warned: false, failed: true });
      },
      sends: ['post'],
    },
    'Facebook warns as the helpful post goes up': {
      state: () => ({ daily: allRead(), ...looked() }),
      list: () => listOf([DANA]),
      world: () => {
        postsOnItsOwn();
        world.post = () => ({ line: 'Facebook says to slow down.', warned: true });
      },
      sends: ['post'],
    },
    'no helpful post written yet, and a list to work': {
      state: () => ({ daily: allRead(), ...looked() }),
      list: () => listOf([DANA, SAM]),
      world: postsOnItsOwn,
      sends: ['post', 'work'],
    },
    'no helpful post written yet, and nothing on the list': {
      state: () => ({ daily: allRead(), ...looked() }),
      world: postsOnItsOwn,
      sends: ['post', 'wait'],
    },
    'no referral to do, then the helpful post goes up': {
      state: () => ({ daily: allRead() }),
      list: () => listOf([DANA]),
      world: () => {
        postsOnItsOwn();
        world.post = UP;
      },
      sends: ['refer', 'post'],
    },
    'no referral to do and no helpful post written yet, and a list to work': {
      state: () => ({ daily: allRead() }),
      list: () => listOf([DANA, SAM]),
      world: postsOnItsOwn,
      sends: ['refer', 'post', 'work'],
    },
    'the helpful post looked for a while ago, and a list to work': {
      state: () => ({ daily: allRead(), ...looked(), helpfulAt: Date.now() + 20 * MIN }),
      list: () => listOf([DANA]),
      world: () => {
        postsOnItsOwn();
        world.post = UP;
      },
      sends: ['work'],
    },
    'the helpful post due to be looked for again': {
      state: () => ({ daily: allRead(), ...looked(), helpfulAt: Date.now() - MIN }),
      world: () => {
        postsOnItsOwn();
        world.post = UP;
      },
      sends: ['post'],
    },
    'the helpful post up already today': {
      state: () => ({
        daily: allRead(),
        ...looked(),
        helpfulUp: true,
        helpfulAt: Date.now() - MIN,
      }),
      list: () => listOf([DANA]),
      world: () => {
        postsOnItsOwn();
        world.post = UP;
      },
      sends: ['work'],
    },
    'their posts wait for their OK': {
      state: () => ({ daily: allRead(), ...looked() }),
      list: () => listOf([DANA]),
      world: () => void (world.post = UP),
      sends: ['work'],
    },
    'posting on its own, with a read put by for later today': {
      // The checks' next few wait their turn: nothing reads now, and the day's post was asked for, so it goes up.
      state: () => ({
        daily: Object.fromEntries(Object.entries(allRead()).filter(([job]) => job !== 'checks')),
        againAt: { checks: Date.now() + 40 * MIN },
        ...looked(),
      }),
      world: () => {
        postsOnItsOwn();
        world.post = UP;
      },
      sends: ['post'],
    },
    'posting on its own, with today’s post not asked for yet': {
      // The read that asks for it is put by for later today, so no read goes now, and nor does the post.
      state: () => ({
        daily: Object.fromEntries(Object.entries(allRead()).filter(([job]) => job !== 'helpful')),
        againAt: { helpful: Date.now() + 40 * MIN },
        ...looked(),
      }),
      list: () => listOf([DANA]),
      world: () => {
        postsOnItsOwn();
        world.post = UP;
      },
      sends: ['work'],
    },
    'posting on its own with Collect off: no read asks for the post first': {
      state: looked,
      list: () => listOf([DANA]),
      world: () => {
        world.choices = { ...world.choices, collect: false, posting: 'own' };
        world.post = UP;
      },
      sends: ['post'],
    },
    'posting on its own, their day started by hand outside the hours: nothing new goes up': {
      state: () => ({ daily: allRead() }),
      list: () => listOf([DANA]),
      world: () => {
        postsOnItsOwn();
        world.post = UP;
        world.hours = notToday();
        world.kept = startedByHand();
      },
      sends: ['work'],
    },
    'outside the hours, posting on its own: nothing new goes up': {
      state: () => ({ daily: allRead() }),
      world: () => {
        postsOnItsOwn();
        world.post = UP;
        world.hours = notToday();
      },
      sends: ['wait'],
    },
    // The newest posts at the top of their best groups (decision 49): every hour or two, in the hours.
    'the newest posts are due': {
      state: () => ({ daily: allRead(), ...looked() }),
      list: () => listOf([DANA]),
      world: watchesPosts,
      sends: ['watch'],
    },
    'the newest posts looked at a while ago, and a list to work': {
      state: () => ({ daily: allRead(), ...looked(), watchAt: Date.now() + 20 * MIN }),
      list: () => listOf([DANA]),
      world: watchesPosts,
      sends: ['work'],
    },
    'the newest posts looked at a while ago, and nothing left': {
      state: () => ({ daily: allRead(), ...looked(), watchAt: Date.now() + 20 * MIN }),
      world: watchesPosts,
      sends: ['wait'],
    },
    'the newest posts due again, with the day’s reading still to do': {
      state: () => ({ watchAt: Date.now() - MIN }),
      world: watchesPosts,
      sends: ['daily'],
    },
    'Facebook warns on the newest posts': {
      state: () => ({ daily: allRead(), ...looked() }),
      world: () => {
        watchesPosts();
        world.ends.watch = () => ({ line: 'Facebook says to slow down.', warned: true });
      },
      sends: ['watch'],
    },
    'Stop for today pressed while the newest posts were looked at': {
      state: () => ({ daily: allRead(), ...looked() }),
      world: () => {
        watchesPosts();
        stopPressedMeanwhile();
      },
      sends: ['watch'],
    },
    'the newest posts due, their day started by hand outside the hours': {
      state: () => ({ daily: allRead() }),
      list: () => listOf([DANA]),
      world: () => {
        watchesPosts();
        world.hours = notToday();
        world.kept = startedByHand();
      },
      sends: ['work'],
    },
    'no referral to do, no helpful post written yet, then the newest posts': {
      state: () => ({ daily: allRead() }),
      list: () => listOf([DANA]),
      world: () => {
        postsOnItsOwn();
        watchesPosts();
      },
      sends: ['refer', 'post', 'watch'],
    },
    'the helpful post up, then nothing left till the newest posts are due': {
      state: () => ({
        daily: allRead(),
        ...looked(),
        helpfulUp: true,
        watchAt: Date.now() + 25 * MIN,
      }),
      world: () => {
        postsOnItsOwn();
        watchesPosts();
      },
      sends: ['wait'],
    },
  };

  for (const [name, scene] of Object.entries(scenes))
    it(`${name}`, async () => {
      scene.world?.();
      const list = scene.list?.() ?? listOf([]);
      const itself = await goFrom(scene.state?.() ?? {}, list, false);
      const sent = await goFrom(scene.state?.() ?? {}, list, true);
      // After Stop for today its own checks hold it: it never asks. After a look with nothing to do, it asks again.
      const sends = scene.sends ?? [];
      expect(world.sent.map((move) => move.do)).toEqual(sends);
      expect(asks()).toHaveLength(sends.length);
      if (sends.length) expect(didAsSent()).toBe(true);
      expectSame(sent, itself);
    });

  it('covers what a go can come to: each kind of read, the list’s work, a referral, the post, the newest posts, and each wait', async () => {
    // What the scenes above came to, by themselves: a guard that they stay worth comparing.
    const seen = new Set<string>();
    for (const [name, scene] of Object.entries(scenes)) {
      freshWorld();
      scene.world?.();
      const came = await goFrom(scene.state?.() ?? {}, scene.list?.() ?? listOf([]), false);
      const worked = came.opened.some((url) => !url.includes('/groups/'));
      const then = worked ? 'work' : came.did.includes('watch') ? 'watch' : 'wait';
      // A referral looked for with none to do, a post looked for with none written, and what the go went on to.
      if (came.referrals && !came.referred && !came.stopped && !came.did.includes('post'))
        seen.add(`no referral, then ${then}`);
      if (came.did.includes('post') && !came.helpfulUp && !came.stopped)
        seen.add(`no post, then ${then}`);
      if (came.referred) seen.add('referral');
      if (came.stopped === 'warning') seen.add('warning');
      seen.add(came.did[0]?.replace(/:.*/, '') ?? (worked ? 'work' : `wait: ${name}`));
    }
    for (const kind of [
      'requests',
      'group_checks',
      'comment_research',
      'before',
      'work',
      'referral',
      'post',
      'watch',
      'warning',
      'no referral, then work',
      'no referral, then wait',
      'no post, then work',
      'no post, then wait',
      'no post, then watch',
    ])
      expect([...seen]).toContain(kind);
    expect([...seen].filter((kind) => kind.startsWith('wait')).length).toBeGreaterThanOrEqual(8);
  });

  it('is where Facebook’s rules part from the other networks’: only its runner does referrals, and watches its groups', () => {
    expect(RUNNERS.facebook).toMatchObject({ refers: true, watches: true, posts: true });
    for (const platform of ['linkedin', 'instagram', 'alignable', 'threads', 'x'] as const)
      expect(RUNNERS[platform]).toMatchObject({ refers: false, watches: false });
    // Its reads never wait for the person to be away, and its steps go at the day's own spread.
    expect(RUNNERS.facebook).toMatchObject({ savesAway: false, paced: false });
  });
});
