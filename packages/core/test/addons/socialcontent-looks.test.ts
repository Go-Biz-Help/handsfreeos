/**
 * The Calendar's List, Week and Month looks, and picking many posts on it (the owner, 15 Nov 2026): the days each look
 * shows, which filter a post falls under, and which picked posts each button acts on. The web and the phone both read
 * these.
 */
import { describe, expect, it } from 'vitest';
import {
  filterCounts,
  inTurns,
  lookRange,
  monthGridFrom,
  monthMoved,
  monthShown,
  picks,
  shows,
  summaryOf,
  weekShown,
  weekStartOf,
  type PickedLike,
} from '../../src/addons/socialcontent/calendar-looks';
import { SOCIALCONTENT_WORDS as W } from '../../src/addons/socialcontent/words';

describe('the Calendar’s looks', () => {
  it('starts weeks on Monday, and a month’s grid on the Monday before its first', () => {
    expect(weekStartOf('2026-11-14')).toBe('2026-11-09');
    expect(weekStartOf('2026-11-09')).toBe('2026-11-09');
    expect(weekStartOf('2026-11-15')).toBe('2026-11-09');
    expect(monthGridFrom('2026-11-14')).toBe('2026-10-26');
    expect(monthGridFrom('2026-06-20')).toBe('2026-06-01');
    expect(monthMoved('2026-12-01', 1)).toBe('2027-01-01');
    expect(monthMoved('2026-01-01', -1)).toBe('2025-12-01');
    expect(lookRange('month', '2026-11-14', '2026-11-14')).toEqual({
      from: '2026-10-26',
      days: 42,
    });
    expect(lookRange('week', '2026-11-14', '2026-11-14')).toEqual({ from: '2026-11-09', days: 7 });
    expect(lookRange('list', '2026-12-01', '2026-11-14')).toEqual({ from: '2026-11-14', days: 15 });
  });

  it('names a week and a month the way people say them', () => {
    expect(weekShown('2026-11-09')).toBe('Nov 9 – 15, 2026');
    expect(weekShown('2026-11-30')).toBe('Nov 30 – Dec 6, 2026');
    expect(weekShown('2026-12-28')).toBe('Dec 28, 2026 – Jan 3, 2027');
    expect(monthShown('2026-11-01')).toBe('November 2026');
  });
});

describe('picking many posts', () => {
  const post = (id: string, state: PickedLike['state'], hidden = false): PickedLike => ({
    id,
    state,
    network: 'linkedin',
    hidden,
  });
  const picked = [
    post('w', 'draft'),
    post('k', 'ready'),
    post('u', 'posted'),
    post('f', 'failed'),
    post('h', 'skipped', true),
    post('g', 'posting'),
  ];

  it('shows hidden posts only under Hidden', () => {
    expect(shows(picked[4]!, 'all')).toBe(false);
    expect(shows(picked[4]!, 'hidden')).toBe(true);
    expect(filterCounts(picked)).toEqual({
      all: 5,
      waiting: 1,
      okd: 2,
      posted: 1,
      failed: 1,
      hidden: 1,
    });
  });

  it('says which picked posts each button acts on', () => {
    const s = summaryOf(picked);
    expect(s).toMatchObject({ picked: 6, waiting: 1, okd: 1, past: 2, failed: 1, hidden: 1 });
    expect(s.ok).toEqual(['w']);
    expect(s.redo).toEqual(['u', 'f']);
    expect(s.look).toEqual(['f']);
    expect(s.show).toEqual(['h']);
    // Nothing going up right now is hidden or deleted.
    expect(s.hide).toEqual(['w', 'k', 'u', 'f']);
    expect(s.remove).toEqual(['w', 'k', 'u', 'f', 'h']);
    expect(W.picking.summary(s)).toBe(
      '1 waiting for your OK · 1 OK’d · 2 past, 1 didn’t post · 1 already hidden',
    );
  });

  it('sends any number, 500 at a time', () => {
    const ids = Array.from({ length: 1_201 }, (_, i) => String(i));
    expect(inTurns(ids).map((t) => t.length)).toEqual([500, 500, 201]);
  });

  it('picks like the server: hidden ones only under everything and Hidden, OK’d is OK’d only', () => {
    const p = (state: PickedLike['state'], hidden = false) => ({ state, hidden });
    expect(picks(p('posted', true), 'all')).toBe(true);
    expect(picks(p('posted', true), 'past')).toBe(false);
    expect(picks(p('posted', true), 'hidden')).toBe(true);
    expect(picks(p('failed'), 'past')).toBe(true);
    expect(picks(p('failed'), 'failed')).toBe(true);
    expect(picks(p('posting'), 'okd')).toBe(false);
    expect(picks(p('ready'), 'okd')).toBe(true);
    expect(picks(p('draft'), 'waiting')).toBe(true);
    expect(picks(p('draft', true), 'waiting')).toBe(false);
  });
});
