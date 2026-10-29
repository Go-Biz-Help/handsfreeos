/**
 * The extension's own tab goes only to Facebook's pages (src/tab.ts, src/networks/facebook/urls.ts): https, on
 * www.facebook.com, web.facebook.com or accountscenter.facebook.com. A bad link kept in HandsFreeOS or read off a page
 * is refused with plain words, and Chrome is never asked to open it. Its own window comes in front for a read that
 * needs the screen: a Check right away, the rest only while the person is away from their computer (decision 120).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AWAY_WAIT_LINE, NotAway } from '../src/away';
import { workUrl } from '../src/networks/facebook/urls';
import { WorkTab } from '../src/tab';

const opened: string[] = [];

beforeAll(() => {
  vi.useFakeTimers();
  vi.stubGlobal('chrome', {
    tabs: {
      create: async ({ url }: { url: string }) => (opened.push(url), { id: 3 }),
      update: async (_id: number, { url }: { url: string }) => (opened.push(url), { id: 3 }),
      get: async () => ({ id: 3, status: 'complete' }),
    },
    windows: {
      create: async ({ url }: { url: string }) => (opened.push(url), { tabs: [{ id: 4 }] }),
    },
  });
});
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
beforeEach(() => void (opened.length = 0));

describe('where the extension’s tab may go', () => {
  it('takes Facebook’s pages and its Accounts Center, over https only', () => {
    expect(workUrl('https://www.facebook.com/dana.reyes.4')).toBe(
      'https://www.facebook.com/dana.reyes.4',
    );
    expect(workUrl('https://web.facebook.com/groups/austinmakers/')).not.toBeNull();
    expect(workUrl('https://accountscenter.facebook.com/info_and_permissions/dyi/')).not.toBeNull();
    for (const bad of [
      'http://www.facebook.com/dana.reyes.4',
      'https://m.facebook.com/dana.reyes.4',
      'https://www.facebook.com.example.com/',
      'https://example.com/?u=https://www.facebook.com/',
      'https://user:pass@www.facebook.com/',
      'https://www.facebook.com:8443/',
      'javascript:alert(1)',
      'chrome://settings',
      '/dana.reyes.4',
      '',
    ])
      expect(workUrl(bad)).toBeNull();
  });

  it('opens a Facebook page, and refuses anything else without asking Chrome', async () => {
    const tab = new WorkTab('window');
    const going = tab.open('https://www.facebook.com/friends/requests');
    await vi.runAllTimersAsync();
    await expect(going).resolves.toBe(4);
    expect(opened).toEqual(['https://www.facebook.com/friends/requests']);
    await expect(tab.open('https://example.com/not-facebook')).rejects.toThrow(
      'That link isn’t a Facebook page, so the extension didn’t open it.',
    );
    await expect(new WorkTab('view').open('javascript:alert(1)')).rejects.toThrow(
      'isn’t a Facebook page',
    );
    expect(opened).toHaveLength(1);
  });
});

describe('a window of its own, in front while a page is read', () => {
  /** Chrome with the person's window (1) in front, and the extension's (9) behind it once it's open. */
  const stub = (focused: number[], made: { focused: boolean }[] = []) => {
    let front = 1;
    vi.stubGlobal('chrome', {
      tabs: {
        get: async (id: number) => ({ id, windowId: 9, status: 'complete' }),
        update: async (id: number) => ({ id, windowId: 9 }),
      },
      windows: {
        getLastFocused: async () => ({ id: front, focused: true }),
        update: async (id: number, { focused: on }: { focused: boolean }) =>
          void (on && (focused.push(id), (front = id))),
        create: async (asked: { focused: boolean }) => {
          made.push(asked);
          if (asked.focused) front = 9;
          return { tabs: [{ id: 4 }] };
        },
      },
      // The page Chrome draws only while its window (9) is in front.
      scripting: {
        executeScript: async () => [{ result: front === 9 ? 'visible' : 'hidden' }],
      },
    });
    return { goTo: (id: number) => void (front = id) };
  };

  it('comes to the front for the read, then puts the person’s window back', async () => {
    const focused: number[] = [];
    stub(focused);
    const tab = new WorkTab('window');
    await tab.adopt(4);
    expect(await tab.inFront(async () => (focused.push(-1), 'read'))).toBe('read');
    // Its own window (9), the read, then theirs (1) in front again.
    expect(focused).toEqual([9, -1, 1]);
  });

  it('opens its window in front when it isn’t open yet, then puts the person’s back', async () => {
    const focused: number[] = [];
    const made: { focused: boolean }[] = [];
    stub(focused, made);
    const tab = new WorkTab('window');
    const reading = tab.inFront(async () => {
      await tab.open('https://www.facebook.com/friends/requests');
      return 'read';
    });
    await vi.runAllTimersAsync();
    await expect(reading).resolves.toBe('read');
    expect(made).toEqual([expect.objectContaining({ focused: true })]);
    expect(focused).toEqual([1]);
    // Outside, a window it opens stays behind the person's.
    const later = new WorkTab('window');
    const opening = later.open('https://www.facebook.com/friends/requests');
    await vi.runAllTimersAsync();
    await opening;
    expect(made[1]).toMatchObject({ focused: false });
  });

  it('leaves the person in a window they went on to while it read', async () => {
    const focused: number[] = [];
    const chrome = stub(focused);
    const tab = new WorkTab('window');
    await tab.adopt(4);
    await tab.inFront(async () => chrome.goTo(2));
    // Its own window (9) only: window 1 never jumps over window 2.
    expect(focused).toEqual([9]);
  });

  it('comes back in front for its next page when the person put another window over it', async () => {
    const focused: number[] = [];
    const chrome = stub(focused);
    const tab = new WorkTab('window');
    await tab.adopt(4);
    const reading = tab.inFront(async () => {
      chrome.goTo(2);
      await tab.open('https://www.facebook.com/friends/requests');
      // In front already: not asked again.
      await tab.keepInFront();
      return 'read';
    });
    await vi.runAllTimersAsync();
    await expect(reading).resolves.toBe('read');
    // Its own (9), again once window 2 went over it, then window 2 back: the one they went on to.
    expect(focused).toEqual([9, 9, 2]);
    // Outside a read, it never comes forward.
    chrome.goTo(2);
    await tab.keepInFront();
    expect(focused).toEqual([9, 9, 2]);
  });

  it('leaves a tab in the person’s own window as it is', async () => {
    const focused: number[] = [];
    stub(focused);
    const tab = new WorkTab('view');
    await tab.adopt(4);
    expect(await tab.inFront(async () => 'read')).toBe('read');
    expect(focused).toEqual([]);
  });
});

describe('outside a Check, in front only while the person is away (decision 120)', () => {
  const ON = 'https://www.facebook.com/friends/requests';
  /**
   * Chrome as above, with its idle state: `idle.state` is what it says now, and `idle.back()` is the person touching a
   * key or the mouse. `theirs` is the window they were last in, and whether Chrome was the app in front.
   */
  const stub = (
    focused: number[],
    idle: { state: string; heard?: (state: string) => void },
    theirs: { focused?: boolean; left?: number; top?: number; width?: number } = {},
    made: Record<string, unknown>[] = [],
  ) => {
    let front = 1;
    vi.stubGlobal('chrome', {
      tabs: {
        get: async (id: number) => ({ id, windowId: 9, status: 'complete' }),
        update: async (id: number) => ({ id, windowId: 9 }),
      },
      windows: {
        getLastFocused: async () => ({ id: front, focused: true, ...theirs }),
        // Unfocused, its own steps back behind the next: the person's.
        update: async (id: number, { focused: on }: { focused: boolean }) => {
          focused.push(on ? id : -id);
          front = on ? id : 1;
          if (on) theirs.focused = true;
        },
        create: async (asked: Record<string, unknown>) => {
          made.push(asked);
          return { tabs: [{ id: 4 }] };
        },
      },
      scripting: {
        executeScript: async () => [{ result: front === 9 ? 'visible' : 'hidden' }],
      },
      idle: {
        queryState: async () => idle.state,
        setDetectionInterval: () => undefined,
        onStateChanged: {
          addListener: (heard: (state: string) => void) => void (idle.heard = heard),
          removeListener: () => void (idle.heard = undefined),
        },
      },
    });
  };
  const runner = () => new WorkTab('window', undefined, { front: 'away', waits: false });

  it('puts off the runner’s read while they’re at their computer, never coming in front', async () => {
    const focused: number[] = [];
    stub(focused, { state: 'active' });
    const tab = runner();
    await tab.adopt(4);
    const work = vi.fn(async () => 'read');
    await expect(tab.inFront(work)).rejects.toBeInstanceOf(NotAway);
    expect(work).not.toHaveBeenCalled();
    expect(focused).toEqual([]);
  });

  it('comes in front once they’ve been away two minutes, then puts their window back', async () => {
    const focused: number[] = [];
    stub(focused, { state: 'idle' });
    const tab = runner();
    await tab.adopt(4);
    expect(await tab.inFront(async () => (focused.push(0), 'read'))).toBe('read');
    expect(focused).toEqual([9, 0, 1]);
  });

  it('gives their window back the moment they’re back, and puts the rest of the runner’s read off', async () => {
    const focused: number[] = [];
    const idle: { state: string; heard?: (state: string) => void } = { state: 'idle' };
    stub(focused, idle);
    const tab = runner();
    await tab.adopt(4);
    const reading = tab.inFront(async () => {
      // A key pressed: their window (1) is in front again at once.
      idle.state = 'active';
      idle.heard?.('active');
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(focused).toEqual([9, 1]);
      // Its next page waits for no one: put off for later.
      await tab.open(ON);
      return 'read';
    });
    const settled = expect(reading).rejects.toBeInstanceOf(NotAway);
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;
    expect(focused).toEqual([9, 1]);
    expect(idle.heard).toBeUndefined();
  });

  it('has an ask wait, saying so, till they’re away, then read in front', async () => {
    const focused: number[] = [];
    const idle = { state: 'active' };
    stub(focused, idle);
    const tab = new WorkTab('window', undefined, { front: 'away' });
    await tab.adopt(4);
    const said: string[] = [];
    const reading = tab.inFront(async () => 'read', {
      say: (line) => said.push(line),
      stopped: () => false,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(said).toEqual([AWAY_WAIT_LINE]);
    expect(focused).toEqual([]);
    idle.state = 'idle';
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(reading).resolves.toBe('read');
    expect(focused).toEqual([9, 1]);
  });

  it('ends an ask stopped while it waits', async () => {
    const focused: number[] = [];
    stub(focused, { state: 'active' });
    const tab = new WorkTab('window', undefined, { front: 'away' });
    await tab.adopt(4);
    let stop = false;
    const reading = tab.inFront(async () => 'read', { say: () => undefined, stopped: () => stop });
    const settled = expect(reading).rejects.toBeInstanceOf(NotAway);
    stop = true;
    await vi.advanceTimersByTimeAsync(6_000);
    await settled;
    expect(focused).toEqual([]);
  });

  it('steps back behind what they were in when that wasn’t Chrome', async () => {
    const focused: number[] = [];
    stub(focused, { state: 'idle' }, { focused: false });
    const tab = runner();
    await tab.adopt(4);
    await tab.inFront(async () => 'read');
    // In front (9), then unfocused (-9), so none of Chrome's windows goes over their other app.
    expect(focused).toEqual([9, -9]);
  });

  it('waits for another network’s window to finish its read in front', async () => {
    const focused: number[] = [];
    stub(focused, { state: 'idle' });
    const first = runner();
    await first.adopt(4);
    let done = () => undefined as void;
    const reading = first.inFront(() => new Promise<void>((go) => (done = go)));
    await vi.advanceTimersByTimeAsync(0);
    await expect(runner().inFront(async () => 'read')).rejects.toBeInstanceOf(NotAway);
    done();
    await reading;
  });

  it('opens its window at the right of theirs, not over the middle', async () => {
    const focused: number[] = [];
    const made: Record<string, unknown>[] = [];
    stub(focused, { state: 'active' }, { left: 0, top: 25, width: 1600 }, made);
    const opening = runner().open(ON);
    await vi.runAllTimersAsync();
    await opening;
    expect(made).toEqual([
      expect.objectContaining({ focused: false, left: 500, top: 25, width: 1100 }),
    ]);
  });
});
