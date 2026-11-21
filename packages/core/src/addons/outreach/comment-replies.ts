/**
 * Replies to the person's comments (docs/outreach.md decision 163, answer 8a): on a network that searches every hour
 * (Threads and X, `NETWORKS[p].postSearch`), each look also reads the person's notifications, and a reply to one of
 * their comments comes to HandsFreeOS (`outreach.comment_replies.save`). On those networks a reply is a post of its
 * own, so it's kept as one (`found: 'reply'`), good to answer without the AI's post check, and Today drafts the answer
 * as it drafts a comment. The answer always waits for an OK on Needs you (`COMMENT_NEEDS_YOU.reply`), Autopilot's too,
 * and the phone gets a push when the reply says yes to a demo (`saysYesToDemo`).
 *
 * Browser-safe: the extension builds the save with these shapes.
 */
import { z } from 'zod';
import { NETWORKS, PLATFORM_KEYS, type Platform } from './networks';
import { WHEN_MOST } from './limits';
import { POST_TEXT_MOST } from './posts';
import { NetworkUrl, PersonName, ProfileRef } from './saves';

/** The networks whose replies to the person's comments are read: those that search every hour. */
export const REPLY_PLATFORMS = PLATFORM_KEYS.filter((p) => NETWORKS[p].postSearch !== null);
export const readsReplies = (platform: Platform): boolean => REPLY_PLATFORMS.includes(platform);

/** What a kept reply is said to be, on Today and Needs you. */
export const REPLY_WHY = 'Answered your comment';

/** The most replies one look sends. */
export const REPLIES_SAVE_MOST = 20;

export const CommentReplyIn = z.object({
  /** The reply's own link: on Threads and X a reply is a post of its own. */
  url: NetworkUrl,
  /** Who wrote it. */
  author: ProfileRef,
  name: PersonName,
  text: z.string().trim().min(1).max(POST_TEXT_MOST),
  /** When, as the page printed it ("3h"). */
  when: z.string().trim().min(1).max(WHEN_MOST).nullable().default(null),
  /**
   * Whether the page showed it answers one of the person's own comments (X's "Replying to", Threads' reply under
   * theirs). Without it, a reply is kept only from someone the person commented to on that network.
   */
  toComment: z.boolean().default(false),
});
export type CommentReplyIn = z.input<typeof CommentReplyIn>;

export const CommentRepliesSaveInput = z.object({
  workspaceId: z.uuid(),
  platform: z
    .enum(PLATFORM_KEYS)
    .refine(readsReplies, 'Replies to your comments are read only on Threads and X.'),
  replies: z.array(CommentReplyIn).min(1).max(REPLIES_SAVE_MOST),
});
export type CommentRepliesSaveInput = z.input<typeof CommentRepliesSaveInput>;

export const CommentRepliesSaveOutput = z.object({
  /** How many replies were new, and wait for an answer on Today. */
  kept: z.number().int().min(0),
});
export type CommentRepliesSaveOutput = z.output<typeof CommentRepliesSaveOutput>;

/** A comment that offered to show them (decision 144): "I can show you a demo if you're interested". */
const OFFERED = /\b(demo|show you|walk you through|happy to show)\b/i;
/** A yes, the way people say it under a comment. */
const YES =
  /\b(yes|yeah|yep|yup|sure|definitely|absolutely|interested|i['’]?m in|count me in|sounds (good|great)|let['’]?s (do it|talk|chat|set (it|that|one) up)|i['’]?d (love|like) (to|that|one|a demo|to see)|show me|send (me )?(it|the link|a link|info|details|more)|dm me|message me|book (it|one|a time)|when can (we|you))\b/i;
/** A no, or a yes that isn't one ("not interested", "no thanks", "sure, but no"). */
const NO =
  /^\W*(no|nope|nah|never)\b|\bnot (interested|now|for me|really)\b|\bno thanks?\b|\bdon['’]?t (need|want)\b/i;

/**
 * Whether a reply says yes to a demo (decision 163's push): it reads as a yes, not a no, and either the person's
 * comment it answers offered to show them, or the reply itself asks for a demo.
 */
export function saysYesToDemo(reply: string, comment: string | null): boolean {
  const text = reply.trim();
  if (!text || NO.test(text) || !YES.test(text)) return false;
  return (comment !== null && OFFERED.test(comment)) || /\bdemo\b/i.test(text);
}

/** The phone's push when someone says yes to a demo under the person's comment. */
export function demoYesPushWords(
  name: string,
  platform: Platform,
): { title: string; body: string } {
  return {
    title: `${name} said yes to a demo`,
    body: `They answered your comment on ${NETWORKS[platform].name}. An answer waits for your OK on Needs you.`,
  };
}
