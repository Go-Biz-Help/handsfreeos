/**
 * What the runner that works on its own (./run.ts) does next, and when: plain workings, kept apart so they can be
 * tested. It goes down the list for today (packages/core/src/addons/outreach/today.ts) in its own order: requests to
 * confirm, then posts to like, then friend requests, then comments (decisions 26, 30 and 33). Messages
 * (packages/core/src/addons/outreach/sends.ts) come around those: the ones OK'd go first, then it drafts the rest,
 * which wait for the person or go as they are; with Approve all, it drafts them all before anything else, so they're
 * ready first thing. Within the working hours it spreads the day's steps out, at random times; after **Start my day** it goes at
 * a person's pace, a minute or few apart. Before any of it, once a day, it checks the person's friend requests, checks
 * their groups for their people and joins good ones when people left to reach run low (decision 48), saves their
 * groups' members, finds posts, reads their chats (decision 32) and checks their friends for good fits (decision 46),
 * which fill that list. In the working hours, every hour or two, it looks at the newest posts in their best groups
 * (decision 49), so one asking for what they offer is answered fast.
 */
import { workWindow, type WorkingHours } from '@hfos/core/addons/outreach/automation';
import { WATCH_EVERY_MINUTES } from '@hfos/core/addons/outreach/posts';
import type { TodayKind } from '@hfos/core/addons/outreach/today';
import type { NeedNoteInput, TodayList, TodayListItem } from '../hfos/messages';

/** Where the runner keeps its state, which the panel watches. */
export const AUTO_STATE_KEY = 'hfos.auto';

/** The kinds it does on its own, in the order it does them. */
export const AUTO_KINDS = ['confirm', 'warm_up', 'friend_request', 'comment'] as const;
export type AutoKind = (typeof AUTO_KINDS)[number];
/** What it counts as done today: the steps above, messages drafted, and messages sent. */
export type DoneKind = AutoKind | 'drafted' | 'sent';

/** The jobs it does once a day before the list, in the order it does them (./daily.ts, decision 32). */
export const DAILY_JOBS = [
  'requests',
  'group_checks',
  'join',
  'members',
  'posts',
  'chats',
  'checks',
] as const;
export type DailyJob = (typeof DAILY_JOBS)[number];

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
  readonly done: Readonly<Partial<Record<DoneKind, number>>>;
  /** The once-a-day jobs it did today, each with how it went in words. Missing in a state kept by 0.11. */
  readonly daily?: Readonly<Partial<Record<DailyJob, string>>>;
  /** When it next looks at the newest posts in the groups (decision 49). Missing in a state kept by 0.22: due now. */
  readonly watchAt?: number | null;
  /** What it's doing, or last did, in words for the person, and when. */
  readonly line: string | null;
  readonly lineAt: number | null;
  /** When it goes next: null when it isn't going to. */
  readonly nextAt: number | null;
  /** Whether a step is under way now. */
  readonly working: boolean;
  /**
   * It stopped for now and needs the person: noting is off, or something went wrong and it tries again later.
   * Missing in a state kept by 0.16; cleared at the next line it says.
   */
  readonly needs?: boolean;
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
    daily: {},
    watchAt: null,
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

/** The once-a-day job to do next, when it collects: the first not done today. */
export const nextDaily = (state: Pick<AutoState, 'daily'>): DailyJob | null =>
  DAILY_JOBS.find((job) => state.daily?.[job] === undefined) ?? null;

/** When it next looks at the newest posts after one at `now`: an hour or two later, at random (`random` 0 to 1). */
export function nextWatch(now: number, random: number): number {
  const [least, most] = WATCH_EVERY_MINUTES;
  return now + Math.round((least + random * (most - least)) * 60_000);
}

/** Whether it's time to look at the newest posts again. */
export const watchDue = (state: Pick<AutoState, 'watchAt'>, now: number): boolean =>
  (state.watchAt ?? 0) <= now;

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
  const left = AUTO_KINDS.filter((kind) => auto.includes(kind)).flatMap((kind) =>
    items.filter(
      (item) =>
        item.kind === kind &&
        !done.has(itemKey(item)) &&
        (kind === 'comment'
          ? item.postUrl !== null && item.profileUrl !== null
          : item.profileUrl !== null),
    ),
  );
  // A post asking for what the business offers goes first (decision 49): answered while it's fresh.
  return [...left.filter((item) => item.asking), ...left.filter((item) => !item.asking)];
}

/** One thing for it to do: a step on the list, drafting a message, or sending one OK'd. */
export type Work =
  | { readonly do: 'step'; readonly item: TodayListItem }
  | { readonly do: 'draft'; readonly item: TodayListItem }
  | { readonly do: 'send'; readonly item: TodayListItem };

/** A piece of work by what it is, so none is tried twice in a day: a send by its own id. */
export const workKey = (work: Work): string =>
  work.do === 'step'
    ? itemKey(work.item)
    : work.do === 'send'
      ? `send:${work.item.send?.sendId ?? itemKey(work.item)}`
      : `draft:${itemKey(work.item)}`;

/**
 * What's left for it to do today, in its order: messages OK'd first; then, with Approve all, every message to draft
 * before the steps, else the steps before them. A message needs the person kept, and their chat or profile to send in.
 */
export function workLeft(
  list: Pick<TodayList, 'items' | 'auto' | 'messages' | 'sending'>,
  tried: readonly string[],
): Work[] {
  const done = new Set(tried);
  const steps = itemsLeft(list.items, list.auto, tried).map(
    (item) => ({ do: 'step', item }) as const,
  );
  const messages = list.items.filter(
    (item) =>
      (list.messages as readonly string[]).includes(item.kind) &&
      item.profileId !== null &&
      (item.profileUrl !== null || item.threadKey !== null),
  );
  const sends = messages
    .filter((item) => item.send?.state === 'approved')
    .map((item) => ({ do: 'send', item }) as const);
  const drafts = messages
    .filter((item) => item.send === null)
    .map((item) => ({ do: 'draft', item }) as const);
  const all: Work[] =
    list.sending === 'approve_all'
      ? [...sends, ...drafts, ...steps]
      : [...sends, ...steps, ...drafts];
  return all.filter((work) => !done.has(workKey(work)));
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

/**
 * A step it couldn't do there and then, handed to the person (decision 42): the line it shows, less its lead ("Dana
 * Reyes: ", "Dana Reyes’s post: "), is why. Null for one that isn't the person's to do: a message (HandsFreeOS hands
 * over one that didn't go itself), or one with nobody kept to do it to.
 */
export function needOf(
  item: Pick<TodayListItem, 'kind' | 'name' | 'profileId' | 'postId' | 'postUrl' | 'profileUrl'>,
  line: string,
  businessId: string,
): NeedNoteInput | null {
  if (!(AUTO_KINDS as readonly string[]).includes(item.kind) || !item.profileId) return null;
  const why = [`${item.name}’s post: `, `${item.name}: `].reduce(
    (said, lead) => (said.startsWith(lead) ? said.slice(lead.length) : said),
    line,
  );
  return {
    workspaceId: businessId,
    step: item.kind as AutoKind,
    profileId: item.profileId,
    postId: item.kind === 'comment' ? (item.postId ?? null) : null,
    name: item.name,
    url: (item.kind === 'comment' ? item.postUrl : null) ?? item.profileUrl ?? null,
    why,
  };
}
