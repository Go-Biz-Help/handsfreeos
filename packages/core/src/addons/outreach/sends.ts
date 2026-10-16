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
 *   (`replyNeedsYou`) waits, and with (b) or (c) one that waits is **handed over**: their phone hears it.
 * - The extension sends what's OK'd in Messenger, in working hours, at a person's pace, and notes it as sent, or not
 *   sent and why.
 *
 * While training wheels are on, each one OK'd counts toward the 25, and whether it was changed first counts toward
 * the last 10 (./automation.ts).
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
import { MESSAGE_KINDS, WheelsState, type ReplyMode, type SendingMode } from './automation';
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
  kind: z.enum(MESSAGE_KINDS),
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
});
export type Send = z.output<typeof Send>;

/** The extension drafted a message for someone on today's list: it waits, or goes as it is. */
export const SendQueueInput = z.object({
  workspaceId: z.uuid(),
  profileId: z.uuid(),
  kind: z.enum(MESSAGE_KINDS),
  chatId: z.uuid().nullable().default(null),
  threadKey: z.string().max(128).nullable().default(null),
  text: words,
  opener: DraftOpener.nullable().default(null),
  /** For a reply: the AI found it simple, so with Replies (b) it goes as it is. */
  simple: z.boolean().default(false),
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
  readonly kind: (typeof MESSAGE_KINDS)[number];
  readonly simple: boolean;
  /** From `replyNeedsYou`. */
  readonly needsYou: string | null;
}): boolean {
  if (o.wheels || o.sending === 'off') return false;
  if (o.kind !== 'reply') return o.sending === 'everything';
  if (o.needsYou) return false;
  return o.replies === 'everything' || (o.replies === 'simple' && o.simple);
}

/**
 * Whether a reply that waits is handed over with a push: with Replies (b) or (c), off training wheels, the person
 * counted on it going; so it comes to them, with why.
 */
export const handedOver = (o: {
  readonly sending: SendingMode;
  readonly replies: ReplyMode;
  readonly wheels: boolean;
  readonly kind: (typeof MESSAGE_KINDS)[number];
  readonly goes: boolean;
}) => o.kind === 'reply' && !o.goes && !o.wheels && o.sending !== 'off' && o.replies !== 'draft';

/** The push for a reply handed over, kept with Waiting for you's words (./waiting-words.ts). */
export { handOverPushWords } from './waiting-words';

/** Whether the person changed the AI's words before the OK: spaces and line breaks don't count. */
export const changed = (drafted: string, text: string) =>
  drafted.trim().replace(/\s+/g, ' ') !== text.trim().replace(/\s+/g, ' ');
