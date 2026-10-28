/**
 * The person's own followers on Facebook (docs/outreach.md, decision 113; the owner's pick of 28 Oct 2026: "Once a
 * week it reads your followers, the AI checks each one like a friend, and the fits go on Today for a friend
 * request."):
 *
 * - **Once a week** (`FOLLOWERS_EVERY_DAYS`), the person's computer opens their own followers list and reads it, up to
 *   `FOLLOWERS_READ_MOST`; each one is kept as theirs, with when it was last seen there.
 * - **Each follower who isn't their friend is checked by the AI like a friend** (`outreach.checks.next`'s `follower`,
 *   last after the friends), inside the day's checks: a check of a follower says so (`via`), and counts with the checks
 *   of people the person knows. A follower who becomes a friend is one of theirs at once.
 * - **A good fit goes on Today for a friend request** ("Follows you on Facebook"), after a like of one of their posts
 *   when Like a post first is on, as anyone's request does.
 *
 * Someone not seen on the list for three weeks (`FOLLOWERS_KEPT_DAYS`) isn't counted as a follower any more. Nothing
 * is pressed on Facebook to read the list.
 *
 * Browser-safe: the extension reads these shapes. The server's side is ./ops/followers.ts.
 */
import { z } from 'zod';
import { PersonName, ProfileRef } from './saves';

/** How many days apart the followers are read. */
export const FOLLOWERS_EVERY_DAYS = 7;
/** The most followers one read takes. */
export const FOLLOWERS_READ_MOST = 300;
/** The most saved at a time: a longer list goes in parts. */
export const FOLLOWERS_SAVE_MOST = 100;
/** Not seen on their list for this long, someone isn't counted as a follower any more: three weeks of reads. */
export const FOLLOWERS_KEPT_DAYS = 21;

/** What Today says of a follower. */
export const FOLLOWER_WHY = 'Follows you on Facebook';
/** What the AI's check is told of one, among what's known of them. */
export const FOLLOWER_FACT = 'Follows the owner on Facebook, though they aren’t friends';

export const FollowersNextInput = z.object({
  workspaceId: z.uuid(),
  platform: z.literal('facebook').default('facebook'),
});
export type FollowersNextInput = z.input<typeof FollowersNextInput>;
export const FollowersNextOutput = z.object({
  /** Whether this week's read is still to do: never read, or last read a week ago or more. */
  due: z.boolean(),
});
export type FollowersNextOutput = z.output<typeof FollowersNextOutput>;

export const FollowersSaveInput = z.object({
  workspaceId: z.uuid(),
  platform: z.literal('facebook').default('facebook'),
  /** The followers the list showed, as far as it loaded: a longer list goes in parts. */
  people: z
    .array(z.object({ profile: ProfileRef, name: PersonName }))
    .max(FOLLOWERS_SAVE_MOST, `Save up to ${FOLLOWERS_SAVE_MOST} at a time.`)
    .default([]),
  /** The last part of this week's read: the next is a week on. */
  done: z.boolean().default(false),
});
export type FollowersSaveInput = z.input<typeof FollowersSaveInput>;
export const FollowersSaveOutput = z.object({
  /** Followers in this part. */
  saved: z.number().int(),
  /** Of them, new as followers and not the person's friends: the AI checks them like friends. */
  added: z.number().int(),
  /** When the week's read was noted done: null for a part before the last. */
  readAt: z.string().nullable(),
});
export type FollowersSaveOutput = z.output<typeof FollowersSaveOutput>;
