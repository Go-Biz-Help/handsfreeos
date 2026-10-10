/**
 * Messages the extension sends on its own (docs/outreach.md, decisions 26 and 27, and training wheels): a first
 * message, a follow-up or a reply on the person's list for today, which the extension drafts with the AI, and which
 * then waits for their OK or goes as it is.
 *
 * - **Waits** while the person's Sending is (a) or (c), while their training wheels are on, and always for a reply
 *   (for now). They OK it from the extension's panel or Today on the web, as it is or changed, one at a time or all at
 *   once (**Approve all**), or skip it, which takes the person off today's list.
 * - **Goes as it is** with Sending (b) once the training wheels are off.
 * - The extension sends what's OK'd in Messenger, in working hours, at a person's pace, and notes it as sent, or not
 *   sent and why.
 *
 * While training wheels are on, each one OK'd counts toward the 25, and whether it was changed first counts toward
 * the last 10 (./automation.ts).
 *
 * Browser-safe: the extension and the web read it.
 */
import { z } from 'zod';
import { MESSAGE_KINDS, WheelsState } from './automation';
import { MESSAGE_MOST } from './limits';
import { DraftOpener } from './openers';

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

const words = z
  .string()
  .trim()
  .min(1, { error: 'Write something to send.' })
  .max(MESSAGE_MOST, {
    error: `Keep a message under ${MESSAGE_MOST.toLocaleString()} characters.`,
  });

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
  createdAt: z.iso.datetime(),
});
export type Send = z.output<typeof Send>;

/** The extension drafted a message for someone on today's list: it waits, or goes as it is. */
export const SendQueueInput = z.object({
  workspaceId: z.uuid(),
  profileId: z.uuid(),
  kind: z.enum(MESSAGE_KINDS),
  chatId: z.uuid().nullable().default(null),
  threadKey: z.string().max(64).nullable().default(null),
  text: words,
  opener: DraftOpener.nullable().default(null),
});
export type SendQueueInput = z.input<typeof SendQueueInput>;
export const SendQueueOutput = Send;

/** The person OKs messages, as they are or changed; with no ids, every one waiting (Approve all). */
export const SendApproveInput = z.object({
  workspaceId: z.uuid(),
  sends: z
    .array(z.object({ sendId: z.uuid(), text: words.optional() }))
    .max(SENDS_MOST)
    .optional(),
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

/** Whether a message goes without waiting: Sending (b), training wheels off, and not a reply (decision 27, for now). */
export const goesAsItIs = (o: {
  readonly sending: string;
  readonly wheels: boolean;
  readonly kind: (typeof MESSAGE_KINDS)[number];
}) => o.sending === 'everything' && !o.wheels && o.kind !== 'reply';

/** Whether the person changed the AI's words before the OK: spaces and line breaks don't count. */
export const changed = (drafted: string, text: string) =>
  drafted.trim().replace(/\s+/g, ' ') !== text.trim().replace(/\s+/g, ' ');
