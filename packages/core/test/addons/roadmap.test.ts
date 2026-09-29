/**
 * Voting on what's next (0109): the planned catalogue as the owner approved it, when each week's pick happens, which
 * add-ons are in the race, where a pick has got to, and the planned list's search, filters and order. Pure: no
 * database (packages/core/test/addon-votes.test.ts runs the vote itself).
 */
import { describe, expect, it } from 'vitest';
import {
  ADDON_CATALOG,
  ADDON_CATEGORIES,
  ADDON_PICK_ZONE,
  BUILT_ADDONS,
  INDUSTRY_GROUPS,
  PLANNED_ADDONS,
  addonsInRace,
  filterPlanned,
  nextAddonPickAt,
  pickStage,
  plannedCategories,
  plannedCategoryCounts,
  plannedGroups,
  withVote,
  type PlannedAddonView,
} from '../../src/index';

describe('the planned catalogue', () => {
  it('holds the owner’s list: 122 add-ons, Real Estate Agent among them', () => {
    expect(PLANNED_ADDONS).toHaveLength(122);
    expect(PLANNED_ADDONS.find((m) => m.id === 'realestate')?.name).toBe('Real Estate Agent');
    expect(PLANNED_ADDONS.every((m) => m.catalog.status === 'planned')).toBe(true);
  });

  it('leaves out what HandsFreeOS already does', () => {
    const names = new Set(PLANNED_ADDONS.map((m) => m.name));
    for (const built of [
      'AI Voice Builder',
      'Commerce & Payments',
      'Quote & Estimate Builder',
      'Email Marketing Studio',
      'Reputation Manager',
      'Knowledge Base Builder',
      'AI Employees',
      'AI Business Analyst',
      'Agency Management',
      'Multi-Location Management',
      'Scheduling Intelligence',
      'Territory Manager',
      'Survey & Feedback Manager',
      'Business Forms Builder',
      'AI Form Builder',
      'AI Automation Builder',
    ])
      expect(names.has(built), built).toBe(false);
  });

  it('files every industry add-on under a line of work, and every add-on under a known category', () => {
    for (const m of PLANNED_ADDONS) {
      expect(ADDON_CATEGORIES).toContain(m.category);
      if (m.category === 'industry') {
        expect(m.catalog.groups).toHaveLength(1);
        expect(INDUSTRY_GROUPS as readonly string[]).toContain(m.catalog.groups![0]);
      }
    }
  });

  it('says what overlaps in the words a business uses, never "core"', () => {
    for (const m of PLANNED_ADDONS)
      if (m.catalog.overlap) expect(m.catalog.overlap, m.id).not.toMatch(/\bcore\b/i);
  });

  it('lets a built add-on take its planned one’s place under the same id', () => {
    expect(ADDON_CATALOG.filter((m) => m.id === 'realestate')).toHaveLength(1);
    expect(ADDON_CATALOG).toHaveLength(
      BUILT_ADDONS.length +
        PLANNED_ADDONS.filter((p) => !BUILT_ADDONS.some((b) => b.id === p.id)).length,
    );
  });
});

describe('when the week closes', () => {
  const eastern = (at: Date) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: ADDON_PICK_ZONE,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(at);

  it('is the midnight that ends Sunday, US Eastern', () => {
    // Wednesday 30 September 2026, 15:00 UTC (11:00 Eastern, daylight time).
    const at = nextAddonPickAt(Date.UTC(2026, 8, 30, 15));
    expect(at.toISOString()).toBe('2026-10-05T04:00:00.000Z');
    expect(eastern(at)).toBe('Mon 00:00');
  });

  it('counts a week from a Monday that has just begun to the next one', () => {
    const monday = Date.parse('2026-10-05T04:00:00.000Z');
    expect(nextAddonPickAt(monday).toISOString()).toBe('2026-10-12T04:00:00.000Z');
    expect(nextAddonPickAt(monday - 1).toISOString()).toBe('2026-10-05T04:00:00.000Z');
  });

  it('follows the clocks going back', () => {
    // Clocks go back on Sunday 1 November 2026: that week closes at 05:00 UTC.
    const at = nextAddonPickAt(Date.UTC(2026, 9, 30, 12));
    expect(at.toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(eastern(at)).toBe('Mon 00:00');
  });
});

describe('the race', () => {
  it('is every planned add-on not yet picked, and not one HandsFreeOS took down', () => {
    const race = addonsInRace(ADDON_CATALOG, { hvac: 'unavailable' }, new Set(['realestate']));
    expect(race).not.toContain('realestate');
    expect(race).not.toContain('hvac');
    expect(race).toContain('plumbing');
    expect(race).toHaveLength(120);
  });

  it('keeps a pick Coming soon until it can be added', () => {
    expect(pickStage('planned')).toBe('coming_soon');
    expect(pickStage('development')).toBe('coming_soon');
    expect(pickStage('beta')).toBe('coming_soon');
    expect(pickStage('built')).toBe('coming_soon');
    expect(pickStage('available')).toBe('shipped');
    expect(pickStage('deprecated')).toBe('gone');
    expect(pickStage(null)).toBe('gone');
  });
});

describe('the planned list', () => {
  const view = (
    addonId: string,
    name: string,
    category: string,
    groups: string[],
    votes = 0,
    summary = '',
  ): PlannedAddonView => ({
    addonId,
    name,
    summary,
    category,
    groups,
    overlap: null,
    votes,
    voted: false,
  });
  const list = [
    view(
      'hvac',
      'HVAC',
      'industry',
      ['Home services & trades'],
      2,
      'Equipment records and filter sizes.',
    ),
    view('roofing', 'Roofing', 'industry', ['Home services & trades'], 5, 'Roof measurements.'),
    view('dental', 'Dental', 'industry', ['Health & care'], 0, 'Tooth-specific records.'),
    view(
      'socialinbox',
      'Social Media Inbox',
      'marketing',
      ['Social Media'],
      5,
      'Comments and DMs.',
    ),
    view('expenses', 'Expense Management', 'finance', [], 1, 'Receipts and approvals.'),
  ];

  it('finds by every word typed, in the name, what it does, its groups or its category', () => {
    const names = (q: string) =>
      filterPlanned(list, { query: q, category: null, group: null }, 'az').map((a) => a.name);
    expect(names('records')).toEqual(['Dental', 'HVAC']);
    expect(names('home services')).toEqual(['HVAC', 'Roofing']);
    expect(names('FINANCE')).toEqual(['Expense Management']);
    expect(names('social dms')).toEqual(['Social Media Inbox']);
    expect(names('zebra')).toEqual([]);
  });

  it('filters by category and group, and sorts by votes then name', () => {
    expect(
      filterPlanned(list, { query: '', category: 'industry', group: null }, 'votes').map(
        (a) => a.addonId,
      ),
    ).toEqual(['roofing', 'hvac', 'dental']);
    expect(
      filterPlanned(list, { query: '', category: null, group: 'Health & care' }, 'votes'),
    ).toHaveLength(1);
    expect(
      filterPlanned(list, { query: '', category: null, group: null }, 'votes').map((a) => a.name),
    ).toEqual(['Roofing', 'Social Media Inbox', 'HVAC', 'Expense Management', 'Dental']);
  });

  it('counts each category for what was typed, and lists the groups a category has', () => {
    const counts = plannedCategoryCounts(list, 'records');
    expect(counts['all']).toBe(2);
    expect(counts['industry']).toBe(2);
    expect(counts['marketing']).toBe(0);
    expect(plannedCategories(list)).toEqual(['industry', 'marketing', 'finance']);
    expect(plannedGroups(list, 'industry')).toEqual(['Health & care', 'Home services & trades']);
    expect(plannedGroups(list, null)).toHaveLength(3);
  });

  it('shows a vote at once, and never below none', () => {
    const hvac = list[0]!;
    expect(withVote(hvac, true)).toMatchObject({ voted: true, votes: 3 });
    expect(withVote({ ...hvac, votes: 0, voted: true }, false)).toMatchObject({ votes: 0 });
    expect(withVote(hvac, false)).toBe(hvac);
  });
});
