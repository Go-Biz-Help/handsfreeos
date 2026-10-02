/**
 * Playwright's route for Real Estate Agent (round four's spec), under the worker's test-route guard: its worker
 * module's `testRoutes`, which http/test-routes.ts registers only with the fake providers, never in production.
 *
 * POST /test/realestate/at-risk-since { workspaceId, dutyId, hours } says an at-risk duty has been at risk for so many
 * hours, so a browser test sees it go to the business's alert people at the next sweep without waiting a business
 * day. The duty must be at risk already (a sweep marked it); run the sweep after with /test/scheduled-jobs/run-due
 * and the dedupe key `<workspaceId>:realestate.sweep:<workspaceId>`.
 */
import { HfosError } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBody, type HttpDeps } from '../../http/common';

const AtRiskSince = z.object({
  workspaceId: z.uuid(),
  dutyId: z.uuid(),
  hours: z
    .number()
    .int()
    .min(1)
    .max(24 * 30),
});

export function registerRealestateTestRoutes(app: FastifyInstance, deps: HttpDeps): void {
  app.post('/test/realestate/at-risk-since', async (req) => {
    const body = parseBody(AtRiskSince, req.body ?? {});
    const [row] = await asWorker(deps.db, { workspaceId: body.workspaceId }, (tx) =>
      rows<{ id: string }>(
        tx,
        sql`update addon_realestate.duties
            set at_risk_since = now() - make_interval(hours => ${body.hours})
            where workspace_id = ${body.workspaceId} and id = ${body.dutyId}
              and at_risk_since is not null
            returning id`,
      ),
    );
    if (!row)
      throw HfosError.notFound(
        'That duty isn’t at risk yet. Run the sweep once it’s overdue, then try again.',
      );
    return { dutyId: row.id };
  });
}
