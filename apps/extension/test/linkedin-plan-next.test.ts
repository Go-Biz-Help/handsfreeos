/**
 * LinkedIn's runner asking HandsFreeOS for its next move (src/auto/linkedin.ts `go`, src/hfos/plan.ts `planNext`;
 * docs/outreach.md decision 195, step 2), with the extension's storage, HandsFreeOS, LinkedIn's tab and each of the
 * runner's reads stood in for, so what a go chose to do is what's seen. Once its own checks let it work it asks, with
 * what only this computer knows, and does the move it's sent as it does its own: the read, the wait, the piece of its
 * list's work HandsFreeOS picked, today's helpful post put up on its own, and what the move changed in its day. It
 * plans the go itself, as it always has, whenever HandsFreeOS doesn't decide, can't be reached, or sends a move it
 * can't do; and it never asks while its own checks hold it. Like Alignable's, a save of the person's lists is tried
 * whenever it's due, and puts itself off when its page needs the screen.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TodayList, TodayListItem } from '../src/hfos/messages';

const LI = 'https://www.linkedin.com';
const ME = { userId: 'u-casey', businessId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' };
const COMPUTER = '5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f';
const TZ = 'America/Chicago';
const MIN = 60_000;
const NEXT = '/v1/queries/outreach.plan.next';
const TODAY_LIST = '/v1/queries/outreach.today';
/** What a read says when it's put off till the person is away. */
const PUT_OFF = 'Put off till you’re away.';
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
  choices: {} as Record<string, unknown>,
  hours: { start: 0, end: 24, days: [0, 1, 2, 3, 4, 5, 6] } as Record<string, unknown>,
  kept: null as Record<string, unknown> | null,
  away: true,
  noting: true,
  asking: false,
  warned: null as { words: string[] } | null,
  /** The reads that need their window on screen: put off while the person's at their computer. */
  screen: new Set<string>(),
  /** How putting today's helpful post up ends. */
  post: (): Record<string, unknown> => ({ line: '', warned: false }),
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
    settings: {
      voice: { split: false },
      hours: world.hours,
      networks: { linkedin: world.choices },
    },
  }),
}));
vi.mock('../src/hfos/live', async (original) => ({
  ...(await original<object>()),
  keptFor: async () => world.kept,
  onBeat: () => undefined,
  feed: async () => undefined,
  computer: async () => ({ id: COMPUTER, fresh: false, name: 'Chrome on Mac', version: '0.159.0' }),
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
  world.did.push(name === 'posts' ? `posts:${job?.round ?? 0}` : name);
  return { line: `Did ${name}.`, warned: false };
};
vi.mock('../src/jobs/chats', async (original) => ({
  ...(await original<object>()),
  readChats: read('chats'),
}));
vi.mock('../src/jobs/linkedin/checks', async (original) => ({
  ...(await original<object>()),
  checkConnections: read('checks'),
}));
vi.mock('../src/jobs/linkedin/people', async (original) => ({
  ...(await original<object>()),
  checkInvitations: read('requests'),
}));
vi.mock('../src/jobs/linkedin/withdraw', async (original) => ({
  ...(await original<object>()),
  withdrawOnItsOwn: read('tidy'),
}));
vi.mock('../src/jobs/occasions', async (original) => ({
  ...(await original<object>()),
  linkedInOccasions: read('occasions'),
}));
vi.mock('../src/jobs/linkedin/posts', async (original) => ({
  ...(await original<object>()),
  findPostsBySearch: read('posts'),
}));
vi.mock('../src/jobs/linkedin/post-people', async (original) => ({
  ...(await original<object>()),
  readPostPeople: read('post_people'),
}));
vi.mock('../src/jobs/linkedin/helpful', async (original) => ({
  ...(await original<object>()),
  linkedInHelpfulAsk: read('helpful'),
  readLinkedInEngaged: read('engaged'),
  // Today's helpful post put up on its own: up, couldn't go, none written yet, or a warning, as the scene says.
  postOnLinkedIn: async () => {
    world.did.push('post');
    return world.post();
  },
}));
vi.mock('../src/jobs/linkedin/comment-research', () => ({
  readLinkedInComments: read('comment_research'),
}));
vi.mock('../src/jobs/found-checks', () => ({ checkFound: read('found_checks') }));
vi.mock('../src/jobs/own-read', () => ({ readProfileOnItsOwn: read('profile') }));
vi.mock('../src/jobs/partners', async (original) => ({
  ...(await original<object>()),
  checkPartners: read('partners'),
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
// LinkedIn's tab opens no page here: a step on the list gets as far as its first page, which is what's seen.
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
      getManifest: () => ({ version: '0.159.0' }),
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

const { linkedInTick, LINKEDIN_ALARM } = await import('../src/auto/linkedin');
const { LINKEDIN_STATE_KEY, freshState, workKey, HELPFUL_AGAIN_MS } =
  await import('../src/auto/plan');
const { businessDay } = await import('@hfos/core/addons/outreach/automation');
const { markOf } = await import('../src/auto/lists');
const { ASK_FIRST_WORDS } = await import('@hfos/core/addons/outreach/asks');
const { LIST_MARKS_ON, NO_LISTS } = await import('@hfos/core/addons/outreach/lists');
const { LINKEDIN_DAILY, LINKEDIN_FINDING, LINKEDIN_GAP_MS, RUNNERS } =
  await import('@hfos/core/addons/outreach/runners');
const { nextMove, planDayOf, PlanState } = await import('@hfos/core/addons/outreach/plan');
const { changeSent, moveSent } = await import('@hfos/core/addons/outreach/plan-next');

type State = ReturnType<typeof freshState>;
const KEY = LINKEDIN_STATE_KEY;
const today = () => businessDay(Date.now(), TZ);
const iso = (ms: number) => new Date(ms).toISOString();
/**
 * Their connections and the invitations either way saved, the old ones to withdraw worked out and the first checks
 * done, today: nothing's due before the day.
 */
const savedLists = () => ({
  ...NO_LISTS,
  friendsAt: iso(Date.now()),
  requestsAt: iso(Date.now()),
  sentAt: iso(Date.now()),
  tidyAt: iso(Date.now()),
  checksAt: iso(Date.now()),
});
const stateNow = () => store.get(KEY) as State;
const begin = (more: Partial<State> = {}) => store.set(KEY, { ...freshState(today()), ...more });
const asks = () => world.posted.filter((p) => p.path === NEXT);
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
const UP = () => ({ line: 'It’s up on your feed.', warned: false, posted: true });
const NONE = () => ({ line: NONE_WRITTEN, warned: false });

const member = (name: string, id: string): TodayListItem =>
  ({
    kind: 'friend_request',
    name,
    profileId: `p-${id}`,
    platformId: null,
    profileUrl: `${LI}/in/${id}/`,
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
const DANA = member('Dana Reyes', 'dana-reyes');
const SAM = member('Sam Lee', 'sam-lee');
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

const freshWorld = () => {
  world.hfos = {
    'hfos-lists': savedLists,
    'hfos-comment-research-next': () => ({ research: null }),
  };
  world.choices = { on: true, sending: 'steps', collect: true, warmUp: true, posting: 'after_ok' };
  world.hours = { start: 0, end: 24, days: [0, 1, 2, 3, 4, 5, 6] };
  world.kept = { working: true, workingName: null, days: {} };
  world.away = true;
  world.noting = true;
  world.asking = false;
  world.warned = null;
  world.screen.clear();
  world.post = NONE;
};

beforeEach(() => {
  store.clear();
  alarms.clear();
  world.did.length = 0;
  world.opened.length = 0;
  world.asked.length = 0;
  world.posted.length = 0;
  world.answers = {};
  world.sent.length = 0;
  freshWorld();
  begin();
});

describe('a go that HandsFreeOS decides (decision 195, step 2)', () => {
  it('asks with where its day is up to, its own clock, and what only this computer knows', async () => {
    world.away = false;
    told({ do: 'wait', why: 'idle', until: Date.now() + 30 * MIN });
    const before = Date.now();
    await linkedInTick();
    expect(asks()).toHaveLength(1);
    const { body } = asks()[0]!;
    expect(body).toMatchObject({
      workspaceId: ME.businessId,
      platform: 'linkedin',
      computer: COMPUTER,
      here: { away: false, passOver: [], research: false, asking: false },
    });
    expect(body.now).toBeGreaterThanOrEqual(before);
    expect(body.now).toBeLessThanOrEqual(Date.now());
    expect(body.random).toBeGreaterThanOrEqual(0);
    expect(body.random).toBeLessThanOrEqual(1);
    // The state as it stands now: today's, with the comment research HandsFreeOS said isn't theirs kept for the day,
    // and where today's helpful post is up to.
    const state = body.state as Record<string, unknown>;
    expect(state.day).toBe(today());
    expect(state.tried).toEqual([]);
    expect(state.daily).toHaveProperty('comment_research');
    expect(state).toMatchObject({ helpfulUp: false, helpfulAt: null });
  });

  it('does the read it’s sent, not the one it would have picked, and waits as long as it’s told', async () => {
    told({ do: 'daily', job: 'chats', gap: 5 * MIN });
    const before = Date.now();
    await linkedInTick();
    // By itself, their invitations come first.
    expect(world.did).toEqual(['chats']);
    const state = stateNow();
    expect(state.daily).toMatchObject({ chats: 'Did chats.' });
    expect(state.daily).not.toHaveProperty('requests');
    expect(state.readLast).toBe(true);
    expect(alarms.get(LINKEDIN_ALARM)).toBeGreaterThanOrEqual(before + 5 * MIN);
    expect(alarms.get(LINKEDIN_ALARM)).toBeLessThan(Date.now() + 5 * MIN + 1_000);
  });

  it('never goes again sooner than its own pace, whatever wait comes with a read', async () => {
    told({ do: 'daily', job: 'requests', gap: 1_000 });
    const before = Date.now();
    await linkedInTick();
    expect(world.did).toEqual(['requests']);
    expect(alarms.get(LINKEDIN_ALARM)).toBeGreaterThanOrEqual(before + LINKEDIN_GAP_MS.least);
  });

  it('does the step before its day it’s sent, at their computer too: a save puts itself off when it must', async () => {
    world.away = false;
    world.hfos['hfos-lists'] = () => NO_LISTS;
    told({ do: 'before', step: { do: 'save', list: 'friends', first: true }, gap: 4 * MIN });
    await linkedInTick();
    expect(world.did).toEqual(['before:friends']);
    expect(stateNow().before).toMatchObject({ friends: 'Saved 3 connections.' });
    // One whose page needs the screen is put off by its own tab, and the list has its turn next.
    world.did.length = 0;
    begin();
    world.screen.add('before:friends');
    await linkedInTick();
    expect(world.did).toEqual([]);
    expect(stateNow().before ?? {}).not.toHaveProperty('friends');
    expect(stateNow().readLast).toBe(true);
    // And one it wouldn't have picked: with their lists saved, by itself it would check their invitations.
    world.hfos['hfos-lists'] = savedLists;
    begin();
    told({ do: 'before', step: { do: 'tidy' }, gap: 4 * MIN });
    await linkedInTick();
    expect(world.did).toEqual(['before:tidy']);
  });

  it('waits as it’s told, with its own words for each wait, and looks again when HandsFreeOS said', async () => {
    const until = Date.now() + 7 * MIN;
    told({ do: 'wait', why: 'asks', until });
    await linkedInTick();
    expect(world.did).toEqual([]);
    expect(stateNow()).toMatchObject({ line: ASK_FIRST_WORDS, nextAt: until });
    expect(alarms.get(LINKEDIN_ALARM)).toBe(until);

    told({ do: 'wait', why: 'idle', until: until + MIN });
    await linkedInTick();
    expect(stateNow().line).toMatch(/^Nothing on your LinkedIn list for it to do yet\./);
    expect(stateNow().nextAt).toBe(until + MIN);

    told({ do: 'wait', why: 'hours', until: until + 2 * MIN });
    await linkedInTick();
    expect(stateNow().line).toMatch(/Start my day for LinkedIn/);
    expect(stateNow().nextAt).toBe(until + 2 * MIN);

    // A warning HandsFreeOS knows of holds it till it asks again: its own state is left to what this computer saw.
    told({ do: 'wait', why: 'warned', until: until + 3 * MIN });
    await linkedInTick();
    expect(stateNow().line).toMatch(/^Stopped: LinkedIn warned you today\./);
    expect(stateNow().stopped).toBeNull();
    expect(stateNow().nextAt).toBe(until + 3 * MIN);

    told({ do: 'wait', why: 'noting', until: until + 4 * MIN });
    await linkedInTick();
    expect(stateNow().line).toMatch(/^Turn on noting your steps/);
    expect(stateNow().needs).toBe(true);
    expect(stateNow().nextAt).toBe(until + 4 * MIN);

    told({ do: 'wait', why: 'off', until: null });
    await linkedInTick();
    expect(stateNow().nextAt).toBeNull();
    expect(alarms.has(LINKEDIN_ALARM)).toBe(false);
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
    await linkedInTick();
    // By itself, Dana is first on the list.
    expect(world.opened[0]).toBe(SAM.profileUrl);
    expect(world.opened).not.toContain(DANA.profileUrl);
    expect(stateNow().tried).toEqual([key]);
    // The list came with the answer: it isn't asked for again.
    expect(world.posted.map((p) => p.path)).not.toContain(TODAY_LIST);
    expect(world.did).toEqual([]);
  });

  it('keeps what the move changed in its day: a round of finding again begun', async () => {
    const lines = Object.fromEntries(LINKEDIN_DAILY.map((job) => [job, `Own line for ${job}.`]));
    begin({ daily: lines });
    const still = Object.fromEntries(
      Object.entries(lines)
        .filter(([job]) => !(LINKEDIN_FINDING as readonly string[]).includes(job))
        .map(([job]) => [job, 'Clipped.']),
    );
    const roundAt = Date.now() - 1_000;
    told(
      { do: 'daily', job: 'posts', gap: 4 * MIN },
      { change: { daily: still, round: 1, roundAt } },
    );
    await linkedInTick();
    // The read asks HandsFreeOS for its search words with the round it's in.
    expect(world.did).toEqual(['posts:1']);
    expect(world.asked.find((ask) => ask.type === 'hfos-post-words')).toMatchObject({ round: 1 });
    const state = stateNow();
    expect(state).toMatchObject({ round: 1, roundAt });
    // Each line stays its own; the finding jobs are to do once more, and the one it did is done again.
    expect(state.daily).toMatchObject({
      requests: 'Own line for requests.',
      chats: 'Own line for chats.',
      posts: 'Did posts.',
    });
    expect(state.daily).not.toHaveProperty('found_checks');
    expect(state.daily).not.toHaveProperty('post_people');
  });

  it('puts today’s helpful post up when it’s sent, and goes next at the pace sent with it', async () => {
    world.post = UP;
    told({ do: 'post', gap: 5 * MIN });
    const before = Date.now();
    await linkedInTick();
    // By itself, with their posts waiting for their OK, it never would: it would check their invitations.
    expect(world.did).toEqual(['post']);
    expect(asks()).toHaveLength(1);
    const state = stateNow();
    expect(state.line).toBe('Helpful post: It’s up on your feed.');
    expect(state.helpfulUp).toBe(true);
    expect(alarms.get(LINKEDIN_ALARM)).toBeGreaterThanOrEqual(before + 5 * MIN);
    expect(alarms.get(LINKEDIN_ALARM)).toBeLessThan(Date.now() + 5 * MIN + 1_000);

    // One that couldn't go is done for today too.
    begin();
    world.did.length = 0;
    world.post = () => ({
      line: 'Couldn’t post on your LinkedIn feed.',
      warned: false,
      failed: true,
    });
    await linkedInTick();
    expect(world.did).toEqual(['post']);
    expect(stateNow().helpfulUp).toBe(true);
    expect(asks()).toHaveLength(2);

    // A warning as it goes up stops the day there.
    begin();
    world.did.length = 0;
    world.post = () => ({ line: 'LinkedIn warned you.', warned: true });
    await linkedInTick();
    expect(world.did).toEqual(['post']);
    expect(stateNow()).toMatchObject({ stopped: 'warning', line: 'LinkedIn warned you.' });
    expect(asks()).toHaveLength(3);
  });

  it('asks once more with no helpful post written yet, and does what goes meanwhile', async () => {
    const roundAt = Date.now() - 1_000;
    toldInTurn(
      { move: { do: 'post', gap: 5 * MIN }, change: { round: 2, roundAt } },
      { move: { do: 'daily', job: 'chats', gap: 4 * MIN } },
    );
    const before = Date.now();
    await linkedInTick();
    expect(world.did).toEqual(['post', 'chats']);
    expect(asks()).toHaveLength(2);
    // What came with the post is kept, and the second ask says the post was looked for: it's due again in a while.
    const again = asks()[1]!.body.state as Record<string, unknown>;
    expect(again).toMatchObject({ helpfulUp: false, round: 2, roundAt });
    expect(again.helpfulAt).toBeGreaterThanOrEqual(before + HELPFUL_AGAIN_MS);
    // The go keeps one clock and one pace for both asks.
    expect(asks()[1]!.body.now).toBe(asks()[0]!.body.now);
    expect(asks()[1]!.body.random).toBe(asks()[0]!.body.random);
    expect(stateNow().daily).toMatchObject({ chats: 'Did chats.' });
  });

  it('looks for the helpful post once a go, whatever it’s sent, and plans the rest itself', async () => {
    // Sent the post again though it was just looked for: it isn't tried twice, and the go goes on by its own order.
    told({ do: 'post', gap: 5 * MIN });
    await linkedInTick();
    expect(world.did).toEqual(['post', 'requests']);
    expect(asks()).toHaveLength(2);
    expect(stateNow().helpfulUp).toBe(false);

    // HandsFreeOS out of reach by the second ask, with the day's reading done and the post theirs to go up on its
    // own: by its own order the post would be next, and it was just looked for.
    begin({ daily: Object.fromEntries(LINKEDIN_DAILY.map((job) => [job, `Read ${job}.`])) });
    world.did.length = 0;
    let n = 0;
    world.answers[NEXT] = () => {
      if (n++) throw new Error('The answer never came.');
      return { decides: true, move: { do: 'post', gap: 5 * MIN }, change: null, list: null };
    };
    world.answers[TODAY_LIST] = () => listOf([]);
    world.choices = { ...world.choices, posting: 'own' };
    await linkedInTick();
    expect(world.did).toEqual(['post']);
    expect(stateNow().line).toMatch(/^Nothing on your LinkedIn list for it to do yet\./);
  });

  it('answers outside its hours only as it’s sent: it waits, or reads a comment research', async () => {
    // No working hours today, and nothing pressed.
    world.hours = { start: 9, end: 17, days: [(new Date().getDay() + 3) % 7], everyDay: false };
    const until = Date.now() + 90 * MIN;
    told({ do: 'wait', why: 'hours', until });
    await linkedInTick();
    expect(world.did).toEqual([]);
    expect(stateNow().nextAt).toBe(until);

    told({ do: 'daily', job: 'comment_research', gap: 4 * MIN });
    await linkedInTick();
    expect(world.did).toEqual(['comment_research']);
    // Outside the hours the list has no turn to take.
    expect(stateNow().readLast).not.toBe(true);

    // Nothing new goes up outside the hours: a helpful post sent then is turned down, and it waits as it would.
    world.did.length = 0;
    world.post = UP;
    told({ do: 'post', gap: 4 * MIN });
    world.answers[TODAY_LIST] = () => listOf([]);
    await linkedInTick();
    expect(world.did).toEqual([]);
    expect(stateNow().line).toMatch(/Start my day for LinkedIn/);
  });
});

describe('a go it plans itself, as it always has', () => {
  const itsOwn = async () => {
    world.did.length = 0;
    world.opened.length = 0;
    begin();
    await linkedInTick();
    return [...world.did];
  };

  it('goes on by its own order when HandsFreeOS can’t be reached, or leaves the order to it', async () => {
    // No answer at all: no connection, or a HandsFreeOS from before runners asked.
    expect(await itsOwn()).toEqual(['requests']);
    expect(asks()).toHaveLength(1);
    // As HandsFreeOS answers while LinkedIn isn't switched on.
    world.answers[NEXT] = () => ({ decides: false, move: null, change: null, list: null });
    expect(await itsOwn()).toEqual(['requests']);
    world.answers[NEXT] = () => {
      throw new Error('The answer never came.');
    };
    expect(await itsOwn()).toEqual(['requests']);
    expect(stateNow().daily).toMatchObject({ requests: 'Did requests.' });
  });

  it('puts the helpful post up by itself, as it always has, once the day’s reading is done', async () => {
    world.choices = { ...world.choices, posting: 'own' };
    world.post = UP;
    const allRead = Object.fromEntries(LINKEDIN_DAILY.map((job) => [job, `Read ${job}.`]));
    world.did.length = 0;
    begin({ daily: allRead });
    await linkedInTick();
    expect(world.did).toEqual(['post']);
    expect(stateNow()).toMatchObject({
      helpfulUp: true,
      line: 'Helpful post: It’s up on your feed.',
    });
    // It's up: never again today.
    world.did.length = 0;
    world.answers[TODAY_LIST] = () => listOf([]);
    await linkedInTick();
    expect(world.did).toEqual([]);
  });

  it('plans for itself when it’s sent a move it can’t do as things stand', async () => {
    // A read that isn't LinkedIn's.
    told({ do: 'daily', job: 'follow_backs', gap: 4 * MIN });
    expect(await itsOwn()).toEqual(['requests']);
    // A move from a later HandsFreeOS.
    told({ do: 'dance', gap: 4 * MIN });
    expect(await itsOwn()).toEqual(['requests']);
    // Threads' and X's hourly search, and Facebook's newest posts, aren't LinkedIn's.
    told({ do: 'search', gap: 4 * MIN });
    expect(await itsOwn()).toEqual(['requests']);
    told({ do: 'watch', gap: 4 * MIN });
    expect(await itsOwn()).toEqual(['requests']);
    // A wait for the screen is Instagram's, Threads' and X's: a save here is tried, and puts itself off.
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
    // A step before the day that isn't one of LinkedIn's.
    told({ do: 'before', step: { do: 'group_checks' }, gap: 4 * MIN });
    expect(await itsOwn()).toEqual(['requests']);
    told({ do: 'before', step: { do: 'save', list: 'groups', first: false }, gap: 4 * MIN });
    expect(await itsOwn()).toEqual(['requests']);
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
      platform: 'linkedin' as const,
      now: body.now as number,
      timeZone: TZ,
      hours: world.hours as never,
      choices: world.choices as never,
      noting: world.noting,
      day: ((world.kept?.days as Record<string, never> | undefined) ?? {}).linkedin ?? null,
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
 * plans for itself comes to the same as itself whatever it was sent, which would compare nothing. The helpful post
 * is only ever a go's first move, looked for once; what's sent after it, with none written yet, is the go's last.
 */
const didAsSent = (): boolean =>
  world.sent.length > 0 &&
  world.sent.every((move, n) => {
    switch (move.do) {
      case 'post':
        return (
          n === 0 &&
          world.did.filter((name) => name === 'post').length === 1 &&
          // Up, or it couldn't go, the go ended there; with none written yet it asked once more.
          world.sent.length === (stateNow().helpfulUp || stateNow().stopped ? 1 : 2)
        );
      case 'wait':
        return move.why !== 'screen';
      case 'daily':
        return (LINKEDIN_DAILY as readonly string[]).includes(move.job as string);
      case 'before':
        return LIST_MARKS_ON.linkedin.includes(markOf(move.step as never));
      // Its list came with the move, and the piece of work was on it: the runner never asked for the list itself.
      case 'work':
        return !world.posted.some((p) => p.path === TODAY_LIST);
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
  world.answers = { [TODAY_LIST]: () => list };
  if (decided) asHandsFreeOS(list);
  const began = Date.now();
  await linkedInTick();
  const now = stateNow();
  const wake = alarms.get(LINKEDIN_ALARM);
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
    /** Today's helpful post: up (or it couldn't go), and whether it was looked for this go, to look again later. */
    helpfulUp: now.helpfulUp ?? false,
    helpfulLooked: (now.helpfulAt ?? 0) >= began + HELPFUL_AGAIN_MS,
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

  const allRead = () => Object.fromEntries(LINKEDIN_DAILY.map((job) => [job, `Read ${job}.`]));
  const notToday = () => ({
    start: 9,
    end: 17,
    days: [(new Date().getDay() + 3) % 7],
    everyDay: false,
  });
  const reply = { ...member('Lee Ortiz', 'lee-ortiz'), kind: 'reply', threadKey: 't-9' };
  const postsOnItsOwn = () => void (world.choices = { ...world.choices, posting: 'own' });
  const startedByHand = () => ({
    working: true,
    workingName: null,
    days: { linkedin: { date: today(), state: 'started', why: null } },
  });

  /** Each: the day so far, today's list, what else is so, and how often a go as HandsFreeOS decides asks (once). */
  const scenes: Record<
    string,
    {
      readonly state?: () => Partial<State>;
      readonly list?: () => TodayList;
      readonly world?: () => void;
      readonly asks?: number;
    }
  > = {
    'a once-a-day read is next': {},
    'the next once-a-day read, with some done': {
      state: () => ({ daily: { requests: 'Read.', tidy: 'Read.', occasions: 'Read.' } }),
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
    'their connections saved, their invitations not yet': {
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
    'the old invitations to withdraw not worked out yet': {
      list: () => listOf([DANA]),
      world: () => void (world.hfos['hfos-lists'] = () => ({ ...savedLists(), tidyAt: null })),
    },
    'the first check of their connections not done yet': {
      world: () => void (world.hfos['hfos-lists'] = () => ({ ...savedLists(), checksAt: null })),
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
        world.kept = startedByHand();
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
          days: { linkedin: { date: today(), state: 'stopped', why: null } },
        }),
      asks: 0,
    },
    // Today's helpful post, where they let it go up on its own (decision 50).
    'the helpful post goes up on its own, with the day’s reading done': {
      state: () => ({ daily: allRead() }),
      list: () => listOf([DANA]),
      world: () => {
        postsOnItsOwn();
        world.post = UP;
      },
    },
    'the helpful post couldn’t go up': {
      state: () => ({ daily: allRead() }),
      list: () => listOf([DANA]),
      world: () => {
        postsOnItsOwn();
        world.post = () => ({
          line: 'Couldn’t post on your LinkedIn feed.',
          warned: false,
          failed: true,
        });
      },
    },
    'LinkedIn warns as the helpful post goes up': {
      state: () => ({ daily: allRead() }),
      list: () => listOf([DANA]),
      world: () => {
        postsOnItsOwn();
        world.post = () => ({ line: 'LinkedIn says to slow down.', warned: true });
      },
    },
    'no helpful post written yet, and a list to work': {
      state: () => ({ daily: allRead() }),
      list: () => listOf([DANA, SAM]),
      world: postsOnItsOwn,
      asks: 2,
    },
    'no helpful post written yet, and nothing on the list': {
      state: () => ({ daily: allRead() }),
      world: postsOnItsOwn,
      asks: 2,
    },
    'the helpful post looked for a while ago, and a list to work': {
      state: () => ({ daily: allRead(), helpfulAt: Date.now() + 20 * MIN }),
      list: () => listOf([DANA]),
      world: () => {
        postsOnItsOwn();
        world.post = UP;
      },
    },
    'the helpful post due to be looked for again': {
      state: () => ({ daily: allRead(), helpfulAt: Date.now() - MIN }),
      world: () => {
        postsOnItsOwn();
        world.post = UP;
      },
    },
    'the helpful post up already today': {
      state: () => ({ daily: allRead(), helpfulUp: true, helpfulAt: Date.now() - MIN }),
      list: () => listOf([DANA]),
      world: () => {
        postsOnItsOwn();
        world.post = UP;
      },
    },
    'their posts wait for their OK': {
      state: () => ({ daily: allRead() }),
      list: () => listOf([DANA]),
      world: () => void (world.post = UP),
    },
    'posting on its own, with today’s post not asked for yet': {
      state: () => ({ daily: { requests: 'Read.', tidy: 'Read.' } }),
      world: () => {
        postsOnItsOwn();
        world.post = UP;
      },
    },
    'posting on its own, with a read put by for later today': {
      // The checks' next few wait their turn: nothing reads now, and the day's post was asked for, so it goes up.
      state: () => ({
        daily: Object.fromEntries(Object.entries(allRead()).filter(([job]) => job !== 'checks')),
        againAt: { checks: Date.now() + 40 * MIN },
      }),
      world: () => {
        postsOnItsOwn();
        world.post = UP;
      },
    },
    'posting on its own with Collect off: no read asks for the post first': {
      list: () => listOf([DANA]),
      world: () => {
        world.choices = { ...world.choices, collect: false, posting: 'own' };
        world.post = UP;
      },
    },
    'the helpful post, their day started by hand outside the hours': {
      state: () => ({ daily: allRead() }),
      world: () => {
        postsOnItsOwn();
        world.post = UP;
        world.hours = notToday();
        world.kept = startedByHand();
      },
    },
    'outside the hours, posting on its own: nothing new goes up': {
      state: () => ({ daily: allRead() }),
      world: () => {
        postsOnItsOwn();
        world.post = UP;
        world.hours = notToday();
      },
    },
  };

  for (const [name, scene] of Object.entries(scenes))
    it(`${name}`, async () => {
      scene.world?.();
      const list = scene.list?.() ?? listOf([]);
      const itself = await goFrom(scene.state?.() ?? {}, list, false);
      const sent = await goFrom(scene.state?.() ?? {}, list, true);
      // After Stop for today its own checks hold it: it never asks. With no helpful post written yet, it asks twice.
      const asked = scene.asks ?? 1;
      expect(asks()).toHaveLength(asked);
      if (asked) expect(didAsSent()).toBe(true);
      expectSame(sent, itself);
    });

  it('covers what a go can come to: each kind of read, a save put off, the list’s work, the post, and each wait', async () => {
    // What the scenes above came to, by themselves: a guard that they stay worth comparing.
    const seen = new Set<string>();
    for (const [name, scene] of Object.entries(scenes)) {
      freshWorld();
      scene.world?.();
      const came = await goFrom(scene.state?.() ?? {}, scene.list?.() ?? listOf([]), false);
      // A post looked for with none written, and what the go went on to.
      if (came.did[0] === 'post' && !came.helpfulUp && !came.stopped)
        seen.add(came.opened.length ? 'post, then work' : 'post, then wait');
      seen.add(
        came.did[0]?.replace(/:.*/, '') ??
          (came.opened.length ? 'work' : came.line === PUT_OFF ? 'put off' : `wait: ${name}`),
      );
    }
    for (const kind of [
      'requests',
      'checks',
      'before',
      'posts',
      'comment_research',
      'work',
      'post',
      'post, then work',
      'post, then wait',
    ])
      expect([...seen]).toContain(kind);
    expect([...seen].filter((kind) => kind.startsWith('wait')).length).toBeGreaterThanOrEqual(4);
  });
});

// Last in this file: a read put off stays put off for 10 minutes, whichever test comes next.
describe('a read put off till the person’s away', () => {
  beforeAll(() => void vi.spyOn(Math, 'random').mockReturnValue(0.5));
  afterAll(() => vi.restoreAllMocks());

  it('is passed over by HandsFreeOS as the runner passes it over, and holds a round of finding again', async () => {
    // Their invitations' read needs its window on screen, and they're at their computer: it's put off.
    world.away = false;
    world.screen.add('requests');
    await linkedInTick();
    expect(world.did).toEqual([]);
    expect(stateNow().daily ?? {}).not.toHaveProperty('requests');

    // The next read goes meanwhile, by itself and as HandsFreeOS decides, which is told what's passed over.
    const itself = await goFrom({}, listOf([]), false);
    const sent = await goFrom({}, listOf([]), true);
    expect(itself.did).toEqual(['tidy']);
    expectSame(sent, itself);
    expect(didAsSent()).toBe(true);
    expect(asks()[0]!.body.here).toMatchObject({ away: false, passOver: ['requests'] });

    // With the rest of the day read, it waits for them to be away: no round of finding again begins meanwhile.
    const rest = Object.fromEntries(
      LINKEDIN_DAILY.filter((job) => job !== 'requests').map((job) => [job, `Read ${job}.`]),
    );
    const short = { ...listOf([]), goal: { more: true } } as unknown as TodayList;
    const waits = await goFrom({ daily: rest, more: true }, short, false);
    const waitsSent = await goFrom({ daily: rest, more: true }, short, true);
    expect(waits.did).toEqual([]);
    expect(waits.round).toBe(0);
    expect(waits.line).toMatch(/One part waits till you’ve been away from your computer/);
    expectSame(waitsSent, waits);
    expect(world.sent.at(-1)).toMatchObject({ do: 'wait', why: 'idle' });

    // Their helpful post, asked for already, still goes up meanwhile, either way.
    world.choices = { ...world.choices, posting: 'own' };
    world.post = UP;
    const posts = await goFrom({ daily: rest }, listOf([]), false);
    const postsSent = await goFrom({ daily: rest }, listOf([]), true);
    expect(posts.did).toEqual(['post']);
    expectSame(postsSent, posts);
    expect(world.sent).toMatchObject([{ do: 'post' }]);
    world.choices = { ...world.choices, posting: 'after_ok' };

    // Once they're away it's read, either way.
    world.away = true;
    const back = await goFrom({ daily: rest }, listOf([]), false);
    const backSent = await goFrom({ daily: rest }, listOf([]), true);
    expect(back.did).toEqual(['requests']);
    expectSame(backSent, back);
    expect(world.sent.at(-1)).toMatchObject({ do: 'daily', job: 'requests' });
  });

  it('holds the helpful post while the read that asks for it is put off, and works the list meanwhile', async () => {
    world.away = false;
    world.screen.add('helpful');
    world.choices = { ...world.choices, posting: 'own' };
    world.post = UP;
    const rest = Object.fromEntries(
      LINKEDIN_DAILY.filter((job) => job !== 'helpful').map((job) => [job, `Read ${job}.`]),
    );
    begin({ daily: rest });
    await linkedInTick();
    expect(world.did).toEqual([]);
    expect(stateNow().daily ?? {}).not.toHaveProperty('helpful');

    // Today's post isn't asked for yet, so none goes up: the list is worked, by itself and as HandsFreeOS decides.
    const itself = await goFrom({ daily: rest }, listOf([DANA]), false);
    const sent = await goFrom({ daily: rest }, listOf([DANA]), true);
    expect(itself.did).toEqual([]);
    expect(itself.opened).toHaveLength(1);
    expectSame(sent, itself);
    expect(didAsSent()).toBe(true);
    expect(world.sent).toMatchObject([{ do: 'work' }]);
  });

  it('is where LinkedIn’s rules part from Instagram’s, Threads’ and X’s: only those hold a save till they’re away', () => {
    expect(RUNNERS.linkedin.savesAway).toBe(false);
    expect(RUNNERS.instagram.savesAway).toBe(true);
    expect(RUNNERS.threads.savesAway).toBe(true);
    expect(RUNNERS.x.savesAway).toBe(true);
    // And LinkedIn's, with Facebook's, puts the helpful post up on its own.
    expect(RUNNERS.linkedin.posts).toBe(true);
    expect(RUNNERS.alignable.posts).toBe(false);
  });
});
