/**
 * The business's own posts and its calendar (HANDSFREEOS_CONTENT_CREATOR_IMPLEMENTATION_PLAN.md, "Making and posting
 * the business's own content", decisions 13 to 20; docs/socialcontent.md, "Making posts"): the plan in Settings (how
 * many posts a week on each network, and the time), the slots it makes in the next two weeks, and what a post needs
 * before it can be OK'd. The numbers live once, here, so the web, the phone and the worker agree.
 *
 * Browser-safe and pure.
 */
import {
  addDays,
  isClock,
  localDateOf,
  localInstant,
  weekdayOf,
} from '../../calendar/engine/zoned';
import type { ContentNetwork } from './networks';

/** The networks it writes posts for (part 8); posting through the extension comes in parts 9 and 10. */
export const POSTING_NETWORKS = ['instagram', 'facebook', 'linkedin'] as const;
export type PostingNetwork = (typeof POSTING_NETWORKS)[number];
export const isPostingNetwork = (n: unknown): n is PostingNetwork =>
  typeof n === 'string' && (POSTING_NETWORKS as readonly string[]).includes(n);

/** What a post is: a picture, a carousel of slides, a video, or words alone (Facebook and LinkedIn only). */
export const CONTENT_FORMATS = ['photo', 'carousel', 'video', 'text'] as const;
export type ContentFormat = (typeof CONTENT_FORMATS)[number];

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

export const CALENDAR = {
  /** How far ahead it fills (decision 18). */
  days: 14,
  /** At most one post a day on each network. */
  perWeekMost: 7,
  /** A carousel's slides, and a post's pictures. */
  slidesMost: 10,
  picturesMost: 10,
  /** How often it fills on its own. */
  everyDays: 7,
} as const;

export interface NetworkPlan {
  /** Posts a week, 0 to 7. */
  readonly perWeek: number;
  /** 'HH:MM' in the business's time zone. */
  readonly time: string;
}
export type CalendarPlan = Readonly<Partial<Record<PostingNetwork, NetworkPlan>>>;

/** The plan until someone changes it: the example in the plan Chris picked from (Instagram 3, Facebook 3, LinkedIn 2). */
export const DEFAULT_PLAN: Readonly<Record<PostingNetwork, NetworkPlan>> = {
  instagram: { perWeek: 3, time: '09:00' },
  facebook: { perWeek: 3, time: '12:00' },
  linkedin: { perWeek: 2, time: '08:00' },
};

const clamp = (n: unknown, low: number, high: number, fallback: number): number =>
  typeof n === 'number' && Number.isFinite(n)
    ? Math.max(low, Math.min(high, Math.round(n)))
    : fallback;

/** The plan as kept (settings.plan): each posting network's, the default where it says nothing. */
export function planOf(raw: unknown): Record<PostingNetwork, NetworkPlan> {
  const kept = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {} as Record<PostingNetwork, NetworkPlan>;
  for (const n of POSTING_NETWORKS) {
    const one = (kept as Record<string, unknown>)[n];
    const p = one && typeof one === 'object' ? (one as Record<string, unknown>) : null;
    out[n] = p
      ? {
          perWeek: clamp(p['perWeek'], 0, CALENDAR.perWeekMost, DEFAULT_PLAN[n].perWeek),
          time:
            typeof p['time'] === 'string' && isClock(p['time']) && p['time'] !== '24:00'
              ? p['time']
              : DEFAULT_PLAN[n].time,
        }
      : DEFAULT_PLAN[n];
  }
  return out;
}

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

export interface Slot {
  readonly network: PostingNetwork;
  /** The local date, YYYY-MM-DD. */
  readonly date: string;
  /** When it goes, as an instant. */
  readonly at: number;
}

/**
 * The plan's slots from tomorrow through the next two weeks, in the business's time zone, soonest first. Today is
 * left out: a post written now still needs an OK before it goes.
 */
export function slotsAhead(
  plan: Readonly<Record<PostingNetwork, NetworkPlan>>,
  timeZone: string,
  now: number,
  days: number = CALENDAR.days,
): Slot[] {
  const today = localDateOf(now, timeZone);
  const out: Slot[] = [];
  for (let d = 1; d <= days; d++) {
    const date = addDays(today, d);
    const weekday = weekdayOf(date);
    for (const network of POSTING_NETWORKS) {
      const p = plan[network];
      if (!(WEEKDAYS_FOR[p.perWeek] ?? []).includes(weekday)) continue;
      out.push({ network, date, at: localInstant(date, p.time, timeZone) });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The slots with no post on that network that day yet (a skipped one leaves the day open). */
export function emptySlots(
  slots: readonly Slot[],
  taken: readonly { network: ContentNetwork; postAt: number | Date | null; state: ContentState }[],
  timeZone: string,
): Slot[] {
  const busy = new Set(
    taken
      .filter((t) => t.postAt !== null && t.state !== 'skipped')
      .map((t) => `${t.network}:${localDateOf(Number(t.postAt), timeZone)}`),
  );
  return slots.filter((s) => !busy.has(`${s.network}:${s.date}`));
}

/** The format a network can take: Instagram always needs a picture or a video. */
export function formatFor(network: ContentNetwork, format: ContentFormat): ContentFormat {
  return network === 'instagram' && format === 'text' ? 'photo' : format;
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
  readonly postAt: string | Date | number | null;
  readonly facebookWhere: readonly FacebookWhere[];
  /** The business's Facebook Page's link, when it has one (Settings → Posting). */
  readonly facebookPage?: string | null;
}

/**
 * What's still missing before a post can be OK'd, in words to show; null when nothing is. A video needs no file yet:
 * the person records it from the script, and adding it comes with posting it (part 10).
 */
export function stillNeeds(c: ReadyCheck): string | null {
  if (!c.words.trim() && c.format === 'text') return 'It has no words yet. Write them first.';
  if (c.format === 'carousel' && c.slides.length < 2 && c.fileIds.length < 2)
    return 'A carousel needs at least 2 slides. Add slides or pictures first.';
  if (hasPictures(c.format) && c.fileIds.length === 0)
    return 'It has no picture yet. Make one, or add your own photo.';
  if (c.postAt === null) return 'It has no day to go yet. Pick when it goes first.';
  if (c.network === 'facebook' && c.facebookWhere.length === 0)
    return 'Pick where on Facebook it goes: your profile, your Page, or both.';
  if (c.network === 'facebook' && c.facebookWhere.includes('page') && !c.facebookPage)
    return 'Add your Facebook Page’s link in Settings → Posting first, or post it to your profile only.';
  return null;
}
