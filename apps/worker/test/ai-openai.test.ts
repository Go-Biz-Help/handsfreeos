import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AiOutputError,
  AiProviderError,
  OpenAiProvider,
  parseStructured,
  openAiSearchesTools,
  type AiRequest,
  type AiToolInput,
} from '@hfos/ai';

/** A streamed Responses API answer as the API sends it: server-sent events, each named by its type. */
function sse(events: readonly Record<string, unknown>[]): Response {
  const body = events
    .map(
      (e, i) =>
        `event: ${String(e.type)}\ndata: ${JSON.stringify({ sequence_number: i, ...e })}\n\n`,
    )
    .join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const base = {
  id: 'resp_test_1',
  object: 'response',
  created_at: 1_790_000_000,
  model: 'gpt-6-sol',
  error: null,
  incomplete_details: null,
  instructions: null,
  metadata: {},
  parallel_tool_calls: true,
  temperature: null,
  tool_choice: 'auto',
  tools: [],
  top_p: null,
};

const message = (text: string) => ({
  type: 'message',
  id: 'msg_1',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});

const call = {
  type: 'function_call',
  id: 'fc_1',
  call_id: 'call_1',
  name: 'search_customers',
  arguments: '{"query":"Mike"}',
  status: 'completed',
};

const usage = {
  input_tokens: 1020,
  input_tokens_details: { cached_tokens: 900, cache_write_tokens: 0 },
  output_tokens: 30,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 1050,
};

/** Text, then a tool call, streamed piece by piece. */
const TOOL_TURN = [
  { type: 'response.created', response: { ...base, status: 'in_progress', output: [] } },
  {
    type: 'response.output_item.added',
    output_index: 0,
    item: { ...message(''), status: 'in_progress', content: [] },
  },
  {
    type: 'response.content_part.added',
    item_id: 'msg_1',
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] },
  },
  {
    type: 'response.output_text.delta',
    item_id: 'msg_1',
    output_index: 0,
    content_index: 0,
    delta: 'Looking ',
    logprobs: [],
  },
  {
    type: 'response.output_text.delta',
    item_id: 'msg_1',
    output_index: 0,
    content_index: 0,
    delta: 'that up.',
    logprobs: [],
  },
  { type: 'response.output_item.done', output_index: 0, item: message('Looking that up.') },
  {
    type: 'response.output_item.added',
    output_index: 1,
    item: { ...call, arguments: '', status: 'in_progress' },
  },
  {
    type: 'response.function_call_arguments.delta',
    item_id: 'fc_1',
    output_index: 1,
    delta: '{"query":',
  },
  {
    type: 'response.function_call_arguments.delta',
    item_id: 'fc_1',
    output_index: 1,
    delta: '"Mike"}',
  },
  { type: 'response.output_item.done', output_index: 1, item: call },
  {
    type: 'response.completed',
    response: {
      ...base,
      status: 'completed',
      output: [message('Looking that up.'), call],
      usage,
    },
  },
];

function recorder(answer: () => Response = () => sse(TOOL_TURN)) {
  const bodies: Record<string, unknown>[] = [];
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return answer();
  }) as unknown as typeof globalThis.fetch;
  return { bodies, fetch };
}

const request: AiRequest = {
  system: 'You help a plumbing business.',
  lasting: 'The business is Bayou Plumbing.',
  context: 'It is Tuesday.',
  messages: [{ role: 'user', content: 'Find Mike.' }],
  tools: [
    {
      name: 'search_customers',
      description: 'Find customers by name.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  ],
};

describe('OpenAiProvider', () => {
  it('streams the text, collects tool calls and reports usage with the cache taken out of input', async () => {
    const { bodies, fetch } = recorder();
    const provider = new OpenAiProvider({ apiKey: 'sk-test', model: 'gpt-6-sol', fetch });
    const deltas: string[] = [];
    const inputs: AiToolInput[] = [];
    const started: string[] = [];
    const turn = await provider.stream(request, {
      onText: (d) => deltas.push(d),
      onToolInput: (i) => inputs.push(i),
      onStarted: (first) => started.push(first),
    });

    expect(deltas).toEqual(['Looking ', 'that up.']);
    expect(started).toEqual(['text']);
    expect(inputs.at(0)).toEqual({ id: 'call_1', name: 'search_customers', json: '', done: false });
    expect(inputs.at(-1)).toEqual({
      id: 'call_1',
      name: 'search_customers',
      json: '{"query":"Mike"}',
      done: true,
    });
    expect(turn.text).toBe('Looking that up.');
    expect(turn.toolCalls).toEqual([
      { id: 'call_1', name: 'search_customers', arguments: { query: 'Mike' } },
    ]);
    expect(turn.stopReason).toBe('tool_use');
    expect(turn.usage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
    });

    const body = bodies[0]!;
    expect(body.model).toBe('gpt-6-sol');
    // Nothing is kept at OpenAI.
    expect(body.store).toBe(false);
    expect(body.instructions).toBe(
      'You help a plumbing business.\n\nThe business is Bayou Plumbing.\n\nIt is Tuesday.',
    );
    expect(body.reasoning).toEqual({ effort: 'low' });
    expect(body.tools).toEqual([
      {
        type: 'function',
        name: 'search_customers',
        description: 'Find customers by name.',
        parameters: request.tools![0]!.inputSchema,
        strict: false,
      },
    ]);
  });

  it('sends a conversation from Claude: tool calls and results as their own items, photos as images', async () => {
    const { bodies, fetch } = recorder();
    const provider = new OpenAiProvider({
      apiKey: 'sk-test',
      model: 'gpt-6-luna',
      reasoningEffort: 'none',
      fetch,
    });
    await provider.stream({
      system: 'You answer calls.',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Here is the leak.' },
            { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' },
          ],
        },
        {
          role: 'assistant',
          content: [
            // Claude's reasoning means nothing to OpenAI: it stays out.
            { type: 'passthrough', block: { type: 'thinking', thinking: 'Hmm', signature: 's' } },
            { type: 'text', text: 'Let me look.' },
            {
              type: 'tool_call',
              id: 'toolu_1',
              name: 'search_customers',
              arguments: { query: 'Mike' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', callId: 'toolu_1', content: '[]' },
            { type: 'tool_result', callId: 'toolu_2', content: 'No such tool', isError: true },
          ],
        },
      ],
    });
    const body = bodies[0]!;
    expect(body.reasoning).toEqual({ effort: 'none' });
    expect(body.input).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Here is the leak.' },
          { type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,aGVsbG8=' },
        ],
      },
      { role: 'assistant', content: 'Let me look.' },
      {
        type: 'function_call',
        call_id: 'toolu_1',
        name: 'search_customers',
        arguments: '{"query":"Mike"}',
      },
      { type: 'function_call_output', call_id: 'toolu_1', output: '[]' },
      { type: 'function_call_output', call_id: 'toolu_2', output: 'Error: No such tool' },
    ]);
  });

  it('asks for JSON in the schema, strict only when every property is required', async () => {
    const { bodies, fetch } = recorder();
    const provider = new OpenAiProvider({ apiKey: 'sk-test', model: 'gpt-6-sol', fetch });
    const strictOne = {
      type: 'object',
      properties: { tag: { type: 'string', minLength: 1 } },
      required: ['tag'],
    };
    const looseOne = {
      type: 'object',
      properties: { tag: { type: 'string' }, note: { type: 'string' } },
      required: ['tag'],
    };
    const aLink = {
      type: 'object',
      properties: { url: { type: 'string', format: 'uri' } },
      required: ['url'],
    };
    await provider.stream({ ...request, tools: [], responseFormat: { schema: strictOne } });
    await provider.stream({ ...request, tools: [], responseFormat: { schema: looseOne } });
    await provider.stream({ ...request, tools: [], responseFormat: { schema: aLink } });
    expect(bodies[0]!.text).toEqual({
      format: {
        type: 'json_schema',
        name: 'answer',
        strict: true,
        schema: {
          type: 'object',
          properties: { tag: { type: 'string', description: '{minLength: 1}' } },
          required: ['tag'],
          additionalProperties: false,
        },
      },
    });
    // An optional property, or a format OpenAI's strict mode doesn't know: guidance, checked by zod.
    expect((bodies[1]!.text as { format: { strict: boolean } }).format.strict).toBe(false);
    expect((bodies[2]!.text as { format: { strict: boolean } }).format.strict).toBe(false);
    expect(bodies[0]!.tools).toBeUndefined();
  });

  it('with tool search, sends the search tool and defers the rest, only on a model that has it', async () => {
    expect(openAiSearchesTools('gpt-6-sol')).toBe(true);
    expect(openAiSearchesTools('gpt-5.4-mini')).toBe(true);
    expect(openAiSearchesTools('gpt-4.1')).toBe(false);
    const deferred: AiRequest = {
      ...request,
      tools: [
        { ...request.tools![0]!, deferred: true },
        {
          name: 'add_note',
          description: 'Add a note.',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      messages: [
        { role: 'user', content: 'Find Mike.' },
        {
          role: 'assistant',
          content: [
            {
              type: 'passthrough',
              block: {
                type: 'tool_search_output',
                id: 'tso_1',
                execution: 'server',
                call_id: null,
                status: 'completed',
                tools: [],
              },
            },
            {
              type: 'tool_call',
              id: 'call_1',
              name: 'search_customers',
              arguments: { query: 'Mike' },
            },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', callId: 'call_1', content: '[]' }] },
      ],
    };
    const on = recorder();
    await new OpenAiProvider({
      apiKey: 'sk-test',
      model: 'gpt-6-sol',
      toolSearch: true,
      fetch: on.fetch,
    }).stream(deferred);
    const tools = on.bodies[0]!.tools as Record<string, unknown>[];
    expect(tools[0]).toEqual({ type: 'tool_search' });
    expect(tools[1]).toMatchObject({ name: 'search_customers', defer_loading: true });
    expect(tools[2]).not.toHaveProperty('defer_loading');
    // What the search found goes back, without the id nothing at OpenAI kept.
    expect((on.bodies[0]!.input as unknown[])[1]).toEqual({
      type: 'tool_search_output',
      execution: 'server',
      call_id: null,
      status: 'completed',
      tools: [],
    });

    const off = recorder();
    await new OpenAiProvider({
      apiKey: 'sk-test',
      model: 'gpt-4.1',
      toolSearch: true,
      fetch: off.fetch,
    }).stream(deferred);
    const plain = off.bodies[0]!.tools as Record<string, unknown>[];
    expect(plain.map((t) => t.type)).toEqual(['function', 'function']);
    expect(plain[0]).not.toHaveProperty('defer_loading');
    // Its search's results mean nothing without the search: they stay out.
    expect((off.bodies[0]!.input as unknown[]).length).toBe(3);
  });

  it('reports an answer cut off at the limit', async () => {
    const { fetch } = recorder(() =>
      sse([
        { type: 'response.created', response: { ...base, status: 'in_progress', output: [] } },
        {
          type: 'response.incomplete',
          response: {
            ...base,
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            output: [message('Half an ans')],
            usage,
          },
        },
      ]),
    );
    const turn = await new OpenAiProvider({ apiKey: 'sk-test', model: 'gpt-6-sol', fetch }).stream(
      request,
    );
    expect(turn.stopReason).toBe('max_tokens');
    expect(turn.text).toBe('Half an ans');
  });

  it('hands back a JSON answer cut off part way, for parseStructured to refuse, instead of throwing', async () => {
    const { fetch } = recorder(() =>
      sse([
        { type: 'response.created', response: { ...base, status: 'in_progress', output: [] } },
        {
          type: 'response.incomplete',
          response: {
            ...base,
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            output: [message('{"tag":"lea')],
            usage,
          },
        },
      ]),
    );
    const schema = { type: 'object', properties: { tag: { type: 'string' } }, required: ['tag'] };
    const turn = await new OpenAiProvider({ apiKey: 'sk-test', model: 'gpt-6-sol', fetch }).stream({
      ...request,
      tools: [],
      responseFormat: { schema },
    });
    expect(turn.stopReason).toBe('max_tokens');
    expect(() => parseStructured(turn, z.object({ tag: z.string() }))).toThrow(AiOutputError);
  });

  it('turns API errors into codes the runtime can act on', async () => {
    const failing = (status: number, code: string | null = null) =>
      new OpenAiProvider({
        apiKey: 'sk-test',
        model: 'gpt-6-sol',
        maxRetries: 0,
        fetch: (async () =>
          new Response(JSON.stringify({ error: { message: 'Nope', type: 'x', code } }), {
            status,
            headers: { 'content-type': 'application/json' },
          })) as unknown as typeof fetch,
      }).stream(request);
    const codeOf = async (p: Promise<unknown>) => {
      const e = await p.catch((err: unknown) => err);
      expect(e).toBeInstanceOf(AiProviderError);
      return { code: (e as AiProviderError).code, retryable: (e as AiProviderError).retryable };
    };
    expect(await codeOf(failing(429))).toEqual({ code: 'rate_limited', retryable: true });
    expect(await codeOf(failing(429, 'insufficient_quota'))).toEqual({
      code: 'auth',
      retryable: false,
    });
    expect(await codeOf(failing(503))).toEqual({ code: 'unavailable', retryable: true });
    expect(await codeOf(failing(401))).toEqual({ code: 'auth', retryable: false });
    expect(await codeOf(failing(400))).toEqual({ code: 'bad_request', retryable: false });
  });
});
