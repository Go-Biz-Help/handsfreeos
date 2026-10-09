/**
 * What the runner that works on its own (./run.ts) does next, and when: plain workings, kept apart so they can be
 * tested. It goes down the list for today (packages/core/src/addons/outreach/today.ts) in its own order: requests to
 * confirm, then posts to like, then friend requests, then comments (decisions 26, 30 and 33). Messages wait for the
 * person. Within the working hours it spreads the day's steps out, at random times; after **Start my day** it goes at
 * a person's pace, a minute or few apart.
 */
import { workWindow, type WorkingHours } from '@hfos/core/addons/outreach/automation';
import type { TodayKind } from '@hfos/core/addons/outreach/today';
import type { TodayListItem } from '../hfos/messages';

/** Where the runner keeps its state, which the panel watches. */
export const AUTO_STATE_KEY = 'hfos.auto';

/** The kinds it does on its own, in the order it does them. */
export const AUTO_KINDS = ['confirm', 'warm_up', 'friend_request', 'comment'] as const;
export type AutoKind = (typeof AUTO_KINDS)[number];

/** The shortest and longest wait between two steps in the working hours. */
export const GAP_MS = { least: 60_000, most: 45 * 60_000 } as const;
/** The wait between two steps after Start my day: a person's pace. */
export const STARTED_GAP_MS = { least: 60_000, most: 180_000 } as const;
/** How far after the hours start it may begin: never on the hour exactly. */
export const START_JITTER_MS = 20 * 60_000;
/** How often it looks again in the hours when nothing's left: a new request to confirm may come. */
export const IDLE_MS = 60 * 60_000;

const DAY = 86_400_000;

/** Where the runner is, kept in the extension's storage across the background's restarts. */
export interface AutoState {
  /** The business's day these are for: "2026-10-09". A new day starts afresh. */
  readonly day: string | null;
  /** Start my day was pressed today: it goes now, at a person's pace, hours or not. */
  readonly started: boolean;
  /** Why it stopped for today: Stop for today, or a warning from Facebook. Null while it goes. */
  readonly stopped: string | null;
  /** Those on the list done or passed over today, by `itemKey`, so none is tried twice. */
  readonly tried: readonly string[];
  /** How many of each it did today. */
  readonly done: Readonly<Partial<Record<AutoKind, number>>>;
  /** What it's doing, or last did, in words for the person, and when. */
  readonly line: string | null;
  readonly lineAt: number | null;
  /** When it goes next: null when it isn't going to. */
  readonly nextAt: number | null;
  /** Whether a step is under way now. */
  readonly working: boolean;
  /** The tab in its window, while it's open. */
  readonly tabId: number | null;
}

export function freshState(day: string | null, tabId: number | null = null): AutoState {
  return {
    day,
    started: false,
    stopped: null,
    tried: [],
    done: {},
    line: null,
    lineAt: null,
    nextAt: null,
    working: false,
    tabId,
  };
}

/** Whether something read from storage has the shape of a state. */
export function isState(value: unknown): value is AutoState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.tried) &&
    typeof v.done === 'object' &&
    v.done !== null &&
    typeof v.started === 'boolean'
  );
}

/** Someone on the list, by what they're on it for. */
export const itemKey = (item: Pick<TodayListItem, 'kind' | 'postId' | 'profileId' | 'name'>) =>
  `${item.kind}:${item.postId ?? item.profileId ?? item.name}`;

/**
 * What's left for it to do today, in its order: the kinds it does for the person (the list's `auto`), not tried
 * yet today, with the page to do it on.
 */
export function itemsLeft(
  items: readonly TodayListItem[],
  auto: readonly TodayKind[],
  tried: readonly string[],
): TodayListItem[] {
  const done = new Set(tried);
  return AUTO_KINDS.filter((kind) => auto.includes(kind)).flatMap((kind) =>
    items.filter(
      (item) =>
        item.kind === kind &&
        !done.has(itemKey(item)) &&
        (kind === 'comment'
          ? item.postUrl !== null && item.profileUrl !== null
          : item.profileUrl !== null),
    ),
  );
}

/**
 * How long to wait before the next step: in the hours, what's left of them shared among the steps left, more or
 * less by half, so the day's steps spread out at random times; after Start my day, a person's pace. `random` is
 * from 0 to 1.
 */
export function gapAfter(input: {
  readonly now: number;
  /** When the working hours end today: null after Start my day outside them. */
  readonly until: number | null;
  readonly left: number;
  readonly started: boolean;
  readonly random: number;
}): number {
  const { least, most } = input.started || input.until === null ? STARTED_GAP_MS : GAP_MS;
  if (input.started || input.until === null)
    return Math.round(least + input.random * (most - least));
  const even = (input.until - input.now) / Math.max(1, input.left);
  return Math.round(Math.min(most, Math.max(least, even * (0.5 + input.random))));
}

/** When the working hours next start after `now`, within a week; a little after the hour, at random. */
export function nextStart(
  hours: WorkingHours,
  timeZone: string,
  now: number,
  random: number,
): number | null {
  for (let days = 0; days <= 7; days++) {
    const window = workWindow(hours, timeZone, now + days * DAY);
    if (window && window.from > now) return window.from + Math.round(random * START_JITTER_MS);
  }
  return null;
}
