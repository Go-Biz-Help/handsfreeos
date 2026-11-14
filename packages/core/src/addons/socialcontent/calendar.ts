/**
 * The business's own posts and its calendar (HANDSFREEOS_CONTENT_CREATOR_IMPLEMENTATION_PLAN.md, "Making and posting
 * the business's own content", decisions 13 to 20; docs/socialcontent.md, "Making posts"): the plan in Settings (how
 * many posts a week on each network, and the time), the slots it makes in the next two weeks, and what a post needs
 * before it can be OK'd. The numbers live once, here, so the web, the phone and the worker agree.
 *
 * Browser-safe and pure.
 */
import { isClock, parseClock } from '../../calendar/engine/zoned';
import type { ContentNetwork } from './networks';

/**
 * The networks it writes posts for (part 8; Threads and X from decision 41); posting through the extension comes in
 * parts 9 and 10.
 */
export const POSTING_NETWORKS = ['instagram', 'facebook', 'linkedin', 'threads', 'x'] as const;
export type PostingNetwork = (typeof POSTING_NETWORKS)[number];
export const isPostingNetwork = (n: unknown): n is PostingNetwork =>
  typeof n === 'string' && (POSTING_NETWORKS as readonly string[]).includes(n);

/** What a post is: a picture, a carousel of slides, a video, or words alone (Facebook and LinkedIn only). */
export const CONTENT_FORMATS = ['photo', 'carousel', 'video', 'text'] as const;
export type ContentFormat = (typeof CONTENT_FORMATS)[number];

/**
 * The formats the AI writes: words with pictures, or words alone, never a video (the owner, 11 Nov). A video post is
 * only ever the person's own, when they pick Video on a post and add their video.
 */
export const AI_FORMATS = ['photo', 'carousel', 'text'] as const satisfies readonly ContentFormat[];
export type AiFormat = (typeof AI_FORMATS)[number];

/**
 * How its picture is made (decision 14): **designed** by Claude (words on it, in the business's colour), a
 * **photo**-style picture from OpenAI, or the person's **own**.
 */
export const PICTURE_WAYS = ['design', 'photo', 'own'] as const;
export type PictureWay = (typeof PICTURE_WAYS)[number];
export const PICTURE_STATES = ['none', 'waiting', 'making', 'made', 'failed'] as const;
export type PictureState = (typeof PICTURE_STATES)[number];

/** A draft waits for an OK; an OK'd one is ready; then it's posted (parts 9 and 10), or skipped. */
export const CONTENT_STATES = ['draft', 'ready', 'posting', 'posted', 'failed', 'skipped'] as const;
export type ContentState = (typeof CONTENT_STATES)[number];

/** Where a Facebook post goes (decision 17). */
export const FACEBOOK_WHERE = ['profile', 'page'] as const;
export type FacebookWhere = (typeof FACEBOOK_WHERE)[number];

/**
 * Where one post goes up on its network (part 9): Facebook's on the person's profile, the business's Page, or both
 * (decision 17); LinkedIn's and Instagram's (part 10) on the person's own feed.
 */
export const POST_PLACES = ['profile', 'page', 'feed'] as const;
export type PostPlace = (typeof POST_PLACES)[number];

/** Each place a post went up so far: its link when the network showed one, and when. */
export interface PostedTo {
  readonly place: PostPlace;
  readonly link: string | null;
  readonly at: string;
}

/** The places one post goes up, in the order the extension puts it up. */
export function placesFor(
  network: ContentNetwork,
  facebookWhere: readonly FacebookWhere[],
): PostPlace[] {
  if (network !== 'facebook') return ['feed'];
  const where = FACEBOOK_WHERE.filter((w) => facebookWhere.includes(w));
  return where.length ? where : ['profile'];
}

/** The places still to go: those it went up in already are never put up again. */
export function placesLeft(
  network: ContentNetwork,
  facebookWhere: readonly FacebookWhere[],
  postedTo: readonly Pick<PostedTo, 'place'>[],
): PostPlace[] {
  const done = new Set(postedTo.map((p) => p.place));
  return placesFor(network, facebookWhere).filter((p) => !done.has(p));
}

/**
 * Posting through the extension (parts 9 and 10). The extension posts on the networks its build can; HandsFreeOS hands
 * an OK'd post to the business's reading computer once its time comes.
 */
export const POSTING = {
  /**
   * The networks the extension posts on: Facebook and LinkedIn (part 9), Instagram (part 10), and Threads and X
   * (decision 41).
   */
  networks: ['facebook', 'linkedin', 'instagram', 'threads', 'x'] as readonly PostingNetwork[],
  /**
   * A post the computer took to put up that hasn't said how it went after this is marked as didn't post, and never
   * tried again on its own: it may have gone up.
   */
  postingForMs: 20 * 60_000,
  /** An OK'd post still waiting this long after its time is marked as didn't post: the posting computer wasn't on. */
  lateMs: 24 * 3_600_000,
  /**
   * The most characters each network takes in a post, hashtags and all: X's 280 is what a free account may post
   * (decision 41).
   */
  textMost: {
    instagram: 2_200,
    facebook: 60_000,
    linkedin: 3_000,
    threads: 500,
    x: 280,
  } as Readonly<Record<PostingNetwork, number>>,
} as const;

/**
 * Threads and X (decision 41): short posts, a picture about half the time, and now and then a chain of posts for a
 * longer tip (the first post, then up to 4 more under it, each within the network's characters). The first carries
 * the picture and the tags: one topic tag on Threads, 1 or 2 hashtags on X.
 */
export const SHORT_NETWORKS = ['threads', 'x'] as const satisfies readonly PostingNetwork[];
export type ShortNetwork = (typeof SHORT_NETWORKS)[number];
export const isShortNetwork = (n: unknown): n is ShortNetwork =>
  typeof n === 'string' && (SHORT_NETWORKS as readonly string[]).includes(n);

export const SHORT_POSTS = {
  /** The most posts under the first in a chain. */
  chainMost: 4,
  /** The most tags a post carries: Threads takes one topic. */
  tagsMost: { threads: 1, x: 2 } as Readonly<Record<ShortNetwork, number>>,
  /** Posts a week to suggest when the person turns one on (they start off). */
  suggestedPerWeek: 5,
} as const;

/** The posts under the first that a network takes: none but on Threads and X. */
export function chainFor(network: ContentNetwork, chain: readonly string[]): string[] {
  if (!isShortNetwork(network)) return [];
  const most = POSTING.textMost[network];
  return chain
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => (t.length > most ? `${t.slice(0, most - 1).trimEnd()}…` : t))
    .slice(0, SHORT_POSTS.chainMost);
}

/**
 * The most hashtags a network takes on a post. Instagram takes 5 since December 2025, and a caption with more goes up
 * without its words: the owner's first Instagram post from HandsFreeOS, with 10, went up with its picture alone
 * (14 Nov 2026). Threads takes one topic; X, 1 or 2 (decision 41).
 */
export const HASHTAGS_MOST: Readonly<Partial<Record<PostingNetwork, number>>> = {
  instagram: 5,
  ...SHORT_POSTS.tagsMost,
};

const tagsLine = (hashtags: readonly string[]) =>
  hashtags
    .map((t) => t.replace(/^#+/, '').trim())
    .filter(Boolean)
    .map((t) => `#${t}`)
    .join(' ');

/** Hashtags written into the words themselves. */
const tagsIn = (words: string): number => words.match(/(^|\s)#[\p{L}\p{N}_]+/gu)?.length ?? 0;

/** The hashtags that go up on the network with these words: as many as it takes, counting any in the words. */
export function tagsFor(
  network: PostingNetwork,
  words: string,
  hashtags: readonly string[],
): readonly string[] {
  const most = HASHTAGS_MOST[network];
  if (most === undefined) return hashtags;
  const kept = hashtags.filter((t) => t.replace(/^#+/, '').trim());
  return kept.slice(0, Math.max(0, most - tagsIn(words)));
}

/** How long a post's words and tags run as they go up: Threads and X count it (decision 41). */
export function postLength(words: string, hashtags: readonly string[]): number {
  const tags = tagsLine(hashtags);
  return words.trim().length + (tags ? tags.length + 2 : 0);
}

/**
 * The words as they go up: the post's words, then a blank line and its hashtags, each with its #, no more of them
 * than the network takes (`HASHTAGS_MOST`). Kept within what the network takes, cutting the words (never a hashtag
 * in half) when they'd run over.
 */
export function postText(
  network: PostingNetwork,
  words: string,
  hashtags: readonly string[],
): string {
  const tags = tagsLine(tagsFor(network, words, hashtags));
  const most = POSTING.textMost[network];
  const tail = tags ? `\n\n${tags}` : '';
  const room = Math.max(0, most - tail.length);
  const body =
    words.trim().length > room
      ? `${words
          .trim()
          .slice(0, Math.max(0, room - 1))
          .trimEnd()}…`
      : words.trim();
  return body ? `${body}${tail}`.slice(0, most) : tags.slice(0, most);
}

export const CALENDAR = {
  /** How far ahead it fills (decision 18). */
  days: 14,
  /**
   * The most posts in one day on one network, whoever picks the times (decision 21): more than that from one account
   * risks a network's limits.
   */
  perDayMost: 3,
  /** The most posts a week on one network: three a day. */
  perWeekMost: 21,
  /** A carousel's slides, and a post's pictures. */
  slidesMost: 10,
  picturesMost: 10,
  /** How often it fills on its own. */
  everyDays: 7,
  /** AI picks' hours are at least this far apart (decision 24). */
  windowLeastMinutes: 60,
} as const;

/** Each network's plan is one of these (decision 21): the AI picks the days and times, or the person does. */
export const PLAN_MODES = ['ai', 'mine'] as const;
export type PlanMode = (typeof PLAN_MODES)[number];

export interface NetworkPlan {
  /** **AI picks** (`ai`) or **I pick** (`mine`). */
  readonly mode: PlanMode;
  /** AI picks: posts a week, 0 to 21 (decision 22). */
  readonly perWeek: number;
  /** AI picks: the most in one day, 1 to 3; null spreads them out, one a day until there are more posts than days. */
  readonly perDay: number | null;
  /** AI picks: the hours it may post between, 'HH:MM' in the business's time zone (decision 24). */
  readonly from: string;
  readonly to: string;
  /** AI picks: the time it starts near while it has learned nothing (the plan's one time before 12 Nov). */
  readonly time: string;
  /** I pick: each weekday's times, Sunday first, soonest first; up to 3 a day. */
  readonly week: string[][];
}
/** The plan as kept in `settings.plan`: before 12 Nov each network held only `{ perWeek, time }`. */
export type CalendarPlan = Readonly<Partial<Record<PostingNetwork, Partial<NetworkPlan>>>>;

/** Which weekdays (0 is Sunday) a number of posts a week lands on: spread out, weekdays first. */
export const WEEKDAYS_FOR: Readonly<Record<number, readonly number[]>> = {
  0: [],
  1: [3],
  2: [2, 4],
  3: [1, 3, 5],
  4: [1, 2, 4, 5],
  5: [1, 2, 3, 4, 5],
  6: [1, 2, 3, 4, 5, 6],
  7: [0, 1, 2, 3, 4, 5, 6],
};

/** A week of times, Sunday first, from a number a week at one time, on the days WEEKDAYS_FOR spreads them over. */
export function weekOf(perWeek: number, time: string): string[][] {
  const days = WEEKDAYS_FOR[Math.max(0, Math.min(7, Math.round(perWeek)))] ?? [];
  return Array.from({ length: 7 }, (_, d) => (days.includes(d) ? [time] : []));
}

/** Posts a week on one network as its plan stands: the AI's number, or the times the person picked. */
export function postsAWeek(p: NetworkPlan): number {
  return p.mode === 'mine' ? p.week.reduce((n, d) => n + d.length, 0) : p.perWeek;
}

const aiPicks = (perWeek: number, time: string): NetworkPlan => ({
  mode: 'ai',
  perWeek,
  perDay: null,
  from: '07:00',
  to: '20:00',
  time,
  week: weekOf(perWeek, time),
});

/**
 * The plan until someone changes it: AI picks on each network, 3, 3 and 2 a week (the example the owner picked from on
 * 10 Nov), between 7 AM and 8 PM (decision 24). Switched to I pick, each starts from the days and time it had before.
 * Threads and X start off, at 0 a week, till the person turns them on (decision 41: 5 a week suggested).
 */
export const DEFAULT_PLAN: Readonly<Record<PostingNetwork, NetworkPlan>> = {
  instagram: aiPicks(3, '09:00'),
  facebook: aiPicks(3, '12:00'),
  linkedin: aiPicks(2, '08:00'),
  threads: aiPicks(0, '10:00'),
  x: aiPicks(0, '11:00'),
};

const clamp = (n: unknown, low: number, high: number, fallback: number): number =>
  typeof n === 'number' && Number.isFinite(n)
    ? Math.max(low, Math.min(high, Math.round(n)))
    : fallback;

const isTime = (v: unknown): v is string => typeof v === 'string' && isClock(v) && v !== '24:00';

/**
 * One network's plan as kept, each part checked, the fallback's where it says nothing usable. A plan kept before 12 Nov
 * (`{ perWeek, time }`) becomes AI picks with its number, starting near its time, with its days for I pick.
 */
export function networkPlanOf(raw: unknown, fallback: NetworkPlan): NetworkPlan {
  const p =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!p) return fallback;
  const perDay = !('perDay' in p)
    ? fallback.perDay
    : p['perDay'] === null
      ? null
      : clamp(p['perDay'], 1, CALENDAR.perDayMost, 1);
  const perWeek = Math.min(
    clamp(p['perWeek'], 0, CALENDAR.perWeekMost, fallback.perWeek),
    7 * (perDay ?? CALENDAR.perDayMost),
  );
  const time = isTime(p['time']) ? p['time'] : fallback.time;
  let from = isTime(p['from']) ? p['from'] : fallback.from;
  let to = isTime(p['to']) ? p['to'] : fallback.to;
  if (parseClock(to) - parseClock(from) < CALENDAR.windowLeastMinutes) {
    from = fallback.from;
    to = fallback.to;
  }
  const kept = p['week'];
  const week =
    Array.isArray(kept) && kept.length === 7
      ? kept.map((d: unknown) =>
          Array.isArray(d)
            ? [...new Set(d.filter(isTime))].sort().slice(0, CALENDAR.perDayMost)
            : [],
        )
      : 'week' in p
        ? fallback.week.map((d) => [...d])
        : weekOf(perWeek, time);
  return { mode: p['mode'] === 'mine' ? 'mine' : 'ai', perWeek, perDay, from, to, time, week };
}

/** The plan as kept (settings.plan): each posting network's, the default where it says nothing. */
export function planOf(raw: unknown): Record<PostingNetwork, NetworkPlan> {
  const kept = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {} as Record<PostingNetwork, NetworkPlan>;
  for (const n of POSTING_NETWORKS)
    out[n] = networkPlanOf((kept as Record<string, unknown>)[n], DEFAULT_PLAN[n]);
  return out;
}

/**
 * The format a network can take: Instagram always needs a picture or a video; Threads and X take one picture, never a
 * carousel of slides (decision 41).
 */
export function formatFor(network: ContentNetwork, format: ContentFormat): ContentFormat {
  if (network === 'instagram' && format === 'text') return 'photo';
  if (isShortNetwork(network) && format === 'carousel') return 'photo';
  return format;
}

/** Whether a format shows pictures (a video's cover is the network's to pick). */
export const hasPictures = (format: ContentFormat): boolean =>
  format === 'photo' || format === 'carousel';

export interface ReadyCheck {
  readonly network: ContentNetwork;
  readonly format: ContentFormat;
  readonly words: string;
  readonly slides: readonly unknown[];
  readonly fileIds: readonly string[];
  /** How many of its files are videos: a video post goes up with the person's own video (part 10). */
  readonly videos: number;
  readonly postAt: string | Date | number | null;
  readonly facebookWhere: readonly FacebookWhere[];
  /** The business's Facebook Page's link, when it has one (Settings → Posting). */
  readonly facebookPage?: string | null;
  /** Threads and X (decision 41): its tags and the posts under it, which must fit what the network takes. */
  readonly hashtags?: readonly string[];
  readonly chain?: readonly string[];
}

/**
 * What's still missing before a post can be OK'd, in words to show; null when nothing is. A video needs the person's
 * own video, recorded from the script and added to the post (part 10).
 */
export function stillNeeds(c: ReadyCheck): string | null {
  if (!c.words.trim() && c.format === 'text') return 'It has no words yet. Write them first.';
  if (isShortNetwork(c.network)) {
    const most = POSTING.textMost[c.network];
    const name = c.network === 'x' ? 'X' : 'Threads';
    if (postLength(c.words, c.hashtags ?? []) > most)
      return `Its words and tags run past the ${most} characters ${name} takes. Shorten them first.`;
    const long = (c.chain ?? []).findIndex((t) => t.trim().length > most);
    if (long >= 0)
      return `Post ${long + 2} in its chain runs past the ${most} characters ${name} takes. Shorten it first.`;
  }
  if (c.format === 'carousel' && c.slides.length < 2 && c.fileIds.length < 2)
    return 'A carousel needs at least 2 slides. Add slides or pictures first.';
  if (hasPictures(c.format) && c.fileIds.length === 0)
    return 'It has no picture yet. Make one, or add your own photo.';
  if (c.format === 'video' && c.videos === 0)
    return 'It has no video yet. Record it from the script, then add it with Add your video.';
  if (c.postAt === null) return 'It has no day to go yet. Pick when it goes first.';
  if (c.network === 'facebook' && c.facebookWhere.length === 0)
    return 'Pick where on Facebook it goes: your profile, your Page, or both.';
  if (c.network === 'facebook' && c.facebookWhere.includes('page') && !c.facebookPage)
    return 'Add your Facebook Page’s link in Settings → Posting first, or post it to your profile only.';
  return null;
}
