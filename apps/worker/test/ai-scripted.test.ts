import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AiOutputError, parseStructured, ScriptedProvider, type AiMessage } from '@hfos/ai';

const provider = new ScriptedProvider([
  {
    when: /attention/i,
    calls: () => [{ name: 'what_needs_attention', arguments: {} }],
    reply: (_q, results) => `Found: ${results['what_needs_attention']}`,
  },
  { when: /hello/i, reply: () => 'Hi there' },
]);

const ask = (text: string): AiMessage[] => [{ role: 'user', content: text }];

describe('ScriptedProvider', () => {
  it('calls the rule’s tools, then answers from their results', async () => {
    const first = await provider.stream({ system: 's', messages: ask('What needs attention?') });
    expect(first.stopReason).toBe('tool_use');
    expect(first.toolCalls).toEqual([
      { id: expect.any(String), name: 'what_needs_attention', arguments: {} },
    ]);

    const call = first.toolCalls[0]!;
    const deltas: string[] = [];
    const second = await provider.stream(
      {
        system: 's',
        messages: [
          ...ask('What needs attention?'),
          {
            role: 'assistant',
            content: [{ type: 'tool_call', id: call.id, name: call.name, arguments: {} }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', callId: call.id, content: '3 things' }],
          },
        ],
      },
      { onText: (d) => deltas.push(d) },
    );
    expect(second).toMatchObject({
      text: 'Found: 3 things',
      stopReason: 'end_turn',
      toolCalls: [],
    });
    expect(deltas.join('')).toBe('Found: 3 things');
    expect(second.usage.outputTokens).toBeGreaterThan(0);
  });

  it('answers straight away when a rule calls nothing, and falls back when none matches', async () => {
    expect((await provider.stream({ system: 's', messages: ask('hello') })).text).toBe('Hi there');
    const other = await provider.stream({ system: 's', messages: ask('Paint the house') });
    expect(other.stopReason).toBe('end_turn');
    expect(other.text).toMatch(/look things up/);
  });

  it('stops when asked to', async () => {
    const stop = new AbortController();
    stop.abort();
    await expect(
      provider.stream({ system: 's', messages: ask('hello') }, { signal: stop.signal }),
    ).rejects.toMatchObject({ code: 'aborted', retryable: false });
  });
});

describe('ScriptedProvider with structured requests', () => {
  const Answer = z.object({
    answer: z.string(),
    usedItemIds: z.array(z.string()),
    unanswered: z.boolean(),
  });
  const both = new ScriptedProvider([
    { when: /hours/i, reply: () => 'We open at 7.' },
    {
      when: /hours/i,
      json: (question, context) => ({
        answer: `${question} (${context})`,
        usedItemIds: [],
        unanswered: false,
      }),
    },
  ]);
  const structured = { schema: { type: 'object' } };

  it('answers a structured request from a rule with json, and a plain one from a rule with reply', async () => {
    const turn = await both.stream({
      system: 's',
      context: 'profile',
      messages: ask('What are your hours?'),
      responseFormat: structured,
    });
    expect(turn.stopReason).toBe('end_turn');
    expect(parseStructured(turn, Answer)).toEqual({
      answer: 'What are your hours? (profile)',
      usedItemIds: [],
      unanswered: false,
    });
    expect((await both.stream({ system: 's', messages: ask('What are your hours?') })).text).toBe(
      'We open at 7.',
    );
  });

  it('falls back to prose when no rule answers in JSON, which parseStructured refuses', async () => {
    const turn = await provider.stream({
      system: 's',
      messages: ask('hello'),
      responseFormat: structured,
    });
    expect(() => parseStructured(turn, Answer)).toThrow(AiOutputError);
  });
});
