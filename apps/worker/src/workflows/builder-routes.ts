import rateLimit from '@fastify/rate-limit';
import { HfosError } from '@hfos/core/server';
import type { FastifyInstance } from 'fastify';
import { authenticate, parseBody, requirePermission, type HttpDeps } from '../http/common';
import { BuilderInput, draftProposal } from './builder';

/** Requests one address may make a minute. The daily AI limit applies on top. */
export const BUILDER_PER_MINUTE = 20;

/**
 * POST /v1/workflows/ai/edit {workspaceId, workflowId | null, baseRevision | null, prompt, selectedStepId?,
 * proposalId?} (bearer token, workflows.manage) → {proposalId, workflowId, baseRevision, ops, preview, issues,
 * summary, reply, unsupported, expiresAt}. Nothing changes until someone applies the proposal. 429
 * `budget_reached` over today's AI limit (or `rate_limited`), 503 `ai_not_configured` without a model or
 * `ai_busy`, 502 `ai_failed`, 409 `revision_conflict` when the draft moved on, `proposal_stale` for a
 * follow-up on an outdated proposal.
 */
export async function registerBuilderRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  await app.register(async (scoped) => {
    await scoped.register(rateLimit, {
      global: false,
      errorResponseBuilder: () =>
        new HfosError(
          'rule_violation',
          429,
          'That’s a lot of changes in a row. Wait a minute and try again.',
          undefined,
          'rate_limited',
        ),
    });
    scoped.post(
      '/v1/workflows/ai/edit',
      { config: { rateLimit: { max: BUILDER_PER_MINUTE, timeWindow: 60_000 } } },
      async (req) => {
        const actor = await authenticate(deps, req);
        const input = parseBody(BuilderInput, req.body);
        await requirePermission(deps, actor.userId, input.workspaceId, 'workflows.manage');
        const { proposal } = await draftProposal(
          { db: deps.httpDb, ai: deps.ai, log: deps.log, wallet: deps.wallet },
          actor,
          input,
        );
        return proposal;
      },
    );
  });
}
