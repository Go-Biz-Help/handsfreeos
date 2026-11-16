/**
 * The windows the extension opens (src/opened.ts, docs/outreach.md decision 171): every network's work shares one
 * window beside the person's, a tab each, closed the moment its work is done, with any tab its page opened; the window
 * closes with its last tab. A new run (Chrome started, a new build loaded) first closes what an earlier one left open,
 * and only a tab this run opened is ever taken over.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { linkedin } from '../src/networks';
import { forgetRun, leftovers, OPENED_KEY, ready, type Opened } from '../src/opened';
import { WorkTab } from '../src/tab';

const FB = 'https://www.facebook.com/friends/requests';
const LI = 'https://www.linkedin.com/feed/';

interface FakeTab {
  id: number;
  windowId: number;
  url?: string;
  openerTabId?: number;
  active: boolean;
  status: 'complete';
}
interface FakeWindow {
  id: number;
  focused: boolean;
  width: number;
  height: number;
  type: 'normal';
  incognito: boolean;
}

/**
 * Chrome with the person's window (1) in front, holding a tab whose page the extension can't see. `run` is the run
 * Chrome's session storage already has a mark for, if any; `kept` what Chrome's storage kept from it.
 */
function fakeChrome({ run, kept }: { run?: string; kept?: Opened } = {}) {
  let next = 100;
  const windows = new Map<number, FakeWindow>([
    [1, { id: 1, focused: true, width: 1512, height: 945, type: 'normal', incognito: false }],
  ]);
  const tabs = new Map<number, FakeTab>([
    [2, { id: 2, windowId: 1, active: true, status: 'complete' }],
  ]);
  const made: Record<string, unknown>[] = [];
  const created: Record<string, unknown>[] = [];
  const removed: number[] = [];
  const local = new Map<string, unknown>(kept ? [[OPENED_KEY, kept]] : []);
  const session = new Map<string, unknown>(run ? [['hfos.run', run]] : []);
  const area = (store: Map<string, unknown>) => ({
    get: async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}),
    set: async (values: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(values))
        store.set(key, JSON.parse(JSON.stringify(value)));
    },
  });
  const dropTab = (id: number) => {
    const tab = tabs.get(id);
    tabs.delete(id);
    // Chrome closes a window with its last tab.
    if (tab && ![...tabs.values()].some((other) => other.windowId === tab.windowId))
      windows.delete(tab.windowId);
  };
  const tab = (windowId: number, url: string | undefined, more: Partial<FakeTab> = {}) => {
    const made: FakeTab = { id: next++, windowId, url, active: false, status: 'complete', ...more };
    tabs.set(made.id, made);
    return made;
  };
  const window = (more: Partial<FakeWindow> = {}) => {
    const made: FakeWindow = {
      id: next++,
      focused: false,
      width: 1100,
      height: 900,
      type: 'normal',
      incognito: false,
      ...more,
    };
    windows.set(made.id, made);
    return made;
  };
  vi.stubGlobal('chrome', {
    storage: { local: area(local), session: area(session) },
    windows: {
      create: async (asked: { url: string; focused: boolean; width: number; height: number }) => {
        made.push(asked);
        const w = window({ focused: asked.focused, width: asked.width, height: asked.height });
        return { ...w, tabs: [tab(w.id, asked.url, { active: true })] };
      },
      get: async (id: number) => {
        const found = windows.get(id);
        if (!found) throw new Error(`No window with id: ${id}.`);
        return found;
      },
      getAll: async () =>
        [...windows.values()].map((w) => ({
          ...w,
          tabs: [...tabs.values()].filter((t) => t.windowId === w.id),
        })),
      getLastFocused: async () => ({ ...windows.get(1), left: 0, top: 25 }),
      update: async (id: number) => windows.get(id),
      remove: async (id: number) => {
        removed.push(id);
        windows.delete(id);
        for (const t of [...tabs.values()]) if (t.windowId === id) tabs.delete(t.id);
      },
    },
    tabs: {
      create: async (asked: { windowId: number; url: string; active: boolean }) => {
        created.push(asked);
        if (!windows.has(asked.windowId)) throw new Error(`No window with id: ${asked.windowId}.`);
        return tab(asked.windowId, asked.url, { active: asked.active });
      },
      get: async (id: number) => {
        const found = tabs.get(id);
        if (!found) throw new Error(`No tab with id: ${id}.`);
        return found;
      },
      update: async (id: number, info: { url?: string; active?: boolean }) => {
        const found = tabs.get(id);
        if (!found) throw new Error(`No tab with id: ${id}.`);
        if (info.url) found.url = info.url;
        if (info.active) found.active = true;
        return found;
      },
      query: async (asked: { windowId?: number }) =>
        [...tabs.values()].filter(
          (t) => asked.windowId === undefined || t.windowId === asked.windowId,
        ),
      remove: async (ids: number | number[]) => {
        for (const id of [ids].flat()) dropTab(id);
      },
    },
    scripting: { executeScript: async () => [{ result: 'visible' }] },
  });
  return { windows, tabs, made, created, removed, local, tab, window };
}

/** Lets a tab load and the page draw (src/tab.ts waits for both). */
async function settle<T>(going: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return going;
}

beforeAll(() => void vi.useFakeTimers());
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
beforeEach(() => forgetRun());

describe('one work window, a tab for each network', () => {
  it('opens Facebook’s and LinkedIn’s work in one window beside the person’s', async () => {
    const chrome = fakeChrome({ run: 'r' });
    const facebook = new WorkTab('window');
    const linked = new WorkTab('window', linkedin);
    const fbTab = await settle(facebook.open(FB));
    const liTab = await settle(linked.open(LI));
    expect(chrome.made).toEqual([
      expect.objectContaining({ url: FB, focused: false, width: 1100, height: 900, left: 412 }),
    ]);
    expect(chrome.tabs.get(liTab)?.windowId).toBe(chrome.tabs.get(fbTab)?.windowId);
    // Two of the extension's windows at most: this one, and the messages one.
    expect(chrome.windows.size).toBe(2);
  });

  it('never opens two windows when two networks start at once', async () => {
    const chrome = fakeChrome({ run: 'r' });
    await settle(
      Promise.all([new WorkTab('window').open(FB), new WorkTab('window', linkedin).open(LI)]),
    );
    expect(chrome.made).toHaveLength(1);
    expect(chrome.created).toHaveLength(1);
  });

  it('opens a tab out of view while another network’s page is read in front', async () => {
    const chrome = fakeChrome({ run: 'r' });
    const facebook = new WorkTab('window');
    const linked = new WorkTab('window', linkedin);
    await settle(
      facebook.inFront(async () => {
        await facebook.open(FB);
        await linked.open(LI);
      }),
    );
    expect(chrome.created).toEqual([expect.objectContaining({ url: LI, active: false })]);
    // Outside a read, the working tab is the one shown.
    const later = new WorkTab('window', linkedin);
    await settle(later.open(LI));
    expect(chrome.created[1]).toMatchObject({ active: true });
  });
});

describe('closed the moment the work is done', () => {
  it('closes its tab, with the tabs its page opened, and the window with its last tab', async () => {
    const chrome = fakeChrome({ run: 'r' });
    const facebook = new WorkTab('window');
    const linked = new WorkTab('window', linkedin);
    const fbTab = await settle(facebook.open(FB));
    await settle(linked.open(LI));
    const windowId = chrome.tabs.get(fbTab)!.windowId;
    // A link the page opened in a new tab, and one that page opened in turn.
    const stray = chrome.tab(windowId, 'https://www.facebook.com/help', { openerTabId: fbTab });
    chrome.tab(windowId, 'https://example.com/', { openerTabId: stray.id });
    await facebook.close();
    expect([...chrome.tabs.values()].filter((t) => t.windowId === windowId)).toHaveLength(1);
    await linked.close();
    expect(chrome.windows.has(windowId)).toBe(false);
    expect([...chrome.windows.keys()]).toEqual([1]);
  });

  it('closes the window when only pages its own opened are left in it', async () => {
    const chrome = fakeChrome({ run: 'r' });
    const facebook = new WorkTab('window');
    const fbTab = await settle(facebook.open(FB));
    const windowId = chrome.tabs.get(fbTab)!.windowId;
    // Opened from a page whose tab closed since: Chrome no longer says which.
    chrome.tab(windowId, 'https://www.facebook.com/photo/?fbid=1');
    await facebook.close();
    expect(chrome.windows.has(windowId)).toBe(false);
  });

  it('leaves a tab of the person’s in it, and opens the next work in a window of its own', async () => {
    const chrome = fakeChrome({ run: 'r' });
    const facebook = new WorkTab('window');
    const fbTab = await settle(facebook.open(FB));
    const windowId = chrome.tabs.get(fbTab)!.windowId;
    // A page the extension can't see: the person's.
    chrome.tab(windowId, undefined);
    await facebook.close();
    expect(chrome.windows.has(windowId)).toBe(true);
    await settle(new WorkTab('window').open(FB));
    expect(chrome.made).toHaveLength(2);
  });
});

describe('only its own tabs, and nothing left open', () => {
  it('takes over a tab this run opened, never one of the person’s that has its number', async () => {
    const chrome = fakeChrome({ run: 'r' });
    const first = new WorkTab('window');
    const id = await settle(first.open(FB));
    const again = new WorkTab('window');
    await again.adopt(id);
    expect(again.tabId).toBe(id);
    const theirs = new WorkTab('window');
    await theirs.adopt(2);
    expect(theirs.tabId).toBeNull();
    expect(chrome.tabs.has(2)).toBe(true);
  });

  it('finds what an earlier run left: windows it kept, and the size it opens its own at', () => {
    const tab = (id: number, url?: string) => ({ id, url }) as chrome.tabs.Tab;
    const win = (id: number, more: Partial<chrome.windows.Window>, tabs: chrome.tabs.Tab[]) =>
      ({
        id,
        focused: false,
        incognito: false,
        type: 'normal',
        width: 1100,
        height: 900,
        tabs,
        ...more,
      }) as chrome.windows.Window;
    const before: Opened = { run: 'old', work: 20, windows: { '20': [21], '40': [99] } };
    expect(
      leftovers(
        [
          // The work window it kept, though the person made it wider.
          win(20, { width: 1600 }, [tab(21, FB)]),
          // The messages window an earlier build left, minimized at the size it opened at.
          win(30, {}, [tab(31, 'https://www.facebook.com/messages/'), tab(32, LI)]),
          // On a short screen, a little less tall.
          win(35, { height: 820 }, [tab(36, LI)]),
          // Kept, but the tab it opened there is gone: someone else's now.
          win(40, { width: 1440 }, [tab(41, FB)]),
          // The size it opens at, with a page that isn't a network's.
          win(50, {}, [tab(51, FB), tab(52)]),
          // The size it opens at, but the one the person is in.
          win(60, { focused: true }, [tab(61, FB)]),
          // The person's own, wider.
          win(70, { width: 1512 }, [tab(71, FB)]),
        ],
        before,
      ),
    ).toEqual([20, 30, 35]);
  });

  it('closes what an earlier run left once Chrome starts again or a new build loads, before anything opens', async () => {
    const chrome = fakeChrome({ kept: { run: 'old', work: null, windows: {} } });
    const old = chrome.window();
    chrome.tab(old.id, FB);
    const going = settle(new WorkTab('window').open(FB));
    await going;
    expect(chrome.removed).toEqual([old.id]);
    expect(chrome.windows.size).toBe(2);
    expect((chrome.local.get(OPENED_KEY) as Opened).run).not.toBe('old');
  });

  it('closes nothing while it’s the same run', async () => {
    const chrome = fakeChrome({ run: 'r', kept: { run: 'r', work: null, windows: {} } });
    const window = chrome.window();
    chrome.tab(window.id, FB);
    await ready();
    expect(chrome.removed).toEqual([]);
  });
});
