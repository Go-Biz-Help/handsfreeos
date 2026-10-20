/**
 * Going through Alignable's lists for the person's asks (partners stage 6c, part 4): My Network's connections and its
 * Requests. My Network opens on Ally's picks, a few connections chosen for them (`allies-picks-list`), beside its tab
 * of them all (`tab-all-connections`, the owner's Check, 0.68.0), so the list is switched to that tab first. Then each
 * screen is scrolled for more, and where the list ends in Alignable's own Show more (or Load more), that's pressed:
 * it only shows more of the list. Nothing else is pressed.
 */
import { clean } from '../facebook/dom';
import { PART } from './read';

/** Its own button for more at a list's foot. */
const MORE = /^(show|load|see|view) (more|all)( connections| requests| results)?$/i;
/** Most of a screen at a time, as a person scrolls. */
const SCREEN = 0.8;

/** My Network's tab of all the person's connections, pressed when the picks show: whether it's showing now. */
export function showAllConnections(doc: Document): boolean {
  const tab = doc.querySelector<HTMLElement>(PART('tab-all-connections'));
  if (!tab) return false;
  const on =
    tab.getAttribute('aria-selected') === 'true' ||
    tab.getAttribute('aria-pressed') === 'true' ||
    (!doc.querySelector(PART('allies-picks-list')) && !!doc.querySelector(PART('connection-row')));
  if (!on) tab.click();
  return true;
}

/** The list's own Show more, in sight at its foot. */
function moreButton(doc: Document): HTMLElement | null {
  const main = doc.querySelector('main, [role="main"]') ?? doc.body;
  for (const button of main.querySelectorAll<HTMLElement>('button, a[role="button"]')) {
    if (button.closest('header, nav, footer, [role="dialog"]')) continue;
    const words = clean(button.textContent) || clean(button.getAttribute('aria-label'));
    if (MORE.test(words) && !(button as HTMLButtonElement).disabled) return button;
  }
  return null;
}

/**
 * Scrolls the page down most of a screen for Alignable to draw more of the list; at its foot, presses its own Show
 * more. Whether there was more to go: none once the list has ended.
 */
export function scrollList(doc: Document): boolean {
  const view = doc.defaultView!;
  const before = view.scrollY;
  const room = doc.documentElement.scrollHeight - before - view.innerHeight;
  if (room > 4) {
    view.scrollBy({ top: Math.max(300, view.innerHeight * SCREEN), behavior: 'smooth' });
    return true;
  }
  const more = moreButton(doc);
  if (!more) return false;
  more.click();
  return true;
}

/**
 * Opens a conversation from Messages' side (`conversationInSidebar`): the first one with words under its name, so a
 * chat with messages in it, for Check to outline (partners stage 6c: Alignable's chat reader is built from it). Whether
 * there was one to open. Opening it is a press of the row, as a person reading their messages does.
 */
export function openConversation(doc: Document): boolean {
  for (const row of doc.querySelectorAll<HTMLElement>(PART('conversationInSidebar'))) {
    const lines = [...row.querySelectorAll('div')]
      .filter((div) => div.children.length === 0)
      .map((div) => clean(div.textContent))
      .filter(Boolean);
    if (lines.length < 2) continue;
    (row.querySelector<HTMLElement>('[role="button"], a, button') ?? row).click();
    return true;
  }
  return false;
}
