/**
 * What the extension has done, counted (docs/outreach.md, decision 140; Chris, 31 Oct 2026: "a counter of all the
 * activities it’s done that day, week, month. showing each platform and all together how many profiles it’s looked
 * at, posts, groups, etc etc. basically count everything it’s doing"), and the live ticker of what it's doing this
 * very second ("kind of like a ticker you see at the bottom of a tv screen").
 *
 * - **Counted as it's saved:** each thing the extension tells HandsFreeOS it did adds to the person's count for that
 *   day, network and kind (`addon_outreach.tallies`), in the same transaction as the save itself (./ops/tallies.ts
 *   `tally`). Nothing new is asked of the extension, so every build counts from the day this went live; counting
 *   started at zero then (answer 8a).
 * - **Only what it does on its own** (answer 2a): a like, comment, friend request or message the person took
 *   themselves, which the extension notes too, isn't counted; nor is a request they answered by hand.
 * - **In groups that open** (answer 1a): Reached out, Looked at, Groups, Tidied up and Written by the AI, each with a
 *   line for each kind, in each network's own words.
 * - **Today, This week and This month** (answer 3a): the week from Monday, the month from the 1st, on the business's
 *   calendar.
 * - **The ticker** (answers 5a and 6a): what the person's computer is doing now, then today's steps going past, along
 *   the bottom of every Social Outreach page on the web and the phone. While one is on screen it says so
 *   (`outreach.live.watch`), and the extension tells its line every few seconds instead of every 20, and HandsFreeOS
 *   passes it on at once instead of every 45 (`WATCHED_LINE_SECONDS`).
 *
 * Owners and admins see the team's counts, all together and person by person (answer 7a); the counts hold no names,
 * so that's all they see. Each person's ticker stays their own, as the feed always was. Browser-safe: the web and the
 * phone draw the counters and the ticker from these.
 */
import { z } from 'zod';
import { addDays, weekdayOf } from '../../calendar/engine/zoned';
import { fmtMonthDay } from '../../calendar/when';
import {
  clockWords,
  ComputerShown,
  isOffline,
  LiveStatus,
  LiveStep,
  offlineWords,
  startWords,
  type ShownState,
} from './live';
import { NETWORKS, PLATFORM_KEYS, type Platform } from './networks';

// ------------------------------------------------------------------------------------------------- what's counted

/** The groups the counts open from, in the order they show. */
export const TALLY_GROUPS = {
  reached: 'Reached out',
  looked: 'Looked at',
  groups: 'Groups',
  tidied: 'Tidied up',
  wrote: 'Written by the AI',
} as const;
export type TallyGroup = keyof typeof TALLY_GROUPS;
export const TALLY_GROUP_KEYS = Object.keys(TALLY_GROUPS) as [TallyGroup, ...TallyGroup[]];

/**
 * Each kind of thing counted: its group; whether its line shows even at 0 (`always`, the main ones, so a quiet day
 * still says what it watches for); and the networks it happens on, when only some.
 */
export const TALLY_KINDS = {
  friend_request: { group: 'reached', always: true },
  like: { group: 'reached', always: true },
  comment: { group: 'reached', always: true },
  message: { group: 'reached', always: true },
  recommend: { group: 'reached', on: ['alignable'] },
  accepted: { group: 'reached' },
  post_up: { group: 'reached' },
  profile: { group: 'looked', always: true },
  post: { group: 'looked', always: true },
  chat: { group: 'looked' },
  found: { group: 'looked' },
  listed: { group: 'looked' },
  occasion: { group: 'looked' },
  event: { group: 'looked', on: ['alignable'] },
  group: { group: 'groups' },
  joined: { group: 'groups' },
  member: { group: 'groups' },
  group_listed: { group: 'groups' },
  cancelled: { group: 'tidied' },
  unfriended: { group: 'tidied' },
  declined: { group: 'tidied' },
  drafted: { group: 'wrote' },
} as const satisfies Record<
  string,
  { group: TallyGroup; always?: boolean; on?: readonly Platform[] }
>;
export type TallyKind = keyof typeof TALLY_KINDS;
export const TALLY_KIND_KEYS = Object.keys(TALLY_KINDS) as [TallyKind, ...TallyKind[]];

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A kind's line, in a network's words ("Invitations to connect sent" on LinkedIn), or for all networks together when
 * it's null.
 */
export function tallyLabel(kind: TallyKind, platform: Platform | null): string {
  const w = platform ? NETWORKS[platform].words : null;
  switch (kind) {
    case 'friend_request':
      if (!w) return 'Friend requests and follows sent';
      return platform === 'instagram' ? 'Accounts followed' : `${cap(w.friendRequests)} sent`;
    case 'like':
      return 'Likes';
    case 'comment':
      return 'Comments';
    case 'message':
      return 'Messages sent';
    case 'recommend':
      return 'Recommendations';
    case 'accepted':
      return w && platform !== 'instagram'
        ? `${cap(w.friendRequests)} accepted`
        : 'Requests accepted';
    case 'post_up':
      return 'Posts put up';
    case 'profile':
      return 'Profiles looked at';
    case 'post':
      return 'Posts read';
    case 'chat':
      return 'Chats read';
    case 'found':
      return 'New people found';
    case 'listed':
      return w ? `People read from your ${w.friends} and requests` : 'People read from your lists';
    case 'occasion':
      return 'Birthdays and news found';
    case 'event':
      return 'Events looked at';
    case 'group':
      return 'Groups looked at';
    case 'joined':
      return 'Groups joined or asked to join';
    case 'member':
      return 'Group members read';
    case 'group_listed':
      return 'Groups read from your list';
    case 'cancelled':
      return platform === 'instagram' ? 'Follow requests taken back' : 'Old requests cancelled';
    case 'unfriended':
      if (!w) return 'Friends removed or unfollowed';
      return platform === 'instagram' ? 'Accounts unfollowed' : `${cap(w.friends)} removed`;
    case 'declined':
      return 'Requests turned down';
    case 'drafted':
      return 'Messages and comments drafted';
  }
}

/** Whether a kind happens on a network: every kind on all of them together. */
export const tallyOn = (kind: TallyKind, platform: Platform | null): boolean => {
  const on = (TALLY_KINDS[kind] as { on?: readonly Platform[] }).on;
  return !platform || !on || on.includes(platform);
};

// ------------------------------------------------------------------------------------------------- the stretches

/** The stretches the counters show, each ending today on the business's calendar. */
export const COUNT_PERIODS = {
  today: 'Today',
  week: 'This week',
  month: 'This month',
} as const;
export type CountPeriod = keyof typeof COUNT_PERIODS;
export const COUNT_PERIOD_KEYS = Object.keys(COUNT_PERIODS) as [CountPeriod, ...CountPeriod[]];

/** The first day of a stretch that ends `today`: today, the Monday of this week, or the 1st of this month. */
export function countPeriodStart(period: CountPeriod, today: string): string {
  if (period === 'today') return today;
  if (period === 'month') return `${today.slice(0, 8)}01`;
  // Monday is 1 and Sunday 0: a Sunday's week began six days before.
  return addDays(today, -((weekdayOf(today) + 6) % 7));
}

/** How long counts are kept: this month's and last year's same month, with room. */
export const TALLY_KEEP_DAYS = 400;

// ------------------------------------------------------------------------------------------------- operations

const count = z.number().int().min(0);

/** One count: how many of a kind on a network in the stretch. */
export const TallyCount = z.object({
  platform: z.enum(PLATFORM_KEYS),
  kind: z.enum(TALLY_KIND_KEYS),
  n: count,
});
export type TallyCount = z.output<typeof TallyCount>;

export const CountsInput = z.object({
  workspaceId: z.uuid(),
  period: z.enum(COUNT_PERIOD_KEYS).default('today'),
  /** Everyone's, for owners and admins (`outreach.manage`), all together and person by person. Left out: the person's own. */
  everyone: z.boolean().default(false),
});
export type CountsInput = z.input<typeof CountsInput>;

export const CountsOutput = z.object({
  timezone: z.string(),
  period: z.enum(COUNT_PERIOD_KEYS),
  /** The stretch's first day and today, on the business's calendar: "2026-10-26". */
  from: z.string(),
  to: z.string(),
  everyone: z.boolean(),
  /** The counts in the stretch: the person's, or everyone's added up. Only those above 0. */
  counts: z.array(TallyCount),
  /** Person by person, for everyone's; null for the person's own. */
  people: z
    .array(z.object({ userId: z.uuid(), name: z.string(), counts: z.array(TallyCount) }))
    .nullable(),
  /** The first day anything was counted for them, so a stretch from before then can say so; null before anything was. */
  since: z.string().nullable(),
});
export type CountsOutput = z.output<typeof CountsOutput>;

export const LiveWatchInput = z.object({ workspaceId: z.uuid() });
export type LiveWatchInput = z.input<typeof LiveWatchInput>;
export const LiveWatchOutput = z.object({
  /** Until when the person's computers tell what they're doing every few seconds. */
  until: z.iso.datetime(),
});

export const TickerInput = z.object({ workspaceId: z.uuid() });
export type TickerInput = z.input<typeof TickerInput>;
/**
 * What the ticker shows, lighter than the whole live view (`outreach.live`) since it's asked again every few seconds
 * while a computer works: the computer that works, what it said it's doing, and today's newest steps.
 */
export const TickerOutput = z.object({
  timezone: z.string(),
  now: z.iso.datetime(),
  computer: ComputerShown.nullable(),
  status: LiveStatus.nullable(),
  steps: z.array(LiveStep),
});
export type TickerOutput = z.output<typeof TickerOutput>;

// ------------------------------------------------------------------------------------------------- what's shown

export interface TallyRow {
  readonly kind: TallyKind;
  readonly label: string;
  readonly n: number;
}
export interface TallyGroupShown {
  readonly key: TallyGroup;
  readonly label: string;
  readonly total: number;
  /** Its lines: every kind with a count, and the main ones at 0 too. */
  readonly rows: readonly TallyRow[];
}
export interface TallyView {
  readonly total: number;
  readonly groups: readonly TallyGroupShown[];
}

/** The counts as the counters show them, for one network or all of them together (null). */
export function tallyView(counts: readonly TallyCount[], platform: Platform | null): TallyView {
  const of = new Map<TallyKind, number>();
  for (const c of counts)
    if (!platform || c.platform === platform) of.set(c.kind, (of.get(c.kind) ?? 0) + c.n);
  const groups = TALLY_GROUP_KEYS.map((key) => {
    const rows = TALLY_KIND_KEYS.filter((k) => TALLY_KINDS[k].group === key)
      .filter((k) => tallyOn(k, platform))
      .map((kind) => ({ kind, label: tallyLabel(kind, platform), n: of.get(kind) ?? 0 }))
      .filter((r) => r.n > 0 || (TALLY_KINDS[r.kind] as { always?: boolean }).always === true);
    return {
      key,
      label: TALLY_GROUPS[key],
      total: rows.reduce((sum, r) => sum + r.n, 0),
      rows,
    };
  });
  return { total: groups.reduce((sum, g) => sum + g.total, 0), groups };
}

/** The networks to pick from on the counters: those the person works, then any other with counts, in the usual order. */
export function tallyNetworks(
  counts: readonly TallyCount[],
  working: readonly Platform[],
): Platform[] {
  const counted = new Set(counts.filter((c) => c.n > 0).map((c) => c.platform));
  return PLATFORM_KEYS.filter((p) => working.includes(p) || counted.has(p));
}

/** "1,204". */
export const countWords = (n: number): string => n.toLocaleString('en-US');

/** The words around the counters. */
export const COUNTER_WORDS = {
  title: 'What it’s done',
  about: 'Everything the extension did on its own, counted as it goes.',
  all: 'All networks',
  you: 'You',
  team: 'Your team',
  person: 'Each person',
  nothing: 'Nothing yet.',
  /** The total, after the number: "312 things". */
  things: (n: number) => (n === 1 ? 'thing' : 'things'),
  noneToday:
    'Nothing counted yet today. It counts as the extension works, in your working hours or when you press Start my day.',
  noneStretch: (period: CountPeriod) =>
    `Nothing counted ${period === 'week' ? 'this week' : 'this month'} yet.`,
  failed: 'Couldn’t load the counts. They try again in a moment.',
} as const;

/**
 * A stretch that started before counting did says so: "Counted since Oct 31." Empty when counting started before it,
 * or when nothing's been counted.
 */
export function countedSinceWords(out: Pick<CountsOutput, 'from' | 'since' | 'to'>): string {
  if (!out.since || out.since <= out.from) return '';
  return `Counted since ${fmtMonthDay(out.since, Number(out.to.slice(0, 4)))}.`;
}

// ------------------------------------------------------------------------------------------------- the ticker

/** While a ticker is on screen it says so this often, and the extension tells fast for this long after. */
export const WATCH_EVERY_SECONDS = 60;
export const WATCH_SECONDS = 90;
/** How often a line alone is sent and passed on while a ticker is on screen, instead of every 20 and 45 seconds. */
export const WATCHED_LINE_SECONDS = 4;
/** Today's steps the ticker carries, the newest first. */
export const TICKER_STEPS = 12;
/**
 * How often the phone asks again for the ticker and the counters while they're on screen: it hears nothing live, so
 * it asks. The web asks each time the computer says something, and every minute.
 */
export const TICKER_ASK_SECONDS = 5;
/** How fast the ticker's words go past, in pixels a second, and its shortest loop. */
export const TICKER_PIXELS_PER_SECOND = 60;
export const TICKER_SHORTEST_SECONDS = 20;

/** The ticker's lead: what the person's computer is doing now, and how it's going. */
export interface TickerHead {
  readonly state: ShownState;
  /** Working: the live dot moves. Paused or offline: it needs a look. */
  readonly tone: 'live' | 'quiet' | 'warn';
  readonly words: string;
}

export interface Ticker {
  readonly head: TickerHead;
  /** Today's steps, the newest first: "2:14 PM  Sent a friend request to Dana Cole". */
  readonly steps: readonly { readonly at: string; readonly line: string }[];
  /** No steps today yet. */
  readonly empty: string;
}

export const TICKER_WORDS = {
  live: 'Live',
  label: 'What it’s doing now',
  pause: 'Pause',
  play: 'Play',
  empty: 'Nothing done yet today.',
  today: 'See today’s steps',
} as const;

/** What the ticker says, from what HandsFreeOS knows of the person's computer (`outreach.ticker`). */
export function tickerOf(
  live: Pick<TickerOutput, 'computer' | 'status' | 'timezone' | 'steps'>,
  now: number,
): Ticker {
  const c = live.computer;
  // The computer's own word on how it's going, every network's together: one network's day stopped while another's
  // goes still shows the one going.
  const state: ShownState = !c
    ? 'none'
    : c.state === 'signed_out'
      ? 'signed_out'
      : isOffline(c.lastSeenAt, now)
        ? 'offline'
        : c.state;
  const line = live.status?.line ?? null;
  const nextAt = live.status?.nextAt ? new Date(live.status.nextAt).getTime() : null;
  // "at 2:14 PM" today, "tomorrow at 9:00 AM" after.
  const next = nextAt !== null && nextAt > now ? startWords(nextAt, live.timezone, now) : null;
  const words = ((): string => {
    switch (state) {
      case 'none':
        return 'No computer yet: once the extension is on yours, what it does shows here.';
      case 'signed_out':
        return 'The extension is signed out. Sign in from its panel in Chrome.';
      case 'offline':
        return offlineWords(c!.lastSeenAt, live.timezone, now);
      case 'stopped':
        return line ?? 'Stopped for today.';
      case 'off':
        return 'Not working on its own: Sending is off in Settings.';
      case 'standby':
        return 'Standing by: another computer of yours is working.';
      case 'working':
        return line ? `Now: ${line}` : 'Working…';
      case 'waiting':
        if (line && next) return `${line} Next step ${next}.`;
        return line ?? (next ? `Waiting for the next step ${next}.` : 'Waiting for the next step.');
      case 'trouble':
        return line ? `Paused: ${line}` : 'Paused.';
      case 'idle':
        return line ?? 'Nothing to do right now.';
    }
  })();
  const tone: TickerHead['tone'] =
    state === 'working'
      ? 'live'
      : state === 'offline' || state === 'trouble' || state === 'signed_out'
        ? 'warn'
        : 'quiet';
  return {
    head: { state, tone, words },
    steps: live.steps
      .slice(0, TICKER_STEPS)
      .map((s) => ({ at: clockWords(s.at, live.timezone), line: s.line })),
    empty: TICKER_WORDS.empty,
  };
}

/** How long the ticker's words take to go past once: longer words, slower loop, never too fast to read. */
export const tickerSeconds = (widthPx: number): number =>
  Math.max(TICKER_SHORTEST_SECONDS, Math.round(widthPx / TICKER_PIXELS_PER_SECOND));
