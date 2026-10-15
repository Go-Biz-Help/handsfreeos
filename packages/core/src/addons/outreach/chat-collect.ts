/**
 * Chats read in Messenger, without Facebook's file (docs/outreach.md, decision 2's "Collect from Facebook"): the
 * extension reads each one-to-one chat in the person's browser, as they open it or as it goes through their chats at
 * a steady pace, and sends its latest few messages, each with when it was sent. They join the chats from the file,
 * one per person, for the AI to read (./chat-read.ts). Browser-safe: the extension builds what it sends with these.
 */
import { z } from 'zod';
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
