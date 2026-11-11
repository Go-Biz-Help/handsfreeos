/**
 * Warming people up while they decide on the person's request (docs/outreach.md, decision 161; the owner, 11 Nov
 * 2026: "like and comment on 2-3 of their posts every other day for 2 weeks and if they still haven't followed us then
 * unfollow them and remove them from the list", on every network). From the day the request goes (a follow, on
 * Instagram) until they accept it (follow back), or the business's wait ends:
 *
 * - **A visit every other day** (`VISIT_EVERY_DAYS`): Today lists a warm-up (`warm_up`, with `keepWarm`) for the
 *   extension to look at their page and like 2 or 3 of their newest posts (`keepWarm.likes`: 3 while the day's likes
 *   have room for every visit's third, else 2). One with nothing to like counts as the visit (`warm_up.missed`).
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

/** A visit every other day: the next once the last was two business days ago or more. */
export const VISIT_EVERY_DAYS = 2;

/** How many of their newest posts a visit likes: 2, or 3 while the day's likes have room (the owner's 1b). */
export const VISIT_LIKES = { least: 2, most: 3 } as const;

/**
 * How long a post a visit liked waits for its comment: till the next visit, which keeps another. One the day's
 * comments had no room for, or the AI found nothing to say on, goes with it.
 */
export const WARM_POST_DAYS = VISIT_EVERY_DAYS;

/**
 * The first build whose runners do a visit (`keepWarm`): 2 or 3 likes, and no friend request after them. Today lists
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
    `Like 2 or 3 of their newest posts, every other day till ${day}`,
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
    : `No new post of ${name}’s to like on this visit: the next is in ${VISIT_EVERY_DAYS} days`;
}
