/**
 * Who liked a good post on Alignable (docs/outreach.md, decision 116, the owner's pick 34a: "It reads up to 3 screens
 * of a Likes box, and Alignable likers."), on the post's own page (a discussion's, /biz/discussions/<id>): its count
 * of likes pressed as a person presses it, the box of who liked it read, each by their business, and the box closed
 * again by its own Close, else Escape. Nothing else is pressed and nothing is written.
 *
 * Read from guessed markup till the owner's next Check Alignable outlines the box: the count is the number beside the
 * word Like in the post's counts (as `likesIn` reads it), or a control that says "3 Likes"; the box is the last one over
 * the page whose words say likes and that links to businesses, or the page of them its link may open instead
 * (/biz/likes?resource=<id>), left by opening the next post.
 */
import { clean } from '../facebook/dom';
import { visible } from '../facebook/fetch';
import type { Named } from '../facebook/types';
import { controlsSaying, waitFor } from '../looking/looks';
import { businessRef, discussionIdOf, linksIn, postParts, urlOf } from './read';

/** A box over the page. */
const OVER_THE_PAGE = '[role="dialog"], dialog[open], [aria-modal="true"]';
/** A box of who liked a post says so: "Likes", "People who liked this", "Liked by". */
const LIKES_BOX = /\blike(s|d)?\b/i;
/** A control that opens it: "3 Likes", "1 Like". */
const LIKES_COUNT = /^\d[\d,]*\s+likes?$/i;
/** What closes it. */
const CLOSE = /^(close|close modal|close dialog|dismiss|×|✕|x)$/i;
/** How long it's waited on to go. */
const CLOSED_MS = 4_000;
/** The most read from it. */
export const ALIGNABLE_LIKERS_MOST = 45;

/** A page of who liked a post, where its count's link may go (/biz/likes?resource=<id>), not a box over it. */
const LIKES_PAGE = /^\/biz\/likes\/?$/i;

/**
 * The box of who liked a post, over the page: the last one that says likes and links to a business; or, where the
 * count's link went to a page of them, that page's main part.
 */
export function likersBox(doc: Document, base: string): Element | null {
  const url = urlOf(base, base);
  if (url && LIKES_PAGE.test(url.pathname) && url.searchParams.has('resource'))
    return doc.querySelector('main, [role="main"]') ?? doc.body;
  return (
    [...doc.querySelectorAll(OVER_THE_PAGE)]
      .filter(visible)
      .reverse()
      .find(
        (box) =>
          LIKES_BOX.test(clean(box.textContent)) &&
          linksIn(box, base).some(({ url }) => businessRef(url, null)),
      ) ?? null
  );
}

/** Who the box of who liked a post shows, each once by their business, in its order. Empty while none is open. */
export function likersOn(doc: Document, base: string): Named[] {
  const box = likersBox(doc, base);
  if (!box) return [];
  const found = new Map<string, Named>();
  for (const { a, url } of linksIn(box, base)) {
    const profile = businessRef(url, null);
    const name = clean(a.textContent);
    if (!profile || !name || found.has(profile.url)) continue;
    found.set(profile.url, { name, profile });
    if (found.size >= ALIGNABLE_LIKERS_MOST) break;
  }
  return [...found.values()];
}

/** Whether an element scrolls up and down by itself. */
function scrolls(element: Element): boolean {
  if (element.scrollHeight <= element.clientHeight + 4) return false;
  const style = getComputedStyle(element);
  return style.overflowY === 'auto' || style.overflowY === 'scroll';
}

/** Its own button for more at the foot of the box. */
const MORE = /^(show|load|see|view) (more|all)$/i;

/**
 * The box of who liked a post, a screen further down (decision 116: up to 3 screens of it, the job's): its list
 * scrolled most of a screen, else its own Show more pressed. Whether there was more to go.
 */
export function scrollLikers(doc: Document, base: string): boolean {
  const box = likersBox(doc, base);
  if (!box) return false;
  const list = [box, ...box.querySelectorAll('*')].find(scrolls);
  if (list) {
    const before = list.scrollTop;
    list.scrollTop = before + Math.max(200, list.clientHeight * 0.8);
    if (list.scrollTop !== before) return true;
  }
  const more = controlsSaying(box, MORE)[0];
  if (!more) return false;
  more.click();
  return true;
}

/** The post's own count of likes: the number beside the word Like in its counts, or a control that says "3 Likes". */
function likesCountIn(root: Element): HTMLElement | null {
  const said = controlsSaying(root, LIKES_COUNT)[0];
  if (said) return said;
  for (const span of root.querySelectorAll('span')) {
    if (!/^likes?$/i.test(clean(span.textContent))) continue;
    const count = span.previousElementSibling;
    if (!count || !/^\d[\d,]*$/.test(clean(count.textContent))) continue;
    return (
      (count.closest('a, button, [role="button"]') as HTMLElement | null) ?? (count as HTMLElement)
    );
  }
  return null;
}

/**
 * Opens the box of who liked the post, on a discussion's own page only, by the post's own count of likes (never an
 * answer's). Whether it pressed it, or the box is open already.
 */
export function openLikers(doc: Document, href: string): boolean {
  if (likersBox(doc, href)) return true;
  if (!discussionIdOf(href)) return false;
  const post = postParts(doc, href)[0];
  const count = post ? likesCountIn(post.root) : null;
  if (!count) return false;
  count.click();
  return true;
}

/** Closes the box of who liked the post by its own Close, else Escape, and waits for it to go. Whether it went. */
export async function closeLikers(doc: Document): Promise<boolean> {
  const box = [...doc.querySelectorAll(OVER_THE_PAGE)].filter(visible).reverse()[0] ?? null;
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
