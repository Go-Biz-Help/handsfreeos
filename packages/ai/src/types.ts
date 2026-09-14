/**
 * The swappable AI seam. HandsFreeOS decides what context a model sees, which tools it may call and
 * whether a person has to approve; a provider only supplies intelligence: text, and tool calls to run.
 */

export type AiContent =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'tool_call';
      readonly id: string;
      readonly name: string;
      readonly arguments: Record<string, unknown>;
    }
  | {
      readonly type: 'tool_result';
      readonly callId: string;
      readonly content: string;
      readonly isError?: boolean;
    };

export interface AiMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string | readonly AiContent[];
}

export interface AiToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/**
 * Answer with a JSON object matching this JSON Schema instead of prose (structured output). Keywords a
 * provider can't enforce are passed on as guidance; `parseStructured` checks the answer against zod.
 */
export interface AiResponseFormat {
  readonly schema: Record<string, unknown>;
}

export interface AiRequest {
  /** Instructions that stay the same between questions; providers cache them where they can. */
  readonly system: string;
  /** Instructions that change with every question: the local time, the page the person is on. */
  readonly context?: string;
  readonly messages: readonly AiMessage[];
  readonly tools?: readonly AiToolDefinition[];
  readonly maxTokens?: number;
  /** The answer's text is JSON in this shape (see `parseStructured`). */
  readonly responseFormat?: AiResponseFormat;
}

export interface AiToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export interface AiUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export type AiStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface AiTurn {
  readonly text: string;
  readonly toolCalls: readonly AiToolCall[];
  readonly stopReason: AiStopReason;
  readonly usage: AiUsage;
}

export interface AiStreamOptions {
  /** Called with each new piece of text as it arrives. */
  readonly onText?: (delta: string) => void;
  readonly signal?: AbortSignal;
}

export interface AiProvider {
  readonly id: string;
  readonly model: string;
  stream(request: AiRequest, options?: AiStreamOptions): Promise<AiTurn>;
}

export type AiErrorCode =
  'aborted' | 'rate_limited' | 'overloaded' | 'unavailable' | 'auth' | 'bad_request' | 'other';

/** A provider failure in words the runtime can act on: retry, say "busy", or give up. */
export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly code: AiErrorCode,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

export const emptyUsage: AiUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export function addUsage(a: AiUsage, b: AiUsage): AiUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/** Every token a turn used, cache reads and writes included (what the daily budget counts). */
export function totalTokens(u: AiUsage): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
}
