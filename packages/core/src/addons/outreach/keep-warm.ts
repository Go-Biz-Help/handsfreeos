/**
 * Warming people up while they decide on the person's request (docs/outreach.md, decision 161; the owner, 11 Nov
 * 2026: "like and comment on 2-3 of their posts every other day for 2 weeks and if they still haven't followed us then
 * unfollow them and remove them from the list", on every network; then "every other day feels robotic just make it
 * random and it can like 1-2 posts and comment on one"). From the day the request goes (a follow, on Instagram) until
 * they accept it (follow back), or the business's wait ends:
 *
 * - **A visit every few days, at random** (`VISIT_GAP_DAYS`): 1 to 3 days after the last (or after the request), Today
 *   lists a warm-up (`warm_up`, with `keepWarm`) for the extension to look at their page and like 1 or 2 of their
 *   newest posts (`keepWarm.likes`, `visitLikes`), picked at random each visit. One with nothing to like counts as the
 *   visit (`warm_up.missed`).
 * - **One comment a visit**: the first post a visit liked is kept (`posts.warm_up`) for one comment under it, on Today
 *   as any comment is, counted against the day's comments and waiting for the person's OK as that network's comments
 *   do (the owner's 3a), drafted to congratulate them, praise something real or show interest, as a person would
 *   (`WARM_COMMENT_TASK` in ./today.ts). Nothing real to react to: no comment.
 * - **Then unfollow or withdraw**, after the business's wait (2 weeks to start, their setting "Warm up for, then
 *   unfollow or withdraw"), on its own with the tidying, 20 a day (decision 98). Nothing more from the tool after it
 *   unless they follow back or write first (`friend_ends.after_warm_up`): in People they're Not a fit, "Didn't follow
 *   back" (`noAnswerWhy`), and Back in play takes them back.
 *
 * Everyone already waiting when it began starts a fresh wait then (`friends.warm_up_from`, set by the migration that
 * added it: the owner's 6b), so each gets all 7 visits. Browser-safe: the extension, the web and the phone read these.
 */
import { appVersionAtLeast } from '../../mobile';
import { NETWORKS, type Platform } from './networks';

/**
 * How many days after the last visit the next comes: at random, 1 to 3 (the owner: "every other day feels robotic"),
 * so about every other day on average, never on a set rhythm. The server picks it from who they are and the day of
 * their last visit, so a day's list stays the same however often it's read.
 */
export const VISIT_GAP_DAYS = { least: 1, most: 3 } as const;

/** How many of their newest posts a visit likes: 1 or 2, at random (the owner, 11 Nov 2026). */
export const VISIT_LIKES = { least: 1, most: 2 } as const;

/**
 * A post kept for a visit's comment within this many hours of another was liked on the same visit: one comment a
 * visit. Visits are a day or more apart, and a visit's likes come minutes apart.
 */
export const WARM_POST_GAP_HOURS = 8;

/**
 * The first build whose runners do a visit (`keepWarm`): its likes, and no friend request after them. Today lists
 * visits only while the person's working computer runs it or later (`keepWarmOn`): an older one would like one post and
 * say a request comes next.
 */
export const KEEP_WARM_SINCE = '0.135.0';

/** Whether a computer's build does visits (`KEEP_WARM_SINCE`): no build said, or no computer, is taken as older. */
export const keepWarmOn = (version: string | null | undefined): boolean =>
  appVersionAtLeast(version ?? null, KEEP_WARM_SINCE);

const DAY = 86_400_000;

/**
 * When someone's warm-up ends, for a request that went at `since`: the business's wait (`weeks`) after it, or after
 * `warmFrom` for one already waiting when warm-ups began (`friends.warm_up_from`, the owner's 6b), whichever is later.
 */
export function warmUpEnds(
  since: Date | string,
  warmFrom: Date | string | null,
  weeks: number,
): Date {
  const from = Math.max(
    new Date(since).getTime(),
    warmFrom === null ? 0 : new Date(warmFrom).getTime(),
  );
  return new Date(from + weeks * 7 * DAY);
}

/**
 * How many posts a visit likes, 1 or 2, at random for each person and day (`VISIT_LIKES`): the same however often the
 * day's list is read. `day` is the day's date, as 2026-11-12.
 */
export function visitLikes(profileId: string, day: string): number {
  let h = 2166136261;
  for (const c of `${profileId}:${day}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  // The high bits: FNV's lowest one is only the characters' parity.
  return VISIT_LIKES.least + ((h >>> 16) % (VISIT_LIKES.most - VISIT_LIKES.least + 1));
}

/** Why someone whose warm-up ended is Not a fit in People: "Didn't follow back", in each network's words. */
export function noAnswerWhy(platform: Platform): string {
  const kit = NETWORKS[platform];
  return kit.follows ? 'Didn’t follow back' : `Didn’t accept your ${kit.words.friendRequest}`;
}

/** Why a visit is on Today, in a line or two: who they're waiting on, and what a visit does. */
export function visitWhy(platform: Platform, until: Date | string): string[] {
  const kit = NETWORKS[platform];
  const day = new Date(until).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  return [
    kit.follows
      ? 'Waiting for them to follow you back'
      : `Waiting for them to accept your ${kit.words.friendRequest}`,
    `Like 1 or 2 of their newest posts every few days, till ${day}`,
  ];
}

/** Why a post a visit liked is on Today for its comment. */
export function warmPostWhy(platform: Platform): string {
  const kit = NETWORKS[platform];
  return kit.follows
    ? 'Their post, while they decide on following you back'
    : `Their post, while they decide on your ${kit.words.friendRequest}`;
}

/** A post as a runner reads it on someone's page, for a visit's picks. */
export interface VisitPost {
  readonly text: string;
  readonly pictures?: readonly string[];
  /** Liked already, by an earlier visit or the person: a visit likes new ones. */
  readonly liked?: boolean;
}

/**
 * Which of their posts a visit likes, newest first as read: up to `likes` that nothing rules out (`neverLike`: grief,
 * illness, trouble…) and that aren't liked already, so each visit adds new likes. Empty when none are left to like.
 */
export function visitPicks(
  posts: readonly VisitPost[],
  likes: number,
  neverLike: (post: { readonly text: string; readonly pictures: readonly string[] }) => boolean,
): number[] {
  const picks: number[] = [];
  posts.forEach((post, i) => {
    if (
      picks.length < likes &&
      !post.liked &&
      !neverLike({ text: post.text, pictures: post.pictures ?? [] })
    )
      picks.push(i);
  });
  return picks;
}

/** What a visit did, for the runner's activity line. */
export function visitLine(name: string, platform: Platform, liked: number): string {
  const kit = NETWORKS[platform];
  const deciding = kit.follows
    ? 'while they decide on following you back'
    : `while they decide on your ${kit.words.friendRequest}`;
  return liked > 0
    ? `Liked ${liked === 1 ? 'a post' : `${liked} posts`} of ${name}’s ${deciding}`
    : `No new post of ${name}’s to like on this visit: the next comes in a few days`;
}
