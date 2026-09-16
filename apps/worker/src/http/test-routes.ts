/**
 * Routes for Playwright only. They are registered when the fake providers are on, and never in production
 * (main.ts and this file both check), so a browser test can see what only time would otherwise show.
 *
 * POST /test/scheduled-jobs/run-due { workspaceId, dedupeKeys? } runs the workspace's due jobs now. Jobs named
 * by dedupe key are moved up to now first and run as of the moment they were due, so a reminder for three
 * days out goes out the way it would have then. The messages they queue go out with the next outbox pass.
 *
 * POST /test/knowledge/scan-at { workspaceId, url } scans a local fixture site (one of FETCH_TEST_ORIGINS) in
 * place of the business's website. The website address itself must stay https (knowledge_source.set and the
 * table's check refuse anything else), so this starts a scan of the saved website the way
 * knowledge_scan.requested does, except that its job reads `url`. The worker's loop (or run-due) then reads it.
 *
 * POST /test/outbox/skip-stale { before } marks the outbox's pending rows written before `before` as done, with a
 * note saying why. The core, DB and worker suites leave thousands of events behind in the shared local database,
 * and a browser run's worker would otherwise spend minutes on them before reaching the specs' own. Playwright's
 * global setup calls it with the run's start time, so the run's own events are never touched.
 */
import { randomUUID } from 'node:crypto';
import { HfosError, scheduleJob } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { registerTeammateTestRoutes } from '../ai-team/test-routes';
import { registerAttentionTestRoutes } from '../attention/test-routes';
import { registerMoneyTestRoutes } from '../money/test-routes';
import { registerPushTestRoutes } from '../push/test-routes';
import { processJobs, type JobMap, type JobStats } from '../jobs';
import { parseBody, type HttpDeps } from './common';

export interface TestRoutes {
  readonly jobs: JobMap;
  /** The local sites a website scan may read (FETCH_TEST_ORIGINS); scan-at refuses any other address. */
  readonly fetchTestOrigins?: readonly string[];
}

const ScanAt = z.object({
  workspaceId: z.uuid(),
  url: z.string().trim().min(1).max(2000),
});

const RunDue = z.object({
  workspaceId: z.uuid(),
  dedupeKeys: z.array(z.string().trim().min(1).max(300)).max(50).default([]),
});

const SkipStale = z.object({ before: z.iso.datetime({ offset: true }) });

/** What an outbox row skipped by /test/outbox/skip-stale says. */
export const STALE_SKIP_NOTE = 'skipped: left by another suite before this browser run';

export function registerTestRoutes(app: FastifyInstance, deps: HttpDeps, test: TestRoutes): void {
  if (process.env.NODE_ENV === 'production') return;
  // The AI teammate's: run its due work now, use up its AI share, expire a draft (ai-team/test-routes.ts).
  registerTeammateTestRoutes(app, deps, test.jobs);
  // The Action Center's: reconcile a business, run its due work, send now, the morning summary
  // (attention/test-routes.ts).
  registerAttentionTestRoutes(app, deps, test.jobs);
  // Money's: make the stand-in provider post one of its signed webhooks now, and run this business's money
  // jobs (money/test-routes.ts).
  registerMoneyTestRoutes(app, deps, test.jobs);
  // Push's: what the stand-in was handed for a business, and its push jobs run now (push/test-routes.ts).
  registerPushTestRoutes(app, deps, test.jobs);

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

  app.post('/test/outbox/skip-stale', async (req) => {
    const body = parseBody(SkipStale, req.body ?? {});
    const [row] = await asWorker(deps.db, {}, (tx) =>
      rows<{ skipped: number }>(
        tx,
        sql`with skipped as (
              update app.outbox
              set status = 'done', locked_at = null, locked_by = null, last_error = ${STALE_SKIP_NOTE}
              where status = 'pending' and created_at < ${body.before}::timestamptz
              returning 1)
            select count(*)::int as skipped from skipped`,
      ),
    );
    return { skipped: row?.skipped ?? 0 };
  });

  app.post('/test/knowledge/scan-at', async (req) => {
    const body = parseBody(ScanAt, req.body ?? {});
    let target: URL | null = null;
    try {
      target = new URL(body.url);
    } catch {
      // Refused below.
    }
    if (!target || !(test.fetchTestOrigins ?? []).includes(target.origin))
      throw new HfosError(
        'validation',
        400,
        'Scan only a local test site listed in FETCH_TEST_ORIGINS.',
        [{ path: 'url', message: 'Not one of FETCH_TEST_ORIGINS.' }],
        'not_a_test_origin',
      );
    const url = `${target.origin}${target.pathname}`;
    const [ws] = await asWorker(deps.db, { workspaceId: body.workspaceId }, (tx) =>
      rows<{ organization_id: string }>(
        tx,
        sql`select organization_id from app.workspaces where id = ${body.workspaceId}`,
      ),
    );
    if (!ws) throw HfosError.notFound('Workspace not found.');
    const scope = { workspaceId: body.workspaceId, organizationId: ws.organization_id };
    return asWorker(deps.db, scope, async (tx) => {
      const [source] = await rows<{ id: string }>(
        tx,
        sql`select id from app.knowledge_sources where workspace_id = ${scope.workspaceId}`,
      );
      if (!source) throw HfosError.conflict('Add the website address first.', 'no_website');
      const [live] = await rows<{ id: string }>(
        tx,
        sql`select id from app.knowledge_scans
            where source_id = ${source.id} and status in ('queued', 'running')`,
      );
      if (live) throw HfosError.conflict('A scan is already running.', 'scan_running');
      const [scan] = await rows<{ id: string }>(
        tx,
        sql`insert into app.knowledge_scans (workspace_id, source_id)
            values (${scope.workspaceId}, ${source.id}) returning id`,
      );
      await scheduleJob(tx, {
        kind: 'knowledge.scan',
        dedupeKey: `knowledge.scan:${scan!.id}`,
        runAt: new Date(),
        payload: {
          scanId: scan!.id,
          sourceId: source.id,
          url,
          requestedBy: null,
          correlationId: randomUUID(),
          causationId: null,
        },
        workspaceId: scope.workspaceId,
        organizationId: scope.organizationId,
      });
      return { scanId: scan!.id, url };
    });
  });
}
