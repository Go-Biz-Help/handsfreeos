/**
 * Conversations on a LinkedIn messaging page whose last message is theirs (docs/outreach.md, decision 22, as
 * ../facebook/replies.ts finds Facebook's), for HandsFreeOS to tell the person's phone who wrote back: in the list of
 * conversations, a line that doesn't start "You:" ("Dana: Tuesday works"); and the conversation open beside it, where
 * the last message is theirs. Only who it's with and when, by the conversation's id or their profile: never what they
 * wrote. A conversation with more than one other person is left out. HandsFreeOS counts one only when it answers a
 * message of the person's that the extension noted.
 *
 * LinkedIn's newer list links to no conversation (the owner's Check LinkedIn of 29 Oct 2026), so a row there goes by
 * the name it shows, and HandsFreeOS takes it only when one person the person messaged there goes by it. Until 0.116.0
 * those rows were never read, so the messaging page kept open (decision 125) saw only the conversation open on it.
 */
import type { ChatOptions } from '../facebook/chat';
import { clean } from '../facebook/dom';
import type { ReplySighting } from '../facebook/replies';
import { readChat } from './chat';
import { listedRows, readChats } from './chats';
import { mainOf } from './dom';
import type { ChatPage, ThreadRef } from './types';
import { classifyUrl } from './urls';

/** The last thing said, in the list, was the person's own: "You: see you then", "You sent an attachment". */
const MINE = /^you(:|\s+(sent|replied|reacted|shared|forwarded|unsent|started|accepted)\b)/i;
/** Not a message: someone reacting, typing, an ad, LinkedIn saying something happened. */
const NOT_A_MESSAGE =
  /\b(reacted|is typing|sponsored|inmail|accepted your invitation|you['’]re now connected|now connected|unsent a message|left the conversation|added .+ to the conversation)\b/i;
/** More than one other person: "Dana Reyes, Sam Lee and Avery Lane". */
const SEVERAL = /,|\band\b/i;
/** LinkedIn writing to the person itself. */
const LINKEDIN = /^linkedin$/i;

const nameKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

/** Whether a line in the list is theirs: not the person's ("You: …"), not a reaction, an ad or LinkedIn saying so. */
const theirsSaid = (said: string, name: string) =>
  !!said &&
  !MINE.test(said) &&
  !NOT_A_MESSAGE.test(said) &&
  !SEVERAL.test(name) &&
  !LINKEDIN.test(name);

/** The open conversation, when its last message is theirs and it's with one person. */
function lastFromThem(chat: ChatPage, thread: ThreadRef | null): ReplySighting | null {
  const last = chat.messages[chat.messages.length - 1];
  if (!last || last.from !== 'them' || !chat.name || SEVERAL.test(chat.name)) return null;
  const threadKey = (chat.thread ?? thread)?.id ?? null;
  if (!threadKey && !chat.profile) return null;
  return { name: chat.name, threadKey, profile: chat.profile, when: null };
}

export function readReplies(
  doc: Document,
  href: string,
  options: ChatOptions = {},
): ReplySighting[] {
  const address = classifyUrl(href);
  if (address.kind !== 'messaging' && address.kind !== 'chat') return [];
  const found: ReplySighting[] = [];
  const linked = readChats(mainOf(doc), href);
  for (const chat of linked)
    if (theirsSaid(clean(chat.preview), chat.name))
      found.push({ name: chat.name, threadKey: chat.thread.id, profile: null, when: chat.when });
  const open =
    address.kind === 'chat'
      ? lastFromThem(readChat(doc, address, href, options), address.thread)
      : null;
  if (open) found.push(open);
  // The rows that link to no conversation go by the name they show, but for the one open, which says who it's with.
  const named = new Set(linked.map((chat) => nameKey(chat.name)));
  for (const row of listedRows(mainOf(doc))) {
    if (named.has(nameKey(row.name)) || !theirsSaid(clean(row.preview), row.name)) continue;
    if (open && nameKey(open.name) === nameKey(row.name)) {
      found[found.indexOf(open)] = { ...open, when: open.when ?? row.when };
      continue;
    }
    named.add(nameKey(row.name));
    found.push({ name: row.name, threadKey: null, profile: null, when: row.when });
  }
  // Each conversation once: the open one says who it's with, and the list when they wrote.
  const byKey = new Map<string, ReplySighting>();
  for (const s of found) {
    const key = s.threadKey ?? `${s.profile?.id ?? ''}|${s.profile?.username ?? ''}|${s.name}`;
    const had = byKey.get(key);
    byKey.set(key, had && !s.profile ? had : { ...s, when: had?.when ?? s.when });
  }
  return [...byKey.values()];
}
