import { randomUUID } from 'node:crypto';
import {
  AssistantAskInput,
  AssistantDecisionInput,
  assistantToolByName,
  HfosError,
  type AssistantEvent,
  type HumanActor,
} from '@hfos/core/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticate, parseBody, requirePermission, type HttpDeps } from '../http/common';
import { openStream } from '../http/sse';
import { personQuery, questionContext } from './context';
import { ask, type ToolContext, type ToolExecutor } from './runtime';
import * as store from './store';
import type { AiProvider } from '@hfos/ai';

/** What the worker needs to answer: a model, the tools' hands, and the daily token budget per workspace. */
export interface AssistantServices {
  readonly provider: AiProvider;
  readonly tools: ToolExecutor;
  readonly dailyTokens: number;
}

/** Runs in progress on this machine, so Stop can reach them. */
const running = new Map<string, { readonly userId: string; readonly stop: AbortController }>();

export function registerAssistantRoutes(
  app: FastifyInstance,
  deps: HttpDeps,
  assistant: AssistantServices | null,
): void {
  const notConfigured = () =>
    HfosError.rule('assistant_not_configured', 503, 'The Assistant isn’t set up yet.');

  app.post('/v1/assistant/messages', async (req, reply) => {
    const actor = await authenticate(deps, req);
    const input = parseBody(AssistantAskInput, req.body);
    await requirePermission(deps, actor.userId, input.workspaceId, 'assistant.use');
    if (!assistant) throw notConfigured();
    const context = await questionContext(
      deps.httpDb,
      actor,
      input.workspaceId,
      input.page,
      randomUUID(),
    );
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
          prompt: context.prompt,
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
        message: e instanceof HfosError ? e.message : 'Something went wrong. Try again.',
      });
    } finally {
      if (runId) running.delete(runId);
      stream.end();
    }
  });

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
    const tool = call ? assistantToolByName.get(call.tool) : undefined;
    if (!call || call.user_id !== actor.userId || !tool)
      throw HfosError.notFound('That card is gone.');
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
      const message = e instanceof HfosError ? e.message : 'That didn’t work. Nothing was changed.';
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
        'This card was already answered, or it expired.',
        'already_answered',
      );
    return out(call.id, call.tool, 'cancelled', null, null, null);
  });

  // Tasks and notes the Assistant added on its own can be taken back.
  app.post<{ Params: { id: string } }>('/v1/assistant/tool-calls/:id/undo', async (req) => {
    const { scope, call, tool, ctx, executor } = await ownCall(req);
    const record = call.result ?? {};
    if (call.status !== 'done' || call.autonomy !== 'auto' || record['undone'])
      throw HfosError.conflict('There is nothing to undo here.', 'nothing_to_undo');
    const outcome = await executor.undo(tool, record, ctx);
    await store.updateToolCall(deps.httpDb, scope, call.id, {
      status: 'done',
      result: { ...record, undone: true, outcome },
    });
    return out(call.id, call.tool, 'done', outcome, null, null, true);
  });
}
