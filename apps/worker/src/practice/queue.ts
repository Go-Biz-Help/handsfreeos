/** The practice jobs' names, and queueing a practice organization's purge (./jobs.ts). */
import { scheduleJob } from '@hfos/core/server';
import type { Tx } from '@hfos/db/client';

export const PRACTICE_JOBS = { sweep: 'practice.sweep', purge: 'practice.purge' } as const;
export const PRACTICE_SWEEP_KEY = 'sweep:practice';
const purgeKey = (organizationId: string) => `practice-purge:${organizationId}`;

/** Queues a practice organization's purge, in the platform's own queue (its own would go with it). */
export async function queuePracticePurge(tx: Tx, organizationId: string): Promise<void> {
  await scheduleJob(tx, {
    kind: PRACTICE_JOBS.purge,
    dedupeKey: purgeKey(organizationId),
    runAt: new Date(),
    payload: { organizationId },
    workspaceId: null,
    organizationId: null,
  });
}

