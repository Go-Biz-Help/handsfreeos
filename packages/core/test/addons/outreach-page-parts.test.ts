/**
 * Needs you's and Today's parts (docs/outreach.md, decision 193): a row at the top of each, the way People has its
 * views, on the web and the phone alike.
 */
import { describe, expect, it } from 'vitest';
import {
  autopilotWaitingOf,
  leftForToday,
  NEEDS_PART_KEYS,
  needsCountsOf,
  needsPartOpen,
  needsPartsShown,
  readNeedsPart,
  readTodayPart,
  TODAY_PART_KEYS,
  todayListCount,
  todayPartsFor,
} from '../../src/addons/outreach/page-parts';
import { WAITING_KIND_KEYS } from '../../src/addons/outreach/waiting-words';

describe('Needs you’s parts', () => {
  it('keep decision 42’s order, with Autopilot’s list first and Not sure where they live last', () => {
    expect(NEEDS_PART_KEYS).toEqual([
      'autopilot',
      'ask',
      'hands',
      'reply',
      'message',
      'need',
      'request',
      'unsure',
    ]);
    // Every kind that waits has a part, in the list's own order.
    expect(
      NEEDS_PART_KEYS.filter((k) => (WAITING_KIND_KEYS as readonly string[]).includes(k)),
    ).toEqual([...WAITING_KIND_KEYS]);
  });

  it('open on the first with anything in it, or the one asked for even once it’s empty', () => {
    const counts = needsCountsOf({
      kinds: {
        ask: { count: 0 },
        reply: { count: 0 },
        message: { count: 3 },
        need: { count: 2 },
        request: { count: 0 },
      },
      hands: 0,
      autopilot: 0,
    });
    expect(needsPartOpen(null, counts)).toBe('message');
    expect(needsPartsShown('message', counts)).toEqual(['message', 'need']);
    // Asked for, and empty now: it stays on the row while it's open.
    expect(needsPartOpen('request', counts)).toBe('request');
    expect(needsPartsShown('request', counts)).toEqual(['message', 'need', 'request']);
  });

  it('have no row, and nothing open, while nothing waits', () => {
    const counts = needsCountsOf({ kinds: { message: { count: 0 } }, hands: 0, unsure: 0 });
    expect(needsPartOpen(null, counts)).toBeNull();
    expect(needsPartsShown(null, counts)).toEqual([]);
  });

  it('leave out a part whose count isn’t known (the phone with no signal)', () => {
    const counts = needsCountsOf({ kinds: { reply: { count: 1 }, message: { count: 0 } } });
    expect(counts).toEqual({ reply: 1, message: 0 });
    expect(needsPartsShown(null, counts)).toEqual(['reply']);
  });

  it('count Autopilot’s people only while its list is first, waiting for the OK', () => {
    const people = [
      { state: 'waiting' as const },
      { state: 'ok' as const },
      { state: 'waiting' as const },
    ];
    expect(autopilotWaitingOf({ on: true, made: true, people })).toBe(2);
    expect(autopilotWaitingOf({ on: true, made: false, people: [] })).toBe(0);
    expect(autopilotWaitingOf({ on: false, made: true, people })).toBe(0);
    expect(autopilotWaitingOf(null)).toBe(0);
  });

  it('read from an address, never one they don’t know', () => {
    expect(readNeedsPart('need')).toBe('need');
    expect(readNeedsPart('nope')).toBeNull();
    expect(readNeedsPart(undefined)).toBeNull();
  });
});

describe('Today’s parts', () => {
  it('are Overview, Your list, Posts and events, Done today, and Your team for owners and admins', () => {
    expect(TODAY_PART_KEYS).toEqual(['overview', 'list', 'posts', 'done', 'team']);
    expect(todayPartsFor(true)).toEqual(['overview', 'list', 'posts', 'done', 'team']);
    expect(todayPartsFor(false)).toEqual(['overview', 'list', 'posts', 'done']);
  });

  it('open on the Overview, and never on Your team for someone who doesn’t manage', () => {
    expect(readTodayPart(undefined, true)).toBe('overview');
    expect(readTodayPart('list', false)).toBe('list');
    expect(readTodayPart('team', true)).toBe('team');
    expect(readTodayPart('team', false)).toBe('overview');
    expect(readTodayPart('nope', true)).toBe('overview');
  });

  it('count the list less the messages Needs you shows already', () => {
    const send = (sendId: string, state: 'waiting' | 'approved') => ({ send: { sendId, state } });
    const today = {
      items: [send('a', 'waiting'), send('b', 'waiting'), send('c', 'approved'), { send: null }],
      partners: [send('d', 'waiting')],
    };
    const underNeeds = new Set(['a', 'c', 'd']);
    // An OK'd one stays: only a message still waiting is shown under Needs you.
    expect(leftForToday(today.items, underNeeds)).toHaveLength(3);
    expect(todayListCount(today, underNeeds)).toBe(3);
    expect(todayListCount(today, new Set())).toBe(5);
  });
});
