/**
 * Playwright's routes for the AI teammate (step 11's specs), under the worker's test-route guard: http/test-routes.ts
 * registers them only with the fake providers, and never in production.
 *
 * POST /test/ai-team/run-due { workspaceId, all? } runs the business's teammate replies now, skipping their
 * debounce wait; with `all`, first messages, nudges, held drafts and hand-off lines, and the draft-expiry sweep come
 * forward too. Then the business's due jobs run; the messages they queue go out with the next outbox pass.
 *
 * POST /test/ai-team/use-budget { workspaceId } uses up the teammate's share of today's AI limit, so the next
 * customer message goes to a person with the hand-off line. It stays used up for the rest of the business's day:
 * the worker can only add AI usage, never take it back, so a spec that uses it wants a business of its own.
 *
 * POST /test/ai-team/expire-draft { workspaceId, draftId? } makes the draft (or every pending one) expire now,
 * and runs the business's expiry sweep: the conversation goes to a person with reason draft_expired.
 */
import { randomUUID } from 'node:crypto';
import { HfosError, loadTeammate } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBody, type HttpDeps } from '../http/common';
import { processJobs, type JobMap, type JobStats } from '../jobs';
import type { TenantScope } from '../services';
import { runtimeConfigOf } from './config';
import { TEAMMATE_JOBS } from './constants';
import { expireDueDrafts } from './expiry';

/** The ai_usage rows use-budget writes are marked as the test's. */
const TEST_BUDGET_MODEL = 'test:use-budget';

const RunDue = z.object({ workspaceId: z.uuid(), all: z.boolean().default(false) });
const UseBudget = z.object({ workspaceId: z.uuid() });
const ExpireDraft = z.object({ workspaceId: z.uuid(), draftId: z.uuid().optional() });

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

export function registerTeammateTestRoutes(
  app: FastifyInstance,
  deps: HttpDeps,
  jobs: JobMap,
): void {
  app.post('/test/ai-team/run-due', async (req) => {
    const body = parseBody(RunDue, req.body ?? {});
    const kinds = body.all ? Object.values(TEAMMATE_JOBS) : [TEAMMATE_JOBS.reply];
    const moved = await asWorker(deps.db, {}, (tx) =>
      rows<{ id: string }>(
        tx,
        sql`update app.scheduled_jobs set run_at = now()
            where workspace_id = ${body.workspaceId} and status = 'pending' and run_at > now()
              and kind in (${sql.join(
                kinds.map((k) => sql`${k}`),
                sql`, `,
              )})
            returning id`,
      ),
    );
    const workerId = `test-ai-team:${randomUUID()}`;
    const total: JobStats = { claimed: 0, done: 0, rescheduled: 0, retried: 0, failed: 0 };
    for (let pass = 0; pass < 5; pass++) {
      await asWorker(deps.db, {}, (tx) =>
        tx.execute(
          sql`update app.scheduled_jobs set locked_at = now(), locked_by = ${workerId}
              where workspace_id = ${body.workspaceId} and status = 'pending' and run_at <= now()
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
      for (const k of Object.keys(total) as (keyof JobStats)[]) total[k] += stats[k];
      if (stats.claimed === 0) break;
    }
    return { moved: moved.length, ran: total };
  });

  app.post('/test/ai-team/use-budget', async (req) => {
    const body = parseBody(UseBudget, req.body ?? {});
    const scope = await scopeOf(deps, body.workspaceId);
    return asWorker(deps.db, scope, async (tx) => {
      const teammate = await loadTeammate(tx, scope.workspaceId);
      if (!teammate) throw HfosError.notFound('This business has no AI teammate.');
      const share = Math.ceil(
        (deps.ai.dailyTokens * runtimeConfigOf(teammate.config).limits.dailySharePercent) / 100,
      );
      await tx.execute(
        sql`insert into app.ai_usage (workspace_id, source, teammate_id, model, input_tokens)
            values (${scope.workspaceId}, 'teammate', ${teammate.id}, ${TEST_BUDGET_MODEL}, ${share})`,
      );
      return { tokens: share };
    });
  });

  app.post('/test/ai-team/expire-draft', async (req) => {
    const body = parseBody(ExpireDraft, req.body ?? {});
    const scope = await scopeOf(deps, body.workspaceId);
    const due = await asWorker(deps.db, scope, (tx) =>
      rows<{ id: string }>(
        tx,
        sql`update app.ai_teammate_drafts set expires_at = now() - interval '1 second'
            where workspace_id = ${scope.workspaceId} and status = 'pending'
              ${body.draftId ? sql`and id = ${body.draftId}` : sql``}
            returning id`,
      ),
    );
    const { expired } = await expireDueDrafts(deps.db, scope);
    return { due: due.length, expired };
  });
}
