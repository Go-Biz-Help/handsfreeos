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
import {
  businessDay,
  nextInHours,
  startAfterToday,
  workWindow,
  type WorkingHours,
} from '@hfos/core/addons/outreach/automation';
import { startWords, type LiveDay } from '@hfos/core/addons/outreach/live';
import { WATCH_EVERY_MINUTES } from '@hfos/core/addons/outreach/posts';
import type { TodayKind } from '@hfos/core/addons/outreach/today';
import type { NeedNoteInput, TodayList, TodayListItem } from '../hfos/messages';
import type { ListMark, ListsSaved } from '@hfos/core/addons/outreach/lists';
import type { TriedBefore } from './lists';

/** Where the runner keeps its state, which the panel watches. */
export const AUTO_STATE_KEY = 'hfos.auto';
/** Where LinkedIn's runner keeps its own (./linkedin.ts). */
export const LINKEDIN_STATE_KEY = 'hfos.auto.linkedin';
/** Where Alignable's runner keeps its own (./alignable.ts). */
export const ALIGNABLE_STATE_KEY = 'hfos.auto.alignable';
/** Where Instagram's runner keeps its own (./instagram.ts). */
export const INSTAGRAM_STATE_KEY = 'hfos.auto.instagram';

/** The kinds it does on its own, in the order it does them. */
export const AUTO_KINDS = ['confirm', 'warm_up', 'friend_request', 'comment'] as const;
export type AutoKind = (typeof AUTO_KINDS)[number];
/**
 * What it counts as done today: the steps above, messages drafted, and messages sent; and on Instagram the stories its
 * warm-ups liked (decision 111), against the kit's `storyLikesPerDay`.
 */
export type DoneKind = AutoKind | 'drafted' | 'sent' | 'story_like';

/** The jobs it does once a day before the list, in the order it does them (./daily.ts, decision 32). */
export const DAILY_JOBS = [
  'requests',
  'tidy',
  'occasions',
  'group_checks',
  'join',
  'members',
  'posts',
  'chats',
  'checks',
  'partners',
  'helpful',
  'profile',
] as const;
export type DailyJob = (typeof DAILY_JOBS)[number];
/**
 * A once-a-day job only some networks' runners do: Instagram's look at the accounts the person followed for who follows
 * them back (../jobs/instagram/follow-backs.ts); and finding people by topic (decision 92): who liked or reacted to and
 * commented on good posts, on Instagram and LinkedIn (`post_people`), the checks of the people found, on all three
 * (`found_checks`, ../jobs/found-checks.ts), and on Alignable its search of businesses (`search`), the person's own
 * groups read first (`my_groups`) and the posts of the groups they joined (`group_posts`), beside Facebook's
 * `group_checks`, `join` and `members`; from 0.101.0 the week's helpful post asked for on Instagram and Alignable
 * (`weekly_post`, decision 109); from 0.102.0 Instagram's accounts like the business's (`like_yours`, decision
 * 110, ../jobs/instagram/like-yours.ts); and from 0.104.0 the events near the person on Alignable, once a week
 * (`events`, decision 112, ../jobs/alignable/events.ts).
 */
export type OwnDailyJob =
  | 'follow_backs'
  | 'post_people'
  | 'found_checks'
  | 'search'
  | 'my_groups'
  | 'group_posts'
  | 'weekly_post'
  | 'like_yours'
  | 'events';

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
  readonly daily?: Readonly<Partial<Record<DailyJob | OwnDailyJob, string>>>;
  /** What it did before the day today (./lists.ts), each with how it went in words. Missing in a state kept by 0.26. */
  readonly before?: TriedBefore;
  /**
   * The person's lists as HandsFreeOS last said, and the step before the day under way now: for the panel's live
   * checklist. Missing in a state kept by 0.27.
   */
  readonly lists?: ListsSaved | null;
  readonly beforeNow?: ListMark | null;
  /** When it next looks at the newest posts in the groups (decision 49). Missing in a state kept by 0.22: due now. */
  readonly watchAt?: number | null;
  /**
   * Today's helpful post, when the person lets it post on its own (decision 50): when it next looks for one written,
   * and whether it's up. Missing in a state kept by 0.23.
   */
  readonly helpfulAt?: number | null;
  readonly helpfulUp?: boolean;
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
    before: {},
    watchAt: null,
    helpfulAt: null,
    helpfulUp: false,
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

/** How long after a look finds no helpful post written yet it looks again. */
export const HELPFUL_AGAIN_MS = 30 * 60_000;

/** Whether to look for today's helpful post to put up on its own: not up yet, and due. */
export const helpfulDue = (
  state: Pick<AutoState, 'helpfulAt' | 'helpfulUp'>,
  now: number,
): boolean => !state.helpfulUp && (state.helpfulAt ?? 0) <= now;

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
 * The messages on a list it drafts and sends: a kind it writes, to someone kept, with their chat or profile. A comment
 * that goes through `sends` (decision 92: where `comment` is among the list's `messages`) also needs its post, kept and
 * with its link.
 */
const messagesOn = (items: readonly TodayListItem[], kinds: readonly string[]) =>
  items.filter(
    (item) =>
      kinds.includes(item.kind) &&
      item.profileId !== null &&
      (item.profileUrl !== null || item.threadKey !== null) &&
      (item.kind !== 'comment' || (item.postId !== null && item.postUrl !== null)),
  );

/**
 * What's left for it to do today, in its order: messages OK'd first; then, with Approve all, every message to draft
 * before the steps, else the steps before them. A message needs the person kept, and their chat or profile to send in.
 * A partner's steps (decision 81) come after the customers' of each sort: a like while it may like on its own, and
 * messages that each wait for an OK of their own.
 */
export function workLeft(
  list: Pick<TodayList, 'items' | 'auto' | 'messages' | 'sending'> & {
    readonly partners?: readonly TodayListItem[];
  },
  tried: readonly string[],
): Work[] {
  const done = new Set(tried);
  const steps = itemsLeft(list.items, list.auto, tried).map(
    (item) => ({ do: 'step', item }) as const,
  );
  const partners = list.partners ?? [];
  const partnerSteps = list.auto.includes('warm_up')
    ? partners
        .filter((item) => item.kind === 'partner_warm_up' && item.profileUrl !== null)
        .map((item) => ({ do: 'step', item }) as const)
    : [];
  const messages = [
    ...messagesOn(list.items, list.messages),
    ...messagesOn(partners, list.messages),
  ];
  const sends = messages
    .filter((item) => item.send?.state === 'approved')
    .map((item) => ({ do: 'send', item }) as const);
  const drafts = messages
    .filter((item) => item.send === null)
    .map((item) => ({ do: 'draft', item }) as const);
  const all: Work[] =
    list.sending === 'approve_all'
      ? [...sends, ...drafts, ...steps, ...partnerSteps]
      : [...sends, ...steps, ...partnerSteps, ...drafts];
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
 * Where a network's day stands for its runner (LinkedIn's, Instagram's and Alignable's, as Facebook's in ./run.ts;
 * decision 28, and the owner, 28 Oct 2026: "they should just start at the time selected in our settings"): after Start
 * my day there it goes now, at a person's pace, hours or not; with nothing pressed today it goes on its own in the
 * person's working hours, spread out over them; Stop for today, or a warning's stop, holds it for the rest of the
 * business's day, till the working hours of a later one. A press from another day changes nothing. `random` is from 0
 * to 1, for when in the first minutes it starts.
 */
export type NetworkDay =
  | { readonly go: true; readonly started: boolean; readonly until: number | null }
  | { readonly go: false; readonly stopped: string | null; readonly next: number | null };

export function networkDay(input: {
  /** The network's day as HandsFreeOS last said it (`days.<network>`); null when it hasn't. */
  readonly day: Pick<LiveDay, 'date' | 'state' | 'why'> | null;
  /** The business's day now. */
  readonly today: string;
  readonly hours: WorkingHours;
  readonly timeZone: string;
  readonly now: number;
  readonly random: number;
}): NetworkDay {
  const pressed = input.day?.date === input.today ? input.day : null;
  const next = () => nextStart(input.hours, input.timeZone, input.now, input.random);
  if (pressed?.state === 'stopped') {
    // Held for the rest of the business's day, whatever its hours: it starts again on a later one.
    const again = startAfterToday(input.hours, input.timeZone, input.today);
    const jitter = Math.round(input.random * START_JITTER_MS);
    return {
      go: false,
      stopped: pressed.why ?? 'person',
      next: again === null ? null : again + jitter,
    };
  }
  if (pressed?.state === 'started') return { go: true, started: true, until: null };
  const window = workWindow(input.hours, input.timeZone, input.now);
  if (window && input.now >= window.from && input.now < window.to)
    return { go: true, started: false, until: window.to };
  return { go: false, stopped: null, next: next() };
}

/**
 * What a network's runner says while its day waits: when it starts on its own (the hours' start, as Today shows it),
 * and that Start my day starts it now. `name` is the network's.
 */
export function networkWaitWords(
  name: string,
  wait: { readonly stopped: string | null },
  hours: WorkingHours,
  timeZone: string,
  now: number,
): string {
  const at = wait.stopped
    ? startAfterToday(hours, timeZone, businessDay(now, timeZone))
    : nextInHours(hours, timeZone, now);
  const when = at !== null && at > now ? startWords(at, timeZone, now) : null;
  if (wait.stopped)
    return when
      ? `Stopped on ${name} for today. It starts again on its own ${when}.`
      : `Stopped on ${name} for today.`;
  return when
    ? `Starts on its own on ${name} ${when}. To start now, press Start my day for ${name} on Today in HandsFreeOS.`
    : `Waiting for you to start your day on ${name}: press Start my day for ${name} on Today in HandsFreeOS.`;
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
