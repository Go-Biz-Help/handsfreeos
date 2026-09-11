import { expect, it } from 'vitest';
import { isDenylistedKey, redact } from '../src/kernel/redact';

it('drops credential-looking keys at any depth and keeps everything else', () => {
  const out = redact({
    email: 'a@b.c',
    token_hash: 'x',
    tokenHash: 'x',
    password: 'x',
    apiKey: 'x',
    secret: 'x',
    nested: { name: 'ok', private_key: 'x', when: new Date('2026-09-11T00:00:00Z') },
    list: ['keeps', 'arrays'],
  });
  expect(out).toEqual({
    email: 'a@b.c',
    nested: { name: 'ok', when: '2026-09-11T00:00:00.000Z' },
    list: ['keeps', 'arrays'],
  });
});

it('does not over-match ordinary words', () => {
  for (const k of ['monkey', 'keyboard', 'hashtag', 'tokens_used_note', 'name'])
    expect(isDenylistedKey(k), k).toBe(false);
  for (const k of ['token', 'access_token', 'token_hash', 'password', 'api_key', 'apiKey'])
    expect(isDenylistedKey(k), k).toBe(true);
});
