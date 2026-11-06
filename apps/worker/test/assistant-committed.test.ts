import { describe, expect, it } from 'vitest';
import { KEPT_ANSWER_MAX, keptAnswer } from '../src/assistant/committed';

/**
 * What a change confirmed on a card leaves for the model (assistant/committed.ts): the command's answer, kept with
 * the tool call so a later question can read it, the way a command receipt keeps one.
 */

describe('the answer kept after Confirm', () => {
  it('keeps what the command answered, without anything credential-looking or shown only once', () => {
    expect(
      keptAnswer(
        {
          videoLinkId: 'v1',
          token: 'abc',
          path: '/v/abc',
          expiresAt: '2026-11-13T00:00:00.000Z',
          nested: { apiKey: 'k', name: 'Rosa' },
        },
        ['token', 'path'],
      ),
    ).toEqual({
      videoLinkId: 'v1',
      expiresAt: '2026-11-13T00:00:00.000Z',
      nested: { name: 'Rosa' },
    });
    expect(keptAnswer({ grantId: 'g1', claimToken: 'secret' }, ['claimToken'])).toEqual({
      grantId: 'g1',
    });
  });

  it('keeps nothing when there was no answer, and cuts a long one short', () => {
    expect(keptAnswer(undefined)).toBeNull();
    const long = keptAnswer({
      items: Array.from({ length: 500 }, (_, i) => ({ id: `item-${i}` })),
    });
    expect(long).toMatchObject({ cutShort: true });
    expect((long as { data: string }).data.length).toBe(KEPT_ANSWER_MAX + 1);
  });
});
