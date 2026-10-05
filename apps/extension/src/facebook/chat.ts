/**
 * An open chat (facebook.com/messages/t/…): who it's with, and its messages, oldest first, as far as the page has
 * loaded them. Who wrote each message comes from, in order:
 *
 * 1. what the page says for screen readers: "You sent", "Jane replied to you", or a sender's name above it;
 * 2. the side of the conversation it sits on: yours are on the right;
 * 3. the message before it, when nothing in between says otherwise: Facebook labels a run of messages once.
 *
 * The times between runs of messages ("Today at 10:12 AM") are rows of their own, and each message carries the last
 * one above it.
 */
import { clean, closestWithin, namesOn, outermost, textLines } from './dom';
import { bestName, isNameLike } from './people';
import type { ChatMessage, ChatPage, PageAddress, ProfileRef } from './types';
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

/** Where the boxes are on screen: a message well right of the middle is yours. */
export function measuredSide(element: Element, conversation: Element): Side | null {
  const box = element.getBoundingClientRect();
  const around = conversation.getBoundingClientRect();
  if (box.width === 0 || around.width === 0) return null;
  const middle = around.left + around.width / 2;
  const center = box.left + box.width / 2;
  if (Math.abs(center - middle) < around.width * 0.05) return null;
  return center > middle ? 'right' : 'left';
}

/** The box that holds the messages: the one labelled as the conversation, else the main column's grid. */
function conversationIn(main: Element): Element {
  for (const element of main.querySelectorAll('[aria-label]')) {
    if (CONVERSATION.test(clean(element.getAttribute('aria-label')))) return element;
  }
  return main.querySelector('[role="grid"]') ?? main;
}

/** The conversation's rows, outermost only, or each piece of writing when it has no rows. */
function rowsIn(conversation: Element): Element[] {
  const rows = outermost(conversation, '[role="row"]');
  return rows.length > 0 ? rows : outermost(conversation, '[dir="auto"]');
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
    .map((element) => ({ element, text: clean(element.textContent) }))
    .filter(
      ({ text }) =>
        text && !isWhen(text) && !UI_WORDS.has(text.toLowerCase()) && !NOTICE.test(text),
    );
  const words = said.filter(({ text }) => !isSenderLabel(text));
  const kept = words.length > 0 ? words : said;
  const first = kept[0];
  return first ? { element: first.element, text: kept.map(({ text }) => text).join('\n') } : null;
}

/** The labels in a row: its headings, and any line that says who sent it. */
function labelsIn(row: Element): { readonly text: string; readonly heading: boolean }[] {
  const headings = [...row.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')].map(
    (element) => ({ text: clean(element.textContent), heading: true }),
  );
  const lines = textLines(row, 20)
    .filter(isSenderLabel)
    .map((text) => ({ text, heading: false }));
  return [...headings, ...lines].filter(({ text }) => text);
}

/** Who the chat is with: the profile its header links to, else its heading, else the conversation's label. */
function whoWith(
  main: Element,
  conversation: Element,
  base: string,
): { name: string | null; profile: ProfileRef | null } {
  const outside = (element: Element) => conversation === main || !conversation.contains(element);
  for (const anchor of main.querySelectorAll('a[href]')) {
    if (!outside(anchor)) continue;
    const url = facebookUrl(anchor.getAttribute('href') ?? '', base);
    const profile = url ? profileFromUrl(url) : null;
    const name = profile ? bestName(namesOn([anchor])) : null;
    if (profile && name) return { name, profile };
  }
  for (const heading of main.querySelectorAll('h1, h2, [role="heading"]')) {
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
  const main = doc.querySelector('[role="main"]') ?? doc.body;
  const conversation = conversationIn(main);
  const { name, profile } = whoWith(main, conversation, base);
  const sideOf = options.sideOf ?? measuredSide;

  const messages: ChatMessage[] = [];
  let when: string | null = null;
  let previous: Pick<ChatMessage, 'from' | 'sender'> = { from: 'unknown', sender: null };
  for (const row of rowsIn(conversation)) {
    const message = messageIn(row);
    if (!message) {
      const time = textLines(row, 4).find(isWhen);
      if (time) {
        when = time;
        previous = { from: 'unknown', sender: null };
      }
      continue;
    }
    let from: ChatMessage['from'] = 'unknown';
    let sender: string | null = null;
    for (const label of labelsIn(row)) {
      if (label.text === message.text) continue;
      const replied = REPLIED.exec(label.text);
      if (MINE.test(label.text) || replied?.[1]?.toLowerCase() === 'you') from = 'me';
      else if (replied?.[1]) [from, sender] = ['them', replied[1]];
      else if (label.heading && isNameLike(label.text)) [from, sender] = ['them', label.text];
      else continue;
      break;
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
    thread: address.thread,
    profile,
    messages: messages.map((message) =>
      message.from === 'them' && !message.sender && oneToOne
        ? { ...message, sender: name }
        : message,
    ),
  };
}
