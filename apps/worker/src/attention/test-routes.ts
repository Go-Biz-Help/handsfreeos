/**
 * Playwright's route for the Action Center (M8), under the worker's test-route guard: http/test-routes.ts registers
 * it only with the fake providers, and never in production.
 *
 * POST /test/attention/sweep { workspaceId, at? } reconciles the whole business now, or as of `at` (an ISO time: an
 * hour ahead for a hot lead's urgency, eight days ahead for a stale lead), exactly as the hourly sweep does. Items
 * open, clear and turn urgent with their attention_item.* events, so Home updates live. It answers with what changed.
 * A spec pins the business's open hours (settings.openHours) and quiet hours first: an unanswered lead's 15 minutes
 * count open hours only, and the default hours (weekdays 8 to 5) would flip results at night and on weekends.
 */
import { randomUUID } from 'node:crypto';
import { HfosError } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBody, type HttpDeps } from '../http/common';
import { sweepBusiness } from './jobs';

const Sweep = z.object({
  workspaceId: z.uuid(),
  at: z.iso.datetime({ offset: true }).optional(),
});

export function registerAttentionTestRoutes(app: FastifyInstance, deps: HttpDeps): void {
  if (process.env.NODE_ENV === 'production') return;

  app.post('/test/attention/sweep', async (req) => {
    const body = parseBody(Sweep, req.body ?? {});
    const [ws] = await asWorker(deps.db, { workspaceId: body.workspaceId }, (tx) =>
      rows<{ organization_id: string }>(
        tx,
        sql`select organization_id from app.workspaces where id = ${body.workspaceId}`,
      ),
    );
    if (!ws) throw HfosError.notFound('Workspace not found.');
    const scope = { workspaceId: body.workspaceId, organizationId: ws.organization_id };
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
}
