/**
 * Going through a LinkedIn list for what the person asked from HandsFreeOS (../../asks/run.ts), the way they would:
 * scrolling their connections, their invitations, people search, post search or messaging's list for LinkedIn to load
 * more, and opening a conversation from messaging's list by clicking it. Only on those pages. It never types, never
 * sends, and presses nothing but LinkedIn's own **Show more results** at the foot of a list that has stopped loading
 * as it scrolls, which shows more of the same list.
 */
import { shown } from '../facebook/fetch';
import { CONTROLS, inTopBar, mainOf, wordsOf } from './dom';
import type { PageKind } from './types';
import { classifyUrl, linkedinUrl, postUrlFrom, profileFromUrl, threadFromUrl } from './urls';

/** The lists it scrolls for more. */
const LISTS: ReadonlySet<PageKind> = new Set([
  'connections',
  'invitations',
  'search-people',
  'search-posts',
  'search',
  'feed',
  'activity',
  'notifications',
  'messaging',
  'chat',
]);
/** LinkedIn's own button at the foot of a list, for more of it. */
const SHOW_MORE = /^(show more results|load more|see more results|show more)$/i;
/** How far one scroll goes: most of a screen, so nothing is skipped past unread. */
const SCROLL = 0.8;

const kindOf = (href: string) => classifyUrl(href).kind;

/** Whether an element scrolls up and down by itself. */
function scrolls(element: Element): boolean {
  const style = getComputedStyle(element);
  return (
    element.scrollHeight > element.clientHeight + 4 &&
    (style.overflowY === 'auto' || style.overflowY === 'scroll')
  );
}

/** The last link to someone, a post or a conversation in the main column: where the list ends for now. */
function lastItem(doc: Document, base: string): Element | null {
  let last: Element | null = null;
  for (const anchor of mainOf(doc).querySelectorAll('a[href]')) {
    if (inTopBar(anchor)) continue;
    const url = linkedinUrl(anchor.getAttribute('href') ?? '', base);
    if (url && (profileFromUrl(url) || postUrlFrom(url) || threadFromUrl(url))) last = anchor;
  }
  return last;
}

/** Scrolls the box around an element that scrolls, else the page: whether there was room to move. */
function scrollFrom(doc: Document, from: Element | null): boolean {
  for (let box: Element | null = from?.parentElement ?? null; box; box = box.parentElement) {
    if (box === doc.documentElement || box === doc.body || !scrolls(box)) continue;
    const before = box.scrollTop;
    box.scrollTop = before + Math.max(200, box.clientHeight * SCROLL);
    return box.scrollTop !== before;
  }
  const view = doc.defaultView!;
  const before = view.scrollY;
  view.scrollBy({ top: Math.max(300, view.innerHeight * SCROLL), behavior: 'smooth' });
  return doc.documentElement.scrollHeight - before - view.innerHeight > 4;
}

/**
 * Scrolls one of the person's lists, or a search's results, down most of a screen, for LinkedIn to load more. At the
 * foot of a list that stopped loading, LinkedIn's own Show more results, when it shows one. Whether it moved: at the
 * end, or off those pages, it doesn't.
 */
export function scrollList(doc: Document, base: string): boolean {
  if (!LISTS.has(kindOf(base))) return false;
  if (scrollFrom(doc, lastItem(doc, base))) return true;
  const more = [...mainOf(doc).querySelectorAll<HTMLElement>(CONTROLS)].find(
    (control) =>
      shown(control) && !inTopBar(control) && wordsOf(control).some((w) => SHOW_MORE.test(w)),
  );
  if (!more) return false;
  more.click();
  return true;
}

/** Whether an address is LinkedIn messaging's: the list of conversations, or one open. */
export const messagingPage = (href: string) => {
  const kind = kindOf(href);
  return kind === 'messaging' || kind === 'chat';
};

/** The links to conversations in messaging's list, outside the top bar, in page order. */
function threadLinks(doc: Document, base: string): { anchor: HTMLAnchorElement; id: string }[] {
  const found: { anchor: HTMLAnchorElement; id: string }[] = [];
  for (const anchor of mainOf(doc).querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (inTopBar(anchor)) continue;
    const url = linkedinUrl(anchor.getAttribute('href') ?? '', base);
    const thread = url ? threadFromUrl(url) : null;
    if (thread) found.push({ anchor, id: thread.id });
  }
  return found;
}

/** Opens a conversation from messaging's list, as clicking it would. Whether its link was there to click. */
export function openChat(doc: Document, base: string, threadId: string): boolean {
  if (!messagingPage(base)) return false;
  const link = threadLinks(doc, base).find((l) => l.id === threadId);
  if (!link) return false;
  link.anchor.click();
  return true;
}

/** Scrolls messaging's list of conversations down, for LinkedIn to load more. Whether it moved. */
export function scrollChats(doc: Document, base: string): boolean {
  if (!messagingPage(base)) return false;
  const links = threadLinks(doc, base);
  const last = links[links.length - 1]?.anchor;
  return last ? scrollFrom(doc, last) : false;
}
