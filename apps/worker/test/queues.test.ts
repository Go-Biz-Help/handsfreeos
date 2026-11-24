import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runQueues, SAFETY_MS, type QueueName, type QueuesWaiting } from '../src/queues';

/**
 * The one look a second that paces the outbox, the webhooks and the jobs (src/queues.ts). Each loop made its own
 * claim once a second and found nothing nearly every time; now a loop claims when the look found something for
 * it, when it is woken, or every half minute as a safety net.
 */

const POLL = 1_000;
const BATCH = 20;
const NOTHING: QueuesWaiting = { outbox: false, webhook: false, jobs: false };

function start(claims: Partial<Record<QueueName, () => number>> = {}) {
  let running = true;
  let found: QueuesWaiting = NOTHING;
  const passes: Record<QueueName, number> = { outbox: 0, webhook: 0, jobs: 0 };
  let looks = 0;
  const pass = (queue: QueueName) => async () => {
    passes[queue] += 1;
    return { claimed: claims[queue]?.() ?? 0 };
  };
  const queues = runQueues(
    { outbox: pass('outbox'), webhook: pass('webhook'), jobs: pass('jobs') },
    async () => {
      looks += 1;
      // What one look found is claimed by the pass it wakes, so the next look finds nothing.
      const now = found;
      found = NOTHING;
      return now;
    },
    { pollMs: POLL, batchSize: BATCH, running: () => running, log: { info() {}, error() {} } },
  );
  return {
    queues,
    passes,
    looks: () => looks,
    find: (waiting: Partial<QueuesWaiting>) => {
      found = { ...NOTHING, ...waiting };
    },
    stop: async () => {
      running = false;
      for (const loop of queues.loops) loop.wake();
      await Promise.all(queues.loops.map((loop) => loop.done));
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the worker’s queues', () => {
  it('look once a second, and claim only every half minute while nothing is waiting', async () => {
    const t = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.passes).toEqual({ outbox: 1, webhook: 1, jobs: 1 });
    expect(t.looks()).toBe(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(t.looks()).toBe(601);
    const each = 1 + (10 * 60_000) / SAFETY_MS;
    expect(t.passes).toEqual({ outbox: each, webhook: each, jobs: each });
    await t.stop();
  });

  it('claim from a queue within the second its work is found, and from that queue only', async () => {
    const t = start();
    await vi.advanceTimersByTimeAsync(5_500);
    const before = { ...t.passes };
    t.find({ jobs: true });
    await vi.advanceTimersByTimeAsync(POLL);
    expect(t.passes).toEqual({ ...before, jobs: before.jobs + 1 });
    await t.stop();
  });

  it('claim at once when another part of the worker wakes the queue', async () => {
    const t = start();
    await vi.advanceTimersByTimeAsync(5_500);
    const before = { ...t.passes };
    const looks = t.looks();
    t.queues.wake('webhook');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.passes).toEqual({ ...before, webhook: before.webhook + 1 });
    expect(t.looks()).toBe(looks);
    await t.stop();
  });

  it('go again at once after a full batch, without waiting for the next look', async () => {
    const batches = [0, BATCH, BATCH, 3];
    const t = start({ outbox: () => batches.shift() ?? 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.passes.outbox).toBe(1);
    t.queues.wake('outbox');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.passes.outbox).toBe(4);
    await t.stop();
  });

  it('keep looking after a look that fails', async () => {
    let running = true;
    let looks = 0;
    let jobs = 0;
    const queues = runQueues(
      {
        outbox: async () => ({ claimed: 0 }),
        webhook: async () => ({ claimed: 0 }),
        jobs: async () => {
          jobs += 1;
          return { claimed: 0 };
        },
      },
      async () => {
        looks += 1;
        if (looks === 2) throw new Error('the database went away');
        return { ...NOTHING, jobs: looks === 3 };
      },
      { pollMs: POLL, batchSize: BATCH, running: () => running, log: { info() {}, error() {} } },
    );
    await vi.advanceTimersByTimeAsync(2 * POLL);
    expect(looks).toBe(3);
    expect(jobs).toBe(2);
    running = false;
    for (const loop of queues.loops) loop.wake();
    await Promise.all(queues.loops.map((loop) => loop.done));
  });

  it('end at once when the worker stops', async () => {
    const t = start();
    await vi.advanceTimersByTimeAsync(3_300);
    const before = { ...t.passes };
    await t.stop();
    expect(t.passes).toEqual(before);
  });
});
