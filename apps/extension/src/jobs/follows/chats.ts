/**
 * **Read my chats** on a follow network that messages (Threads', decision 167), as Instagram's ../instagram/chats.ts
 * does: its chats in the person's messages, opened one at a time by their own pages (/messages/t/<number>/) at a steady
 * pace, scrolling the list for more, each one's latest messages sent to HandsFreeOS as that network's, where the AI
 * reads them for the Chats tab. A chat whose last message is theirs goes as a sighting too (`outreach.replies.note`),
 * which counts it as a reply when it answers a message of the person's the extension noted.
 *
 * It skips chats read in the last day with nothing new and group chats, and stops after a run's worth. Nothing is
 * written or sent. It stops on any warning there.
 */
import { CHATS_PACE_SECONDS } from '@hfos/core/addons/outreach/asks';
import { NETWORKS } from '@hfos/core/addons/outreach/networks';
import { repliesInput, toSend } from '../../hfos/replies';
import { chatCollect } from '../../hfos/saves';
import type { ReplySighting } from '../../networks/facebook/replies';
import type { ChatPage } from '../../networks/facebook/types';
import { lastFromThem } from '../../networks/follows/chats';
import { FOLLOW_SPECS } from '../../networks/follows/specs';
import type { FollowChat, FollowPlatform } from '../../networks/follows/types';
import { counted } from '../../words';
import { chatMemory, type ChatMemory } from '../chats';
import { pause, paced, valueOf, warnedOn, type Job, type JobEnd } from '../job';
import { readFollowIn, signedOutEnd } from './read';

/** Between chats, a steady pace like a person's: a few seconds, never the same twice. */
const PACE_MS = [CHATS_PACE_SECONDS[0] * 1000, CHATS_PACE_SECONDS[1] * 1000] as const;
/** While a chat just opened draws, and more of the list just scrolled to. */
const OPEN_MS = 3_500;
const SCROLL_MS = 2_500;
/** Scrolls in a row that bring no new chat before it's the end of the list. */
const EMPTY_SCROLLS = 4;
/** A run's worth of chats, as the runner reads them once a day. */
export const FOLLOW_CHATS_MOST = 60;

/** A chat open on its page as the saves take it, Facebook's shape: one-to-one, with its number and their account. */
export function followChatPage(platform: FollowPlatform, chat: FollowChat): ChatPage | null {
  const m = FOLLOW_SPECS[platform].messages;
  if (!m || !chat.thread || !chat.with) return null;
  return {
    name: chat.name ?? chat.with.username,
    thread: { id: chat.thread, encrypted: false, url: m.chatUrl(chat.thread) },
    profile: { id: null, username: chat.with.username, url: chat.with.url },
    messages: chat.messages.map((m) => ({ from: m.from, sender: null, text: m.text, when: null })),
  };
}

/**
 * Goes through the person's chats there, up to `most` sent for the AI, then tells HandsFreeOS who wrote last in those
 * opened. `again` names what to press to go on, in the line it ends with.
 */
export async function readFollowChats(
  job: Job,
  platform: FollowPlatform,
  options: {
    readonly most?: number;
    readonly memory?: ChatMemory;
    readonly again?: string;
  } = {},
): Promise<JobEnd> {
  const m = FOLLOW_SPECS[platform].messages;
  const name = NETWORKS[platform].name;
  if (!m) return { line: `Nothing is read in your ${name} messages yet.`, warned: false };
  const most = options.most ?? FOLLOW_CHATS_MOST;
  const memory = options.memory ?? chatMemory;
  const again = options.again ?? 'Press Read my chats again to read more.';
  const { tab } = job;
  job.progress(`Opening your ${name} messages…`);
  await tab.open(m.inbox);
  let read = 0;
  const tried = new Set<string>();
  const seen: ReplySighting[] = [];
  let emptyScrolls = 0;
  const told = async () => {
    const fresh = toSend(seen, {}, new Date(), platform);
    if (!fresh.length) return;
    valueOf(
      await job.hfos({
        type: 'hfos-replies-note',
        input: repliesInput(job.businessId, fresh, false, platform),
      }),
    );
  };
  while (!job.stopped() && read < most) {
    // The list, beside the chat open as Messenger's is, else on its own page.
    let page = await readFollowIn(tab, platform);
    if (!page.found.chats.length && page.kind === 'chat') {
      await tab.open(m.inbox);
      page = await readFollowIn(tab, platform);
    }
    const warned = await warnedOn(job, page);
    if (warned) {
      await told();
      return warned;
    }
    if (page.signedOut) return signedOutEnd(platform);
    let next: (typeof page.found.chats)[number] | undefined;
    for (const row of page.found.chats) {
      if (!row.thread) continue;
      const key = `${platform}:${row.thread}`;
      if (tried.has(key)) continue;
      const thread = { id: key, encrypted: false, url: m.inbox };
      if (await memory.lately({ name: row.name, thread, preview: row.preview, when: row.when }))
        continue;
      next = row;
      break;
    }
    if (!next) {
      const moved =
        emptyScrolls < EMPTY_SCROLLS && (await tab.ask({ type: 'hfos-scroll-list' })).ok;
      if (!moved) break;
      emptyScrolls++;
      job.progress(`Loading more chats… ${counted(read, 'chat')} read so far.`);
      await pause(SCROLL_MS);
      continue;
    }
    emptyScrolls = 0;
    const key = `${platform}:${next.thread}`;
    tried.add(key);
    job.progress(`Reading the chat with ${next.name}… ${counted(read, 'chat')} read so far.`);
    await tab.open(m.chatUrl(next.thread!));
    await pause(OPEN_MS);
    let opened = await readFollowIn(tab, platform);
    if (opened.found.chat?.thread !== next.thread || !opened.found.chat.messages.length) {
      await pause(OPEN_MS);
      opened = await readFollowIn(tab, platform);
    }
    const warnedThere = await warnedOn(job, opened);
    if (warnedThere) {
      await told();
      return warnedThere;
    }
    const chat = opened.found.chat;
    const chatPage = chat?.thread === next.thread ? followChatPage(platform, chat) : null;
    if (chat && chatPage) {
      const built = chatCollect(chatPage, new Date(), next.when, platform);
      if (built) {
        valueOf(
          await job.hfos({
            type: 'hfos-collect-chats',
            input: { workspaceId: job.businessId, platform, chats: [built] },
          }),
        );
        read++;
      }
      const theirs = lastFromThem(chat);
      if (theirs) seen.push({ ...theirs, when: next.when });
    }
    // Group chats, and one that didn't open, wait for a day with something new.
    await memory.remember(key, next.preview ?? next.when);
    if (!job.stopped()) await pause(paced(PACE_MS));
  }
  await told();
  const wrote = seen.length ? ` ${counted(seen.length, 'chat')} had their message last.` : '';
  return {
    line: job.stopped()
      ? `Stopped. ${counted(read, 'chat')} sent for the AI to read.${wrote}`
      : read >= most
        ? `${counted(read, 'chat')} sent for the AI to read.${wrote} ${again}`
        : `Done: ${counted(read, 'chat')} sent for the AI to read.${wrote} Chats read in the last day were left as they were.`,
    warned: false,
  };
}
