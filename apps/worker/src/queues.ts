import { asWorker, rows, sql, type Db } from '@hfos/db/client';
import type { SQL } from 'drizzle-orm';
import { claimableDeliveries } from './deliveries';
import { claimableJobs } from './jobs';
import { runLoop, type Loop, type LoopDeps } from './loop';
import { claimableEvents } from './outbox';

/**
 * The worker's three queues, and the one look a second that paces them.
 *
 * Each queue's loop used to make its own claim once a second: an `update` in a transaction of its own that found
 * nothing 999 times in 1,000. Three of them in every worker process were most of the statements this database
 * ran. Now one statement a second asks all three queues whether anything is waiting, and a loop makes its claim
 * only when that says so, when another part of the worker wakes it (main.ts: a webhook stored, an event handled,
 * a job run), or once every `SAFETY_MS` in case both were missed. Nothing is found later than before: the look
 * comes as often as the claims did, and it asks with the claims' own words.
 */

export type QueueName = 'outbox' | 'webhook' | 'jobs';
export type QueuesWaiting = Readonly<Record<QueueName, boolean>>;
type Pass = () => Promise<{ claimed: number }>;

/** A loop that was told of nothing still makes its own claim this often. */
export const SAFETY_MS = 30_000;

/**
 * Whether a queue has a row to claim, asked as "the oldest one" and never as a bare `exists`.
 *
 * The worker reads these tables through row-level security, where Postgres won't use what it knows about `status`
 * (an enum's `=` isn't leakproof), so it reckons a half or a third of each table is waiting. For an `exists` it
 * then expects the first rows of the table itself to do, and reads the whole table to find there is none: live,
 * every row of the outbox and the webhooks on every look, 325 blocks and 1.6 ms, where the same statement read 9
 * blocks for a role row-level security doesn't apply to. Asked for the first by the column the queue's index of
 * waiting rows is sorted on, that index costs least whatever Postgres reckons: one block with nothing waiting.
 * Writing the order and the limit inside an `exists` won't do, because Postgres drops both there.
 */
const oldest = (table: SQL, claimable: SQL, due: SQL) =>
  sql`coalesce((select true from ${table} where ${claimable} order by ${due} limit 1), false)`;

/**
 * The look's one statement: each queue's oldest claimable row, through its index of waiting rows.
 *
 * `runningJobs` are the jobs this worker is running (job-runner.ts): it holds them, so the claim's words count them
 * as its own to take, and they are left out here as the runner's claim leaves them out.
 */
export const waitingStatement = (workerId: string, runningJobs: readonly string[] = []) => {
  const notRunning =
    runningJobs.length === 0
      ? sql``
      : sql`and id not in (${sql.join(
          runningJobs.map((id) => sql`${id}`),
          sql`, `,
        )})`;
  return sql`select
        ${oldest(sql`app.outbox`, claimableEvents(workerId), sql`next_attempt_at`)} as outbox,
        ${oldest(sql`app.webhook_deliveries`, claimableDeliveries(workerId), sql`next_attempt_at`)} as webhook,
        ${oldest(sql`app.scheduled_jobs`, sql`${claimableJobs(workerId)} ${notRunning}`, sql`run_at`)} as jobs`;
};

/** Which queues have something this worker may claim now. */
export async function queuesWaiting(
  db: Db,
  workerId: string,
  runningJobs: readonly string[] = [],
): Promise<QueuesWaiting> {
  const [row] = await asWorker(db, {}, (tx) =>
    rows<QueuesWaiting>(tx, waitingStatement(workerId, runningJobs)),
  );
  return row ?? { outbox: false, webhook: false, jobs: false };
}

export interface Queues {
  /** Every loop here, to wait for and to wake when the worker stops. */
  readonly loops: readonly Loop[];
  /** There is work for this queue now: its loop makes its claim at once, or as soon as the pass it is in ends. */
  wake(queue: QueueName): void;
}

export function runQueues(
  passes: Readonly<Record<QueueName, Pass>>,
  waiting: () => Promise<QueuesWaiting>,
  deps: LoopDeps,
): Queues {
  // Woken by the look below; on their own only as the safety net.
  const paced = { drain: true, idle: { afterMs: 0, everyMs: SAFETY_MS } } as const;
  const loops: Readonly<Record<QueueName, Loop>> = {
    outbox: runLoop('outbox', passes.outbox, paced, deps),
    webhook: runLoop('webhook', passes.webhook, paced, deps),
    jobs: runLoop('jobs', passes.jobs, paced, deps),
  };
  const look = runLoop(
    'look',
    async () => {
      const found = await waiting();
      if (found.outbox) loops.outbox.wake();
      if (found.webhook) loops.webhook.wake();
      if (found.jobs) loops.jobs.wake();
      return { claimed: 0 };
    },
    { drain: false },
    deps,
  );
  return {
    loops: [loops.outbox, loops.webhook, loops.jobs, look],
    wake: (queue) => loops[queue].wake(),
  };
}
