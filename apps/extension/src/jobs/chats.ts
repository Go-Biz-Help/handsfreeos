/**
 * **Read my chats** (docs/outreach.md, decision 2's "Collect from Facebook"): without Facebook's file, it goes through
 * the person's one-to-one chats in Messenger, one at a time from the list beside it, at a steady pace, scrolling the
 * list for more (src/facebook/browse.ts), and sends each one's latest few messages to HandsFreeOS, where the AI reads
 * them for the Chats tab. It skips chats read in the last day with nothing new, and stops after a run's worth. Group
 * chats are left out, and nothing is sent on Facebook.
 */
import type { ChatPage, ChatSummary } from '../facebook/types';
import type { ChatsCollected } from '../hfos/messages';
import { CHATS_PACE_SECONDS } from '@hfos/core/addons/outreach/asks';
import { chatCollect } from '../hfos/saves';
import { counted } from '../words';
import { pause, paced, readIn, valueOf, warnedOn, type Hfos, type Job, type JobEnd } from './job';

/** Messenger's list of chats. */
export const MESSENGER = 'https://www.facebook.com/messages/';
/** Between chats, a steady pace like a person's: a few seconds, never the same twice. */
const PACE_MS = [CHATS_PACE_SECONDS[0] * 1000, CHATS_PACE_SECONDS[1] * 1000] as const;
/** While Facebook draws a chat just opened, and more of the list just scrolled to. */
const OPEN_MS = 3_500;
const SCROLL_MS = 2_500;
/** Scrolls in a row that bring no new chat before it's the end of the list. */
const EMPTY_SCROLLS = 4;
/** A chat read in the last day with the same last message isn't read again. */
const AGAIN_MS = 24 * 3_600_000;
/** The most chats remembered as read. */
const REMEMBERED = 3_000;
/** Where the chats read lately are kept, for the panel and the runner alike. */
const DONE_KEY = 'hfos.chatsRead';

interface DoneChat {
  readonly at: number;
  readonly last: string | null;
}

async function doneChats(): Promise<Record<string, DoneChat>> {
  try {
    const stored: unknown = (await chrome.storage.local.get(DONE_KEY))[DONE_KEY];
    return typeof stored === 'object' && stored !== null
      ? (stored as Record<string, DoneChat>)
      : {};
  } catch {
    return {};
  }
}

/** Which chats were read lately, kept in the extension's storage. */
export interface ChatMemory {
  lately(chat: ChatSummary): Promise<boolean>;
  remember(threadId: string, last: string | null): Promise<void>;
}

export const chatMemory: ChatMemory = {
  /** Read in the last day, and the list says nothing newer since. */
  async lately(chat) {
    const had = (await doneChats())[chat.thread.id];
    return !!had && Date.now() - had.at < AGAIN_MS && had.last === (chat.preview ?? chat.when);
  },
  async remember(threadId, last) {
    const done = await doneChats();
    done[threadId] = { at: Date.now(), last };
    const ids = Object.keys(done);
    if (ids.length > REMEMBERED)
      for (const id of ids
        .sort((a, b) => done[a]!.at - done[b]!.at)
        .slice(0, ids.length - REMEMBERED))
        delete done[id];
    await chrome.storage.local.set({ [DONE_KEY]: done }).catch(() => undefined);
  },
};

/** What was last sent for each chat, so a chat read again with nothing new isn't sent again. */
const sent = new Map<string, string>();

function words(name: string, got: ChatsCollected): string {
  if (!got.saved) return `Nothing new with ${name}.`;
  return got.waiting
    ? `Sent the chat with ${name} for the AI to read.`
    : `Kept the chat with ${name}.`;
}

/** Sends a chat for the AI. What came of it, in words; null when there was nothing new to send. */
export async function sendChat(
  hfos: Hfos,
  businessId: string,
  memory: ChatMemory,
  chat: ChatPage,
  listed: ChatSummary | null,
): Promise<string | null> {
  const built = chatCollect(chat, new Date(), listed?.when);
  if (!built) return null;
  const key = JSON.stringify(built.messages);
  if (sent.get(built.thread.id) === key) return null;
  const got = valueOf(
    await hfos({
      type: 'hfos-collect-chats',
      input: { workspaceId: businessId, platform: 'facebook', chats: [built] },
    }),
  );
  sent.set(built.thread.id, key);
  await memory.remember(built.thread.id, listed ? (listed.preview ?? listed.when) : null);
  return words(built.name, got);
}

/**
 * Goes through the chats in Messenger, up to `most` sent for the AI. `said` hears each chat sent, in words. `again`
 * names the button to press to go on, in the line it ends with.
 */
export async function readChats(
  job: Job,
  options: {
    readonly most: number;
    readonly memory: ChatMemory;
    readonly said?: (line: string) => void;
    readonly again: string;
  },
): Promise<JobEnd> {
  const { tab } = job;
  let read = 0;
  job.progress('Opening Messenger…');
  // A tab not opened yet has nothing to read: Messenger first.
  const first = await readIn(tab).catch(() => null);
  if (!first || (first.kind !== 'chats' && first.kind !== 'chat')) await tab.open(MESSENGER);
  const tried = new Set<string>();
  let emptyScrolls = 0;
  while (!job.stopped() && read < options.most) {
    const page = await readIn(tab);
    const warned = await warnedOn(job, page);
    if (warned) return warned;
    let next: ChatSummary | undefined;
    for (const chat of page.chats ?? [])
      if (!tried.has(chat.thread.id) && !(await options.memory.lately(chat))) {
        next = chat;
        break;
      }
    if (!next) {
      const moved =
        emptyScrolls < EMPTY_SCROLLS && (await tab.ask({ type: 'hfos-scroll-chats' })).ok;
      if (!moved) break;
      emptyScrolls++;
      job.progress(`Loading more chats… ${counted(read, 'chat')} read so far.`);
      await pause(SCROLL_MS);
      continue;
    }
    emptyScrolls = 0;
    tried.add(next.thread.id);
    job.progress(`Reading the chat with ${next.name}… ${counted(read, 'chat')} read so far.`);
    if (!(await tab.ask({ type: 'hfos-open-chat', threadId: next.thread.id })).ok)
      await tab.open(next.thread.url);
    await pause(OPEN_MS);
    let opened = await readIn(tab);
    if (opened.chat?.thread?.id !== next.thread.id) {
      await pause(OPEN_MS);
      opened = await readIn(tab);
    }
    if (opened.chat?.thread?.id === next.thread.id) {
      const said = await sendChat(job.hfos, job.businessId, options.memory, opened.chat, next);
      if (said) {
        read++;
        options.said?.(said);
      } else await options.memory.remember(next.thread.id, next.preview ?? next.when);
    }
    if (!job.stopped()) await pause(paced(PACE_MS));
  }
  return {
    line: job.stopped()
      ? `Stopped. ${counted(read, 'chat')} sent for the AI to read.`
      : read >= options.most
        ? `${counted(read, 'chat')} sent for the AI to read. ${options.again}`
        : `Done: ${counted(read, 'chat')} sent for the AI to read. Chats read in the last day were left as they were.`,
    warned: false,
  };
}
