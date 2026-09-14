import rateLimit from '@fastify/rate-limit';
import { HfosError } from '@hfos/core/server';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, parseBody, requirePermission, type HttpDeps } from '../http/common';
import { tryKnowledge } from './try';

/** Try it: questions one address may ask a minute. The daily AI limit applies on top. */
export const TRY_PER_MINUTE = 20;

const TryInput = z.object({
  workspaceId: z.uuid(),
  question: z
    .string()
    .trim()
    .min(1, 'Type a question.')
    .max(500, 'Keep the question under 500 characters.'),
});

/**
 * POST /v1/knowledge/try {workspaceId, question} (bearer token, knowledge.manage) →
 * {answer, unanswered, items: [{id, kind, title, snippet}], gap: {suggestionId, grouped} | null}.
 * 429 `budget_reached` over today's AI limit (or `rate_limited`), 503 `ai_not_configured` without a model.
 */
export async function registerKnowledgeRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  await app.register(async (scoped) => {
    await scoped.register(rateLimit, {
      global: false,
      errorResponseBuilder: () =>
        new HfosError(
          'rule_violation',
          429,
          'That’s a lot of questions in a row. Wait a minute and try again.',
          undefined,
          'rate_limited',
        ),
    });
    scoped.post(
      '/v1/knowledge/try',
      { config: { rateLimit: { max: TRY_PER_MINUTE, timeWindow: 60_000 } } },
      async (req) => {
        const actor = await authenticate(deps, req);
        const input = parseBody(TryInput, req.body);
        await requirePermission(deps, actor.userId, input.workspaceId, 'knowledge.manage');
        return tryKnowledge(deps, actor, input);
      },
    );
  });
}
