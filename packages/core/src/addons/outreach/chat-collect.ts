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
  /**
   * Who wrote back, by profile, as the chats read showed it (decision 150): their runner drafts the answer next. Left
   * out by a HandsFreeOS from before it.
   */
  replied: z.array(z.uuid()).optional(),
});
export type ChatsCollectOutput = z.output<typeof ChatsCollectOutput>;

/** The line Messenger puts under the person's last message: "Sent 33m ago", "Seen 2h ago", "Delivered". */
export const STATUS_LINE = /^(?:sent|seen|delivered)(?: by .+| just now| \d+\s*[a-z]+ ago)?$/i;
/** Facebook's own line at the top of an encrypted chat, which nobody in it wrote. */
const ENCRYPTED = /^(?:new )?messages and calls are secured with end-to-end encryption\b/i;
/**
 * A message of the person's with no words in it, only Messenger's line under it: a picture, a sticker, a like or a
 * file. It stays, as this, so their chat still ends with them and nothing of theirs is answered twice.
 */
export const WORDLESS = '(a picture, sticker or file)';

/**
 * What a message says, without what Messenger says about it. An extension before 0.147.8 read the line under the
 * person's last message ("Sent 33m ago") as part of it, so the same message came in with new words at each read and
 * was kept again (the owner's screenshots, 17 Nov 2026), and Facebook's line about an encrypted chat as theirs. A
 * message of the person's that was only that line is `WORDLESS`; Facebook's line about encryption is nothing.
 */
export function withoutStatus(text: string, fromMe: boolean): string {
  const lines = text.trim().split('\n');
  let status = false;
  while (lines.length && STATUS_LINE.test(lines.at(-1)!.trim())) {
    lines.pop();
    status = true;
  }
  const said = lines.join('\n').trim();
  if (!said) return status && fromMe ? WORDLESS : '';
  return ENCRYPTED.test(said) ? '' : said;
}

/** A message as two reads of a chat compare it: who wrote it and its words, whatever time each read gave it. */
const keyOf = (m: Pick<DownloadMessage, 'fromMe' | 'text'>): string =>
  `${m.fromMe ? 'me' : 'them'}:${withoutStatus(m.text, m.fromMe).replace(/\s+/g, ' ').trim()}`;

/** Messages with what Messenger says about them left off (`withoutStatus`), and Facebook's own left out. */
const saidOnly = (messages: readonly DownloadMessage[]): DownloadMessage[] =>
  messages.flatMap((m) => {
    const text = withoutStatus(m.text, m.fromMe);
    return !text ? [] : text === m.text ? [m] : [{ ...m, text }];
  });

/**
 * What was kept and what's new, the latest few, oldest first, each once. The same message read again is known by who
 * wrote it and its words, never by its time: Instagram's messages show none, so each read gives them the time the
 * chat's row in the list says, which moves on as the day does, and other networks' times shift as a page scrolls ("Mon"
 * one week, a date the next). Kept by time, one message sent once showed up again with each read (the owner's
 * screenshot, 17 Nov 2026). A read is the chat in order, so its messages are matched to those kept in order, the most
 * that line up, and a message said twice in the chat stays twice. One kept keeps its time; a new one goes where the
 * page put it, its time kept between those around it, and the ones kept and read between two matched fall in by time.
 * What Messenger says about a message is left off it (`withoutStatus`).
 */
export function mergeRecent(
  keptAsIs: readonly DownloadMessage[],
  readAsIs: readonly DownloadMessage[],
): DownloadMessage[] {
  const kept = saidOnly(keptAsIs);
  const read = saidOnly(readAsIs);
  const k = kept.map(keyOf);
  const r = read.map(keyOf);
  // The longest run of messages both have in the same order, worked out from the end.
  const most = Array.from({ length: k.length + 1 }, () => new Array<number>(r.length + 1).fill(0));
  for (let i = k.length - 1; i >= 0; i--)
    for (let j = r.length - 1; j >= 0; j--)
      most[i]![j] =
        k[i] === r[j] ? most[i + 1]![j + 1]! + 1 : Math.max(most[i + 1]![j]!, most[i]![j + 1]!);
  const all: { readonly m: DownloadMessage; readonly kept: boolean }[] = [];
  let keptBetween: DownloadMessage[] = [];
  let readBetween: DownloadMessage[] = [];
  // Those kept and read between two matched ones, by time: a tie puts the kept one first.
  const between = () => {
    let a = 0;
    let b = 0;
    while (a < keptBetween.length || b < readBetween.length) {
      const fromRead =
        a >= keptBetween.length ||
        (b < readBetween.length && Date.parse(readBetween[b]!.at) < Date.parse(keptBetween[a]!.at));
      all.push(
        fromRead ? { m: readBetween[b++]!, kept: false } : { m: keptBetween[a++]!, kept: true },
      );
    }
    keptBetween = [];
    readBetween = [];
  };
  let i = 0;
  let j = 0;
  while (i < k.length || j < r.length) {
    if (i < k.length && j < r.length && k[i] === r[j]) {
      between();
      all.push({ m: kept[i]!, kept: true });
      i++;
      j++;
    } else if (j >= r.length || (i < k.length && most[i + 1]![j]! >= most[i]![j + 1]!))
      keptBetween.push(kept[i++]!);
    else readBetween.push(read[j++]!);
  }
  between();
  // A new message's time sits between those around it, so the latest is last.
  const times = all.map(({ m }) => Date.parse(m.at));
  for (let x = 1; x < all.length; x++)
    if (!all[x]!.kept) times[x] = Math.max(times[x]!, times[x - 1]!);
  for (let x = all.length - 2; x >= 0; x--)
    if (!all[x]!.kept) times[x] = Math.min(times[x]!, times[x + 1]!);
  return all
    .map(({ m, kept }, x) =>
      kept || times[x] === Date.parse(m.at) ? m : { ...m, at: new Date(times[x]!).toISOString() },
    )
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
