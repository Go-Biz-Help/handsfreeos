/**
 * The AI's help with the business's main offer (docs/main-offer.md), from its builder: the niche finder, Improve and
 * Write it for me on a part, and the score. Core holds what the model is asked and checks what it answers
 * (packages/core/src/main-offer/assist.ts); here each route checks the person may build the offer and that an add-on
 * that uses it is on, asks, and answers. Only the score is kept, through the worker's own `main_offer.score_save`, for
 * the draft it read. The tokens count as `main_offer` usage for the person asking, against the daily AI limit.
 *
 * POST /v1/main-offer/niche {workspaceId, parts} → {options: [{work, slice, problem, why}]}
 * POST /v1/main-offer/assist {workspaceId, path, mode, parts} → {options, steps}
 * POST /v1/main-offer/score {workspaceId, revision} → {saved, score}
 * 403 without main_offer.manage; 409 `main_offer_not_in_use`, `main_offer_no_draft` or `main_offer_draft_moved`;
 * 429 `budget_reached` or `rate_limited`; 402 `wallet_empty`; 503 `ai_not_configured` or `ai_busy`; 502 `ai_failed`.
 */
import { randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import {
  briefFromProfile,
  checkedOfferAssist,
  checkedOfferNiche,
  checkedOfferScore,
  executeCommand,
  executeQuery,
  HfosError,
  industryLabel,
  mainOfferGet,
  mainOfferScoreSave,
  OFFER_ASSIST_SCHEMA,
  OFFER_ASSIST_SYSTEM,
  OFFER_NICHE_SCHEMA,
  OFFER_NICHE_SYSTEM,
  OFFER_SCORE_SCHEMA,
  OFFER_SCORE_SYSTEM,
  OfferAssistAnswer,
  OfferAssistInput,
  offerAssistPrompt,
  offerAssistRefusal,
  OfferNicheAnswer,
  OfferNicheInput,
  offerNichePrompt,
  OfferScoreAnswer,
  offerScorePrompt,
  workspaceGet,
  type HumanActor,
  type MainOfferGetOutput,
  type MainOfferScore,
  type OfferAssistOutput,
  type OfferBusiness,
  type OfferNicheOption,
} from '@hfos/core/server';
import { asWorker } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AI_BUDGET_MESSAGE,
  AI_BUSY_MESSAGE,
  AI_UNAVAILABLE_MESSAGE,
  AiAskError,
  askStructured,
} from '../ai/ask';
import { authenticate, parseBody, requirePermission, type HttpDeps } from '../http/common';
import { loadGrounding } from '../knowledge/grounding';
import { systemActor, workerMeta } from '../services';
import type { TenantScope } from '../services';

/** Asks one address may make a minute. The daily AI limit applies on top. */
export const MAIN_OFFER_PER_MINUTE = 20;

const workspaceId = z.uuid();
const NicheBody = OfferNicheInput.extend({ workspaceId });
const AssistBody = OfferAssistInput.extend({ workspaceId });
const ScoreBody = z.object({ workspaceId, revision: z.int().min(0) });

const FAILED = 'The AI couldn’t help with that just now. Try again, or write it yourself.';

function aiError(e: unknown): unknown {
  if (!(e instanceof AiAskError)) return e;
  switch (e.code) {
    case 'ai_unavailable':
      return HfosError.rule('ai_not_configured', 503, AI_UNAVAILABLE_MESSAGE);
    case 'budget_reached':
      return HfosError.rule('budget_reached', 429, AI_BUDGET_MESSAGE);
    case 'wallet_empty':
      return HfosError.rule('wallet_empty', 402, e.message);
    case 'provider_error':
      return e.retryable
        ? HfosError.rule('ai_busy', 503, AI_BUSY_MESSAGE)
        : HfosError.rule('ai_failed', 502, FAILED);
    case 'bad_output':
      return HfosError.rule('ai_failed', 502, FAILED);
  }
}

const meta = () => ({ correlationId: randomUUID(), channel: 'web' as const });

/**
 * Who's asking may build the offer, an add-on that uses it is on, and what the model is told about the business:
 * its name, line of work and profile brief.
 */
async function preparing(
  deps: HttpDeps,
  actor: HumanActor,
  id: string,
): Promise<{ scope: TenantScope; business: OfferBusiness; offer: MainOfferGetOutput }> {
  await requirePermission(deps, actor.userId, id, 'main_offer.manage');
  if (!deps.ai.provider) throw HfosError.rule('ai_not_configured', 503, AI_UNAVAILABLE_MESSAGE);
  const [{ workspace }, offer] = await Promise.all([
    executeQuery(deps.httpDb, workspaceGet, { workspaceId: id }, actor, meta()),
    executeQuery(deps.httpDb, mainOfferGet, { workspaceId: id }, actor, meta()),
  ]);
  if (!offer.inUse)
    throw HfosError.rule(
      'main_offer_not_in_use',
      409,
      `Your main offer comes with ${offer.comesWith.join(' or ') || 'an add-on'}, which isn’t on in this business. An owner or admin can turn it on in Settings → Add-ons.`,
    );
  const scope = { workspaceId: id, organizationId: workspace.organizationId };
  const grounding = await asWorker(deps.httpDb, scope, (tx) => loadGrounding(tx, id));
  return {
    scope,
    offer,
    business: {
      name: workspace.name,
      lineOfWork: workspace.industry ? industryLabel(workspace.industry) : null,
      brief: briefFromProfile(grounding.profile, grounding.business),
    },
  };
}

const services = (deps: HttpDeps) => ({
  db: deps.httpDb,
  ai: deps.ai,
  log: deps.log,
  wallet: deps.wallet,
});

export async function offerNiche(
  deps: HttpDeps,
  actor: HumanActor,
  input: z.output<typeof NicheBody>,
): Promise<{ options: OfferNicheOption[] }> {
  const { scope, business } = await preparing(deps, actor, input.workspaceId);
  try {
    const { value } = await askStructured(services(deps), scope, {
      system: OFFER_NICHE_SYSTEM,
      messages: [{ role: 'user', content: offerNichePrompt(business, input.parts) }],
      schema: OFFER_NICHE_SCHEMA,
      zod: OfferNicheAnswer,
      maxTokens: 1200,
      usage: { source: 'main_offer', userId: actor.userId },
    });
    return { options: checkedOfferNiche(value) };
  } catch (e) {
    throw aiError(e);
  }
}

export async function offerAssist(
  deps: HttpDeps,
  actor: HumanActor,
  input: z.output<typeof AssistBody>,
): Promise<OfferAssistOutput> {
  const refused = offerAssistRefusal(input);
  if (refused) throw HfosError.rule('main_offer_no_proof', 422, refused);
  const { scope, business } = await preparing(deps, actor, input.workspaceId);
  try {
    const { value } = await askStructured(services(deps), scope, {
      system: OFFER_ASSIST_SYSTEM,
      messages: [{ role: 'user', content: offerAssistPrompt(business, input) }],
      schema: OFFER_ASSIST_SCHEMA,
      zod: OfferAssistAnswer,
      maxTokens: 1500,
      usage: { source: 'main_offer', userId: actor.userId },
    });
    return checkedOfferAssist(value, input);
  } catch (e) {
    throw aiError(e);
  }
}

/** Scores the draft as it's kept (never what the screen sends), and keeps the score for that revision. */
export async function offerScore(
  deps: HttpDeps,
  actor: HumanActor,
  input: z.output<typeof ScoreBody>,
): Promise<{ saved: boolean; score: MainOfferScore }> {
  const { scope, business, offer } = await preparing(deps, actor, input.workspaceId);
  if (!offer.draft)
    throw HfosError.rule(
      'main_offer_no_draft',
      409,
      'There’s nothing new to score. Change a part of your offer first, then score it.',
    );
  if (offer.revision !== input.revision)
    throw HfosError.conflict(
      'Someone changed your offer’s draft in the meantime. Reload to see their changes, then score it again.',
      'main_offer_draft_moved',
    );
  let score: MainOfferScore;
  try {
    const { value } = await askStructured(services(deps), scope, {
      system: OFFER_SCORE_SYSTEM,
      messages: [{ role: 'user', content: offerScorePrompt(business, offer.draft.parts) }],
      schema: OFFER_SCORE_SCHEMA,
      zod: OfferScoreAnswer,
      maxTokens: 1500,
      usage: { source: 'main_offer', userId: actor.userId },
    });
    score = checkedOfferScore(value);
  } catch (e) {
    throw aiError(e);
  }
  const { output } = await executeCommand(
    deps.httpDb,
    mainOfferScoreSave,
    { workspaceId: input.workspaceId, revision: input.revision, score },
    systemActor(scope, actor.userId),
    workerMeta(),
  );
  return { saved: output.saved, score };
}

export async function registerMainOfferRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  await app.register(async (scoped) => {
    await scoped.register(rateLimit, {
      global: false,
      errorResponseBuilder: () =>
        new HfosError(
          'rule_violation',
          429,
          'That’s a lot of asks in a row. Wait a minute and try again.',
          undefined,
          'rate_limited',
        ),
    });
    const limited = { config: { rateLimit: { max: MAIN_OFFER_PER_MINUTE, timeWindow: 60_000 } } };
    scoped.post('/v1/main-offer/niche', limited, async (req) => {
      const actor = await authenticate(deps, req);
      return offerNiche(deps, actor, parseBody(NicheBody, req.body));
    });
    scoped.post('/v1/main-offer/assist', limited, async (req) => {
      const actor = await authenticate(deps, req);
      return offerAssist(deps, actor, parseBody(AssistBody, req.body));
    });
    scoped.post('/v1/main-offer/score', limited, async (req) => {
      const actor = await authenticate(deps, req);
      return offerScore(deps, actor, parseBody(ScoreBody, req.body));
    });
  });
}
