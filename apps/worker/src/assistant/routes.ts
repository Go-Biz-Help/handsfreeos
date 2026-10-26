import { randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import { eq } from 'drizzle-orm';
import {
  ADDON_SERVER_MODULES,
  addonAiToolByName,
  AssistantAskInput,
  AssistantDecisionInput,
  AssistantWarmInput,
  assistantConsentOf,
  assistantToolByName,
  HfosError,
  type AddonServerModule,
  type AssistantEvent,
  type Catalog,
  type HumanActor,
} from '@hfos/core/server';
import { asUser } from '@hfos/db/client';
import { users } from '@hfos/db/schema';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticate, parseBody, requirePermission, type HttpDeps } from '../http/common';
import { openStream } from '../http/sse';
import { ADDON_WORKER_MODULES } from '../addons/modules';
import type { AddonWorkerModule } from '../addons/types';
import { personQuery, questionContext } from './context';
import { ask, warmUp, type ToolContext, type ToolExecutor } from './runtime';
import { addonActionToolByName } from './tools-addons';
import * as store from './store';
import type { AiProvider } from '@hfos/ai';

/** What the worker needs to answer: a model, the tools' hands, and the daily token budget per workspace. */
export interface AssistantServices {
  readonly provider: AiProvider;
  readonly tools: ToolExecutor;
  readonly dailyTokens: number;
  /** The add-ons whose operations can be tools (default: every one HandsFreeOS ships; tests bring their own). */
  readonly addons?: readonly AddonServerModule[];
  /** The add-on catalogue the model's directory is written from (default: HandsFreeOS's). */
  readonly addonCatalog?: Catalog;
  /** The add-ons' worker halves, whose actions can be tools (default: every one HandsFreeOS ships). */
  readonly workerAddons?: readonly AddonWorkerModule[];
}

/**
 * The person's OK to send what they ask about to an AI service (assistant.consent), read as them. Without it the
 * question isn't asked: a refusal the panels answer with the consent step (disposition "ask").
 */
async function assertConsented(deps: HttpDeps, actor: HumanActor): Promise<void> {
  const consent = await consentOf(deps, actor);
  if (consent.needed)
    throw new HfosError(
      'rule_violation',
      409,
      'The Assistant sends what you ask about to an AI service to answer you. Say OK once, on the web or your phone, and it won’t ask again.',
      { version: consent.version, command: 'assistant.consent' },
      'assistant_consent_required',
    );
}

async function consentOf(deps: HttpDeps, actor: HumanActor) {
  const [me] = await asUser(deps.httpDb, actor.claims, (tx) =>
    tx.select({ settings: users.settings }).from(users).where(eq(users.id, actor.userId)),
  );
  return assistantConsentOf(me?.settings);
}

/**
 * When each person last had the AI read ahead, on this machine: once in four minutes is enough, since the
 * provider keeps what it read for five.
 */
const warmed = new Map<string, number>();
const WARM_EVERY_MS = 4 * 60_000;
/** Warm-ups one address may ask for a minute: it spends AI, like the worker's other AI routes. */
export const WARMS_PER_MINUTE = 12;

/** Runs in progress on this machine, so Stop can reach them. */
const running = new Map<string, { readonly userId: string; readonly stop: AbortController }>();

export function registerAssistantRoutes(
  app: FastifyInstance,
  deps: HttpDeps,
  assistant: AssistantServices | null,
): void {
  const notConfigured = () =>
    HfosError.rule(
      'assistant_not_configured',
      503,
      'The Assistant hasn’t been set up for HandsFreeOS yet, so it can’t answer. Everything else works as usual.',
    );

  app.post('/v1/assistant/messages', async (req, reply) => {
    const receivedAt = Date.now();
    const actor = await authenticate(deps, req);
    const input = parseBody(AssistantAskInput, req.body);
    await requirePermission(deps, actor.userId, input.workspaceId, 'assistant.use');
    if (!assistant) throw notConfigured();
    await assertConsented(deps, actor);
    const context = await questionContext(
      deps.httpDb,
      actor,
      input.workspaceId,
      input.page,
      randomUUID(),
      new Date(),
      {
        modules: assistant.addons,
        catalog: assistant.addonCatalog,
        workerModules: assistant.workerAddons,
      },
    );
    const prompt = input.spoken ? { ...context.prompt, spoken: true } : context.prompt;
    const stream = openStream<AssistantEvent>(reply);
    const stop = new AbortController();
    let runId: string | null = null;
    try {
      // The run finishes and saves even if the browser goes away; only Stop ends it early.
      await ask(
        {
          db: deps.httpDb,
          provider: assistant.provider,
          tools: assistant.tools,
          dailyTokens: assistant.dailyTokens,
          log: deps.log,
        },
        {
          actor,
          workspaceId: input.workspaceId,
          organizationId: context.organizationId,
          ...(input.threadId ? { threadId: input.threadId } : {}),
          text: input.text,
          page: input.page,
          tools: context.tools,
          prompt,
          receivedAt,
        },
        (event) => {
          if (event.type === 'run') {
            runId = event.runId;
            running.set(event.runId, { userId: actor.userId, stop });
          }
          stream.send(event);
        },
        stop.signal,
      );
    } catch (e) {
      const busyElsewhere = e instanceof HfosError && e.rule === 'already_running';
      if (!busyElsewhere && !(e instanceof HfosError))
        deps.log.error({ err: e }, 'assistant question failed');
      stream.send({
        type: 'error',
        code: busyElsewhere ? 'already_running' : 'failed',
        message:
          e instanceof HfosError
            ? e.message
            : 'Something went wrong on our side. Try again in a minute.',
      });
    } finally {
      if (runId) running.delete(runId);
      stream.end();
    }
  });

  /**
   * The panel opened: while the person types, the AI reads the instructions, their tools and the business ahead of
   * the question, so the answer starts sooner (runtime.ts, warmUp). Best effort and quiet: without their OK to use
   * the AI service, or within four minutes of the last one, nothing is sent; anything that goes wrong is only logged.
   * It spends AI, so each address is held to WARMS_PER_MINUTE, on top of the four minutes per person.
   */
  void app.register(async (scoped) => {
    await scoped.register(rateLimit, {
      global: false,
      errorResponseBuilder: () =>
        new HfosError(
          'rule_violation',
          429,
          'That’s a lot of requests in a row. Wait a minute and try again.',
          undefined,
          'rate_limited',
        ),
    });
    scoped.post(
      '/v1/assistant/warm',
      { config: { rateLimit: { max: WARMS_PER_MINUTE, timeWindow: 60_000 } } },
      (req) => warmRoute(req),
    );
  });

  async function warmRoute(req: FastifyRequest) {
    const actor = await authenticate(deps, req);
    const input = parseBody(AssistantWarmInput, req.body);
    await requirePermission(deps, actor.userId, input.workspaceId, 'assistant.use');
    if (!assistant?.provider.warm) return { warmed: false };
    const key = `${input.workspaceId}:${actor.userId}`;
    const now = Date.now();
    if (now - (warmed.get(key) ?? 0) < WARM_EVERY_MS) return { warmed: false };
    if ((await consentOf(deps, actor)).needed) return { warmed: false };
    warmed.set(key, now);
    for (const [k, at] of warmed) if (now - at >= WARM_EVERY_MS) warmed.delete(k);
    try {
      const context = await questionContext(
        deps.httpDb,
        actor,
        input.workspaceId,
        null,
        randomUUID(),
        new Date(),
        {
          modules: assistant.addons,
          catalog: assistant.addonCatalog,
          workerModules: assistant.workerAddons,
        },
      );
      const done = await warmUp(
        { db: deps.httpDb, provider: assistant.provider, dailyTokens: assistant.dailyTokens },
        {
          userId: actor.userId,
          workspaceId: input.workspaceId,
          organizationId: context.organizationId,
          tools: context.tools,
          prompt: context.prompt,
        },
      );
      return { warmed: done };
    } catch (e) {
      warmed.delete(key);
      deps.log.warn({ err: e }, 'assistant warm-up failed');
      return { warmed: false };
    }
  }

  app.post<{ Params: { id: string } }>('/v1/assistant/runs/:id/stop', async (req) => {
    const actor = await authenticate(deps, req);
    const run = running.get(req.params.id);
    if (run && run.userId === actor.userId) run.stop.abort();
    return { stopping: !!run && run.userId === actor.userId };
  });

  /** The card's tool call, if it is this person's; their permission is checked on the way in. */
  async function ownCall(req: FastifyRequest<{ Params: { id: string } }>) {
    const actor = await authenticate(deps, req);
    const input = parseBody(AssistantDecisionInput, req.body);
    await requirePermission(deps, actor.userId, input.workspaceId, 'assistant.use');
    if (!assistant) throw notConfigured();
    const scope = { workspaceId: input.workspaceId, organizationId: '' };
    const call = await store.getToolCall(deps.httpDb, scope, req.params.id);
    // An add-on's card is confirmed with its tool whether or not the add-on still runs: the kernel checks that, and
    // the permission, when it runs, and a card for an add-on turned off since says so.
    const tool = call
      ? (assistantToolByName.get(call.tool) ??
        addonAiToolByName(assistant.addons ?? ADDON_SERVER_MODULES, call.tool) ??
        addonActionToolByName(assistant.workerAddons ?? ADDON_WORKER_MODULES, call.tool))
      : undefined;
    if (!call || call.user_id !== actor.userId || !tool)
      throw HfosError.notFound(
        'That card isn’t there anymore. Ask the Assistant again for a fresh one.',
      );
    const ctx = await toolContext(actor, input.workspaceId);
    return { actor, input, scope, call, tool, ctx, executor: assistant.tools };
  }

  async function toolContext(actor: HumanActor, workspaceId: string): Promise<ToolContext> {
    const correlationId = randomUUID();
    const { workspace } = await personQuery<{
      workspace: { timezone: string; organizationId: string };
    }>(deps.httpDb, 'workspace.get', { workspaceId }, actor, correlationId);
    return {
      actor,
      workspaceId,
      organizationId: workspace.organizationId,
      correlationId,
      timezone: workspace.timezone,
    };
  }

  const out = (
    id: string,
    tool: string,
    status: string,
    outcome: string | null,
    href: string | null,
    error: string | null,
    undone = false,
  ) => ({
    id,
    tool,
    status,
    outcome,
    href,
    error,
    undone,
  });

  app.post<{ Params: { id: string } }>('/v1/assistant/tool-calls/:id/confirm', async (req) => {
    const { input, scope, call, tool, ctx, executor } = await ownCall(req);
    if (!(await store.claimToolCall(deps.httpDb, scope, call.id, 'confirmed')))
      throw HfosError.conflict(
        'This card was already answered, or it expired. Ask again for a fresh one.',
        'already_answered',
      );
    try {
      const done = await executor.commit(tool, call.arguments, ctx, {
        toolCallId: call.id,
        ...(input.lostReason ? { lostReason: input.lostReason } : {}),
      });
      await store.updateToolCall(deps.httpDb, scope, call.id, {
        status: 'confirmed',
        result: { outcome: done.outcome, href: done.href, command: done.command },
      });
      return out(call.id, call.tool, 'confirmed', done.outcome, done.href, null);
    } catch (e) {
      const message =
        e instanceof HfosError
          ? e.message
          : 'Something went wrong on our side, so nothing was changed. Try again in a minute.';
      if (!(e instanceof HfosError))
        deps.log.error({ err: e, toolCallId: call.id }, 'assistant confirm failed');
      await store.updateToolCall(deps.httpDb, scope, call.id, { status: 'failed', error: message });
      return out(call.id, call.tool, 'failed', null, null, message);
    }
  });

  app.post<{ Params: { id: string } }>('/v1/assistant/tool-calls/:id/cancel', async (req) => {
    const { scope, call } = await ownCall(req);
    if (!(await store.claimToolCall(deps.httpDb, scope, call.id, 'cancelled')))
      throw HfosError.conflict(
        'This card was already answered, or it expired, so there’s nothing to cancel.',
        'already_answered',
      );
    return out(call.id, call.tool, 'cancelled', null, null, null);
  });

  // Tasks and notes the Assistant added on its own can be taken back.
  app.post<{ Params: { id: string } }>('/v1/assistant/tool-calls/:id/undo', async (req) => {
    const { scope, call, tool, ctx, executor } = await ownCall(req);
    const record = call.result ?? {};
    if (call.status !== 'done' || call.autonomy !== 'auto' || record['undone'])
      throw HfosError.conflict(
        record['undone']
          ? 'This was already undone.'
          : call.autonomy !== 'auto'
            ? 'Only what the Assistant did on its own can be undone here. Change this one from its own page instead.'
            : 'This didn’t go through, so there’s nothing to undo.',
        'nothing_to_undo',
      );
    const outcome = await executor.undo(tool, record, ctx);
    await store.updateToolCall(deps.httpDb, scope, call.id, {
      status: 'done',
      result: { ...record, undone: true, outcome },
    });
    return out(call.id, call.tool, 'done', outcome, null, null, true);
  });
}
