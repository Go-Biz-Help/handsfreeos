/**
 * Going through the person's chats in Messenger for the AI to read (docs/outreach.md, decision 2's "Collect from
 * Facebook"), once they press **Read my chats** in the panel: it opens one chat at a time from the list beside
 * Messenger, the way the person would by clicking it, and scrolls that list to load more. It never types, never
 * sends, and does nothing anywhere else: only on Messenger's own pages (`messengerPage`), and only the list's links.
 */
import { inTopBar } from './dom';
import { classifyUrl, facebookUrl, threadFromUrl } from './urls';

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
