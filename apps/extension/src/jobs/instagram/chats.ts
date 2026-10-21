/**
 * **Read my chats** on Instagram (the Instagram and Alignable plan's part 13 and its "The inbox": Chris works from his
 * personal account, so his replies come in as LinkedIn's do, through the extension reading his messages). It goes
 * through the person's chats in their messages (/direct/inbox/), one at a time from the list beside them, at a steady
 * pace, scrolling the list for more, and sends each one's latest messages to HandsFreeOS as Instagram's, with its id
 * from its address (/direct/t/<id>/), where the AI reads them for the Chats tab. Instagram's rows are buttons, not
 * links (the owner's Check, 0.62.0), so each is opened by pressing its row, found by the name it shows, as a person
 * reading their messages does.
 *
 * It notes who wrote last: a chat whose last message is theirs goes to HandsFreeOS as a sighting
 * (`outreach.replies.note`), which counts it as a reply when it answers a message of the person's the extension noted.
 * It skips chats read in the last day with nothing new, leaves group chats and the Requests box alone (nothing there is
 * accepted or opened), and stops after a run's worth. Nothing is written or sent on Instagram. It stops on any
 * Instagram warning.
 */
import { CHATS_PACE_SECONDS } from '@hfos/core/addons/outreach/asks';
import { repliesInput, toSend } from '../../hfos/replies';
import { chatCollect } from '../../hfos/saves';
import type { ReplySighting } from '../../networks/facebook/replies';
import type { ChatPage } from '../../networks/facebook/types';
import type { ChatOpen, ChatRow } from '../../networks/instagram/read';
import { lastFromThem } from '../../networks/instagram/replies';
import { counted } from '../../words';
import type { ChatMemory } from '../chats';
import { pause, paced, valueOf, warnedOn, type Job, type JobEnd } from '../job';
import { INSTAGRAM, readInstagramIn, signedOutEnd, type InstagramPage } from './read';

/** Their messages: the chats with the people they follow, and those who follow them. Never the Requests box. */
export const INBOX = `${INSTAGRAM}/direct/inbox/`;
/** A chat's own page. */
export const chatUrl = (id: string) => `${INSTAGRAM}/direct/t/${id}/`;

/** Between chats, a steady pace like a person's: a few seconds, never the same twice. */
const PACE_MS = [CHATS_PACE_SECONDS[0] * 1000, CHATS_PACE_SECONDS[1] * 1000] as const;
/** While Instagram draws a chat just opened, and more of the list just scrolled to. */
const OPEN_MS = 3_500;
const SCROLL_MS = 2_500;
/** Scrolls in a row that bring no new chat before it's the end of the list. */
const EMPTY_SCROLLS = 4;

/** A chat's key in what was read lately: its id when its row links to it, else the name its row shows. */
const keyOf = (row: ChatRow) => `instagram:${row.thread ?? row.name.toLowerCase()}`;

/** A chat open on its page as the saves take it, Facebook's shape: one-to-one, with its id and their account. */
export function chatPageOf(chat: ChatOpen): ChatPage | null {
  if (!chat.thread || !chat.with) return null;
  return {
    name: chat.name ?? chat.with.username,
    thread: { id: chat.thread, encrypted: false, url: chatUrl(chat.thread) },
    profile: { id: null, username: chat.with.username, url: chat.with.url },
    messages: chat.messages.map((m) => ({ from: m.from, sender: null, text: m.text, when: null })),
  };
}

/** Whether the chat open is the row pressed: by the name it shows, or a new one-to-one chat opened by the press. */
function isRow(chat: ChatOpen | null, row: ChatRow, before: string | null): chat is ChatOpen {
  if (!chat?.thread || !chat.with) return false;
  const name = row.name.trim().toLowerCase();
  if (chat.name?.trim().toLowerCase() === name || chat.with.username.toLowerCase() === name)
    return true;
  return chat.thread !== before;
}

/**
 * Goes through the person's Instagram chats, up to `most` sent for the AI, then tells HandsFreeOS who wrote last in
 * those opened. `again` names what to press to go on, in the line it ends with.
 */
export async function readInstagramChats(
  job: Job,
  options: { readonly most: number; readonly memory: ChatMemory; readonly again: string },
): Promise<JobEnd> {
  const { tab } = job;
  job.progress('Opening your Instagram messages…');
  await tab.open(INBOX);
  let read = 0;
  const tried = new Set<string>();
  const seen: ReplySighting[] = [];
  let open: string | null = null;
  let emptyScrolls = 0;
  const told = async () => {
    const fresh = toSend(seen, {}, new Date(), 'instagram');
    if (!fresh.length) return;
    valueOf(
      await job.hfos({
        type: 'hfos-replies-note',
        input: repliesInput(job.businessId, fresh, false, 'instagram'),
      }),
    );
  };
  while (!job.stopped() && read < options.most) {
    const page: InstagramPage = await readInstagramIn(tab);
    const warned = await warnedOn(job, page);
    if (warned) {
      await told();
      return warned;
    }
    if (page.signedOut) return signedOutEnd();
    let next: ChatRow | undefined;
    for (const row of page.found.chats) {
      const key = keyOf(row);
      if (tried.has(key)) continue;
      const thread = { id: key, encrypted: false, url: INBOX };
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
      job.progress(`Loading more chats… ${counted(read, 'chat')} read so far.`);
      await pause(SCROLL_MS);
      continue;
    }
    emptyScrolls = 0;
    const key = keyOf(next);
    tried.add(key);
    job.progress(`Reading the chat with ${next.name}… ${counted(read, 'chat')} read so far.`);
    const pressed = next.thread
      ? (await tab.open(chatUrl(next.thread)), true)
      : (await tab.ask({ type: 'hfos-open-chat', threadId: '', name: next.name })).ok;
    if (pressed) {
      await pause(OPEN_MS);
      let opened = await readInstagramIn(tab);
      if (!isRow(opened.found.chat, next, open)) {
        await pause(OPEN_MS);
        opened = await readInstagramIn(tab);
      }
      const warnedThere = await warnedOn(job, opened);
      if (warnedThere) {
        await told();
        return warnedThere;
      }
      const chat = opened.found.chat;
      if (isRow(chat, next, open)) {
        open = chat.thread;
        const built = chatCollect(chatPageOf(chat)!, new Date(), next.when, 'instagram');
        if (built) {
          valueOf(
            await job.hfos({
              type: 'hfos-collect-chats',
              input: { workspaceId: job.businessId, platform: 'instagram', chats: [built] },
            }),
          );
          read++;
        }
        const theirs = lastFromThem(chat);
        if (theirs) seen.push({ ...theirs, when: next.when });
      }
    }
    // Group chats, and one that didn't open, wait for a day with something new.
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
