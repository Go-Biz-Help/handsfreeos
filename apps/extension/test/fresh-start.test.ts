/**
 * Starting Social Outreach fresh (docs/outreach.md, "Starting fresh"): when the business's `startedAt` moves, the
 * extension forgets what it kept on the computer from before, so nothing from before is sent again. The first load,
 * and the same one again, forget nothing.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AUTO_STATE_KEY } from '../src/auto/plan';
import { ASK_ENDS_KEY, ASK_KEY } from '../src/hfos/asks';
import { forgetOnFreshStart, KEPT_FOR_BUSINESS, STARTED_KEY } from '../src/hfos/follow';
import { WAITING_FOR_KEY } from '../src/hfos/messages';
import { SETUP_OPENED_KEY, SETUP_REPORTED_KEY } from '../src/hfos/setup';
import { WAITING_TOLD_KEY } from '../src/hfos/waiting';
import { FILE_KEY } from '../src/jobs/file';
import { FOLLOW_BACKS_KEY } from '../src/jobs/instagram/follow-backs';

const BUSINESS = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const store = new Map<string, unknown>();

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
          for (const [k, v] of Object.entries(values)) store.set(k, v);
        },
        remove: async (keys: string | string[]) => {
          for (const k of [keys].flat()) store.delete(k);
        },
      },
    },
  });
});
afterAll(() => vi.unstubAllGlobals());

const keepAll = () => {
  for (const key of KEPT_FOR_BUSINESS) store.set(key, { kept: true });
  store.set('hfos.session', { signedIn: true });
};

describe('starting fresh', () => {
  it('names every key kept about a business’s outreach', () => {
    for (const key of [
      AUTO_STATE_KEY,
      ASK_KEY,
      ASK_ENDS_KEY,
      WAITING_FOR_KEY,
      WAITING_TOLD_KEY,
      SETUP_OPENED_KEY,
      SETUP_REPORTED_KEY,
      FILE_KEY,
      // The Instagram followers newest at the last save, kept by 0.85.0 to 0.87.0.
      'hfos.followersRead',
      FOLLOW_BACKS_KEY,
    ])
      expect(KEPT_FOR_BUSINESS).toContain(key);
  });

  it('forgets nothing the first time, or when it’s the same start', async () => {
    keepAll();
    await forgetOnFreshStart(BUSINESS, '2026-10-01T00:00:00.000Z');
    await forgetOnFreshStart(BUSINESS, '2026-10-01T00:00:00.000Z');
    for (const key of KEPT_FOR_BUSINESS) expect(store.has(key)).toBe(true);
    expect(store.get(STARTED_KEY)).toEqual({ [BUSINESS]: '2026-10-01T00:00:00.000Z' });
  });

  it('forgets what was kept from before once the business started fresh, and stays signed in', async () => {
    keepAll();
    await forgetOnFreshStart(BUSINESS, '2026-10-11T00:00:00.000Z');
    for (const key of KEPT_FOR_BUSINESS) expect(store.has(key)).toBe(false);
    expect(store.has('hfos.session')).toBe(true);
    expect(store.get(STARTED_KEY)).toEqual({ [BUSINESS]: '2026-10-11T00:00:00.000Z' });
  });
});
