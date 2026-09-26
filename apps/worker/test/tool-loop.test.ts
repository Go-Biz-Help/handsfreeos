import {
  addUsage,
  AiProviderError,
  emptyUsage,
  ScriptedProvider,
  totalTokens,
  type AiMessage,
  type AiProvider,
  type AiRequest,
  type AiUsage,
} from '@hfos/ai';
import { describe, expect, it } from 'vitest';
import { runToolLoop, type ToolLoopAnswer, type ToolLoopInput } from '../src/ai/tool-loop';

const tool = (name: string) => ({
  name,
  description: `The ${name} tool.`,
  inputSchema: { type: 'object', properties: {} },
});
const TOOLS = [tool('look_up'), tool('reply'), tool('add_note')];

/** The stand-in model: it answers the hours straight away, looks the price up first, and replies through tools. */
const scripted = new ScriptedProvider([
  { when: /hours/i, reply: () => 'We open at 7 and close at 5.' },
  {
    when: /price/i,
    calls: () => [{ name: 'look_up', arguments: { about: 'price' } }],
    reply: (_q, results) => `The list says ${results['look_up']}`,
  },
  {
    when: /on my way/i,
    calls: () => [
      { name: 'reply', arguments: { text: 'On my way!' } },
      { name: 'add_note', arguments: { text: 'Told them' } },
    ],
    reply: () => 'Never asked for: the reply ends the turn.',
  },
]);

/** The scripted model shown only the question, so it asks for its tools every turn and never answers. */
const restless: AiProvider = {
  id: 'restless',
  model: 'scripted',
  stream: (request, options) =>
    scripted.stream({ ...request, messages: request.messages.slice(0, 1) }, options),
};

/** The same model, keeping what each call was sent (the conversation as it was then). */
function recorded(provider: AiProvider): { provider: AiProvider; requests: AiRequest[] } {
  const requests: AiRequest[] = [];
  return {
    requests,
    provider: {
      id: provider.id,
      model: provider.model,
      stream: (request, options) => {
        requests.push({ ...request, messages: [...request.messages] });
        return provider.stream(request, options);
      },
    },
  };
}

const question = (text: string): AiMessage[] => [{ role: 'user', content: text }];

function loop(input: Partial<ToolLoopInput> & Pick<ToolLoopInput, 'provider' | 'messages'>) {
  return runToolLoop({
    system: 'You help a small business.',
    tools: TOOLS,
    maxRounds: 8,
    maxTokens: 1024,
    execute: async (): Promise<ToolLoopAnswer> => ({ content: { ok: true } }),
    ...input,
  });
}

describe('runToolLoop', () => {
  it('ends when the model answers, with the text it streamed', async () => {
    const { provider, requests } = recorded(scripted);
    const deltas: string[] = [];
    const r = await loop({
      provider,
      messages: question('What are your hours?'),
      onText: (d) => deltas.push(d),
    });
    expect(r).toMatchObject({
      text: 'We open at 7 and close at 5.',
      stoppedBy: 'end_turn',
      rounds: 0,
      toolCalls: [],
      retryable: false,
    });
    expect(r.error).toBeUndefined();
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe(r.text);
    expect(requests).toHaveLength(1);
    expect(r.messages).toEqual([
      ...question('What are your hours?'),
      { role: 'assistant', content: r.text },
    ]);
  });

  it('runs the tools the model asks for, then ends with its answer', async () => {
    const { provider, requests } = recorded(scripted);
    const asked = question('What is the price of a tune-up?');
    const r = await loop({
      provider,
      messages: asked,
      execute: async (call) => ({ content: { [call.name]: '$89' } }),
    });
    expect(r).toMatchObject({
      text: 'The list says {"look_up":"$89"}',
      stoppedBy: 'end_turn',
      rounds: 1,
    });
    expect(r.toolCalls).toEqual([
      {
        id: expect.any(String),
        name: 'look_up',
        arguments: { about: 'price' },
        round: 1,
        content: '{"look_up":"$89"}',
        isError: false,
        stop: false,
      },
    ]);
    expect(requests).toHaveLength(2);
    expect(r.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    // The caller's conversation is left as it was.
    expect(asked).toHaveLength(1);
  });

  it('stops at the round cap without running the calls past it', async () => {
    const { provider, requests } = recorded(restless);
    const ran: number[] = [];
    const r = await loop({
      provider,
      messages: question('What is the price?'),
      maxRounds: 3,
      execute: async () => {
        ran.push(requests.length);
        return { content: 'ok' };
      },
    });
    expect(r).toMatchObject({ stoppedBy: 'max_rounds', rounds: 4, retryable: false });
    expect(ran).toEqual([1, 2, 3]);
    expect(r.toolCalls.map((c) => c.round)).toEqual([1, 2, 3]);
    expect(requests).toHaveLength(4);
    // The fourth turn's calls never reach the conversation: it ends with the third round's results.
    expect(r.messages).toHaveLength(1 + 3 * 2);
    expect(r.messages.at(-1)?.role).toBe('user');
  });

  it('checks the budget before every model call, stopping when it runs out between rounds', async () => {
    const { provider, requests } = recorded(scripted);
    const seen: AiUsage[] = [];
    const r = await loop({
      provider,
      messages: question('What is the price?'),
      checkBudget: (used) => {
        seen.push(used);
        return totalTokens(used) === 0;
      },
    });
    expect(r).toMatchObject({ stoppedBy: 'budget', rounds: 1, text: '' });
    expect(r.toolCalls).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(totalTokens(r.usage)).toBeGreaterThan(0);
    expect(seen).toEqual([emptyUsage, r.usage]);

    const none = recorded(scripted);
    const spent = await loop({
      provider: none.provider,
      messages: question('What are your hours?'),
      checkBudget: async () => false,
    });
    expect(spent).toMatchObject({ stoppedBy: 'budget', rounds: 0, text: '', usage: emptyUsage });
    expect(none.requests).toHaveLength(0);
  });

  it('feeds a tool’s error back to the model, which answers from it', async () => {
    const { provider, requests } = recorded(scripted);
    const r = await loop({
      provider,
      messages: question('What is the price?'),
      execute: async () => ({ content: { error: 'The price list is empty.' }, isError: true }),
    });
    expect(r).toMatchObject({
      stoppedBy: 'end_turn',
      text: 'The list says {"error":"The price list is empty."}',
    });
    expect(r.toolCalls[0]).toMatchObject({
      isError: true,
      content: '{"error":"The price list is empty."}',
    });
    expect(requests[1]!.messages.at(-1)).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          callId: r.toolCalls[0]!.id,
          content: '{"error":"The price list is empty."}',
          isError: true,
        },
      ],
    });
  });

  it('ends after the round when a tool says stop, running the round’s other calls first', async () => {
    const { provider, requests } = recorded(scripted);
    const r = await loop({
      provider,
      messages: question('Tell them I’m on my way'),
      execute: async (call) => ({ content: { done: call.name }, stop: call.name === 'reply' }),
    });
    expect(r).toMatchObject({ stoppedBy: 'end_turn', rounds: 1, text: '' });
    expect(r.toolCalls.map((c) => [c.name, c.stop])).toEqual([
      ['reply', true],
      ['add_note', false],
    ]);
    expect(requests).toHaveLength(1);
    const last = r.messages.at(-1)!;
    expect(last.role).toBe('user');
    expect(Array.isArray(last.content) && last.content.map((c) => c.type)).toEqual([
      'tool_result',
      'tool_result',
    ]);
  });

  it('stops when aborted, between rounds or partway through the answer', async () => {
    const stop = new AbortController();
    const { provider, requests } = recorded(scripted);
    const r = await loop({
      provider,
      messages: question('What is the price?'),
      signal: stop.signal,
      execute: async () => {
        stop.abort();
        return { content: 'ok' };
      },
    });
    expect(r).toMatchObject({ stoppedBy: 'aborted', rounds: 1, text: '', retryable: false });
    expect(r.error).toBeInstanceOf(AiProviderError);
    expect(r.error).toMatchObject({ code: 'aborted' });
    // The round already running finished; the next model call never started.
    expect(r.toolCalls).toHaveLength(1);
    expect(requests).toHaveLength(2);

    const midway = new AbortController();
    const partial = await loop({
      provider: scripted,
      messages: question('What are your hours?'),
      signal: midway.signal,
      onText: () => midway.abort(),
    });
    // What streamed before Stop is kept.
    expect(partial).toMatchObject({ stoppedBy: 'aborted', text: 'We ' });
  });

  it('adds up the tokens of every turn, reporting each before its tools run', async () => {
    const turns: AiUsage[] = [];
    const order: string[] = [];
    const r = await loop({
      provider: scripted,
      messages: question('What is the price?'),
      onTurnUsage: async (u) => {
        turns.push(u);
        order.push('usage');
      },
      execute: async () => {
        order.push('tool');
        return { content: 'ok' };
      },
    });
    expect(order).toEqual(['usage', 'tool', 'usage']);
    expect(turns).toHaveLength(2);
    // The scripted model's tool turn writes 20 tokens.
    expect(turns[0]!.outputTokens).toBe(20);
    expect(r.usage).toEqual(turns.reduce(addUsage, emptyUsage));
    expect(r.usage.inputTokens).toBe(turns[0]!.inputTokens + turns[1]!.inputTokens);
  });

  it('hands a turn back as the model gave it, reasoning first, and says why its last turn stopped', async () => {
    const reasoning = {
      type: 'passthrough',
      block: { type: 'thinking', thinking: '', signature: 's' },
    } as const;
    let calls = 0;
    const thinker: AiProvider = {
      id: 'thinker',
      model: 'thinker',
      stream: async () => {
        calls++;
        if (calls === 1)
          return {
            text: '',
            toolCalls: [{ id: 'c1', name: 'look_up', arguments: {} }],
            content: [reasoning, { type: 'tool_call', id: 'c1', name: 'look_up', arguments: {} }],
            stopReason: 'tool_use',
            usage: emptyUsage,
          };
        return { text: '', toolCalls: [], stopReason: 'refusal', usage: emptyUsage };
      },
    };
    const { provider, requests } = recorded(thinker);
    const out = await loop({
      provider,
      messages: question('What does it cost?'),
      execute: async () => ({ content: { price: 90 } }),
    });
    expect(requests[1]!.messages[1]).toEqual({
      role: 'assistant',
      content: [reasoning, { type: 'tool_call', id: 'c1', name: 'look_up', arguments: {} }],
    });
    expect(out.stoppedBy).toBe('end_turn');
    expect(out.lastStop).toBe('refusal');
  });

  it('carries on a turn the provider paused, as one turn', async () => {
    const search = { type: 'passthrough', block: { type: 'server_tool_use', id: 's1' } } as const;
    let calls = 0;
    const pauses: AiProvider = {
      id: 'pauses',
      model: 'pauses',
      stream: async () =>
        ++calls === 1
          ? {
              text: '',
              toolCalls: [],
              content: [search],
              stopReason: 'pause_turn',
              usage: emptyUsage,
            }
          : { text: 'Found it.', toolCalls: [], stopReason: 'end_turn', usage: emptyUsage },
    };
    const { provider, requests } = recorded(pauses);
    const out = await loop({ provider, messages: question('Refund Mike') });
    // The paused turn went back as it came, at the end, for the model to carry on from.
    expect(requests[1]!.messages.at(-1)).toEqual({ role: 'assistant', content: [search] });
    expect(out.messages.at(-1)).toEqual({
      role: 'assistant',
      content: [search, { type: 'text', text: 'Found it.' }],
    });
    expect(out.stoppedBy).toBe('end_turn');
  });

  it('ends on a failure, marking a busy provider as worth trying again', async () => {
    const busy: AiProvider = {
      id: 'busy',
      model: 'busy',
      stream: async () => {
        throw new AiProviderError('Overloaded', 'overloaded', true, 529);
      },
    };
    const r = await loop({ provider: busy, messages: question('What are your hours?') });
    expect(r).toMatchObject({ stoppedBy: 'error', retryable: true, rounds: 0 });
    expect(r.error).toMatchObject({ code: 'overloaded' });

    const broken = new Error('The database went away');
    const failed = await loop({
      provider: scripted,
      messages: question('What is the price?'),
      execute: async () => {
        throw broken;
      },
    });
    expect(failed).toMatchObject({ stoppedBy: 'error', retryable: false, rounds: 1 });
    expect(failed.error).toBe(broken);
    expect(failed.toolCalls).toHaveLength(0);
  });
});
