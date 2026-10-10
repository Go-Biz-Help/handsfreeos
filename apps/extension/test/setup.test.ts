/**
 * The extension's first run (src/hfos/setup.ts): it tells HandsFreeOS it's signed in, now at a sign-in and otherwise
 * every few hours (a refusal too, and only a lost connection sooner), and opens HandsFreeOS's setup once per person and
 * business on this computer for a first-timer there, as HandsFreeOS's answer says.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sent: unknown[] = [];
const place = { userId: 'u-1', businessId: 'b-1' };
let fails: { rule: string | null; status: number | null } | null = null;
let answer: object = { firstTime: true };

vi.mock('../src/hfos/config', () => ({
  config: { webUrl: 'https://app.example.test/', apiUrl: 'https://api.example.test' },
}));
vi.mock('../src/hfos/session', () => {
  class Refused extends Error {
    constructor(readonly problem: { rule: string | null; status: number | null }) {
      super('refused');
    }
  }
  return {
    Refused,
    savingTo: async () => place,
    api: () => ({
      POST: (path: string, init: { body: unknown }) => {
        sent.push({ path, body: init.body });
        return Promise.resolve();
      },
    }),
    call: async () => {
      // An answer takes a moment, so two runs at once overlap.
      await new Promise((done) => setTimeout(done, 5));
      if (fails) throw new Refused(fails);
      return answer;
    },
  };
});

const { firstRun, reportSignedIn, REPORT_EVERY_MS, setupUrl, shouldOpenSetup, stamped } =
  await import('../src/hfos/setup');
const ANSWERED = 'hfos.setupReported';

let stored: Record<string, unknown> = {};
const opened: unknown[] = [];

beforeEach(() => {
  stored = {};
  sent.length = 0;
  opened.length = 0;
  fails = null;
  answer = { firstTime: true };
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: stored[key] }),
        set: async (values: Record<string, unknown>) => {
          stored = { ...stored, ...values };
        },
      },
    },
    tabs: {
      create: async (tab: unknown) => {
        opened.push(tab);
        return tab;
      },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

const never = { saved: false, changedBy: null };
const theirOwn = { saved: true, changedBy: null };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const found = (f: object) => f as any;

describe('the setup’s address and when to open it', () => {
  it('opens HandsFreeOS’s setup, saying it came from the extension', () => {
    expect(setupUrl('https://app.example.test/', 'b-1')).toBe(
      'https://app.example.test/app/w/b-1/a/outreach/setup?from=extension',
    );
  });

  it('opens it only for a first-timer, as HandsFreeOS answers, once per person and business', () => {
    const web = 'https://app.example.test';
    const first = { firstTime: true };
    const notFirst = { firstTime: false };
    const byOwner = { saved: true, changedBy: 'Morgan Owner' };
    expect(shouldOpenSetup(first, never, {}, 'u-1:b-1', web)).toBe(true);
    // Saved their own once, then an owner changed them: HandsFreeOS says they aren't a first-timer.
    expect(shouldOpenSetup(notFirst, byOwner, {}, 'u-1:b-1', web)).toBe(false);
    expect(shouldOpenSetup(notFirst, never, {}, 'u-1:b-1', web)).toBe(false);
    // No answer: the settings it follows say.
    expect(shouldOpenSetup(null, never, {}, 'u-1:b-1', web)).toBe(true);
    expect(shouldOpenSetup(null, theirOwn, {}, 'u-1:b-1', web)).toBe(false);
    expect(shouldOpenSetup(null, byOwner, {}, 'u-1:b-1', web)).toBe(true);
    expect(shouldOpenSetup(first, never, { 'u-1:b-1': 1 }, 'u-1:b-1', web)).toBe(false);
    expect(shouldOpenSetup(first, never, { 'u-1:b-1': 1 }, 'u-1:b-2', web)).toBe(true);
    expect(shouldOpenSetup(first, never, {}, 'u-1:b-1', '')).toBe(false);
  });

  it('keeps the newest 20', () => {
    const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, i]));
    const kept = stamped(many, 'new', 100);
    expect(Object.keys(kept)).toHaveLength(20);
    expect(kept.new).toBe(100);
    expect(kept.k0).toBeUndefined();
  });
});

describe('the first run', () => {
  it('tells HandsFreeOS it signed in first, then opens the setup once', async () => {
    await firstRun(found(never), true);
    expect(sent).toEqual([
      {
        path: '/v1/commands/outreach.setup.save',
        body: { workspaceId: 'b-1', extension: true },
      },
    ]);
    expect(opened).toEqual([
      { url: 'https://app.example.test/app/w/b-1/a/outreach/setup?from=extension', active: true },
    ]);
    await firstRun(found(never), true);
    expect(sent).toHaveLength(2);
    expect(opened).toHaveLength(1);
  });

  it('opens nothing for someone HandsFreeOS says isn’t a first-timer', async () => {
    answer = { firstTime: false };
    // An owner saved their settings last, after they saved their own: still not a first-timer.
    await firstRun(found({ saved: true, changedBy: 'Morgan Owner' }), true);
    expect(sent).toHaveLength(1);
    expect(opened).toHaveLength(0);
  });

  it('opens one tab for two sign-ins at once', async () => {
    await Promise.all([firstRun(found(never), true), firstRun(found(never), true)]);
    expect(sent).toHaveLength(2);
    expect(opened).toHaveLength(1);
  });

  it('opens the setup even when the report is refused, but not when the add-on is off', async () => {
    fails = { rule: 'not_found', status: 404 };
    await firstRun(found(never), true);
    expect(opened).toHaveLength(1);
    stored = {};
    fails = { rule: 'addon_inactive', status: 403 };
    await firstRun(found(never), true);
    expect(opened).toHaveLength(1);
  });

  it('waits the few hours after a refusal, and tries again soon only after a lost connection', async () => {
    fails = { rule: null, status: 500 };
    await firstRun(null, false);
    await firstRun(null, false);
    expect(sent).toHaveLength(1);
    expect(stored[ANSWERED]).toBeDefined();
    stored = {};
    sent.length = 0;
    fails = { rule: null, status: null };
    await firstRun(null, false);
    await firstRun(null, false);
    expect(sent).toHaveLength(2);
    expect(stored[ANSWERED]).toBeUndefined();
  });

  it('on a wake with a sign-in already there, reports once in a while and opens nothing', async () => {
    await firstRun(null, false);
    await firstRun(null, false);
    expect(sent).toHaveLength(1);
    expect(opened).toHaveLength(0);
    // A few hours on, it says so again.
    await reportSignedIn(place, false, Date.now() + REPORT_EVERY_MS + 1);
    expect(sent).toHaveLength(2);
  });
});
