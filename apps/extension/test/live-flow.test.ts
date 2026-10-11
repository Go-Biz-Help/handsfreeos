/**
 * What the extension tells HandsFreeOS, as it goes (src/hfos/live.ts), with the extension's storage and HandsFreeOS
 * stood in for: a press in the panel updates the answer kept, so an older answer never undoes it; a long line is cut
 * short rather than refused; a press made with no connection goes with a later beat; and a beat's answer that stops
 * the day or moves the work to another computer has the runner end what it's doing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveDay } from '@hfos/core/addons/outreach/live';
import { AUTO_STATE_KEY, freshState, type AutoState } from '../src/auto/plan';
import {
  beat,
  dayChange,
  LIVE_KEY,
  LIVE_PRESS_KEY,
  liveNow,
  onWake,
  pressDay,
  wakeFor,
  type Kept,
} from '../src/hfos/live';

const ME = { userId: 'u-dana', businessId: 'b-one' };
const DAY = '2026-10-27';

interface Posted {
  readonly path: string;
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string>;
}
const posted: Posted[] = [];
let answers: Record<string, { readonly status: number; readonly data?: unknown }> = {};

vi.mock('../src/hfos/session', () => {
  class Refused extends Error {
    constructor(readonly problem: { readonly message: string }) {
      super(problem.message);
    }
  }
  return {
    Refused,
    savingTo: async () => ({ userId: 'u-dana', businessId: 'b-one' }),
    api: () => ({
      POST: async (
        path: string,
        options: { body: Record<string, unknown>; headers?: Record<string, string> },
      ) => {
        posted.push({ path, body: options.body, headers: options.headers ?? {} });
        const answer = answers[path] ?? { status: 503 };
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

const store = new Map<string, unknown>();
const copy = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
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
        },
        remove: async (keys: string | string[]) => {
          for (const k of [keys].flat()) store.delete(k);
        },
      },
    },
    runtime: {
      getPlatformInfo: async () => ({ os: 'win' }),
      getManifest: () => ({ version: '0.17.0' }),
    },
    alarms: { get: async () => undefined, create: async () => undefined, clear: async () => true },
  });
});
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const day = (state: LiveDay['state'], why: LiveDay['why'] = null): LiveDay => ({
  date: DAY,
  state,
  why,
  via: state === 'none' ? null : 'web',
  at: state === 'none' ? null : '2026-10-27T15:00:00.000Z',
});
const kept = (more: Partial<Kept> = {}): Kept => ({
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
const beatAnswer = (more: Partial<Kept> = {}) => {
  const { userId: _u, businessId: _b, at: _a, ...answer } = kept(more);
  return answer;
};
const runner = (more: Partial<AutoState> = {}): AutoState => ({ ...freshState(DAY), ...more });

/** Listeners each test adds, taken away after it. */
const listening: (() => void)[] = [];
const listen = (fn: (halt: boolean) => void) => listening.push(onWake(fn));

beforeEach(() => {
  store.clear();
  posted.length = 0;
  answers = {};
  for (const stop of listening.splice(0)) stop();
});

describe('a press in the panel', () => {
  it('updates the answer kept, so a fresh older answer never undoes Stop for today', async () => {
    // The answer kept a moment ago still says the day is started.
    store.set(LIVE_KEY, kept({ day: day('started') }));
    answers['/v1/commands/outreach.day.stop'] = { status: 200, data: day('stopped', 'person') };
    expect(await pressDay('stop')).toEqual({ kind: 'done', day: day('stopped', 'person') });
    // What the runner then does (run.ts): stopped here, and goes by the answer kept.
    const local = runner({ started: false, stopped: 'person' });
    const live = await liveNow(ME);
    expect(live?.day.state).toBe('stopped');
    expect(dayChange(local, live!.day, false)).toBeNull();
  });

  it('makes this computer the one that works in the answer kept', async () => {
    store.set(LIVE_KEY, kept({ working: false, workingName: 'Chrome on Mac', day: day('none') }));
    answers['/v1/commands/outreach.day.start'] = { status: 200, data: day('started') };
    await pressDay('start');
    expect((await liveNow(ME))?.working).toBe(true);
    expect(dayChange(runner({ started: true }), (await liveNow(ME))!.day, false)).toBeNull();
  });

  it('waits with no connection, keeping its id and moment, and goes with the next beat', async () => {
    const pressed = await pressDay('stop');
    expect(pressed).toEqual({ kind: 'waiting' });
    const waiting = store.get(LIVE_PRESS_KEY) as { commandId: string; occurredAt: string };
    expect(waiting.commandId).toBeTruthy();
    answers['/v1/commands/outreach.day.stop'] = { status: 200, data: day('stopped', 'person') };
    answers['/v1/commands/outreach.live.beat'] = {
      status: 200,
      data: beatAnswer({ day: day('stopped', 'person') }),
    };
    await beat(true);
    const sent = posted.filter((p) => p.path === '/v1/commands/outreach.day.stop');
    expect(sent).toHaveLength(2);
    expect(Object.values(sent[1]!.headers)).toEqual(
      expect.arrayContaining([waiting.commandId, waiting.occurredAt]),
    );
    expect(store.has(LIVE_PRESS_KEY)).toBe(false);
  });
});

describe('the beat', () => {
  it('cuts a 400-character line short rather than be refused for it', async () => {
    store.set(
      AUTO_STATE_KEY,
      runner({ line: `Dana Reyes: ${'x'.repeat(400)}`, lineAt: Date.now() }),
    );
    answers['/v1/commands/outreach.live.beat'] = { status: 200, data: beatAnswer() };
    await beat(true);
    const sent = posted.find((p) => p.path === '/v1/commands/outreach.live.beat');
    const line = (sent!.body.status as { line: string }).line;
    expect(line).toHaveLength(300);
    expect(line.endsWith('…')).toBe(true);
  });

  it('has the runner end what it’s doing when the day was stopped in the app', async () => {
    const woke: boolean[] = [];
    listen((halt) => woke.push(halt));
    store.set(LIVE_KEY, kept({ day: day('started') }));
    store.set(AUTO_STATE_KEY, runner({ started: true, working: true }));
    answers['/v1/commands/outreach.live.beat'] = {
      status: 200,
      data: beatAnswer({ day: day('stopped', 'person') }),
    };
    await beat(true);
    expect(woke).toEqual([true]);
  });

  it('has the runner stand by when another computer works now', async () => {
    const woke: boolean[] = [];
    listen((halt) => woke.push(halt));
    store.set(LIVE_KEY, kept());
    store.set(AUTO_STATE_KEY, runner({ started: true, working: true }));
    answers['/v1/commands/outreach.live.beat'] = {
      status: 200,
      data: beatAnswer({ working: false, workingName: 'Chrome on Mac' }),
    };
    await beat(true);
    expect(woke).toEqual([true]);
  });

  it('tells the runner and the ask under way alike: one never takes the other’s place', async () => {
    const runnerHeard: boolean[] = [];
    const askHeard: boolean[] = [];
    listen((halt) => runnerHeard.push(halt));
    listen((halt) => askHeard.push(halt));
    store.set(LIVE_KEY, kept({ day: day('started') }));
    store.set(AUTO_STATE_KEY, runner({ started: true, working: true }));
    answers['/v1/commands/outreach.live.beat'] = {
      status: 200,
      data: beatAnswer({ day: day('stopped', 'person') }),
    };
    await beat(true);
    expect(runnerHeard).toEqual([true]);
    expect(askHeard).toEqual([true]);
  });

  it('wakes a computer chosen to work again without stopping it', async () => {
    const woke: boolean[] = [];
    listen((halt) => woke.push(halt));
    store.set(LIVE_KEY, kept({ working: false, workingName: 'Chrome on Mac' }));
    store.set(AUTO_STATE_KEY, runner({ started: true }));
    answers['/v1/commands/outreach.live.beat'] = { status: 200, data: beatAnswer() };
    await beat(true);
    expect(woke).toEqual([false]);
  });
});

describe('what a beat’s answer means for the runner', () => {
  const local = runner({ started: true });
  it('halts on a stop or another computer working, and wakes on a start', () => {
    expect(
      wakeFor({ working: true }, { working: true, day: day('started') }, local, false),
    ).toEqual({ wake: false, halt: false });
    expect(
      wakeFor({ working: true }, { working: true, day: day('stopped', 'person') }, local, false),
    ).toEqual({ wake: true, halt: true });
    expect(
      wakeFor({ working: true }, { working: false, day: day('started') }, local, false),
    ).toEqual({ wake: true, halt: true });
    expect(
      wakeFor({ working: true }, { working: true, day: day('started') }, runner(), false),
    ).toEqual({ wake: true, halt: false });
    // A press of its own waiting: the day isn't followed yet.
    expect(
      wakeFor({ working: true }, { working: true, day: day('stopped', 'person') }, local, true),
    ).toEqual({ wake: false, halt: false });
  });
});
