/**
 * Playwright's routes for push notifications (M10), under the worker's test-route guard: http/test-routes.ts registers
 * them only with the fake providers, never in production, and only while the push stand-in is the sender.
 *
 * - `GET /test/push/sent?workspaceId=…` answers what the stand-in was handed for the business, oldest first: each
 *   message's phone (`to`, `platform`), its words (iPhone), its category and its `data` (README.md's contract).
 * - `POST /test/push/run-due { workspaceId }` moves the business's push jobs up to now and runs them: sends waiting
 *   to go, and receipt checks that would otherwise wait 15 minutes. It answers `{ moved, ran }`.
 *
 * **A push is queued by the worker's own loop** (the event's handler, or the urgent alert's job), so a spec that has
 * just made something happen should wait for that work to drain, or read `sent` again, rather than reading it once.
 */
import { randomUUID } from 'node:crypto';
import { HfosError } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBody, type HttpDeps } from '../http/common';
import { processJobs, type JobMap, type JobStats } from '../jobs';
import { PUSH_JOBS } from './queue';

const Business = z.object({ workspaceId: z.uuid() });
const PUSH_KINDS = [PUSH_JOBS.send, PUSH_JOBS.receipts];

export function registerPushTestRoutes(app: FastifyInstance, deps: HttpDeps, jobs: JobMap): void {
  const fake = deps.push.fake;
  if (process.env.NODE_ENV === 'production' || !fake) return;

  app.get('/test/push/sent', async (req) => {
    const { workspaceId } = parseBody(Business, req.query ?? {});
    return {
      sent: fake.sent
        .filter((s) => s.message.data['workspaceId'] === workspaceId)
        .map((s) => ({
          to: s.message.to,
          platform: s.message.categoryId ? 'ios' : 'android',
          title: s.message.title ?? null,
          subtitle: s.message.subtitle ?? null,
          body: s.message.body ?? null,
          categoryId: s.message.categoryId ?? null,
          priority: s.message.priority,
          data: s.message.data,
          ticketId: s.ticketId,
          at: new Date(s.at).toISOString(),
        })),
    };
  });

  app.post('/test/push/run-due', async (req) => {
    const { workspaceId } = parseBody(Business, req.body ?? {});
    const [ws] = await asWorker(deps.db, { workspaceId }, (tx) =>
      rows(tx, sql`select 1 from app.workspaces where id = ${workspaceId}`),
    );
    if (!ws) throw HfosError.notFound('Workspace not found.');
    const kinds = sql`kind in (${sql.join(
      PUSH_KINDS.map((k) => sql`${k}`),
      sql`, `,
    )})`;
    const workerId = `test-push:${randomUUID()}`;
    // Taken as they move: a job not due yet isn't running, so whoever reserved it can't be holding it.
    const moved = await asWorker(deps.db, {}, (tx) =>
      rows<{ id: string }>(
        tx,
        sql`update app.scheduled_jobs set run_at = now(), locked_at = now(), locked_by = ${workerId}
            where workspace_id = ${workspaceId} and status = 'pending' and run_at > now() and ${kinds}
            returning id`,
      ),
    );
    const ran: JobStats = {
      claimed: 0,
      done: 0,
      rescheduled: 0,
      retried: 0,
      failed: 0,
      cancelled: 0,
    };
    for (let pass = 0; pass < 5; pass++) {
      await asWorker(deps.db, {}, (tx) =>
        tx.execute(
          sql`update app.scheduled_jobs set locked_at = now(), locked_by = ${workerId}
              where workspace_id = ${workspaceId} and status = 'pending' and run_at <= now() and ${kinds}
                and (locked_at is null or locked_at < now() - interval '5 minutes' or locked_by = ${workerId})`,
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
  });
}
