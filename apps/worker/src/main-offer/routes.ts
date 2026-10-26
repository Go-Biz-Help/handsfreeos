/**
 * The AI's help with the business's main offer (docs/main-offer.md), from its builder: the niche finder, Improve and
 * Write it for me on a part, the score, and a try of the whole offer
 * (HANDSFREEOS_MAIN_OFFER_TRIES_IMPLEMENTATION_PLAN.md). Core holds what the model is asked and checks what it
 * answers (packages/core/src/main-offer/assist.ts); here each route checks the person may build the offer and that an
 * add-on that uses it is on, asks with the owner's direction when there is one, and answers. Only the score and a
 * try are kept, through the worker's own `main_offer.score_save` and `main_offer.try_save`, for the draft they read.
 * The tokens count as `main_offer` usage for the person asking, against the daily AI limit.
 *
 * POST /v1/main-offer/niche {workspaceId, parts} → {options: [{work, slice, problem, why}]}
 * POST /v1/main-offer/assist {workspaceId, path, mode, parts} → {options, steps}
 * POST /v1/main-offer/score {workspaceId, revision} → {saved, score}
 * POST /v1/main-offer/try {workspaceId, revision, notes, keep} → {saved, try}
 * 403 without main_offer.manage; 409 `main_offer_not_in_use`, `main_offer_no_draft` or `main_offer_draft_moved`;
 * 422 `main_offer_no_proof`, `main_offer_all_kept` or `main_offer_try_unchanged`; 429 `budget_reached` or
 * `rate_limited`; 402 `wallet_empty`; 503 `ai_not_configured` or `ai_busy`; 502 `ai_failed`.
 */
import { randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import {
  briefFromProfile,
  checkedOfferAssist,
  checkedOfferNiche,
  checkedOfferScore,
  checkedOfferTry,
  executeCommand,
  executeQuery,
  HfosError,
  industryLabel,
  mainOfferGet,
  mainOfferScoreSave,
  mainOfferTryList,
  mainOfferTrySave,
  OFFER_ASSIST_SCHEMA,
  OFFER_ASSIST_SYSTEM,
  OFFER_NICHE_SCHEMA,
  OFFER_NICHE_SYSTEM,
  OFFER_SCORE_SCHEMA,
  OFFER_SCORE_SYSTEM,
  OFFER_TRY_SCHEMA,
  OFFER_TRY_SYSTEM,
  OfferAssistAnswer,
  OfferAssistInput,
  offerAssistPrompt,
  offerAssistRefusal,
  OfferNicheAnswer,
  OfferNicheInput,
  offerNichePrompt,
  OfferScoreAnswer,
  offerScorePrompt,
  OfferTryAnswer,
  OfferTryInput,
  offerTryPrompt,
  offerTryRefusal,
  workspaceGet,
  type HumanActor,
  type MainOfferGetOutput,
  type MainOfferParts,
  type MainOfferScore,
  type MainOfferTryOut,
  type OfferAssistOutput,
  type OfferBusiness,
  type OfferNicheOption,
  type OfferTryOutput,
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
const TryBody = OfferTryInput.extend({ workspaceId, revision: z.int().min(0) });

const FAILED = 'The AI couldn’t help with that just now. Try again, or write it yourself.';

function aiError(e: unknown): unknown {
  if (!(e instanceof AiAskError)) return e;
  switch (e.code) {
    case 'ai_unavailable':
      return HfosError.rule('ai_not_configured', 503, AI_UNAVAILABLE_MESSAGE);
    case 'budget_reached':
      // The business's own limit, with its amount, in the words the check that reached it wrote.
      return HfosError.rule('budget_reached', 429, e.message || AI_BUDGET_MESSAGE);
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

/** What the AI's help needs: the database, the model, and the wallet and log its asks are counted against. */
export type MainOfferDeps = Pick<HttpDeps, 'httpDb' | 'ai' | 'log' | 'wallet'>;

function noDraft(message: string): HfosError {
  return HfosError.rule('main_offer_no_draft', 409, message);
}

function draftMoved(what: string): HfosError {
  return HfosError.conflict(
    `Someone changed your offer’s draft in the meantime. Reload to see their changes, then ${what} again.`,
    'main_offer_draft_moved',
  );
}

/**
 * Who's asking may build the offer, an add-on that uses it is on, and what the model is told about the business:
 * its name, line of work and profile brief.
 */
async function preparing(
  deps: MainOfferDeps,
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

const services = (deps: MainOfferDeps) => ({
  db: deps.httpDb,
  ai: deps.ai,
  log: deps.log,
  wallet: deps.wallet,
});

export async function offerNiche(
  deps: MainOfferDeps,
  actor: HumanActor,
  input: z.output<typeof NicheBody>,
): Promise<{ options: OfferNicheOption[] }> {
  const { scope, business, offer } = await preparing(deps, actor, input.workspaceId);
  try {
    const { value } = await askStructured(services(deps), scope, {
      system: OFFER_NICHE_SYSTEM,
      messages: [
        { role: 'user', content: offerNichePrompt(business, input.parts, offer.direction) },
      ],
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
  deps: MainOfferDeps,
  actor: HumanActor,
  input: z.output<typeof AssistBody>,
): Promise<OfferAssistOutput> {
  const refused = offerAssistRefusal(input);
  if (refused) throw HfosError.rule('main_offer_no_proof', 422, refused);
  const { scope, business, offer } = await preparing(deps, actor, input.workspaceId);
  try {
    const { value } = await askStructured(services(deps), scope, {
      system: OFFER_ASSIST_SYSTEM,
      messages: [{ role: 'user', content: offerAssistPrompt(business, input, offer.direction) }],
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

/** The AI's score of an offer, with the owner's direction when there is one. */
async function scored(
  deps: MainOfferDeps,
  actor: HumanActor,
  scope: TenantScope,
  business: OfferBusiness,
  parts: MainOfferParts,
  direction: string | null,
): Promise<MainOfferScore> {
  try {
    const { value } = await askStructured(services(deps), scope, {
      system: OFFER_SCORE_SYSTEM,
      messages: [{ role: 'user', content: offerScorePrompt(business, parts, direction) }],
      schema: OFFER_SCORE_SCHEMA,
      zod: OfferScoreAnswer,
      maxTokens: 3000,
      usage: { source: 'main_offer', userId: actor.userId },
    });
    return checkedOfferScore(value, { direction: !!direction });
  } catch (e) {
    throw aiError(e);
  }
}

/** Scores the draft as it's kept (never what the screen sends), and keeps the score for that revision. */
export async function offerScore(
  deps: MainOfferDeps,
  actor: HumanActor,
  input: z.output<typeof ScoreBody>,
): Promise<{ saved: boolean; score: MainOfferScore }> {
  const { scope, business, offer } = await preparing(deps, actor, input.workspaceId);
  if (!offer.draft)
    throw noDraft(
      'There’s nothing new to score. Change a part of your offer first, then score it.',
    );
  if (offer.revision !== input.revision) throw draftMoved('score it');
  const score = await scored(deps, actor, scope, business, offer.draft.parts, offer.direction);
  const { output } = await executeCommand(
    deps.httpDb,
    mainOfferScoreSave,
    { workspaceId: input.workspaceId, revision: input.revision, score },
    systemActor(scope, actor.userId),
    workerMeta(),
  );
  return { saved: output.saved, score };
}

/**
 * Writes a try of the whole offer from the draft as it's kept, the owner's direction, their notes and the parts to
 * keep; scores it; and keeps it beside the draft for that revision. Two asks of the model, both counted.
 */
export async function offerTry(
  deps: MainOfferDeps,
  actor: HumanActor,
  input: z.output<typeof TryBody>,
): Promise<{ saved: boolean; try: MainOfferTryOut | null }> {
  const refused = offerTryRefusal(input);
  if (refused) throw HfosError.rule('main_offer_all_kept', 422, refused);
  const { scope, business, offer } = await preparing(deps, actor, input.workspaceId);
  if (!offer.draft)
    throw noDraft(
      'There’s no draft to write a try from. Change a part of your offer first, then make a try.',
    );
  if (offer.revision !== input.revision) throw draftMoved('make the try');
  const draft = offer.draft.parts;
  let written: OfferTryOutput;
  try {
    const { value } = await askStructured(services(deps), scope, {
      system: OFFER_TRY_SYSTEM,
      messages: [
        { role: 'user', content: offerTryPrompt(business, draft, input, offer.direction) },
      ],
      schema: OFFER_TRY_SCHEMA,
      zod: OfferTryAnswer,
      maxTokens: 5000,
      usage: { source: 'main_offer', userId: actor.userId },
    });
    written = checkedOfferTry(value, draft, input.keep);
  } catch (e) {
    throw aiError(e);
  }
  if (!written.changed.length)
    throw HfosError.rule(
      'main_offer_try_unchanged',
      422,
      'The AI left every part as it was this time. Add a note on what you’d like changed, or try again.',
    );
  const score = await scored(deps, actor, scope, business, written.parts, offer.direction);
  const { output } = await executeCommand(
    deps.httpDb,
    mainOfferTrySave,
    {
      workspaceId: input.workspaceId,
      revision: input.revision,
      parts: written.parts,
      why: written.why,
      score,
      notes: input.notes,
      keep: input.keep,
    },
    systemActor(scope, actor.userId),
    workerMeta(),
  );
  if (!output.saved) return { saved: false, try: null };
  const { tries } = await executeQuery(
    deps.httpDb,
    mainOfferTryList,
    { workspaceId: input.workspaceId },
    actor,
    meta(),
  );
  return { saved: true, try: tries.find((t) => t.id === output.id) ?? null };
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
    scoped.post('/v1/main-offer/try', limited, async (req) => {
      const actor = await authenticate(deps, req);
      return offerTry(deps, actor, parseBody(TryBody, req.body));
    });
  });
}
