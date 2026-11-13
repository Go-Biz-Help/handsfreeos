import { randomUUID } from 'node:crypto';
import {
  AiOutputError,
  AiProviderError,
  FallbackProvider,
  parseStructured,
  type AiMessage,
  type AiProvider,
  type AiRequest,
  type AiTurn,
  type AiUsage,
  type AiWebSource,
} from '@hfos/ai';
import type { z } from 'zod';
import type { TenantScope, WorkerServices } from '../services';
import { asWorker } from '@hfos/db/client';
import {
  aiLimitReached,
  aiWebSearchUsageKey,
  walletRoom,
  WALLET_REFUSALS,
} from '@hfos/core/server';
import { chargeUsage } from '../money/wallet';
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

/**
 * The daily AI limit's words where only "it was reached" is known. A check that reached it says the amount
 * (`aiBudget.reached`), and those words travel on the error.
 */
export const AI_BUDGET_MESSAGE = aiLimitReached();
export const AI_UNAVAILABLE_MESSAGE =
  'The AI isn’t set up for HandsFreeOS yet, so this can’t run. HandsFreeOS support can switch it on.';
export const AI_BUSY_MESSAGE = 'The AI is busy right now. Try again in a minute.';

/**
 * Room for the model's thinking, on top of what the answer itself may take. AI_MODEL thinks before it answers
 * (docs/operations.md, "Change the model"), and its thinking counts toward the cap, so a cap sized for the answer
 * alone cuts the answer off, and an answer cut off can't be used. A finished answer costs only what it wrote.
 */
export const THINKING_ROOM = 16_000;

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
  /** The most the answer itself may take; the model gets THINKING_ROOM on top to think in. */
  readonly maxTokens?: number;
  /** Where the tokens are counted (app.ai_usage). */
  readonly usage: AiUsageRef;
  readonly signal?: AbortSignal;
  /**
   * When Claude declines or answers with nothing at all, the backup (OpenAI, behind Claude in `FallbackProvider`)
   * answers the same request once instead (the owner's pick, 13 Nov 2026). For a caller's last try: see `askedTwice`.
   */
  readonly backupWhenDeclined?: boolean;
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
  const reached = await aiBudget.reached(ctx.db, scope);
  if (reached) throw new AiAskError('budget_reached', reached);
  // Beside the daily AI limit, and for the same reason: both are a business's spending running out, and both
  // stop before the provider is asked rather than after the tokens are gone.
  const room = await asWorker(ctx.db, scope, (tx) =>
    walletRoom(tx, scope.workspaceId, 'ai', (m, e) => ctx.log.error({ err: e }, m)),
  );
  if (!room.allowed) throw new AiAskError('wallet_empty', WALLET_REFUSALS.ai);
  const request: AiRequest = {
    system: input.system,
    ...(input.context ? { context: input.context } : {}),
    messages: input.messages,
    maxTokens: (input.maxTokens ?? 2048) + THINKING_ROOM,
    responseFormat: { schema: input.schema },
  };
  const turn = await answerOf(ctx, scope, provider, request, input);
  try {
    return parsedAnswer(turn, provider, input);
  } catch (e) {
    if (!(e instanceof AiOutputError)) throw e;
    unusable(ctx, input, turn, e);
    const backup =
      input.backupWhenDeclined && declined(turn) && provider instanceof FallbackProvider
        ? provider.backupAfterDecline()
        : null;
    if (!backup) throw badOutput(e);
    ctx.log.info({ source: input.usage.source }, 'Claude declined: the backup AI answers');
    const again = await answerOf(ctx, scope, backup, request, input);
    try {
      return parsedAnswer(again, backup, input);
    } catch (e2) {
      if (!(e2 instanceof AiOutputError)) throw e2;
      unusable(ctx, input, again, e2);
      throw badOutput(e2);
    }
  }
}

/** One provider's answer to the request, with its tokens recorded and charged whether or not it's usable. */
async function answerOf(
  ctx: Pick<WorkerServices, 'db' | 'ai' | 'log' | 'wallet'>,
  scope: TenantScope,
  provider: AiProvider,
  request: AiRequest,
  input: Pick<AskStructuredInput<z.ZodType>, 'usage' | 'signal'>,
): Promise<AiTurn> {
  let turn: AiTurn;
  try {
    turn = await provider.stream(request, input.signal ? { signal: input.signal } : {});
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
    model: turn.model ?? provider.model,
    usage: turn.usage,
  });
  return turn;
}

function parsedAnswer<S extends z.ZodType>(
  turn: AiTurn,
  provider: AiProvider,
  input: Pick<AskStructuredInput<S>, 'zod'>,
): AskStructuredResult<z.output<S>> {
  return {
    value: parseStructured(turn, input.zod),
    usage: turn.usage,
    model: turn.model ?? provider.model,
  };
}

/** Whether a turn is Claude declining, or writing nothing at all (0 output tokens, in about a second). */
const declined = (turn: AiTurn): boolean =>
  turn.stopReason === 'refusal' || turn.text.trim() === '';

function unusable(
  ctx: Pick<WorkerServices, 'log'>,
  input: Pick<AskStructuredInput<z.ZodType>, 'usage'>,
  turn: AiTurn,
  e: AiOutputError,
): void {
  ctx.log.warn(
    { source: input.usage.source, issues: e.issues.slice(0, 5), stopReason: turn.stopReason },
    'AI answer had the wrong shape',
  );
}

const badOutput = (e: AiOutputError): AiAskError =>
  new AiAskError('bad_output', 'The AI’s answer didn’t come back in the expected shape.', false, {
    cause: e,
  });

/**
 * A structured ask, asked once more when its answer came back unusable. The AI service sometimes answers with nothing
 * at all, no words written (about 1 call in 25 on 9 Nov 2026, behind the owner's problem reports of "The AI couldn’t
 * write that just now"), and asked again it often writes one. When it doesn't, the second try goes to the backup
 * (`backupWhenDeclined`; the owner's pick, 13 Nov 2026, after 3 drafts in a day and about 8% of profile checks came back
 * empty twice). Social Outreach's drafts and profile checks ask this way.
 */
export async function askedTwice<T>(ask: (last: boolean) => Promise<T>): Promise<T> {
  try {
    return await ask(false);
  } catch (e) {
    if (!(e instanceof AiAskError) || e.code !== 'bad_output') throw e;
    return ask(true);
  }
}

/**
 * What a report says when the AI wasn't asked for one of the extension's helpers (Social Outreach's, AI Social Media
 * Content Creator's): HandsFreeOS's words, then the AI service's own when it refused. Only HandsFreeOS's own Admin
 * reads it, and without the service's reason a report can't say what to fix.
 */
export function notAskedWords(e: AiAskError): string {
  const cause = e.cause instanceof AiProviderError ? e.cause : null;
  if (e.code !== 'provider_error' || e.retryable || !cause || cause.code === 'aborted')
    return e.message;
  const reason = cause.message.replace(/\s+/g, ' ').trim();
  return reason ? `${e.message} The AI service said: ${reason}` : e.message;
}

export interface AskSearchingInput {
  readonly system: string;
  readonly prompt: string;
  /** The most searches in the whole answer, each paid for (`ai.web_search`). */
  readonly searches: number;
  readonly maxTokens: number;
  readonly usage: AiUsageRef;
  /** In words, for the statement line the searches are charged on. */
  readonly subject: string;
}

export interface AskSearchingResult {
  /** The answer's words, each claim marked [n] with its page's place in `pages`. */
  readonly notes: string;
  readonly pages: readonly AiWebSource[];
  readonly searches: number;
}

/**
 * One AI answer that may look things up on the web first (Claude's own search tool), inside the workspace's daily
 * limit and balance as `askStructured` is. A long search turn that pauses goes back as it came, a few times at most.
 * The tokens are recorded and charged as always, and the searches beside them, each as `ai.web_search`. A provider
 * with no web search (the backup) answers from what it knows, with no pages. Throws AiAskError as `askStructured`.
 */
export async function askSearching(
  ctx: Pick<WorkerServices, 'db' | 'ai' | 'log' | 'wallet'>,
  scope: TenantScope,
  input: AskSearchingInput,
  continues = 3,
): Promise<AskSearchingResult> {
  const provider = ctx.ai.provider;
  if (!provider) throw new AiAskError('ai_unavailable', AI_UNAVAILABLE_MESSAGE);
  const reached = await aiBudget.reached(ctx.db, scope);
  if (reached) throw new AiAskError('budget_reached', reached);
  const room = await asWorker(ctx.db, scope, (tx) =>
    walletRoom(tx, scope.workspaceId, 'ai', (m, e) => ctx.log.error({ err: e }, m)),
  );
  if (!room.allowed) throw new AiAskError('wallet_empty', WALLET_REFUSALS.ai);
  const messages: AiMessage[] = [{ role: 'user', content: input.prompt }];
  let notes = '';
  const pages: AiWebSource[] = [];
  let searches = 0;
  for (let round = 0; round <= continues; round++) {
    let turn: AiTurn;
    try {
      turn = await provider.stream({
        system: input.system,
        messages,
        maxTokens: input.maxTokens + THINKING_ROOM,
        webSearch: { maxUses: Math.max(1, input.searches - searches) },
      });
    } catch (e) {
      const known = e instanceof AiProviderError ? e : null;
      ctx.log.warn({ err: e, source: input.usage.source }, 'AI call with web search failed');
      throw new AiAskError(
        'provider_error',
        known?.retryable ? AI_BUSY_MESSAGE : 'The AI couldn’t answer.',
        known?.retryable ?? false,
        { cause: e },
      );
    }
    await recordAndChargeAi(ctx, scope, {
      ...input.usage,
      model: turn.model ?? provider.model,
      usage: turn.usage,
    });
    if (turn.webSearches) {
      searches += turn.webSearches;
      await chargeUsage(ctx.wallet, scope, {
        parts: [{ key: 'ai.web_search', quantity: turn.webSearches }],
        idempotencyKey: aiWebSearchUsageKey(randomUUID()),
        subject: input.subject,
      });
    }
    // Each answer numbers its own pages from 1: renumbered here into one list for the whole answer.
    const here = turn.webSources ?? [];
    const placeOf = (n: number): number => {
      const page = here[n - 1];
      if (!page) return 0;
      const at = pages.findIndex((p) => p.url === page.url);
      if (at >= 0) return at + 1;
      pages.push(page);
      return pages.length;
    };
    notes += (turn.citedText ?? turn.text).replace(/\[(\d+)\]/g, (_, n: string) => {
      const at = placeOf(Number(n));
      return at ? `[${at}]` : '';
    });
    if (turn.stopReason !== 'pause_turn' || !turn.content?.length) break;
    messages.push({ role: 'assistant', content: turn.content });
  }
  return { notes: notes.trim(), pages, searches };
}
