/**
 * Going through Instagram's lists for the person's asks (the Instagram and Alignable plan's part 12): their followers,
 * which Instagram draws in a box over their profile (/<you>/followers/), a few rows at a time as the box is scrolled.
 * Each call scrolls a box most of its height, as a person reading the list does; the box of followers, which keeps
 * every row it has drawn, to its end, so each screen draws the next rows whatever the box's height (0.89.0: most of a
 * short box's height drew a few followers a screen). Nothing is pressed. Where Instagram
 * doesn't open the box from its address, their account's count of followers is pressed to open it, as a person does
 * (0.84.0: its counts aren't links to the list now). And a chat opened from the side of their messages, whose rows
 * aren't links (the owner's Check, 0.62.0): for Check Instagram, and, from part 13, for Read my chats, which also
 * scrolls that list for more.
 *
 * From 0.95.0 (decision 92) a good post's people, for who liked and commented on it: its View all comments (or Load
 * more comments) pressed once, its Likes box opened by its count of likes, as a person opens it, scrolled as any box
 * over the page is (`scrollDialog`), and closed again by its own Close. Nothing in them is pressed.
 */
import { clean } from '../facebook/dom';
import { visible } from '../facebook/fetch';
import { controlsSaying, waitFor } from '../looking/looks';
import {
  followersBox,
  followersCount,
  likersBox,
  likesOpenerIn,
  moreCommentsIn,
  ownOf,
  postRootOf,
} from './read';
import { accountOf, instagramUrl, kindOf } from './urls';

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

/** Instagram's own mark for rows still on their way, by its label or role. */
const loadingIn = (box: Element): boolean =>
  box.querySelector('[role="progressbar"], [aria-label^="loading" i]') !== null;

/**
 * Scrolls the box over the page down most of its height for Instagram to draw more of the list, or to its end (their
 * followers, `toEnd`); with no box, the page itself. Whether there was more to go: none once the list has ended, and
 * so not while Instagram still shows it's drawing more.
 */
export function scrollDialog(doc: Document, toEnd = false): boolean {
  const box = doc.querySelector('[role="dialog"]');
  const scroller = box ? scrollerIn(box) : null;
  if (scroller) {
    const room = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (room <= 4) return toEnd && loadingIn(box!);
    if (toEnd) scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
    else
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

/**
 * A list on the page for the person's asks: their chats on their messages' pages, else the box over the page, their
 * followers' to its end.
 */
export const scrollList = (doc: Document, href: string): boolean =>
  /^\/direct\//.test(new URL(href).pathname) && chatRowsIn(doc).length
    ? scrollChats(doc)
    : scrollDialog(doc, followersBox(doc, href) !== null);

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

/**
 * Opens the box of another account's followers over its page (decision 110: an account like the business's, whose
 * followers are its kind of customer): a press of the account's count of followers, as a person does. Only on an
 * account's own page that isn't the person's, and never with the box open already. Whether the box is there, or was
 * asked for.
 */
export function openTheirFollowers(doc: Document, href: string): boolean {
  if (followersBox(doc, href)) return true;
  const page = instagramUrl(href);
  const account = page ? accountOf(page) : null;
  const own = ownOf(doc, href);
  if (!account || (own && account.username.toLowerCase() === own.toLowerCase())) return false;
  const count = followersCount(doc);
  if (!count) return false;
  count.click();
  return true;
}

// ------------------------------------------------------------------------------------------------ a post's people

/** A box over the page's own Close, as its label says. */
const CLOSE = /^close$/i;
/** How long a box is waited on to go once its Close is pressed. */
const CLOSED_MS = 4_000;

/** Whether the tab shows a post's own page: its comments and its count of likes are there. */
const onPost = (href: string): boolean => {
  const page = instagramUrl(href);
  return page !== null && kindOf(page) === 'post';
};

/**
 * Opens a post's Likes box over its page (decision 92): a press of its count of likes ("12 others", "1,234 likes", or
 * the number beside its Like), as a person does. Only on a post's own page, and never with the box open already.
 * Whether the box is there, or was asked for.
 */
export function openLikers(doc: Document, href: string): boolean {
  if (likersBox(doc, href)) return true;
  if (!onPost(href)) return false;
  const opener = likesOpenerIn(postRootOf(doc), href);
  if (!opener) return false;
  opener.click();
  return true;
}

/**
 * Shows more of a post's comments (decision 92): its own View all comments, or Load more comments, pressed once.
 * Only on a post's own page; never View replies. Whether there was one.
 */
export function moreComments(doc: Document, href: string): boolean {
  if (!onPost(href)) return false;
  const more = moreCommentsIn(postRootOf(doc));
  if (!more) return false;
  more.click();
  return true;
}

/**
 * Closes the box over the page, a post's Likes box first, by its own Close as a person does, or with Escape where it
 * has none, and waits for it to go. Whether it went: none there is gone already.
 */
export async function closeDialog(doc: Document, href: string): Promise<boolean> {
  const box = likersBox(doc, href) ?? doc.querySelector('[role="dialog"]');
  if (!box) return true;
  const close = controlsSaying(box, CLOSE, true)[0];
  if (close) close.click();
  else
    box.dispatchEvent(
      new (doc.defaultView ?? globalThis).KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        bubbles: true,
      }),
    );
  return (
    (await waitFor(() => (!box.isConnected || !visible(box) ? true : null), CLOSED_MS)) === true
  );
}
