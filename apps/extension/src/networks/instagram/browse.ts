/**
 * Going through Instagram's lists for the person's asks (the Instagram and Alignable plan's part 12): their followers,
 * which Instagram draws in a box over their profile (/<you>/followers/), a few rows at a time as the box is scrolled.
 * Each call scrolls the box most of its height, as a person reading the list does; nothing is pressed. And, for Check
 * Instagram, a chat opened from the side of their messages, whose rows aren't links (the owner's Check, 0.62.0).
 */
import { clean } from '../facebook/dom';

/** Most of the box's height at a time, as a person scrolls. */
const SCREEN = 0.8;

/** Whether an element scrolls: taller inside than it shows, and let to scroll by its style. */
function scrolls(element: HTMLElement): boolean {
  if (element.scrollHeight <= element.clientHeight + 4) return false;
  const overflow = element.ownerDocument.defaultView?.getComputedStyle(element).overflowY ?? '';
  return /auto|scroll|overlay/.test(overflow);
}

/** The part of a box over the page that scrolls: the list inside it. */
function scrollerIn(box: Element): HTMLElement | null {
  for (const element of box.querySelectorAll<HTMLElement>('div, ul, section'))
    if (scrolls(element)) return element;
  return null;
}

/**
 * Scrolls the box over the page (their followers) down most of its height for Instagram to draw more of the list;
 * with no box, the page itself. Whether there was more to go: none once the list has ended.
 */
export function scrollDialog(doc: Document): boolean {
  const box = doc.querySelector('[role="dialog"]');
  const scroller = box ? scrollerIn(box) : null;
  if (scroller) {
    const room = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (room <= 4) return false;
    scroller.scrollBy({ top: Math.max(200, scroller.clientHeight * SCREEN), behavior: 'smooth' });
    return true;
  }
  if (box) return false;
  const view = doc.defaultView!;
  const room = doc.documentElement.scrollHeight - view.scrollY - view.innerHeight;
  if (room <= 4) return false;
  view.scrollBy({ top: Math.max(300, view.innerHeight * SCREEN), behavior: 'smooth' });
  return true;
}

/**
 * Opens a chat from the side of their messages, for Check to outline: the first row with words under its name (a chat
 * with messages in it). Its rows are buttons, each with the other person's name in a `title` and the time of its last
 * message (`abbr`). Opening it is a press of the row, as a person reading their messages does. Whether there was one.
 */
export function openChat(doc: Document): boolean {
  for (const row of doc.querySelectorAll<HTMLElement>('[role="button"]')) {
    if (!row.querySelector('span[title]') || !row.querySelector('abbr')) continue;
    if (row.querySelector('[role="button"]')) continue;
    const words = clean(row.textContent);
    if (!words) continue;
    row.click();
    return true;
  }
  return false;
}
