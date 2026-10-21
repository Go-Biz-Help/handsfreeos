/**
 * What the dropdown shows (search/dropdown.ts), with no database. The rule of decision 33, not board 1 copied: groups
 * whose best hit is tier 0 to 2 by tier, then kind order, so Messages comes before Calendar at tiers 3 and 4, and the
 * chips follow the same order. The best match comes out of its group, Archived shows only under 3 hits, and the
 * close-match and no-one-active lines are decided after the Settings group, whose hits count.
 */
import { describe, expect, it } from 'vitest';
import type { SearchEverythingOutput, SearchGroup, SearchHit } from '../../src/schemas/search';
import { dropdownOf, groupLabel, unavailableLine } from '../../src/search/dropdown';
import { bestOf, orderGroups } from '../../src/search/rank';

let n = 0;
const hit = (
  kind: string,
  title: string,
  tier: number,
  over: Partial<SearchHit> = {},
): SearchHit => ({
  kind,
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  title,
  subtitle: null,
  badges: [],
  why: { field: 'name', label: null, snippet: null, page: null },
  tier,
  exact: false,
  at: null,
  href: '/',
  contact: null,
  amount: null,
  facts: {},
  duplicateOf: null,
  ...over,
});
const group = (kind: string, items: SearchHit[], over: Partial<SearchGroup> = {}): SearchGroup => ({
  kind,
  label: null,
  icon: null,
  total: items.length,
  capped: false,
  complete: true,
  searchedBack: null,
  unavailable: null,
  items,
  ...over,
});
const answer = (over: Partial<SearchEverythingOutput>): SearchEverythingOutput => {
  const groups = orderGroups(over.groups ?? []);
  return {
    q: 'smith',
    tooShort: false,
    probes: { looksLike: 'words', phoneE164: null, email: null, number: null },
    total: groups.reduce((t, g) => t + g.total, 0),
    capped: false,
    best: bestOf(groups),
    archived: null,
    bin: null,
    close: false,
    noneActive: false,
    ...over,
    groups,
  };
};

describe('the dropdown', () => {
  it('orders groups by the rule, takes the best match out, and lists what didn’t fit under Also found', () => {
    const dana = hit('contacts', 'Dana Smith', 1);
    const a = answer({
      groups: [
        group('calendar', [hit('calendar', 'Visit', 3)]),
        group('messages', [hit('messages', 'Text', 4)]),
        group('contacts', [
          dana,
          hit('contacts', 'Marcus Smith', 1),
          hit('contacts', 'Jo Smithers', 2),
        ]),
        group('companies', [hit('companies', 'Smithfield', 1)]),
        group('leads', [hit('leads', 'Backflow', 3)]),
        group('money', [hit('money', 'Invoice #1031', 3)]),
        group('tasks', [hit('tasks', 'Call back', 3)]),
      ],
    });
    const d = dropdownOf(a, null, { maxGroups: 5, maxRows: 10 });
    expect(d.best?.title).toBe('Dana Smith');
    expect(d.groups.map((g) => g.group.kind)).toEqual([
      'contacts',
      'companies',
      'leads',
      'money',
      'messages',
    ]);
    // More than 3 groups show, so 2 rows each, and Dana isn't in her group again.
    expect(d.groups[0]!.rows.map((h) => h.title)).toEqual(['Marcus Smith', 'Jo Smithers']);
    expect(d.alsoFound.map((g) => g.kind)).toEqual(['calendar', 'tasks']);
    expect(d.chips.map((c) => c.kind)).toEqual([
      'all',
      'contacts',
      'companies',
      'leads',
      'money',
      'messages',
      'calendar',
      'tasks',
    ]);
    expect(d.chips[0]).toMatchObject({ label: 'All', count: 9 });
    expect(d.line).toBeNull();
    // Every group at once (the phone's See all results): each group's rows as asked, however many groups show.
    const all = dropdownOf(a, null, { maxGroups: 40, maxRows: 400, perGroup: 5 });
    expect(all.groups.map((g) => g.rows.length)).toEqual([2, 1, 1, 1, 1, 1, 1]);
    expect(all.alsoFound).toEqual([]);
  });

  it('puts exact matches under Exact match, with no best match, when a number was typed', () => {
    const exact = hit('money', 'Invoice #1042', 0, { exact: true });
    const a = answer({
      probes: { looksLike: 'number', phoneE164: null, email: null, number: '1042' },
      groups: [group('money', [exact]), group('contacts', [hit('contacts', 'Kim 1042 Oak', 3)])],
    });
    const d = dropdownOf(a, null);
    expect(d.exact?.map((h) => h.title)).toEqual(['Invoice #1042']);
    expect(d.best).toBeNull();
    expect(d.groups.map((g) => g.group.kind)).toEqual(['contacts']);
  });

  it('shows Archived and the bin only when the active groups hold fewer than 3 hits', () => {
    const archived = group('archived', [
      hit('contacts', 'Tom Becnel', 1, { badges: ['archived'] }),
    ]);
    const bin = group('bin', [hit('bin', 'Texts with Tom Becnel', 1)]);
    const few = dropdownOf(
      answer({ groups: [group('leads', [hit('leads', 'Tom job', 3)])], archived, bin }),
      null,
    );
    expect(few.archived).toBe(archived);
    expect(few.bin).toBe(bin);
    const many = dropdownOf(
      answer({
        groups: [
          group('leads', [hit('leads', 'a', 3), hit('leads', 'b', 3), hit('leads', 'c', 3)]),
        ],
        archived,
        bin,
      }),
      null,
    );
    expect(many.archived).toBeNull();
    expect(many.bin).toBeNull();
  });

  it('says nobody active matches when only Archived or the bin found something, unless a setting did', () => {
    const archived = group('archived', [
      hit('contacts', 'Tom Becnel', 1, { badges: ['archived'] }),
    ]);
    const a = answer({ groups: [], archived, noneActive: true });
    expect(dropdownOf(a, null).line).toBe('none_active');
    const settings = group('settings', [hit('settings', 'Quiet hours', 2)]);
    expect(dropdownOf(a, settings).line).toBeNull();
  });

  it('decides the close-match line after the Settings group: "quiet hours" with a setting shows no close matches', () => {
    const close = answer({
      close: true,
      groups: [group('close', [hit('contacts', 'Quinn Hours', 5)])],
    });
    expect(dropdownOf(close, null).line).toBe('close');
    const settings = group('settings', [hit('settings', 'Quiet hours', 1)]);
    const d = dropdownOf(close, settings);
    expect(d.line).toBeNull();
    expect(d.groups.map((g) => g.group.kind)).toEqual(['settings']);
    expect(d.total).toBe(1);
    expect(d.chips[0]).toMatchObject({ kind: 'all', count: 1 });
  });

  it('keeps the close-match line and the names when a setting is only close too', () => {
    // "bown", a typo for Brown: the server's close matches stand, beside a setting that's a typo of its own.
    const close = answer({
      q: 'bown',
      close: true,
      groups: [
        group('close', [
          hit('contacts', 'Dana Brown', 5, {
            why: { field: 'close', label: null, snippet: null, page: null },
          }),
        ]),
      ],
    });
    const settings = group('settings', [
      hit('settings', 'Your own web address', 5, {
        why: { field: 'close', label: null, snippet: null, page: null },
      }),
    ]);
    const d = dropdownOf(close, settings);
    expect(d.line).toBe('close');
    expect(d.groups.flatMap((g) => g.rows.map((r) => r.title))).toContain('Dana Brown');
  });

  it('counts the settings it found, and says when nothing at all matched', () => {
    const settings = group('settings', [
      hit('settings', 'Quiet hours', 1),
      hit('settings', 'Opening hours', 2),
    ]);
    const d = dropdownOf(
      answer({ groups: [group('contacts', [hit('contacts', 'Dana', 3)])] }),
      settings,
    );
    expect(d.total).toBe(3);
    expect(dropdownOf(answer({ groups: [] }), null).line).toBe('empty');
    expect(dropdownOf(answer({ groups: [], tooShort: true }), null).line).toBeNull();
  });

  it('lists a kind that didn’t answer with its own line', () => {
    const slow = group('money', [], { unavailable: 'too_slow' });
    const d = dropdownOf(
      answer({ groups: [slow, group('contacts', [hit('contacts', 'Dana', 1)])] }),
      null,
    );
    expect(d.unavailable.map((g) => g.kind)).toEqual(['money']);
    expect(unavailableLine(slow)).toBe(
      'Money took too long to search. Try again, or pick Money on its own.',
    );
    expect(unavailableLine(group('contacts', [hit('contacts', 'Dana', 1)]))).toBeNull();
  });

  it('says neither nobody active nor nothing at all while a kind didn’t answer', () => {
    const archived = group('archived', [
      hit('contacts', 'Tom Becnel', 1, { badges: ['archived'] }),
    ]);
    const slow = group('contacts', [], { unavailable: 'too_slow' });
    expect(dropdownOf(answer({ groups: [slow], archived }), null).line).toBeNull();
    expect(dropdownOf(answer({ groups: [slow] }), null).line).toBeNull();
  });

  it('counts a Deleted bin that wasn’t searched as a kind that didn’t answer, with its own line', () => {
    // "tom becnel", deleted for good: every kind answered empty and the bin ran out of budget.
    const stopped = group('bin', [], { unavailable: 'skipped' });
    const d = dropdownOf(answer({ groups: [], bin: stopped }), null);
    expect(d.unavailable.map((g) => g.kind)).toEqual(['bin']);
    expect(d.line).toBeNull();
    expect(d.bin).toBeNull();
    expect(unavailableLine(stopped)).toMatch(/^Deleted bin wasn’t searched this time/);
    const archived = group('archived', [
      hit('contacts', 'Tom Becnel', 1, { badges: ['archived'] }),
    ]);
    expect(dropdownOf(answer({ groups: [], archived, bin: stopped }), null).line).toBeNull();
    // A bin that found something, though its facts failed, is the bin, not a kind that didn't answer.
    const found = group('bin', [hit('bin', 'Tom Becnel', 1)], { unavailable: 'failed' });
    const shown = dropdownOf(answer({ groups: [], bin: found }), null);
    expect(shown.unavailable).toEqual([]);
    expect(shown.line).toBe('none_active');
  });

  it('words the business’s own kinds together with Try again only, since there’s no one chip to pick', () => {
    const records = group('records', [], { unavailable: 'skipped' });
    expect(groupLabel(records)).toBe('Your own kinds of records');
    expect(unavailableLine(records)).toBe(
      'Your own kinds of records weren’t searched this time, to keep this quick. Try again.',
    );
    expect(unavailableLine({ ...records, unavailable: 'too_slow' })).not.toMatch(/on its own/);
    expect(
      orderGroups([records, group('knowledge', [], { unavailable: 'skipped' })]).map((g) => g.kind),
    ).toEqual(['knowledge', 'records']);
  });

  it('labels core’s kinds itself and a record kind by its own plural', () => {
    expect(groupLabel({ kind: 'contacts', label: null })).toBe('Contacts');
    expect(groupLabel({ kind: 'record.pets', label: 'Pets' })).toBe('Pets');
    expect(groupLabel({ kind: 'bin', label: null })).toBe('Deleted bin');
    // An object's own keys are no kind of core's.
    expect(groupLabel({ kind: 'constructor', label: null })).toBe('constructor');
  });
});
