import { describe, expect, it } from 'vitest';
import { ScriptedProvider, type AiMessage } from '@hfos/ai';

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
