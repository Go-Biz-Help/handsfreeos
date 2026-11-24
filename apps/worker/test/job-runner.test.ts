import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createJobRunner, RENEW_MS, SLOW_MS, type JobRunner } from '../src/job-runner';
import type { JobHandler } from '../src/jobs';
import { queuesWaiting } from '../src/queues';
import { testServices, type TestServices } from './helpers';

/**
 * The worker's jobs, several at once (job-runner.ts; the counting alone is in job-lanes.test.ts).
 *
 * The database is shared with the other suites, so every test here has job kinds of its own and its runner claims
 * only those (`onlyKinds`). A job's handler waits at a gate the test opens, so a test decides what is running.
 */

const ME = `vitest-runner-${process.pid}`;
const OTHER = `vitest-runner-other-${process.pid}`;
const admin = () => testDbs().admin.db;

let s: TestServices;
const jobIds: string[] = [];
let testNo = 0;
/** This test's own kinds. */
let kinds: Record<'quick' | 'slow' | 'heavy', string>;
/** Job id → what lets its handler end. */
const gates = new Map<string, () => void>();
/** The jobs whose handlers have begun, in the order they did. */
let begun: string[] = [];
let runner: JobRunner | null = null;
/** The runner's clock, moved by hand: how long a job "ran" is up to the test. */
let clock = 0;

const hold: JobHandler = (ctx) =>
  new Promise<void>((resolve) => {
    begun.push(ctx.job.id);
    gates.set(ctx.job.id, resolve);
  });

async function until(what: string, ok: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await ok())) {
    if (Date.now() > deadline) throw new Error(`still waiting after 10 s: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A job of this test's own, due `ago` seconds ago: the larger, the older. */
async function job(
  kind: string,
  ago: number,
  held?: { by: string; minutesAgo: number },
): Promise<string> {
  const [row] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.scheduled_jobs (kind, run_at, payload, locked_at, locked_by)
        values (${kind}, now() - make_interval(secs => ${ago}), '{}',
          ${held ? sql`now() - make_interval(mins => ${held.minutesAgo})` : sql`null`},
          ${held ? held.by : null})
        returning id`,
  );
  jobIds.push(row!.id);
  return row!.id;
}

const rowOf = async (id: string) =>
  (
    await rows<{ status: string; locked_by: string | null; fresh: boolean | null }>(
      admin(),
      sql`select status, locked_by, locked_at > now() - interval '1 minute' as fresh
          from app.scheduled_jobs where id = ${id}`,
    )
  )[0]!;

interface Told {
  ran: number;
  free: number;
}

function start(opts: { slots: number; slowSlots: number }): Told {
  const told: Told = { ran: 0, free: 0 };
  runner = createJobRunner({
    ...s,
    workerId: ME,
    jobs: { [kinds.quick]: hold, [kinds.slow]: hold, [kinds.heavy]: hold },
    heavyKinds: [kinds.heavy],
    onlyKinds: Object.values(kinds),
    time: () => clock,
    onRan: () => told.ran++,
    onFree: () => told.free++,
    ...opts,
  });
  return told;
}

/** Fills the free places, and waits for the handlers of what was claimed to begin. */
async function pass(): Promise<number> {
  const before = begun.length;
  const { claimed } = await runner!.pass();
  await until('the claimed jobs begin', () => begun.length === before + claimed);
  return claimed;
}

/** Lets a running job end, and waits until its place is free. */
async function end(id: string): Promise<void> {
  gates.get(id)!();
  gates.delete(id);
  await until('the job ends', () => !runner!.runningIds().includes(id));
}

/** Runs one job of `kind` to its end, taking `ms` by the runner's clock. */
async function runFor(kind: string, ms: number): Promise<void> {
  const id = await job(kind, 1);
  expect(await pass()).toBe(1);
  clock += ms;
  await end(id);
}

beforeAll(() => {
  s = testServices();
});
afterEach(async () => {
  for (const open of gates.values()) open();
  gates.clear();
  await runner?.settle(5_000);
  runner = null;
});
afterAll(async () => {
  for (const id of jobIds)
    await rows(admin(), sql`delete from app.scheduled_jobs where id = ${id}`);
  await closeTestDbs();
});

function fresh() {
  testNo++;
  const base = `test.runner.${process.pid}.${testNo}`;
  kinds = { quick: `${base}.quick`, slow: `${base}.slow`, heavy: `${base}.heavy` };
  begun = [];
  clock = Date.now();
}

describe('the worker’s jobs, several at once', () => {
  it('starts as many as there are places and answers at once; the next starts when a place is free', async () => {
    fresh();
    const told = start({ slots: 2, slowSlots: 1 });
    const first = await job(kinds.quick, 30);
    const second = await job(kinds.quick, 20);
    const third = await job(kinds.quick, 10);

    expect(await pass()).toBe(2);
    expect([...begun].sort()).toEqual([first, second].sort());
    expect([...runner!.runningIds()].sort()).toEqual([first, second].sort());
    expect(await rowOf(first)).toMatchObject({ status: 'pending', locked_by: ME, fresh: true });
    // The one that waits is not held: another machine could take it.
    expect(await rowOf(third)).toMatchObject({ status: 'pending', locked_by: null });
    // Every place taken: nothing is claimed.
    expect(await pass()).toBe(0);
    expect(told).toEqual({ ran: 0, free: 0 });

    await end(first);
    expect(told).toEqual({ ran: 1, free: 1 });
    expect(await rowOf(first)).toMatchObject({ status: 'done', locked_by: null });
    expect(await pass()).toBe(1);
    expect(begun).toContain(third);

    // The look that paces the loops asks with the running jobs left out, in one statement.
    const waiting = await queuesWaiting(s.db, ME, runner!.runningIds());
    expect(typeof waiting.jobs).toBe('boolean');
  });

  it('does not take a job it is running a second time, even with its lease gone stale', async () => {
    fresh();
    start({ slots: 2, slowSlots: 1 });
    const id = await job(kinds.quick, 10);
    expect(await pass()).toBe(1);
    await rows(
      admin(),
      sql`update app.scheduled_jobs set locked_at = now() - interval '10 minutes' where id = ${id}`,
    );
    expect(await pass()).toBe(0);
    expect(begun).toEqual([id]);
  });

  it('keeps places for quick jobs: a quick one gets through while older slow ones wait their turn', async () => {
    fresh();
    start({ slots: 3, slowSlots: 1 });
    // Two slow runs teach the worker that this kind is slow.
    await runFor(kinds.slow, SLOW_MS + 1_000);
    await runFor(kinds.slow, SLOW_MS + 1_000);

    const slowOlder = await job(kinds.slow, 60);
    const slowNewer = await job(kinds.slow, 50);
    const quick = await job(kinds.quick, 5);
    begun = [];
    expect(await pass()).toBe(2);
    expect([...begun].sort()).toEqual([slowOlder, quick].sort());
    // A place is free, and the second slow job still waits: slow jobs have one place here.
    expect(await pass()).toBe(0);
    expect(await rowOf(slowNewer)).toMatchObject({ status: 'pending', locked_by: null });

    await end(slowOlder);
    expect(await pass()).toBe(1);
    expect(begun).toContain(slowNewer);
  });

  it('runs one heavy job at a time', async () => {
    fresh();
    start({ slots: 3, slowSlots: 2 });
    const first = await job(kinds.heavy, 20);
    const second = await job(kinds.heavy, 10);
    expect(await pass()).toBe(1);
    expect(begun).toEqual([first]);
    expect(await pass()).toBe(0);
    await end(first);
    expect(await pass()).toBe(1);
    expect(begun).toEqual([first, second]);
  });

  it('takes a row held under its own name that it is not running, and leaves another worker’s', async () => {
    fresh();
    start({ slots: 4, slowSlots: 2 });
    // Left by a pass that broke off, or by this worker before a restart.
    const mine = await job(kinds.quick, 40, { by: ME, minutesAgo: 0 });
    const theirs = await job(kinds.quick, 30, { by: OTHER, minutesAgo: 1 });
    const theirsStale = await job(kinds.quick, 20, { by: OTHER, minutesAgo: 6 });
    expect(await pass()).toBe(2);
    expect([...begun].sort()).toEqual([mine, theirsStale].sort());
    expect(await rowOf(theirs)).toMatchObject({ status: 'pending', locked_by: OTHER });
    expect(await rowOf(theirsStale)).toMatchObject({ locked_by: ME, fresh: true });
  });

  it('renews the lease of a job that runs for minutes', async () => {
    fresh();
    start({ slots: 2, slowSlots: 1 });
    const id = await job(kinds.quick, 10);
    expect(await pass()).toBe(1);
    await rows(
      admin(),
      sql`update app.scheduled_jobs set locked_at = now() - interval '4 minutes' where id = ${id}`,
    );
    expect(await rowOf(id)).toMatchObject({ locked_by: ME, fresh: false });
    // Not yet: the last renewal is less than a minute old by the runner's clock.
    await runner!.pass();
    expect(await rowOf(id)).toMatchObject({ fresh: false });
    clock += RENEW_MS;
    await runner!.pass();
    expect(await rowOf(id)).toMatchObject({ status: 'pending', locked_by: ME, fresh: true });
  });

  it('on stopping, waits for the running jobs, and lets go of one that is still running', async () => {
    fresh();
    start({ slots: 2, slowSlots: 1 });
    expect(await runner!.settle(50)).toBe(0);

    const quick = await job(kinds.quick, 20);
    const stuck = await job(kinds.quick, 10);
    expect(await pass()).toBe(2);
    setTimeout(() => gates.get(quick)?.(), 30);
    expect(await runner!.settle(1_500)).toBe(1);
    expect(await rowOf(quick)).toMatchObject({ status: 'done' });
    // Free for another worker now, not in five minutes.
    expect(await rowOf(stuck)).toMatchObject({ status: 'pending', locked_by: null });
  });
});
