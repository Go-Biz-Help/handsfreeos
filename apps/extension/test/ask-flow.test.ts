/**
 * Doing what the person asked from HandsFreeOS, from taking it to its end (src/asks/run.ts, docs/outreach.md decision
 * 43), with the extension's storage, HandsFreeOS and the job stood in for: one that goes to the end is done; one that
 * throws, or can't do what it was asked, is failed with its words; Stop on the web, Stop for today pressed in the panel,
 * a Facebook warning kept while it goes (from any tab) or seen on another computer each end it at its next page, with
 * how far it got; and one left under way when the extension starts again is ended as lost. Each network has its own
 * line: LinkedIn's takes its own asks beside Facebook's, only while LinkedIn is on and allowed, and a warning or Stop
 * for today on one network ends only that network's.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ASK_LOST_LINE,
  askSignInLine,
  askWarnedLine,
  type AskTaken,
} from '@hfos/core/addons/outreach/asks';
import type { LiveDay } from '@hfos/core/addons/outreach/live';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import type { Job, JobEnd } from '../src/jobs/job';

const ME = { userId: 'u-dana', businessId: 'b-one' };
const DAY = '2026-10-27';
const ASK_ID = '4c3b2a1d-0e9f-4a8b-8c7d-6e5f4a3b2c1d';

interface Posted {
  readonly path: string;
  readonly body: Record<string, unknown>;
}
const posted: Posted[] = [];
type Answer = { readonly status: number; readonly data?: unknown };
let answers: Record<string, Answer | ((body: Record<string, unknown>) => Answer)> = {};

/** Who's signed in here, and to which business: null when nobody is. */
const signed = vi.hoisted(() => ({
  place: { userId: 'u-dana', businessId: 'b-one' } as { userId: string; businessId: string } | null,
}));

vi.mock('../src/hfos/session', () => {
  class Refused extends Error {
    constructor(readonly problem: { readonly message: string }) {
      super(problem.message);
    }
  }
  return {
    Refused,
    savingTo: async () => signed.place,
    answer: async () => ({ ok: true, value: null }),
    answerWith: async (_type: string, fn: () => Promise<unknown>) => {
      try {
        return { ok: true, value: await fn() };
      } catch (error) {
        return { ok: false, problem: { message: (error as Error).message } };
      }
    },
    api: () => ({
      POST: async (path: string, options: { body: Record<string, unknown> }) => {
        posted.push({ path, body: options.body });
        const found = answers[path];
        const answer = (typeof found === 'function' ? found(options.body) : found) ?? {
          status: 503,
        };
        return {
          data: answer.status < 400 ? answer.data : undefined,
          error: answer.status < 400 ? undefined : { error: { message: 'Try again in a minute.' } },
          response: { ok: answer.status < 400, status: answer.status },
        };
      },
    }),
    call: async (request: Promise<{ data?: unknown; response: { ok: boolean } }>) => {
      const result = await request;
      if (result.data !== undefined && result.response.ok) return result.data;
      throw new Refused({ message: 'Couldn’t reach HandsFreeOS.' });
    },
  };
});
vi.mock('../src/hfos/follow', () => ({ SETTINGS_KEY: 'hfos.settings' }));
// The runner and its daily jobs aren't what's tested here.
vi.mock('../src/auto/run', () => ({ tick: async () => undefined }));
vi.mock('../src/auto/daily', () => ({ postSender: () => async () => 0 }));
vi.mock('../src/hfos/waiting', () => ({
  POPUP_ID: 'hfos-waiting',
  popUp: async () => undefined,
  waitingSoon: () => undefined,
}));
vi.mock('../src/hfos/looked', () => ({ noteWarnings: async () => undefined }));
vi.mock('../src/tab', () => ({
  WorkTab: class {
    readonly tabId = 7;
    async focus() {}
    async close() {}
  },
}));

/** The job an ask of Read my chats does: it waits to be let go, then says how far it got. */
let job: Job | null = null;
let letGo: (() => void) | null = null;
/** Each one going, by its network: two go side by side, a line each. */
const going = new Map<Platform, { readonly job: Job; readonly letGo: () => void }>();
let ending: (job: Job) => Promise<JobEnd> = async (j) => ({
  line: j.stopped() ? 'Stopped. 2 chats sent for the AI to read.' : 'Read 3 chats.',
  warned: false,
});
vi.mock('../src/jobs/chats', () => ({
  chatMemory: {},
  LINKEDIN_MESSAGING: { platform: 'linkedin' },
  readChats: async (j: Job, options: { readonly home?: { readonly platform: Platform } }) => {
    job = j;
    await new Promise<void>((done) => {
      letGo = done;
      going.set(options.home?.platform ?? 'facebook', { job: j, letGo: done });
    });
    return ending(j);
  },
}));

const { runAsks, recoverAsk, endOf, signInChanged } = await import('../src/asks/run');
const { beat, LIVE_KEY, pressDay } = await import('../src/hfos/live');
const { ASK_ENDS_KEY, ASK_KEY, askKeyOf, sendWaitingEnds } = await import('../src/hfos/asks');
const { WARNED_KEY } = await import('../src/hfos/warned');
const { NETWORKS_KEY } = await import('../src/networks/on');

const store = new Map<string, unknown>();
const changed = new Set<(changes: Record<string, unknown>, area: string) => void>();
const copy = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

beforeAll(() => {
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (keys: string | string[]) =>
          Object.fromEntries(
            [keys]
              .flat()
              .filter((k) => store.has(k))
              .map((k) => [k, copy(store.get(k))]),
          ),
        set: async (values: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(values)) store.set(k, copy(v));
          const changes = Object.fromEntries(
            Object.entries(values).map(([k, v]) => [k, { newValue: v }]),
          );
          for (const fn of changed) fn(changes, 'local');
        },
        remove: async (keys: string | string[]) => {
          for (const k of [keys].flat()) store.delete(k);
        },
      },
      onChanged: { addListener: (fn: never) => changed.add(fn) },
    },
    runtime: {
      getPlatformInfo: async () => ({ os: 'win' }),
      getManifest: () => ({ version: '0.19.0' }),
    },
    notifications: { clear: async () => true },
    alarms: { get: async () => undefined, create: async () => undefined, clear: async () => true },
  });
});
afterAll(() => vi.unstubAllGlobals());

const day = (state: LiveDay['state'], why: LiveDay['why'] = null): LiveDay => ({
  date: DAY,
  state,
  why,
  via: state === 'none' ? null : 'web',
  at: state === 'none' ? null : '2026-10-27T15:00:00.000Z',
});
const kept = (more: Record<string, unknown> = {}) => ({
  computerId: '00000000-0000-4000-8000-000000000001',
  name: 'Chrome on Windows',
  working: true,
  workingName: null,
  day: day('started'),
  stepsKept: [],
  asks: 0,
  ...ME,
  at: Date.now(),
  ...more,
});
const taken: AskTaken = {
  askId: ASK_ID,
  kind: 'chats',
  task: { kind: 'chats' },
  about: null,
  platform: 'facebook',
  askedAt: '2026-10-27T15:00:00.000Z',
};

const ends = () =>
  posted
    .filter((p) => p.path === '/v1/commands/outreach.ask.end')
    .map((p) => ({ state: p.body.state, line: p.body.line }));
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((done) => setTimeout(done, 1));
  expect(ok()).toBe(true);
};

/** Takes the ask and starts its job; once the job is under way, the run to wait for. */
async function start(): Promise<{ readonly running: Promise<void> }> {
  let given = false;
  answers['/v1/commands/outreach.ask.take'] = () => {
    const ask = given ? null : taken;
    given = true;
    return { status: 200, data: { ask, waiting: 0 } };
  };
  const running = runAsks();
  await until(() => job !== null);
  return { running };
}

beforeEach(() => {
  signed.place = { ...ME };
  store.clear();
  store.set(LIVE_KEY, kept());
  posted.length = 0;
  job = null;
  letGo = null;
  going.clear();
  ending = async (j) => ({
    line: j.stopped() ? 'Stopped. 2 chats sent for the AI to read.' : 'Read 3 chats.',
    warned: false,
  });
  answers = {
    '/v1/commands/outreach.ask.progress': { status: 200, data: { cancelled: false, reply: null } },
    '/v1/commands/outreach.ask.end': { status: 200, data: { ok: true } },
  };
});

describe('an ask from taking it to its end', () => {
  it('is done when the job goes to the end, and nothing is kept under way after', async () => {
    const { running } = await start();
    letGo!();
    await running;
    expect(ends()).toEqual([{ state: 'done', line: 'Read 3 chats.' }]);
    expect(store.get(ASK_KEY) ?? null).toBeNull();
  });

  it('is failed, with the job’s words, when the job throws or can’t do what was asked', async () => {
    ending = async () => {
      throw new Error('HandsFreeOS couldn’t keep those chats. Try again in a minute.');
    };
    let { running } = await start();
    letGo!();
    await running;
    ending = async () => ({ line: 'Nothing to save.', warned: false, failed: true });
    job = null;
    ({ running } = await start());
    letGo!();
    await running;
    expect(ends()).toEqual([
      { state: 'failed', line: 'HandsFreeOS couldn’t keep those chats. Try again in a minute.' },
      { state: 'failed', line: 'Nothing to save.' },
    ]);
  });

  it('ends at its next page when Stop for today is pressed in the panel, saying how far it got', async () => {
    const { running } = await start();
    answers['/v1/commands/outreach.day.stop'] = { status: 200, data: day('stopped', 'person') };
    await pressDay('stop');
    await until(() => job!.stopped());
    letGo!();
    await running;
    expect(ends()).toEqual([
      {
        state: 'failed',
        line: 'Stopped: you pressed Stop for today. 2 chats sent for the AI to read.',
      },
    ]);
  });

  it('ends when Stop is pressed on the web, the next time it says how it’s going', async () => {
    const { running } = await start();
    answers['/v1/commands/outreach.ask.progress'] = {
      status: 200,
      data: { cancelled: true, reply: null },
    };
    // A line alone goes at most every 20 seconds: this one, half a minute on.
    const now = Date.now();
    const later = vi.spyOn(Date, 'now').mockReturnValue(now + 30_000);
    job!.progress('Reading your chats… 2 so far.');
    await until(() => job!.stopped());
    later.mockRestore();
    letGo!();
    await running;
    expect(ends()).toEqual([
      { state: 'failed', line: 'Stopped. 2 chats sent for the AI to read.' },
    ]);
  });

  it.each(['carry_on', 'skip'] as const)(
    'takes %s for a step it handed over, pressed in HandsFreeOS’s Needs you, never the panel',
    async (pressed) => {
      // The step waits on a look every 20 seconds; that timer ends with the test.
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        let got: unknown = null;
        ending = async (j) => {
          got = await j.handOver!('Couldn’t find that step on the page. Then press Carry on.');
          return { line: 'Read 3 chats.', warned: false };
        };
        // Pressed on the web or the phone: the look's answer has it (outreach.ask.reply keeps it there).
        answers['/v1/commands/outreach.ask.progress'] = (body) => ({
          status: 200,
          data: { cancelled: false, reply: body.state === 'stuck' ? pressed : null },
        });
        const { running } = await start();
        letGo!();
        await running;
        expect(got).toBe(pressed);
        const states = posted
          .filter((p) => p.path === '/v1/commands/outreach.ask.progress')
          .map((p) => p.body.state);
        // Taken, handed over, then on again once the answer came.
        expect(states).toEqual(['working', 'stuck', 'working']);
        // The extension says nothing of its own about the answer: HandsFreeOS has it already.
        expect(posted.some((p) => p.path === '/v1/commands/outreach.ask.reply')).toBe(false);
        expect(ends()).toEqual([{ state: 'done', line: 'Read 3 chats.' }]);
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it('ends on a Facebook warning kept while it goes, from any tab', async () => {
    const { running } = await start();
    expect(job!.stopped()).toBe(false);
    await chrome.storage.local.set({
      [WARNED_KEY]: {
        day: new Date().toLocaleDateString('en-CA'),
        words: ['You’re temporarily blocked'],
      },
    });
    await until(() => job!.stopped());
    letGo!();
    await running;
    expect(ends()).toEqual([
      {
        state: 'failed',
        line: `${askWarnedLine('You’re temporarily blocked')} 2 chats sent for the AI to read.`,
      },
    ]);
  });

  it('keeps going on a LinkedIn warning: a warning on one network never stops another', async () => {
    const { running } = await start();
    await chrome.storage.local.set({
      [WARNED_KEY]: {
        linkedin: {
          day: new Date().toLocaleDateString('en-CA'),
          words: ['You’ve reached the weekly invitation limit'],
        },
      },
    });
    // Heard and looked at: Facebook's day is as it was.
    await new Promise((done) => setTimeout(done, 20));
    expect(job!.stopped()).toBe(false);
    letGo!();
    await running;
    expect(ends()).toEqual([{ state: 'done', line: 'Read 3 chats.' }]);
  });

  it('ends on a warning seen on another of the person’s computers, as the beat says', async () => {
    const { running } = await start();
    const {
      userId: _u,
      businessId: _b,
      at: _a,
      ...answer
    } = kept({
      day: day('stopped', 'warning'),
    });
    answers['/v1/commands/outreach.live.beat'] = { status: 200, data: answer };
    await beat(true);
    await until(() => job!.stopped());
    letGo!();
    await running;
    expect(ends()).toEqual([
      { state: 'failed', line: `${askWarnedLine(null)} 2 chats sent for the AI to read.` },
    ]);
  });

  it('stops when someone else signs in here, and its end waits for its own person', async () => {
    const { running } = await start();
    signed.place = { userId: 'u-riley', businessId: 'b-one' };
    await signInChanged();
    expect(job!.stopped()).toBe(true);
    letGo!();
    await running;
    // Nothing of Dana's goes to HandsFreeOS while Riley is signed in here.
    expect(ends()).toEqual([]);
    const line = `${askSignInLine(signed.place, ME)} 2 chats sent for the AI to read.`;
    expect(store.get(ASK_ENDS_KEY)).toMatchObject([{ ...ME, state: 'failed', line }]);
    expect(line).toContain('Stopped: you signed in as someone else here.');
    signed.place = { ...ME };
    await sendWaitingEnds(ME);
    expect(ends()).toEqual([{ state: 'failed', line }]);
  });

  it('stops before its next call to HandsFreeOS once signed out, or another business is picked', async () => {
    for (const now of [null, { userId: 'u-dana', businessId: 'b-two' }]) {
      job = null;
      posted.length = 0;
      store.delete(ASK_ENDS_KEY);
      signed.place = { ...ME };
      const { running } = await start();
      signed.place = now;
      const said = await job!.hfos({ type: 'hfos-auto' } as never);
      expect(said).toMatchObject({ ok: false, problem: { message: askSignInLine(now, ME) } });
      expect(job!.stopped()).toBe(true);
      letGo!();
      await running;
      expect(ends()).toEqual([]);
    }
    expect(askSignInLine(null, ME)).toContain('signed out');
    expect(askSignInLine({ userId: 'u-dana', businessId: 'b-two' }, ME)).toContain(
      'another business',
    );
  });

  it('is ended as lost when the extension starts again with one left under way', async () => {
    store.set(ASK_KEY, {
      ...ME,
      askId: ASK_ID,
      kind: 'chats',
      about: null,
      state: 'working',
      line: 'Reading your chats…',
      at: Date.now(),
    });
    await recoverAsk();
    expect(ends()).toEqual([{ state: 'failed', line: ASK_LOST_LINE }]);
    expect(store.has(ASK_KEY)).toBe(false);
  });
});

describe('how an ask ended', () => {
  it('keeps the job’s own warning words, and the halt’s words alone when the job said nothing more', () => {
    expect(
      endOf(
        { halted: askWarnedLine(null), warned: true },
        { line: 'Stopped: Facebook says “Slow down”.', warned: true },
      ),
    ).toEqual({ state: 'failed', line: 'Stopped: Facebook says “Slow down”.' });
    expect(
      endOf(
        { halted: 'Stopped: you pressed Stop for today.', warned: false },
        { line: 'Stopped.', warned: false },
      ),
    ).toEqual({ state: 'failed', line: 'Stopped: you pressed Stop for today.' });
    expect(
      endOf({ halted: null, warned: false }, { line: 'Saved 3 groups.', warned: false }),
    ).toEqual({ state: 'done', line: 'Saved 3 groups.' });
  });
});

describe('a line of asks per network', () => {
  const LINKEDIN_ASK = '7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a';
  const both = {
    facebook: { on: true, allowed: true },
    linkedin: { on: true, allowed: true },
  };
  const onLinkedIn: AskTaken = { ...taken, askId: LINKEDIN_ASK, platform: 'linkedin' };
  const takes = () =>
    posted.filter((p) => p.path === '/v1/commands/outreach.ask.take').map((p) => p.body.platform);
  const endOf_ = (askId: string) =>
    posted
      .filter((p) => p.path === '/v1/commands/outreach.ask.end' && p.body.askId === askId)
      .map((p) => ({ state: p.body.state, line: p.body.line }));

  /** Each network's line is handed its own ask once; both go side by side. */
  async function startBoth(): Promise<{ readonly running: Promise<void> }> {
    store.set(NETWORKS_KEY, both);
    const given = new Set<unknown>();
    answers['/v1/commands/outreach.ask.take'] = (body) => {
      const ask = given.has(body.platform)
        ? null
        : body.platform === 'linkedin'
          ? onLinkedIn
          : taken;
      given.add(body.platform);
      return { status: 200, data: { ask, waiting: 0 } };
    };
    const running = runAsks();
    await until(() => going.size === 2);
    return { running };
  }

  it('takes LinkedIn’s asks on a line of its own, beside Facebook’s, each kept apart for the panel', async () => {
    const { running } = await startBoth();
    // Each line asks for its own network's.
    expect(takes()).toEqual(expect.arrayContaining(['facebook', 'linkedin']));
    expect(going.get('linkedin')!.job.stopped()).toBe(false);
    expect(store.get(askKeyOf('linkedin'))).toMatchObject({
      askId: LINKEDIN_ASK,
      platform: 'linkedin',
    });
    expect(store.get(ASK_KEY)).toMatchObject({ askId: ASK_ID, platform: 'facebook' });
    // LinkedIn's ends first: Facebook's goes on.
    going.get('linkedin')!.letGo();
    await until(() => endOf_(LINKEDIN_ASK).length === 1);
    expect(going.get('facebook')!.job.stopped()).toBe(false);
    expect(store.has(askKeyOf('linkedin'))).toBe(false);
    going.get('facebook')!.letGo();
    await running;
    expect(endOf_(LINKEDIN_ASK)).toEqual([{ state: 'done', line: 'Read 3 chats.' }]);
    expect(endOf_(ASK_ID)).toEqual([{ state: 'done', line: 'Read 3 chats.' }]);
  });

  it('takes nothing on LinkedIn while it’s off, or Chrome hasn’t allowed it', async () => {
    for (const linkedin of [
      { on: false, allowed: true },
      { on: true, allowed: false },
    ]) {
      posted.length = 0;
      store.set(NETWORKS_KEY, { ...both, linkedin });
      answers['/v1/commands/outreach.ask.take'] = () => ({
        status: 200,
        data: { ask: null, waiting: 0 },
      });
      await runAsks();
      expect(takes()).toEqual(['facebook']);
    }
  });

  it('ends a LinkedIn ask at once when LinkedIn was turned off since it was taken, saying how to turn it on', async () => {
    store.set(NETWORKS_KEY, both);
    let given = false;
    answers['/v1/commands/outreach.ask.take'] = (body) => {
      if (body.platform !== 'linkedin' || given)
        return { status: 200, data: { ask: null, waiting: 0 } };
      given = true;
      // Turned off in Chrome just now.
      store.set(NETWORKS_KEY, { ...both, linkedin: { on: true, allowed: false } });
      return { status: 200, data: { ask: onLinkedIn, waiting: 0 } };
    };
    await runAsks();
    expect(going.size).toBe(0);
    expect(endOf_(LINKEDIN_ASK)).toEqual([
      {
        state: 'failed',
        line: 'Chrome hasn’t let the extension on LinkedIn yet. Press Allow on LinkedIn in the extension’s panel, then ask again.',
      },
    ]);
  });

  it('ends only LinkedIn’s on a LinkedIn warning, in LinkedIn’s words', async () => {
    const { running } = await startBoth();
    await chrome.storage.local.set({
      [WARNED_KEY]: {
        linkedin: {
          day: new Date().toLocaleDateString('en-CA'),
          words: ['You’ve reached the weekly invitation limit'],
        },
      },
    });
    await until(() => going.get('linkedin')!.job.stopped());
    expect(going.get('facebook')!.job.stopped()).toBe(false);
    for (const one of going.values()) one.letGo();
    await running;
    expect(endOf_(LINKEDIN_ASK)).toEqual([
      {
        state: 'failed',
        line: `${askWarnedLine('You’ve reached the weekly invitation limit', 'linkedin')} 2 chats sent for the AI to read.`,
      },
    ]);
    expect(askWarnedLine(null, 'linkedin')).toBe(
      'LinkedIn warned you today, so the extension does nothing more on LinkedIn until tomorrow.',
    );
    expect(endOf_(ASK_ID)).toEqual([{ state: 'done', line: 'Read 3 chats.' }]);
  });

  it('ends only Facebook’s when Stop for today is pressed: the day the beat carries is Facebook’s', async () => {
    const { running } = await startBoth();
    answers['/v1/commands/outreach.day.stop'] = { status: 200, data: day('stopped', 'person') };
    await pressDay('stop');
    await until(() => going.get('facebook')!.job.stopped());
    await new Promise((done) => setTimeout(done, 20));
    expect(going.get('linkedin')!.job.stopped()).toBe(false);
    for (const one of going.values()) one.letGo();
    await running;
    expect(endOf_(LINKEDIN_ASK)).toEqual([{ state: 'done', line: 'Read 3 chats.' }]);
  });

  it('ends a LinkedIn ask left under way when the extension starts again, beside Facebook’s', async () => {
    const left = (askId: string, platform: Platform) => ({
      ...ME,
      askId,
      platform,
      kind: 'chats',
      about: null,
      state: 'working',
      line: 'Reading your chats…',
      at: Date.now(),
    });
    store.set(ASK_KEY, left(ASK_ID, 'facebook'));
    store.set(askKeyOf('linkedin'), left(LINKEDIN_ASK, 'linkedin'));
    await recoverAsk();
    expect(endOf_(ASK_ID)).toEqual([{ state: 'failed', line: ASK_LOST_LINE }]);
    expect(endOf_(LINKEDIN_ASK)).toEqual([{ state: 'failed', line: ASK_LOST_LINE }]);
    expect(store.has(askKeyOf('linkedin'))).toBe(false);
  });
});
