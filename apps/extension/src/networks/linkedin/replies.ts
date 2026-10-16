/**
 * Conversations on a LinkedIn messaging page whose last message is theirs (docs/outreach.md, decision 22, as
 * ../facebook/replies.ts finds Facebook's), for HandsFreeOS to tell the person's phone who wrote back: in the list of
 * conversations, a line that doesn't start "You:" ("Dana: Tuesday works"); and the conversation open beside it, where
 * the last message is theirs. Only who it's with and when, by the conversation's id or their profile: never what they
 * wrote. A conversation with more than one other person is left out. HandsFreeOS counts one only when it answers a
 * message of the person's that the extension noted.
 */
import type { ChatOptions } from '../facebook/chat';
import { clean } from '../facebook/dom';
import type { ReplySighting } from '../facebook/replies';
import { readChat } from './chat';
import { readChats } from './chats';
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
  for (const chat of readChats(mainOf(doc), href)) {
    const said = clean(chat.preview);
    if (!said || MINE.test(said) || NOT_A_MESSAGE.test(said) || SEVERAL.test(chat.name)) continue;
    found.push({ name: chat.name, threadKey: chat.thread.id, profile: null, when: chat.when });
  }
  if (address.kind === 'chat') {
    const open = lastFromThem(readChat(doc, address, href, options), address.thread);
    if (open) found.push(open);
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
