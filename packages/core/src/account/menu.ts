/**
 * The side menu, as each person arranges it. One list of places (Home, Inbox, Customers…), which a person can
 * reorder, fold into groups of their own ("More", "Back office"), or hide — kept with the account under
 * `users.settings.menu`, so a desk and a laptop show the same menu.
 *
 * - **Shape:** `entries` is the menu top to bottom. An entry is either a link to one place or a group with a
 *   name and the places inside it, which the sidebar opens on hover or a press. `hidden` is what the person
 *   took out; nothing is lost, and the editor lists it so it can come back.
 * - **Forgiving:** `menuOf` never throws and never leaves a place unreachable. Anything it doesn't recognise
 *   (a section that has since gone, a group with nothing in it, the same place twice) is dropped, and any
 *   place the stored menu has never heard of — a section that shipped after it was saved — is put back where
 *   it would have been, beside the neighbour it ships next to. So a new section appears on its own, in the
 *   right place, without anyone editing anything.
 * - **Always there:** Home and Settings can be moved or grouped but never hidden, so there is always a way
 *   home and always a way back to this editor.
 *
 * The words each place goes by, its icon and its address are the web's (components/shell/nav-links.tsx); this
 * file knows only the keys, so the layout can be read and checked anywhere.
 */
import { z } from 'zod';
import type { WorkspacePermission } from '../permissions';

/** Every place the menu can hold, in the order a new account sees them. */
export const MENU_KEYS = [
  'home',
  'inbox',
  'customers',
  'pipeline',
  'calendar',
  'money',
  'workflows',
  'campaigns',
  'forms',
  'reviews',
  'knowledge',
  'ai-team',
  'tasks',
  'members',
  'audit',
  'settings',
] as const;
export type MenuKey = (typeof MENU_KEYS)[number];

const KEY_SET: ReadonlySet<string> = new Set(MENU_KEYS);
export const isMenuKey = (v: unknown): v is MenuKey => typeof v === 'string' && KEY_SET.has(v);

/** Movable and groupable, but never hidden: the way home, and the way back to the editor. */
export const MENU_ALWAYS_SHOWN: readonly MenuKey[] = ['home', 'settings'];

/** How many groups one menu may hold, and how long a group's name may be. */
export const MENU_GROUPS_MAX = 5;
export const MENU_GROUP_LABEL_MAX = 24;
/** What a group is called until it is named. */
export const MENU_GROUP_DEFAULT_LABEL = 'More';

export interface MenuLink {
  readonly kind: 'link';
  readonly key: MenuKey;
}
export interface MenuGroup {
  readonly kind: 'group';
  /** Steady across saves, so an open group stays open while the menu is edited. */
  readonly id: string;
  readonly label: string;
  readonly keys: readonly MenuKey[];
}
export type MenuEntry = MenuLink | MenuGroup;

export interface Menu {
  /** The menu top to bottom. */
  readonly entries: readonly MenuEntry[];
  /** Taken out of the menu; the editor lists these so they can come back. */
  readonly hidden: readonly MenuKey[];
}

/** What a save writes to `users.settings.menu`; `v` is there so an older menu can be read forward. */
export const StoredMenu = z.object({
  v: z.literal(1),
  entries: z.array(
    z.union([
      z.object({ kind: z.literal('link'), key: z.string() }),
      z.object({
        kind: z.literal('group'),
        id: z.string(),
        label: z.string(),
        keys: z.array(z.string()),
      }),
    ]),
  ),
  hidden: z.array(z.string()),
});
export type StoredMenu = z.infer<typeof StoredMenu>;

/** Every place, one under the other: what someone who has never touched their menu sees. */
export const DEFAULT_MENU: Menu = {
  entries: MENU_KEYS.map((key) => ({ kind: 'link', key })),
  hidden: [],
};

/**
 * The tidy-up the editor offers in one press: the places a day is spent in stay out, and the rest fold into
 * **More**. Nine rows instead of fifteen, and nothing is lost.
 */
export const SUGGESTED_MENU: Menu = {
  entries: [
    { kind: 'link', key: 'home' },
    { kind: 'link', key: 'inbox' },
    { kind: 'link', key: 'customers' },
    { kind: 'link', key: 'pipeline' },
    { kind: 'link', key: 'calendar' },
    { kind: 'link', key: 'money' },
    { kind: 'link', key: 'tasks' },
    {
      kind: 'group',
      id: 'more',
      label: MENU_GROUP_DEFAULT_LABEL,
      keys: [
        'workflows',
        'campaigns',
        'forms',
        'reviews',
        'knowledge',
        'ai-team',
        'members',
        'audit',
      ],
    },
    { kind: 'link', key: 'settings' },
  ],
  hidden: [],
};

/**
 * The places that are nothing without a permission a business may take away (0105): Money without seeing bills,
 * the inbox without using it, the audit log without reading it.
 */
export const MENU_NEEDS: Readonly<Partial<Record<MenuKey, WorkspacePermission>>> = {
  inbox: 'inbox.use',
  money: 'money.read',
  audit: 'audit.read',
};

/**
 * The menu as this person sees it in one business: the places they may not open are left out, and a group left
 * with nothing in it goes too. Their saved menu keeps every place, so one comes back where it was the moment the
 * business lets them in. Without their permissions (an older copy), the menu as saved.
 */
export function menuFor(menu: Menu, permissions: readonly string[] | null | undefined): Menu {
  if (!permissions) return menu;
  const open = (key: MenuKey) => {
    const needs = MENU_NEEDS[key];
    return !needs || permissions.includes(needs);
  };
  return {
    entries: menu.entries.flatMap((e): MenuEntry[] => {
      if (e.kind === 'link') return open(e.key) ? [e] : [];
      const keys = e.keys.filter(open);
      return keys.length ? [{ ...e, keys }] : [];
    }),
    hidden: menu.hidden,
  };
}

/** The places an entry holds, in order. */
export function entryKeys(entry: MenuEntry): readonly MenuKey[] {
  return entry.kind === 'link' ? [entry.key] : entry.keys;
}

/** Every place the menu shows, groups included, top to bottom. */
export function menuKeys(menu: Menu): readonly MenuKey[] {
  return menu.entries.flatMap(entryKeys);
}

/** A group id nothing else in this menu uses. */
export function nextGroupId(menu: Menu): string {
  const taken = new Set(menu.entries.filter((e) => e.kind === 'group').map((e) => e.id));
  for (let n = 1; ; n += 1) {
    const id = `g${n}`;
    if (!taken.has(id)) return id;
  }
}

function cleanLabel(label: string): string {
  const trimmed = label.replace(/\s+/g, ' ').trim().slice(0, MENU_GROUP_LABEL_MAX);
  return trimmed || MENU_GROUP_DEFAULT_LABEL;
}

/**
 * A menu that can be drawn: known places only, each in one place, no empty group, no more groups than
 * `MENU_GROUPS_MAX` (the ones over that spill back into the menu), Home and Settings never hidden, and any
 * place the input never mentioned put back beside the neighbour it ships next to.
 */
export function normalizeMenu(input: Menu): Menu {
  const seen = new Set<MenuKey>();
  const ids = new Set<string>();
  const entries: MenuEntry[] = [];
  let groups = 0;

  for (const entry of input.entries) {
    if (entry.kind === 'link') {
      if (!isMenuKey(entry.key) || seen.has(entry.key)) continue;
      seen.add(entry.key);
      entries.push({ kind: 'link', key: entry.key });
      continue;
    }
    const keys: MenuKey[] = [];
    for (const key of entry.keys) {
      if (!isMenuKey(key) || seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
    if (keys.length === 0) continue;
    // Past the limit a group is no group at all: its places go back into the menu where the group stood.
    if (groups >= MENU_GROUPS_MAX) {
      for (const key of keys) entries.push({ kind: 'link', key });
      continue;
    }
    let id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim().slice(0, 32) : '';
    for (let n = 1; !id || ids.has(id); n += 1) id = `g${n}`;
    ids.add(id);
    groups += 1;
    entries.push({ kind: 'group', id, label: cleanLabel(entry.label ?? ''), keys });
  }

  const hidden: MenuKey[] = [];
  for (const key of input.hidden) {
    if (!isMenuKey(key) || seen.has(key) || MENU_ALWAYS_SHOWN.includes(key)) continue;
    seen.add(key);
    hidden.push(key);
  }

  // Places this menu has never heard of, put back beside the neighbour they ship next to.
  MENU_KEYS.forEach((key, index) => {
    if (seen.has(key)) return;
    seen.add(key);
    let at = 0;
    for (let i = index - 1; i >= 0; i -= 1) {
      const before = MENU_KEYS[i]!;
      const holder = entries.findIndex((e) => entryKeys(e).includes(before));
      if (holder >= 0) {
        at = holder + 1;
        break;
      }
    }
    entries.splice(at, 0, { kind: 'link', key });
  });

  return { entries, hidden };
}

/** One person's menu, from their settings: what they arranged, else every place one under the other. */
export function menuOf(settings: unknown): Menu {
  const raw =
    typeof settings === 'object' && settings !== null && !Array.isArray(settings)
      ? (settings as Record<string, unknown>)['menu']
      : undefined;
  const parsed = StoredMenu.safeParse(raw);
  if (!parsed.success) return DEFAULT_MENU;
  return normalizeMenu({
    entries: parsed.data.entries.map((e) =>
      e.kind === 'link'
        ? ({ kind: 'link', key: e.key } as MenuEntry)
        : ({ kind: 'group', id: e.id, label: e.label, keys: e.keys } as MenuEntry),
    ) as MenuEntry[],
    hidden: parsed.data.hidden as MenuKey[],
  });
}

/** A menu as `user.update_profile` sends it (`settings: { menu: … }`, a top-level key replaced whole). */
export function storedMenu(menu: Menu): StoredMenu {
  const clean = normalizeMenu(menu);
  return {
    v: 1,
    entries: clean.entries.map((e) =>
      e.kind === 'link'
        ? { kind: 'link', key: e.key }
        : { kind: 'group', id: e.id, label: e.label, keys: [...e.keys] },
    ),
    hidden: [...clean.hidden],
  };
}

/** Whether two menus say the same thing (the editor's Save is off until something changes). */
export function sameMenu(a: Menu, b: Menu): boolean {
  return JSON.stringify(storedMenu(a)) === JSON.stringify(storedMenu(b));
}

// ---------- editing ----------

/** Where a place can be sent: the menu itself, one of its groups, a new group of its own, or out of sight. */
export type MenuTarget = 'menu' | 'hidden' | 'new' | { readonly group: string };

/**
 * These work on a menu being edited, so they leave a group with nothing in it alone — one just emptied must not
 * vanish under the hand that emptied it. `normalizeMenu` drops it when the arrangement is saved.
 */

/** The place, out of wherever it is now. */
export function withoutKey(menu: Menu, key: MenuKey): Menu {
  return {
    entries: menu.entries.flatMap((e): MenuEntry[] =>
      e.kind === 'link'
        ? e.key === key
          ? []
          : [e]
        : [{ ...e, keys: e.keys.filter((k) => k !== key) }],
    ),
    hidden: menu.hidden.filter((k) => k !== key),
  };
}

/** The place, moved to the end of wherever it is being sent. */
export function moveKey(menu: Menu, key: MenuKey, target: MenuTarget): Menu {
  const base = withoutKey(menu, key);
  if (target === 'hidden') {
    // Home and Settings stay in the menu whatever is asked of them.
    if (MENU_ALWAYS_SHOWN.includes(key)) return menu;
    return { ...base, hidden: [...base.hidden, key] };
  }
  if (target === 'menu') {
    // Out of a group, it lands straight under that group, where the eye last had it; from anywhere else
    // (hiding, or the menu itself) it goes to the end, where a menu grows.
    const from = menu.entries.findIndex((e) => e.kind === 'group' && e.keys.includes(key));
    const entries = [...base.entries];
    entries.splice(from < 0 ? entries.length : from + 1, 0, { kind: 'link', key });
    return { ...base, entries };
  }
  if (target === 'new')
    return {
      ...base,
      entries: [
        ...base.entries,
        { kind: 'group', id: nextGroupId(base), label: MENU_GROUP_DEFAULT_LABEL, keys: [key] },
      ],
    };
  const into = base.entries.some((e) => e.kind === 'group' && e.id === target.group);
  if (!into) return menu;
  return {
    ...base,
    entries: base.entries.map((e) =>
      e.kind === 'group' && e.id === target.group ? { ...e, keys: [...e.keys, key] } : e,
    ),
  };
}

function swapAt<T>(list: readonly T[], at: number, by: -1 | 1): T[] {
  const next = [...list];
  const to = at + by;
  if (at < 0 || at >= next.length || to < 0 || to >= next.length) return next;
  [next[at], next[to]] = [next[to]!, next[at]!];
  return next;
}

/** One row of the menu — a place or a whole group — a step up or down. */
export function moveEntry(menu: Menu, at: number, by: -1 | 1): Menu {
  return { ...menu, entries: swapAt(menu.entries, at, by) };
}

/** One place inside a group, a step up or down within it. */
export function moveInGroup(menu: Menu, groupId: string, at: number, by: -1 | 1): Menu {
  return {
    ...menu,
    entries: menu.entries.map((e) =>
      e.kind === 'group' && e.id === groupId ? { ...e, keys: swapAt(e.keys, at, by) } : e,
    ),
  };
}

/** The group goes; what was in it takes its place in the menu, in the order it was in. */
export function ungroup(menu: Menu, groupId: string): Menu {
  return {
    ...menu,
    entries: menu.entries.flatMap((e): MenuEntry[] =>
      e.kind === 'group' && e.id === groupId ? e.keys.map((key) => ({ kind: 'link', key })) : [e],
    ),
  };
}

/** A new, empty group at the end of the menu, ready to be named and filled. */
export function addGroup(menu: Menu): Menu {
  if (menu.entries.filter((e) => e.kind === 'group').length >= MENU_GROUPS_MAX) return menu;
  return {
    ...menu,
    entries: [
      ...menu.entries,
      { kind: 'group', id: nextGroupId(menu), label: MENU_GROUP_DEFAULT_LABEL, keys: [] },
    ],
  };
}

/** What a group is called. Tidied on the way to being saved, not while it is being typed. */
export function renameGroup(menu: Menu, groupId: string, label: string): Menu {
  return {
    ...menu,
    entries: menu.entries.map((e) =>
      e.kind === 'group' && e.id === groupId ? { ...e, label } : e,
    ),
  };
}

/** What a menu holds, in a line: "9 in the menu · 1 group · 2 hidden". */
export function menuSummary(menu: Menu): string {
  const clean = normalizeMenu(menu);
  const groups = clean.entries.filter((e) => e.kind === 'group').length;
  const parts = [`${clean.entries.length} in the menu`];
  if (groups > 0) parts.push(groups === 1 ? '1 group' : `${groups} groups`);
  if (clean.hidden.length > 0) parts.push(`${clean.hidden.length} hidden`);
  return parts.join(' · ');
}

/** The words on the menu editor, on the web and wherever else a menu is arranged. */
export const MENU_WORDS = {
  edit: 'Edit menu',
  title: 'Edit menu',
  /** The card on Settings → Account. */
  sectionTitle: 'Side menu',
  intro:
    'Your menu, on every device you sign in on. Move a place up or down, put the ones you rarely need in a group, and hide what you never open.',
  inMenu: 'In the menu',
  hidden: 'Hidden',
  hiddenEmpty: 'Nothing hidden.',
  hiddenHint: 'Hidden places still open from search and from a link.',
  addGroup: 'Add a group',
  groupName: 'Group name',
  groupEmpty: 'Nothing in here yet. An empty group is dropped when you save.',
  ungroup: 'Ungroup',
  moveTo: 'Move to',
  moveUp: 'Move up',
  moveDown: 'Move down',
  hide: 'Hide',
  show: 'Show',
  pinned: 'Always in the menu',
  suggest: 'Use suggested groups',
  suggestHint: 'Keeps the everyday places out and folds the rest into More.',
  reset: 'Start over',
  resetHint: 'Every place, one under the other.',
  save: 'Save menu',
  saving: 'Saving',
  saved: 'Menu saved.',
  cancel: 'Cancel',
  groupsFull: `A menu holds up to ${MENU_GROUPS_MAX} groups.`,
} as const;
