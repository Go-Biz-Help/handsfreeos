import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AiOutputError,
  AnthropicProvider,
  emptyUsage,
  parseStructured,
  structuredOutputSchema,
  type AiRequest,
  type AiTurn,
} from '@hfos/ai';

/** A streamed Messages API answer as the API sends it: server-sent events. */
function sse(events: readonly (readonly [string, unknown])[]): Response {
  const body = events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const TOOL_TURN = [
  [
    'message_start',
    {
      type: 'message_start',
      message: {
        id: 'msg_test_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 120,
          output_tokens: 1,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 0,
        },
      },
    },
  ],
  [
    'content_block_start',
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  ],
  [
    'content_block_delta',
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Looking ' } },
  ],
  [
    'content_block_delta',
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'that up.' } },
  ],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  [
    'content_block_start',
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_test_1', name: 'search_customers', input: {} },
    },
  ],
  [
    'content_block_delta',
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"query":' },
    },
  ],
  [
    'content_block_delta',
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '"Mike"}' },
    },
  ],
  ['content_block_stop', { type: 'content_block_stop', index: 1 }],
  [
    'message_delta',
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 30 },
    },
  ],
  ['message_stop', { type: 'message_stop' }],
] as const;

const REQUEST: AiRequest = {
  system: 'You are the HandsFreeOS Assistant.',
  context: 'It is Sunday, 2:16 PM.',
  tools: [
    {
      name: 'search_customers',
      description: 'Find customers.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  ],
  messages: [
    { role: 'user', content: 'Find Mike' },
    {
      role: 'assistant',
      content: [{ type: 'tool_call', id: 'toolu_0', name: 'list_team', arguments: {} }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', callId: 'toolu_0', content: '[]', isError: true }],
    },
  ],
};

function recording(response: () => Response) {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(url),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return response();
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}

describe('AnthropicProvider', () => {
  it('streams the text, collects tool calls and reports usage including the cache', async () => {
    const { sent, fetch } = recording(() => sse(TOOL_TURN));
    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      model: 'claude-sonnet-5',
      fetch,
      maxRetries: 0,
    });
    const deltas: string[] = [];
    const turn = await provider.stream(REQUEST, { onText: (d) => deltas.push(d) });

    expect(deltas).toEqual(['Looking ', 'that up.']);
    expect(turn).toEqual({
      text: 'Looking that up.',
      toolCalls: [{ id: 'toolu_test_1', name: 'search_customers', arguments: { query: 'Mike' } }],
      stopReason: 'tool_use',
      usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 900, cacheWriteTokens: 0 },
    });

    const body = sent[0]!.body;
    expect(sent[0]!.url).toMatch(/\/v1\/messages$/);
    expect(body).toMatchObject({ model: 'claude-sonnet-5', max_tokens: 2048, stream: true });
    expect(body).not.toHaveProperty('temperature');
    // The fixed instructions carry the cache mark; the per-question context comes after them.
    expect(body['system']).toEqual([
      { type: 'text', text: REQUEST.system, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: REQUEST.context },
    ]);
    expect(body['tools']).toEqual([
      {
        name: 'search_customers',
        description: 'Find customers.',
        input_schema: REQUEST.tools![0]!.inputSchema,
      },
    ]);
    expect(body['messages']).toEqual([
      { role: 'user', content: 'Find Mike' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_0', name: 'list_team', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_0', content: '[]', is_error: true }],
      },
    ]);
  });

  it('turns API errors into codes the runtime can act on', async () => {
    const answer = (status: number, type: string) => () =>
      new Response(JSON.stringify({ type: 'error', error: { type, message: type } }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    const failWith = (status: number, type: string) =>
      new AnthropicProvider({
        apiKey: 'test-key',
        model: 'claude-sonnet-5',
        fetch: recording(answer(status, type)).fetch,
        maxRetries: 0,
      }).stream(REQUEST);

    await expect(failWith(529, 'overloaded_error')).rejects.toMatchObject({
      code: 'overloaded',
      retryable: true,
    });
    await expect(failWith(429, 'rate_limit_error')).rejects.toMatchObject({
      code: 'rate_limited',
      retryable: true,
    });
    await expect(failWith(401, 'authentication_error')).rejects.toMatchObject({
      code: 'auth',
      retryable: false,
    });
    await expect(failWith(400, 'invalid_request_error')).rejects.toMatchObject({
      code: 'bad_request',
      retryable: false,
    });
  });
});

/** A structured answer (output_config.format) as the API streams it: JSON text in pieces. */
const JSON_TURN = [
  [
    'message_start',
    {
      type: 'message_start',
      message: {
        id: 'msg_test_2',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 410,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    },
  ],
  [
    'content_block_start',
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  ],
  [
    'content_block_delta',
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: '{"items":[{"kind":"fact","title":"Hours",' },
    },
  ],
  [
    'content_block_delta',
    {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'text_delta',
        text: '"body":"Monday to Friday, 7 AM to 6 PM.","tags":["hours"]}]}',
      },
    },
  ],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  [
    'message_delta',
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 38 },
    },
  ],
  ['message_stop', { type: 'message_stop' }],
] as const;

const ITEMS_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['fact', 'faq', 'article'] },
          title: { type: 'string', maxLength: 120, description: 'The fact’s name.' },
          body: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['kind', 'title', 'body', 'tags'],
      },
    },
  },
  required: ['items'],
};

const Items = z.object({
  items: z
    .array(
      z.object({
        kind: z.enum(['fact', 'faq', 'article']),
        title: z.string().max(120),
        body: z.string(),
        tags: z.array(z.string()),
      }),
    )
    .max(8),
});

describe('structured output', () => {
  it('asks Claude for JSON in the schema (output_config.format) and parses the answer', async () => {
    const { sent, fetch } = recording(() => sse(JSON_TURN));
    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      model: 'claude-sonnet-5',
      fetch,
      maxRetries: 0,
    });
    const turn = await provider.stream({
      system: 'Suggest knowledge items.',
      messages: [
        { role: 'user', content: '<website_page url="https://x.example/">…</website_page>' },
      ],
      maxTokens: 4096,
      responseFormat: { schema: ITEMS_SCHEMA },
    });
    expect(turn.stopReason).toBe('end_turn');
    expect(turn.usage).toEqual({
      inputTokens: 410,
      outputTokens: 38,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(parseStructured(turn, Items)).toEqual({
      items: [
        { kind: 'fact', title: 'Hours', body: 'Monday to Friday, 7 AM to 6 PM.', tags: ['hours'] },
      ],
    });

    const body = sent[0]!.body;
    expect(body).toMatchObject({ model: 'claude-sonnet-5', max_tokens: 4096, stream: true });
    expect(body).not.toHaveProperty('tools');
    // Every object closed, enums kept, and the limits the API doesn't enforce passed on as guidance.
    expect(body['output_config']).toEqual({
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              description: '{maxItems: 8}',
              items: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['fact', 'faq', 'article'] },
                  title: { type: 'string', description: 'The fact’s name.\n\n{maxLength: 120}' },
                  body: { type: 'string' },
                  tags: { type: 'array', items: { type: 'string' } },
                },
                required: ['kind', 'title', 'body', 'tags'],
                additionalProperties: false,
              },
            },
          },
          required: ['items'],
          additionalProperties: false,
        },
      },
    });
  });

  it('sends plain requests without output_config', async () => {
    const { sent, fetch } = recording(() => sse(TOOL_TURN));
    await new AnthropicProvider({
      apiKey: 'k',
      model: 'claude-sonnet-5',
      fetch,
      maxRetries: 0,
    }).stream(REQUEST);
    expect(sent[0]!.body).not.toHaveProperty('output_config');
  });

  it('keeps what structured outputs support and moves the rest into the description', () => {
    expect(
      structuredOutputSchema({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          when: { type: 'string', format: 'date-time' },
          site: { type: 'string', format: 'idn-hostname' },
          n: { type: 'integer', minimum: 1, maximum: 5 },
          pick: { oneOf: [{ type: 'string', const: 'a' }, { type: 'null' }] },
          list: { type: 'array', minItems: 1, items: { type: 'string' } },
          many: {
            type: 'array',
            minItems: 2,
            items: { type: 'object', additionalProperties: true },
          },
        },
      }),
    ).toEqual({
      type: 'object',
      properties: {
        when: { type: 'string', format: 'date-time' },
        site: { type: 'string', description: '{format: "idn-hostname"}' },
        n: { type: 'integer', description: '{minimum: 1, maximum: 5}' },
        pick: { anyOf: [{ type: 'string', const: 'a' }, { type: 'null' }] },
        list: { type: 'array', minItems: 1, items: { type: 'string' } },
        many: {
          type: 'array',
          description: '{minItems: 2}',
          items: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
      additionalProperties: false,
    });
  });

  it('refuses answers it can’t use: cut off, refused, not JSON, or the wrong shape', () => {
    const turn = (text: string, stopReason: AiTurn['stopReason'] = 'end_turn'): AiTurn => ({
      text,
      toolCalls: [],
      stopReason,
      usage: emptyUsage,
    });
    expect(() => parseStructured(turn('{"items": ['), Items)).toThrow(AiOutputError);
    expect(() => parseStructured(turn('{"items":[]}', 'max_tokens'), Items)).toThrow(/cut off/);
    expect(() => parseStructured(turn('{"items":[]}', 'refusal'), Items)).toThrow(/declined/);
    let issues: readonly string[] = [];
    try {
      parseStructured(turn('{"items":[{"kind":"poem","title":"x","body":"y","tags":[]}]}'), Items);
    } catch (e) {
      expect(e).toBeInstanceOf(AiOutputError);
      issues = (e as AiOutputError).issues;
    }
    expect(issues[0]).toMatch(/^items\.0\.kind: /);
  });
});
