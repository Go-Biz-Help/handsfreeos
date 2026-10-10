/**
 * Social Outreach: results by group and the weekly report (docs/outreach.md, decision 34). The extension works the
 * groups that bring replies and demos most, and still tries others; the weekly report names the best group and
 * opener, and comes on Monday at the morning push's hour, in the business's time zone.
 */
import { describe, expect, it } from 'vitest';
import { outreachSettings } from '../../src/addons/outreach/chat-read';
import {
  bestGroup,
  bestOpener,
  groupsToWork,
  nextWeekly,
  resultWords,
} from '../../src/addons/outreach/results';

const group = (name: string, replies = 0, demos = 0, joined: boolean | null = true) => ({
  name,
  replies,
  demos,
  joined,
});

describe('the groups the extension works', () => {
  it('keeps 3 of 5 places for the groups that brought results, the best first', () => {
    const work = [
      group('New 1'),
      group('Replies', 4),
      group('New 2'),
      group('Demo', 0, 1),
      group('New 3'),
      group('Few replies', 1),
      group('Most replies', 9),
      group('New 4'),
    ];
    expect(groupsToWork(work, [], 5).map((g) => g.name)).toEqual([
      'Demo',
      'Most replies',
      'Replies',
      'New 1',
      'New 2',
    ]);
  });

  it('fills the rest with the other kind when there are too few of one', () => {
    const proven = [group('A', 1), group('B', 2), group('C', 3), group('D', 4)];
    expect(groupsToWork([...proven, group('New')], [], 5).map((g) => g.name)).toEqual([
      'D',
      'C',
      'B',
      'A',
      'New',
    ]);
    expect(groupsToWork([group('New 1'), group('New 2')], [], 5)).toHaveLength(2);
  });

  it('takes proven groups from Maybe too, but tries new ones from Maybe only when they’re in none of Work these', () => {
    const maybe = [group('Maybe demo', 0, 2), group('Maybe new')];
    expect(groupsToWork([group('Work new')], maybe, 5).map((g) => g.name)).toEqual([
      'Maybe demo',
      'Work new',
    ]);
    expect(groupsToWork([group('Not in', 0, 0, false)], maybe, 5).map((g) => g.name)).toEqual([
      'Maybe demo',
      'Maybe new',
    ]);
  });
});

describe('the weekly report', () => {
  it('names the best group and opener, or none when nothing came of it', () => {
    expect(bestGroup([group('A', 5), group('B', 1, 1), group('C')])?.name).toBe('B');
    expect(bestGroup([group('A'), group('B')])).toBeNull();
    expect(resultWords({ replies: 3, demos: 1 })).toBe('3 wrote back · 1 demo booked');
    expect(resultWords({ replies: 0, demos: 2 })).toBe('2 demos booked');
    expect(resultWords({ replies: 0, demos: 0 })).toBe('');
    const opener = (text: string, sent: number, replies: number, demos = 0) => ({
      text,
      sent,
      replies,
      demos,
    });
    expect(
      bestOpener([opener('Most', 20, 4), opener('Best rate', 4, 4), opener('Quiet', 9, 0)])?.text,
    ).toBe('Best rate');
    expect(bestOpener([opener('Demo', 10, 1, 1), opener('Replies', 10, 6)])?.text).toBe('Demo');
    expect(bestOpener([opener('Quiet', 9, 0), opener('Unsent', 0, 0)])).toBeNull();
  });

  it('comes on Monday at the morning push’s hour, in the business’s time zone, and is on to start', () => {
    expect(outreachSettings(null).weeklyReport).toBe(true);
    expect(outreachSettings({ weeklyReport: false }).weeklyReport).toBe(false);
    // Saturday 10 Oct 2026, noon in Chicago: Monday the 12th at 8 there (13:00 UTC).
    const saturday = Date.parse('2026-10-10T17:00:00Z');
    expect(nextWeekly(saturday, 'America/Chicago', 8).toISOString()).toBe(
      '2026-10-12T13:00:00.000Z',
    );
    // Monday at 7:30 there: that morning; at 8:30, the Monday after.
    const monday = Date.parse('2026-10-12T12:30:00Z');
    expect(nextWeekly(monday, 'America/Chicago', 8).toISOString()).toBe('2026-10-12T13:00:00.000Z');
    expect(nextWeekly(monday + 3_600_000, 'America/Chicago', 8).toISOString()).toBe(
      '2026-10-19T13:00:00.000Z',
    );
  });
});
