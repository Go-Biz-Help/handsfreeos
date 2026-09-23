/**
 * The side menu each person arranges (`users.settings.menu`): reading one back, putting right what can't be
 * drawn, and never leaving a place unreachable.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MENU,
  MENU_GROUPS_MAX,
  addGroup,
  moveEntry,
  moveInGroup,
  moveKey,
  renameGroup,
  ungroup,
  MENU_GROUP_LABEL_MAX,
  MENU_KEYS,
  SUGGESTED_MENU,
  effectivePermissions,
  menuFor,
  menuKeys,
  menuOf,
  nextGroupId,
  normalizeMenu,
  sameMenu,
  storedMenu,
  type Menu,
  type MenuGroup,
  type MenuKey,
} from '../src/index';

const link = (key: MenuKey) => ({ kind: 'link', key }) as const;

describe('menuOf', () => {
  it('gives every place, one under the other, to someone who has never touched it', () => {
    expect(menuOf(undefined)).toEqual(DEFAULT_MENU);
    expect(menuOf({})).toEqual(DEFAULT_MENU);
    expect(menuOf({ theme: 'dark' })).toEqual(DEFAULT_MENU);
    expect(menuKeys(menuOf(null))).toEqual([...MENU_KEYS]);
  });

  it('ignores a menu it cannot read, rather than showing none', () => {
    expect(menuOf({ menu: 'more' })).toEqual(DEFAULT_MENU);
    expect(menuOf({ menu: { v: 2, entries: [], hidden: [] } })).toEqual(DEFAULT_MENU);
    expect(menuOf({ menu: { v: 1, entries: 'nope', hidden: [] } })).toEqual(DEFAULT_MENU);
  });

  it('reads back what was saved', () => {
    const menu: Menu = {
      entries: [
        link('home'),
        { kind: 'group', id: 'g1', label: 'Back office', keys: ['members', 'audit'] },
        link('settings'),
      ],
      hidden: ['reviews'],
    };
    const read = menuOf({ menu: storedMenu(menu) });
    expect(read.hidden).toEqual(['reviews']);
    expect(read.entries.find((e) => e.kind === 'group')).toEqual({
      kind: 'group',
      id: 'g1',
      label: 'Back office',
      keys: ['members', 'audit'],
    });
    // Everything else it never mentioned is still there.
    expect(new Set(menuKeys(read))).toEqual(new Set(MENU_KEYS.filter((k) => k !== 'reviews')));
  });
});

describe('normalizeMenu', () => {
  it('drops places that have gone and shows each of the rest once', () => {
    const menu = normalizeMenu({
      entries: [
        link('home'),
        { kind: 'link', key: 'gone-away' as MenuKey },
        link('inbox'),
        link('inbox'),
        { kind: 'group', id: 'g1', label: 'More', keys: ['tasks', 'tasks', 'inbox'] },
      ],
      hidden: [],
    });
    expect(menuKeys(menu).filter((k) => k === 'inbox')).toHaveLength(1);
    expect(menuKeys(menu).filter((k) => k === 'tasks')).toHaveLength(1);
    expect(menuKeys(menu)).not.toContain('gone-away');
  });

  it('puts a place it has never heard of beside the neighbour it ships next to', () => {
    // A menu saved before Reviews shipped: it sits between Forms and Knowledge again.
    const before = MENU_KEYS.filter((k) => k !== 'reviews').map(link);
    const keys = menuKeys(normalizeMenu({ entries: before, hidden: [] }));
    expect(keys.indexOf('reviews')).toBe(keys.indexOf('forms') + 1);
    expect(keys.indexOf('knowledge')).toBe(keys.indexOf('reviews') + 1);
  });

  it('puts an unheard-of place after the group its neighbour sits in', () => {
    const menu = normalizeMenu({
      entries: [
        link('home'),
        { kind: 'group', id: 'g1', label: 'More', keys: ['forms'] },
        link('settings'),
      ],
      hidden: [],
    });
    // Reviews ships after Forms, and Forms is in the group: it lands straight after the group.
    const group = menu.entries.findIndex((e) => e.kind === 'group');
    const at = menu.entries.findIndex((e) => e.kind === 'link' && e.key === 'reviews');
    expect(at).toBe(group + 1);
  });

  it('keeps a hidden place hidden, and refuses to hide Home or Settings', () => {
    const menu = normalizeMenu({
      entries: MENU_KEYS.filter((k) => k !== 'audit').map(link),
      hidden: ['audit', 'home', 'settings'],
    });
    expect(menu.hidden).toEqual(['audit']);
    expect(menuKeys(menu)).toContain('home');
    expect(menuKeys(menu)).toContain('settings');
  });

  it('drops a group with nothing in it', () => {
    const menu = normalizeMenu({
      entries: [...MENU_KEYS.map(link), { kind: 'group', id: 'g1', label: 'More', keys: [] }],
      hidden: [],
    });
    expect(menu.entries.some((e) => e.kind === 'group')).toBe(false);
  });

  it('names a group that has no name, tidies one that has, and keeps ids apart', () => {
    const menu = normalizeMenu({
      entries: [
        { kind: 'group', id: '', label: '   ', keys: ['tasks'] },
        { kind: 'group', id: 'g1', label: `  Every  ${'long'.repeat(20)}  `, keys: ['audit'] },
        { kind: 'group', id: 'g1', label: 'Same id', keys: ['members'] },
      ],
      hidden: [],
    });
    const groups = menu.entries.filter((e) => e.kind === 'group');
    expect(groups[0]!.label).toBe('More');
    expect(groups[1]!.label.length).toBe(MENU_GROUP_LABEL_MAX);
    expect(new Set(groups.map((g) => g.id)).size).toBe(groups.length);
  });

  it('spills groups past the limit back into the menu, keeping their places', () => {
    const extra = MENU_KEYS.length - 1;
    const menu = normalizeMenu({
      entries: [
        link('home'),
        ...MENU_KEYS.slice(1, 1 + extra).map(
          (key, i) => ({ kind: 'group', id: `g${i}`, label: `G${i}`, keys: [key] }) as const,
        ),
      ],
      hidden: [],
    });
    expect(menu.entries.filter((e) => e.kind === 'group')).toHaveLength(MENU_GROUPS_MAX);
    expect(new Set(menuKeys(menu))).toEqual(new Set(MENU_KEYS));
  });

  it('leaves the suggested menu and the default alone', () => {
    expect(normalizeMenu(SUGGESTED_MENU)).toEqual(SUGGESTED_MENU);
    expect(normalizeMenu(DEFAULT_MENU)).toEqual(DEFAULT_MENU);
    expect(new Set(menuKeys(SUGGESTED_MENU))).toEqual(new Set(MENU_KEYS));
  });
});

describe('editing helpers', () => {
  it('hands out a group id nothing else uses', () => {
    expect(nextGroupId(DEFAULT_MENU)).toBe('g1');
    expect(
      nextGroupId({
        entries: [{ kind: 'group', id: 'g1', label: 'More', keys: ['tasks'] }],
        hidden: [],
      }),
    ).toBe('g2');
  });

  it('knows when nothing has changed', () => {
    expect(sameMenu(DEFAULT_MENU, DEFAULT_MENU)).toBe(true);
    expect(sameMenu(DEFAULT_MENU, SUGGESTED_MENU)).toBe(false);
    // The same menu with an empty group in it is the same menu.
    expect(
      sameMenu(DEFAULT_MENU, {
        entries: [...DEFAULT_MENU.entries, { kind: 'group', id: 'g1', label: 'More', keys: [] }],
        hidden: [],
      }),
    ).toBe(true);
  });
});

describe('editing a menu', () => {
  const base: Menu = {
    entries: [
      link('home'),
      link('inbox'),
      { kind: 'group', id: 'g1', label: 'More', keys: ['members', 'audit'] },
      link('settings'),
    ],
    hidden: ['reviews'],
  };

  it('sends a place into a group, out to the menu, and out of sight', () => {
    const intoGroup = moveKey(base, 'tasks', { group: 'g1' });
    expect((intoGroup.entries[2] as MenuGroup).keys).toEqual(['members', 'audit', 'tasks']);
    const out = moveKey(intoGroup, 'audit', 'menu');
    expect((out.entries[2] as MenuGroup).keys).toEqual(['members', 'tasks']);
    // Out of a group it lands straight under that group, not at the far end of the menu.
    expect(out.entries[3]).toEqual(link('audit'));
    const gone = moveKey(out, 'audit', 'hidden');
    expect(gone.hidden).toEqual(['reviews', 'audit']);
    expect(menuKeys(gone)).not.toContain('audit');
    // Back out of hiding: into the menu, at its end.
    const back = moveKey(gone, 'audit', 'menu');
    expect(back.hidden).toEqual(['reviews']);
    expect(back.entries.at(-1)).toEqual(link('audit'));
  });

  it('never hides Home or Settings, and never sends a place to a group that is not there', () => {
    expect(moveKey(base, 'home', 'hidden')).toBe(base);
    expect(moveKey(base, 'settings', 'hidden')).toBe(base);
    expect(moveKey(base, 'tasks', { group: 'nope' })).toBe(base);
  });

  it('makes a group of one, and stops at the limit', () => {
    const made = moveKey(base, 'tasks', 'new');
    const group = made.entries.at(-1);
    expect(group).toEqual({ kind: 'group', id: 'g2', label: 'More', keys: ['tasks'] });
    let full: Menu = { entries: [], hidden: [] };
    for (let i = 0; i < MENU_GROUPS_MAX + 2; i += 1) full = addGroup(full);
    expect(full.entries).toHaveLength(MENU_GROUPS_MAX);
  });

  it('keeps a group that has been emptied, until the arrangement is saved', () => {
    const emptied = moveKey(moveKey(base, 'members', 'menu'), 'audit', 'menu');
    expect(emptied.entries.filter((e) => e.kind === 'group')).toHaveLength(1);
    // Saving is what drops it.
    expect(normalizeMenu(emptied).entries.filter((e) => e.kind === 'group')).toHaveLength(0);
  });

  it('moves a row up and down, and stays put at the ends', () => {
    expect(moveEntry(base, 1, -1).entries[0]).toEqual(link('inbox'));
    expect(moveEntry(base, 0, -1)).toEqual(base);
    expect(moveEntry(base, 3, 1)).toEqual(base);
    // A whole group moves as one row.
    const up = moveEntry(base, 2, -1);
    expect(up.entries[1]).toEqual(base.entries[2]);
  });

  it('moves a place within its group', () => {
    const moved = moveInGroup(base, 'g1', 1, -1);
    expect((moved.entries[2] as MenuGroup).keys).toEqual(['audit', 'members']);
    expect(moveInGroup(base, 'g1', 0, -1)).toEqual(base);
    expect(moveInGroup(base, 'nope', 0, 1)).toEqual(base);
  });

  it('ungroups in place, and renames without tidying mid-word', () => {
    const flat = ungroup(base, 'g1');
    expect(flat.entries).toEqual([
      link('home'),
      link('inbox'),
      link('members'),
      link('audit'),
      link('settings'),
    ]);
    // Half-typed names are left alone here; normalizeMenu tidies them when the menu is saved.
    const named = renameGroup(base, 'g1', '  Back  ');
    expect((named.entries[2] as { label: string }).label).toBe('  Back  ');
    expect(
      (normalizeMenu(named).entries.find((e) => e.kind === 'group') as { label: string }).label,
    ).toBe('Back');
  });
});

describe('the menu in one business (0105)', () => {
  it('leaves out what the business keeps a person from, groups included, and keeps it in their saved menu', () => {
    const member = effectivePermissions('member');
    // Members don't read the audit log, so it isn't offered; the saved menu still has it.
    expect(menuKeys(menuFor(SUGGESTED_MENU, member))).not.toContain('audit');
    expect(menuKeys(SUGGESTED_MENU)).toContain('audit');
    // A business that keeps them from money and the inbox takes those places away too.
    const kept = effectivePermissions('member', { 'money.read': false, 'inbox.use': false });
    const theirs = menuKeys(menuFor(SUGGESTED_MENU, kept));
    expect(theirs).not.toContain('money');
    expect(theirs).not.toContain('inbox');
    expect(theirs).toContain('customers');
    // A group with nothing left in it goes.
    const onlyAudit: Menu = {
      entries: [link('home'), { kind: 'group', id: 'g', label: 'Back office', keys: ['audit'] }],
      hidden: [],
    };
    expect(menuFor(onlyAudit, member).entries).toEqual([link('home')]);
    // Without their permissions (an older copy), the menu as saved.
    expect(menuFor(SUGGESTED_MENU, null)).toBe(SUGGESTED_MENU);
    expect(menuKeys(menuFor(SUGGESTED_MENU, effectivePermissions('owner')))).toEqual(
      menuKeys(SUGGESTED_MENU),
    );
  });
});
