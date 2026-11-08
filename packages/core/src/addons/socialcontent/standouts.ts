/**
 * Which of a creator's posts stand out (HANDSFREEOS_CONTENT_CREATOR_IMPLEMENTATION_PLAN.md, decisions 5 to 8).
 *
 * Followers and engagement grow over time, so a post isn't weighed against the creator's best ever, but against the
 * posts around it: up to 10 before it and 10 after it. A post with at least 2 times their middle number (the median,
 * so one other big hit nearby doesn't throw it off) is a standout, on views (for videos, where the site shows them)
 * or on likes plus comments, whichever it beat them on. Chris's example: 5 posts, one with 100 likes and comments and
 * the rest 20 to 50, makes the 100 about 3 times their middle, so it counts.
 *
 * - A post under 7 days old waits: it's still growing. It isn't anyone's neighbour either, for the same reason.
 * - It's weighed only against at least 4 neighbours that show the same number.
 * - A post needs 10 likes and comments, or 500 views, at the least, so 3 likes next to posts with 1 isn't a standout.
 *
 * It's worked out again for all of a creator's posts every time any are saved, since each post's neighbours change.
 * The one copy: the server keeps its answer, the web and the phone show it. Browser-safe and pure.
 */

export const STANDOUT = {
  /** How many times their middle number a post needs. */
  times: 2,
  /** How many posts on each side it's weighed against, at most. */
  eachSide: 10,
  /** How many neighbours showing the same number it needs to be weighed at all. */
  neighboursAtLeast: 4,
  /** How old a post must be to be weighed, or to weigh another. */
  waitDays: 7,
  /** The least a standout needs: likes plus comments, or views. */
  engagementAtLeast: 10,
  viewsAtLeast: 500,
} as const;

/** What a creator has to show to have done well (decision 5): enough followers, and a post lately. */
export const DONE_WELL = { followersAtLeast: 5_000, postedWithinDays: 30 } as const;

/** The most a "times" number is kept as (the column's limit). */
const TIMES_MOST = 9_999;

export interface PostNumbers {
  readonly id: string;
  readonly postedAt: Date | string;
  readonly views: number | null;
  readonly likes: number | null;
  readonly comments: number | null;
}

export type StandoutOn = 'views' | 'engagement' | 'both';
export type StandoutWait = 'too_new' | 'too_few';

export interface Weighed {
  readonly id: string;
  /** Its views against the middle of its neighbours', or null when it can't be weighed on views. */
  readonly viewsTimes: number | null;
  /** Its likes plus comments against the middle of its neighbours', or null. */
  readonly engagementTimes: number | null;
  readonly standout: boolean;
  readonly on: StandoutOn | null;
  /** Why it isn't weighed yet, when it isn't. */
  readonly waiting: StandoutWait | null;
}

/** Likes plus comments, or null when the site shows neither. */
export function engagementOf(p: Pick<PostNumbers, 'likes' | 'comments'>): number | null {
  if (p.likes === null && p.comments === null) return null;
  return (p.likes ?? 0) + (p.comments ?? 0);
}

/** The middle number of a list (the mean of the middle two when it's even). The list mustn't be empty. */
export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const time = (d: Date | string) => (d instanceof Date ? d.getTime() : new Date(d).getTime());
const twoPlaces = (n: number) => Math.min(TIMES_MOST, Math.round(n * 100) / 100);

/** How many times the middle of `around` a value is, or null when there are too few to judge by. */
function timesOf(value: number | null, around: readonly (number | null)[]): number | null {
  if (value === null) return null;
  const shown = around.filter((n): n is number => n !== null);
  if (shown.length < STANDOUT.neighboursAtLeast) return null;
  return twoPlaces(value / Math.max(median(shown), 1));
}

/** Every post of one creator, weighed against the posts around it. In the order given. */
export function weighPosts(posts: readonly PostNumbers[], now: Date | number): Weighed[] {
  const cut = (now instanceof Date ? now.getTime() : now) - STANDOUT.waitDays * 86_400_000;
  const grown = posts
    .filter((p) => time(p.postedAt) <= cut)
    .sort((a, b) => time(a.postedAt) - time(b.postedAt) || a.id.localeCompare(b.id));
  const at = new Map(grown.map((p, i) => [p.id, i]));
  return posts.map((p) => {
    const i = at.get(p.id);
    if (i === undefined)
      return {
        id: p.id,
        viewsTimes: null,
        engagementTimes: null,
        standout: false,
        on: null,
        waiting: 'too_new',
      };
    const around = [
      ...grown.slice(Math.max(0, i - STANDOUT.eachSide), i),
      ...grown.slice(i + 1, i + 1 + STANDOUT.eachSide),
    ];
    const engagement = engagementOf(p);
    const viewsTimes = timesOf(
      p.views,
      around.map((n) => n.views),
    );
    const engagementTimes = timesOf(engagement, around.map(engagementOf));
    const byViews =
      viewsTimes !== null &&
      viewsTimes >= STANDOUT.times &&
      (p.views ?? 0) >= STANDOUT.viewsAtLeast;
    const byEngagement =
      engagementTimes !== null &&
      engagementTimes >= STANDOUT.times &&
      (engagement ?? 0) >= STANDOUT.engagementAtLeast;
    const shows = p.views !== null || engagement !== null;
    return {
      id: p.id,
      viewsTimes,
      engagementTimes,
      standout: byViews || byEngagement,
      on: byViews && byEngagement ? 'both' : byViews ? 'views' : byEngagement ? 'engagement' : null,
      waiting: shows && viewsTimes === null && engagementTimes === null ? 'too_few' : null,
    };
  });
}

/** How far past its neighbours a standout is: its better number. */
export function standoutTimes(w: Pick<Weighed, 'viewsTimes' | 'engagementTimes'>): number {
  return Math.max(w.viewsTimes ?? 0, w.engagementTimes ?? 0);
}

/** Whether a creator found by a search has done well enough to suggest (decision 5): followers, and a recent post. */
export function doneWell(
  c: { readonly followers: number | null; readonly lastPostAt: Date | string | null },
  now: Date | number,
): boolean {
  if (c.followers === null || c.followers < DONE_WELL.followersAtLeast) return false;
  if (c.lastPostAt === null) return false;
  const since =
    (now instanceof Date ? now.getTime() : now) - DONE_WELL.postedWithinDays * 86_400_000;
  return time(c.lastPostAt) >= since;
}
