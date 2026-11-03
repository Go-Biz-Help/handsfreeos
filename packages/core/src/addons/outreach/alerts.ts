/**
 * Phone alerts (docs/outreach.md, decision 22). Facebook tells HandsFreeOS nothing, so a reply is known only when the
 * extension sees it, in Chrome on the person's computer:
 *
 * - **A reply.** In any Facebook tab, the extension looks at the chats on the page (Messenger's list, an open chat,
 *   a small chat window) and tells HandsFreeOS of each whose last message is theirs (`outreach.replies.note`). It
 *   counts as a reply when the person's last message, request or comment to them (`REPLY_STARTS`), as the extension
 *   noted it, came before: so once for each of those, never for an old chat. A newer message of theirs counts again,
 *   at most once a quarter hour (decision 150, `NEWER_QUIET_MS`), and so does one a chat read finds. Unless the person
 *   was looking at that tab just then, their phone hears "Dana Reyes wrote back".
 * - **The morning.** At the business's hour (`morningPushHour`, 8 to start; Social Outreach → Settings → General,
 *   For your team), each person who used the extension lately and has something on their list for today hears how much.
 *
 * Both are pushes on the person's add-ons switch (Settings → Notifications), opening Today. Nothing is pushed to
 * anyone else. Browser-safe: the extension builds what it tells, and the worker the words.
 */
import { z } from 'zod';
import { addDays, localDateOf, localInstant } from '../../calendar/engine/zoned';
import { MORNING_PUSH_HOUR } from './chat-read';
import { inNetworkWords, PLATFORM_KEYS, PLATFORMS, type Platform } from './networks';
import { PersonName, ProfileRef, ThreadKey } from './saves';
import { TODAY_KINDS, type TodayItem, type TodayKind } from './today';

export { MORNING_PUSH_HOUR };
/** The hours the setting offers; null is off. */
export const MORNING_PUSH_HOURS = [5, 6, 7, 8, 9, 10, 11, 12] as const;

/** "8 AM", "12 PM". */
export const hourWords = (hour: number) =>
  `${hour % 12 === 0 ? 12 : hour % 12} ${hour < 12 ? 'AM' : 'PM'}`;

/** The next time the morning push goes, after `now`: today at the hour if it's still ahead, else tomorrow. */
export function nextMorning(now: number, timeZone: string, hour: number): Date {
  const clock = `${String(hour).padStart(2, '0')}:00`;
  const today = localDateOf(now, timeZone);
  const at = localInstant(today, clock, timeZone);
  return new Date(at > now ? at : localInstant(addDays(today, 1), clock, timeZone));
}

/** Who used the extension lately enough to hear in the morning: a step noted in this many days. */
export const MORNING_ACTIVE_DAYS = 14;

/**
 * A chat the extension saw whose last message is theirs: who it's with, as the page showed it. Instagram's list of
 * chats and LinkedIn's list of conversations link to none of them, so a row there comes by its name alone, which
 * counts only when it's the name of one person here the person messaged on that network.
 */
export const ReplySeen = z.object({
  name: PersonName,
  /** The chat's id, from its link, when the page showed one. */
  threadKey: ThreadKey.nullable().default(null),
  profile: ProfileRef.nullable().default(null),
  /**
   * Its last line changed on the person's computer since the extension last saw it there (decision 150): a newer
   * message of theirs, even with nothing of the person's noted since their last one. The words never leave the
   * computer.
   */
  newer: z.boolean().default(false),
});
export type ReplySeen = z.input<typeof ReplySeen>;

/** The most chats one note sends. */
export const REPLIES_MOST = 20;

/**
 * The steps of the person's that start a conversation (decision 150; the owner, 3 Nov 2026, answer 5a): a message, a
 * friend or connection request, a comment on their post. Someone who writes after one of these is answered, whether
 * or not the AI read them as a likely prospect. A like starts nothing.
 */
export const REPLY_STARTS = ['message', 'friend_request', 'comment'] as const;

/**
 * A newer message from someone who already wrote back buzzes the person's phone at most this often (decision 150,
 * answer 1a): a few messages in a row are one buzz. Their draft is written again either way.
 */
export const NEWER_QUIET_MS = 15 * 60_000;

/**
 * How lately their message was written for a chat read to count it as a reply (decision 150, answer 3a), as the
 * extension's own sightings go (`REPLY_FRESH_MS` there): an older one is still answered from Today, without a buzz.
 */
export const REPLY_FRESH_MS = 2 * 24 * 3_600_000;

export const RepliesNoteInput = z.object({
  workspaceId: z.uuid(),
  /** The network the chats are on. */
  platform: z.enum(PLATFORM_KEYS).default('facebook'),
  seen: z.array(ReplySeen).min(1).max(REPLIES_MOST),
  /** The person had that tab in front of them: it's noted, but their phone isn't buzzed. */
  looking: z.boolean().default(false),
});
export type RepliesNoteInput = z.input<typeof RepliesNoteInput>;

export const RepliesNoteOutput = z.object({
  /**
   * The replies new to HandsFreeOS: after a message, request or comment of the person's that nothing had answered, or
   * a newer message of theirs (decision 150). Each has their runner draft the answer next.
   */
  replies: z.array(z.object({ profileId: z.uuid(), name: z.string() })),
});
export type RepliesNoteOutput = z.output<typeof RepliesNoteOutput>;

/** The push for a reply: "Dana Reyes wrote back", on the network they wrote on. */
export function replyPushWords(
  name: string,
  platform: Platform = 'facebook',
): { title: string; body: string } {
  return {
    title: `${name} wrote back`,
    body: `On ${PLATFORMS[platform]}. Your list for today has them, with drafts for your reply.`,
  };
}

/** What accepting the person's request is on each network: Instagram's is following them back. */
const acceptedOn = (platform: Platform, many: boolean): string =>
  platform === 'instagram'
    ? 'followed you back'
    : inNetworkWords(
        many ? 'accepted your friend requests' : 'accepted your friend request',
        platform,
      );

/**
 * The push when people accept the person's friend request, invitation or follow (decision 101), on their switch: one
 * by name, or several in one, "Dana Reyes, Sam Lee and 2 more".
 */
export function acceptedPushWords(
  names: readonly string[],
  platform: Platform,
): { title: string; body: string } {
  const on = `On ${PLATFORMS[platform]}. Tap for your list for today.`;
  if (names.length === 1) return { title: `${names[0]} ${acceptedOn(platform, false)}`, body: on };
  const shown = names.slice(0, 2);
  const more = names.length - shown.length;
  return {
    title: `${names.length} people ${acceptedOn(platform, true)}`,
    body: `${more ? `${shown.join(', ')} and ${more} more` : shown.join(' and ')}. ${on}`,
  };
}

/** Each kind as the morning push counts it: "2 friend requests". */
const COUNTED: Record<TodayKind, readonly [string, string]> = {
  confirm: ['request to confirm', 'requests to confirm'],
  warm_up: ['post to like', 'posts to like'],
  friend_request: ['friend request', 'friend requests'],
  opener: ['first message to a new friend', 'first messages to new friends'],
  reconnect: ['friend to reconnect with', 'friends to reconnect with'],
  pitch: ['person to send your link to', 'people to send your link to'],
  video: ['person to send your video to', 'people to send your video to'],
  follow_up: ['follow-up', 'follow-ups'],
  check_in: ['check-in', 'check-ins'],
  reply: ['reply', 'replies'],
  demo_reminder: ['demo to remind them of', 'demos to remind them of'],
  rebook: ['missed demo to offer another time for', 'missed demos to offer another time for'],
  birthday: ['birthday note', 'birthday notes'],
  new_job: ['note on a new job', 'notes on new jobs'],
  comment: ['post to comment on', 'posts to comment on'],
  group_reply: ['question to answer in your groups', 'questions to answer in your groups'],
  warm_lead: ['comment to answer', 'comments to answer'],
  recommend: ['business to recommend', 'businesses to recommend'],
  partner_reply: ['reply to a partner', 'replies to partners'],
  partner_details: ['partner to send the details to', 'partners to send the details to'],
  partner_follow_up: ['partner to follow up with', 'partners to follow up with'],
  partner_ask: ['partner to ask', 'partners to ask'],
  partner_warm_up: ['partner to warm up', 'partners to warm up'],
};

/** "a, b and c". */
const andWords = (parts: readonly string[]): string =>
  parts.length === 1
    ? parts[0]!
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;

/**
 * The morning push: "6 on your list for today", and what they are. Null with nothing on the list. Its `platforms` are
 * the networks the list is from, each the person works: one says it in that network's words and where to start; more
 * than one names them.
 */
export function morningPushWords(
  items: readonly Pick<TodayItem, 'kind'>[],
  platforms: readonly Platform[] = ['facebook'],
): { title: string; body: string } | null {
  if (!items.length) return null;
  const counts = (Object.keys(TODAY_KINDS) as TodayKind[])
    .map((kind) => [kind, items.filter((i) => i.kind === kind).length] as const)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count} ${COUNTED[kind][count === 1 ? 0 : 1]}`);
  const list = andWords(counts);
  const one = platforms.length === 1 ? platforms[0]! : null;
  const said = one ? inNetworkWords(list, one) : list;
  return {
    title: `${items.length} on your list for today`,
    body: one
      ? `${said.charAt(0).toUpperCase()}${said.slice(1)}. Open the extension on ${PLATFORMS[one]} to start.`
      : `${said.charAt(0).toUpperCase()}${said.slice(1)}, on ${andWords(platforms.map((p) => PLATFORMS[p]))}. Open Today to start.`,
  };
}
