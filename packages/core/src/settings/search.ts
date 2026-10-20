/**
 * Settings search (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "Web: Settings search" and "Phone: Settings search"):
 * core's catalogue, searched on the device as a person types, with nothing sent anywhere. The web's Search settings
 * box, the phone's Settings and the main search's Settings group all run this, so each finds the same settings, in the
 * same order, gated the same way as the Settings menu.
 *
 * Words are folded as search folds them (`search/fold.ts`), so a word typed without its accents finds it written
 * with them, and the marks fit the label. The catalogue is written with curly apostrophes and a keyboard types straight
 * ones, so every apostrophe is read as one, and a typed hyphen splits words ("opt-out" finds "opt out"). Every typed
 * word has to be somewhere: in the setting's own label, its other words or its section, or the page and group around
 * it, and at least one in the setting itself, so "texting" finds the Texting & calls page rather than every row on it.
 * With nothing found, a typo gets the close-match check search uses (decision 26).
 */
import { ADDON_CATALOG } from '../addons/catalog';
import type { SearchGroup, SearchHit } from '../schemas/search';
import { closeWorthTrying, wordIsClose } from '../search/close';
import { fold } from '../search/fold';
import { searchProbes } from '../search/probes';
import { startsAWord, tierOf } from '../search/rank';
import { marksIn } from '../search/snippet';
import { SETTINGS, type SettingEntry } from './catalog';
import {
  SETTINGS_PAGES,
  settingsFeatureHere,
  settingsPage,
  settingsPageShown,
  type SettingsViewer,
} from './pages';

export interface SettingHit {
  readonly entry: SettingEntry;
  /** Where the label matched, `[start, end)`, drawn as text inside `<mark>`. */
  readonly marks: [number, number][];
  /** Higher is better. */
  readonly score: number;
  /**
   * Search's tier (`search/rank.ts`): 1 when every word starts a word of the label, 2 when the label holds them all,
   * 3 when they're in its other words or section, 5 for a close match.
   */
  readonly tier: 1 | 2 | 3 | 5;
  /** Close to what was typed rather than holding it (a typo). */
  readonly close: boolean;
  /** What it sits under: the menu's group ("Messages"), the add-on's name, or "This phone". */
  readonly group: string;
  /** Its page's label, or the add-on's name; null for the phone's own. */
  readonly pageLabel: string | null;
}

export interface SettingsSearchOptions extends SettingsViewer {
  /** The phone lists its own settings too (Face ID); the web never does. */
  readonly surface: 'web' | 'phone';
  /** They answer HandsFreeOS support, so New support tickets is theirs. Left out, it isn't listed. */
  readonly staff?: boolean;
  /** An owner or admin of an organization with more than one business (`managesAnAgency`): Daily agency digest. */
  readonly agency?: boolean;
}

/** Typed text past this is cut: no setting is named at such length, and every keystroke runs this. */
const TYPED_MAX = 100;

/** Every apostrophe as one, so a typed "can't" finds "can’t". One character for one, so marks still fit. */
const oneApostrophe = (text: string) => text.replace(/[’‘`]/g, "'");

const addonName = (id: string) => ADDON_CATALOG.find((m) => m.id === id)?.name ?? id;

/** What an entry sits under, as the results group it. */
function placeOf(entry: SettingEntry): { group: string; pageLabel: string | null } {
  if (entry.page) {
    const page = settingsPage(entry.page);
    return { group: page.group, pageLabel: page.label };
  }
  if (entry.addon) return { group: addonName(entry.addon), pageLabel: addonName(entry.addon) };
  return { group: entry.section ?? '', pageLabel: null };
}

/**
 * Whether this person may see the entry: as the Settings menu shows its page, its own needs, and a row only some people
 * have (`only`) as their Notifications show it.
 */
function shown(entry: SettingEntry, viewer: SettingsSearchOptions): boolean {
  if (entry.page && !settingsPageShown(settingsPage(entry.page), viewer)) return false;
  if (entry.needs && !viewer.permissions.includes(entry.needs)) return false;
  if (entry.feature && !settingsFeatureHere(viewer, entry.feature)) return false;
  if (entry.only && !viewer[entry.only]) return false;
  if (entry.addon) {
    const manifest = ADDON_CATALOG.find((m) => m.id === entry.addon);
    // An add-on's permissions are only someone's while it runs, so with no list of what runs they answer it.
    const runs = viewer.addons
      ? viewer.addons.includes(entry.addon)
      : !!manifest?.permissions.some((p) => viewer.permissions.includes(p.key));
    if (!runs) return false;
  }
  return true;
}

/**
 * How well an entry matches the typed words (folded): 0 is no match. A word at the start of the label scores most,
 * then at the start of one of its words, then in its other words or section, then anywhere in them; the page and
 * group only help.
 */
function scoreOf(entry: SettingEntry, words: readonly string[], around: readonly string[]): number {
  const label = oneApostrophe(fold(entry.label));
  const own = [...entry.words, ...(entry.section ? [entry.section] : [])].map((w) =>
    oneApostrophe(fold(w)),
  );
  let total = 0;
  let mine = false;
  for (const w of words) {
    if (label.startsWith(w)) total += 6;
    else if (startsAWord(label, w)) total += 5;
    else if (own.some((o) => startsAWord(o, w))) total += 3;
    else if (label.includes(w) || own.some((o) => o.includes(w))) total += 2;
    else if (around.some((a) => startsAWord(a, w))) {
      total += 1;
      continue;
    } else return 0;
    mine = true;
  }
  return mine ? total : 0;
}

const CLOSE_WORDS = new Map<SettingEntry, readonly string[]>();

/** An entry's words for the close-match check, from its label, section and other words, worked out once. */
function closeWordsOf(entry: SettingEntry): readonly string[] {
  let words = CLOSE_WORDS.get(entry);
  if (!words) {
    words = fold([entry.label, entry.section ?? '', ...entry.words].join(' '))
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);
    CLOSE_WORDS.set(entry, words);
  }
  return words;
}

/**
 * Whether every typed word is close to a word of the entry's label, other words or section. An apostrophe splits
 * words on both sides ("can’t" is "can" and "t"), as a hyphen does.
 */
function closeTo(entry: SettingEntry, words: readonly string[]): boolean {
  const theirs = closeWordsOf(entry);
  return words
    .flatMap((w) => w.split(/[^\p{L}\p{N}]+/u))
    .filter(Boolean)
    .every((typed) => theirs.some((w) => wordIsClose(typed, w)));
}

/**
 * The settings that match what was typed, best first, for this person: gated as the Settings menu is (`can` and the
 * add-ons running), and each entry by its own needs. Nothing for fewer than 2 characters.
 */
export function searchSettings(q: string, opts: SettingsSearchOptions): SettingHit[] {
  const typed = searchProbes(q.slice(0, TYPED_MAX));
  // A typed hyphen splits words, and every apostrophe reads as one, on the probes the marks are found with too.
  const words = [
    ...new Set(
      typed.folded
        .flatMap((w) => oneApostrophe(w).split('-'))
        .filter((w) => /[\p{L}\p{N}]/u.test(w)),
    ),
  ];
  if (typed.tooShort || words.length === 0) return [];
  const probes = { ...typed, folded: words };
  const candidates = SETTINGS.filter(
    (e) => (opts.surface === 'phone' || e.kind !== 'phone') && shown(e, opts),
  );
  const hitOf = (entry: SettingEntry, score: number, close: boolean): SettingHit => ({
    entry,
    marks: close ? [] : marksIn(oneApostrophe(entry.label), probes),
    score,
    tier: close ? 5 : (tierOf(oneApostrophe(entry.label), probes) ?? 3),
    close,
    ...placeOf(entry),
  });

  const found = candidates
    .map((entry, order) => {
      const place = placeOf(entry);
      const around = [place.pageLabel ?? '', place.group].map(fold);
      return { entry, order, score: scoreOf(entry, words, around) };
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order);
  if (found.length > 0) return found.map((m) => hitOf(m.entry, m.score, false));
  if (!closeWorthTrying(words)) return [];
  return candidates.filter((e) => closeTo(e, words)).map((e) => hitOf(e, 0, true));
}

/** Where a setting opens on the web: `/app/w/<business>/settings/texting#quiet-hours`. */
export function settingHref(workspaceId: string, entry: SettingEntry): string {
  return `/app/w/${workspaceId}/${entry.path}${entry.open ? `?${entry.open}` : ''}${
    entry.anchor ? `#${entry.anchor}` : ''
  }`;
}

/**
 * Where a setting opens on the phone: a screen of its own (`settings/notifications?setting=…`, flashed in place), or
 * the web at that setting, anchor and all, for one only the web changes.
 */
export function settingPhoneTarget(
  workspaceId: string,
  entry: SettingEntry,
):
  | { readonly kind: 'screen'; readonly href: string }
  | { readonly kind: 'web'; readonly path: string } {
  return entry.phone === 'web'
    ? { kind: 'web', path: settingHref(workspaceId, entry) }
    : { kind: 'screen', href: `/app/w/${workspaceId}/${entry.phone}` };
}

/** One page of results, as the Settings menu draws them: the page, then its settings that matched. */
export interface SettingsResultPage {
  /** A page's key, or `addon:<id>`. */
  readonly key: string;
  readonly label: string;
  /** Where the page itself opens, under /app/w/<business>/. */
  readonly path: string;
  /** Its own entry, when the page matched by its name. */
  readonly page: SettingHit | null;
  /** Its settings that matched, best first. */
  readonly hits: readonly SettingHit[];
}

export interface SettingsResultGroup {
  /** The menu's group ("Messages"), an add-on's name, or "This phone". */
  readonly label: string;
  readonly pages: readonly SettingsResultPage[];
}

/**
 * The results in the menu's order: its groups and pages as the menu lists them, then each add-on's under its own name
 * (Add-ons is at the foot of the side menu, never a Settings page), then the phone's own.
 */
export function settingsByPage(hits: readonly SettingHit[]): SettingsResultGroup[] {
  // The menu's pages by their place in it; then add-ons, then the phone's own, each as they first came.
  const rankOf = (e: SettingEntry, seen: number) =>
    e.page
      ? SETTINGS_PAGES.findIndex((p) => p.key === e.page)
      : (e.addon ? 1 : 2) * SETTINGS_PAGES.length + seen;
  const pages = new Map<string, { group: string; page: SettingsResultPage; rank: number }>();
  for (const hit of hits) {
    const e = hit.entry;
    const key = e.page ?? (e.addon ? `addon:${e.addon}` : `phone:${e.section ?? ''}`);
    let at = pages.get(key);
    if (!at) {
      at = {
        group: hit.group,
        rank: rankOf(e, pages.size),
        page: {
          key,
          label: hit.pageLabel ?? hit.group,
          path: e.page ? `settings${settingsPage(e.page).path}` : e.path,
          page: null,
          hits: [],
        },
      };
      pages.set(key, at);
    }
    if (e.kind === 'page') at.page = { ...at.page, page: hit };
    else at.page = { ...at.page, hits: [...at.page.hits, hit] };
  }
  const groups: SettingsResultGroup[] = [];
  for (const { group, page } of [...pages.values()].sort((a, b) => a.rank - b.rank)) {
    const last = groups[groups.length - 1];
    if (last && last.label === group)
      groups[groups.length - 1] = { ...last, pages: [...last.pages, page] };
    else groups.push({ label: group, pages: [page] });
  }
  return groups;
}

/** How many settings matched, and on how many pages, for `settingsFound`. A page matched by its name is no setting. */
export function settingsCount(hits: readonly SettingHit[]): { settings: number; pages: number } {
  return {
    settings: hits.filter((h) => h.entry.kind !== 'page').length,
    pages: settingsByPage(hits).reduce((n, g) => n + g.pages.length, 0),
  };
}

/**
 * The Settings group of the main search, worked out on the device and merged into the server's answer by `dropdownOf`:
 * each setting as a hit whose line `hitLines` prints ("Settings › Texting & calls · 9:00 PM to 8:00 AM"). A setting's
 * id is its catalogue key; the group never leaves the device.
 *
 * A setting that's only close to what was typed is left out: the main search's close matches are names, and only a
 * setting that really matched means the words were spelled right (`settingsMatched`, decision 26). Null when none did.
 */
export function settingsSearchGroup(
  workspaceId: string,
  hits: readonly SettingHit[],
  now: { readonly settings: Readonly<Record<string, unknown>> | null; readonly timeZone: string },
): SearchGroup | null {
  const matched = hits.filter((h) => !h.close);
  if (matched.length === 0) return null;
  const hitOf = (h: SettingHit): SearchHit => {
    const value = h.entry.value?.(now.settings, now.timeZone) ?? null;
    return {
      kind: 'settings',
      id: h.entry.key,
      title: h.entry.label,
      subtitle: null,
      badges: [],
      why: { field: 'setting', label: null, snippet: null, page: null },
      tier: h.tier,
      exact: false,
      at: null,
      href: settingHref(workspaceId, h.entry),
      contact: null,
      amount: null,
      facts: { ...(h.pageLabel ? { on: h.pageLabel } : {}), ...(value ? { status: value } : {}) },
      duplicateOf: null,
    };
  };
  return {
    kind: 'settings',
    label: null,
    icon: null,
    total: matched.length,
    capped: false,
    complete: true,
    searchedBack: null,
    unavailable: null,
    items: matched.map(hitOf),
  };
}
