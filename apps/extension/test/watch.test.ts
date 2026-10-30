/**
 * Replies first, and each network's messages kept open (docs/outreach.md, decision 125; the owner, 29 Oct 2026: "keep
 * a page of each platform open at all times and check for messages sent to us each minute locally so that we can
 * reply quickly"). A reply is drafted before anything else on the list, again for someone who wrote back since; a
 * window of the extension's own, minimized, keeps a messages page open for each network that's on and works on its
 * own, read every minute where it stands; what it sees goes to HandsFreeOS as any tab's does, and a reply it keeps as
 * new reaches that network's runner. A tab the person closes stays closed for an hour. Made-up people throughout.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import type { TodayListItem } from '../src/hfos/messages';
import type { ReplySighting } from '../src/networks/facebook/replies';
import type * as Replies from '../src/hfos/replies';

type RepliesModule = typeof Replies;

const ME = { userId: 'u-casey', businessId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' };
const MAYA = '1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9';
const OWEN = '2c3d4e5f-6071-4829-93a4-b5c6d7e8f90a';

const world = vi.hoisted(() => ({
  noting: true,
  kept: null as { working: boolean } | null,
  warned: [] as string[],
  noted: [] as { seen: unknown; platform: unknown }[],
  kept_replies: [] as { profileId: string; name: string }[],
  posted: [] as { path: string; body: Record<string, unknown> }[],
}));

vi.mock('../src/hfos/session', async (original) => ({
  ...(await original<object>()),
  savingTo: async () => ME,
  api: () => ({
    POST: async (path: string, options: { body: Record<string, unknown> }) => {
      world.posted.push({ path, body: options.body });
      return { data: { replies: world.kept_replies }, response: { ok: true, status: 200 } };
    },
  }),
}));
vi.mock('../src/hfos/live', async (original) => ({
  ...(await original<object>()),
  keptFor: async () => world.kept,
}));
vi.mock('../src/hfos/noting', async (original) => ({
  ...(await original<object>()),
  isNoting: async () => world.noting,
}));
vi.mock('../src/hfos/warned', async (original) => ({
  ...(await original<object>()),
  warnedNow: async (platform: string) =>
    world.warned.includes(platform) ? { day: 'today', words: ['Slow down'] } : null,
}));
vi.mock('../src/hfos/replies', async (original) => ({
  ...(await original<object>()),
  noteReplies: async (note: { seen: unknown }, platform: unknown) =>
    void world.noted.push({ seen: note.seen, platform }),
}));

const {
  AGAIN_MS,
  CLOSED_FOR_MS,
  FRESH_MS,
  loadAgain,
  onAlignableMoved,
  rowsMoved,
  rowsOf,
  tabClosed,
  tabStep,
  WATCH_ALARM,
  WATCH_PAGES,
  watchedOn,
  watchTick,
  windowClosed,
} = await import('../src/auto/watch');
const {
  answersAnyTime,
  listTurn,
  lookOutsideAt,
  REPLY_LOOK_MS,
  repliedAfter,
  replyWaiting,
  stillReplied,
  withReplied,
  workKey,
  workLeft,
} = await import('../src/auto/plan');
const { NETWORKS_KEY } = await import('../src/networks/on');

// ------------------------------------------------------------------------------------------------- Chrome

interface FakeTab {
  id: number;
  windowId: number;
  url: string;
  status: string;
  discarded?: boolean;
  autoDiscardable?: boolean;
}
interface FakeWindow {
  id: number;
  state: string;
  focused: boolean;
  width?: number;
  height?: number;
}

const local = new Map<string, unknown>();
const session = new Map<string, unknown>();
const alarms = new Map<string, unknown>();
const windows = new Map<number, FakeWindow>();
const tabs = new Map<number, FakeTab>();
const sent: { url: string; type: string }[] = [];
let nextId = 100;
/** What a tab's script answers. */
let answers: (tab: FakeTab, message: { type: string }) => unknown = () => undefined;

const storeOf = (store: Map<string, unknown>) => ({
  get: async (keys: string | string[]) =>
    Object.fromEntries(
      [keys]
        .flat()
        .filter((k) => store.has(k))
        .map((k) => [k, store.get(k)]),
    ),
  set: async (values: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(values)) store.set(k, JSON.parse(JSON.stringify(v)));
  },
  remove: async (keys: string | string[]) => {
    for (const k of [keys].flat()) store.delete(k);
  },
});

beforeAll(() => {
  vi.stubGlobal('chrome', {
    storage: { local: storeOf(local), session: storeOf(session), onChanged: { addListener() {} } },
    alarms: {
      get: async (name: string) => (alarms.has(name) ? { name } : undefined),
      create: async (name: string, info: unknown) => void alarms.set(name, info),
    },
    windows: {
      get: async (id: number) => {
        const found = windows.get(id);
        if (!found) throw new Error('No window');
        return found;
      },
      getLastFocused: async () => ({ id: 1, left: 0, top: 0, width: 1600, focused: true }),
      create: async (info: { url: string; focused: boolean; width: number; height: number }) => {
        const made: FakeWindow = {
          id: nextId++,
          state: 'normal',
          focused: info.focused,
          width: info.width,
          height: info.height,
        };
        windows.set(made.id, made);
        const tab: FakeTab = { id: nextId++, windowId: made.id, url: info.url, status: 'complete' };
        tabs.set(tab.id, tab);
        return { ...made, tabs: [tab] };
      },
      update: async (id: number, change: Partial<FakeWindow>) =>
        Object.assign(windows.get(id)!, change),
      remove: async (id: number) => {
        windows.delete(id);
        for (const tab of [...tabs.values()]) if (tab.windowId === id) tabs.delete(tab.id);
      },
    },
    tabs: {
      get: async (id: number) => {
        const found = tabs.get(id);
        if (!found) throw new Error('No tab');
        return found;
      },
      create: async (info: { windowId: number; url: string }) => {
        const tab: FakeTab = {
          id: nextId++,
          windowId: info.windowId,
          url: info.url,
          status: 'complete',
        };
        tabs.set(tab.id, tab);
        return tab;
      },
      update: async (id: number, change: Partial<FakeTab>) => {
        const tab = tabs.get(id);
        if (!tab) throw new Error('No tab');
        return Object.assign(tab, change);
      },
      remove: async (id: number) => void tabs.delete(id),
      sendMessage: async (id: number, message: { type: string }) => {
        const tab = tabs.get(id)!;
        sent.push({ url: tab.url, type: message.type });
        return answers(tab, message);
      },
    },
  });
});
afterAll(() => vi.unstubAllGlobals());

const ON = { on: true, allowed: true };
const settings = (instagram = 'off') => ({
  settings: {
    sending: 'steps',
    networks: {
      facebook: { on: true },
      linkedin: { sending: 'steps' },
      instagram: { sending: instagram },
      alignable: { sending: 'steps' },
    },
  },
});

const maya: ReplySighting = {
  name: 'Maya Ortiz',
  threadKey: '100200300',
  profile: null,
  when: '1m',
};

/** Alignable's conversations, as its page read gives them. */
let rows: { name: string; preview: string | null; when: string | null }[] = [];

beforeEach(() => {
  for (const store of [local, session, alarms, windows, tabs]) store.clear();
  sent.length = 0;
  world.noted.length = 0;
  world.posted.length = 0;
  world.noting = true;
  world.kept = null;
  world.warned = [];
  rows = [{ name: 'Owen Price', preview: 'Sounds good', when: 'Oct 20' }];
  local.set(NETWORKS_KEY, { facebook: ON, linkedin: ON, instagram: ON, alignable: ON });
  local.set('hfos.settings', settings());
  answers = (tab, message) => {
    if (message.type === 'hfos-read')
      return { ok: true, result: { platform: 'alignable', found: { chats: rows } } };
    if (new URL(tab.url).hostname === 'www.facebook.com') return { ok: true, seen: [maya] };
    return { ok: true, seen: [] };
  };
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse('2026-10-29T16:00:00Z'));
});

const urls = () => [...tabs.values()].map((t) => t.url).sort();
const minute = () => vi.setSystemTime(Date.now() + 60_000);

describe('the messages kept open', () => {
  it('opens a minimized window of its own with each network’s messages that works on its own, every minute', async () => {
    await watchTick();
    const [made] = [...windows.values()];
    expect(made).toMatchObject({ state: 'minimized', focused: false, width: 1100, height: 900 });
    // Instagram works on nothing on its own (Off), so it has no tab.
    expect(urls()).toEqual(
      [WATCH_PAGES.facebook.url, WATCH_PAGES.linkedin.url, WATCH_PAGES.alignable.url].sort(),
    );
    expect([...tabs.values()].every((t) => t.windowId === made!.id)).toBe(true);
    expect(alarms.get(WATCH_ALARM)).toEqual({ periodInMinutes: 1 });
  });

  it('reads each page where it stands, and sends who wrote last as that network’s', async () => {
    await watchTick();
    minute();
    sent.length = 0;
    world.noted.length = 0;
    await watchTick();
    expect(sent.map((s) => s.type).sort()).toEqual([
      'hfos-read',
      'hfos-replies-now',
      'hfos-replies-now',
    ]);
    // Only Facebook's showed someone, so only Facebook's went.
    expect(world.noted).toEqual([{ seen: [maya], platform: 'facebook' }]);
  });

  it('has Alignable’s runner read its chats again only when a conversation’s last line changed', async () => {
    const moved = vi.fn();
    onAlignableMoved(moved);
    await watchTick();
    minute();
    await watchTick();
    expect(moved).not.toHaveBeenCalled();
    rows = [
      { name: 'Owen Price', preview: 'Can you come Friday?', when: 'Oct 29' },
      ...rows.map((r) => ({ ...r, name: 'Pat Lee' })),
    ];
    minute();
    await watchTick();
    expect(moved).toHaveBeenCalledTimes(1);
    minute();
    await watchTick();
    expect(moved).toHaveBeenCalledTimes(1);
  });

  it('loads a page afresh when it went elsewhere, after a while, and every so often', async () => {
    await watchTick();
    const facebook = [...tabs.values()].find((t) => t.url === WATCH_PAGES.facebook.url)!;
    // Facebook asked them to sign in: left be for a while, never loaded every minute.
    facebook.url = 'https://www.facebook.com/login/';
    minute();
    await watchTick();
    expect(facebook.url).toBe('https://www.facebook.com/login/');
    vi.setSystemTime(Date.now() + AGAIN_MS);
    await watchTick();
    expect(facebook.url).toBe(WATCH_PAGES.facebook.url);
    expect(facebook.autoDiscardable).toBe(false);
  });

  it('closes a network’s tab when it’s turned off, and the window when nothing’s watched', async () => {
    await watchTick();
    local.set('hfos.settings', {
      settings: { ...settings().settings, networks: { linkedin: { sending: 'off' } } },
    });
    minute();
    await watchTick();
    expect(urls()).not.toContain(WATCH_PAGES.linkedin.url);
    expect(urls()).toContain(WATCH_PAGES.facebook.url);
    // Noting off: nothing is read, and the window goes.
    world.noting = false;
    minute();
    await watchTick();
    expect(windows.size).toBe(0);
    expect(tabs.size).toBe(0);
  });

  it('stands by while another computer of theirs works', async () => {
    world.kept = { working: false };
    await watchTick();
    expect(windows.size).toBe(0);
  });

  it('keeps a tab the person closed shut for an hour, and every tab when they close the window', async () => {
    await watchTick();
    const linkedin = [...tabs.values()].find((t) => t.url === WATCH_PAGES.linkedin.url)!;
    tabs.delete(linkedin.id);
    await tabClosed(linkedin.id, false);
    minute();
    await watchTick();
    expect(urls()).not.toContain(WATCH_PAGES.linkedin.url);
    vi.setSystemTime(Date.now() + CLOSED_FOR_MS);
    await watchTick();
    expect(urls()).toContain(WATCH_PAGES.linkedin.url);

    const [made] = [...windows.values()];
    windows.delete(made!.id);
    for (const tab of [...tabs.values()]) tabs.delete(tab.id);
    await windowClosed(made!.id);
    minute();
    await watchTick();
    expect(windows.size).toBe(0);
    vi.setSystemTime(Date.now() + CLOSED_FOR_MS);
    await watchTick();
    expect(windows.size).toBe(1);
  });
});

describe('what’s watched, and when a page is loaded', () => {
  const base = {
    settings: settings('steps').settings as never,
    states: { facebook: ON, linkedin: ON, instagram: ON, alignable: ON },
    working: true,
    noting: true,
    warned: [] as Platform[],
    closed: {},
    now: 1_000_000_000,
  };

  it('watches each network that’s on and works on its own, unless warned today or closed this hour', () => {
    expect(watchedOn(base)).toEqual(['facebook', 'linkedin', 'instagram', 'alignable']);
    expect(watchedOn({ ...base, warned: ['instagram'] })).toEqual([
      'facebook',
      'linkedin',
      'alignable',
    ]);
    expect(
      watchedOn({ ...base, states: { ...base.states, linkedin: { on: true, allowed: false } } }),
    ).toEqual(['facebook', 'instagram', 'alignable']);
    expect(watchedOn({ ...base, closed: { facebook: base.now - 60_000 } })).toEqual([
      'linkedin',
      'instagram',
      'alignable',
    ]);
    expect(watchedOn({ ...base, closed: { facebook: base.now - CLOSED_FOR_MS } })).toHaveLength(4);
    for (const off of [{ working: false }, { noting: false }, { settings: null }])
      expect(watchedOn({ ...base, ...off })).toEqual([]);
  });

  it('opens, waits for, loads afresh or reads a tab', () => {
    const now = 1_000_000_000;
    const step = (tab: Parameters<typeof tabStep>[0]['tab'], kind: string | null, loadedAt = now) =>
      tabStep({ tab, kind, platform: 'facebook', loadedAt, now });
    expect(step(null, null)).toBe('open');
    expect(step({ status: 'loading' }, 'chats')).toBe('wait');
    expect(step({ status: 'complete', discarded: true }, 'chats')).toBe('load');
    expect(step({ status: 'complete' }, 'chats')).toBe('read');
    expect(step({ status: 'complete' }, 'chat')).toBe('read');
    expect(step({ status: 'complete' }, 'chats', now - FRESH_MS.facebook)).toBe('load');
    expect(step({ status: 'complete' }, 'other')).toBe('wait');
    expect(step({ status: 'complete' }, 'other', now - AGAIN_MS)).toBe('load');
    expect(loadAgain(now - 60_000, now)).toBe(false);
    expect(loadAgain(now - AGAIN_MS, now)).toBe(true);
  });

  it('notes Alignable’s conversations by their last lines, and a change only after the first read', () => {
    const first = rowsOf([
      { name: 'Owen Price', preview: 'Sounds good' },
      { name: 'Pat Lee', preview: null },
    ]);
    expect(first).toEqual({ 'owen price': 'Sounds good' });
    expect(rowsMoved(null, first)).toBe(false);
    expect(rowsMoved(first, first)).toBe(false);
    expect(rowsMoved(first, { 'owen price': 'Friday works' })).toBe(true);
    expect(rowsMoved(first, { ...first, 'jo hill': 'Hi there' })).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------- replies first

const item = (more: Partial<TodayListItem>): TodayListItem =>
  ({
    recent: [],
    kind: 'friend_request',
    name: 'Dana Reyes',
    profileId: '7b6f5c4d-3e2a-4b1c-8d9e-0f1a2b3c4d5e',
    profileUrl: 'https://www.facebook.com/dana.reyes.12',
    chatId: null,
    threadKey: null,
    postId: null,
    postUrl: null,
    posted: null,
    post: null,
    asking: false,
    why: [],
    summary: null,
    nextStep: null,
    playbookName: null,
    demoLink: null,
    videoLink: null,
    personId: null,
    demoBooked: false,
    send: null,
    ...more,
  }) as TodayListItem;

describe('replies first', () => {
  const request = item({});
  const reply = item({
    kind: 'reply',
    name: 'Maya Ortiz',
    profileId: MAYA,
    threadKey: '100200300',
  });
  const opener = item({ kind: 'opener', name: 'Jo Hill', profileId: OWEN });
  const okd = item({
    kind: 'follow_up',
    name: 'Kim Lee',
    profileId: '6b6f5c4d-3e2a-4b1c-8d9e-0f1a2b3c4d5e',
    send: {
      sendId: '7b6f5c4d-3e2a-4b1c-8d9e-0f1a2b3c4d5e',
      state: 'approved',
      text: 'Hi Kim',
      handedOver: false,
      needsYou: null,
    },
  } as Partial<TodayListItem>);
  const list = {
    items: [request, opener, okd, reply],
    auto: ['friend_request' as const],
    messages: ['opener' as const, 'follow_up' as const, 'reply' as const],
  };
  const what = (work: ReturnType<typeof workLeft>) => work.map((w) => `${w.do}: ${w.item.name}`);

  it('drafts a reply before anything else, with Approve all or not', () => {
    expect(what(workLeft({ ...list, sending: 'steps' }, []))).toEqual([
      'draft: Maya Ortiz',
      'send: Kim Lee',
      'step: Dana Reyes',
      'draft: Jo Hill',
    ]);
    expect(what(workLeft({ ...list, sending: 'approve_all' }, []))).toEqual([
      'draft: Maya Ortiz',
      'send: Kim Lee',
      'draft: Jo Hill',
      'step: Dana Reyes',
    ]);
  });

  it('drafts the reply again for someone who wrote back since, and nothing else tried', () => {
    const all = workLeft({ ...list, sending: 'steps' }, []);
    const tried = all.map(workKey);
    expect(workLeft({ ...list, sending: 'steps' }, tried)).toEqual([]);
    expect(what(workLeft({ ...list, sending: 'steps' }, tried, [MAYA, OWEN]))).toEqual([
      'draft: Maya Ortiz',
    ]);
  });

  it('keeps who wrote back till their reply’s drafted, and lets go of those not on the list', () => {
    expect(withReplied([MAYA], [MAYA, OWEN])).toEqual([MAYA, OWEN]);
    const left = workLeft({ ...list, sending: 'steps' }, []);
    expect(repliedAfter([MAYA, OWEN], left[0]!)).toEqual([OWEN]);
    expect(repliedAfter([MAYA], left[1]!)).toEqual([MAYA]);
    expect(stillReplied([MAYA, OWEN], left)).toEqual([MAYA]);
  });

  it('gives the list its turn over the morning’s reading while someone who wrote back waits', () => {
    expect(listTurn({ readLast: false, replied: [MAYA] }, true, false)).toBe(true);
    expect(listTurn({ readLast: false, replied: [] }, true, false)).toBe(false);
    // A first save still holds the day.
    expect(listTurn({ replied: [MAYA] }, true, true)).toBe(false);
  });
});

describe('outside the working hours (decision 133)', () => {
  const send = (state: 'waiting' | 'approved', text: string) => ({
    sendId: '8b6f5c4d-3e2a-4b1c-8d9e-0f1a2b3c4d5e',
    state,
    text,
    handedOver: false,
    needsYou: null,
  });
  const reply = item({
    kind: 'reply',
    name: 'Maya Ortiz',
    profileId: MAYA,
    threadKey: '100200300',
  });
  const okdReply = item({
    kind: 'partner_reply',
    name: 'Ana Ruiz',
    profileId: '5b6f5c4d-3e2a-4b1c-8d9e-0f1a2b3c4d5e',
    threadKey: '100200301',
    send: send('approved', 'Sounds good, Ana'),
  } as Partial<TodayListItem>);
  const okdOpener = item({
    kind: 'opener',
    name: 'Jo Hill',
    profileId: OWEN,
    send: send('approved', 'Hi Jo'),
  } as Partial<TodayListItem>);
  const list = {
    items: [item({}), okdOpener, reply],
    partners: [okdReply],
    auto: ['friend_request' as const],
    messages: ['opener' as const, 'reply' as const, 'partner_reply' as const],
    sending: 'steps' as const,
  };

  it('answers who wrote back, drafted and sent once OK’d, and does nothing new', () => {
    expect(
      workLeft(list, [])
        .filter(answersAnyTime)
        .map((w) => `${w.do}: ${w.item.name}`),
    ).toEqual(['draft: Maya Ortiz', 'send: Ana Ruiz']);
  });

  it('looks again soon while a reply waits for an OK, else at the hours’ next start', () => {
    const now = Date.UTC(2026, 9, 30, 3);
    const next = now + 6 * 3_600_000;
    expect(replyWaiting(list)).toBe(false);
    const waiting = { items: [{ ...reply, send: send('waiting', 'Thanks, Maya') }] };
    expect(replyWaiting(waiting)).toBe(true);
    expect(lookOutsideAt(true, now, next)).toBe(now + REPLY_LOOK_MS);
    expect(lookOutsideAt(true, now, null)).toBe(now + REPLY_LOOK_MS);
    expect(lookOutsideAt(false, now, next)).toBe(next);
    // The hours start sooner than the next look: then.
    expect(lookOutsideAt(true, now, now + 60_000)).toBe(now + 60_000);
  });
});

describe('a reply HandsFreeOS keeps as new', () => {
  it('reaches the runner of the network it was seen on, by who wrote', async () => {
    const real = await vi.importActual<RepliesModule>('../src/hfos/replies');
    const heard = vi.fn();
    real.onReplied(heard);
    world.kept_replies = [{ profileId: MAYA, name: 'Maya Ortiz' }];
    await real.noteReplies({ type: 'hfos-replies', seen: [maya], looking: false }, 'instagram');
    expect(world.posted[0]).toMatchObject({
      path: '/v1/commands/outreach.replies.note',
      body: { platform: 'instagram', looking: false },
    });
    expect(heard).toHaveBeenCalledWith('instagram', [MAYA]);
    // Nothing new: nobody's told.
    heard.mockClear();
    world.kept_replies = [];
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await real.noteReplies({ type: 'hfos-replies', seen: [maya], looking: false }, 'instagram');
    expect(heard).not.toHaveBeenCalled();
  });
});
