/**
 * Chats read in Messenger, without Facebook's file (docs/outreach.md, decision 2's "Collect from Facebook"): the
 * extension reads each one-to-one chat in the person's browser, as they open it or as it goes through their chats at
 * a steady pace, and sends its latest few messages, each with when it was sent. They join the chats from the file,
 * one per person, for the AI to read (./chat-read.ts). Browser-safe: the extension builds what it sends with these.
 */
import { z } from 'zod';
import type { SendKind } from './automation';
import { DownloadMessageInput, type DownloadMessage } from './download';
import { RECENT_MESSAGES } from './limits';
import { PLATFORM_KEYS } from './playbooks';
import { PersonName, ProfileRef, ThreadKey } from './saves';

/** The most chats one call brings: the extension sends them as it reads them. */
export const COLLECT_CHATS_MOST = 10;

export const CollectedChat = z.object({
  /** Who it's with, as the chat shows them. */
  name: PersonName,
  thread: z.object({
    id: ThreadKey,
    encrypted: z.boolean().default(false),
  }),
  /** Their profile, when the chat links to it. */
  profile: ProfileRef.nullable().default(null),
  /** The latest messages on the page, oldest first, each with when it was sent. */
  messages: z.array(DownloadMessageInput).min(1).max(RECENT_MESSAGES),
});
export type CollectedChat = z.input<typeof CollectedChat>;

export const ChatsCollectInput = z.object({
  workspaceId: z.uuid(),
  platform: z.enum(PLATFORM_KEYS).default('facebook'),
  chats: z
    .array(CollectedChat)
    .min(1)
    .max(COLLECT_CHATS_MOST, `Send up to ${COLLECT_CHATS_MOST} chats at a time.`),
});
export type ChatsCollectInput = z.input<typeof ChatsCollectInput>;

export const ChatsCollectOutput = z.object({
  /** Chats kept, new or with newer messages. */
  saved: z.number().int(),
  /** Of those, the ones waiting for the AI. */
  waiting: z.number().int(),
});
export type ChatsCollectOutput = z.output<typeof ChatsCollectOutput>;

const same = (a: DownloadMessage, b: DownloadMessage) =>
  a.fromMe === b.fromMe && a.text === b.text && a.at === b.at;

/** What was kept and what's new, the latest few, oldest first, each once. */
export function mergeRecent(
  kept: readonly DownloadMessage[],
  read: readonly DownloadMessage[],
): DownloadMessage[] {
  const all: DownloadMessage[] = [];
  for (const m of [...kept, ...read]) if (!all.some((had) => same(had, m))) all.push(m);
  return all
    .map((m, i) => ({ m, i }))
    .sort((x, y) => x.m.at.localeCompare(y.m.at) || x.i - y.i)
    .map(({ m }) => m)
    .slice(-RECENT_MESSAGES);
}

/**
 * The drafts written for where a chat is (decision 134): an answer, a nudge, the next step after a yes, a first
 * message. One still waiting for the person's OK when the chat moves on was written for where it was, so it goes, and
 * the next look drafts again from the chat as it is now. A demo's reminder, another time after a no-show and a birthday
 * or new-job note stay: they're about a day, not the chat.
 */
export const DRAFTS_THE_CHAT_MOVES = [
  'opener',
  'reconnect',
  'pitch',
  'video',
  'follow_up',
  'check_in',
  'reply',
  'partner_ask',
  'partner_follow_up',
  'partner_details',
  'partner_reply',
] as const satisfies readonly SendKind[];

/** A message as two reads of a chat compare it: who wrote it and its words, whatever time each read gave it. */
const keyOf = (m: Pick<DownloadMessage, 'fromMe' | 'text'>): string =>
  `${m.fromMe ? 'me' : 'them'}:${m.text.replace(/\s+/g, ' ').trim()}`;

/**
 * Whether a chat moved on since it was kept: the last message on the page just read is none of those kept, so someone
 * wrote since, either of them. A page scrolled up to older messages, or read again as it was, hasn't. A chat kept with
 * nothing in it has nothing to move on from.
 */
export function movedOn(
  kept: readonly Pick<DownloadMessage, 'fromMe' | 'text'>[],
  read: readonly Pick<DownloadMessage, 'fromMe' | 'text'>[],
): boolean {
  const last = read.at(-1);
  if (!kept.length || !last) return false;
  const latest = keyOf(last);
  return !kept.some((m) => keyOf(m) === latest);
}
