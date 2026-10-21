/**
 * Going through Instagram's lists for the person's asks (the Instagram and Alignable plan's part 12): their followers,
 * which Instagram draws in a box over their profile (/<you>/followers/), a few rows at a time as the box is scrolled.
 * Each call scrolls the box most of its height, as a person reading the list does; nothing is pressed. Where Instagram
 * doesn't open the box from its address, their account's count of followers is pressed to open it, as a person does
 * (0.84.0: its counts aren't links to the list now). And a chat opened from the side of their messages, whose rows
 * aren't links (the owner's Check, 0.62.0): for Check Instagram, and, from part 13, for Read my chats, which also
 * scrolls that list for more.
 */
import { clean } from '../facebook/dom';
import { followersBox, followersCount, ownOf } from './read';
import { accountOf, instagramUrl } from './urls';

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

/** The rows of the list beside their messages: buttons, each with the other person's name in a `title`. */
const chatRowsIn = (doc: Document): HTMLElement[] =>
  [...doc.querySelectorAll<HTMLElement>('[role="button"]')].filter(
    (row) => row.querySelector('span[title]') && !row.querySelector('[role="button"]'),
  );

/**
 * Opens a chat from the side of their messages: for Check to outline, the first row with words under its name (a chat
 * with messages in it); for Read my chats (part 13), the row whose name is `name`. Its rows are buttons, each with
 * the other person's name in a `title` and the time of its last message (`abbr`). Opening it is a press of the row, as
 * a person reading their messages does. Whether there was one.
 */
export function openChat(doc: Document, name: string | null = null): boolean {
  const want = name ? clean(name).toLowerCase() : null;
  for (const row of chatRowsIn(doc)) {
    const named = row.querySelector('span[title]')!;
    const shown = clean(named.getAttribute('title')) || clean(named.textContent);
    if (want ? shown.toLowerCase() !== want : !row.querySelector('abbr') || !clean(row.textContent))
      continue;
    row.click();
    return true;
  }
  return false;
}

/**
 * Scrolls the list beside their messages most of its height for Instagram to draw more chats: the part around its rows
 * that scrolls. Whether there was more to go.
 */
export function scrollChats(doc: Document): boolean {
  const first = chatRowsIn(doc)[0];
  for (let up = first?.parentElement; up; up = up.parentElement) {
    if (!(up instanceof doc.defaultView!.HTMLElement) || !scrolls(up)) continue;
    const room = up.scrollHeight - up.scrollTop - up.clientHeight;
    if (room <= 4) return false;
    up.scrollBy({ top: Math.max(200, up.clientHeight * SCREEN), behavior: 'smooth' });
    return true;
  }
  return false;
}

/** A list on the page for the person's asks: their chats on their messages' pages, else the box over the page. */
export const scrollList = (doc: Document, href: string): boolean =>
  /^\/direct\//.test(new URL(href).pathname) && chatRowsIn(doc).length
    ? scrollChats(doc)
    : scrollDialog(doc);

/**
 * Opens the box of their followers over their own account when Instagram didn't from its address: a press of the
 * account's count of followers, as a person does (the owner's Check, 21 Oct 2026: the counts aren't links to the list
 * now, and /<you>/followers/ showed their account without it). Only on their own account, by the menu's Profile, and
 * never with the box open already. Whether the box is there, or was asked for.
 */
export function openFollowers(doc: Document, href: string): boolean {
  if (followersBox(doc, href)) return true;
  const page = instagramUrl(href);
  const account = page ? accountOf(page) : null;
  const own = ownOf(doc, href);
  if (!account || !own || account.username.toLowerCase() !== own.toLowerCase()) return false;
  const count = followersCount(doc);
  if (!count) return false;
  count.click();
  return true;
}
