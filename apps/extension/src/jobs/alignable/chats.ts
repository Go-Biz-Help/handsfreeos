/**
 * **Read my chats** on Alignable (0.84.0; the Instagram and Alignable plan's "The inbox", as Instagram's ../instagram/
 * chats.ts reads its): it goes through the person's conversations down the side of Alignable's Messages
 * (/biz/conversations), one at a time, at a steady pace, scrolling that list for more, and sends each one's latest
 * messages to HandsFreeOS as Alignable's, keyed by Alignable's id for the business it's with (its header's link, the
 * id the conversation opens by: /biz/conversations?with_business_id=<id>), where the AI reads them for the Chats tab.
 * Alignable's rows aren't links (the owner's Check, 0.68.0), so each is opened by pressing its row, found by the name it
 * shows, as a person reading their messages does.
 *
 * It notes who wrote last: a conversation whose last message is theirs goes to HandsFreeOS as a sighting
 * (`outreach.replies.note`), which counts it as a reply when it answers a message of the person's the extension noted.
 * It skips conversations with no messages yet and those read in the last day with nothing new, and stops after a run's
 * worth. Nothing is written or sent on Alignable. It stops on any Alignable warning.
 */
import { CHATS_PACE_SECONDS } from '@hfos/core/addons/outreach/asks';
import { chatUrlOn } from '@hfos/core/addons/outreach/network-words';
import { repliesInput, toSend } from '../../hfos/replies';
import { chatCollect } from '../../hfos/saves';
import type { ChatOpen, ChatRow } from '../../networks/alignable/read';
import { lastFromThem } from '../../networks/alignable/replies';
import type { ReplySighting } from '../../networks/facebook/replies';
import type { ChatPage } from '../../networks/facebook/types';
import { counted } from '../../words';
import type { ChatMemory } from '../chats';
import { pause, paced, valueOf, warnedOn, type Job, type JobEnd } from '../job';
import { ALIGNABLE, readAlignableIn, signedOutEnd, type AlignablePage } from './read';

/** Their messages, with their conversations down the side. */
export const MESSAGES = `${ALIGNABLE}/biz/conversations`;

/** Between conversations, a steady pace like a person's: a few seconds, never the same twice. */
const PACE_MS = [CHATS_PACE_SECONDS[0] * 1000, CHATS_PACE_SECONDS[1] * 1000] as const;
/** While Alignable draws a conversation just opened, and more of the list just scrolled to. */
const OPEN_MS = 3_000;
const SCROLL_MS = 2_500;
/** Scrolls in a row that bring no new conversation before it's the end of the list. */
const EMPTY_SCROLLS = 4;

/** A conversation's key in what was read lately: the name its row shows, as its rows carry no id. */
const keyOf = (row: ChatRow) => `alignable:${row.name.toLowerCase()}`;

/**
 * The conversation open as the saves take it, Facebook's shape: with the one business its header links to by
 * Alignable's id, which is the conversation's own key.
 */
export function chatPageOf(chat: ChatOpen): ChatPage | null {
  const id = chat.profile?.id;
  const url = id ? chatUrlOn('alignable', id) : null;
  if (!id || !url || !chat.profile) return null;
  return {
    name: chat.name ?? '',
    thread: { id, encrypted: false, url },
    profile: chat.profile,
    messages: chat.messages.map((m) => ({
      from: m.from,
      sender: null,
      text: m.text,
      when: m.when,
    })),
  };
}

/** Whether the conversation open is the row pressed: by the name it shows, or a new business opened by the press. */
function isRow(chat: ChatOpen | null, row: ChatRow, before: string | null): chat is ChatOpen {
  const id = chat?.profile?.id;
  if (!chat || !id) return false;
  if (chat.name?.trim().toLowerCase() === row.name.trim().toLowerCase()) return true;
  return before !== null && id !== before;
}

/**
 * Goes through the person's Alignable conversations, up to `most` sent for the AI, then tells HandsFreeOS who wrote
 * last in those opened. `again` names what to press to go on, in the line it ends with.
 */
export async function readAlignableChats(
  job: Job,
  options: { readonly most: number; readonly memory: ChatMemory; readonly again: string },
): Promise<JobEnd> {
  const { tab } = job;
  job.progress('Opening your Alignable messages…');
  await tab.open(MESSAGES);
  let read = 0;
  const tried = new Set<string>();
  const seen: ReplySighting[] = [];
  // The business of the conversation Messages opens on: pressing another row changes it.
  let open: string | null = null;
  let emptyScrolls = 0;
  const told = async () => {
    const fresh = toSend(seen, {}, new Date(), 'alignable');
    if (!fresh.length) return;
    valueOf(
      await job.hfos({
        type: 'hfos-replies-note',
        input: repliesInput(job.businessId, fresh, false, 'alignable'),
      }),
    );
  };
  while (!job.stopped() && read < options.most) {
    const page: AlignablePage = await readAlignableIn(tab);
    const warned = await warnedOn(job, page);
    if (warned) {
      await told();
      return warned;
    }
    if (page.signedOut) return signedOutEnd();
    open ??= page.found.chat?.profile?.id ?? null;
    let next: ChatRow | undefined;
    for (const row of page.found.chats) {
      const key = keyOf(row);
      // A conversation with no messages yet shows nothing under its name: nothing to read.
      if (tried.has(key) || !row.preview) continue;
      const thread = { id: key, encrypted: false, url: MESSAGES };
      if (
        await options.memory.lately({
          name: row.name,
          thread,
          preview: row.preview,
          when: row.when,
        })
      )
        continue;
      next = row;
      break;
    }
    if (!next) {
      const moved =
        emptyScrolls < EMPTY_SCROLLS && (await tab.ask({ type: 'hfos-scroll-list' })).ok;
      if (!moved) break;
      emptyScrolls++;
      job.progress(`Loading more conversations… ${counted(read, 'chat')} read so far.`);
      await pause(SCROLL_MS);
      continue;
    }
    emptyScrolls = 0;
    const key = keyOf(next);
    tried.add(key);
    job.progress(`Reading the chat with ${next.name}… ${counted(read, 'chat')} read so far.`);
    const pressed = (await tab.ask({ type: 'hfos-open-chat', threadId: '', name: next.name })).ok;
    if (pressed) {
      await pause(OPEN_MS);
      let opened = await readAlignableIn(tab);
      if (!isRow(opened.found.chat, next, open)) {
        await pause(OPEN_MS);
        opened = await readAlignableIn(tab);
      }
      const warnedThere = await warnedOn(job, opened);
      if (warnedThere) {
        await told();
        return warnedThere;
      }
      const chat = opened.found.chat;
      if (isRow(chat, next, open)) {
        open = chat.profile!.id;
        const built = chatCollect(chatPageOf(chat)!, new Date(), next.when, 'alignable');
        if (built) {
          valueOf(
            await job.hfos({
              type: 'hfos-collect-chats',
              input: { workspaceId: job.businessId, platform: 'alignable', chats: [built] },
            }),
          );
          read++;
        }
        const theirs = lastFromThem(chat);
        if (theirs) seen.push({ ...theirs, when: next.when });
      }
    }
    // One that didn't open waits for a day with something new.
    await options.memory.remember(key, next.preview ?? next.when);
    if (!job.stopped()) await pause(paced(PACE_MS));
  }
  await told();
  const wrote = seen.length ? ` ${counted(seen.length, 'chat')} had their message last.` : '';
  return {
    line: job.stopped()
      ? `Stopped. ${counted(read, 'chat')} sent for the AI to read.${wrote}`
      : read >= options.most
        ? `${counted(read, 'chat')} sent for the AI to read.${wrote} ${options.again}`
        : `Done: ${counted(read, 'chat')} sent for the AI to read.${wrote} Chats read in the last day were left as they were.`,
    warned: false,
  };
}
