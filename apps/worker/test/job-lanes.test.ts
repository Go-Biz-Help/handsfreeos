import { describe, expect, it } from 'vitest';
import { createLanes, SLOW_MS } from '../src/job-runner';

/**
 * How the worker's places for jobs are counted (job-runner.ts): how many jobs may start, how many of them slow
 * ones, and whether a heavy one. No database: the claim that asks with these numbers is in job-runner.test.ts.
 */

const lanes = () =>
  createLanes({
    slots: 6,
    slowSlots: 3,
    heavyKinds: ['file.text', 'pictures'],
    promptKinds: ['ai_teammate.reply'],
  });

/** Runs a job of `kind` from `from` for `ms`. */
function ran(l: ReturnType<typeof lanes>, id: string, kind: string, from: number, ms: number) {
  l.started(id, kind, from);
  l.ended(id, from + ms);
}

describe('the places for jobs', () => {
  it('has every place free to start with, three of them for slow jobs, and a heavy job may start', () => {
    expect(lanes().room(0)).toEqual({ free: 6, slow: 3, heavy: true });
  });

  it('counts a running job against the free places, and gives the place back when it ends', () => {
    const l = lanes();
    l.started('a', 'push.send', 0);
    l.started('b', 'push.send', 0);
    expect(l.room(10)).toEqual({ free: 4, slow: 3, heavy: true });
    expect(l.ids().sort()).toEqual(['a', 'b']);
    l.ended('a', 20);
    expect(l.room(20).free).toBe(5);
    expect(l.ids()).toEqual(['b']);
  });

  it('never has more free places than there are, with every one taken', () => {
    const l = lanes();
    for (let i = 0; i < 6; i++) l.started(`j${i}`, 'push.send', 0);
    expect(l.room(1)).toEqual({ free: 0, slow: 0, heavy: false });
  });

  it('takes a job that has run for a while as a slow one, whatever its kind', () => {
    const l = lanes();
    l.started('a', 'calendar.refresh', 0);
    expect(l.room(SLOW_MS - 1)).toEqual({ free: 5, slow: 3, heavy: true });
    expect(l.room(SLOW_MS)).toEqual({ free: 5, slow: 2, heavy: true });
  });

  it('learns a kind is slow from two slow runs, and then counts it as slow from its start', () => {
    const l = lanes();
    ran(l, 'a', 'outreach.check_people', 0, 5_000);
    expect(l.slowKinds()).toEqual([]);
    ran(l, 'b', 'outreach.check_people', 10_000, 5_000);
    expect(l.slowKinds()).toEqual(['outreach.check_people']);
    l.started('c', 'outreach.check_people', 20_000);
    expect(l.room(20_000)).toEqual({ free: 5, slow: 2, heavy: true });
  });

  it('does not call a quick kind slow for one slow run among quick ones', () => {
    const l = lanes();
    ran(l, 'a', 'push.send', 0, 50);
    ran(l, 'b', 'push.send', 100, 60_000);
    ran(l, 'c', 'push.send', 70_000, 50);
    expect(l.slowKinds()).toEqual([]);
  });

  it('forgets a kind was slow once most of its last runs were quick', () => {
    const l = lanes();
    ran(l, 'a', 'reviews.sync', 0, 3_000);
    ran(l, 'b', 'reviews.sync', 10_000, 3_000);
    expect(l.slowKinds()).toEqual(['reviews.sync']);
    ran(l, 'c', 'reviews.sync', 20_000, 100);
    expect(l.slowKinds()).toEqual(['reviews.sync']);
    ran(l, 'd', 'reviews.sync', 30_000, 100);
    expect(l.slowKinds()).toEqual([]);
  });

  it('leaves no slow place when three slow jobs run, and still has places for quick ones', () => {
    const l = lanes();
    for (const id of ['a', 'b', 'c']) l.started(id, 'calendar.refresh', 0);
    expect(l.room(SLOW_MS)).toEqual({ free: 3, slow: 0, heavy: false });
  });

  it('runs one heavy job at a time, in a slow place', () => {
    const l = lanes();
    l.started('a', 'file.text', 0);
    // Slow from its start, and no second heavy one beside it.
    expect(l.room(0)).toEqual({ free: 5, slow: 2, heavy: false });
    l.ended('a', 30_000);
    expect(l.room(30_000)).toEqual({ free: 6, slow: 3, heavy: true });
    // A heavy kind is never listed as a learned slow kind: it has its own lane.
    ran(l, 'b', 'file.text', 40_000, 30_000);
    expect(l.slowKinds()).toEqual([]);
  });

  it('never takes a kind somebody is waiting on as slow, however long it runs', () => {
    const l = lanes();
    ran(l, 'a', 'ai_teammate.reply', 0, 8_000);
    ran(l, 'b', 'ai_teammate.reply', 10_000, 8_000);
    expect(l.slowKinds()).toEqual([]);
    l.started('c', 'ai_teammate.reply', 20_000);
    expect(l.room(30_000)).toEqual({ free: 5, slow: 3, heavy: true });
  });

  it('gives slow jobs no more places than are free', () => {
    const l = lanes();
    for (let i = 0; i < 5; i++) l.started(`j${i}`, 'push.send', 0);
    expect(l.room(1)).toEqual({ free: 1, slow: 1, heavy: true });
  });

  it('takes no notice of a job it was never told had started', () => {
    const l = lanes();
    l.ended('nobody', 5);
    expect(l.room(5)).toEqual({ free: 6, slow: 3, heavy: true });
  });
});
