import OpenAI from 'openai';
import type {
  FunctionTool,
  Response as OpenAiResponse,
  ResponseInputContent,
  ResponseInputItem,
  ResponseOutputItem,
  Tool,
} from 'openai/resources/responses/responses';
import type { ReasoningEffort } from 'openai/resources/shared';
import { structuredOutputSchema } from './json-schema';
import {
  AiProviderError,
  type AiContent,
  type AiFirstBlock,
  type AiMessage,
  type AiProvider,
  type AiRequest,
  type AiStopReason,
  type AiStreamOptions,
  type AiToolDefinition,
  type AiTurn,
  type AiUsage,
} from './types';

export interface OpenAiOptions {
  readonly apiKey: string;
  readonly model: string;
  /** How long the model reasons before answering. A phone call wants `none`; the default is `low`. */
  readonly reasoningEffort?: ReasoningEffort;
  /** The SDK retries 408, 409, 429 and 5xx answers on its own; this caps how often. */
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
  /** Tests pass a recorded fetch. */
  readonly fetch?: typeof fetch;
  /** Let the model search tools marked `deferred` (OpenAI's hosted tool search), when the model has it. */
  readonly toolSearch?: boolean;
}

/** The models OpenAI's hosted tool search runs on (developers.openai.com, "Tool search": gpt-5.4 and later). */
const TOOL_SEARCH_MODELS = ['gpt-6', 'gpt-5.4', 'gpt-5.5', 'gpt-5.6'];
export const openAiSearchesTools = (model: string): boolean =>
  TOOL_SEARCH_MODELS.some((m) => model === m || model.startsWith(`${m}-`));

/** OpenAI's own kinds of item that go back unchanged on the next call (a tool search and what it loaded). */
const PASSTHROUGH = new Set(['tool_search_call', 'tool_search_output']);

/**
 * GPT through the Responses API, streamed: the backup when Claude is down (`FallbackProvider`). Nothing is
 * stored at OpenAI (`store: false`), and its prompt cache works on its own, so there is nothing to warm.
 *
 * The model's reasoning isn't handed back between turns: without storage it could only go back encrypted, and a
 * tool loop works without it. A tool search is, so the tools it found stay found.
 */
export class OpenAiProvider implements AiProvider {
  readonly id = 'openai';
  readonly model: string;
  readonly toolSearch: boolean;
  private readonly client: OpenAI;
  private readonly effort: ReasoningEffort;

  constructor(options: OpenAiOptions) {
    this.model = options.model;
    this.toolSearch = options.toolSearch === true && openAiSearchesTools(options.model);
    this.effort = options.reasoningEffort ?? 'low';
    this.client = new OpenAI({
      apiKey: options.apiKey,
      maxRetries: options.maxRetries ?? 2,
      timeout: options.timeoutMs ?? 60_000,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  async stream(request: AiRequest, options: AiStreamOptions = {}): Promise<AiTurn> {
    const searching = this.toolSearch && (request.tools ?? []).some((t) => t.deferred);
    const tools = toolsOf(request.tools ?? [], searching);
    try {
      // The raw events, not the SDK's stream helper: that one parses JSON answers and strict tools' input
      // itself, and throws on a cut-off one, where `parseStructured` and the tool's own check should say why.
      const events = await this.client.responses.create(
        {
          model: this.model,
          store: false,
          stream: true,
          instructions: instructionsOf(request),
          input: inputOf(request.messages, searching),
          max_output_tokens: request.maxTokens ?? 2048,
          reasoning: { effort: this.effort },
          ...(tools.length ? { tools } : {}),
          ...(request.responseFormat
            ? {
                text: {
                  format: {
                    type: 'json_schema' as const,
                    name: 'answer',
                    ...strictSchema(request.responseFormat.schema),
                  },
                },
              }
            : {}),
        },
        { signal: options.signal },
      );
      const writing = new Map<number, { id: string; name: string; json: string }>();
      let started = false;
      let final: OpenAiResponse | null = null;
      for await (const event of events) {
        if (event.type === 'response.output_item.added') {
          if (!started) {
            started = true;
            options.onStarted?.(firstBlockOf(event.item.type));
          }
          if (event.item.type === 'function_call' && options.onToolInput) {
            const call = { id: event.item.call_id, name: event.item.name, json: '' };
            writing.set(event.output_index, call);
            options.onToolInput({ ...call, done: false });
          }
        } else if (event.type === 'response.output_text.delta') {
          options.onText?.(event.delta);
        } else if (event.type === 'response.function_call_arguments.delta') {
          const call = writing.get(event.output_index);
          if (!call) continue;
          call.json += event.delta;
          options.onToolInput?.({ ...call, done: false });
        } else if (event.type === 'response.output_item.done') {
          const call = writing.get(event.output_index);
          if (!call || event.item.type !== 'function_call') continue;
          writing.delete(event.output_index);
          call.json = event.item.arguments;
          options.onToolInput?.({ ...call, done: true });
        } else if (
          event.type === 'response.completed' ||
          event.type === 'response.incomplete' ||
          event.type === 'response.failed'
        )
          final = event.response;
        else if (event.type === 'error')
          throw new AiProviderError(event.message, 'unavailable', true);
      }
      if (!final)
        throw new AiProviderError('OpenAI’s answer stopped part way', 'unavailable', true);
      return fromOpenAi(final);
    } catch (e) {
      throw providerError(e);
    }
  }
}

/** One set of instructions: the fixed part first, so OpenAI's prompt cache finds the same start every time. */
function instructionsOf(request: AiRequest): string {
  return [request.system, request.lasting, request.context].filter(Boolean).join('\n\n');
}

function toolsOf(defs: readonly AiToolDefinition[], searching: boolean): Tool[] {
  const tools: Tool[] = defs.map((t): FunctionTool => {
    const strict = t.strict ? strictSchema(t.inputSchema) : null;
    return {
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: strict ? strict.schema : t.inputSchema,
      // Strict only when the schema meets OpenAI's rules; the caller checks the input either way.
      strict: strict?.strict ?? false,
      ...(searching && t.deferred ? { defer_loading: true } : {}),
    };
  });
  if (searching) tools.unshift({ type: 'tool_search' });
  return tools;
}

/**
 * The schema reduced as for Claude, held to it exactly only when OpenAI's strict mode takes it: every object
 * closed, every property required, no `allOf`, and only the string formats it knows. Anything else is sent as
 * guidance and checked by the caller's zod.
 */
function strictSchema(schema: Record<string, unknown>): {
  schema: Record<string, unknown>;
  strict: boolean;
} {
  const reduced = structuredOutputSchema(schema);
  return { schema: reduced, strict: strictOk(reduced) };
}

/** The string formats OpenAI's strict mode accepts (developers.openai.com, "Structured model outputs"). */
const STRICT_FORMATS = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'ipv4',
  'ipv6',
  'uuid',
]);

function strictOk(node: Record<string, unknown>): boolean {
  const each = (value: unknown) =>
    Object.values((value ?? {}) as Record<string, Record<string, unknown>>).every(strictOk);
  const properties = (node.properties ?? {}) as Record<string, unknown>;
  const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
  if (node.properties && Object.keys(properties).some((k) => !required.has(k))) return false;
  if (node.allOf || (node.format !== undefined && !STRICT_FORMATS.has(String(node.format))))
    return false;
  return (
    each(node.properties) &&
    each(node.$defs) &&
    (!node.items || strictOk(node.items as Record<string, unknown>)) &&
    (!Array.isArray(node.anyOf) || (node.anyOf as Record<string, unknown>[]).every(strictOk))
  );
}

/**
 * The conversation as Responses API items. Tool calls and their results are items of their own, in the order
 * they happened; a block only Claude understands (its reasoning, its tool search) is left out.
 */
function inputOf(messages: readonly AiMessage[], searching: boolean): ResponseInputItem[] {
  const items: ResponseInputItem[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      if (m.content) items.push({ role: m.role, content: m.content });
      continue;
    }
    let parts: ResponseInputContent[] = [];
    let text = '';
    const flush = () => {
      if (m.role === 'assistant') {
        if (text) items.push({ role: 'assistant', content: text });
      } else if (parts.length) items.push({ role: 'user', content: parts });
      parts = [];
      text = '';
    };
    for (const c of m.content) {
      switch (c.type) {
        case 'text':
          if (!c.text) break;
          if (m.role === 'assistant') text += c.text;
          else parts.push({ type: 'input_text', text: c.text });
          break;
        case 'image':
          parts.push({
            type: 'input_image',
            detail: 'auto',
            image_url: `data:${c.mediaType};base64,${c.data}`,
          });
          break;
        case 'document':
          parts.push({
            type: 'input_file',
            filename: c.title ? `${c.title}.pdf` : 'document.pdf',
            file_data: `data:${c.mediaType};base64,${c.data}`,
          });
          break;
        case 'tool_call':
          flush();
          items.push({
            type: 'function_call',
            call_id: c.id,
            name: c.name,
            arguments: JSON.stringify(c.arguments),
          });
          break;
        case 'tool_result':
          flush();
          items.push({
            type: 'function_call_output',
            call_id: c.callId,
            output: c.isError ? `Error: ${c.content}` : c.content,
          });
          break;
        case 'passthrough': {
          if (!searching || !PASSTHROUGH.has(String(c.block.type))) break;
          flush();
          // Nothing is stored at OpenAI, so an item goes back without the id it had.
          const { id: _id, ...item } = c.block;
          items.push(item as unknown as ResponseInputItem);
          break;
        }
      }
    }
    flush();
  }
  return items;
}

function firstBlockOf(type: string): AiFirstBlock {
  if (type === 'reasoning') return 'thinking';
  if (type === 'message') return 'text';
  return type === 'function_call' ? 'tool_call' : 'other';
}

/** OpenAI counts cached input inside `input_tokens`; here, as with Claude, input is only what wasn't cached. */
function usageOf(u: OpenAiResponse['usage']): AiUsage {
  const cacheRead = u?.input_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = u?.input_tokens_details?.cache_write_tokens ?? 0;
  return {
    inputTokens: Math.max(0, (u?.input_tokens ?? 0) - cacheRead - cacheWrite),
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
}

function fromOpenAi(response: OpenAiResponse): AiTurn {
  if (response.status === 'failed')
    throw new AiProviderError(
      response.error?.message ?? 'OpenAI couldn’t answer',
      'unavailable',
      true,
    );
  let text = '';
  let refused = false;
  const toolCalls: AiTurn['toolCalls'][number][] = [];
  const content: AiContent[] = [];
  for (const item of response.output as ResponseOutputItem[]) {
    if (item.type === 'message') {
      for (const part of item.content) {
        if (part.type === 'output_text') {
          text += part.text;
          content.push({ type: 'text', text: part.text });
        } else if (part.type === 'refusal') refused = true;
      }
    } else if (item.type === 'function_call') {
      const call = { id: item.call_id, name: item.name, arguments: argumentsOf(item.arguments) };
      toolCalls.push(call);
      content.push({ type: 'tool_call', ...call });
    } else if (PASSTHROUGH.has(item.type))
      content.push({ type: 'passthrough', block: { ...item } });
  }
  return {
    text,
    toolCalls,
    content,
    stopReason: stopOf(response, refused, toolCalls.length > 0),
    usage: usageOf(response.usage),
  };
}

function stopOf(response: OpenAiResponse, refused: boolean, calls: boolean): AiStopReason {
  if (refused) return 'refusal';
  if (response.status === 'incomplete') {
    const reason = response.incomplete_details?.reason;
    if (reason === 'max_output_tokens') return 'max_tokens';
    return reason === 'content_filter' ? 'refusal' : 'other';
  }
  if (calls) return 'tool_use';
  return response.status === 'completed' ? 'end_turn' : 'other';
}

/** A call's arguments, or none when they aren't a JSON object: the tool's own check then says what's missing. */
function argumentsOf(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function providerError(e: unknown): AiProviderError {
  if (e instanceof AiProviderError) return e;
  if (e instanceof OpenAI.APIUserAbortError)
    return new AiProviderError('Stopped before the answer finished', 'aborted', false);
  if (e instanceof OpenAI.APIConnectionError)
    return new AiProviderError('Could not reach OpenAI', 'unavailable', true);
  if (e instanceof OpenAI.APIError) {
    const status = e.status ?? 0;
    // Out of credit is a 429 too, and waiting won't fix it.
    if (status === 429 && e.code === 'insufficient_quota')
      return new AiProviderError(e.message, 'auth', false, status);
    if (status === 429) return new AiProviderError(e.message, 'rate_limited', true, status);
    // An error in the middle of the stream has no status: the server's own trouble.
    if (status === 0 || status >= 500)
      return new AiProviderError(e.message, 'unavailable', true, status || undefined);
    if (status === 401 || status === 403)
      return new AiProviderError(e.message, 'auth', false, status);
    return new AiProviderError(e.message, 'bad_request', false, status);
  }
  return new AiProviderError(e instanceof Error ? e.message : String(e), 'other', false);
}
