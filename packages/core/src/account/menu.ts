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
 * - **Add-ons' places (0108):** an add-on that is on adds places of its own, one for each entry in its manifest's
 *   `ui.nav`, keyed `addon:<add-on id>:<its key>`. A saved menu keeps them like any other place, even while the
 *   add-on is off, so turning it back on puts each one back where the person had it; but `menuFor` shows one only
 *   while its add-on runs in the business and the person may open it. One they have never arranged goes at the end.
 *
 * - **Not in it:** the places about HandsFreeOS itself rather than the business, Add-ons and Ideas (the owner's
 *   decision, 2026-09-28), sit at the foot of the sidebar with Get help and the account, where nobody arranges them.
 *   A saved menu that still names Ideas simply loses it, like any place it no longer knows.
 *
 * The words each place goes by, its icon and its address are the web's (components/shell/nav-links.tsx), and an
 * add-on's are its manifest's; this file knows only the keys, so the layout can be read and checked anywhere.
 */
import { z } from 'zod';
import type { AddonManifest, AddonNavItem } from '../addons/manifest';
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

/** One of an add-on's places (0108): `addon:<add-on id>:<the key its manifest's ui.nav gives it>`. */
export type AddonMenuKey = `addon:${string}:${string}`;
/** Any place a menu can hold: one of core's, or an add-on's. */
export type MenuPlaceKey = MenuKey | AddonMenuKey;

/**
 * A well-formed add-on place: an add-on id (2–16 letters, as manifest.ts's ADDON_ID_PATTERN) and a place key (as
 * `manifestIssues` checks each `ui.nav` key). Anything else that looks like one is dropped like any unknown place.
 */
const ADDON_MENU_KEY = /^addon:([a-z]{2,16}):([a-z][a-z0-9_-]{0,39})$/;

export const isAddonMenuKey = (v: unknown): v is AddonMenuKey =>
  typeof v === 'string' && ADDON_MENU_KEY.test(v);
export const isMenuPlaceKey = (v: unknown): v is MenuPlaceKey => isMenuKey(v) || isAddonMenuKey(v);

/** The key one of an add-on's places goes by in a menu. */
export const addonMenuKey = (addonId: string, navKey: string): AddonMenuKey =>
  `addon:${addonId}:${navKey}`;

/** Movable and groupable, but never hidden: the way home, and the way back to the editor. */
export const MENU_ALWAYS_SHOWN: readonly MenuKey[] = ['home', 'settings'];

/** Whether a place is one of the two that are never hidden. */
export const isAlwaysShown = (key: MenuPlaceKey): boolean =>
  (MENU_ALWAYS_SHOWN as readonly string[]).includes(key);

/** How many groups one menu may hold, and how long a group's name may be. */
export const MENU_GROUPS_MAX = 5;
export const MENU_GROUP_LABEL_MAX = 24;
/** What a group is called until it is named. */
export const MENU_GROUP_DEFAULT_LABEL = 'More';
/**
 * How many add-ons' places one saved menu keeps. Far more than a business turns on, and it keeps a menu saved by
 * hand from growing without end: core's places are a fixed list, add-ons' are whatever the saved menu names.
 */
export const MENU_ADDON_PLACES_MAX = 100;

/**
 * The shapes below take the kind of key they hold: any place by default, and core's only (`MenuKey`) for the menus
 * core ships (DEFAULT_MENU, SUGGESTED_MENU), which never name an add-on.
 */
export interface MenuLink<K extends MenuPlaceKey = MenuPlaceKey> {
  readonly kind: 'link';
  readonly key: K;
}
export interface MenuGroup<K extends MenuPlaceKey = MenuPlaceKey> {
  readonly kind: 'group';
  /** Steady across saves, so an open group stays open while the menu is edited. */
  readonly id: string;
  readonly label: string;
  readonly keys: readonly K[];
}
export type MenuEntry<K extends MenuPlaceKey = MenuPlaceKey> = MenuLink<K> | MenuGroup<K>;

export interface Menu<K extends MenuPlaceKey = MenuPlaceKey> {
  /** The menu top to bottom. */
  readonly entries: readonly MenuEntry<K>[];
  /** Taken out of the menu; the editor lists these so they can come back. */
  readonly hidden: readonly K[];
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
export const DEFAULT_MENU: Menu<MenuKey> = {
  entries: MENU_KEYS.map((key) => ({ kind: 'link', key })),
  hidden: [],
};

/**
 * The tidy-up the editor offers in one press: the places a day is spent in stay out, Campaigns among them just
 * above **More** (the owner's decision, 2026-09-28), and the rest fold into More. Ten rows instead of sixteen, and
 * nothing is lost.
 */
export const SUGGESTED_MENU: Menu<MenuKey> = {
  entries: [
    { kind: 'link', key: 'home' },
    { kind: 'link', key: 'inbox' },
    { kind: 'link', key: 'customers' },
    { kind: 'link', key: 'pipeline' },
    { kind: 'link', key: 'calendar' },
    { kind: 'link', key: 'money' },
    { kind: 'link', key: 'tasks' },
    { kind: 'link', key: 'campaigns' },
    {
      kind: 'group',
      id: 'more',
      label: MENU_GROUP_DEFAULT_LABEL,
      keys: ['workflows', 'forms', 'reviews', 'knowledge', 'ai-team', 'members', 'audit'],
    },
    { kind: 'link', key: 'settings' },
  ],
  hidden: [],
};

/**
 * The places that are nothing without a permission a business may take away (0106): Money without seeing bills,
 * the inbox without using it, the audit log without reading it.
 */
export const MENU_NEEDS: Readonly<Partial<Record<MenuKey, WorkspacePermission>>> = {
  inbox: 'inbox.use',
  money: 'money.read',
  audit: 'audit.read',
};

/** What the menu needs to know about add-ons in one business (0108). */
export interface MenuAddons {
  /** The add-ons running there: `addons` on the business in `account.me`, or in `workspace.get`. */
  readonly running: readonly string[];
  /** Where their places come from: the catalogue (`ADDON_CATALOG`), or a test's own. */
  readonly catalog: readonly AddonManifest[];
}

/** The add-on and the entry in its manifest's `ui.nav` a place stands for; null when no add-on here has it. */
export function addonMenuPlace(
  catalog: readonly AddonManifest[],
  key: string,
): { readonly addon: AddonManifest; readonly nav: AddonNavItem } | null {
  const [, addonId, navKey] = ADDON_MENU_KEY.exec(key) ?? [];
  const addon = catalog.find((a) => a.id === addonId);
  const nav = addon?.ui?.nav?.find((n) => n.key === navKey);
  return addon && nav ? { addon, nav } : null;
}

/**
 * Whether a person may open one of an add-on's places. The place's own permission when it names one; otherwise,
 * as the manifest says, anyone who holds one of the add-on's permissions — and anyone at all, for an add-on that
 * declares none.
 */
function addonPlaceAllowed(
  addon: AddonManifest,
  nav: AddonNavItem,
  permissions: readonly string[],
): boolean {
  if (nav.permission) return permissions.includes(nav.permission);
  return (
    addon.permissions.length === 0 || addon.permissions.some((p) => permissions.includes(p.key))
  );
}

/**
 * Whether a place is open to this person in this business. Core's, unless the business keeps them from what it
 * needs (MENU_NEEDS); an add-on's, only while the add-on runs there and they may open it. Without their permissions
 * (an older copy) core's places are open and add-ons' are not: an add-on is never offered on a guess.
 */
export function menuPlaceOpen(
  key: MenuPlaceKey,
  permissions: readonly string[] | null | undefined,
  addons?: MenuAddons,
): boolean {
  if (isMenuKey(key)) {
    const needs = MENU_NEEDS[key];
    return !permissions || !needs || permissions.includes(needs);
  }
  if (!permissions || !addons) return false;
  const place = addonMenuPlace(addons.catalog, key);
  return (
    !!place &&
    addons.running.includes(place.addon.id) &&
    addonPlaceAllowed(place.addon, place.nav, permissions)
  );
}

/** Every add-on place open to this person here: the catalogue's order, and each add-on's own. */
export function addonMenuPlaces(
  permissions: readonly string[] | null | undefined,
  addons?: MenuAddons,
): AddonMenuKey[] {
  if (!permissions || !addons) return [];
  return addons.catalog.flatMap((addon) =>
    addons.running.includes(addon.id)
      ? (addon.ui?.nav ?? [])
          .filter((nav) => addonPlaceAllowed(addon, nav, permissions))
          .map((nav) => addonMenuKey(addon.id, nav.key))
          .filter(isAddonMenuKey)
      : [],
  );
}

/**
 * The menu with the add-on places open to this person that it has never held — shown or hidden — put at the end,
 * after core's, in the catalogue's order: where an add-on that has just been turned on first appears. The same menu
 * when there are none.
 */
export function withAddonPlaces(
  menu: Menu,
  permissions: readonly string[] | null | undefined,
  addons?: MenuAddons,
): Menu {
  const held = new Set<string>([...menuKeys(menu), ...menu.hidden]);
  const missing = addonMenuPlaces(permissions, addons).filter((key) => !held.has(key));
  if (missing.length === 0) return menu;
  return {
    ...menu,
    entries: [...menu.entries, ...missing.map((key): MenuLink => ({ kind: 'link', key }))],
  };
}

/**
 * The menu as this person sees it in one business: the places they may not open are left out, and a group left
 * with nothing in it goes too. Their saved menu keeps every place, so one comes back where it was the moment the
 * business lets them in — or, for an add-on's, the moment it is turned back on. The add-ons running here (0108)
 * add their places, at the end until the person arranges them. Without their permissions (an older copy), core's
 * places as saved.
 */
export function menuFor(
  menu: Menu,
  permissions: readonly string[] | null | undefined,
  addons?: MenuAddons,
): Menu {
  if (!permissions && !menuKeys(menu).some(isAddonMenuKey)) return menu;
  const open = (key: MenuPlaceKey) => menuPlaceOpen(key, permissions, addons);
  return {
    entries: withAddonPlaces(menu, permissions, addons).entries.flatMap((e): MenuEntry[] => {
      if (e.kind === 'link') return open(e.key) ? [e] : [];
      const keys = e.keys.filter(open);
      return keys.length ? [{ ...e, keys }] : [];
    }),
    hidden: menu.hidden,
  };
}

/**
 * Whether the menu editor lists an entry: a place open here, or a group holding one. A group with nothing in it at
 * all is listed too — it has just been made, or emptied, and is still being arranged.
 */
export function entryShown(entry: MenuEntry, open: (key: MenuPlaceKey) => boolean): boolean {
  return entry.kind === 'link' ? open(entry.key) : entry.keys.length === 0 || entry.keys.some(open);
}

/** The places an entry holds, in order. */
export function entryKeys<K extends MenuPlaceKey>(entry: MenuEntry<K>): readonly K[] {
  return entry.kind === 'link' ? [entry.key] : entry.keys;
}

/** Every place the menu shows, groups included, top to bottom. */
export function menuKeys<K extends MenuPlaceKey>(menu: Menu<K>): readonly K[] {
  return menu.entries.flatMap((e) => entryKeys(e));
}

/**
 * Whether the page at `pathname` is in the place at `href`: the place itself or a page under it, by whole
 * segments, so `/forms-pro` is never in Forms (FE-2). An `exact` place (Home) is its own address only.
 */
export function inMenuPlace(pathname: string, href: string, exact = false): boolean {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The one place the page at `pathname` is in: of the places it is in, the one whose address is longest, so an
 * add-on's Leases (`…/a/pm/leases`) wins over its first page (`…/a/pm`).
 */
export function currentMenuPlace<T extends { readonly href: string; readonly exact?: boolean }>(
  places: readonly T[],
  pathname: string,
): T | undefined {
  let best: T | undefined;
  for (const place of places)
    if (
      inMenuPlace(pathname, place.href, place.exact) &&
      place.href.length > (best?.href.length ?? -1)
    )
      best = place;
  return best;
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
 * place the input never mentioned put back beside the neighbour it ships next to. "Known" includes any
 * well-formed add-on place (up to MENU_ADDON_PLACES_MAX): whether its add-on is on is `menuFor`'s question, asked
 * each time the menu is drawn, so an add-on turned off and on again finds its places where the person left them.
 */
export function normalizeMenu(input: Menu): Menu {
  const seen = new Set<MenuPlaceKey>();
  const ids = new Set<string>();
  const entries: MenuEntry[] = [];
  let groups = 0;
  let addonPlaces = 0;
  /** A place this menu can hold and doesn't yet, which it now does. */
  const take = (key: unknown): key is MenuPlaceKey => {
    if (!isMenuPlaceKey(key) || seen.has(key)) return false;
    if (!isMenuKey(key)) {
      if (addonPlaces >= MENU_ADDON_PLACES_MAX) return false;
      addonPlaces += 1;
    }
    seen.add(key);
    return true;
  };

  for (const entry of input.entries) {
    if (entry.kind === 'link') {
      if (!take(entry.key)) continue;
      entries.push({ kind: 'link', key: entry.key });
      continue;
    }
    const keys: MenuPlaceKey[] = [];
    for (const key of entry.keys) if (take(key)) keys.push(key);
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

  const hidden: MenuPlaceKey[] = [];
  for (const key of input.hidden) {
    if (isMenuPlaceKey(key) && isAlwaysShown(key)) continue;
    if (take(key)) hidden.push(key);
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
    hidden: parsed.data.hidden as MenuPlaceKey[],
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
export function withoutKey(menu: Menu, key: MenuPlaceKey): Menu {
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
export function moveKey(menu: Menu, key: MenuPlaceKey, target: MenuTarget): Menu {
  const base = withoutKey(menu, key);
  if (target === 'hidden') {
    // Home and Settings stay in the menu whatever is asked of them.
    if (isAlwaysShown(key)) return menu;
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

/** `at` swapped with its nearest neighbour that way that is `shown`; unchanged at either end. */
function swapAt<T>(
  list: readonly T[],
  at: number,
  by: -1 | 1,
  shown: (item: T) => boolean = () => true,
): T[] {
  const next = [...list];
  let to = at + by;
  while (to >= 0 && to < next.length && !shown(next[to]!)) to += by;
  if (at < 0 || at >= next.length || to < 0 || to >= next.length) return next;
  [next[at], next[to]] = [next[to]!, next[at]!];
  return next;
}

/**
 * One row of the menu — a place or a whole group — a step up or down. With `open` (the places open in this
 * business, which are all the editor lists) the step is past the next row listed, and the rows that aren't — a
 * place the business keeps them from, an add-on that is off here — stay where they are.
 */
export function moveEntry(
  menu: Menu,
  at: number,
  by: -1 | 1,
  open?: (key: MenuPlaceKey) => boolean,
): Menu {
  const shown = open ? (e: MenuEntry) => entryShown(e, open) : undefined;
  return { ...menu, entries: swapAt(menu.entries, at, by, shown) };
}

/** One place inside a group, a step up or down within it (past the next one listed, with `open`). */
export function moveInGroup(
  menu: Menu,
  groupId: string,
  at: number,
  by: -1 | 1,
  open?: (key: MenuPlaceKey) => boolean,
): Menu {
  return {
    ...menu,
    entries: menu.entries.map((e) =>
      e.kind === 'group' && e.id === groupId ? { ...e, keys: swapAt(e.keys, at, by, open) } : e,
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
  /** A newer menu was saved (from the Assistant, or on another device) while the editor was open. */
  changedMeanwhile:
    'Your menu was changed somewhere else while this was open. Here it is now. Make your change again, then save.',
  cancel: 'Cancel',
  groupsFull: `A menu holds up to ${MENU_GROUPS_MAX} groups.`,
} as const;
