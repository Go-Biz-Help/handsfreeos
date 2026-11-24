import { asWorker, rows, sql } from '@hfos/db/client';
import { claimableJobs, runClaimed, type JobDeps } from './jobs';

/**
 * The worker's jobs, several at once (the owner's pick from the speed audit, Nov 2026).
 *
 * The jobs loop claimed twenty rows and ran them one after another. A push, an appointment reminder or the AI
 * teammate's reply waited behind whatever was in front of it: a picture being made (most of a minute), a PDF being
 * read, a few hundred Social Outreach checks at five seconds each. And the nineteen rows a pass had claimed but not
 * reached were locked, so the second machine sat idle beside them.
 *
 * Here a pass claims only as many jobs as there are free places (`slots`), starts each on its own and answers at
 * once. When a job ends its place is free, and main.ts wakes the loop to fill it (`onFree`).
 *
 * Slow jobs can't take every place. A kind is slow when most of its last runs took `SLOW_MS` or longer; this is
 * learned as the worker runs and forgotten when it restarts. Slow jobs share `slowSlots` of the places, so the rest
 * are always there for quick ones. A job that has itself run that long counts as slow from then on, whatever its
 * kind. A few kinds read a big file or make pictures inside this process, which has one shared CPU and 512 MB
 * (`heavyKinds`): one of those runs at a time, in a slow place. And a kind somebody is waiting on, though it takes
 * seconds (the AI teammate's reply to a customer, `promptKinds`), is never taken as slow: it starts whenever any
 * place is free.
 *
 * Each lane takes its oldest jobs first, as the one lane did. Between lanes there is no order, as there never was
 * between two machines.
 */

/** A job that has run this long is a slow one. */
export const SLOW_MS = 2_000;
/** How many of a kind's last runs are remembered: it is slow when more than half of them were. */
const REMEMBERED_RUNS = 3;
/** A running job's lease is renewed this often. It lasts five minutes (`claimableJobs`). */
export const RENEW_MS = 60_000;
/** A job that ran this long is written to the log, with its kind. */
const LONG_MS = 10_000;

export interface LaneOptions {
  /** How many jobs run at once. */
  readonly slots: number;
  /** How many of them may be slow ones. */
  readonly slowSlots: number;
  /** Kinds that run one at a time, in a slow place. */
  readonly heavyKinds: readonly string[];
  /** Kinds somebody is waiting on: never taken as slow, however long they run. */
  readonly promptKinds?: readonly string[];
}

/** What a pass may start now. */
export interface LaneRoom {
  /** Free places in all. */
  readonly free: number;
  /** How many of them slow jobs may take, the heavy one among them. */
  readonly slow: number;
  /** Whether a heavy job may start. */
  readonly heavy: boolean;
}

export interface Lanes {
  started(id: string, kind: string, now: number): void;
  ended(id: string, now: number): void;
  room(now: number): LaneRoom;
  /** The jobs running now. */
  ids(): string[];
  /** The kinds that count as slow now, the heavy ones left out. */
  slowKinds(): string[];
}

/** Who is running and what may start: the counting, with no database in it. */
export function createLanes(opts: LaneOptions): Lanes {
  const running = new Map<string, { kind: string; since: number }>();
  /** Kind → whether each of its last runs was slow, newest last. */
  const runs = new Map<string, boolean[]>();
  const heavy = new Set(opts.heavyKinds);
  const prompt = new Set(opts.promptKinds ?? []);
  const slowKind = (kind: string) => {
    const last = runs.get(kind);
    return (
      !prompt.has(kind) &&
      !!last &&
      last.length > 1 &&
      last.filter(Boolean).length * 2 > last.length
    );
  };
  return {
    started(id, kind, now) {
      running.set(id, { kind, since: now });
    },
    ended(id, now) {
      const job = running.get(id);
      if (!job) return;
      running.delete(id);
      const last = [...(runs.get(job.kind) ?? []), now - job.since >= SLOW_MS];
      runs.set(job.kind, last.slice(-REMEMBERED_RUNS));
    },
    room(now) {
      let slow = 0;
      let heavies = 0;
      for (const job of running.values()) {
        if (heavy.has(job.kind)) heavies++;
        if (heavy.has(job.kind)) slow++;
        else if (!prompt.has(job.kind) && (slowKind(job.kind) || now - job.since >= SLOW_MS))
          slow++;
      }
      const free = Math.max(0, opts.slots - running.size);
      const slowFree = Math.min(free, Math.max(0, opts.slowSlots - slow));
      return { free, slow: slowFree, heavy: heavies === 0 && slowFree > 0 };
    },
    ids: () => [...running.keys()],
    slowKinds: () => [...runs.keys()].filter((kind) => !heavy.has(kind) && slowKind(kind)),
  };
}

export interface JobRunnerDeps extends Omit<JobDeps, 'batchSize' | 'reservedOnly'>, LaneOptions {
  /** Told when a job has ended and its place is free: main.ts wakes the jobs loop to fill it. */
  readonly onFree?: () => void;
  /** Only jobs of these kinds (tests, which share a database with other pollers). */
  readonly onlyKinds?: readonly string[];
  /** The time now (tests; default: the clock). */
  readonly time?: () => number;
}

export interface JobRunner {
  /** Fills the free places and answers at once: the jobs it started run on their own. */
  pass(): Promise<{ claimed: number; running: number }>;
  /** The jobs running now. The look that paces the loops leaves them out (queues.ts). */
  runningIds(): readonly string[];
  /**
   * For stopping: settles when no job is running, or after `ms`. A job still running then is let go of, so another
   * worker, or this one once it is back, takes it at once and not when its lease runs out. Answers how many.
   */
  settle(ms: number): Promise<number>;
}

const texts = (values: readonly string[]) =>
  values.length === 0
    ? sql`'{}'::text[]`
    : sql`array[${sql.join(
        values.map((v) => sql`${v}`),
        sql`, `,
      )}]::text[]`;
const uuids = (values: readonly string[]) =>
  values.length === 0
    ? sql`'{}'::uuid[]`
    : sql`array[${sql.join(
        values.map((v) => sql`${v}`),
        sql`, `,
      )}]::uuid[]`;

export function createJobRunner(deps: JobRunnerDeps): JobRunner {
  const time = deps.time ?? Date.now;
  const lanes = createLanes(deps);
  const going = new Map<string, Promise<void>>();
  let renewedAt = time();

  /** One statement: each lane's oldest jobs, as many as it has room for, and of those the oldest that fit. */
  const claim = (room: LaneRoom) => {
    const slow = lanes.slowKinds();
    const mine = sql`${claimableJobs(deps.workerId)} and id <> all(${uuids(lanes.ids())})
      ${deps.onlyKinds ? sql`and kind = any(${texts(deps.onlyKinds)})` : sql``}`;
    return asWorker(deps.db, {}, (tx) =>
      rows<{ id: string; kind: string }>(
        tx,
        sql`with quick as (
              select id, run_at from app.scheduled_jobs
              where ${mine} and kind <> all(${texts([...slow, ...deps.heavyKinds])})
              order by run_at limit ${room.free} for update skip locked),
            slow as (
              select id, run_at from app.scheduled_jobs
              where ${mine} and kind = any(${texts(slow)})
              order by run_at limit ${room.slow} for update skip locked),
            heavy as (
              select id, run_at from app.scheduled_jobs
              where ${mine} and kind = any(${texts(deps.heavyKinds)})
              order by run_at limit ${room.heavy ? 1 : 0} for update skip locked),
            capped as (
              select id, run_at from (select * from slow union all select * from heavy) s
              order by run_at limit ${room.slow}),
            pick as (
              select id from (select * from quick union all select * from capped) c
              order by run_at limit ${room.free}),
            claimed as (
              update app.scheduled_jobs j set locked_at = now(), locked_by = ${deps.workerId}
              where j.id in (select id from pick)
              returning j.id, j.kind, j.run_at)
            select id, kind from claimed order by run_at, id`,
      ),
    );
  };

  /** A job that runs for minutes keeps its lease: without this another worker took it after five and ran it too. */
  const renew = async (now: number) => {
    if (now - renewedAt < RENEW_MS) return;
    renewedAt = now;
    const ids = lanes.ids();
    if (ids.length === 0) return;
    await asWorker(deps.db, {}, (tx) =>
      tx.execute(
        sql`update app.scheduled_jobs set locked_at = now()
            where id = any(${uuids(ids)}) and locked_by = ${deps.workerId} and status = 'pending'`,
      ),
    );
  };

  const start = (id: string, kind: string) => {
    const began = time();
    lanes.started(id, kind, began);
    const run = runClaimed(deps, id)
      .then(() => {
        const ms = time() - began;
        if (ms >= LONG_MS) deps.log.info({ jobId: id, kind, ms }, 'long job');
      })
      // What came of the job could not be written (the database went away). The row is still held under this
      // worker's name and no longer running here, so the next pass takes it again, as a broken pass's rows were.
      .catch((e: unknown) => deps.log.error({ err: e, jobId: id, kind }, 'job broke off'))
      .finally(() => {
        going.delete(id);
        lanes.ended(id, time());
        deps.onFree?.();
      });
    going.set(id, run);
  };

  return {
    async pass() {
      const now = time();
      await renew(now);
      const room = lanes.room(now);
      if (room.free === 0) return { claimed: 0, running: going.size };
      const claimed = await claim(room);
      for (const job of claimed) start(job.id, job.kind);
      return { claimed: claimed.length, running: going.size };
    },
    runningIds: () => lanes.ids(),
    async settle(ms) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all(going.values()),
        new Promise((resolve) => {
          timer = setTimeout(resolve, ms);
        }),
      ]);
      clearTimeout(timer);
      const left = lanes.ids();
      if (left.length === 0) return 0;
      await asWorker(deps.db, {}, (tx) =>
        tx.execute(
          sql`update app.scheduled_jobs set locked_at = null, locked_by = null
              where id = any(${uuids(left)}) and locked_by = ${deps.workerId} and status = 'pending'`,
        ),
      );
      return left.length;
    },
  };
}
