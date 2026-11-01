/**
 * Messages the extension sends on its own (docs/outreach.md, decisions 26 and 27, and training wheels): a first
 * message, a follow-up or a reply on the person's list for today, which the extension drafts with the AI, and which
 * then waits for their OK or goes as it is.
 *
 * - **Waits** while the person's Sending is (a) or (c), and while their training wheels are on. They OK it on Today,
 *   on the web or the phone (never in the extension's panel, decision 72), as it is or changed, one at a time or all
 *   at once (**Approve all**), or skip it, which takes the person off today's list.
 * - **Goes as it is** with Sending (b) once the training wheels are off.
 * - **A reply** follows the person's Replies instead (decision 27): with (b) it goes as it is when the AI found it
 *   simple; with (c) it always does; with (a) it waits. Whatever they chose, a reply to someone who needs the person
 *   (`replyNeedsYou`) waits, and so does one to something the business's Knowledge doesn't answer (decision 122,
 *   ./knows.ts); with (b) or (c) one that waits is **handed over**: their phone hears it.
 * - The extension sends what's OK'd in Messenger, in working hours, at a person's pace, and notes it as sent, or not
 *   sent and why.
 *
 * While training wheels are on, each one OK'd counts toward the 25, and whether it was changed first counts toward
 * the last 10 (./automation.ts).
 *
 * **A comment** on a good post goes this way too on a network whose comments wait at first (Instagram's and
 * Alignable's, the kit's `commentsWait: 'hold'`, decision 92), for a build of the extension that finds people by topic.
 * It waits under training wheels, and under its own hold (`commentHoldOn`) till the network has had comments for a week
 * and the person has OK'd 25; then it goes on its own with any Sending but Off. An answer to an Alignable post asking
 * for exactly what the business offers always waits for an OK of its own (decision 79).
 *
 * **The day's reply in a group** on Facebook (`group_reply`, decision 114, ./active.ts) goes as a comment does, under
 * the question it answers, and under the same hold, counted from those replies alone.
 *
 * Browser-safe: the extension and the web read it.
 */
import { z } from 'zod';
import {
  asksForPerson,
  isEmergency,
  looksFrustrated,
  optOutPhrase,
  sensitiveTopic,
} from '../../ai-team/guardrails';
import {
  SEND_KINDS,
  WheelsState,
  type ReplyMode,
  type SendingMode,
  type SendKind,
  underAPost,
} from './automation';
import { UNANSWERED_MOST } from './knows';
import { MESSAGE_MOST } from './limits';
import { DraftOpener } from './openers';
import { gapWords } from './voice';

export const SEND_STATES = {
  waiting: 'Waiting for your OK',
  approved: 'OK’d: it goes soon',
  sent: 'Sent',
  skipped: 'Skipped',
  failed: 'Not sent',
} as const;
export type SendState = keyof typeof SEND_STATES;
export const SEND_STATE_KEYS = Object.keys(SEND_STATES) as [SendState, ...SendState[]];

/** The most OK'd at once with Approve all, and listed. */
export const SENDS_MOST = 100;
export const SEND_WHY_MOST = 300;

/** A message's words, as the person OKs them: the phone checks a change with it before it waits there. */
export const SendText = z
  .string()
  .trim()
  .min(1, { error: 'Write something to send.' })
  .max(MESSAGE_MOST, {
    error: `Keep a message under ${MESSAGE_MOST.toLocaleString()} characters.`,
  });
const words = SendText;

/** How many of a chat's latest messages show beside a message waiting for an OK. */
export const RECENT_SHOWN = 6;

/**
 * One of a chat's latest messages, shown beside a message waiting for the person's OK so they see where the chat is
 * going: theirs or the person's, its words, and when.
 */
export const RecentMessage = z.object({
  fromMe: z.boolean(),
  text: z.string(),
  at: z.iso.datetime(),
});
export type RecentMessage = z.output<typeof RecentMessage>;

/** When one of a chat's messages went, for the person: "Today", "Yesterday", "2 days ago", "3 weeks ago". */
export function chatWhen(at: string, now: number): string {
  const days = Math.floor((now - Date.parse(at)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return `${gapWords(at, now) ?? `${days} days`} ago`;
}

/**
 * A chat's latest messages as bubbles to show beside a message waiting for an OK: each with when it went, said once for
 * a run of messages the same day.
 */
export function recentBubbles(
  recent: readonly RecentMessage[],
  now: number,
): { readonly fromMe: boolean; readonly text: string; readonly when: string | null }[] {
  return recent.map((m, i) => {
    const when = chatWhen(m.at, now);
    const next = recent[i + 1];
    return {
      fromMe: m.fromMe,
      text: m.text,
      when: next && chatWhen(next.at, now) === when ? null : when,
    };
  });
}

export const RECENT_WORDS = {
  title: 'Your chat so far',
} as const;

export const Send = z.object({
  sendId: z.uuid(),
  kind: z.enum(SEND_KINDS),
  profileId: z.uuid(),
  /** Who it's to, and their profile's link. */
  name: z.string(),
  profileUrl: z.string().nullable(),
  chatId: z.uuid().nullable(),
  threadKey: z.string().nullable(),
  text: z.string(),
  state: z.enum(SEND_STATE_KEYS),
  why: z.string().nullable(),
  opener: DraftOpener.nullable(),
  /** A reply handed over to the person (`handedOver`): it waits for an OK of its own, never Approve all. */
  handedOver: z.boolean(),
  /** Why a reply needs the person (`replyNeedsYou`): it waits for an OK of its own too. */
  needsYou: z.string().nullable(),
  createdAt: z.iso.datetime(),
  /** The chat's latest messages, oldest first, when there is one: where it's going. */
  recent: z.array(RecentMessage).max(RECENT_SHOWN),
  /**
   * For a comment (decision 92) or a reply in a group (decision 114): its post, the post's link and its first words
   * (`postStartOf`), shown above it. Null for a message.
   */
  postId: z.uuid().nullable(),
  postUrl: z.string().nullable(),
  post: z.string().nullable(),
  /**
   * The whole post, when `post` is cut short: **More** shows it in place (decision 141). Null when `post` is all of it,
   * or for a message; left out by servers from before it, and read as null.
   */
  postWhole: z.string().nullable().default(null),
});
export type Send = z.output<typeof Send>;

/** How much of a comment's post shows above it in Waiting for you. */
export const SEND_POST_MOST = 200;

/**
 * A post as a card shows it (decision 141): its first words, cut short at `most`, and the whole of it for **More** when
 * they were cut, else null.
 */
export function postParts(
  body: string,
  most: number,
): { readonly post: string; readonly postWhole: string | null } {
  const t = body.trim();
  return t.length > most
    ? { post: `${t.slice(0, most - 1).trimEnd()}…`, postWhole: t }
    : { post: t, postWhole: null };
}

/** A post's first words, as a comment waiting shows them: cut short at `SEND_POST_MOST`. */
export const postStartOf = (body: string): string => postParts(body, SEND_POST_MOST).post;

/** The extension drafted a message, or a comment, for someone on today's list: it waits, or goes as it is. */
export const SendQueueInput = z
  .object({
    workspaceId: z.uuid(),
    profileId: z.uuid(),
    kind: z.enum(SEND_KINDS),
    chatId: z.uuid().nullable().default(null),
    threadKey: z.string().max(128).nullable().default(null),
    text: words,
    opener: DraftOpener.nullable().default(null),
    /** For a reply: the AI found it simple, so with Replies (b) it goes as it is. */
    simple: z.boolean().default(false),
    /**
     * For a reply: what they asked that the business's Knowledge doesn't answer, as the AI said (decision 122,
     * ./knows.ts), so it waits for the person whatever their Replies say. From the extension's 0.111.0.
     */
    unanswered: z.string().trim().max(UNANSWERED_MOST).nullable().default(null),
    /**
     * For a comment (decision 92) or a reply in a group (decision 114), and only for one: the post on Today it goes
     * under.
     */
    postId: z.uuid().nullable().default(null),
  })
  .refine((i) => underAPost(i.kind) === (i.postId !== null), {
    error: 'Send the post a comment or a reply in a group goes under, and a post only with one.',
    path: ['postId'],
  });
export type SendQueueInput = z.input<typeof SendQueueInput>;
export const SendQueueOutput = Send;

/**
 * The person OKs messages, as they are or changed; with no ids, every one waiting (Approve all) but those that wait for
 * an OK of their own (`oneByOne` in ./waiting-words.ts): a reply handed over, or one to someone who needs the person.
 */
export const SendApproveInput = z.object({
  workspaceId: z.uuid(),
  sends: z
    .array(z.object({ sendId: z.uuid(), text: words.optional() }))
    .max(SENDS_MOST)
    .optional(),
  /**
   * OK those named that still wait and pass over the rest, rather than refusing: the phone's Approve all, made from
   * what it showed, perhaps with no signal, while some were OK'd or skipped elsewhere meanwhile (decision 44).
   */
  partial: z.boolean().default(false),
});
export type SendApproveInput = z.input<typeof SendApproveInput>;
export const SendApproveOutput = z.object({
  approved: z.array(z.uuid()),
  wheels: WheelsState,
});

export const SendSkipInput = z.object({ workspaceId: z.uuid(), sendId: z.uuid() });
export type SendSkipInput = z.input<typeof SendSkipInput>;
export const SendSkipOutput = z.object({ sendId: z.uuid() });

/** The extension sent it in Messenger, or couldn't, and why. */
export const SendDoneInput = z.object({
  workspaceId: z.uuid(),
  sendId: z.uuid(),
  sent: z.boolean(),
  why: z.string().trim().max(SEND_WHY_MOST).nullable().default(null),
});
export type SendDoneInput = z.input<typeof SendDoneInput>;
export const SendDoneOutput = z.object({ sendId: z.uuid(), state: z.enum(SEND_STATE_KEYS) });

/**
 * Retry, or Retry all, on messages and comments the extension couldn't send (decision 132): the steps handed to the
 * person by their ids, or with none named every one that can be tried again. Each goes again as it was, a few minutes
 * after the one before.
 */
export const SendRetryInput = z.object({
  workspaceId: z.uuid(),
  needIds: z.array(z.uuid()).min(1).max(SENDS_MOST).nullable().default(null),
});
export type SendRetryInput = z.input<typeof SendRetryInput>;
export const SendRetryOutput = z.object({
  /** Each tried again: its step, the message that goes again, and when it may go at the soonest. */
  retried: z.array(z.object({ needId: z.uuid(), sendId: z.uuid(), at: z.iso.datetime() })),
  /** Those that couldn't be: a newer message to them waits already, or it went since. */
  passed: z.number().int().min(0),
});
export type SendRetryOutput = z.output<typeof SendRetryOutput>;

/** The person's messages waiting for their OK, and those OK'd, to send. */
export const SendsInput = z.object({ workspaceId: z.uuid() });
export type SendsInput = z.input<typeof SendsInput>;
export const SendsOutput = z.object({
  sends: z.array(Send),
  wheels: WheelsState,
});
export type SendsOutput = z.output<typeof SendsOutput>;

/**
 * Why a reply needs the person, from their last message, as the AI teammate hands over (packages/core/src/ai-team/
 * guardrails.ts): an emergency, asking to stop, a refund, a complaint, a legal threat or cancelling, asking for a
 * person, or sounding upset. Null when nothing does.
 */
export function replyNeedsYou(theirs: string | null): string | null {
  if (!theirs?.trim()) return null;
  if (isEmergency(theirs)) return 'it sounds like an emergency';
  if (optOutPhrase(theirs)) return 'they asked you to stop messaging them';
  const topic = sensitiveTopic(theirs);
  if (topic) return `it’s about ${topic.label}`;
  if (asksForPerson(theirs)) return 'they asked for you';
  if (looksFrustrated(theirs)) return 'they sound upset';
  return null;
}

/** Whether a message goes without waiting for the person's OK, and why a reply waits for them when it does. */
export function goesAsItIs(o: {
  readonly sending: SendingMode;
  readonly replies: ReplyMode;
  readonly wheels: boolean;
  readonly kind: SendKind;
  readonly simple: boolean;
  /** From `replyNeedsYou`, or why a comment waits for an OK of its own. */
  readonly needsYou: string | null;
  /** For a comment or a reply in a group: whether its network's comment hold is on (`commentHoldOn`). */
  readonly held?: boolean;
}): boolean {
  // A partner's messages wait for the person's OK, whatever Sending says (decision 81), and so do another time after
  // a no-show (decision 106) and a birthday or new-job note (decision 108).
  if (
    o.wheels ||
    o.sending === 'off' ||
    o.kind.startsWith('partner_') ||
    o.kind === 'rebook' ||
    o.kind === 'birthday' ||
    o.kind === 'new_job'
  )
    return false;
  // A comment, or a reply in a group, goes on its own with any Sending but Off, once its hold is off, unless it needs
  // the person (decisions 92 and 114).
  if (underAPost(o.kind)) return !o.held && !o.needsYou;
  if (o.kind !== 'reply') return o.sending === 'everything';
  if (o.needsYou) return false;
  return o.replies === 'everything' || (o.replies === 'simple' && o.simple);
}

/**
 * The comments-only hold (decision 92's 13; the owner's card of 27 Oct 2026, "Comments only"): on a network whose
 * comments go through `sends`, each comment waits for the person's OK until the network has had comments for
 * `COMMENT_HOLD.days` and they've OK'd `COMMENT_HOLD.okd` of them, worked out from their own sends there (the first
 * comment's, and those they OK'd). Nothing else halves for it, and training wheels stand as they are. Kept to this one
 * function, so another choice of the owner's changes it alone.
 */
export const COMMENT_HOLD = { days: 7, okd: 25 } as const;

export function commentHoldOn(o: {
  /** When the network's first comment of theirs was drafted: null before any. */
  readonly firstAt: number | null;
  /** How many of their comments there they OK'd themselves. */
  readonly okd: number;
  readonly now: number;
}): boolean {
  return (
    o.firstAt === null ||
    o.now - o.firstAt < COMMENT_HOLD.days * 86_400_000 ||
    o.okd < COMMENT_HOLD.okd
  );
}

/** Under Sending on a network whose comments wait at first: what the hold is. */
export const COMMENT_HOLD_WORDS = `Each comment waits for your OK until you’ve OK’d ${COMMENT_HOLD.okd} and a week has gone by.`;

/** Why a comment waits for an OK of its own, whatever the hold says (`needsYou`). */
export const COMMENT_NEEDS_YOU = {
  /** An answer to an Alignable post asking for exactly what the business offers (decision 79). */
  answer: 'a forum answer always waits for your OK',
} as const;

/** Why another time after a no-show waits for an OK of its own (decision 106, `needsYou`). */
export const REBOOK_NEEDS_YOU = 'they missed their demo, so you see it first';

/**
 * Whether a reply that waits is handed over with a push: with Replies (b) or (c), off training wheels, the person
 * counted on it going; so it comes to them, with why.
 */
export const handedOver = (o: {
  readonly sending: SendingMode;
  readonly replies: ReplyMode;
  readonly wheels: boolean;
  readonly kind: SendKind;
  readonly goes: boolean;
}) => o.kind === 'reply' && !o.goes && !o.wheels && o.sending !== 'off' && o.replies !== 'draft';

/** The push for a reply handed over, kept with Waiting for you's words (./waiting-words.ts). */
export { handOverPushWords } from './waiting-words';

/** Whether the person changed the AI's words before the OK: spaces and line breaks don't count. */
export const changed = (drafted: string, text: string) =>
  drafted.trim().replace(/\s+/g, ' ') !== text.trim().replace(/\s+/g, ' ');
