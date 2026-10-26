import Anthropic from '@anthropic-ai/sdk';
import { structuredOutputSchema } from './json-schema';
import {
  AI_EFFORTS,
  AiProviderError,
  type AiContent,
  type AiEffort,
  type AiFirstBlock,
  type AiMessage,
  type AiProvider,
  type AiRequest,
  type AiStopReason,
  type AiStreamOptions,
  type AiTurn,
  type AiUsage,
} from './types';

export interface AnthropicOptions {
  readonly apiKey: string;
  readonly model: string;
  /** The SDK retries 408, 409, 429 and 5xx answers on its own; this caps how often. */
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
  /** Tests pass a recorded fetch. */
  readonly fetch?: typeof fetch;
  /**
   * Let the model search tools marked `deferred` (Anthropic's tool search), when the model has it. Worth it
   * only with a long list of tools; see `searchesTools`.
   */
  readonly toolSearch?: boolean;
  /**
   * How much the model thinks before it answers (`output_config.effort`), on a model that takes it; see
   * `takesEffort`. Less is faster. Unset leaves the model's own default.
   */
  readonly effort?: AnthropicEffort;
  /**
   * Answer without thinking first (`thinking: {type: 'disabled'}`), on a model that lets it be turned off; see
   * `turnsThinkingOff`. Others think as they always do.
   */
  readonly thinkingOff?: boolean;
  /**
   * Every turn calls a tool (`tool_choice: {type: 'any'}`), when thinking is off: without thinking, a model can
   * write a tool call out as text instead of making it. Only with thinking off, since most models refuse a forced
   * tool alongside thinking; never in a warm-up, which refuses it too.
   */
  readonly toolEachTurn?: boolean;
}

export type AnthropicEffort = NonNullable<Anthropic.OutputConfig['effort']>;

/**
 * The models that take `thinking: {type: 'disabled'}` at low effort (platform.claude.com, "Extended thinking").
 * Claude Opus 5.5, Claude Sonnet 5.5 and the Fable models refuse it, so they're matched exactly, with a date at
 * most: `claude-opus-5` isn't `claude-opus-5-5`.
 */
const THINKING_OFF_MODELS = [
  'claude-haiku-5-5',
  'claude-haiku-4-5',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
];
export const turnsThinkingOff = (model: string): boolean =>
  THINKING_OFF_MODELS.some(
    (m) => model === m || (model.startsWith(`${m}-`) && /^\d{8}$/.test(model.slice(m.length + 1))),
  );

/**
 * The models that take an effort level (platform.claude.com, "Effort"). Claude Haiku 4.5 and Claude Sonnet 4.5
 * refuse one, so they answer as they always did.
 */
const EFFORT_MODELS = [
  'claude-fable-5',
  'claude-mythos-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-haiku-5-5',
];
export const takesEffort = (model: string): boolean =>
  EFFORT_MODELS.some((m) => model === m || model.startsWith(`${m}-`));

/**
 * The models Anthropic's tool search runs on (platform.claude.com, "Tool search tool", Model compatibility).
 * Claude Sonnet 5 isn't one: with it, deferred tools are simply sent in full.
 */
const TOOL_SEARCH_MODELS = [
  'claude-opus-5',
  'claude-fable-5',
  'claude-mythos-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
];
export const searchesTools = (model: string): boolean =>
  TOOL_SEARCH_MODELS.some((m) => model === m || model.startsWith(`${m}-`));

/**
 * The models that change how much they think partway through a conversation (platform.claude.com, "Effort", per-message
 * effort; beta `mid-conversation-output-config-2026-07-01`), and only while they think. Matched exactly, with a date
 * at most: Claude Fable 5 refuses it, and `claude-fable-5` isn't `claude-fable-5-1`.
 */
const EFFORT_PER_MESSAGE_MODELS = [
  'claude-fable-5-1',
  'claude-mythos-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
];
export const changesEffortPartway = (model: string): boolean =>
  EFFORT_PER_MESSAGE_MODELS.some(
    (m) => model === m || (model.startsWith(`${m}-`) && /^\d{8}$/.test(model.slice(m.length + 1))),
  );
const EFFORT_PARTWAY = 'mid-conversation-output-config-2026-07-01';

const THINKING_OFF = { type: 'disabled' } as const satisfies Anthropic.ThinkingConfigDisabled;
const ANY_TOOL = { type: 'any' } as const satisfies Anthropic.ToolChoiceAny;

/** BM25: the model searches in plain words, which is how the tools here are described. */
const TOOL_SEARCH = {
  type: 'tool_search_tool_bm25_20251119',
  name: 'tool_search_tool_bm25',
} as const satisfies Anthropic.ToolSearchToolBm25_20251119;

/**
 * Claude through the Messages API, streamed. Temperature is left alone: Sonnet 5 refuses it. A request with
 * a `responseFormat` uses structured outputs (`output_config.format`, a JSON schema; generally available,
 * supported by Sonnet 5), so the answer's text is JSON in that shape.
 */
export class AnthropicProvider implements AiProvider {
  readonly id = 'anthropic';
  readonly model: string;
  readonly toolSearch: boolean;
  readonly effort: AnthropicEffort | null;
  readonly thinkingOff: boolean;
  readonly toolEachTurn: boolean;
  private readonly client: Anthropic;

  constructor(options: AnthropicOptions) {
    this.model = options.model;
    this.toolSearch = options.toolSearch === true && searchesTools(options.model);
    this.effort = options.effort && takesEffort(options.model) ? options.effort : null;
    this.thinkingOff = options.thinkingOff === true && turnsThinkingOff(options.model);
    this.toolEachTurn = options.toolEachTurn === true && this.thinkingOff;
    this.client = new Anthropic({
      apiKey: options.apiKey,
      maxRetries: options.maxRetries ?? 2,
      timeout: options.timeoutMs ?? 60_000,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  /**
   * Only from an effort set below it, on a model that changes effort partway and while it thinks: the request then
   * says so with an effort-only message where the step starts, which leaves the cached conversation before it alone.
   */
  thinksHarderAt(effort: AiEffort): boolean {
    return (
      this.effort !== null &&
      !this.thinkingOff &&
      changesEffortPartway(this.model) &&
      AI_EFFORTS.indexOf(effort) > AI_EFFORTS.indexOf(this.effort)
    );
  }

  async stream(request: AiRequest, options: AiStreamOptions = {}): Promise<AiTurn> {
    const tools = this.toolsOf(request);
    const harder =
      request.effortFrom && this.thinksHarderAt(request.effortFrom.effort)
        ? request.effortFrom
        : null;
    try {
      const stream = this.client.messages.stream(
        {
          model: this.model,
          max_tokens: request.maxTokens ?? 2048,
          system: systemOf(request),
          messages: messagesOf(request.messages, harder),
          ...(tools.length ? { tools } : {}),
          ...(tools.length && this.toolEachTurn ? { tool_choice: ANY_TOOL } : {}),
          ...(this.thinkingOff ? { thinking: THINKING_OFF } : {}),
          ...outputConfigOf(request, this.effort),
        },
        {
          signal: options.signal,
          ...(harder ? { headers: { 'anthropic-beta': EFFORT_PARTWAY } } : {}),
        },
      );
      const onStarted = options.onStarted;
      if (onStarted) {
        let started = false;
        stream.on('streamEvent', (event) => {
          if (started || event.type !== 'content_block_start') return;
          started = true;
          onStarted(firstBlockOf(event.content_block.type));
        });
      }
      const onText = options.onText;
      if (onText) stream.on('text', (delta) => onText(delta));
      const onToolInput = options.onToolInput;
      if (onToolInput) {
        const writing = new Map<number, { id: string; name: string; json: string }>();
        stream.on('streamEvent', (event) => {
          if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
            const call = { id: event.content_block.id, name: event.content_block.name, json: '' };
            writing.set(event.index, call);
            onToolInput({ ...call, done: false });
          } else if (
            event.type === 'content_block_delta' &&
            event.delta.type === 'input_json_delta'
          ) {
            const call = writing.get(event.index);
            if (!call) return;
            call.json += event.delta.partial_json;
            onToolInput({ ...call, done: false });
          } else if (event.type === 'content_block_stop') {
            const call = writing.get(event.index);
            if (!call) return;
            writing.delete(event.index);
            onToolInput({ ...call, done: true });
          }
        });
      }
      return fromAnthropic(await stream.finalMessage());
    } catch (e) {
      throw providerError(e);
    }
  }

  /**
   * `max_tokens: 0`: the API reads the instructions and tools, writing them to its cache, and answers nothing.
   * The tools, `system`, `lasting`, thinking and effort must be exactly what the next request sends for it to find
   * them.
   */
  async warm(request: AiRequest): Promise<AiUsage> {
    const tools = this.toolsOf(request);
    try {
      const message = await this.client.messages.create({
        model: this.model,
        max_tokens: 0,
        system: systemOf(request),
        // Read while warming, never answered: anything that isn't blank.
        messages: request.messages.length
          ? request.messages.map(toAnthropic)
          : [{ role: 'user', content: 'Getting ready.' }],
        ...(tools.length ? { tools } : {}),
        ...(this.thinkingOff ? { thinking: THINKING_OFF } : {}),
        ...(this.effort ? { output_config: { effort: this.effort } } : {}),
      });
      return usageOf(message.usage);
    } catch (e) {
      throw providerError(e);
    }
  }

  private toolsOf(request: AiRequest): Anthropic.ToolUnion[] {
    // Deferred tools reach the model only through its search; the search tool itself is never deferred.
    const searching = this.toolSearch && (request.tools ?? []).some((t) => t.deferred);
    const tools: Anthropic.ToolUnion[] = (request.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      ...(t.strict ? { strict: true } : {}),
      ...(t.streamInput ? { eager_input_streaming: true } : {}),
      ...(searching && t.deferred ? { defer_loading: true } : {}),
    }));
    if (searching) tools.unshift(TOOL_SEARCH);
    return tools;
  }
}

/**
 * Tools, then the fixed instructions, form a prefix the API caches (the same for every conversation with the same
 * tools); a conversation's lasting part is cached after it; the per-question context comes last, uncached.
 */
function systemOf(request: AiRequest): Anthropic.TextBlockParam[] {
  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: request.system, cache_control: { type: 'ephemeral' } },
  ];
  if (request.lasting)
    system.push({ type: 'text', text: request.lasting, cache_control: { type: 'ephemeral' } });
  if (request.context) system.push({ type: 'text', text: request.context });
  return system;
}

/** The effort and a `responseFormat`'s schema, when there is either; a plain request sends no output_config. */
function outputConfigOf(
  request: AiRequest,
  effort: AnthropicEffort | null,
): { output_config?: Anthropic.OutputConfig } {
  if (!effort && !request.responseFormat) return {};
  return {
    output_config: {
      ...(effort ? { effort } : {}),
      ...(request.responseFormat
        ? {
            format: {
              type: 'json_schema' as const,
              schema: structuredOutputSchema(request.responseFormat.schema),
            },
          }
        : {}),
    },
  };
}

function firstBlockOf(type: string): AiFirstBlock {
  if (type === 'thinking' || type === 'redacted_thinking') return 'thinking';
  if (type === 'text') return 'text';
  return type === 'tool_use' ? 'tool_call' : 'other';
}

function usageOf(u: Anthropic.Usage): AiUsage {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

/**
 * The conversation is sent again every round of a tool loop, so its end is cached too: the next round reads
 * everything up to it, history and tool results included, and pays full price only for what's new. A picture
 * or a PDF is the bulk of a turn, so the conversation's last one keeps its own mark unless the end mark already
 * covers it. With the system and lasting marks that is four at most, the API's limit.
 */
function messagesOf(
  messages: readonly AiMessage[],
  harder: AiRequest['effortFrom'] | null = null,
): Anthropic.MessageParam[] {
  const out = messages.map(toAnthropic);
  const lastImage = out.findLastIndex(
    (m) => typeof m.content !== 'string' && m.content.some((b) => BULKY.has(b.type)),
  );
  if (lastImage >= 0 && lastImage < out.length - 1)
    out[lastImage] = withCacheOn(out[lastImage]!, 'bulky');
  if (out.length) out[out.length - 1] = withCacheOn(out[out.length - 1]!, 'last');
  // Thinking harder from a step on: an effort-only message just before the step's tool results, which holds from
  // there until the loop ends. It carries no words, so it may sit anywhere.
  if (harder && harder.at > 0 && harder.at < out.length) {
    const effort: Anthropic.Beta.BetaMessageParam = {
      role: 'system',
      content: [],
      output_config: { effort: harder.effort },
    };
    out.splice(harder.at, 0, effort as unknown as Anthropic.MessageParam);
  }
  return out;
}

/** Claude's own kinds of block that go back unchanged; another provider's (the backup's tool search) are left out. */
const PASSTHROUGH = new Set([
  'thinking',
  'redacted_thinking',
  'server_tool_use',
  'tool_search_tool_result',
]);

function toAnthropic(m: AiMessage): Anthropic.MessageParam {
  if (typeof m.content === 'string') return { role: m.role, content: m.content };
  return {
    role: m.role,
    content: m.content
      .filter((c) => c.type !== 'passthrough' || PASSTHROUGH.has(String(c.block.type)))
      .map(toBlock),
  };
}

const CACHEABLE = new Set(['text', 'image', 'document', 'tool_use', 'tool_result']);
/** The blocks that are most of a turn's size. */
const BULKY = new Set(['image', 'document']);

/**
 * Marks the message's last image or PDF, or its last block. Only our own kinds of block take the mark: never
 * thinking, a block passed back as the API sent it, or empty text.
 */
function withCacheOn(m: Anthropic.MessageParam, which: 'bulky' | 'last'): Anthropic.MessageParam {
  if (typeof m.content === 'string')
    return m.content && which === 'last'
      ? {
          role: m.role,
          content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }],
        }
      : m;
  const i =
    which === 'bulky' ? m.content.findLastIndex((b) => BULKY.has(b.type)) : m.content.length - 1;
  const block = m.content[i];
  if (!block || !CACHEABLE.has(block.type) || (block.type === 'text' && !block.text)) return m;
  const content = [...m.content];
  content[i] = { ...block, cache_control: { type: 'ephemeral' } } as Anthropic.ContentBlockParam;
  return { role: m.role, content };
}

function toBlock(c: AiContent): Anthropic.ContentBlockParam {
  switch (c.type) {
    case 'text':
      return { type: 'text', text: c.text };
    case 'tool_call':
      return { type: 'tool_use', id: c.id, name: c.name, input: c.arguments };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: c.callId,
        content: c.content,
        ...(c.isError ? { is_error: true } : {}),
      };
    case 'image':
      return { type: 'image', source: { type: 'base64', media_type: c.mediaType, data: c.data } };
    case 'document':
      return {
        type: 'document',
        source: { type: 'base64', media_type: c.mediaType, data: c.data },
        ...(c.title ? { title: c.title } : {}),
      };
    case 'passthrough':
      // A thinking, server tool use or tool search result block as the API sent it, signature and all.
      return c.block as unknown as Anthropic.ContentBlockParam;
  }
}

const STOP: Record<string, AiStopReason> = {
  end_turn: 'end_turn',
  stop_sequence: 'end_turn',
  tool_use: 'tool_use',
  pause_turn: 'pause_turn',
  max_tokens: 'max_tokens',
  refusal: 'refusal',
};

function fromAnthropic(message: Anthropic.Message): AiTurn {
  let text = '';
  const toolCalls: AiTurn['toolCalls'][number][] = [];
  const content: AiContent[] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      text += block.text;
      content.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_use') {
      const call = {
        id: block.id,
        name: block.name,
        arguments: (block.input ?? {}) as Record<string, unknown>,
      };
      toolCalls.push(call);
      content.push({ type: 'tool_call', ...call });
    } else if (PASSTHROUGH.has(block.type))
      content.push({ type: 'passthrough', block: { ...block } });
  }
  return {
    text,
    toolCalls,
    content,
    stopReason: STOP[message.stop_reason ?? ''] ?? 'other',
    usage: usageOf(message.usage),
  };
}

function providerError(e: unknown): AiProviderError {
  if (e instanceof AiProviderError) return e;
  if (e instanceof Anthropic.APIUserAbortError)
    return new AiProviderError('Stopped before the answer finished', 'aborted', false);
  if (e instanceof Anthropic.APIConnectionError)
    return new AiProviderError('Could not reach Anthropic', 'unavailable', true);
  if (e instanceof Anthropic.APIError) {
    const status = e.status ?? 0;
    if (status === 429) return new AiProviderError(e.message, 'rate_limited', true, status);
    if (status === 529) return new AiProviderError(e.message, 'overloaded', true, status);
    if (status >= 500) return new AiProviderError(e.message, 'unavailable', true, status);
    if (status === 401 || status === 403)
      return new AiProviderError(e.message, 'auth', false, status);
    return new AiProviderError(e.message, 'bad_request', false, status);
  }
  return new AiProviderError(e instanceof Error ? e.message : String(e), 'other', false);
}
