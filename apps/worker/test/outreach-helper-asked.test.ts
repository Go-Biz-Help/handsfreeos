import { AiProviderError, structuredOutputSchema } from '@hfos/ai';
import { HELPER_SCHEMA } from '@hfos/core/addons/outreach/helper';
import { LIKE_PICK_SCHEMA } from '@hfos/core/addons/outreach/like-pick';
import { describe, expect, it } from 'vitest';
import { notAskedWords } from '../src/addons/outreach/helper';
import { AI_BUSY_MESSAGE, AiAskError } from '../src/ai/ask';

/** Every enum in a schema as sent, at any depth. */
function enums(node: unknown): unknown[][] {
  if (Array.isArray(node)) return node.flatMap(enums);
  if (!node || typeof node !== 'object') return [];
  const own = Array.isArray((node as { enum?: unknown }).enum)
    ? [(node as { enum: unknown[] }).enum]
    : [];
  return [...own, ...Object.values(node).flatMap(enums)];
}

describe('the outreach helper when the AI isn’t asked', () => {
  it('sends the helper’s and the like picker’s answers with no null inside an enum', () => {
    for (const schema of [HELPER_SCHEMA, LIKE_PICK_SCHEMA]) {
      const sent = enums(structuredOutputSchema(schema));
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.filter((e) => e.includes(null))).toEqual([]);
    }
  });

  it('keeps the AI service’s own reason when it turned the request down', () => {
    const refused = new AiProviderError(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Schema is too complex"}}',
      'bad_request',
      false,
      400,
    );
    const words = notAskedWords(
      new AiAskError('provider_error', 'The AI couldn’t answer.', false, { cause: refused }),
    );
    expect(words).toMatch(/^The AI couldn’t answer\. The AI service said: 400 /);
    expect(words).toContain('Schema is too complex');
  });

  it('says only HandsFreeOS’s words when the AI was busy, stopped, or out of budget', () => {
    const busy = new AiProviderError('overloaded', 'overloaded', true, 529);
    expect(
      notAskedWords(new AiAskError('provider_error', AI_BUSY_MESSAGE, true, { cause: busy })),
    ).toBe(AI_BUSY_MESSAGE);
    const stopped = new AiProviderError('Stopped', 'aborted', false);
    expect(
      notAskedWords(new AiAskError('provider_error', 'Stopped.', false, { cause: stopped })),
    ).toBe('Stopped.');
    expect(notAskedWords(new AiAskError('budget_reached', 'Today’s AI limit is reached.'))).toBe(
      'Today’s AI limit is reached.',
    );
  });
});
