/**
 * Waiting for you on this computer (docs/outreach.md, decisions 40 and 42; the rules in
 * packages/core/src/addons/outreach/waiting-words.ts), in the background worker:
 *
 * - **The number on the icon** is everything waiting for the person (`outreach.waiting`): messages for their OK,
 *   replies handed over, steps the extension needs them for, and friend requests to decide. It's asked again within
 *   seconds of a change heard on the live channel (./follow.ts), after the person acts on one in the panel, and every
 *   10 minutes with nothing heard (the beat's alarm).
 * - **Chrome's pop-ups** follow the person's pushes setting, as their phone does: one bundled pop-up at most every 2
 *   hours in their working hours, or one for each (more than 3 at once go as one); a reply handed over pops up at once
 *   either way; friend requests never do. They show only on the computer that works (./live.ts), and the first look
 *   after a sign-in tells of what was there in one pop-up at most. A click opens the side panel, or Waiting for you in
 *   HandsFreeOS when Chrome won't or the button was pressed.
 *
 * What's kept says whose it is (the person and the business), so one person's never shows for another.
 */
import { inWorkingHours } from '@hfos/core/addons/outreach/automation';
import {
  badgeText,
  bundleDue,
  bundlePushWords,
  EACH_POPUPS_MOST,
  eachPushWords,
  handOverPushWords,
  NUDGE_KINDS,
  WAITING_REFRESH_MINUTES,
  waitingWords,
  type WaitingKinds,
} from '@hfos/core/addons/outreach/waiting-words';
import type { WorkingHours } from '@hfos/core/addons/outreach/automation';
import { outreachPath } from '@hfos/core/addons/outreach/setup';
import { config } from './config';
import { keptFor, samePlace } from './live';
import {
  WAITING_ANY_ACTOR,
  WAITING_EVENTS,
  WAITING_FOR_KEY,
  type HfosAnswer,
  type HfosAsk,
  type Waiting,
  type WaitingItem,
} from './messages';
import { answerWith, api, call, Refused, savingTo, type Place } from './session';

/** What a pop-up told of already, and when the last bundled one went. */
export const WAITING_TOLD_KEY = 'hfos.waitingFor.told';
/** The bundled pop-up: one at a time, replaced. Each one of its own is this and the item's id. */
export const POPUP_ID = 'hfos-waiting';
/** The most ids remembered as told. */
export const TOLD_MOST = 300;

export interface KeptWaiting extends Place {
  readonly list: Waiting;
  readonly at: number;
}

export interface Told extends Place {
  readonly ids: readonly string[];
  /** When the last bundled pop-up went: null when none has. */
  readonly lastAt: number | null;
}

export interface PopUp {
  readonly id: string;
  readonly title: string;
  readonly message: string;
}

// ------------------------------------------------------------------------------------------------- the workings

/**
 * Whether a change heard on the live channel may move what waits for the signed-in person: their own; one HandsFreeOS
 * made itself (no person did it: a download brought in, friends saved); or a change to settings or training wheels by
 * anyone, since an owner may change the person's.
 */
export function waitingEventFor(
  payload: { readonly type?: unknown; readonly actorId?: unknown },
  userId: string | null,
): boolean {
  if (!userId || typeof payload.type !== 'string' || !WAITING_EVENTS.has(payload.type))
    return false;
  return (
    payload.actorId === userId ||
    payload.actorId === null ||
    payload.actorId === undefined ||
    WAITING_ANY_ACTOR.has(payload.type)
  );
}

type Nudge = Extract<WaitingItem, { kind: 'reply' | 'message' | 'need' }>;
const isNudge = (item: WaitingItem): item is Nudge =>
  (NUDGE_KINDS as readonly string[]).includes(item.kind);

/** A message's or a need's id: what's remembered as told. */
export const itemId = (item: Nudge): string =>
  item.kind === 'need' ? item.need.needId : item.send.sendId;

function popUpOf(item: Nudge): PopUp {
  const id = `${POPUP_ID}-${itemId(item)}`;
  const words =
    item.kind === 'reply'
      ? handOverPushWords(item.send.name, item.send.needsYou)
      : item.kind === 'message'
        ? eachPushWords('message', item.send.name)
        : eachPushWords('need', item.need.name, item.need.why);
  return { id, title: words.title, message: words.body };
}

function bundledPopUp(kinds: WaitingKinds, withReplies = false): PopUp | null {
  const words = bundlePushWords(kinds, withReplies);
  return words && { id: POPUP_ID, title: words.title, message: words.body };
}

/**
 * The pop-ups to show now, and what's told after: the rule the phone's pushes follow, on this computer.
 *
 * - `told` null (the first look since the person signed in here): what's there is told in one pop-up at most, in
 *   their working hours for bundled;
 * - a new reply handed over pops up at once, on its own;
 * - one for each: each new message and need, up to `EACH_POPUPS_MOST`; more go as one;
 * - bundled: one, when something's new and it's due (working hours, 2 hours after the last); not due, nothing new is
 *   marked told, so a later look shows it once it is.
 */
export function popUpsFor(input: {
  readonly list: Pick<Waiting, 'items' | 'kinds' | 'pushes' | 'hours' | 'timezone'>;
  readonly told: readonly string[] | null;
  readonly lastAt: number | null;
  readonly now: number;
}): { show: PopUp[]; told: string[]; lastAt: number | null } {
  const { list, now } = input;
  const hours = list.hours as WorkingHours;
  const nudges = list.items.filter(isNudge);
  const ids = nudges.map(itemId);
  const bundled = () => bundledPopUp(list.kinds);
  if (input.told === null) {
    // The first look tells of all that was there, replies handed over too.
    const one =
      list.pushes === 'each' || inWorkingHours(hours, list.timezone, now)
        ? bundledPopUp(list.kinds, true)
        : null;
    return {
      show: one ? [one] : [],
      told: ids.slice(0, TOLD_MOST),
      lastAt: one ? now : input.lastAt,
    };
  }
  const known = new Set(input.told);
  // Only those still waiting are remembered: one that leaves and comes back is new again.
  const stillTold = ids.filter((id) => known.has(id));
  const fresh = nudges.filter((item) => !known.has(itemId(item)));
  if (!fresh.length) return { show: [], told: stillTold, lastAt: input.lastAt };
  const replies = fresh.filter((item) => item.kind === 'reply');
  const others = fresh.filter((item) => item.kind !== 'reply');
  const show = replies.map(popUpOf);
  const told = [...stillTold, ...replies.map(itemId)];
  let lastAt = input.lastAt;
  if (others.length) {
    if (list.pushes === 'each') {
      if (others.length <= EACH_POPUPS_MOST) show.push(...others.map(popUpOf));
      else {
        const one = bundled();
        if (one) show.push(one);
      }
      told.push(...others.map(itemId));
    } else if (bundleDue({ now, lastAt, hours, timeZone: list.timezone })) {
      const one = bundled();
      if (one) show.push(one);
      told.push(...others.map(itemId));
      lastAt = now;
    }
  }
  return { show, told: told.slice(-TOLD_MOST), lastAt };
}

// ------------------------------------------------------------------------------------------------- storage

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

async function readKey<T>(key: string): Promise<T | null> {
  try {
    const value: unknown = (await chrome.storage.local.get(key))[key];
    return isObject(value) ? (value as T) : null;
  } catch {
    return null;
  }
}

/** The last answer kept, when it's this person's in this business. */
export async function waitingKept(place: Place | null): Promise<KeptWaiting | null> {
  const kept = await readKey<KeptWaiting>(WAITING_FOR_KEY);
  return samePlace(kept, place) ? kept : null;
}

// ------------------------------------------------------------------------------------------------- the icon

/** A red that reads on both of Chrome's themes. */
const BADGE_RED = '#C62828';

async function showCount(count: number | null): Promise<void> {
  try {
    await chrome.action.setBadgeText({ text: count === null ? '' : badgeText(count) });
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_RED });
    await chrome.action.setTitle({
      title: count === null ? 'HandsFreeOS Social' : `HandsFreeOS Social: ${waitingWords(count)}`,
    });
  } catch {
    // Chrome is closing: the next look sets it.
  }
}

// ------------------------------------------------------------------------------------------------- pop-ups

async function clearPopUps(): Promise<void> {
  try {
    const shown = await chrome.notifications.getAll();
    await Promise.all(
      Object.keys(shown)
        .filter((id) => id.startsWith(POPUP_ID))
        .map((id) => chrome.notifications.clear(id)),
    );
  } catch {
    // Nothing shown, or Chrome won't say.
  }
}

/** Shows a pop-up; one with the same id replaces it. Also for a step an ask hands the person (../asks/run.ts). */
export async function popUp(shown: PopUp): Promise<void> {
  try {
    await chrome.notifications.create(shown.id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title: shown.title,
      message: shown.message,
      buttons: [{ title: 'Open in HandsFreeOS' }],
      priority: 0,
    });
  } catch (error) {
    console.error('HandsFreeOS Social couldn’t show a pop-up', error);
  }
}

/** Tells of what's new, as the person's pushes say, on the computer that works. */
async function tell(place: Place, list: Waiting): Promise<void> {
  const told = await readKey<Told>(WAITING_TOLD_KEY);
  const mine = samePlace(told, place) ? told : null;
  const next = popUpsFor({
    list,
    told: mine ? mine.ids : null,
    lastAt: mine?.lastAt ?? null,
    now: Date.now(),
  });
  // Another computer of theirs works: it shows them there, and this one only remembers them as told.
  const live = await keptFor(place);
  if (!live || live.working) for (const shown of next.show) await popUp(shown);
  const kept: Told = { ...place, ids: next.told, lastAt: next.lastAt };
  await chrome.storage.local.set({ [WAITING_TOLD_KEY]: kept }).catch(() => undefined);
}

// ------------------------------------------------------------------------------------------------- asking

/** Nobody signed in: no number, nothing kept, no pop-ups. */
async function forget(): Promise<void> {
  await showCount(null);
  await chrome.storage.local.remove([WAITING_FOR_KEY, WAITING_TOLD_KEY]).catch(() => undefined);
  await clearPopUps();
}

async function refreshOnce(): Promise<KeptWaiting | null> {
  const place = await savingTo().catch(() => null);
  if (!place) {
    await forget();
    return null;
  }
  let list: Waiting;
  try {
    list = await call(
      api().POST('/v1/queries/outreach.waiting', {
        body: { workspaceId: place.businessId, items: true },
      }),
      place.businessId,
    );
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    // Social Outreach turned off there, or the person can't use it any more: no number, nothing kept.
    if (error.problem.rule === 'addon_inactive' || error.problem.status === 403) {
      await forget();
      return null;
    }
    // No connection: the last answer stays, if it's theirs.
    const kept = await waitingKept(place);
    await showCount(kept ? kept.list.count : null);
    return kept;
  }
  const kept: KeptWaiting = { ...place, list, at: Date.now() };
  await chrome.storage.local.set({ [WAITING_FOR_KEY]: kept }).catch(() => undefined);
  await showCount(list.count);
  await tell(place, list);
  return kept;
}

let running: Promise<KeptWaiting | null> | null = null;
let again = false;

/** Asks HandsFreeOS what waits, one look at a time: one asked for while another goes follows it. */
export function refreshWaiting(): Promise<KeptWaiting | null> {
  if (running) {
    again = true;
    return running;
  }
  running = refreshOnce()
    .catch((error: unknown) => {
      console.error('HandsFreeOS Social couldn’t ask what waits for you', error);
      return null;
    })
    .finally(() => {
      running = null;
      if (again) {
        again = false;
        void refreshWaiting();
      }
    });
  return running;
}

let soon: ReturnType<typeof setTimeout> | null = null;
/** A look in a moment: changes close together go in one. */
export function waitingSoon(): void {
  if (soon) clearTimeout(soon);
  soon = setTimeout(() => ((soon = null), void refreshWaiting()), 1_500);
}

/** The beat's alarm: a look when the last is older than 10 minutes, or there's none. */
export async function refreshWaitingIfOld(): Promise<void> {
  const place = await savingTo().catch(() => null);
  const kept = await waitingKept(place);
  if (!place || !kept || Date.now() - kept.at >= WAITING_REFRESH_MINUTES * 60_000)
    await refreshWaiting();
  // Chrome started again: the number comes back from the last look.
  else await showCount(kept.list.count);
}

/** A change heard on the live channel (./follow.ts) that may move what waits (`waitingEventFor`). */
export async function heardWaiting(payload: Record<string, unknown>): Promise<void> {
  const place = await savingTo().catch(() => null);
  if (waitingEventFor(payload, place?.userId ?? null)) waitingSoon();
}

// ------------------------------------------------------------------------------------------------- a click

/**
 * The window the person last used: the side panel opens there, at once, while Chrome still counts the click. Kept in
 * the session's storage too, since a click often wakes a sleeping background, which forgets what it had in memory.
 */
const LAST_WINDOW_KEY = 'hfos.lastWindow';
let lastWindow: number | null = null;
export function trackWindows(): void {
  try {
    chrome.windows.onFocusChanged.addListener((id) => {
      if (id === chrome.windows.WINDOW_ID_NONE) return;
      lastWindow = id;
      void chrome.storage.session.set({ [LAST_WINDOW_KEY]: id }).catch(() => undefined);
    });
    void chrome.storage.session
      .get(LAST_WINDOW_KEY)
      .then((kept) => {
        const id: unknown = kept[LAST_WINDOW_KEY];
        if (lastWindow === null && typeof id === 'number') lastWindow = id;
      })
      .catch(() => undefined);
    void chrome.windows
      .getLastFocused()
      .then((w) => {
        if (lastWindow === null && w.id !== undefined) lastWindow = w.id;
      })
      .catch(() => undefined);
  } catch {
    // No windows to follow: a click opens HandsFreeOS instead.
  }
}

async function openPage(): Promise<void> {
  const place = await savingTo().catch(() => null);
  if (!config.webUrl) return;
  const url = place ? `${config.webUrl}${outreachPath(place.businessId, 'today')}` : config.webUrl;
  await chrome.tabs.create({ url }).catch(() => undefined);
}

/**
 * One of its pop-ups was clicked: the side panel opens in the window last used, or Waiting for you in HandsFreeOS
 * when Chrome won't open it or the button was pressed. Called straight from Chrome's listener, so the panel opens
 * while the click still counts.
 */
export function openWaiting(notificationId: string, button?: number): void {
  if (!notificationId.startsWith(POPUP_ID)) return;
  void chrome.notifications.clear(notificationId).catch(() => undefined);
  if (button !== undefined) return void openPage();
  if (lastWindow !== null) {
    chrome.sidePanel.open({ windowId: lastWindow }).catch(() => void openPage());
    return;
  }
  // Just woken, with no window known yet: the one last used, if Chrome still counts the click; else HandsFreeOS.
  void chrome.windows
    .getLastFocused()
    .then((w) => (w.id === undefined ? openPage() : chrome.sidePanel.open({ windowId: w.id })))
    .catch(() => openPage());
}

// ------------------------------------------------------------------------------------------------- the panel's asks

type WaitingAsk = Extract<
  HfosAsk,
  { readonly type: 'hfos-waiting' | 'hfos-need-clear' | 'hfos-request-aside' }
>;

/** The panel's asks about Waiting for you. Never throws: what went wrong comes back as a problem. */
export function answerWaiting(ask: WaitingAsk): Promise<HfosAnswer<unknown>> {
  return answerWith(ask.type, async () => {
    switch (ask.type) {
      case 'hfos-waiting':
        return (await refreshWaiting())?.list ?? null;
      case 'hfos-need-clear': {
        const cleared = await call(
          api().POST('/v1/commands/outreach.need.clear', { body: ask.input }),
          ask.input.workspaceId,
        );
        waitingSoon();
        return cleared;
      }
      case 'hfos-request-aside': {
        const aside = await call(
          api().POST('/v1/commands/outreach.request.set_aside', { body: ask.input }),
          ask.input.workspaceId,
        );
        waitingSoon();
        return aside;
      }
    }
  });
}
