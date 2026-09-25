/**
 * The test worlds' own helpers: `readyTexting` gives each business a random live number, and a live number is unique
 * across every business in the shared test database, so a pick another world already holds is drawn again instead of
 * failing whichever test drew it.
 */
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeWorld, readyTexting, type World } from './booking-world';

let a: World;
let b: World;

beforeAll(async () => {
  [a, b] = await Promise.all([makeWorld('rtclash-a'), makeWorld('rtclash-b')]);
});
afterAll(async () => {
  vi.restoreAllMocks();
  await Promise.all([a.app.close(), b.app.close()]);
  await closeTestDbs();
});

describe('readyTexting', () => {
  it('draws another number when its first pick is one another business has', async () => {
    const taken = await readyTexting(a);
    // Math.random's first answer lands on the number `a` holds; after that it's random again.
    const random = vi
      .spyOn(Math, 'random')
      .mockReturnValueOnce((Number(taken.slice(-6)) + 0.5) / 1_000_000);
    const number = await readyTexting(b);
    expect(random.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(number).toMatch(/^\+18335\d{6}$/);
    expect(number).not.toBe(taken);
    expect(b.number).toBe(number);
  });
});
