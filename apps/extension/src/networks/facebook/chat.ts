/**
 * An open chat (facebook.com/messages/t/…): who it's with, and its messages, oldest first, as far as the page has
 * loaded them. Each message is a row of the conversation, or since 2026 an article. Who wrote it comes from, in order:
 *
 * 1. what the page says for screen readers: "You sent", "Jane replied to you", a sender's name above it, or the
 *    button at the end of it that repeats it with when and by whom it was sent ("Enter, sent Wed 11:02 AM, You: …");
 * 2. the sender's picture beside it: Facebook shows theirs, never yours;
 * 3. the side of the conversation it sits on: yours are against the right edge, theirs against the left;
 * 4. the message before it, when nothing in between says otherwise: Facebook labels a run of messages once.
 *
 * The times between runs of messages ("Today at 10:12 AM") sit between the messages, and each message carries the
 * last one above it.
 */
import {
  clean,
  closestWithin,
  elementsAfter,
  elementsIn,
  isBefore,
  namesOn,
  outermost,
  textLines,
  textPieces,
  textWithEmoji,
  withoutPicturePrefix,
} from './dom';
import { bestName, isNameLike } from './people';
import type { ChatMessage, ChatPage, PageAddress, ProfileRef, ThreadRef } from './types';
import { facebookUrl, profileFromUrl } from './urls';
import { isWhen, UI_WORDS } from './vocabulary';

/** Labels on your own messages. */
const MINE = /^you (sent|replied|forwarded|unsent|reacted)\b/i;
/** "Jane Doe replied to you", "Jane Doe replied to Sam". */
const REPLIED = /^(.+?) replied to\b/i;
/** The label Facebook puts on the conversation: "Messages in conversation with Jane Doe". */
const CONVERSATION = /^(?:messages in )?conversation (?:with|titled) (.+)$/i;
/** Lines that are Facebook talking, not anyone in the chat. */
const NOTICE =
  /^(seen( by .+)?|delivered|sending…?|.+ is typing…?|you are now connected on messenger\.?|you['’]re now friends on facebook\.?|say hi to your new facebook friend.*|messages and calls are secured with end-to-end encryption.*|.+ unsent a message)$/i;
/** Writing that is never a message: headings, buttons, and the box you type in. */
const NOT_SAID =
  'h1, h2, h3, h4, h5, h6, [role="heading"], [role="button"], button, [role="textbox"], [contenteditable="true"]';

export type Side = 'left' | 'right';

export interface ChatOptions {
  /** Which side of the conversation an element sits on. The page measures it; tests say it. */
  readonly sideOf?: (element: Element, conversation: Element) => Side | null;
}

/**
 * Where the boxes are on screen: yours sit against the conversation's right edge and theirs against its left, after
 * their picture, so the nearer edge says whose it is, however wide the message. A line in the middle (a time, "You're
 * now friends") is neither.
 */
export function measuredSide(element: Element, conversation: Element): Side | null {
  const box = element.getBoundingClientRect();
  const around = conversation.getBoundingClientRect();
  if (box.width === 0 || around.width === 0) return null;
  const left = box.left - around.left;
  const right = around.right - box.right;
  if (Math.abs(left - right) < Math.max(4, around.width * 0.02)) return null;
  return left < right ? 'left' : 'right';
}

/** Whether an element holds a chat's messages, as Facebook labels them: "Messages in conversation with Jane Doe". */
export const isConversation = (element: Element) =>
  CONVERSATION.test(clean(element.getAttribute('aria-label')));

/** Who a chat's messages are with, as their label says: "Messages in conversation with Jane Doe" is Jane Doe. */
export const conversationWith = (element: Element): string | null =>
  CONVERSATION.exec(clean(element.getAttribute('aria-label')))?.[1] ?? null;

/** The box that holds the messages: the one labelled as the conversation, else the chat's grid. */
function conversationIn(scope: Element): Element {
  for (const element of scope.querySelectorAll('[aria-label]')) {
    if (isConversation(element)) return element;
  }
  return scope.querySelector('[role="grid"]') ?? scope;
}

/** The conversation's messages: its rows, else its articles, else each piece of writing. Outermost only. */
function rowsIn(conversation: Element): Element[] {
  for (const selector of ['[role="row"]', '[role="article"]']) {
    const rows = outermost(conversation, selector);
    if (rows.length > 0) return rows;
  }
  return outermost(conversation, '[dir="auto"]');
}

/**
 * The name on the sender's picture beside a message, before it: Facebook shows the other person's, never yours. A
 * picture inside the message (an emoji) or after it ("Seen by") isn't the sender's.
 */
function pictureIn(row: Element, message: Element): string | null {
  for (const image of row.querySelectorAll(
    '[aria-hidden="true"] img[alt], [aria-hidden="true"] [role="img"][aria-label]',
  )) {
    if (message.contains(image) || !isBefore(image, message)) continue;
    const name = withoutPicturePrefix(
      image.getAttribute('alt') ?? image.getAttribute('aria-label'),
    );
    if (/\p{L}/u.test(name) && isNameLike(name) && !NOTICE.test(name)) return name;
  }
  return null;
}

/**
 * Who the button at the end of a message says sent it. Facebook repeats each message there for screen readers, with
 * when and by whom it was sent: "Enter, sent Wed 11:02 AM, You: We still on?", where "You" is a piece of text of its
 * own, or "Enter, sent Wed 11:55 AM, Jane: Sounds good" for theirs. Only a button after the message and before the
 * next one counts, and only one that says more than the message: a reaction to "❤" is a "❤" too.
 */
function repeatedBy(
  message: Element,
  text: string,
  conversation: Element,
  isRow: ReadonlySet<Element>,
): ChatMessage['from'] | null {
  const start = text.split('\n')[0]!.slice(0, 40);
  for (const element of elementsAfter(message, conversation)) {
    if (isRow.has(element)) break;
    if (element.getAttribute('role') !== 'button') continue;
    const repeat = textWithEmoji(element);
    if (repeat.length > start.length && repeat.includes(start))
      return textPieces(element).includes('You') ? 'me' : 'them';
  }
  return null;
}

function isSenderLabel(text: string): boolean {
  return MINE.test(text) || REPLIED.test(text);
}

/**
 * What a message says: the writing in its row that isn't a time, a button or Facebook's own words. A line like
 * "You sent" is a label when the row has other writing, and the message itself when it's all there is.
 */
function messageIn(row: Element): { readonly text: string; readonly element: Element } | null {
  const said = outermost(row, '[dir="auto"]')
    .filter((element) => !closestWithin(element, NOT_SAID, row))
    .map((element) => ({ element, text: textWithEmoji(element) }))
    .filter(
      ({ text }) =>
        text && !isWhen(text) && !UI_WORDS.has(text.toLowerCase()) && !NOTICE.test(text),
    );
  const words = said.filter(({ text }) => !isSenderLabel(text));
  const kept = words.length > 0 ? words : said;
  const first = kept[0];
  return first ? { element: first.element, text: kept.map(({ text }) => text).join('\n') } : null;
}

/** The labels in a row: its headings above the message, and any line that says who sent it. */
function labelsIn(
  row: Element,
  message: Element,
): { readonly text: string; readonly heading: boolean }[] {
  const headings = [...row.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')]
    .filter((element) => isBefore(element, message))
    .map((element) => ({ text: clean(element.textContent), heading: true }));
  const lines = textLines(row, 20)
    .filter(isSenderLabel)
    .map((text) => ({ text, heading: false }));
  return [...headings, ...lines].filter(({ text }) => text);
}

/** Who the chat is with: the profile its header links to, else its heading, else the conversation's label. */
function whoWith(
  scope: Element,
  conversation: Element,
  base: string,
): { name: string | null; profile: ProfileRef | null } {
  const outside = (element: Element) => conversation === scope || !conversation.contains(element);
  for (const anchor of scope.querySelectorAll('a[href]')) {
    if (!outside(anchor)) continue;
    const url = facebookUrl(anchor.getAttribute('href') ?? '', base);
    const profile = url ? profileFromUrl(url) : null;
    const name = profile ? bestName(namesOn([anchor])) : null;
    if (profile && name) return { name, profile };
  }
  for (const heading of scope.querySelectorAll('h1, h2, [role="heading"]')) {
    const text = clean(heading.textContent);
    if (outside(heading) && isNameLike(text) && !UI_WORDS.has(text.toLowerCase()))
      return { name: text, profile: null };
  }
  const label = CONVERSATION.exec(clean(conversation.getAttribute('aria-label')));
  return { name: label?.[1] ?? null, profile: null };
}

export function readChat(
  doc: Document,
  address: PageAddress,
  base: string,
  options: ChatOptions = {},
): ChatPage {
  return readChatIn(doc.querySelector('[role="main"]') ?? doc.body, address.thread, base, options);
}

/** The chat a part of the page shows: the main column of a chat's own page, or a small chat window over another page. */
export function readChatIn(
  scope: Element,
  thread: ThreadRef | null,
  base: string,
  options: ChatOptions = {},
): ChatPage {
  const conversation = conversationIn(scope);
  const { name, profile } = whoWith(scope, conversation, base);
  const sideOf = options.sideOf ?? measuredSide;

  const messages: ChatMessage[] = [];
  let when: string | null = null;
  let previous: Pick<ChatMessage, 'from' | 'sender'> = { from: 'unknown', sender: null };
  const newTime = (time: string) => {
    when = time;
    previous = { from: 'unknown', sender: null };
  };
  const rows = rowsIn(conversation);
  const isRow = new Set(rows);
  const inRow = (element: Element) => {
    for (let e: Element | null = element; e && e !== conversation; e = e.parentElement)
      if (isRow.has(e)) return true;
    return false;
  };
  for (const element of elementsIn(conversation)) {
    if (!isRow.has(element)) {
      // A time between the messages, outside them: "Sep 25, 2026, 11:39 PM".
      const text = element.childElementCount === 0 ? clean(element.textContent) : '';
      if (text && isWhen(text) && !inRow(element)) newTime(text);
      continue;
    }
    const row = element;
    const message = messageIn(row);
    if (!message) {
      const time = textLines(row, 4).find(isWhen);
      if (time) newTime(time);
      continue;
    }
    let from: ChatMessage['from'] = 'unknown';
    let sender: string | null = null;
    for (const label of labelsIn(row, message.element)) {
      if (label.text === message.text) continue;
      const replied = REPLIED.exec(label.text);
      if (MINE.test(label.text) || replied?.[1]?.toLowerCase() === 'you') from = 'me';
      else if (replied?.[1]) [from, sender] = ['them', replied[1]];
      else if (label.heading && isNameLike(label.text)) [from, sender] = ['them', label.text];
      else continue;
      break;
    }
    if (from === 'unknown')
      from = repeatedBy(message.element, message.text, conversation, isRow) ?? 'unknown';
    if (from !== 'me' && !sender) {
      const pictured = pictureIn(row, message.element);
      if (pictured) [from, sender] = ['them', pictured];
    }
    if (from === 'unknown') {
      const side = sideOf(message.element, conversation);
      if (side) from = side === 'right' ? 'me' : 'them';
    }
    if (from === 'unknown') from = previous.from;
    if (from === 'them' && !sender && previous.from === 'them') sender = previous.sender;
    messages.push({ from, sender: from === 'me' ? null : sender, text: message.text, when });
    previous = { from, sender };
  }

  // A chat with one other person names nobody above their messages: they're all from the person it's with.
  const senders = new Set(messages.flatMap((message) => (message.sender ? [message.sender] : [])));
  const oneToOne = senders.size === 0 || (senders.size === 1 && name !== null && senders.has(name));
  return {
    name,
    thread,
    profile,
    messages: messages.map((message) =>
      message.from === 'them' && !message.sender && oneToOne
        ? { ...message, sender: name }
        : message,
    ),
  };
}
