/**
 * Staying active in the person's Facebook groups (docs/outreach.md, decision 114; the owner's pick of 28 Oct 2026:
 * "Each day it likes 3 to 5 recent posts in your groups and replies to 1. The AI writes the reply, and replies wait
 * for your OK at first."):
 *
 * - **Likes.** Once a day the person's computer opens up to `ACTIVE_GROUPS` of their groups marked Work these or Maybe
 *   that no teammate works, a different few each day, newest posts first, and likes `ACTIVE_LIKES` recent posts there
 *   in all (`recentPost`): never one of their own, one liked already, or one about sad news (`neverLike`). Each is
 *   noted as a like of theirs, so it counts against the day's likes, which leave it room first.
 * - **One reply a day.** It keeps one recent post there that asks something (`asksSomething`) for a reply
 *   (`outreach.active.reply`): never one of their own, nor one worth the AI's check for a comment, which Find posts and
 *   the look at the newest posts keep for that (decision 20). Today lists it ("Answer a question in your group"), the
 *   AI writes the reply, with no pitch and no link, and it goes under the post like a comment, through `sends`
 *   (`group_reply`): each waits for the person's OK until they've OK'd `COMMENT_HOLD.okd` and a week has gone by
 *   (./sends.ts), then goes on its own with any Sending but Off. Only a build that posts them gets them
 *   (`groupRepliesOn`): an older one would send an OK'd reply as a message.
 *
 * Nothing waits on it: a day it can't like or find a question, the rest of the day goes on.
 *
 * Browser-safe: the extension reads these shapes. The server's side is ./ops/active.ts.
 */
import { z } from 'zod';
import { appVersionAtLeast } from '../../mobile';
import { GroupRef } from './activity';
import { asksForHelp, dayNumber, PostIn, postHoursAgo } from './posts';

/** The most groups a day's likes and question come from. */
export const ACTIVE_GROUPS = 3;
/** How many recent posts it likes in them a day, in all: a few, a different number from day to day. */
export const ACTIVE_LIKES = { least: 3, most: 5 } as const;
/** A post is recent while Facebook says it went up within this many hours. */
export const ACTIVE_FRESH_HOURS = 72;
/** How long a question kept for a reply stays on Today, unanswered: the conversation under it moves on. */
export const REPLY_KEPT_DAYS = 3;
/** The most questions offered at once for the day's reply: the first that can be answered is kept. */
export const REPLY_TRIES = 5;

/** The first build of the extension that posts a reply in a group once it's OK'd (decision 114). */
export const GROUP_REPLIES_SINCE = '0.106.0';

/**
 * Whether a computer's build gets the day's reply in a group (`GROUP_REPLIES_SINCE`): one that didn't say its build, or
 * no computer at all, is taken as older.
 */
export const groupRepliesOn = (version: string | null | undefined): boolean =>
  appVersionAtLeast(version ?? null, GROUP_REPLIES_SINCE);

/** How many posts it likes in the groups today, before the day's likes have their say: 3 to 5, all day the same. */
export const likesToday = (now: number = Date.now()): number =>
  ACTIVE_LIKES.least + (dayNumber(now) % (ACTIVE_LIKES.most - ACTIVE_LIKES.least + 1));

/**
 * Whether a post in a group's newest posts is recent: Facebook said it went up within `ACTIVE_FRESH_HOURS`, or said
 * nothing (it's at the top of the newest). One it dated ("October 3") is older.
 */
export function recentPost(when: string | null): boolean {
  if (!when?.trim()) return true;
  const hours = postHoursAgo(when);
  return hours !== null && hours <= ACTIVE_FRESH_HOURS;
}

/** Whether a post asks something: for help or a recommendation, or anything with a question mark, links aside. */
export function asksSomething(text: string): boolean {
  const words = text.replace(/\bhttps?:\/\/\S+/gi, ' ');
  return asksForHelp(words) || words.includes('?');
}

/** What Today and the screens say of a reply in a group. */
export const GROUP_REPLY_WORDS = {
  /** Today's why: "Asked in Austin Small Business Owners". */
  asked: (group: string | null): string =>
    group ? `Asked in ${group}` : 'Asked in one of your groups',
  /** Why the day's question waits for tomorrow. */
  keptToday: 'A question in your groups is kept for today’s reply already. Another comes tomorrow.',
  /** Why none of those offered could be kept. */
  noneKept:
    'None of those posts could be answered: each was yours, answered or put aside already, another teammate’s, or one the AI checks for a comment instead.',
} as const;

export const ActiveNextInput = z.object({
  workspaceId: z.uuid(),
  platform: z.literal('facebook').default('facebook'),
});
export type ActiveNextInput = z.input<typeof ActiveNextInput>;

export const ActiveGroup = z.object({
  groupId: z.uuid(),
  name: z.string().nullable(),
  url: z.string(),
});
export type ActiveGroup = z.output<typeof ActiveGroup>;

export const ActiveNextOutput = z.object({
  /**
   * How many recent posts to like in the groups today: 3 to 5, no more than the day's likes leave room for, and none
   * before the person is ready (decision 63) or once today's are noted.
   */
  likes: z.number().int().min(0).max(ACTIVE_LIKES.most),
  /**
   * Whether a question is still to keep for today's reply: none kept today, Sending isn't Off, the day's comments have
   * room, and the person's computer posts replies (`groupRepliesOn`).
   */
  reply: z.boolean(),
  /**
   * The groups to look in: up to `ACTIVE_GROUPS` of the person's, marked Work these or Maybe, that no teammate works,
   * Work these first, a different few each day.
   */
  groups: z.array(ActiveGroup).max(ACTIVE_GROUPS),
  /**
   * The person's own profile there, as the check of their profile read it, so none of their own posts is liked or
   * answered: null till it's been read.
   */
  own: z.object({ url: z.string().nullable(), username: z.string().nullable() }).nullable(),
});
export type ActiveNextOutput = z.output<typeof ActiveNextOutput>;

export const ActiveReplyInput = z.object({
  workspaceId: z.uuid(),
  platform: z.literal('facebook').default('facebook'),
  /** Recent posts in the groups that ask something, the best first, each with its group: the first that can be is kept. */
  posts: z
    .array(PostIn.extend({ group: GroupRef }))
    .min(1)
    .max(REPLY_TRIES, `Send up to ${REPLY_TRIES} posts at a time.`),
});
export type ActiveReplyInput = z.input<typeof ActiveReplyInput>;

export const ActiveReplyOutput = z.object({
  /** The post kept for today's reply, and its link: null when none could be. */
  postId: z.uuid().nullable(),
  url: z.string().nullable(),
  /** Why none was kept, in words for the person: null when one was. */
  why: z.string().nullable(),
});
export type ActiveReplyOutput = z.output<typeof ActiveReplyOutput>;
