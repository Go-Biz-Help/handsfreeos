/**
 * Chats on the page whose last message is theirs (docs/outreach.md, decision 22), for HandsFreeOS to tell the person's
 * phone who wrote back. Three places show one: Messenger's list of chats, where the last thing said is under each
 * name and the person's own starts "You:"; the chat open on a chat's own page; and the small chat windows over any
 * other page. Only who it's with and when: never what they wrote. HandsFreeOS counts one only when it answers a
 * message of the person's that the extension noted.
 */
import { isConversation, readChat, readChatIn, type ChatOptions } from './chat';
import { readChats } from './chats';
import { clean } from './dom';
import { peopleLinked } from './people';
import type { ChatPage, ProfileRef, ThreadRef } from './types';
import { classifyUrl, facebookUrl, threadFromUrl } from './urls';

export interface ReplySighting {
  readonly name: string;
  /** The chat's number, from its link. */
  readonly threadKey: string | null;
  readonly profile: ProfileRef | null;
  /** When the list said it was written ("3h"); null in an open chat, where it's in front of them. */
  readonly when: string | null;
}

/** The last thing said, in the list, was the person's own: "You: see you then", "You sent a photo". */
const MINE =
  /^you(:|\s+(sent|replied|reacted|forwarded|unsent|called|missed|started|named|changed|added|removed|left)\b)/i;
/** Not a message: someone reacting, a call, or Facebook saying something happened. */
const NOT_A_MESSAGE =
  /\b(reacted|is typing|are typing|missed (a |your )?(video )?call|called you|call ended|you are now connected|you['’]re now friends|say hi to|unsent a message|named the group|left the group|joined the group|changed the)\b/i;
/** How far up from a chat's messages a small chat window's header can be. */
const WINDOW_STEPS = 10;

/** Only digits name a chat that HandsFreeOS knows by its number. */
const keyOf = (thread: ThreadRef | null) =>
  thread && /^[0-9]{1,30}$/.test(thread.id) ? thread.id : null;

/** The chat as read, when its last message is theirs. */
function lastFromThem(chat: ChatPage, thread: ThreadRef | null): ReplySighting | null {
  const last = chat.messages[chat.messages.length - 1];
  if (!last || last.from !== 'them' || !chat.name) return null;
  const threadKey = keyOf(chat.thread ?? thread);
  if (!threadKey && !chat.profile) return null;
  return { name: chat.name, threadKey, profile: chat.profile, when: null };
}

/**
 * The small chat window around a chat's messages, over a page that isn't the chat's own: the nearest box around them
 * that links to someone outside them, as the window's header does. Never the main column, and never a box with a
 * second chat in it.
 */
function windowAround(conversation: Element, main: Element, base: string): Element | null {
  let up = conversation.parentElement;
  for (let steps = 0; up && steps < WINDOW_STEPS; steps++, up = up.parentElement) {
    if (up.contains(main) || main.contains(up)) return null;
    const here = up;
    if ([...here.querySelectorAll('[aria-label]')].filter(isConversation).length > 1) return null;
    const outside = [...here.querySelectorAll('a[href]')].filter(
      (anchor) => !conversation.contains(anchor),
    );
    if (peopleLinked(outside, base).length > 0) return here;
  }
  return null;
}

/** The chat window's own link, to its chat: /messages/t/… */
function threadIn(scope: Element, base: string): ThreadRef | null {
  for (const anchor of scope.querySelectorAll('a[href]')) {
    const url = facebookUrl(anchor.getAttribute('href') ?? '', base);
    const thread = url ? threadFromUrl(url) : null;
    if (thread) return thread;
  }
  return null;
}

export function readReplies(
  doc: Document,
  href: string,
  options: ChatOptions = {},
): ReplySighting[] {
  const address = classifyUrl(href);
  const main = doc.querySelector('[role="main"]') ?? doc.body;
  const found: ReplySighting[] = [];

  // Messenger's list of chats, wherever on the page it is.
  if (address.kind === 'chats' || address.kind === 'chat') {
    for (const chat of readChats(doc.body, href)) {
      const said = clean(chat.preview);
      if (!said || MINE.test(said) || NOT_A_MESSAGE.test(said)) continue;
      const threadKey = keyOf(chat.thread);
      if (threadKey) found.push({ name: chat.name, threadKey, profile: null, when: chat.when });
    }
  }
  // The chat open on its own page.
  if (address.kind === 'chat') {
    const open = lastFromThem(readChat(doc, address, href, options), address.thread);
    if (open) found.push(open);
  } else {
    // The small chat windows over any other page.
    for (const conversation of doc.querySelectorAll('[aria-label]')) {
      if (!isConversation(conversation) || main.contains(conversation)) continue;
      const box = windowAround(conversation, main, href);
      if (!box) continue;
      const thread = threadIn(box, href);
      const seen = lastFromThem(readChatIn(box, thread, href, options), thread);
      if (seen) found.push(seen);
    }
  }

  // Each chat once: the open chat says more than its line in the list.
  const byKey = new Map<string, ReplySighting>();
  for (const s of found) {
    const key = s.threadKey ?? `${s.profile?.id ?? ''}|${s.profile?.username ?? ''}|${s.name}`;
    const had = byKey.get(key);
    byKey.set(key, had && !s.profile ? had : { ...s, when: had?.when ?? s.when });
  }
  return [...byKey.values()];
}
