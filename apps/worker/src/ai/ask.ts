import {
  AiOutputError,
  AiProviderError,
  parseStructured,
  type AiMessage,
  type AiTurn,
  type AiUsage,
} from '@hfos/ai';
import type { z } from 'zod';
import type { TenantScope, WorkerServices } from '../services';
import { asWorker } from '@hfos/db/client';
import { walletRoom, WALLET_REFUSALS } from '@hfos/core/server';
import { aiBudget, recordAndChargeAi, type AiUsageRef } from './budget';

export type AiAskErrorCode =
  | 'budget_reached'
  /** The usage balance has run out. Beside `budget_reached`: same shape, different limit. */
  | 'wallet_empty'
  | 'ai_unavailable'
  | 'provider_error'
  | 'bad_output';

/**
 * Why askStructured has no answer, in words callers act on: a workflow step falls back, Try it answers 429
 * or 503, a website scan stops, and a retryable provider error can be tried again later.
 */
export class AiAskError extends Error {
  constructor(
    readonly code: AiAskErrorCode,
    message: string,
    readonly retryable = false,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AiAskError';
  }
}

/** The Assistant's wording, for everything else that uses the AI. */
export const AI_BUDGET_MESSAGE =
  'That’s today’s AI limit for this business. It resets at midnight.';
export const AI_UNAVAILABLE_MESSAGE = 'The AI isn’t set up yet.';
export const AI_BUSY_MESSAGE = 'The AI is busy right now. Try again in a minute.';

export interface AskStructuredInput<S extends z.ZodType> {
  /** Fixed instructions (cached by the provider). */
  readonly system: string;
  /** What changes per call: the business brief, the knowledge offered. */
  readonly context?: string;
  readonly messages: readonly AiMessage[];
  /** The answer's JSON Schema, sent to the provider. */
  readonly schema: Record<string, unknown>;
  /** The same shape in zod: the answer is checked against it, limits the provider can't enforce included. */
  readonly zod: S;
  readonly maxTokens?: number;
  /** Where the tokens are counted (app.ai_usage). */
  readonly usage: AiUsageRef;
  readonly signal?: AbortSignal;
}

export interface AskStructuredResult<T> {
  readonly value: T;
  /** What the call cost, for logs such as a workflow step's. */
  readonly usage: AiUsage;
  readonly model: string;
}

/**
 * One structured AI call inside the workspace's daily limit: checks the budget, asks the provider for JSON
 * in `schema`, records the tokens in app.ai_usage (even when the answer turns out unusable), and returns the
 * answer parsed with `zod`. Throws AiAskError: `ai_unavailable`, `budget_reached`, `provider_error`
 * (`retryable` or not) or `bad_output`.
 */
export async function askStructured<S extends z.ZodType>(
  ctx: Pick<WorkerServices, 'db' | 'ai' | 'log' | 'wallet'>,
  scope: TenantScope,
  input: AskStructuredInput<S>,
): Promise<AskStructuredResult<z.output<S>>> {
  const provider = ctx.ai.provider;
  if (!provider) throw new AiAskError('ai_unavailable', AI_UNAVAILABLE_MESSAGE);
  if ((await aiBudget.usedToday(ctx.db, scope)) >= ctx.ai.dailyTokens)
    throw new AiAskError('budget_reached', AI_BUDGET_MESSAGE);
  // Beside the daily token limit, and for the same reason: both are a business's spending running out, and
  // both stop before the provider is asked rather than after the tokens are gone.
  const room = await asWorker(ctx.db, scope, (tx) =>
    walletRoom(tx, scope.workspaceId, 'ai', (m, e) => ctx.log.error({ err: e }, m)),
  );
  if (!room.allowed) throw new AiAskError('wallet_empty', WALLET_REFUSALS.ai);
  let turn: AiTurn;
  try {
    turn = await provider.stream(
      {
        system: input.system,
        ...(input.context ? { context: input.context } : {}),
        messages: input.messages,
        maxTokens: input.maxTokens ?? 2048,
        responseFormat: { schema: input.schema },
      },
      input.signal ? { signal: input.signal } : {},
    );
  } catch (e) {
    const known = e instanceof AiProviderError ? e : null;
    ctx.log.warn({ err: e, source: input.usage.source }, 'AI call failed');
    throw new AiAskError(
      'provider_error',
      known?.code === 'aborted'
        ? 'Stopped.'
        : known?.retryable
          ? AI_BUSY_MESSAGE
          : 'The AI couldn’t answer.',
      known?.retryable ?? false,
      { cause: e },
    );
  }
  // The tokens were spent whether or not the answer is usable.
  await recordAndChargeAi(ctx, scope, {
    ...input.usage,
    model: provider.model,
    usage: turn.usage,
  });
  try {
    return { value: parseStructured(turn, input.zod), usage: turn.usage, model: provider.model };
  } catch (e) {
    if (!(e instanceof AiOutputError)) throw e;
    ctx.log.warn(
      { source: input.usage.source, issues: e.issues.slice(0, 5), stopReason: turn.stopReason },
      'AI answer had the wrong shape',
    );
    throw new AiAskError(
      'bad_output',
      'The AI’s answer didn’t come back in the expected shape.',
      false,
      { cause: e },
    );
  }
}
