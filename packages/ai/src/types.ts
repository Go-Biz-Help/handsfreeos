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
   * A PDF the model reads, pages and all, as base64 bytes (Real Estate round four: a scanned contract). Put it
   * before the words that ask about it. `pages`, when known, is only for guessing what it costs.
   */
  | {
      readonly type: 'document';
      readonly mediaType: 'application/pdf';
      readonly data: string;
      readonly title?: string;
      readonly pages?: number;
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
/**
 * The largest PDF a model reads, before base64: its base64 stays under the 32 MB a request may be, with room
 * for the words around it.
 */
export const AI_DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;
/** The most pages a model reads in one PDF; the smaller models stop at 100. */
export const AI_DOCUMENT_MAX_PAGES = 100;
/** Roughly what one PDF page costs a model (its words and its picture), for guessed token counts. */
export const AI_DOCUMENT_PAGE_TOKENS = 2500;
/** A PDF's pages when nobody counted them, for guessed token counts. */
const UNCOUNTED_PAGES = 10;

/**
 * The messages' length in characters for a guessed token count, a picture or a PDF counted as its tokens, not its
 * bytes.
 */
export function messagesLength(messages: readonly AiMessage[]): number {
  let tokens = 0;
  const text = JSON.stringify(messages, (key, value: unknown) => {
    const type = value && typeof value === 'object' ? (value as { type?: unknown }).type : null;
    if (type === 'image') {
      tokens += AI_IMAGE_TOKENS;
      return { type };
    }
    if (type === 'document') {
      const pages = (value as { pages?: unknown }).pages;
      tokens +=
        (typeof pages === 'number' && pages > 0 ? pages : UNCOUNTED_PAGES) *
        AI_DOCUMENT_PAGE_TOKENS;
      return { type };
    }
    return value;
  });
  return text.length + tokens * 4;
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
  /**
   * Instructions that stay the same for a whole conversation, after `system`: a phone call's business, customer
   * and FAQ, read once when it's picked up. Providers cache them too, so each turn reads only what's new.
   */
  readonly lasting?: string;
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
  /** The model that answered, when the provider says: the backup's, when Claude was down. */
  readonly model?: string;
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
  /** The answer started: its first block arrived (the model's reasoning, text or a tool call). Once per answer. */
  readonly onStarted?: (first: AiFirstBlock) => void;
  readonly signal?: AbortSignal;
}

/** What an answer started with: `thinking` when the model reasoned before writing anything. */
export type AiFirstBlock = 'thinking' | 'text' | 'tool_call' | 'other';

export interface AiProvider {
  readonly id: string;
  readonly model: string;
  /**
   * It can search tools marked `deferred` and load them when needed, so a request can offer many tools without
   * the model reading every one of them up front. Without it, deferred tools are sent like any other.
   */
  readonly toolSearch?: boolean;
  stream(request: AiRequest, options?: AiStreamOptions): Promise<AiTurn>;
  /**
   * Reads a request's instructions and tools ahead of time, answering nothing, so the next request that starts
   * the same way finds them ready (a call does this while its greeting plays). Providers without a cache leave
   * it out.
   */
  warm?(request: AiRequest): Promise<AiUsage>;
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
