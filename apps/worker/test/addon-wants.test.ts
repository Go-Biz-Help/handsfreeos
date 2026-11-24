import { describe, expect, it, vi } from 'vitest';
import { FIXTURE_CATALOG, fxrent } from '../../../packages/core/test/addons/fixtures';
import { addonWorker, addonWorkerModuleIssues, type AddonWorkerModule } from '../src/addons/index';
import { handlersFor, type HandlerContext } from '../src/handlers/types';
import { liveChangedWanted } from '../src/addons/outreach/live';
import { postCheckedWanted } from '../src/addons/outreach/posts';

/**
 * An add-on's `wants` (src/addons/types.ts; the speed audit, Nov 2026): whether it has anything to do for an event,
 * asked before a delivery is queued. Most of what Social Outreach's computers say all day had the worker queue a
 * job, claim it, read the event again and do nothing: six in ten of every add-on delivery there was.
 *
 * No database here: an event nobody wants must not reach one. test/addons.test.ts has the same end to end.
 */

const rent = (wants: AddonWorkerModule['wants']): AddonWorkerModule => ({
  manifest: fxrent,
  subscribers: { 'fxprop.lease.signed': async () => {}, 'invoice.paid': async () => {} },
  wants,
  releaseResource: async () => {},
});

/** An `invoice.paid` handed to the add-ons' own handler: what was asked of the database, and what was logged. */
async function paid(module: AddonWorkerModule, payload: unknown) {
  const execute = vi.fn(async () => []);
  const error = vi.fn();
  const [fanOut] = handlersFor(
    addonWorker(FIXTURE_CATALOG, [module]).withAddons({}),
    'invoice.paid',
  );
  await fanOut!({
    tx: { execute },
    log: { error },
    scope: { workspaceId: 'w', organizationId: 'o' },
    event: { id: 'e', payload },
  } as unknown as HandlerContext);
  return { asked: execute.mock.calls.length, logged: error.mock.calls.length };
}

describe('an event an add-on has nothing to do for', () => {
  const quiet = rent({ 'invoice.paid': (p) => p['quiet'] !== true });

  it('asks the database nothing and queues nothing', async () => {
    expect(await paid(quiet, { quiet: true })).toEqual({ asked: 0, logged: 0 });
  });

  it('is still looked up when it is wanted, has no payload, or the add-on says nothing', async () => {
    expect(await paid(quiet, { quiet: false })).toEqual({ asked: 1, logged: 0 });
    expect(await paid(quiet, null)).toEqual({ asked: 1, logged: 0 });
    expect(await paid(rent(undefined), { quiet: true })).toEqual({ asked: 1, logged: 0 });
  });

  it('is delivered when the add-on’s check breaks, so its trouble stays in its own job', async () => {
    const broken = rent({
      'invoice.paid': () => {
        throw new Error('broke');
      },
    });
    expect(await paid(broken, {})).toEqual({ asked: 1, logged: 1 });
  });

  it('can only be said of an event the add-on subscribes to', () => {
    expect(
      addonWorkerModuleIssues(FIXTURE_CATALOG, [rent({ 'person.updated': () => false })]),
    ).toEqual(['fxrent says which person.updated it wants but has no subscriber for it']);
  });
});

describe('what Social Outreach wants', () => {
  it('a computer new to HandsFreeOS, of everything its computers say', () => {
    expect(liveChangedWanted({ userId: 'u', state: 'working', working: true, made: true })).toBe(
      true,
    );
    expect(liveChangedWanted({ userId: 'u', state: 'working', working: true, made: false })).toBe(
      false,
    );
    expect(liveChangedWanted({ userId: 'u', state: 'idle' })).toBe(false);
    expect(liveChangedWanted({})).toBe(false);
  });

  it('a checked post that asks for a recommendation or is a strong one', () => {
    const post = { postId: 'p', userId: 'u' };
    expect(postCheckedWanted({ ...post, check: 'good', strong: true, asks: false })).toBe(true);
    expect(postCheckedWanted({ ...post, check: 'not', strong: false, asks: true })).toBe(true);
    expect(postCheckedWanted({ ...post, check: 'good', strong: false, asks: false })).toBe(false);
    expect(postCheckedWanted({ ...post, check: 'not', strong: true, asks: false })).toBe(false);
    expect(postCheckedWanted({ check: 'good', strong: true, asks: true })).toBe(false);
    expect(postCheckedWanted({})).toBe(false);
  });
});
