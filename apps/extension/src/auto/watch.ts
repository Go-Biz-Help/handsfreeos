/**
 * Each network's messages, kept open and read every minute (docs/outreach.md, decision 125; the owner, 29 Oct 2026:
 * "keep a page of each platform open at all times and check for messages sent to us each minute locally so that we
 * can reply quickly"). While Chrome is open, someone's signed in, this is the computer that works, and noting is on, a
 * window of its own, kept minimized, holds one tab for each network that's on and works on its own (not Off): Messenger,
 * LinkedIn's messaging, Instagram's messages and Alignable's. Every minute each page is read where it stands, never
 * pressed or scrolled.
 *
 * - On Facebook, LinkedIn and Instagram, the chats whose last message is theirs go to HandsFreeOS as any tab's do
 *   (../hfos/replies.ts). One that answers a message of the person's buzzes their phone, and has that network's runner
 *   draft the reply next (`onReplied`, in the background).
 * - Alignable's list doesn't say who wrote last, so a conversation whose last line changed has its runner read the
 *   chats again (`alignableChatsAgain`), which opens only the ones that changed.
 *
 * A page is loaded afresh every so often, when it went elsewhere, and when it doesn't answer. A tab the person closes
 * stays closed for an hour, and every tab does when they close the window.
 */
import type { Platform } from '@hfos/core/addons/outreach/networks';
import { SETTINGS_KEY } from '../hfos/follow';
import { keptFor } from '../hfos/live';
import type { Automation } from '../hfos/messages';
import { isNoting } from '../hfos/noting';
import { noteReplies } from '../hfos/replies';
import { savingTo } from '../hfos/session';
import { warnedNow } from '../hfos/warned';
import { MESSAGES as ALIGNABLE_MESSAGES } from '../jobs/alignable/chats';
import { LINKEDIN_MESSAGING, MESSENGER_HOME } from '../jobs/chats';
import { INBOX as INSTAGRAM_INBOX } from '../jobs/instagram/chats';
import type { RepliesNowAnswer } from '../messages';
import { KITS } from '../networks';
import { isWorking, statesNow, type NetworkStates } from '../networks/on';

export const WATCH_ALARM = 'hfos-watch';
/** Where the watch keeps its window and tabs, while the browser is open. */
const WATCH_KEY = 'hfos.watch';

/** The networks it watches, in the order their tabs open. */
const WATCHED: readonly Platform[] = ['facebook', 'linkedin', 'instagram', 'alignable'];

/** The page kept open on each network, and the kinds of its pages that show the person's messages. */
export const WATCH_PAGES: Readonly<
  Record<Platform, { readonly url: string; readonly kinds: readonly string[] }>
> = {
  facebook: { url: MESSENGER_HOME.url, kinds: MESSENGER_HOME.kinds },
  linkedin: { url: LINKEDIN_MESSAGING.url, kinds: LINKEDIN_MESSAGING.kinds },
  instagram: { url: INSTAGRAM_INBOX, kinds: ['inbox', 'chat'] },
  alignable: { url: ALIGNABLE_MESSAGES, kinds: ['inbox', 'chat'] },
};

/**
 * A page is loaded afresh after this: one open for hours can stop hearing of new messages. Alignable's sooner, as its
 * list may only move when it's loaded.
 */
export const FRESH_MS: Readonly<Record<Platform, number>> = {
  facebook: 20 * 60_000,
  linkedin: 20 * 60_000,
  instagram: 20 * 60_000,
  alignable: 5 * 60_000,
};
/** A tab the person closed stays closed this long. */
export const CLOSED_FOR_MS = 60 * 60_000;
/**
 * A page that went elsewhere (the network asked them to sign in), or didn't answer, is loaded again only this long
 * after it last was: never every minute.
 */
export const AGAIN_MS = 5 * 60_000;
/** How long a page has to answer before it's loaded afresh. */
const ANSWER_MS = 10_000;
/** The window's size: the layout every network's readers were tuned on (../tab.ts). */
const WIDTH = 1100;
const HEIGHT = 900;
/** The most of Alignable's conversations compared, from the top. */
const ROWS_COMPARED = 12;

/** The watch's window and tabs, and when each page loaded or was closed. */
export interface Watch {
  readonly windowId: number | null;
  readonly tabs: Partial<Record<Platform, number>>;
  readonly loaded: Partial<Record<Platform, number>>;
  readonly closed: Partial<Record<Platform, number>>;
  /** Alignable's conversations as last read: each one's last line, by name. Null before the first read. */
  readonly rows: Readonly<Record<string, string>> | null;
}

const NONE: Watch = { windowId: null, tabs: {}, loaded: {}, closed: {}, rows: null };

/** Whether a network works on its own: Facebook's sending, or the network's own. */
function sendingOn(settings: Automation['settings'], platform: Platform): boolean {
  if (platform === 'facebook') return settings.sending !== 'off';
  const choices = (settings.networks as Partial<Record<Platform, { readonly sending?: string }>>)[
    platform
  ];
  return choices?.sending !== 'off';
}

/**
 * The networks whose messages are kept open now: none unless someone's signed in, this computer works and noting's on;
 * then each that's on and allowed, works on its own, wasn't warned today, and wasn't closed by the person this hour.
 */
export function watchedOn(input: {
  readonly settings: Automation['settings'] | null;
  readonly states: NetworkStates | null;
  readonly working: boolean;
  readonly noting: boolean;
  readonly warned: readonly Platform[];
  readonly closed: Watch['closed'];
  readonly now: number;
}): Platform[] {
  const { settings } = input;
  if (!settings || !input.working || !input.noting) return [];
  return WATCHED.filter((platform) => {
    const closedAt = input.closed[platform];
    return (
      isWorking(KITS[platform], input.states) &&
      sendingOn(settings, platform) &&
      !input.warned.includes(platform) &&
      (closedAt === undefined || input.now - closedAt >= CLOSED_FOR_MS)
    );
  });
}

/** The conversations' last lines, by name, from the top: the ones with nothing written yet left out. */
export function rowsOf(
  rows: readonly { readonly name: string; readonly preview: string | null }[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows.slice(0, ROWS_COMPARED))
    if (row.preview) out[row.name.trim().toLowerCase()] = row.preview.trim();
  return out;
}

/** Whether a conversation has a new last line since the last read. The first read only notes where they stand. */
export function rowsMoved(
  before: Readonly<Record<string, string>> | null,
  now: Readonly<Record<string, string>>,
): boolean {
  if (before === null) return false;
  return Object.entries(now).some(([name, line]) => before[name] !== line);
}

/** What should happen to a network's tab this minute: open it, load it afresh, leave it be, or read it. */
export function tabStep(input: {
  readonly tab: { readonly status?: string; readonly discarded?: boolean } | null;
  readonly kind: string | null;
  readonly platform: Platform;
  readonly loadedAt: number | undefined;
  readonly now: number;
}): 'open' | 'load' | 'wait' | 'read' {
  const { tab } = input;
  if (!tab) return 'open';
  if (tab.discarded) return 'load';
  if (tab.status !== undefined && tab.status !== 'complete') return 'wait';
  const since = input.now - (input.loadedAt ?? 0);
  if (input.kind === null || !WATCH_PAGES[input.platform].kinds.includes(input.kind))
    return since >= AGAIN_MS ? 'load' : 'wait';
  if (since >= FRESH_MS[input.platform]) return 'load';
  return 'read';
}

/** A page that didn't answer is loaded again, unless it was lately (`AGAIN_MS`). */
export const loadAgain = (loadedAt: number | undefined, now: number): boolean =>
  now - (loadedAt ?? 0) >= AGAIN_MS;

// ------------------------------------------------------------------------------------------------- kept

function isWatch(value: unknown): value is Watch {
  return (
    typeof value === 'object' &&
    value !== null &&
    'tabs' in value &&
    'loaded' in value &&
    'closed' in value
  );
}

async function watchNow(): Promise<Watch> {
  try {
    const value: unknown = (await chrome.storage.session.get(WATCH_KEY))[WATCH_KEY];
    return isWatch(value) ? { ...NONE, ...value } : NONE;
  } catch {
    return NONE;
  }
}

let writing: Promise<unknown> = Promise.resolve();
/** Changes what's kept, one change after another, each on the latest. */
function setWatch(change: (watch: Watch) => Partial<Watch>): Promise<Watch> {
  const write = writing.then(async () => {
    const now = await watchNow();
    const next = { ...now, ...change(now) };
    await chrome.storage.session.set({ [WATCH_KEY]: next });
    return next;
  });
  writing = write.catch(() => undefined);
  return write;
}

/** Window and tab ids it's closing itself: never counted as the person closing them. */
const closing = new Set<number>();

// ------------------------------------------------------------------------------------------------- the minute

/** Who hears that Alignable's conversations moved: its runner (the background says). */
let moved: () => void = () => undefined;
export function onAlignableMoved(heard: () => void): void {
  moved = heard;
}

/** The networks to watch now, from what's kept on the computer: never an ask of HandsFreeOS. */
async function watchedNow(watch: Watch): Promise<Platform[]> {
  const to = await savingTo().catch(() => null);
  if (!to) return [];
  const [kept, noting, states, said] = await Promise.all([
    keptFor(to),
    isNoting(),
    statesNow(),
    chrome.storage.local.get(SETTINGS_KEY).then(
      (found) => found[SETTINGS_KEY] as Automation | undefined,
      () => undefined,
    ),
  ]);
  const warned: Platform[] = [];
  for (const platform of WATCHED) if (await warnedNow(platform)) warned.push(platform);
  return watchedOn({
    settings: said?.settings ?? null,
    states,
    // Another computer of theirs works now: it keeps theirs open, not this one.
    working: !kept || kept.working,
    noting,
    warned,
    closed: watch.closed,
    now: Date.now(),
  });
}

/** Its window, opened beside the person's and minimized, with the first network's page. */
async function windowFor(watch: Watch, first: Platform): Promise<Watch> {
  const open =
    watch.windowId === null ? null : await chrome.windows.get(watch.windowId).catch(() => null);
  if (open) return watch;
  const theirs = await chrome.windows.getLastFocused().catch(() => null);
  const beside =
    theirs?.left !== undefined && theirs.top !== undefined && theirs.width !== undefined
      ? { left: Math.max(theirs.left, theirs.left + theirs.width - WIDTH), top: theirs.top }
      : {};
  const made = await chrome.windows.create({
    url: WATCH_PAGES[first].url,
    focused: false,
    width: WIDTH,
    height: HEIGHT,
    ...beside,
  });
  const windowId = made?.id ?? null;
  const tabId = made?.tabs?.[0]?.id;
  if (windowId === null) throw new Error('Chrome didn’t open the window.');
  // Minimized at the size it opened at, so each page lays out as its readers expect.
  await chrome.windows.update(windowId, { state: 'minimized' }).catch(() => undefined);
  if (tabId !== undefined)
    await chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => undefined);
  const now = Date.now();
  return setWatch(() => ({
    windowId,
    tabs: tabId === undefined ? {} : { [first]: tabId },
    loaded: tabId === undefined ? {} : { [first]: now },
    rows: null,
  }));
}

/** Closes a network's tab, when it has one. */
async function closeTab(watch: Watch, platform: Platform): Promise<void> {
  const id = watch.tabs[platform];
  if (id === undefined) return;
  closing.add(id);
  await chrome.tabs.remove(id).catch(() => undefined);
  await setWatch((now) => {
    const tabs = { ...now.tabs };
    delete tabs[platform];
    return { tabs };
  });
}

/** Closes its window: nothing is watched now. */
async function closeWindow(watch: Watch): Promise<void> {
  if (watch.windowId !== null) {
    closing.add(watch.windowId);
    await chrome.windows.remove(watch.windowId).catch(() => undefined);
  }
  await setWatch(() => ({ windowId: null, tabs: {}, loaded: {}, rows: null }));
}

/** Asks a tab's script, giving up after a while: a page Chrome froze, or one with no script, answers nothing. */
async function askWithin<T>(tabId: number, message: { readonly type: string }): Promise<T | null> {
  const asked = chrome.tabs.sendMessage(tabId, message).then(
    (answer) => answer as T,
    () => null,
  );
  const late = new Promise<null>((done) => setTimeout(() => done(null), ANSWER_MS));
  return Promise.race([asked, late]);
}

/** Loads a network's page in its tab afresh. */
async function load(tabId: number, platform: Platform): Promise<void> {
  await chrome.tabs.update(tabId, { url: WATCH_PAGES[platform].url, autoDiscardable: false });
  await setWatch((now) => ({ loaded: { ...now.loaded, [platform]: Date.now() } }));
}

/** This minute on one network: its tab opened, loaded afresh, or read. */
async function lookAt(watch: Watch, platform: Platform): Promise<void> {
  const id = watch.tabs[platform];
  const tab = id === undefined ? null : await chrome.tabs.get(id).catch(() => null);
  const ours = tab && tab.windowId === watch.windowId ? tab : null;
  const step = tabStep({
    tab: ours,
    kind: ours?.url ? KITS[platform].kindOf(ours.url) : null,
    platform,
    loadedAt: watch.loaded[platform],
    now: Date.now(),
  });
  if (step === 'wait') return;
  if (step === 'open' || !ours?.id) {
    if (watch.windowId === null) return;
    const made = await chrome.tabs.create({
      windowId: watch.windowId,
      url: WATCH_PAGES[platform].url,
      active: false,
    });
    if (made.id === undefined) return;
    await chrome.tabs.update(made.id, { autoDiscardable: false }).catch(() => undefined);
    const madeId = made.id;
    await setWatch((now) => ({
      tabs: { ...now.tabs, [platform]: madeId },
      loaded: { ...now.loaded, [platform]: Date.now() },
    }));
    return;
  }
  if (step === 'load') return load(ours.id, platform);
  const unanswered = () =>
    loadAgain(watch.loaded[platform], Date.now()) ? load(ours.id!, platform) : undefined;
  if (platform === 'alignable') {
    const read = await askWithin<{
      ok?: boolean;
      result?: { found?: { chats?: readonly { name: string; preview: string | null }[] } };
    }>(ours.id, { type: 'hfos-read' });
    const chats = read?.ok ? read.result?.found?.chats : undefined;
    if (!chats) return unanswered();
    const rows = rowsOf(chats);
    const before = (await watchNow()).rows;
    await setWatch(() => ({ rows }));
    if (rowsMoved(before, rows)) moved();
    return;
  }
  const answer = await askWithin<RepliesNowAnswer>(ours.id, { type: 'hfos-replies-now' });
  if (!answer?.ok) return unanswered();
  if (answer.seen.length)
    await noteReplies({ type: 'hfos-replies', seen: answer.seen, looking: false }, platform);
}

async function look(): Promise<void> {
  const watch = await watchNow();
  const on = await watchedNow(watch);
  if (!on.length) {
    if (watch.windowId !== null) await closeWindow(watch);
    return;
  }
  const now = await windowFor(watch, on[0]!);
  for (const platform of on) {
    try {
      await lookAt(now, platform);
    } catch (error) {
      console.error(`HandsFreeOS Social couldn’t look at your ${platform} messages`, error);
    }
  }
  // Closed after the others opened, so the window never closes with its last tab.
  const after = await watchNow();
  for (const platform of WATCHED)
    if (!on.includes(platform) && after.tabs[platform] !== undefined)
      await closeTab(after, platform);
}

let busy = false;

/** Every minute, and when what's on changes: one look at a time. Never throws. */
export async function watchTick(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const alarm = await chrome.alarms.get(WATCH_ALARM).catch(() => null);
    if (!alarm) await chrome.alarms.create(WATCH_ALARM, { periodInMinutes: 1 });
    await look();
  } catch (error) {
    console.error('HandsFreeOS Social couldn’t look at your messages', error);
  } finally {
    busy = false;
  }
}

/** The person closed the window: every network's tab stays closed for an hour. */
export async function windowClosed(windowId: number): Promise<void> {
  if (closing.delete(windowId)) return;
  const watch = await watchNow();
  if (watch.windowId !== windowId) return;
  const at = Date.now();
  await setWatch(() => ({
    windowId: null,
    tabs: {},
    loaded: {},
    rows: null,
    closed: Object.fromEntries(WATCHED.map((platform) => [platform, at])) as Watch['closed'],
  }));
}

/** The person closed a network's tab: it stays closed for an hour. */
export async function tabClosed(tabId: number, windowClosing: boolean): Promise<void> {
  if (closing.delete(tabId) || windowClosing) return;
  const watch = await watchNow();
  const platform = WATCHED.find((p) => watch.tabs[p] === tabId);
  if (!platform) return;
  await setWatch((now) => {
    const tabs = { ...now.tabs };
    delete tabs[platform];
    return { tabs, closed: { ...now.closed, [platform]: Date.now() } };
  });
}
