/**
 * Search's slot gate, on its own (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, How it works, 6): three searches at once
 * on a machine, a fourth waits up to its timeout and gives up, a released slot lets the next one in, and a search that
 * throws gives its slot back. Real local searches finish in milliseconds, so a route can't hold a slot long enough
 * to test this through the API.
 */
import { describe, expect, it } from 'vitest';
import { createSlotGate, SEARCH_SLOTS, searchSlots } from '../src/search-slots';

describe('the search slot gate', () => {
  it('holds three at once, and the fourth waits, then gives up after its timeout', async () => {
    const gate = createSlotGate(3);
    const held = await Promise.all([1, 2, 3].map(() => gate.acquireSlot(1_000)));
    expect(held.every((r) => typeof r === 'function')).toBe(true);
    expect(gate.held).toBe(3);
    const started = Date.now();
    const fourth = await gate.acquireSlot(80);
    expect(fourth).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    expect(gate.waiting).toBe(0);
    held.forEach((release) => release!());
    expect(gate.held).toBe(0);
  });

  it('lets the next one in as soon as a slot is released, first come first served', async () => {
    const gate = createSlotGate(1);
    const first = await gate.acquireSlot(1_000);
    const order: string[] = [];
    const second = gate.acquireSlot(1_000).then((r) => (order.push('second'), r));
    const third = gate.acquireSlot(1_000).then((r) => (order.push('third'), r));
    expect(gate.waiting).toBe(2);
    first!();
    const releaseSecond = await second;
    expect(order).toEqual(['second']);
    expect(gate.held).toBe(1);
    releaseSecond!();
    (await third)!();
    expect(order).toEqual(['second', 'third']);
    expect(gate.held).toBe(0);
  });

  it('gives a slot back once, however often it is released, and after a throw', async () => {
    const gate = createSlotGate(2);
    const release = await gate.acquireSlot(1_000);
    release!();
    release!();
    expect(gate.held).toBe(0);
    const run = async () => {
      const r = await gate.acquireSlot(1_000);
      try {
        throw new Error('the search failed');
      } finally {
        r!();
      }
    };
    await expect(run()).rejects.toThrow('the search failed');
    await expect(run()).rejects.toThrow('the search failed');
    await expect(run()).rejects.toThrow('the search failed');
    expect(gate.held).toBe(0);
    expect(gate.waiting).toBe(0);
  });

  it('is three slots on each machine', () => {
    expect(SEARCH_SLOTS).toBe(3);
    expect(searchSlots.held).toBe(0);
  });
});
