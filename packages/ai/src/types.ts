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
    }
  /** A picture the model looks at (M18: a customer's photo), as base64 bytes. */
  | {
      readonly type: 'image';
      readonly mediaType: AiImageType;
      readonly data: string;
    }
  /**
   * A block only the provider understands, from an earlier turn of the same tool loop, exactly as it sent it:
   * the model's reasoning, or a tool search it ran. Nothing here reads or shows it. It goes back unchanged on the
   * next call, because newer Claude models tie reasoning to the conversation, and the tools a search found stay
   * found only while the search is in the history.
   */
  | { readonly type: 'passthrough'; readonly block: Readonly<Record<string, unknown>> };

/** The image types models take. */
export const AI_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
export type AiImageType = (typeof AI_IMAGE_TYPES)[number];
/** The largest image a model takes, before base64. */
export const AI_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** Roughly what a picture costs a model, for stand-ins that guess token counts. */
export const AI_IMAGE_TOKENS = 1600;

/** The messages' length in characters for a guessed token count, a picture counted as its tokens, not its bytes. */
export function messagesLength(messages: readonly AiMessage[]): number {
  let images = 0;
  const text = JSON.stringify(messages, (key, value: unknown) => {
    if (value && typeof value === 'object' && (value as { type?: unknown }).type === 'image') {
      images++;
      return { type: 'image' };
    }
    return value;
  });
  return text.length + images * AI_IMAGE_TOKENS * 4;
}

export interface AiMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string | readonly AiContent[];
}

export interface AiToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** The provider holds the call's input to the schema exactly (strict tool use); the schema must allow it. */
  readonly strict?: boolean;
  /**
   * The call's input streams as the model writes it (`onToolInput`), instead of arriving whole once it's done. The
   * provider then no longer checks it against the schema, so whoever runs the tool must.
   */
  readonly streamInput?: boolean;
  /**
   * Loaded only when the model searches for it (a provider with `toolSearch`); elsewhere it is an ordinary tool.
   * The model sees these tools' names and descriptions only through its search.
   */
  readonly deferred?: boolean;
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

/** `pause_turn`: the provider paused a long turn of its own tools; sending the turn back lets it carry on. */
export type AiStopReason =
  'end_turn' | 'tool_use' | 'pause_turn' | 'max_tokens' | 'refusal' | 'other';

export interface AiTurn {
  readonly text: string;
  readonly toolCalls: readonly AiToolCall[];
  /**
   * The whole turn in the model's order, reasoning included: what a tool loop hands back before the tools'
   * results. Stand-ins that don't reason leave it out.
   */
  readonly content?: readonly AiContent[];
  readonly stopReason: AiStopReason;
  readonly usage: AiUsage;
}

/** A tool call as the model writes it. */
export interface AiToolInput {
  readonly id: string;
  readonly name: string;
  /** The input's JSON so far: whole only once `done`. */
  readonly json: string;
  readonly done: boolean;
}

export interface AiStreamOptions {
  /** Called with each new piece of text as it arrives. */
  readonly onText?: (delta: string) => void;
  /**
   * Each tool call as it's written, in the answer's order: when it starts (no JSON yet), as each piece arrives, and
   * when it's done. A tool without `streamInput` may arrive in one piece.
   */
  readonly onToolInput?: (input: AiToolInput) => void;
  readonly signal?: AbortSignal;
}

export interface AiProvider {
  readonly id: string;
  readonly model: string;
  /**
   * It can search tools marked `deferred` and load them when needed, so a request can offer many tools without
   * the model reading every one of them up front. Without it, deferred tools are sent like any other.
   */
  readonly toolSearch?: boolean;
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
