/**
 * Practice businesses going (Admin → Try onboarding, 20261027027400). Ending one is deleting it, as an owner does
 * (`practice.end`), and the business's deletion job takes it out like any other (workspace/delete.ts). Two jobs here
 * do the rest:
 *
 * - `practice.sweep`, hourly: one whose time is up is marked and its deletion queued, as if its owner had asked
 *   (`private.practice_expire`).
 * - `practice.purge`: once its business is gone, the practice organization goes too, with its own history, so nothing
 *   of it is left (`private.purge_practice_organization`). Queued by the business's deletion job and by the sweep.
 */
import { scheduleJob } from '@hfos/core/server';
import { asWorker, noStatementLimit, rows, sql } from '@hfos/db/client';
import type { JobHandler } from '../jobs';
import { WORKSPACE_JOBS, workspaceDeleteJobKey } from '../workspace/delete';
import { PRACTICE_JOBS, queuePracticePurge } from './queue';

export { PRACTICE_JOBS, PRACTICE_SWEEP_KEY } from './queue';

const HOUR = 60 * 60_000;

export const practiceSweep: JobHandler = async (ctx) => {
  const due = await asWorker(ctx.db, {}, (tx) =>
    rows<{ organization_id: string; workspace_id: string | null }>(
      tx,
      sql`select organization_id, workspace_id from private.practice_expire()`,
    ),
  );
  if (!due.length) return { rescheduleAt: new Date(Date.now() + HOUR) };
  await asWorker(ctx.db, {}, async (tx) => {
    for (const d of due) {
      if (!d.workspace_id) {
        await queuePracticePurge(tx, d.organization_id);
        continue;
      }
      // The same job an owner's request queues, in the organization's queue as that one is.
      await scheduleJob(tx, {
        kind: WORKSPACE_JOBS.delete,
        dedupeKey: workspaceDeleteJobKey(d.workspace_id),
        runAt: new Date(),
        payload: {
          workspaceId: d.workspace_id,
          organizationId: d.organization_id,
          requestedBy: null,
          practice: true,
        },
        workspaceId: null,
        organizationId: d.organization_id,
      });
    }
  });
  ctx.log.info({ due: due.length }, 'practice businesses whose time was up are going');
  return { rescheduleAt: new Date(Date.now() + HOUR) };
};

export const practicePurge: JobHandler = async (ctx) => {
  const organizationId = ctx.job.payload['organizationId'];
  if (typeof organizationId !== 'string') return;
  const [done] = await asWorker(ctx.db, {}, async (tx) => {
    // One statement for the organization and every business in it.
    await noStatementLimit(tx);
    return rows<{ purged: boolean }>(
      tx,
      sql`select private.purge_practice_organization(${organizationId}::uuid) as purged`,
    );
  });
  if (done?.purged) ctx.log.info({ organizationId }, 'a practice organization is gone');
};

export const practiceJobs = {
  [PRACTICE_JOBS.sweep]: practiceSweep,
  [PRACTICE_JOBS.purge]: practicePurge,
};
