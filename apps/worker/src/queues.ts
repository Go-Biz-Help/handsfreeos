import { asWorker, rows, sql, type Db } from '@hfos/db/client';
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

/** Which queues have something this worker may claim now. One statement over the queues' indexes of waiting rows. */
export async function queuesWaiting(db: Db, workerId: string): Promise<QueuesWaiting> {
  const [row] = await asWorker(db, {}, (tx) =>
    rows<QueuesWaiting>(
      tx,
      sql`select
            exists(select 1 from app.outbox where ${claimableEvents(workerId)}) as outbox,
            exists(select 1 from app.webhook_deliveries where ${claimableDeliveries(workerId)}) as webhook,
            exists(select 1 from app.scheduled_jobs where ${claimableJobs(workerId)}) as jobs`,
    ),
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
