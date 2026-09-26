import Anthropic from '@anthropic-ai/sdk';
import { structuredOutputSchema } from './json-schema';
import {
  AiProviderError,
  type AiContent,
  type AiMessage,
  type AiProvider,
  type AiRequest,
  type AiStopReason,
  type AiStreamOptions,
  type AiTurn,
} from './types';

export interface AnthropicOptions {
  readonly apiKey: string;
  readonly model: string;
  /** The SDK retries 408, 409, 429 and 5xx answers on its own; this caps how often. */
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
  /** Tests pass a recorded fetch. */
  readonly fetch?: typeof fetch;
}

/**
 * Claude through the Messages API, streamed. Temperature is left alone: Sonnet 5 refuses it. A request with
 * a `responseFormat` uses structured outputs (`output_config.format`, a JSON schema; generally available,
 * supported by Sonnet 5), so the answer's text is JSON in that shape.
 */
export class AnthropicProvider implements AiProvider {
  readonly id = 'anthropic';
  readonly model: string;
  private readonly client: Anthropic;

  constructor(options: AnthropicOptions) {
    this.model = options.model;
    this.client = new Anthropic({
      apiKey: options.apiKey,
      maxRetries: options.maxRetries ?? 2,
      timeout: options.timeoutMs ?? 60_000,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  async stream(request: AiRequest, options: AiStreamOptions = {}): Promise<AiTurn> {
    // Tools, then the fixed instructions, form a prefix the API caches; the per-question context comes after it.
    const system: Anthropic.TextBlockParam[] = [
      { type: 'text', text: request.system, cache_control: { type: 'ephemeral' } },
    ];
    if (request.context) system.push({ type: 'text', text: request.context });
    const tools: Anthropic.Tool[] = (request.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      ...(t.strict ? { strict: true } : {}),
    }));
    try {
      const stream = this.client.messages.stream(
        {
          model: this.model,
          max_tokens: request.maxTokens ?? 2048,
          system,
          messages: request.messages.map(toAnthropic),
          ...(tools.length ? { tools } : {}),
          ...(request.responseFormat
            ? {
                output_config: {
                  format: {
                    type: 'json_schema' as const,
                    schema: structuredOutputSchema(request.responseFormat.schema),
                  },
                },
              }
            : {}),
        },
        { signal: options.signal },
      );
      const onText = options.onText;
      if (onText) stream.on('text', (delta) => onText(delta));
      return fromAnthropic(await stream.finalMessage());
    } catch (e) {
      throw providerError(e);
    }
  }
}

function toAnthropic(m: AiMessage): Anthropic.MessageParam {
  if (typeof m.content === 'string') return { role: m.role, content: m.content };
  // A picture is the bulk of a turn, and the conversation is sent again every round: the last one is cached.
  const lastImage = m.content.map((c) => c.type).lastIndexOf('image');
  return {
    role: m.role,
    content: m.content.map((c, i) => {
      const block = toBlock(c);
      return i === lastImage && block.type === 'image'
        ? { ...block, cache_control: { type: 'ephemeral' as const } }
        : block;
    }),
  };
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
    case 'reasoning':
      // A thinking or redacted_thinking block as the API sent it, signature and all.
      return c.block as unknown as Anthropic.ContentBlockParam;
  }
}

const STOP: Record<string, AiStopReason> = {
  end_turn: 'end_turn',
  stop_sequence: 'end_turn',
  tool_use: 'tool_use',
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
    } else if (block.type === 'thinking' || block.type === 'redacted_thinking')
      content.push({ type: 'reasoning', block: { ...block } });
  }
  const u = message.usage;
  return {
    text,
    toolCalls,
    content,
    stopReason: STOP[message.stop_reason ?? ''] ?? 'other',
    usage: {
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    },
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
