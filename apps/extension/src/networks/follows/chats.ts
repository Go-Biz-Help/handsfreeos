/**
 * A follow network's messages (decision 167; Threads' for now, X's when it has them): what its pages show of the
 * person's chats, and the presses its runner makes there, by its spec's `messages`.
 *
 * - **The list of chats** (Threads' /messages/, and beside a chat's own page): each one a link to its chat
 *   (/messages/t/<number>/), with who it's with (in a `title`, else its first line), its last line ("You: …" when it's
 *   the person's) and when it moved ("3h"), as Messenger's list shows them, which Threads' messages are made of.
 * - **A chat on its own page** (/messages/t/<number>/): who it's with (the one other account its header links to, never
 *   one a message links to), its messages (the conversation's rows, else its articles), whose each is (what it says for
 *   screen readers, their picture beside it, else the side it sits on), and its box to write in.
 * - **Who wrote back** (`followReplies`): the chats whose last message is theirs, in the list and the chat open, by the
 *   chat's number; never what they wrote, but the last line kept on the computer to tell a newer one (decision 150).
 *
 * The presses, each only where it's for:
 *
 * - **Message** on their profile, beside its Follow: Threads shows it once they follow the person (or they follow each
 *   other on Instagram), which is when a first message goes there (decision 159).
 * - **A message** in their chat: only in the chat whose header is them, only in its own box, only while that box is
 *   empty; typed as a person types, and sent with its Send, else Enter. What was typed is taken out again whenever it
 *   isn't still their chat's box, or it didn't go, and nothing is sent. It went once the box empties.
 *
 * They read by the site's own words, labels, roles and addresses, never class names, and were built from its code and
 * Messenger's usual markup before anyone's Check outlined them: Check Threads tunes them.
 */
import type { AutoResult } from '../facebook/auto';
import { measuredSide } from '../facebook/chat';
import { clean, textLines } from '../facebook/dom';
import { visible } from '../facebook/fetch';
import type { LastLine, ReplySighting } from '../facebook/replies';
import type { ProfileRef } from '../facebook/types';
import { isWhen } from '../facebook/vocabulary';
import {
  boxesSaying,
  controlsSaying,
  emptyIn,
  mainOf,
  pause,
  waitFor,
  writeIn,
  writingIn,
} from '../looking/looks';
import { sameName } from './read';
import type {
  FollowAccount,
  FollowChat,
  FollowChatMessage,
  FollowChatRow,
  FollowMessages,
  FollowSpec,
} from './types';

/** Of a list's chats: enough to go on with, never a whole page's worth. */
const ROWS_MOST = 200;
/** A chat's latest messages. */
const MESSAGES_MOST = 20;
/** A message, as long as a reader keeps. */
const TEXT_MOST = 2_000;
/** How far up from a chat's link its row is looked for, while it holds no other chat. */
const ROW_STEPS = 6;
/** How long a message is waited on to show it went, and its box to show. */
const WENT_MS = 6_000;
const SENT_MS = 10_000;

/** What a chat's line of its own says it was: the person's ("You sent"), or someone's ("Dana sent"). */
const MINE = /^you (sent|replied|reacted|forwarded)( to [^.]{1,60}| a message| an attachment)?\b/i;
const THEIRS = /^(.{1,60}?) (sent|replied)( to you| a message| an attachment)?$/i;
/** The label on a chat's messages: "Messages in conversation with Dana Reyes". */
const CONVERSATION = /^(messages in )?conversation (with|titled)\b/i;
/** Lines that are the site talking, never anyone in the chat. */
const NOTICE =
  /^(seen( by .+)?|sent|delivered|sending…?|active now|active \d+\w* ago|.+ is typing…?|today|yesterday|view profile|you messaged from (their|your) (ghost )?post.*|messaged from your (ghost )?post.*|message unavailable|attachment unavailable|unsupported message type|you can now message.*|to message this profile.*|you can['’]t message .*)$/i;
/** A row's last line that isn't a message of theirs: a reaction, or the site saying something. */
const NOT_A_MESSAGE =
  /^(active now|active (\d+\s?\w+|yesterday)( ago)?|seen( by .+)?|sent( \d+\s?\w+ ago)?|delivered|typing…?|.+ is typing…?)$|\b(reacted|liked a message|liked your (message|post)|sent you a message request|wants to send you a message)\b/i;
/** The person's own last line in the list: "You: see you then", "You sent a photo". */
const YOURS = /^you(\s*:|\s+(sent|replied|reacted|forwarded|unsent)\b)/i;
/** Headings, where a page says for screen readers whose a message is. */
const HEADINGS = 'h1, h2, h3, h4, h5, h6, [role="heading"]';
/** What's never a message's own words: its buttons, its times, its headings, its box. */
const NOT_WRITTEN = `button, [role="button"], abbr, time, ${HEADINGS}, [role="textbox"], [contenteditable="true"]`;
/** A chat's messages: Messenger's rows, or its articles. */
const MESSAGE_PARTS = '[role="row"], [role="article"]';
/** Where a person writes. */
const WRITING = 'textarea, [role="textbox"], [contenteditable="true"]';

/** The network's messages, and whether the address is one of its message pages. */
function messagesHere(
  href: string,
  spec: FollowSpec,
): { readonly m: FollowMessages; readonly page: URL; readonly kind: string } | null {
  const m = spec.messages;
  const page = m ? spec.url(href) : null;
  const kind = page ? spec.kindOf(page) : 'other';
  return m && page && (kind === 'messages' || kind === 'chat') ? { m, page, kind } : null;
}

/** The chat a link leads to, by its number: null for any other link. */
function chatLinked(link: Element, spec: FollowSpec, base: string): string | null {
  const url = spec.url(link.getAttribute('href') ?? '', base);
  return url && spec.messages ? spec.messages.chatOf(url) : null;
}

/** The account a link leads to, by the name in its address: never a post's own link. */
function accountLinked(link: Element, spec: FollowSpec, base: string): FollowAccount | null {
  const url = spec.url(link.getAttribute('href') ?? '', base);
  return url && !spec.postOf(url) ? spec.profileOf(url) : null;
}

/** A chat's row around its link: the link itself when it holds words, else the part around it that holds no other. */
function rowAround(link: Element, spec: FollowSpec, base: string): Element {
  let row: Element = link;
  for (let up = link.parentElement, n = 0; up && n < ROW_STEPS; up = up.parentElement, n++) {
    if (clean(row.textContent)) break;
    const chats = new Set(
      [...up.querySelectorAll('a[href]')].map((a) => chatLinked(a, spec, base)).filter(Boolean),
    );
    if (chats.size > 1) break;
    row = up;
  }
  return row;
}

/**
 * The chats in the list of them, on its own page or beside a chat's: each by its link, once, in page order, with who
 * it's with, its last line and when. Never a link inside a chat's own messages (a shared chat, say).
 */
export function chatRowsOn(doc: Document, href: string, spec: FollowSpec): FollowChatRow[] {
  const here = messagesHere(href, spec);
  if (!here) return [];
  const rows = new Map<string, FollowChatRow>();
  for (const link of doc.querySelectorAll('a[href]')) {
    const thread = chatLinked(link, spec, href);
    if (!thread || rows.has(thread) || link.closest(MESSAGE_PARTS)) continue;
    const row = rowAround(link, spec, href);
    const titled = clean(row.querySelector('[title]')?.getAttribute('title'));
    const lines = textLines(row, 12, 'abbr');
    const name = titled || lines.find((l) => !isWhen(l) && !/^[·•]$/.test(l)) || '';
    if (!name || name.length > 100) continue;
    let preview: string | null = null;
    let when: string | null = clean(row.querySelector('abbr, time')?.textContent) || null;
    for (const line of lines) {
      if (line === name) continue;
      // The time is a line of its own ("3h", "· 3h") or at the end of the words: "You: see you then · 3h".
      const parts = line.split(/(?:^|\s+)[·•]\s*/);
      const last = parts[parts.length - 1];
      if (last && isWhen(last)) {
        when ??= last;
        parts.pop();
      }
      const words = parts
        .map((p) => p.trim())
        .filter(Boolean)
        .join(' · ');
      if (!words || preview !== null || spec.words.has(words.toLowerCase())) continue;
      preview = words;
    }
    rows.set(thread, {
      name,
      preview,
      yours: preview !== null && YOURS.test(preview),
      when,
      thread,
    });
    if (rows.size >= ROWS_MOST) break;
  }
  return [...rows.values()];
}

/** The part of the page that's the list of chats: the nearest part around two or more of their links. */
function listOf(doc: Document, spec: FollowSpec, base: string): Element | null {
  const links = [...doc.querySelectorAll('a[href]')].filter(
    (a) => chatLinked(a, spec, base) !== null && !a.closest(MESSAGE_PARTS),
  );
  if (links.length < 2) return null;
  const [first, ...rest] = links;
  for (let up: Element | null = first!.parentElement; up; up = up.parentElement)
    if (rest.every((a) => up!.contains(a))) return up;
  return null;
}

/** Whether an element scrolls: taller inside than it shows, and let to scroll by its style. */
function scrolls(element: HTMLElement): boolean {
  if (element.scrollHeight <= element.clientHeight + 4) return false;
  const overflow = element.ownerDocument.defaultView?.getComputedStyle(element).overflowY ?? '';
  return /auto|scroll|overlay/.test(overflow);
}

/**
 * Scrolls the list of chats most of its height for the site to draw more: the part around its links that scrolls.
 * Whether there was more to go; null on any page that isn't its messages with a list of chats.
 */
export function scrollChatList(doc: Document, href: string, spec: FollowSpec): boolean | null {
  if (!messagesHere(href, spec)) return null;
  const list = listOf(doc, spec, href);
  if (!list) return null;
  const Html = doc.defaultView!.HTMLElement;
  for (let up: Element | null = list; up; up = up.parentElement) {
    if (!(up instanceof Html) || !scrolls(up)) continue;
    const room = up.scrollHeight - up.scrollTop - up.clientHeight;
    if (room <= 4) return false;
    up.scrollBy({ top: Math.max(200, up.clientHeight * 0.8), behavior: 'smooth' });
    return true;
  }
  return false;
}

/** A message's own words: what's written in it, without the site's lines around it. */
function messageText(row: Element): string {
  return textLines(row, 60, NOT_WRITTEN)
    .filter((text) => !MINE.test(text) && !THEIRS.test(text) && !NOTICE.test(text))
    .join('\n')
    .slice(0, TEXT_MOST);
}

/** The part around one message that's about it alone: its row, or up as far as it holds no other message. */
function aroundMessage(message: Element, messages: readonly Element[]): Element {
  if (message.getAttribute('role') === 'row') return message;
  let part = message;
  for (let up = message.parentElement, n = 0; up && n < 10; up = up.parentElement, n++) {
    if (messages.some((other) => other !== message && up!.contains(other))) break;
    if (up.querySelector(`h1, h2, ${WRITING}`)) break;
    part = up;
  }
  return part;
}

/**
 * The person's and theirs: by what the message says for screen readers ("You sent", "Dana sent"), by their picture
 * beside it (a link to them, never beside the person's), else by the side of the conversation it sits on.
 */
function whoseMessage(
  message: Element,
  part: Element,
  conversation: Element,
  them: FollowAccount | null,
  spec: FollowSpec,
  base: string,
): FollowChatMessage['from'] | null {
  for (const text of textLines(message, 6)) {
    if (MINE.test(text)) return 'me';
    if (THEIRS.test(text)) return 'them';
  }
  for (const el of message.querySelectorAll('[aria-label]')) {
    const label = clean(el.getAttribute('aria-label'));
    if (MINE.test(label)) return 'me';
    if (THEIRS.test(label)) return 'them';
  }
  if (
    them &&
    [...part.querySelectorAll('a[href]')].some(
      (a) =>
        sameName(accountLinked(a, spec, base)?.username, them.username) &&
        (part === message || !message.contains(a)),
    )
  )
    return 'them';
  try {
    const side = measuredSide(message, conversation);
    if (side) return side === 'right' ? 'me' : 'them';
  } catch {
    // Not drawn: what the page says is all there is.
  }
  return null;
}

/** Whether a link sits with a chat's messages: in one, or in a part around some that doesn't hold the box. */
function withMessages(link: Element, main: Element, box: Element | null): boolean {
  for (let up: Element | null = link; up && up !== main; up = up.parentElement)
    if (
      up.matches(MESSAGE_PARTS) ||
      CONVERSATION.test(clean(up.getAttribute('aria-label'))) ||
      (!(box && up.contains(box)) && up.querySelector(MESSAGE_PARTS) !== null)
    )
      return true;
  return false;
}

/** The nearest part of the page holding all of these, when there are any. */
function closestAround(elements: readonly Element[]): Element | null {
  const [first, ...rest] = elements;
  for (let up: Element | null = first?.parentElement ?? null; up; up = up.parentElement)
    if (rest.every((el) => up!.contains(el))) return up;
  return null;
}

/** The chat's box to write in: the one named as a message's box, else the one box in the chat's part of the page. */
function chatBoxIn(scope: Element, m: FollowMessages, list: Element | null): HTMLElement | null {
  const outsideList = (b: Element) => !list || !list.contains(b);
  const named = boxesSaying(scope, m.box).filter(outsideList);
  if (named.length) return named.length === 1 ? named[0]! : null;
  const any = [...scope.querySelectorAll<HTMLElement>(WRITING)].filter(
    (b) => visible(b) && outsideList(b) && !b.closest('[role="dialog"]'),
  );
  return any.length === 1 ? any[0]! : null;
}

/** A chat open on its own page: who it's with, its messages and its box. Null on any other page. */
export function chatOn(
  doc: Document,
  href: string,
  spec: FollowSpec,
  me: string | null,
): FollowChat | null {
  const here = messagesHere(href, spec);
  if (!here || here.kind !== 'chat') return null;
  const main = mainOf(doc);
  const list = listOf(doc, spec, href);
  const inList = (el: Element) => list !== null && list.contains(el);
  const labelled = [...main.querySelectorAll('[aria-label]')].find((el) =>
    CONVERSATION.test(clean(el.getAttribute('aria-label'))),
  );
  const grid = labelled ?? main.querySelector('[role="grid"], [role="log"]');
  const outer = (selector: string) =>
    [...(grid ?? main).querySelectorAll(selector)].filter(
      (el) => !inList(el) && !el.parentElement?.closest(selector),
    );
  const rows = outer('[role="row"]');
  const messages = rows.length ? rows : outer('[role="article"]');
  const box = chatBoxIn(main, here.m, list);
  // Who it's with: the one account other than the person's own that the chat links to outside its messages, as its
  // header does; never one a message links to (a post shared, or the picture beside a run of someone's).
  const accounts = new Map<string, FollowAccount>();
  for (const a of main.querySelectorAll('a[href]')) {
    const account = accountLinked(a, spec, href);
    if (!account || inList(a) || withMessages(a, main, box)) continue;
    if (!sameName(account.username, me)) accounts.set(account.username.toLowerCase(), account);
  }
  const them = accounts.size === 1 ? [...accounts.values()][0]! : null;
  const toThem = them
    ? [...main.querySelectorAll('a[href]')].filter(
        (a) => !inList(a) && sameName(accountLinked(a, spec, href)?.username, them.username),
      )
    : [];
  const header =
    main.querySelector('header, [role="banner"]') ??
    toThem.find((a) => a.querySelector('h1, h2')) ??
    toThem[0] ??
    null;
  const name =
    clean(header?.querySelector('h1, h2, [title]')?.textContent) ||
    clean(header?.textContent) ||
    them?.username ||
    null;
  const conversation = grid ?? closestAround([...messages, ...(box ? [box] : [])]) ?? main;
  const read: FollowChatMessage[] = [];
  let last: FollowChat['last'] = null;
  for (const message of messages) {
    const from = whoseMessage(
      message,
      aroundMessage(message, messages),
      conversation,
      them,
      spec,
      href,
    );
    if (!from) continue;
    last = from;
    const text = messageText(message);
    if (text) read.push({ from, text });
  }
  return {
    thread: here.m.chatOf(here.page),
    with: them,
    name: name && name.length <= 100 ? name : (them?.username ?? null),
    messages: read.slice(-MESSAGES_MOST),
    last,
    box: box !== null,
  };
}

/** A last line to compare, when there are words: a photo alone has none. */
const lineOf = (text: string | null | undefined, where: LastLine['where']): LastLine | null => {
  const line = clean(text ?? '');
  return line ? { line, where } : null;
};

/** Whether a row's last line is a message of theirs: not the person's, and not a reaction or a notice. */
export const theirsLast = (row: Pick<FollowChatRow, 'preview' | 'yours'>): boolean =>
  row.preview !== null && !row.yours && !NOT_A_MESSAGE.test(row.preview.trim());

/** The chat open, when its last message is theirs and it's with one account it names. */
export function lastFromThem(chat: FollowChat | null): ReplySighting | null {
  if (!chat?.with || !chat.thread || chat.last !== 'them') return null;
  const last = chat.messages[chat.messages.length - 1];
  return {
    name: chat.name ?? chat.with.username,
    threadKey: chat.thread,
    profile: { id: null, username: chat.with.username, url: chat.with.url },
    when: null,
    last: lineOf(last?.from === 'them' ? last.text : null, 'chat'),
  };
}

/**
 * The chats on a messages page whose last message is theirs, each once by its number: the chat open says who it's
 * with, the list when they wrote and its last line (the one compared each time, decision 150). Never what they wrote
 * beyond that line, which stays on the computer.
 */
export function followReplies(doc: Document, href: string, spec: FollowSpec): ReplySighting[] {
  if (!messagesHere(href, spec)) return [];
  const me = meOfPage(doc, href, spec);
  const found = new Map<string, ReplySighting>();
  const open = lastFromThem(chatOn(doc, href, spec, me));
  if (open?.threadKey) found.set(open.threadKey, open);
  for (const row of chatRowsOn(doc, href, spec)) {
    if (!row.thread || !theirsLast(row)) continue;
    const had = found.get(row.thread);
    const last = lineOf(row.preview, 'list');
    found.set(
      row.thread,
      had
        ? { ...had, when: row.when, last: last ?? had.last ?? null }
        : { name: row.name, threadKey: row.thread, profile: null, when: row.when, last },
    );
  }
  return [...found.values()];
}

/** The person's own username, from the menu's link to their profile. */
export function meOfPage(doc: Document, href: string, spec: FollowSpec): string | null {
  const link = spec.ownLink(doc, href);
  const url = link ? spec.url(link, href) : null;
  return url ? (spec.profileOf(url)?.username ?? null) : null;
}

// ------------------------------------------------------------------------------------------------ presses

/** Their profile's own page in the tab, by its address, with its header. */
function theirHeader(doc: Document, href: string, spec: FollowSpec, them: ProfileRef) {
  const page = spec.url(href);
  const account = page && spec.kindOf(page) === 'profile' ? spec.profileOf(page) : null;
  if (!account || !sameName(account.username, them.username)) return null;
  return spec.headerOf(doc);
}

/** Presses Message on their profile, beside its Follow, which opens their chat. Whether it could. */
export const openTheirChat =
  (spec: FollowSpec) =>
  (doc: Document, href: string, them: ProfileRef): boolean => {
    const header = spec.messages ? theirHeader(doc, href, spec, them) : null;
    const message = header ? spec.messages!.messageIn(header) : null;
    if (!message) return false;
    message.click();
    return true;
  };

/**
 * The box to write to them in: on their chat's own page, when the chat open is with them, its own box. A chat with
 * someone else, or with more than one box, is never theirs.
 */
export function chatBoxFor(
  doc: Document,
  href: string,
  spec: FollowSpec,
  them: ProfileRef,
): HTMLElement | null {
  const here = messagesHere(href, spec);
  if (!here || here.kind !== 'chat') return null;
  const chat = chatOn(doc, href, spec, meOfPage(doc, href, spec));
  if (!sameName(chat?.with?.username, them.username)) return null;
  return chatBoxIn(mainOf(doc), here.m, listOf(doc, spec, href));
}

/** The box's own Send: the nearest part around it that holds one, never past one with another box to write in. */
function sendFor(box: Element, m: FollowMessages): HTMLElement | null {
  for (let up = box.parentElement, n = 0; up && n < 8; up = up.parentElement, n++) {
    if (up.querySelectorAll(WRITING).length > 1) return null;
    const send = controlsSaying(up, m.send, true).filter((c) => !c.contains(box));
    if (send.length) return send.length === 1 ? send[0]! : null;
  }
  return null;
}

/** Enter in the box, as a person sends a message where no Send shows. */
function pressEnter(doc: Document, box: HTMLElement): void {
  for (const type of ['keydown', 'keypress', 'keyup'])
    box.dispatchEvent(
      new doc.defaultView!.KeyboardEvent(type, {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }),
    );
}

/**
 * Writes a message to them in their chat and sends it. Nothing is typed unless the focus is in their chat's own box
 * and it's empty, and nothing is sent unless, once typed and again just before it's sent, it's still their chat's box
 * with what was typed in it; else what was typed is taken out again (`not_theirs`, or `not_sent`). `done` once the box
 * empties; `none` with no such box.
 */
export const writeMessage =
  (spec: FollowSpec) =>
  async (doc: Document, href: string, text: string, them: ProfileRef): Promise<AutoResult> => {
    const m = spec.messages;
    if (!m || !text.trim()) return 'none';
    const here = () => doc.defaultView?.location.href ?? href;
    const find = () => chatBoxFor(doc, here(), spec, them);
    const box = await waitFor(find, WENT_MS);
    if (!box) return 'none';
    // Something written there already is the person's: left alone.
    if (writingIn(box)) return 'not_sent';
    box.focus();
    box.click();
    await pause(300);
    if (doc.activeElement !== box && !box.contains(doc.activeElement)) return 'not_theirs';
    writeIn(doc, box, text);
    await pause(800);
    const live = find();
    if (live !== box) {
      if (writingIn(box)) await emptyIn(doc, box);
      return 'not_theirs';
    }
    if (!writingIn(box)) return 'not_sent';
    if (clean(box.textContent) !== clean(text) && !clean(box.textContent).includes(clean(text))) {
      await emptyIn(doc, box);
      return 'not_sent';
    }
    // Send shows once something's written (Messenger's); else Enter sends it.
    const send = await waitFor(() => sendFor(box, m), 2_000);
    if (find() !== box || !writingIn(box)) {
      if (writingIn(box)) await emptyIn(doc, box);
      return 'not_theirs';
    }
    if (send) send.click();
    else pressEnter(doc, box);
    if (await waitFor(() => (find() && writingIn(find()!) ? null : true), SENT_MS)) return 'done';
    // It didn't go: what was typed is taken out again, so nothing is left half-written in their chat.
    const left = find();
    if (left && writingIn(left)) await emptyIn(doc, left);
    return 'not_sent';
  };
