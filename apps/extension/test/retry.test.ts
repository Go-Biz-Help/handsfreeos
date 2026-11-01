/**
 * Steps tried again (docs/outreach.md, decision 143): which hand back to the person, which clear as done already, and
 * Retry all on its own once after each update, but messages that didn't go.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const world = vi.hoisted(() => ({
  posted: [] as { path: string; body: Record<string, unknown> }[],
  down: false,
}));
vi.mock('../src/hfos/session', () => ({
  api: () => ({
    POST: async (path: string, options: { body: Record<string, unknown> }) => {
      world.posted.push({ path, body: options.body });
      return world.down
        ? { error: {}, response: { ok: false, status: 503 } }
        : { data: { retried: [], passed: 0 }, response: { ok: true, status: 200 } };
    },
  }),
  call: async (request: Promise<{ data?: unknown; response: { ok: boolean } }>) => {
    const result = await request;
    if (result.response.ok) return result.data;
    throw new Error('Couldn’t reach HandsFreeOS.');
  },
}));

const { clearRetried, handsOver, RETRIED_FOR_KEY, retryAfterUpdate } =
  await import('../src/auto/retry');

const store = new Map<string, unknown>();
let version = '0.123.0';
beforeAll(() => {
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}),
        set: async (values: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(values)) store.set(k, v);
        },
      },
    },
    runtime: { getManifest: () => ({ version }) },
  });
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  world.posted.length = 0;
  world.down = false;
});

const BUSINESS = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const retry = { needId: '1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9', at: '2026-11-01T22:00:00.000Z' };

describe('a step tried again', () => {
  it('hands back one that didn’t go, but not one found done already', () => {
    const failed = { done: false, line: 'Dana Reyes: the page went somewhere else' };
    const already = { done: false, line: 'Dana Reyes: connected already', skip: true as const };
    expect(handsOver({ retry }, failed)).toBe(true);
    expect(handsOver({ retry }, already)).toBe(false);
    expect(handsOver({ retry }, { done: true, line: 'Sent Dana Reyes a request' })).toBe(false);
    expect(handsOver({ retry }, { stop: 'LinkedIn warned you' })).toBe(false);
    // A step not tried again hands over only what it says the person can do.
    expect(handsOver({}, failed)).toBe(false);
    expect(handsOver({}, { ...failed, need: true as const })).toBe(true);
  });

  it('clears one found done already, and nothing else', async () => {
    await clearRetried({ retry }, { done: false, line: 'x', skip: true }, BUSINESS);
    await clearRetried({ retry }, { done: false, line: 'x' }, BUSINESS);
    await clearRetried({}, { done: false, line: 'x', skip: true }, BUSINESS);
    expect(world.posted).toEqual([
      {
        path: '/v1/commands/outreach.need.clear',
        body: { workspaceId: BUSINESS, needId: retry.needId, how: 'done' },
      },
    ]);
  });
});

describe('after an update', () => {
  it('tries again once for each version, but messages, and again next time when it couldn’t reach HandsFreeOS', async () => {
    world.down = true;
    await retryAfterUpdate(BUSINESS);
    expect(store.get(RETRIED_FOR_KEY)).toBeUndefined();
    world.down = false;
    await retryAfterUpdate(BUSINESS);
    await retryAfterUpdate(BUSINESS);
    expect(world.posted).toEqual([
      ...Array(2).fill({
        path: '/v1/commands/outreach.need.retry',
        body: { workspaceId: BUSINESS, needIds: null, sends: false },
      }),
    ]);
    expect(store.get(RETRIED_FOR_KEY)).toEqual({ [BUSINESS]: '0.123.0' });
    version = '0.124.0';
    await retryAfterUpdate(BUSINESS);
    expect(world.posted).toHaveLength(3);
    expect(store.get(RETRIED_FOR_KEY)).toEqual({ [BUSINESS]: '0.124.0' });
  });
});
