/**
 * Playwright's routes for the Action Center (M8), under the worker's test-route guard: http/test-routes.ts
 * registers them only with the fake providers, and never in production.
 *
 * Every spec pins the business's open hours (`settings.openHours`, all week) and its quiet hours first: an
 * unanswered lead's 15 minutes count open hours only, an urgent email about a lead waits for opening time, and a
 * business defaults to weekdays 8 to 5 in Chicago, so anything timing-dependent flips at night and at weekends.
 *
 * - `POST /test/attention/sweep { workspaceId, at? }` reconciles the whole business now, or as of `at` (an ISO
 *   time: an hour ahead for a hot lead's urgency, eight days ahead for a stale lead), exactly as the hourly sweep
 *   does. Items open, clear and turn urgent with their attention_item.* events, so Home updates live.
 * - `POST /test/attention/run-jobs { workspaceId }` runs everything the Action Center has waiting for the business
 *   — sweeps, rechecks, snoozes running out, automatic messages and urgent emails — as if their time had come.
 * - `POST /test/attention/send-now { workspaceId, itemId }` skips one item's 60-minute cancel window: its message
 *   goes out now.
 * - `POST /test/attention/digest { workspaceId }` sends the morning summary now.
 *
 * Each answers with what it moved and ran. **A job and the record that armed it commit together, but the event
 * that armed them is handled by the worker's own loop, so a spec that has just made something happen should wait
 * for its work to drain — or call again while `moved` is 0 — rather than reading the item once and assuming.**
 */
import { randomUUID } from 'node:crypto';
import { HfosError } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBody, type HttpDeps } from '../http/common';
import { processJobs, type JobMap, type JobStats } from '../jobs';
import type { TenantScope } from '../services';
import { ATTENTION_JOBS, autoJobKey, digestJobKey } from './constants';
import { armDigestNow } from './digest';
import { sweepBusiness } from './jobs';

const Sweep = z.object({
  workspaceId: z.uuid(),
  at: z.iso.datetime({ offset: true }).optional(),
});
const RunJobs = z.object({ workspaceId: z.uuid() });
const SendNow = z.object({ workspaceId: z.uuid(), itemId: z.uuid() });

/** Everything the Action Center runs for one business (its global plan aside). */
const BUSINESS_JOB_KINDS: readonly string[] = [
  ATTENTION_JOBS.sweep,
  ATTENTION_JOBS.recheck,
  ATTENTION_JOBS.unsnooze,
  ATTENTION_JOBS.autoHandle,
  ATTENTION_JOBS.urgentAlert,
];

async function scopeOf(deps: HttpDeps, workspaceId: string): Promise<TenantScope> {
  const [ws] = await asWorker(deps.db, { workspaceId }, (tx) =>
    rows<{ organization_id: string }>(
      tx,
      sql`select organization_id from app.workspaces where id = ${workspaceId}`,
    ),
  );
  if (!ws) throw HfosError.notFound('Workspace not found.');
  return { workspaceId, organizationId: ws.organization_id };
}

/** Moves the business's waiting jobs of these kinds to now, then runs them until nothing is left. */
async function runDue(
  deps: HttpDeps,
  jobs: JobMap,
  workspaceId: string,
  kinds: readonly string[],
  dedupeKeys?: readonly string[],
): Promise<{ moved: number; ran: JobStats }> {
  const moved = await asWorker(deps.db, {}, (tx) =>
    rows<{ id: string }>(
      tx,
      sql`update app.scheduled_jobs set run_at = now()
          where workspace_id = ${workspaceId} and status = 'pending' and run_at > now()
            and kind in (${sql.join(
              kinds.map((k) => sql`${k}`),
              sql`, `,
            )})
            ${
              dedupeKeys
                ? sql`and dedupe_key in (${sql.join(
                    dedupeKeys.map((k) => sql`${k}`),
                    sql`, `,
                  )})`
                : sql``
            }
          returning id`,
    ),
  );
  const workerId = `test-attention:${randomUUID()}`;
  const ran: JobStats = {
    claimed: 0,
    done: 0,
    rescheduled: 0,
    retried: 0,
    failed: 0,
    cancelled: 0,
  };
  // A job that asks to run again right away (it changed while it ran) gets another pass.
  for (let pass = 0; pass < 5; pass++) {
    await asWorker(deps.db, {}, (tx) =>
      tx.execute(
        sql`update app.scheduled_jobs set locked_at = now(), locked_by = ${workerId}
            where workspace_id = ${workspaceId} and status = 'pending' and run_at <= now()
              and kind in (${sql.join(
                kinds.map((k) => sql`${k}`),
                sql`, `,
              )})
              and (locked_at is null or locked_at < now() - interval '5 minutes')`,
      ),
    );
    const stats = await processJobs({
      ...deps,
      jobs,
      workerId,
      batchSize: 100,
      reservedOnly: true,
    });
    for (const k of Object.keys(ran) as (keyof JobStats)[]) ran[k] += stats[k];
    if (stats.claimed === 0) break;
  }
  return { moved: moved.length, ran };
}

export function registerAttentionTestRoutes(
  app: FastifyInstance,
  deps: HttpDeps,
  jobs: JobMap,
): void {
  if (process.env.NODE_ENV === 'production') return;

  app.post('/test/attention/sweep', async (req) => {
    const body = parseBody(Sweep, req.body ?? {});
    const scope = await scopeOf(deps, body.workspaceId);
    const now = body.at ? Date.parse(body.at) : Date.now();
    const outcome = await asWorker(deps.db, scope, (tx) =>
      sweepBusiness(tx, scope, now, { correlationId: randomUUID(), causationId: randomUUID() }),
    );
    return {
      at: new Date(now).toISOString(),
      transitions: outcome.transitions.map((t) => ({
        type: t.type,
        kind: t.kind,
        itemId: t.itemId,
        subjectType: t.subjectType,
        subjectId: t.subjectId,
        state: t.state,
        resolution: t.resolution,
      })),
      becameUrgent: outcome.becameUrgent.map((u) => u.itemId),
      updated: outcome.updated,
    };
  });

  app.post('/test/attention/run-jobs', async (req) => {
    const body = parseBody(RunJobs, req.body ?? {});
    await scopeOf(deps, body.workspaceId);
    return runDue(deps, jobs, body.workspaceId, BUSINESS_JOB_KINDS);
  });

  app.post('/test/attention/send-now', async (req) => {
    const body = parseBody(SendNow, req.body ?? {});
    const scope = await scopeOf(deps, body.workspaceId);
    // The cancel window is over: the item says so, and its job is due.
    const [item] = await asWorker(deps.db, scope, (tx) =>
      rows<{ id: string; auto_state: string | null }>(
        tx,
        sql`update app.attention_items set auto_scheduled_for = now()
            where workspace_id = ${scope.workspaceId} and id = ${body.itemId}
              and auto_state = 'scheduled'
            returning id, auto_state`,
      ),
    );
    const ran = await runDue(
      deps,
      jobs,
      body.workspaceId,
      [ATTENTION_JOBS.autoHandle],
      [autoJobKey(body.itemId)],
    );
    return { scheduled: !!item, ...ran };
  });

  app.post('/test/attention/digest', async (req) => {
    const body = parseBody(RunJobs, req.body ?? {});
    const scope = await scopeOf(deps, body.workspaceId);
    await asWorker(deps.db, scope, (tx) => armDigestNow(tx, scope, Date.now()));
    return runDue(
      deps,
      jobs,
      body.workspaceId,
      [ATTENTION_JOBS.digest],
      [digestJobKey(body.workspaceId)],
    );
  });
}
