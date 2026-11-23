import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLoop, type LoopOptions } from '../src/loop';

/**
 * The worker's queue loops (src/loop.ts). The migration queue is empty nearly always, and asking it once a second
 * was a tenth of everything the database did: it now slows to one look every 30 seconds after a quiet minute, and
 * comes straight back when it is woken.
 */

const POLL = 1_000;
const BATCH = 20;
const IDLE = { afterMs: 60_000, everyMs: 30_000 };

function start(opts: LoopOptions, claim: () => number = () => 0) {
  let running = true;
  let passes = 0;
  const loop = runLoop(
    'test',
    async () => {
      passes += 1;
      return { claimed: claim() };
    },
    opts,
    { pollMs: POLL, batchSize: BATCH, running: () => running, log: { info() {}, error() {} } },
  );
  return {
    loop,
    passes: () => passes,
    /** Passes made while `ms` go by. */
    during: async (ms: number) => {
      const before = passes;
      await vi.advanceTimersByTimeAsync(ms);
      return passes - before;
    },
    stop: async () => {
      running = false;
      loop.wake();
      await loop.done;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a queue loop', () => {
  it('looks once a poll, for as long as it runs, when it has no idle wait', async () => {
    const t = start({ drain: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.passes()).toBe(1);
    expect(await t.during(10 * 60_000)).toBe(600);
    await t.stop();
  });

  it('goes again at once after a full batch, and waits after a short one', async () => {
    const batches = [BATCH, BATCH, 3];
    const t = start({ drain: true }, () => batches.shift() ?? 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.passes()).toBe(3);
    expect(await t.during(POLL)).toBe(1);
    await t.stop();
  });

  it('slows to its idle wait after a quiet minute', async () => {
    const t = start({ drain: false, idle: IDLE });
    await vi.advanceTimersByTimeAsync(0);
    // The first minute is the usual pace: the worker has just started and a move may be under way.
    expect(await t.during(60_000)).toBe(60);
    expect(await t.during(10 * 60_000)).toBe(20);
    await t.stop();
  });

  it('is woken at once from an idle wait, and keeps the usual pace for the next minute', async () => {
    const t = start({ drain: false, idle: IDLE });
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 10_000);
    const before = t.passes();
    t.loop.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.passes()).toBe(before + 1);
    expect(await t.during(59_000)).toBe(59);
    // Nothing came of it: quiet again.
    expect(await t.during(5 * 60_000)).toBeLessThanOrEqual(11);
    await t.stop();
  });

  it('stays at the usual pace while there is work', async () => {
    let work = true;
    const t = start({ drain: false, idle: IDLE }, () => (work ? 1 : 0));
    await vi.advanceTimersByTimeAsync(0);
    expect(await t.during(5 * 60_000)).toBe(300);
    work = false;
    expect(await t.during(60_000)).toBe(60);
    expect(await t.during(60_000)).toBe(2);
    await t.stop();
  });

  it('skips the wait when it was woken during a pass', async () => {
    let release: (() => void) | null = null;
    let running = true;
    let passes = 0;
    const loop = runLoop(
      'test',
      async () => {
        passes += 1;
        if (passes === 1) await new Promise<void>((r) => (release = r));
        return { claimed: 0 };
      },
      { drain: false, idle: IDLE },
      { pollMs: POLL, batchSize: BATCH, running: () => running, log: { info() {}, error() {} } },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(passes).toBe(1);
    loop.wake();
    release!();
    await vi.advanceTimersByTimeAsync(0);
    expect(passes).toBe(2);
    running = false;
    loop.wake();
    await loop.done;
  });

  it('ends at once when the worker stops, however long its wait', async () => {
    const t = start({ drain: false, idle: IDLE });
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000);
    const before = t.passes();
    await t.stop();
    expect(t.passes()).toBe(before);
  });

  it('carries on after a pass that throws', async () => {
    let first = true;
    const t = start({ drain: true }, () => {
      if (first) {
        first = false;
        throw new Error('the database went away');
      }
      return 0;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(await t.during(3 * POLL)).toBe(3);
    await t.stop();
  });
});
