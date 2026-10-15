/**
 * An open conversation in LinkedIn messaging (/messaging/thread/<id>/): who it's with, and its messages, oldest
 * first, as far as the page has loaded them. LinkedIn starts each run of messages from one person with their picture,
 * their name and the time ("Dana Reyes · 2:15 PM", and for screen readers "Dana Reyes sent the following messages at
 * 2:15 PM"), yours as theirs, and puts the day above the first run of each day ("Today", "Oct 3"). So who wrote a
 * message comes from, in order:
 *
 * 1. the run it starts: the name over it, in words or on the sender's picture or link. Yours is yours by your name on
 *    the top bar's Me, or by not being the other person's in a chat with one;
 * 2. the message before it, when nothing in between says otherwise: LinkedIn names a run once;
 * 3. the side of the conversation it sits on, where nothing names its run: yours against the right edge, as Facebook
 *    draws them (../facebook/chat.ts).
 *
 * Each message carries the day above it and its run's time: "Today at 2:15 PM", as Facebook prints its own, so
 * ../hfos/when.ts makes it last.
 */
import { clean, elementsIn, outermost } from '../facebook/dom';
import { measuredSide, type ChatOptions } from '../facebook/chat';
import { sameName } from '../facebook/people';
import { CONTROLS, inTopBar, mainOf, namesOn, shownLines, yourName } from './dom';
import { bestName, isNameLike } from './people';
import type { ChatMessage, ChatPage, PageAddress, ProfileRef } from './types';
import { linkedinUrl, profileFromUrl, profileKey, threadFromUrl } from './urls';
import { CLOCK, degreeOnly, isWhen, UI_WORDS } from './vocabulary';

export type { ChatOptions };

/** The label a conversation may carry: "Conversation with Dana Reyes", "Messages in conversation with Dana Reyes". */
const CONVERSATION = /^(?:messages in )?conversation with (.+)$/i;
/** The line for screen readers that starts a run: "Dana Reyes sent the following messages at 2:15 PM". */
const SENT_BY = /^(.+?) sent the following messages? at (.+)$/i;
/** Lines that are LinkedIn talking, not anyone in the conversation. */
const NOTICE =
  /^(seen( by .+)?|read|delivered|sending…?|sent|.+ is typing…?|this is the (very )?beginning of your conversation.*|.+ accepted your invitation.*|you['’]re now connected.*|view .+[’']s? profile)$/i;
/** Writing that is never a message: headings, buttons, the box you type in, times. */
const NOT_SAID = `${CONTROLS}, [role="textbox"], [contenteditable="true"], time`;

/** Whether a part of the page is the list of conversations: its links lead to chats. */
const holdsThreads = (element: Element, base: string) =>
  [...element.querySelectorAll('a[href]')].some((anchor) => {
    const url = linkedinUrl(anchor.getAttribute('href') ?? '', base);
    return url !== null && threadFromUrl(url) !== null;
  });

const rowsOf = (list: Element) => outermost(list, 'li, [role="listitem"]');

/**
 * The box that holds the messages: the one labelled as the conversation, or the log; else the list of messages, the
 * one with the most items that isn't the list of conversations.
 */
function conversationIn(scope: Element, base: string): Element | null {
  for (const element of scope.querySelectorAll('[aria-label], [role="log"]')) {
    if (
      element.matches('[role="log"]') ||
      CONVERSATION.test(clean(element.getAttribute('aria-label')))
    )
      return element;
  }
  let best: Element | null = null;
  for (const list of outermost(scope, 'ul, ol, [role="list"]')) {
    if (inTopBar(list) || holdsThreads(list, base)) continue;
    if (!best || rowsOf(list).length > rowsOf(best).length) best = list;
  }
  return best;
}

/**
 * Who the conversation is with: the profile its header links to (outside the messages and the list of
 * conversations), else its heading, else the conversation's label.
 */
function whoWith(
  scope: Element,
  conversation: Element | null,
  base: string,
): { readonly name: string | null; readonly profile: ProfileRef | null } {
  const outside = (element: Element) =>
    !inTopBar(element) &&
    !conversation?.contains(element) &&
    !element.closest('a[href*="/messaging/thread/"]');
  for (const anchor of scope.querySelectorAll('a[href]')) {
    if (!outside(anchor)) continue;
    const url = linkedinUrl(anchor.getAttribute('href') ?? '', base);
    const profile = url ? profileFromUrl(url) : null;
    const name = profile ? bestName(namesOn([anchor])) : null;
    if (profile && name) return { name, profile };
  }
  for (const heading of scope.querySelectorAll('h1, h2, h3, [role="heading"]')) {
    const text = clean(heading.textContent);
    if (outside(heading) && isNameLike(text) && !holdsThreads(heading, base))
      return { name: text, profile: null };
  }
  const label = CONVERSATION.exec(clean(conversation?.getAttribute('aria-label')));
  return { name: label?.[1] ?? null, profile: null };
}

/** Who a row says starts a run there: the name on its screen readers' line, its sender's link or picture. */
function senderIn(
  row: Element,
  lines: readonly string[],
  base: string,
): {
  readonly name: string | null;
  readonly profile: ProfileRef | null;
  readonly clock: string | null;
} {
  const said = lines.map((line) => SENT_BY.exec(line)).find(Boolean);
  let profile: ProfileRef | null = null;
  let name = said?.[1] ?? null;
  for (const anchor of row.querySelectorAll('a[href]')) {
    const url = linkedinUrl(anchor.getAttribute('href') ?? '', base);
    profile = url ? profileFromUrl(url) : null;
    if (!profile) continue;
    name ??= bestName(namesOn([anchor]));
    break;
  }
  // The run's time is a time of day; a day above it ("Today") is the day's.
  const clock =
    said?.[2] ??
    [...row.querySelectorAll('time')].map((t) => clean(t.textContent)).find((t) => CLOCK.test(t)) ??
    null;
  return { name: name && isNameLike(name) ? name : null, profile, clock };
}

export function readChat(
  doc: Document,
  address: PageAddress,
  base: string,
  options: ChatOptions = {},
): ChatPage {
  const scope = mainOf(doc);
  const conversation = conversationIn(scope, base);
  const { name, profile } = whoWith(scope, conversation, base);
  const you = yourName(doc);
  const sideOf = options.sideOf ?? measuredSide;
  const messages: ChatMessage[] = [];
  if (!conversation) return { name, thread: address.thread, profile, messages };

  // A chat with one person: its header links to them, or names one person.
  const oneToOne = profile !== null || (name !== null && !/,|\band\b/.test(name));
  /** Whether a run is yours: your name; else, in a chat with one person, anyone who isn't them. */
  const mine = (sender: { name: string | null; profile: ProfileRef | null }) => {
    if (sender.name && you) return sameName(sender.name, you);
    const theirs =
      (sender.profile && profile && profileKey(sender.profile) === profileKey(profile)) ||
      (sender.name && name && sameName(sender.name, name));
    return !theirs && oneToOne;
  };

  let day: string | null = null;
  let clock: string | null = null;
  let previous: Pick<ChatMessage, 'from' | 'sender'> = { from: 'unknown', sender: null };
  for (const row of rowsOf(conversation)) {
    const lines = shownLines(row, { max: 30, exclude: CONTROLS });
    // The card about them at the start of a conversation says how far they are; a message never does.
    if (lines.some((line) => degreeOnly(line.replace(/^.*?[·•]\s*/, '')) !== null)) continue;

    // A day above the run ("Today", "Oct 3") starts afresh; the run's own time is a time of day.
    const times = [
      ...lines.filter(isWhen),
      ...[...row.querySelectorAll('time')].map((time) => clean(time.textContent)).filter(isWhen),
    ];
    const newDay = times.find((time) => !CLOCK.test(time));
    if (newDay) {
      [day, clock] = [newDay, null];
      previous = { from: 'unknown', sender: null };
    }
    const sender = senderIn(row, lines, base);
    clock = sender.clock ?? times.find((time) => CLOCK.test(time)) ?? clock;

    const isMeta = (line: string) =>
      sender.name !== null &&
      line.startsWith(sender.name) &&
      (line === sender.name || isWhen(line.slice(sender.name.length).replace(/^[\s·•]+/, '')));
    const said = shownLines(row, { max: 30, exclude: NOT_SAID }).filter(
      (line) =>
        !SENT_BY.test(line) &&
        !NOTICE.test(line) &&
        !isWhen(line) &&
        !isMeta(line) &&
        !UI_WORDS.has(line.toLowerCase()),
    );
    if (said.length === 0) continue;

    let from: ChatMessage['from'] = 'unknown';
    let who: string | null = null;
    if (sender.name || sender.profile) {
      from = mine(sender) ? 'me' : 'them';
      who = from === 'them' ? sender.name : null;
    } else if (previous.from !== 'unknown') {
      [from, who] = [previous.from, previous.sender];
    } else {
      // Nothing names the run: the side the message sits on.
      const start = said[0]!.slice(0, 20);
      const bubble = [...elementsIn(row)]
        .reverse()
        .find((element) => clean(element.textContent).startsWith(start));
      const side = sideOf(bubble ?? row, conversation);
      if (side) from = side === 'right' ? 'me' : 'them';
    }
    const when = day && clock ? `${day} at ${clock}` : (clock ?? day);
    const writer = from === 'them' ? (who ?? (oneToOne ? name : null)) : null;
    messages.push({ from, sender: writer, text: said.join('\n'), when });
    previous = { from, sender: who };
  }
  return { name, thread: address.thread, profile, messages };
}
