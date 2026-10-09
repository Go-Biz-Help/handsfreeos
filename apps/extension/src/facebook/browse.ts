/**
 * Going through the person's chats in Messenger for the AI to read (docs/outreach.md, decision 2's "Collect from
 * Facebook"), once they press **Read my chats** in the panel: it opens one chat at a time from the list beside
 * Messenger, the way the person would by clicking it, and scrolls that list to load more. It never types, never
 * sends, and does nothing anywhere else: only on Messenger's own pages (`messengerPage`), and only the list's links.
 *
 * And for **Find posts** (docs/outreach.md, decision 18): on a group's own page, it scrolls the feed down a screen at a
 * time, as the person would, for Facebook to load more posts. For the once-a-day jobs (decision 32), it scrolls the
 * person's friend requests, and a group's members, the same way, for Facebook to load more people. Nothing else: it
 * opens nothing and presses nothing.
 */
import { inTopBar } from './dom';
import { classifyUrl, facebookUrl, profileFromUrl, threadFromUrl } from './urls';

/** Whether an address is Messenger's: the list of chats, or a chat. */
export const messengerPage = (href: string) => {
  const kind = classifyUrl(href).kind;
  return kind === 'chat' || kind === 'chats';
};

/** The links to chats on the page, outside the top bar, in page order. */
function chatLinks(root: Document, base: string): { anchor: HTMLAnchorElement; id: string }[] {
  const found: { anchor: HTMLAnchorElement; id: string }[] = [];
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (inTopBar(anchor)) continue;
    const url = facebookUrl(anchor.getAttribute('href') ?? '', base);
    const thread = url ? threadFromUrl(url) : null;
    if (thread) found.push({ anchor, id: thread.id });
  }
  return found;
}

/** Opens a chat from the list, as clicking it would. Whether its link was there to click. */
export function openChat(root: Document, base: string, threadId: string): boolean {
  if (!messengerPage(base)) return false;
  const link = chatLinks(root, base).find((l) => l.id === threadId);
  if (!link) return false;
  link.anchor.click();
  return true;
}

/** Whether an element scrolls up and down by itself. */
function scrolls(element: Element): boolean {
  const style = getComputedStyle(element);
  return (
    element.scrollHeight > element.clientHeight + 4 &&
    (style.overflowY === 'auto' || style.overflowY === 'scroll')
  );
}

/**
 * Scrolls the list of chats down, for Facebook to load more. Whether it moved: at the end of the list, or with no
 * list on the page, it doesn't.
 */
export function scrollChats(root: Document, base: string): boolean {
  if (!messengerPage(base)) return false;
  const links = chatLinks(root, base);
  const last = links[links.length - 1]?.anchor;
  if (!last) return false;
  for (let box: Element | null = last.parentElement; box; box = box.parentElement) {
    if (!scrolls(box)) continue;
    const before = box.scrollTop;
    box.scrollTop = before + Math.max(200, box.clientHeight * 0.9);
    return box.scrollTop !== before;
  }
  // No box of its own: the page scrolls.
  const before = window.scrollY;
  last.scrollIntoView({ block: 'end' });
  return window.scrollY !== before;
}

/** Whether an address is a group's own feed: not its members, a post, or the list of groups. */
export const groupFeedPage = (href: string) => classifyUrl(href).kind === 'group';

/** How far one scroll of a group's feed goes: most of a screen, so no post is skipped past unread. */
const FEED_SCROLL = 0.8;

/**
 * Scrolls a group's feed down most of a screen, for Facebook to load more posts. Whether it moved: at the end of the
 * feed, or off a group's page, it doesn't.
 */
export function scrollFeed(base: string): boolean {
  if (!groupFeedPage(base)) return false;
  const before = window.scrollY;
  window.scrollBy({ top: Math.max(300, window.innerHeight * FEED_SCROLL), behavior: 'smooth' });
  // Smooth scrolling moves over a few frames; what counts is that there was room to move.
  return document.documentElement.scrollHeight - before - window.innerHeight > 4;
}

/** Whether an address is a list of people the once-a-day jobs load more of: your friends pages, or a group's members. */
export const peopleListPage = (href: string) => {
  const kind = classifyUrl(href).kind;
  return kind === 'friends' || kind === 'group-members';
};

/**
 * Scrolls a list of people down most of a screen, for Facebook to load more: the box the list scrolls in (your friend
 * requests sit in one beside the page), else the page. Whether it moved: at the end, or off those pages, it doesn't.
 */
export function scrollList(root: Document, base: string): boolean {
  if (!peopleListPage(base)) return false;
  const people = [...root.querySelectorAll<HTMLAnchorElement>('a[href]')].filter((anchor) => {
    if (inTopBar(anchor)) return false;
    const url = facebookUrl(anchor.getAttribute('href') ?? '', base);
    return url !== null && profileFromUrl(url) !== null;
  });
  const last = people[people.length - 1];
  for (let box: Element | null = last?.parentElement ?? null; box; box = box.parentElement) {
    if (box === root.documentElement || box === root.body || !scrolls(box)) continue;
    const before = box.scrollTop;
    box.scrollTop = before + Math.max(200, box.clientHeight * FEED_SCROLL);
    return box.scrollTop !== before;
  }
  const view = root.defaultView!;
  const before = view.scrollY;
  view.scrollBy({ top: Math.max(300, view.innerHeight * FEED_SCROLL), behavior: 'smooth' });
  return root.documentElement.scrollHeight - before - view.innerHeight > 4;
}
