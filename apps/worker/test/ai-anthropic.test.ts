import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AiOutputError,
  AnthropicProvider,
  changesEffortPartway,
  emptyUsage,
  parseStructured,
  searchesTools,
  structuredOutputSchema,
  takesEffort,
  turnsThinkingOff,
  type AiRequest,
  type AiToolInput,
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
  const sent: { url: string; body: Record<string, unknown>; beta: string | null }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(url),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      beta: new Headers(init?.headers).get('anthropic-beta'),
    });
    return response();
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}

describe('AnthropicProvider', () => {
  it('sends a customer’s photos as images, the last one cached (M18)', async () => {
    const { sent, fetch } = recording(() => sse(TOOL_TURN));
    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      model: 'claude-sonnet-5',
      fetch,
      maxRetries: 0,
    });
    await provider.stream({
      system: 'You look at photos.',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image', mediaType: 'image/png', data: 'AAAA' },
            { type: 'image', mediaType: 'image/jpeg', data: 'BBBB' },
          ],
        },
      ],
    });
    expect(sent[0]!.body['messages']).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' },
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
    ]);
  });

  it('sends a PDF as a document before the words that ask about it, cached when a later turn follows (round four)', async () => {
    const { sent, fetch } = recording(() => sse(TOOL_TURN));
    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      model: 'claude-sonnet-5',
      fetch,
      maxRetries: 0,
    });
    await provider.stream({
      system: 'You read contracts.',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              mediaType: 'application/pdf',
              data: 'JVBERi0=',
              title: 'Smith contract',
              pages: 9,
            },
            { type: 'text', text: 'Read the contract’s terms.' },
          ],
        },
        { role: 'assistant', content: 'Which ones?' },
        { role: 'user', content: 'All of them.' },
      ],
    });
    const messages = sent[0]!.body['messages'] as { content: unknown }[];
    expect(messages[0]!.content).toEqual([
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
        title: 'Smith contract',
        cache_control: { type: 'ephemeral' },
      },
      { type: 'text', text: 'Read the contract’s terms.' },
    ]);
  });

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
      content: [
        { type: 'text', text: 'Looking that up.' },
        {
          type: 'tool_call',
          id: 'toolu_test_1',
          name: 'search_customers',
          arguments: { query: 'Mike' },
        },
      ],
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
        // The conversation's end is cached, so the next round reads it all back.
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_0',
            content: '[]',
            is_error: true,
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
    ]);
  });

  it('caches the conversation’s end and its last photo, and nothing else (PERF-M30)', async () => {
    const { sent, fetch } = recording(() => sse(TOOL_TURN));
    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      model: 'claude-sonnet-5',
      fetch,
      maxRetries: 0,
    });
    const photo = (data: string) => ({
      type: 'image' as const,
      mediaType: 'image/png' as const,
      data,
    });
    await provider.stream({
      system: 'You look at photos.',
      lasting: 'The business.',
      messages: [
        { role: 'user', content: [photo('AAAA'), { type: 'text', text: 'And this?' }] },
        { role: 'assistant', content: 'A condenser.' },
        { role: 'user', content: [photo('BBBB'), photo('CCCC'), { type: 'text', text: 'Now?' }] },
        { role: 'assistant', content: 'A coil.' },
        { role: 'user', content: 'Thanks' },
      ],
    });
    const body = sent[0]!.body;
    const marks = JSON.stringify(body).split('"cache_control"').length - 1;
    expect(marks).toBe(4);
    const messages = body['messages'] as { content: unknown }[];
    expect(messages[0]!.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'text', text: 'And this?' },
    ]);
    expect((messages[2]!.content as Record<string, unknown>[])[1]).toMatchObject({
      type: 'image',
      cache_control: { type: 'ephemeral' },
    });
    expect(messages[4]!.content).toEqual([
      { type: 'text', text: 'Thanks', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('streams a tool call’s input as it’s written, for tools that ask for it', async () => {
    const { sent, fetch } = recording(() => sse(TOOL_TURN));
    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      model: 'claude-sonnet-5',
      fetch,
      maxRetries: 0,
    });
    const inputs: AiToolInput[] = [];
    const turn = await provider.stream(
      { ...REQUEST, tools: [{ ...REQUEST.tools![0]!, streamInput: true }] },
      { onToolInput: (i) => inputs.push(i) },
    );
    const call = { id: 'toolu_test_1', name: 'search_customers' };
    expect(inputs).toEqual([
      { ...call, json: '', done: false },
      { ...call, json: '{"query":', done: false },
      { ...call, json: '{"query":"Mike"}', done: false },
      { ...call, json: '{"query":"Mike"}', done: true },
    ]);
    expect(turn.toolCalls).toEqual([{ ...call, arguments: { query: 'Mike' } }]);
    expect(sent[0]!.body['tools']).toEqual([
      {
        name: 'search_customers',
        description: 'Find customers.',
        input_schema: REQUEST.tools![0]!.inputSchema,
        eager_input_streaming: true,
      },
    ]);
  });

  it('caches a conversation’s lasting instructions after the fixed ones, and says when the answer started', async () => {
    const { sent, fetch } = recording(() => sse(TOOL_TURN));
    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      model: 'claude-haiku-4-5',
      fetch,
      maxRetries: 0,
    });
    const started: string[] = [];
    await provider.stream(
      { ...REQUEST, lasting: 'The business, the customer and the FAQ.' },
      { onStarted: (first) => started.push(first) },
    );
    expect(sent[0]!.body['system']).toEqual([
      { type: 'text', text: REQUEST.system, cache_control: { type: 'ephemeral' } },
      {
        type: 'text',
        text: 'The business, the customer and the FAQ.',
        cache_control: { type: 'ephemeral' },
      },
      { type: 'text', text: REQUEST.context },
    ]);
    // Once, for the answer's first block, whatever follows.
    expect(started).toEqual(['text']);
  });

  it('warms: reads the same instructions and tools ahead of time and answers nothing', async () => {
    let calls = 0;
    const { sent, fetch } = recording(() =>
      ++calls > 1
        ? sse(TOOL_TURN)
        : new Response(
            JSON.stringify({
              id: 'msg_warm',
              type: 'message',
              role: 'assistant',
              model: 'claude-haiku-4-5',
              content: [],
              stop_reason: 'max_tokens',
              stop_sequence: null,
              usage: {
                input_tokens: 12,
                output_tokens: 0,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 5100,
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
    );
    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      model: 'claude-haiku-4-5',
      fetch,
      maxRetries: 0,
    });
    const request: AiRequest = {
      system: REQUEST.system,
      lasting: 'The business, the customer and the FAQ.',
      tools: [{ ...REQUEST.tools![0]!, streamInput: true }],
      messages: [],
    };
    const usage = await provider.warm(request);
    expect(usage).toEqual({
      inputTokens: 12,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 5100,
    });
    const warm = sent[0]!.body;
    expect(warm).toMatchObject({ model: 'claude-haiku-4-5', max_tokens: 0 });
    expect(warm).not.toHaveProperty('stream');
    // Exactly what a turn sends before its own context, so the turn finds it ready.
    await provider.stream({
      ...request,
      context: 'Now.',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    const turn = sent[1]!.body;
    expect(warm['tools']).toEqual(turn['tools']);
    expect(warm['system']).toEqual((turn['system'] as unknown[]).slice(0, 2));
  });

  it('keeps the model’s reasoning in order and hands it back exactly as it came', async () => {
    // Opus 5.5 thinks before every answer and ties that thinking to the conversation.
    const [start, ...rest] = TOOL_TURN;
    const thinking = [
      [
        'content_block_start',
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        },
      ],
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'sig-1' },
        },
      ],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ] as const;
    // The fixture's own blocks move up one.
    const shifted = rest.map(([event, data]) => {
      const d = data as { index?: number };
      return [event, d.index === undefined ? data : { ...d, index: d.index + 1 }] as const;
    });
    const { sent, fetch } = recording(() => sse([start, ...thinking, ...shifted]));
    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      model: 'claude-opus-5-5',
      fetch,
      maxRetries: 0,
    });
    const turn = await provider.stream(REQUEST);
    const reasoning = { type: 'thinking', thinking: '', signature: 'sig-1' };
    expect(turn.content![0]).toEqual({ type: 'passthrough', block: reasoning });
    expect(turn.content!.map((c) => c.type)).toEqual(['passthrough', 'text', 'tool_call']);

    await provider.stream({
      ...REQUEST,
      messages: [
        ...REQUEST.messages,
        { role: 'assistant', content: turn.content! },
        {
          role: 'user',
          content: [{ type: 'tool_result', callId: 'toolu_test_1', content: '[]' }],
        },
      ],
    });
    const replayed = (sent[1]!.body['messages'] as { content: unknown[] }[])[3]!;
    expect(replayed.content).toEqual([
      reasoning,
      { type: 'text', text: 'Looking that up.' },
      { type: 'tool_use', id: 'toolu_test_1', name: 'search_customers', input: { query: 'Mike' } },
    ]);
    // Nothing Opus 5.5 refuses: no thinking switch, no forced tool, no temperature.
    expect(sent[1]!.body).not.toHaveProperty('thinking');
    expect(sent[1]!.body).not.toHaveProperty('tool_choice');
    expect(sent[1]!.body).not.toHaveProperty('temperature');
  });

  it('with tool search, sends the search tool and defers the rest, only on a model that has it', async () => {
    const tools: AiRequest['tools'] = [
      { ...REQUEST.tools![0]! },
      {
        name: 'refund_payment',
        description: 'Refund a payment.',
        inputSchema: { type: 'object', properties: {} },
        deferred: true,
      },
    ];
    const bodyFor = async (model: string, toolSearch: boolean) => {
      const { sent, fetch } = recording(() => sse(TOOL_TURN));
      const provider = new AnthropicProvider({
        apiKey: 'k',
        model,
        fetch,
        maxRetries: 0,
        toolSearch,
      });
      await provider.stream({ ...REQUEST, tools });
      return { provider, body: sent[0]!.body };
    };

    const opus = await bodyFor('claude-opus-5-5', true);
    expect(opus.provider.toolSearch).toBe(true);
    expect(opus.body['tools']).toEqual([
      { type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' },
      {
        name: 'search_customers',
        description: 'Find customers.',
        input_schema: tools[0]!.inputSchema,
      },
      {
        name: 'refund_payment',
        description: 'Refund a payment.',
        input_schema: { type: 'object', properties: {} },
        defer_loading: true,
      },
    ]);

    // Claude Sonnet 5 has no tool search: every tool goes as it always did.
    const sonnet = await bodyFor('claude-sonnet-5', true);
    expect(sonnet.provider.toolSearch).toBe(false);
    const sent = sonnet.body['tools'] as Record<string, unknown>[];
    expect(sent.map((t) => t['name'])).toEqual(['search_customers', 'refund_payment']);
    expect(sent.some((t) => 'defer_loading' in t)).toBe(false);
    // Nor when it's turned off.
    expect((await bodyFor('claude-opus-5-5', false)).provider.toolSearch).toBe(false);
    expect(searchesTools('claude-opus-5')).toBe(true);
    expect(searchesTools('claude-haiku-4-5-20251001')).toBe(true);
  });

  it('thinks as it was told (effort, or not at all), warming the same way, only on a model that takes it', async () => {
    const warmed = () =>
      new Response(
        JSON.stringify({
          id: 'msg_warm',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-5-5',
          content: [],
          stop_reason: 'max_tokens',
          stop_sequence: null,
          usage: {
            input_tokens: 12,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 5100,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const bodiesFor = async (model: string) => {
      let calls = 0;
      const { sent, fetch } = recording(() => (++calls > 1 ? sse(TOOL_TURN) : warmed()));
      const provider = new AnthropicProvider({
        apiKey: 'k',
        model,
        fetch,
        maxRetries: 0,
        effort: 'low',
        thinkingOff: true,
        toolEachTurn: true,
      });
      await provider.warm(REQUEST);
      await provider.stream(REQUEST);
      return { provider, warm: sent[0]!.body, turn: sent[1]!.body };
    };

    // Claude Haiku 5.5, as on a call: the warm-up asks the same way as the turn, so the turn finds it ready.
    const haiku = await bodiesFor('claude-haiku-5-5');
    expect(haiku.provider.effort).toBe('low');
    expect(haiku.warm['output_config']).toEqual({ effort: 'low' });
    expect(haiku.turn['output_config']).toEqual({ effort: 'low' });
    expect(haiku.warm['thinking']).toEqual({ type: 'disabled' });
    expect(haiku.turn['thinking']).toEqual({ type: 'disabled' });
    // Without thinking it calls a tool every turn, rather than writing one out as text; the warm-up refuses that.
    expect(haiku.turn['tool_choice']).toEqual({ type: 'any' });
    expect(haiku.warm).not.toHaveProperty('tool_choice');

    // Claude Haiku 4.5 refuses an effort level, so none is sent.
    const older = await bodiesFor('claude-haiku-4-5');
    expect(older.provider.effort).toBeNull();
    expect(older.warm).not.toHaveProperty('output_config');
    expect(older.turn).not.toHaveProperty('output_config');
    expect(older.turn['thinking']).toEqual({ type: 'disabled' });
    expect(takesEffort('claude-opus-5-5')).toBe(true);
    expect(takesEffort('claude-sonnet-4-5-20250929')).toBe(false);

    // Claude Sonnet 5.5 refuses to turn thinking off, so it thinks as it always does.
    const sonnet = await bodiesFor('claude-sonnet-5-5');
    expect(sonnet.provider.thinkingOff).toBe(false);
    expect(sonnet.warm).not.toHaveProperty('thinking');
    expect(sonnet.turn).not.toHaveProperty('thinking');
    expect(sonnet.turn).not.toHaveProperty('tool_choice');
    expect(turnsThinkingOff('claude-opus-5-5')).toBe(false);
    expect(turnsThinkingOff('claude-opus-5')).toBe(true);
    expect(turnsThinkingOff('claude-haiku-4-5-20251001')).toBe(true);
  });

  it('thinks harder from a step on with an effort-only message there, where the model can, leaving the rest alone', async () => {
    const harder: AiRequest = { ...REQUEST, effortFrom: { at: 2, effort: 'high' } };
    const sentFor = async (options: { model: string; effort?: 'low' | 'high'; off?: boolean }) => {
      const { sent, fetch } = recording(() => sse(TOOL_TURN));
      const provider = new AnthropicProvider({
        apiKey: 'k',
        model: options.model,
        fetch,
        maxRetries: 0,
        ...(options.effort ? { effort: options.effort } : {}),
        ...(options.off ? { thinkingOff: true } : {}),
      });
      await provider.stream(harder);
      await provider.stream(REQUEST);
      return { provider, harder: sent[0]!, plain: sent[1]! };
    };

    const opus = await sentFor({ model: 'claude-opus-5-5', effort: 'low' });
    expect(opus.provider.thinksHarderAt('high')).toBe(true);
    expect(opus.provider.thinksHarderAt('low')).toBe(false);
    const messages = opus.harder.body['messages'] as { role: string }[];
    // Just before the step's results, after the turn that asked for them; the asked-for level stays low on top.
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'system', 'user']);
    expect(messages[2]).toEqual({ role: 'system', content: [], output_config: { effort: 'high' } });
    expect(opus.harder.body['output_config']).toEqual({ effort: 'low' });
    expect(opus.harder.beta).toContain('mid-conversation-output-config-2026-07-01');
    // A request that doesn't ask sends neither.
    expect((opus.plain.body['messages'] as unknown[]).length).toBe(3);
    expect(opus.plain.beta ?? '').not.toContain('mid-conversation-output-config');

    // Already at that level, not thinking, or a model that refuses it: the request goes as it always did.
    for (const other of [
      await sentFor({ model: 'claude-opus-5-5', effort: 'high' }),
      await sentFor({ model: 'claude-opus-5', effort: 'low', off: true }),
      await sentFor({ model: 'claude-fable-5', effort: 'low' }),
      await sentFor({ model: 'claude-opus-5-5' }),
    ]) {
      expect(other.provider.thinksHarderAt('high')).toBe(false);
      expect((other.harder.body['messages'] as unknown[]).length).toBe(3);
      expect(other.harder.beta ?? '').not.toContain('mid-conversation-output-config');
    }
    expect(changesEffortPartway('claude-sonnet-5-5')).toBe(true);
    expect(changesEffortPartway('claude-fable-5')).toBe(false);
    expect(changesEffortPartway('claude-opus-5-5-20261001')).toBe(true);
  });

  it('keeps a tool search in the turn, hands it back as it came, and reports a paused turn', async () => {
    const search = {
      type: 'server_tool_use',
      id: 'srvtoolu_1',
      name: 'tool_search_tool_bm25',
      input: { query: 'refund' },
    };
    const found = {
      type: 'tool_search_tool_result',
      tool_use_id: 'srvtoolu_1',
      content: {
        type: 'tool_search_tool_search_result',
        tool_references: [{ type: 'tool_reference', tool_name: 'refund_payment' }],
      },
    };
    const [start] = TOOL_TURN;
    const paused = [
      start,
      [
        'content_block_start',
        { type: 'content_block_start', index: 0, content_block: { ...search, input: {} } },
      ],
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"query":"refund"}' },
        },
      ],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['content_block_start', { type: 'content_block_start', index: 1, content_block: found }],
      ['content_block_stop', { type: 'content_block_stop', index: 1 }],
      [
        'message_delta',
        {
          type: 'message_delta',
          delta: { stop_reason: 'pause_turn', stop_sequence: null },
          usage: { output_tokens: 12 },
        },
      ],
      ['message_stop', { type: 'message_stop' }],
    ] as const;
    const { sent, fetch } = recording(() => sse(paused));
    const provider = new AnthropicProvider({
      apiKey: 'k',
      model: 'claude-opus-5-5',
      fetch,
      maxRetries: 0,
      toolSearch: true,
    });
    const turn = await provider.stream(REQUEST);
    expect(turn.stopReason).toBe('pause_turn');
    expect(turn.content).toEqual([
      { type: 'passthrough', block: search },
      { type: 'passthrough', block: found },
    ]);
    await provider.stream({
      ...REQUEST,
      messages: [...REQUEST.messages, { role: 'assistant', content: turn.content! }],
    });
    const messages = sent[1]!.body['messages'] as { content: unknown }[];
    expect(messages.at(-1)!.content).toEqual([search, found]);
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

  it('sends an effort beside the schema', async () => {
    const { sent, fetch } = recording(() => sse(JSON_TURN));
    await new AnthropicProvider({
      apiKey: 'k',
      model: 'claude-haiku-5-5',
      fetch,
      maxRetries: 0,
      effort: 'low',
    }).stream({
      system: 'Suggest knowledge items.',
      messages: [{ role: 'user', content: 'Hours?' }],
      responseFormat: { schema: ITEMS_SCHEMA },
    });
    expect(sent[0]!.body['output_config']).toMatchObject({
      effort: 'low',
      format: { type: 'json_schema' },
    });
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
