/**
 * The side menu each person arranges (`users.settings.menu`): reading one back, putting right what can't be
 * drawn, and never leaving a place unreachable — and the places add-ons bring with them (0108), which show only
 * while their add-on runs and come back where they were when it is turned on again.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MENU,
  MENU_ADDON_PLACES_MAX,
  MENU_GROUPS_MAX,
  addGroup,
  addonMenuKey,
  addonMenuPlace,
  addonMenuPlaces,
  currentMenuPlace,
  entryShown,
  inMenuPlace,
  isAddonMenuKey,
  menuPlaceOpen,
  moveEntry,
  moveInGroup,
  moveKey,
  renameGroup,
  ungroup,
  withAddonPlaces,
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
  type AddonManifest,
  type AddonMenuKey,
  type Menu,
  type MenuAddons,
  type MenuGroup,
  type MenuKey,
  type MenuPlaceKey,
} from '../src/index';

const link = (key: MenuPlaceKey) => ({ kind: 'link', key }) as const;

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

  it('suggests Campaigns as its own row, just above More', () => {
    const rows = SUGGESTED_MENU.entries.map((e) => (e.kind === 'link' ? e.key : `group:${e.id}`));
    expect(rows.indexOf('campaigns')).toBe(rows.indexOf('group:more') - 1);
    const more = SUGGESTED_MENU.entries.find((e) => e.kind === 'group');
    expect(more?.kind === 'group' ? more.keys : []).not.toContain('campaigns');
  });

  it('keeps Ideas out: it sits with Get help, and a saved menu that names it loses it', () => {
    expect(MENU_KEYS as readonly string[]).not.toContain('ideas');
    const saved = menuOf({
      menu: {
        v: 1,
        entries: [
          { kind: 'link', key: 'home' },
          { kind: 'link', key: 'ideas' },
          { kind: 'group', id: 'g1', label: 'More', keys: ['ideas', 'audit'] },
        ],
        hidden: ['ideas'],
      },
    });
    expect(menuKeys(saved) as readonly string[]).not.toContain('ideas');
    expect(saved.hidden as readonly string[]).not.toContain('ideas');
    expect(new Set(menuKeys(saved))).toEqual(new Set(MENU_KEYS));
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

describe('the menu in one business (0106)', () => {
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

// ---------- add-ons' places (0108) ----------

/**
 * Made-up add-ons, shaped like packages/core/test/addons/fixtures.ts (every id starts with `fx`, so none can be
 * mistaken for a real one): Property Management with two places, the second behind its own permission; Accounting
 * with one; a board that declares no permissions at all; and one with no places.
 */
const fixture = (
  id: string,
  name: string,
  permissions: readonly string[],
  nav: NonNullable<NonNullable<AddonManifest['ui']>['nav']>,
): AddonManifest => ({
  id,
  name,
  summary: `${name} for tests.`,
  description: 'A test fixture.',
  category: 'operations',
  version: '1.0.0',
  dataVersion: 1,
  catalog: { status: 'available', keywords: [id] },
  capabilities: [{ id: `${id}.use`, label: name, description: `${name}.` }],
  permissions: permissions.map((key) => ({
    key,
    label: key,
    description: key,
    defaultRoles: ['admin', 'member'],
  })),
  ui: { nav },
  billing: { model: 'free' },
});

const fxprop = fixture(
  'fxprop',
  'Property Management',
  ['fxprop.read', 'fxprop.write'],
  [
    { key: 'properties', label: 'Properties', icon: 'building', path: '' },
    {
      key: 'leases',
      label: 'Leases',
      icon: 'file-text',
      path: 'leases',
      permission: 'fxprop.write',
    },
  ],
);
const fxacct = fixture(
  'fxacct',
  'Accounting',
  ['fxacct.use'],
  [{ key: 'books', label: 'Books', icon: 'book-open', path: '' }],
);
const fxboard = fixture(
  'fxboard',
  'Notice Board',
  [],
  [{ key: 'board', label: 'Board', icon: 'clipboard', path: '' }],
);
const fxquiet = fixture('fxquiet', 'Quiet', ['fxquiet.use'], []);
const CATALOG: readonly AddonManifest[] = [fxprop, fxacct, fxboard, fxquiet];

const PROPERTIES = addonMenuKey('fxprop', 'properties');
const LEASES = addonMenuKey('fxprop', 'leases');
const BOOKS = addonMenuKey('fxacct', 'books');
const BOARD = addonMenuKey('fxboard', 'board');

const running = (...ids: string[]): MenuAddons => ({ running: ids, catalog: CATALOG });
/** An owner's permissions with those of the add-ons that run, as private.user_permissions() works them out. */
const ownerWith = (...extra: string[]) => [...effectivePermissions('owner'), ...extra];

describe('add-on places in a saved menu', () => {
  it('are `addon:<add-on>:<place>`, and only well-formed ones count', () => {
    expect(PROPERTIES).toBe('addon:fxprop:properties');
    expect(isAddonMenuKey(PROPERTIES)).toBe(true);
    for (const bad of [
      'addon:fxprop',
      'addon:Fxprop:properties',
      'addon:f:properties',
      'addon:fxprop:Properties',
      'addon:fxprop:',
      'addon:fxprop:a:b',
      'addon:fx9:properties',
      'addons:fxprop:properties',
      'inbox',
    ])
      expect(isAddonMenuKey(bad), bad).toBe(false);
  });

  it('are kept where the person put them — in the menu, in a group, or hidden — while other unknowns go', () => {
    const menu = normalizeMenu({
      entries: [
        link('home'),
        link(PROPERTIES),
        { kind: 'link', key: 'addon:Nope:x' as AddonMenuKey },
        {
          kind: 'group',
          id: 'g1',
          label: 'Money',
          keys: ['money', BOOKS, BOOKS, 'gone' as MenuKey],
        },
        link(PROPERTIES),
      ],
      hidden: [LEASES, 'addon:fxprop' as AddonMenuKey],
    });
    const at = (key: MenuPlaceKey) =>
      menu.entries.findIndex((e) => e.kind === 'link' && e.key === key);
    const group = menu.entries.findIndex((e) => e.kind === 'group');
    // Where it was put: after Home, before the group (Inbox, never mentioned, goes back beside Home).
    expect(at(PROPERTIES)).toBeGreaterThan(at('home'));
    expect(at(PROPERTIES)).toBeLessThan(group);
    expect(menu.entries[group]).toEqual({
      kind: 'group',
      id: 'g1',
      label: 'Money',
      keys: ['money', BOOKS],
    });
    expect(menu.hidden).toEqual([LEASES]);
    const keys = menuKeys(menu);
    expect(keys.filter((k) => k === PROPERTIES)).toHaveLength(1);
    expect(keys).not.toContain('addon:Nope:x');
    // Every core place is still there, the ones it never mentioned put back as always.
    expect(new Set(keys.filter((k) => !isAddonMenuKey(k)))).toEqual(new Set(MENU_KEYS));
  });

  it('come back from what was saved, add-on off or on', () => {
    const arranged: Menu = {
      entries: [
        link('home'),
        { kind: 'group', id: 'g1', label: 'Rentals', keys: [LEASES, PROPERTIES] },
        ...MENU_KEYS.filter((k) => k !== 'home').map(link),
      ],
      hidden: [BOOKS],
    };
    const read = menuOf({ menu: storedMenu(arranged) });
    expect(read.entries[1]).toEqual(arranged.entries[1]);
    expect(read.hidden).toEqual([BOOKS]);
    expect(sameMenu(read, arranged)).toBe(true);
  });

  it('stop at a limit, so a menu saved by hand cannot grow without end', () => {
    const many = Array.from({ length: MENU_ADDON_PLACES_MAX + 5 }, (_, i) =>
      link(addonMenuKey('fxprop', `place${i}`)),
    );
    const menu = normalizeMenu({ entries: [...MENU_KEYS.map(link), ...many], hidden: [] });
    expect(menuKeys(menu).filter(isAddonMenuKey)).toHaveLength(MENU_ADDON_PLACES_MAX);
    expect(new Set(menuKeys(menu).filter((k) => !isAddonMenuKey(k)))).toEqual(new Set(MENU_KEYS));
  });
});

describe('the menu in one business, with its add-ons (0108)', () => {
  const owner = ownerWith('fxprop.read', 'fxprop.write', 'fxacct.use');

  it('adds the places of add-ons running here, after core’s, in the catalogue’s order', () => {
    const keys = menuKeys(menuFor(DEFAULT_MENU, owner, running('fxacct', 'fxprop')));
    expect(keys.slice(0, MENU_KEYS.length)).toEqual([...MENU_KEYS]);
    expect(keys.slice(MENU_KEYS.length)).toEqual([PROPERTIES, LEASES, BOOKS]);
    // An add-on with no places adds none; one that isn't in the catalogue adds nothing at all.
    expect(menuKeys(menuFor(DEFAULT_MENU, owner, running('fxquiet', 'fxgone')))).toEqual([
      ...MENU_KEYS,
    ]);
  });

  it('never shows a place of an add-on that isn’t running, and keeps it in the saved menu', () => {
    const saved: Menu = {
      entries: [
        link('home'),
        link(BOOKS),
        { kind: 'group', id: 'g1', label: 'Rentals', keys: [PROPERTIES, LEASES] },
        link('settings'),
      ],
      hidden: [],
    };
    // Property Management is off: its group has nothing left to show, so it goes too.
    const off = menuFor(saved, owner, running('fxacct'));
    expect(off.entries).toEqual([link('home'), link(BOOKS), link('settings')]);
    // No add-ons known at all (an older caller): only core's places.
    expect(menuFor(saved, owner).entries).toEqual([link('home'), link('settings')]);
    // Back on: everything where it was, nothing added at the end.
    expect(menuFor(saved, owner, running('fxacct', 'fxprop')).entries).toEqual(saved.entries);
  });

  it('keeps a place the person hid out of the menu, rather than adding it back at the end', () => {
    const hid: Menu = { entries: DEFAULT_MENU.entries, hidden: [PROPERTIES] };
    const keys = menuKeys(menuFor(hid, owner, running('fxprop')));
    expect(keys).not.toContain(PROPERTIES);
    expect(keys).toContain(LEASES);
  });

  it('shows a place only to people who may open it', () => {
    const readOnly = ownerWith('fxprop.read');
    // Properties names no permission: anyone holding one of the add-on's sees it. Leases needs fxprop.write.
    expect(addonMenuPlaces(readOnly, running('fxprop'))).toEqual([PROPERTIES]);
    // Someone the business gives none of the add-on's permissions sees none of its places.
    expect(addonMenuPlaces(effectivePermissions('member'), running('fxprop'))).toEqual([]);
    // An add-on that declares no permissions of its own is for everyone in the business.
    expect(addonMenuPlaces(effectivePermissions('member'), running('fxboard'))).toEqual([BOARD]);
    expect(menuPlaceOpen(LEASES, readOnly, running('fxprop'))).toBe(false);
    expect(menuPlaceOpen(PROPERTIES, readOnly, running('fxprop'))).toBe(true);
    expect(menuPlaceOpen(PROPERTIES, readOnly, running())).toBe(false);
    expect(menuPlaceOpen('audit', effectivePermissions('member'), running('fxprop'))).toBe(false);
  });

  it('offers no add-on place without the person’s permissions, and leaves an old copy as saved', () => {
    const saved: Menu = { entries: [link('home'), link(PROPERTIES)], hidden: [] };
    expect(menuFor(saved, null, running('fxprop')).entries).toEqual([link('home')]);
    expect(addonMenuPlaces(undefined, running('fxprop'))).toEqual([]);
    expect(menuFor(SUGGESTED_MENU, null, running('fxprop'))).toBe(SUGGESTED_MENU);
  });

  it('knows which add-on and entry a place stands for', () => {
    expect(addonMenuPlace(CATALOG, LEASES)).toEqual({ addon: fxprop, nav: fxprop.ui!.nav![1] });
    expect(addonMenuPlace(CATALOG, addonMenuKey('fxprop', 'gone'))).toBeNull();
    expect(addonMenuPlace(CATALOG, 'inbox')).toBeNull();
  });

  it('adds only the places a menu has never held', () => {
    const menu = withAddonPlaces(
      { entries: [link('home'), link(BOOKS)], hidden: [LEASES] },
      owner,
      running('fxprop', 'fxacct'),
    );
    expect(menuKeys(menu)).toEqual(['home', BOOKS, PROPERTIES]);
    const same: Menu = { entries: [link('home')], hidden: [] };
    expect(withAddonPlaces(same, owner, running())).toBe(same);
  });
});

describe('editing a menu with places this business doesn’t show', () => {
  // The editor lists only what is open here: Books belongs to an add-on that is off.
  const open = (key: MenuPlaceKey) => key !== BOOKS;

  it('steps a row past the next one listed, leaving the others where they are', () => {
    const menu: Menu = { entries: [link('home'), link(BOOKS), link('inbox')], hidden: [] };
    expect(moveEntry(menu, 2, -1, open).entries).toEqual([
      link('inbox'),
      link(BOOKS),
      link('home'),
    ]);
    expect(moveEntry(menu, 0, 1, open).entries).toEqual([link('inbox'), link(BOOKS), link('home')]);
    // Nothing listed above: it stays put.
    const first: Menu = { entries: [link(BOOKS), link('home')], hidden: [] };
    expect(moveEntry(first, 1, -1, open).entries).toEqual(first.entries);
  });

  it('does the same inside a group', () => {
    const menu: Menu = {
      entries: [{ kind: 'group', id: 'g1', label: 'More', keys: ['tasks', BOOKS, 'audit'] }],
      hidden: [],
    };
    const moved = moveInGroup(menu, 'g1', 2, -1, open);
    expect((moved.entries[0] as MenuGroup).keys).toEqual(['audit', BOOKS, 'tasks']);
  });

  it('lists a group holding a place open here, or nothing yet, and not one holding only others', () => {
    expect(entryShown({ kind: 'group', id: 'g', label: 'A', keys: [BOOKS] }, open)).toBe(false);
    expect(entryShown({ kind: 'group', id: 'g', label: 'A', keys: [BOOKS, 'tasks'] }, open)).toBe(
      true,
    );
    expect(entryShown({ kind: 'group', id: 'g', label: 'A', keys: [] }, open)).toBe(true);
    expect(entryShown(link(BOOKS), open)).toBe(false);
  });

  it('moves and hides an add-on’s place like any other, and still never hides Home', () => {
    const menu = moveKey(DEFAULT_MENU, PROPERTIES, 'hidden');
    expect(menu.hidden).toEqual([PROPERTIES]);
    expect(moveKey(menu, PROPERTIES, 'menu').entries.at(-1)).toEqual(link(PROPERTIES));
    expect(moveKey(menu, 'home', 'hidden')).toBe(menu);
  });
});

describe('which place the open page is in', () => {
  const ws = '/app/w/b1';
  const places = [
    { key: 'home', href: ws, exact: true },
    { key: 'forms', href: `${ws}/forms` },
    { key: 'properties', href: `${ws}/a/fxprop` },
    { key: 'leases', href: `${ws}/a/fxprop/leases` },
  ];

  it('matches whole segments, so /forms-pro is not Forms (FE-2)', () => {
    expect(inMenuPlace(`${ws}/forms`, `${ws}/forms`)).toBe(true);
    expect(inMenuPlace(`${ws}/forms/f1/responses`, `${ws}/forms`)).toBe(true);
    expect(inMenuPlace(`${ws}/forms-pro`, `${ws}/forms`)).toBe(false);
    expect(inMenuPlace(`${ws}/forms`, ws, true)).toBe(false);
    expect(inMenuPlace(ws, ws, true)).toBe(true);
  });

  it('picks the deepest place the page is in', () => {
    expect(currentMenuPlace(places, `${ws}/a/fxprop/leases/l1`)?.key).toBe('leases');
    expect(currentMenuPlace(places, `${ws}/a/fxprop/units`)?.key).toBe('properties');
    expect(currentMenuPlace(places, `${ws}/forms-pro`)).toBeUndefined();
    expect(currentMenuPlace(places, ws)?.key).toBe('home');
  });
});
