/**
 * Routes for Playwright only. They are registered when the fake providers are on, and never in production
 * (main.ts and this file both check), so a browser test can see what only time would otherwise show.
 *
 * POST /test/scheduled-jobs/run-due { workspaceId, dedupeKeys? } runs the workspace's due jobs now. Jobs named
 * by dedupe key are moved up to now first and run as of the moment they were due, so a reminder for three
 * days out goes out the way it would have then. The messages they queue go out with the next outbox pass.
 */
import { randomUUID } from 'node:crypto';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { processJobs, type JobMap, type JobStats } from '../jobs';
import { parseBody, type HttpDeps } from './common';

export interface TestRoutes {
  readonly jobs: JobMap;
}

const RunDue = z.object({
  workspaceId: z.uuid(),
  dedupeKeys: z.array(z.string().trim().min(1).max(300)).max(50).default([]),
});

export function registerTestRoutes(app: FastifyInstance, deps: HttpDeps, test: TestRoutes): void {
  if (process.env.NODE_ENV === 'production') return;

  app.post('/test/scheduled-jobs/run-due', async (req) => {
    const body = parseBody(RunDue, req.body ?? {});
    const workerId = `test-run-due:${randomUUID()}`;
    const dueAt = new Map<string, number>();
    const moved: { id: string; kind: string; dedupeKey: string; dueAt: string }[] = [];
    if (body.dedupeKeys.length > 0) {
      const list = await asWorker(deps.db, {}, (tx) =>
        rows<{ id: string; kind: string; dedupe_key: string; due_at: Date | string }>(
          tx,
          sql`with picked as (
                select id, run_at from app.scheduled_jobs
                where workspace_id = ${body.workspaceId} and status = 'pending'
                  and dedupe_key in (${sql.join(
                    body.dedupeKeys.map((k) => sql`${k}`),
                    sql`, `,
                  )})
                for update)
              update app.scheduled_jobs j set run_at = now(), locked_at = now(), locked_by = ${workerId}
              from picked where j.id = picked.id
              returning j.id, j.kind, j.dedupe_key, picked.run_at as due_at`,
        ),
      );
      for (const r of list) {
        const at = new Date(r.due_at).getTime();
        dueAt.set(r.id, at);
        moved.push({
          id: r.id,
          kind: r.kind,
          dedupeKey: r.dedupe_key,
          dueAt: new Date(at).toISOString(),
        });
      }
    }
    const lockDue = () =>
      asWorker(deps.db, {}, (tx) =>
        tx.execute(
          sql`update app.scheduled_jobs set locked_at = now(), locked_by = ${workerId}
              where workspace_id = ${body.workspaceId} and status = 'pending' and run_at <= now()
                and (locked_at is null or locked_at < now() - interval '5 minutes')`,
        ),
      );
    const total: JobStats = { claimed: 0, done: 0, rescheduled: 0, retried: 0, failed: 0 };
    // A job that asks to run again right away (it changed while it ran) gets another pass.
    for (let pass = 0; pass < 5; pass++) {
      await lockDue();
      const stats = await processJobs({
        ...deps,
        jobs: test.jobs,
        workerId,
        batchSize: 100,
        reservedOnly: true,
        clock: (job) => {
          const at = dueAt.get(job.id);
          dueAt.delete(job.id);
          return at ?? Date.now();
        },
      });
      for (const k of Object.keys(total) as (keyof JobStats)[]) total[k] += stats[k];
      if (stats.claimed === 0) break;
    }
    return { moved, ran: total };
  });
}
