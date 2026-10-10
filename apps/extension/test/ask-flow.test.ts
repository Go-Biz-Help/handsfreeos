/**
 * Doing what the person asked from HandsFreeOS, from taking it to its end (src/asks/run.ts, docs/outreach.md decision
 * 43), with the extension's storage, HandsFreeOS and the job stood in for: one that goes to the end is done; one that
 * throws, or can't do what it was asked, is failed with its words; Stop on the web, Stop for today pressed in the panel,
 * a Facebook warning kept while it goes (from any tab) or seen on another computer each end it at its next page, with
 * how far it got; and one left under way when the extension starts again is ended as lost.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ASK_LOST_LINE,
  askSignInLine,
  askWarnedLine,
  type AskTaken,
} from '@hfos/core/addons/outreach/asks';
import type { LiveDay } from '@hfos/core/addons/outreach/live';
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
let ending: (job: Job) => Promise<JobEnd> = async (j) => ({
  line: j.stopped() ? 'Stopped. 2 chats sent for the AI to read.' : 'Read 3 chats.',
  warned: false,
});
vi.mock('../src/jobs/chats', () => ({
  chatMemory: {},
  readChats: async (j: Job) => {
    job = j;
    await new Promise<void>((done) => (letGo = done));
    return ending(j);
  },
}));

const { runAsks, recoverAsk, endOf, signInChanged } = await import('../src/asks/run');
const { beat, LIVE_KEY, pressDay } = await import('../src/hfos/live');
const { ASK_ENDS_KEY, ASK_KEY, sendWaitingEnds } = await import('../src/hfos/asks');
const { WARNED_KEY } = await import('../src/hfos/warned');

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
