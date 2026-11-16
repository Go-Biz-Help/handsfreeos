/**
 * The windows the extension opens (docs/outreach.md, decision 171; the owner, 16 Nov 2026: "the extension keeps a lot
 * of tabs and windows open, we should have it try to limit it to only what it needs"). Two at most:
 *
 * - **The work window,** beside the person's: a tab for each network working right now, the runners', the asks' and
 *   Content Creator's alike (./tab.ts `WorkTab`), each closed the moment its work is done. A tab a page opens from one
 *   goes with it (`closeWorkTab`), and the window closes with its last tab.
 * - **The messages window,** minimized, with a tab for each network's messages (./auto/watch.ts, decision 125).
 *
 * Each window and tab it opens is kept in Chrome's storage with this run's mark (`RUN_KEY`, which Chrome forgets when
 * it starts again and when a new build is loaded), so a background Chrome stopped while idle finds its work window
 * again rather than opening another. A new run first closes what an earlier one left open (`closeLeftovers`), before
 * anything opens.
 */
import { kitHere } from './networks';

/** This run's mark, in Chrome's session storage: gone once Chrome starts again or a new build is loaded. */
const RUN_KEY = 'hfos.run';
/** The windows and tabs this run opened, in Chrome's storage. */
export const OPENED_KEY = 'hfos.opened';
/** A window it opens: the size every network's readers were tuned on. */
export const WIDTH = 1100;
export const HEIGHT = 900;
/** The least height a window of its own may have been given on a short screen. */
const LEAST_HEIGHT = 500;

export interface Opened {
  readonly run: string;
  /** The work window, while it's open. */
  readonly work: number | null;
  /** Each window this run opened, by its number, with the tabs it opened in it. */
  readonly windows: Readonly<Record<string, readonly number[]>>;
}

const isOpened = (value: unknown): value is Opened =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Opened).run === 'string' &&
  typeof (value as Opened).windows === 'object' &&
  (value as Opened).windows !== null;

/** What's kept when Chrome's storage can't be had: this background's own. */
let memory: Opened | null = null;
let begun: Promise<string> | null = null;

/** Whether an address is one of the networks' pages, as the extension's own tabs only ever are. */
export const isWorkPage = (href: string | undefined): boolean =>
  !!href && (href === 'about:blank' || kitHere(href) !== null);

/** Calls Chrome, with null for a failure or a call this Chrome doesn't have. */
const attempt = <T>(call: () => Promise<T>): Promise<T | null> =>
  Promise.resolve()
    .then(call)
    .catch(() => null);

/**
 * Whether a window is the size the extension opens its own at: for what an earlier build, which kept no list, left
 * open. A short screen may have made it a little less tall.
 */
const ourSize = (window: chrome.windows.Window): boolean =>
  window.type === 'normal' &&
  window.width === WIDTH &&
  window.height !== undefined &&
  window.height <= HEIGHT &&
  window.height >= LEAST_HEIGHT;

/**
 * The windows an earlier run left open, of those Chrome has now: one it kept, still holding a tab it opened, or one the
 * size it opens its own at (`ourSize`); either way only while every tab in it is a network's page, and never the one
 * the person is in.
 */
export function leftovers(
  windows: readonly chrome.windows.Window[],
  before: Opened | null,
): number[] {
  const left: number[] = [];
  for (const window of windows) {
    if (window.id === undefined || window.focused || window.incognito) continue;
    const tabs = window.tabs ?? [];
    if (!tabs.length || !tabs.every((tab) => isWorkPage(tab.url ?? tab.pendingUrl))) continue;
    const kept = before?.windows[String(window.id)] ?? [];
    if (kept.some((id) => tabs.some((tab) => tab.id === id)) || ourSize(window))
      left.push(window.id);
  }
  return left;
}

async function storedNow(): Promise<Opened | null> {
  try {
    const value: unknown = (await chrome.storage.local.get(OPENED_KEY))[OPENED_KEY];
    return isOpened(value) ? value : null;
  } catch {
    return memory;
  }
}

/** The last write, which the next waits for. */
let writing: Promise<unknown> = Promise.resolve();

function change(how: (now: Opened) => Opened): Promise<void> {
  const write = writing.then(async () => {
    const run = await ready();
    const stored = await storedNow();
    const now = stored?.run === run ? stored : { run, work: null, windows: {} };
    const next = how(now);
    if (next === now) return;
    memory = next;
    await attempt(() => chrome.storage.local.set({ [OPENED_KEY]: next }));
  });
  writing = write.catch(() => undefined);
  return write.catch(() => undefined);
}

/** What this run opened. */
async function openedNow(): Promise<Opened> {
  const run = await ready();
  const stored = await storedNow();
  return stored?.run === run ? stored : { run, work: null, windows: {} };
}

/**
 * This run's mark, made the first time it's asked for in a new run (Chrome started, or a new build loaded): then
 * what an earlier run left open is closed first. Never fails: without Chrome's session storage, it's one run.
 */
export function ready(): Promise<string> {
  begun ??= (async () => {
    let had: unknown;
    try {
      had = (await chrome.storage.session.get(RUN_KEY))[RUN_KEY];
    } catch {
      return 'here';
    }
    if (typeof had === 'string') return had;
    const run = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    await attempt(() => chrome.storage.session.set({ [RUN_KEY]: run }));
    const before = await storedNow();
    memory = { run, work: null, windows: {} };
    await attempt(() => chrome.storage.local.set({ [OPENED_KEY]: memory }));
    await closeLeftovers(before);
    return run;
  })();
  return begun;
}

/** Closes what an earlier run left open: its windows, and those an earlier build left (`leftovers`). */
async function closeLeftovers(before: Opened | null): Promise<void> {
  // When Chrome can't say, nothing's closed.
  const all = (await attempt(() => chrome.windows.getAll({ populate: true }))) ?? [];
  for (const id of leftovers(all, before)) await attempt(() => chrome.windows.remove(id));
}

/** Notes a window this run opened, with its first tab; the work window when it's that. */
export const noteWindow = (windowId: number, tabId: number | undefined, work: boolean) =>
  change((now) => ({
    ...now,
    work: work ? windowId : now.work,
    windows: { ...now.windows, [String(windowId)]: tabId === undefined ? [] : [tabId] },
  }));

/** Notes a tab this run opened in one of its windows. */
export const noteTab = (windowId: number, tabId: number) =>
  change((now) => ({
    ...now,
    windows: {
      ...now.windows,
      [String(windowId)]: [...(now.windows[String(windowId)] ?? []), tabId],
    },
  }));

/**
 * Forgets tabs it closed, and a window with none of its tabs left: closed with them, or holding only the person's own,
 * which the next work never goes in.
 */
export const forgetTabs = (ids: readonly number[]) =>
  change((now) => {
    const windows: Record<string, readonly number[]> = {};
    for (const [w, tabs] of Object.entries(now.windows)) {
      const left = tabs.filter((t) => !ids.includes(t));
      if (left.length) windows[w] = left;
    }
    const work = now.work !== null && windows[String(now.work)] ? now.work : null;
    return { ...now, work, windows };
  });

/** Forgets a window that closed, by Chrome or the person. */
export const forgetWindow = (windowId: number) =>
  change((now) => {
    if (!(String(windowId) in now.windows) && now.work !== windowId) return now;
    const windows = { ...now.windows };
    delete windows[String(windowId)];
    return { ...now, work: now.work === windowId ? null : now.work, windows };
  });

/** Whether this run opened a tab: only such a tab is taken over after the background restarted. */
export async function isOurs(tabId: number): Promise<boolean> {
  const now = await openedNow();
  return Object.values(now.windows).some((tabs) => tabs.includes(tabId));
}

/** The work window, while it's still open. */
async function workWindow(): Promise<number | null> {
  const { work } = await openedNow();
  if (work === null) return null;
  const open = await attempt(() => chrome.windows.get(work));
  return open?.id === work ? work : null;
}

/** Opening and closing go one at a time: a tab just opened in the work window is never closed with it. */
let queue: Promise<unknown> = Promise.resolve();
function inQueue<T>(work: () => Promise<T>): Promise<T> {
  const go = queue.then(work);
  queue = go.catch(() => undefined);
  return go;
}

export interface WorkTabHow {
  /** Its window comes in front with it: a read that needs the screen. */
  readonly front: boolean;
  /** Its tab is the one shown in the window: nothing else is in front for a read. */
  readonly active: boolean;
}

/**
 * Opens an address in a new tab of the work window, opening the window when it isn't open: beside the person's, not
 * in front of it unless `front`, at their window's right, so where it shows over theirs it leaves its left in view.
 * The tab's number, or null when Chrome didn't open it.
 */
export function openWorkTab(url: string, how: WorkTabHow): Promise<number | null> {
  return inQueue(async () => {
    await ready();
    const work = await workWindow();
    if (work !== null) {
      const tab = await attempt(() =>
        chrome.tabs.create({ windowId: work, url, active: how.active || how.front }),
      );
      if (tab?.id !== undefined) {
        await noteTab(work, tab.id);
        await keep(tab.id);
        if (how.front) await attempt(() => chrome.windows.update(work, { focused: true }));
        return tab.id;
      }
    }
    const theirs = await attempt(() => chrome.windows.getLastFocused());
    const beside =
      theirs?.left !== undefined && theirs.top !== undefined && theirs.width !== undefined
        ? { left: Math.max(theirs.left, theirs.left + theirs.width - WIDTH), top: theirs.top }
        : {};
    const made = await chrome.windows.create({
      url,
      focused: how.front,
      width: WIDTH,
      height: HEIGHT,
      ...beside,
    });
    const tabId = made?.tabs?.[0]?.id;
    if (tabId === undefined) return null;
    if (made?.id !== undefined) await noteWindow(made.id, tabId, true);
    await keep(tabId);
    return tabId;
  });
}

/** Chrome never unloads a work tab to save memory while it works. */
const keep = (tabId: number) =>
  attempt(() => chrome.tabs.update(tabId, { autoDiscardable: false }));

/**
 * Closes a work tab, with any tab or pop-up a page opened from it, and theirs; and the work window, when all that's
 * left in it is pages its own pages opened. The person's own tab in it keeps the window open, and the next work goes
 * in a window of its own.
 */
export function closeWorkTab(tabId: number): Promise<void> {
  return inQueue(async () => {
    const tab = await attempt(() => chrome.tabs.get(tabId));
    if (!tab) return forgetTabs([tabId]);
    const every = (await attempt(() => chrome.tabs.query({}))) ?? [];
    const closing = new Set([tabId]);
    for (let grew = true; grew;) {
      grew = false;
      for (const other of every)
        if (
          other.id !== undefined &&
          !closing.has(other.id) &&
          other.openerTabId !== undefined &&
          closing.has(other.openerTabId)
        ) {
          closing.add(other.id);
          grew = true;
        }
    }
    const ours = (await openedNow()).windows[String(tab.windowId)];
    const rest = every.filter(
      (other) =>
        other.windowId === tab.windowId && other.id !== undefined && !closing.has(other.id),
    );
    // Only network pages it didn't open are left: pages its own opened, whose opener is gone.
    const done =
      ours !== undefined &&
      rest.length > 0 &&
      rest.every((other) => !ours.includes(other.id!) && isWorkPage(other.url ?? other.pendingUrl));
    const ids = [...closing];
    await attempt(() => chrome.tabs.remove(ids));
    if (done) await attempt(() => chrome.windows.remove(tab.windowId));
    await forgetTabs(done ? [...ids, ...rest.map((other) => other.id!)] : ids);
  });
}

/** For tests: forgets this background's run and what it kept. */
export function forgetRun(): void {
  begun = null;
  memory = null;
  writing = Promise.resolve();
  queue = Promise.resolve();
}
