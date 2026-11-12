/**
 * When the business's own posts go (HANDSFREEOS_CONTENT_CREATOR_IMPLEMENTATION_PLAN.md, decisions 21 to 27;
 * docs/socialcontent.md, "The schedule"): the plan's open slots over the next two weeks, the hours AI picks posts at,
 * and what it learned about the hours from the creators' posts and then the business's own.
 *
 * - **I pick** puts a post at each time the person ticked on each day.
 * - **AI picks** spreads the week's posts over its days, then puts each at the best hour it knows between the plan's
 *   hours, and about 1 in 5 at the hour it knows least about, so it keeps learning (decision 26).
 * - **What it learned** is each hour's average "times its normal" (decision 23): views where the network shows them,
 *   otherwise likes plus comments, against the normal around it. Before its own posts tell, the creators' best posts'
 *   hours lead (decision 25); from 10 of its own posts with numbers on a network, only its own count there.
 *
 * Everything is worked out again from the posts each time, so the web, the phone and the worker agree, and the same
 * day gives the same hours. Pure and browser-safe.
 */
import {
  addDays,
  localDateOf,
  localInstant,
  parseClock,
  weekdayOf,
  zonedParts,
} from '../../calendar/engine/zoned';
import {
  CALENDAR,
  POSTING_NETWORKS,
  WEEKDAYS_FOR,
  type ContentState,
  type NetworkPlan,
  type PostedTo,
  type PostingNetwork,
} from './calendar';
import type { ContentNetwork } from './networks';
import { firstUp, hasNumbers, type OwnNumbers, type OwnNumbersRead } from './own';

export const SCHEDULE = {
  /** About 1 in this many of the AI's times is the hour it knows least about (decision 26). */
  tryEvery: 5,
  /** On a day with more than one post, the AI's hours are this far apart when the plan's hours have room. */
  gapHours: 2,
  /** Its own posts with numbers on a network before the creators' hours stop counting there (decision 25). */
  ownEnough: 10,
  /** One of its own posts counts as much as this many of the creators'. */
  ownWeight: 3,
  /** The creators' posts on the same network it needs before the others' are left out. */
  sameNetworkEnough: 20,
  /** An hour is trusted once this much went up in it (a post at an hour next to it counts half). */
  trustWeight: 2,
  /**
   * Each hour starts as if one post did its normal there (1 times), so an hour with little to go on stays near normal
   * and the hour the posts went up at leads the ones beside it.
   */
  priorWeight: 1,
  /** The most times its normal one post counts for, so one post that took off doesn't decide alone. */
  timesMost: 5,
  /** How many of its own latest posts make its normal, and how few will do. */
  normalOf: 30,
  normalLeast: 3,
  /** A post going up sooner than this is never moved to a better time: the computer may be putting it up. */
  moveLeadMs: 30 * 60_000,
} as const;

/** Where the AI's hours come from now. */
export const TIMES_FROM = ['own', 'both', 'creators', 'none'] as const;
export type TimesFrom = (typeof TIMES_FROM)[number];

/** What it learned about the hours of the day on one network, in the business's time zone. */
export interface NetworkTimes {
  /** Each hour's average times-its-normal, 0 to 23; null where too little went up to tell. */
  readonly hours: readonly (number | null)[];
  /** How many posts it learned from went up in each hour. */
  readonly counts: readonly number[];
  /** How many of its own posts, and of the creators', it learned from. */
  readonly own: number;
  readonly creators: number;
  readonly from: TimesFrom;
}
export type LearnedTimes = Readonly<Partial<Record<PostingNetwork, NetworkTimes>>>;

/** One post it learns from: when it went up, and how many times its normal it did. */
export interface TimeSample {
  readonly network: string;
  readonly at: number;
  readonly times: number;
  readonly own: boolean;
}

const hourOf = (at: number, timeZone: string) => zonedParts(at, timeZone).hour;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** What the posts say about each hour on each posting network (decisions 23 and 25). */
export function learnTimes(samples: readonly TimeSample[], timeZone: string): LearnedTimes {
  const creatorsAll = samples.filter((s) => !s.own);
  const out: Partial<Record<PostingNetwork, NetworkTimes>> = {};
  for (const n of POSTING_NETWORKS) {
    const own = samples.filter((s) => s.own && s.network === n);
    const same = creatorsAll.filter((s) => s.network === n);
    const creators = same.length >= SCHEDULE.sameNetworkEnough ? same : creatorsAll;
    const withCreators = own.length < SCHEDULE.ownEnough;
    const used: [TimeSample, number][] = [
      ...own.map((s): [TimeSample, number] => [s, SCHEDULE.ownWeight]),
      ...(withCreators ? creators.map((s): [TimeSample, number] => [s, 1]) : []),
    ];
    const sum = Array<number>(24).fill(0);
    const weight = Array<number>(24).fill(0);
    const counts = Array<number>(24).fill(0);
    for (const [s, w] of used) {
      if (!Number.isFinite(s.at) || !Number.isFinite(s.times)) continue;
      const h = hourOf(s.at, timeZone);
      const times = Math.max(0, Math.min(SCHEDULE.timesMost, s.times));
      counts[h]!++;
      for (const d of [-1, 0, 1]) {
        const k = (h + d + 24) % 24;
        const f = d === 0 ? 1 : 0.5;
        sum[k]! += w * f * times;
        weight[k]! += w * f;
      }
    }
    out[n] = {
      hours: weight.map((wt, k) =>
        wt >= SCHEDULE.trustWeight
          ? round2((sum[k]! + SCHEDULE.priorWeight) / (wt + SCHEDULE.priorWeight))
          : null,
      ),
      counts,
      own: own.length,
      creators: withCreators ? creators.length : 0,
      from:
        own.length && withCreators && creators.length
          ? 'both'
          : own.length
            ? 'own'
            : creators.length
              ? 'creators'
              : 'none',
    };
  }
  return out;
}

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** The number a read counts by (decision 23): views where the network showed them, otherwise likes plus comments. */
function activityOf(r: OwnNumbersRead): { on: 'views' | 'engagement'; value: number } | null {
  if (!hasNumbers(r)) return null;
  if (r.views !== null) return { on: 'views', value: r.views };
  if (r.likes === null && r.comments === null) return null;
  return { on: 'engagement', value: (r.likes ?? 0) + (r.comments ?? 0) };
}

/** One of the business's own posts that went up, with its numbers. */
export interface OwnPostTimes {
  readonly network: string;
  readonly postedTo: readonly PostedTo[];
  readonly numbers: OwnNumbers;
}

/**
 * The business's own posts as posts to learn from: each place's latest read (7 days, else 2) against the middle of
 * the same read of its own latest posts in that place, on the same number; a post's times is its places' average.
 * Newest first in, as the normal is its latest posts'.
 */
export function ownSamples(posts: readonly OwnPostTimes[]): TimeSample[] {
  type One = { post: number; key: string; value: number };
  const ones: One[] = [];
  posts.forEach((p, i) => {
    for (const place of p.postedTo) {
      const reads = p.numbers[place.place];
      const read = reads?.d7 && hasNumbers(reads.d7) ? 'd7' : 'd2';
      const r = reads?.[read];
      const a = r ? activityOf(r) : null;
      if (a)
        ones.push({ post: i, key: `${p.network}|${place.place}|${read}|${a.on}`, value: a.value });
    }
  });
  const normal = new Map<string, number>();
  for (const key of new Set(ones.map((o) => o.key))) {
    const latest = ones.filter((o) => o.key === key).slice(0, SCHEDULE.normalOf);
    if (latest.length >= SCHEDULE.normalLeast) normal.set(key, median(latest.map((o) => o.value)));
  }
  const out: TimeSample[] = [];
  posts.forEach((p, i) => {
    const ratios = ones
      .filter((o) => o.post === i && (normal.get(o.key) ?? 0) > 0)
      .map((o) => o.value / normal.get(o.key)!);
    const at = firstUp(p.postedTo);
    if (ratios.length && at !== null)
      out.push({
        network: p.network,
        at,
        times: ratios.reduce((a, b) => a + b, 0) / ratios.length,
        own: true,
      });
  });
  return out;
}

/** The whole hours AI picks may post at on a network (decision 24), soonest first. */
export function windowHours(plan: Pick<NetworkPlan, 'from' | 'to'>): number[] {
  const first = Math.ceil(parseClock(plan.from) / 60);
  const last = Math.min(23, Math.floor(parseClock(plan.to) / 60));
  const out: number[] = [];
  for (let h = first; h <= last; h++) out.push(h);
  return out.length ? out : [Math.min(23, first)];
}

/** The plan's hours, best first: the ones it trusts by how they did, then the rest nearest the plan's time. */
export function rankedHours(plan: NetworkPlan, times: NetworkTimes | undefined): number[] {
  const hours = windowHours(plan);
  const near = Math.max(hours[0]!, Math.min(hours.at(-1)!, parseClock(plan.time) / 60));
  const score = (h: number) => times?.hours[h] ?? null;
  return [...hours].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    if (sa !== null && sb !== null && sa !== sb) return sb - sa;
    if (sa !== null && sb === null) return -1;
    if (sa === null && sb !== null) return 1;
    return Math.abs(a - near) - Math.abs(b - near) || a - b;
  });
}

/** A number from words that's the same every time, so the same day picks the same hours on the web and the worker. */
export function seedOf(words: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < words.length; i++) {
    h ^= words.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** One hour the AI picked for a post, and whether it's an hour it's trying out to keep learning. */
export interface PickedTime {
  readonly time: string;
  readonly trying: boolean;
}

const clockOfHour = (h: number) => `${String(h).padStart(2, '0')}:00`;

/**
 * The AI's hours for `count` posts on one network on one day, around the hours already taken that day: the best it
 * knows, apart from each other when the plan's hours have room; and about 1 in 5 the hour it knows least about
 * (decision 26). `first` is how many posts that day came before them, so the same post keeps the same hour.
 */
export function timesFor(
  network: PostingNetwork,
  date: string,
  plan: NetworkPlan,
  times: NetworkTimes | undefined,
  count: number,
  taken: readonly number[] = [],
  first = taken.length,
): PickedTime[] {
  const ranked = rankedHours(plan, times);
  const used = [...taken];
  const out: PickedTime[] = [];
  for (let i = 0; i < count; i++) {
    const seed = seedOf(`${network}:${date}:${first + i}`);
    let hour: number | null = null;
    let trying = false;
    if (seed % SCHEDULE.tryEvery === 0) {
      const pool = ranked.slice(1).filter((h) => !used.includes(h));
      if (pool.length) {
        const least = Math.min(...pool.map((h) => times?.counts[h] ?? 0));
        const fewest = pool.filter((h) => (times?.counts[h] ?? 0) === least);
        hour = fewest[Math.floor(seed / SCHEDULE.tryEvery) % fewest.length]!;
        trying = true;
      }
    }
    hour ??=
      ranked.find(
        (h) => !used.includes(h) && used.every((u) => Math.abs(u - h) >= SCHEDULE.gapHours),
      ) ??
      ranked.find((h) => !used.includes(h)) ??
      ranked[0]!;
    used.push(hour);
    out.push({ time: clockOfHour(hour), trying });
  }
  return out;
}

export interface Slot {
  readonly network: PostingNetwork;
  /** The local date, YYYY-MM-DD. */
  readonly date: string;
  /** When it goes, as an instant. */
  readonly at: number;
  /** An hour AI picks is trying out, to keep learning (decision 26). */
  readonly trying: boolean;
}

/** A post already on the calendar: a skipped one leaves its place open. */
export interface TakenPost {
  readonly network: ContentNetwork | string;
  readonly postAt: number | Date | string | null;
  readonly state: ContentState;
}

interface Busy {
  readonly network: string;
  readonly date: string;
  /** Minutes past midnight, in the business's time zone. */
  readonly minutes: number;
}

const instant = (t: number | Date | string) =>
  t instanceof Date ? t.getTime() : typeof t === 'number' ? t : Date.parse(t);

function busyOf(taken: readonly TakenPost[], timeZone: string): Busy[] {
  return taken.flatMap((t) => {
    if (t.postAt === null || t.state === 'skipped') return [];
    const at = instant(t.postAt);
    if (!Number.isFinite(at)) return [];
    const p = zonedParts(at, timeZone);
    return [
      { network: t.network, date: localDateOf(at, timeZone), minutes: p.hour * 60 + p.minute },
    ];
  });
}

/** How many posts AI picks puts on each weekday (0 is Sunday): spread out, weekdays first, then two a day and so on. */
export function perWeekday(perWeek: number): number[] {
  const base = Math.floor(perWeek / 7);
  const extra = WEEKDAYS_FOR[perWeek - base * 7] ?? [];
  return Array.from({ length: 7 }, (_, d) => base + (extra.includes(d) ? 1 : 0));
}

/** The Monday a date's week starts on. */
export const mondayOf = (date: string): string => addDays(date, -((weekdayOf(date) + 6) % 7));

/**
 * The plan's open slots from tomorrow through the next two weeks, in the business's time zone, soonest first. Today
 * is left out: a post written now still needs an OK before it goes.
 *
 * - **I pick:** each time ticked on each day, less one for each post that day (the nearest time).
 * - **AI picks:** each week (Monday to Sunday) gets its posts a week, spread over its days; each post already in that
 *   week takes the place of the nearest spread day's, so a post moved by hand isn't written again; spread days already
 *   past are let go. Each open one gets the AI's hour for that day.
 */
export function openSlots(input: {
  readonly plan: Readonly<Record<PostingNetwork, NetworkPlan>>;
  readonly times: LearnedTimes;
  readonly taken: readonly TakenPost[];
  readonly timeZone: string;
  readonly now: number;
  readonly days?: number;
}): Slot[] {
  const { plan, times, timeZone } = input;
  const days = input.days ?? CALENDAR.days;
  const today = localDateOf(input.now, timeZone);
  const first = addDays(today, 1);
  const last = addDays(today, days);
  const busy = busyOf(input.taken, timeZone);
  const out: Slot[] = [];
  for (const network of POSTING_NETWORKS) {
    const p = plan[network];
    const mine = busy.filter((b) => b.network === network);
    if (p.mode === 'mine') {
      for (let d = 1; d <= days; d++) {
        const date = addDays(today, d);
        const left = [...(p.week[weekdayOf(date)] ?? [])].map(parseClock);
        for (const b of mine.filter((x) => x.date === date)) {
          if (!left.length) break;
          let at = 0;
          left.forEach((m, i) => {
            if (Math.abs(m - b.minutes) < Math.abs(left[at]! - b.minutes)) at = i;
          });
          left.splice(at, 1);
        }
        for (const m of left) {
          const clock = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
          out.push({ network, date, at: localInstant(date, clock, timeZone), trying: false });
        }
      }
      continue;
    }
    if (p.perWeek <= 0) continue;
    const spread = perWeekday(p.perWeek);
    for (let week = mondayOf(first); week <= last; week = addDays(week, 7)) {
      const dates = Array.from({ length: 7 }, (_, i) => addDays(week, i));
      const left = dates.map((date) => spread[weekdayOf(date)]!);
      for (const b of mine
        .filter((x) => x.date >= dates[0]! && x.date <= dates[6]!)
        .sort((a, b) => a.date.localeCompare(b.date) || a.minutes - b.minutes)) {
        const i = dates.indexOf(b.date);
        let at = -1;
        for (let j = 0; j < 7; j++)
          if (left[j]! > 0 && (at < 0 || Math.abs(j - i) < Math.abs(at - i))) at = j;
        if (at >= 0) left[at]!--;
      }
      dates.forEach((date, i) => {
        if (date < first || date > last || left[i]! <= 0) return;
        const taken = mine.filter((x) => x.date === date).map((x) => Math.floor(x.minutes / 60));
        for (const t of timesFor(network, date, p, times[network], left[i]!, taken))
          out.push({
            network,
            date,
            at: localInstant(date, t.time, timeZone),
            trying: t.trying,
          });
      });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** A post on the calendar that AI picks may move: who set its time, and its state. */
export interface MovablePost extends TakenPost {
  readonly id: string;
  /** Whether the AI set its time (when it wrote it into a slot) or a person did. */
  readonly placedBy: 'ai' | 'person';
}

/**
 * Where AI picks' posts that haven't gone up belong now (decision 27): on each day, the posts the AI placed get the
 * AI's hours for that day, around the ones a person placed or that are going up. OK'd ones move too; a post a person
 * set the time of never does, nor one going up within half an hour. Only those whose time changes.
 */
export function movesFor(input: {
  readonly plan: Readonly<Record<PostingNetwork, NetworkPlan>>;
  readonly times: LearnedTimes;
  readonly posts: readonly MovablePost[];
  readonly timeZone: string;
  readonly now: number;
}): { id: string; from: number; to: number }[] {
  const { plan, times, timeZone, now } = input;
  const soon = now + SCHEDULE.moveLeadMs;
  const out: { id: string; from: number; to: number }[] = [];
  for (const network of POSTING_NETWORKS) {
    const p = plan[network];
    if (p.mode !== 'ai') continue;
    const on = input.posts.filter(
      (x) => x.network === network && x.postAt !== null && x.state !== 'skipped',
    );
    const movable = (x: MovablePost) =>
      x.placedBy === 'ai' &&
      (x.state === 'draft' || x.state === 'ready') &&
      instant(x.postAt!) > soon;
    const byDay = new Map<string, MovablePost[]>();
    for (const x of on) {
      const date = localDateOf(instant(x.postAt!), timeZone);
      byDay.set(date, [...(byDay.get(date) ?? []), x]);
    }
    for (const [date, all] of byDay) {
      const moving = all.filter(movable).sort((a, b) => instant(a.postAt!) - instant(b.postAt!));
      if (!moving.length) continue;
      const fixed = all
        .filter((x) => !movable(x))
        .map((x) => zonedParts(instant(x.postAt!), timeZone).hour);
      const picked = timesFor(network, date, p, times[network], moving.length, fixed)
        .map((t) => localInstant(date, t.time, timeZone))
        .sort((a, b) => a - b);
      moving.forEach((x, i) => {
        const to = picked[i]!;
        const from = instant(x.postAt!);
        if (to !== from && to > soon) out.push({ id: x.id, from, to });
      });
    }
  }
  return out;
}

/** What AI picks learned on a network, in a few facts the pages show: its best hours between the plan's, and from what. */
export interface LearnedShown {
  /** Up to 3 best hours it trusts, 'HH:00', best first. */
  readonly best: string[];
  readonly from: TimesFrom;
  readonly own: number;
  readonly creators: number;
}

export function learnedShown(
  plan: Readonly<Record<PostingNetwork, NetworkPlan>>,
  times: LearnedTimes,
): Record<PostingNetwork, LearnedShown> {
  const out = {} as Record<PostingNetwork, LearnedShown>;
  for (const n of POSTING_NETWORKS) {
    const t = times[n];
    out[n] = {
      best: rankedHours(plan[n], t)
        .filter((h) => t?.hours[h] != null)
        .slice(0, 3)
        .map(clockOfHour),
      from: t?.from ?? 'none',
      own: t?.own ?? 0,
      creators: t?.creators ?? 0,
    };
  }
  return out;
}
