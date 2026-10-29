/**
 * Each post's own link on LinkedIn's post search, where its newer layout shows none (docs/outreach.md, decision 123;
 * the owner's Check LinkedIn of 29 Oct 2026: six posts read, not one with a link, its time plain words, every link in
 * it to its writer or a hashtag). A post with no link can't be kept, so its writer was never found. Here, for each
 * person's post with none: its menu ("Open control menu for post by …"), then Copy link to post, the link it copies
 * caught on the page before it reaches the person's clipboard (../copies.ts), and the menu closed. Nothing is pressed
 * unless the page catches copies, so the person's clipboard is never written to. After two posts whose menu had no
 * Copy link to post, or gave no link, it stops, with the page's outline taken while the menu was open (decision 74).
 *
 * Runs in the tab, on the page in front of it.
 */
import type { PostLinksAnswer } from '../../messages';
import { CATCH, CATCHING, COPIED } from '../copies';
import { pause } from '../facebook/editors';
import { nameOf, shown } from '../facebook/fetch';
import { closeMenu, openMenu } from '../fill';
import { waitFor } from '../looking/looks';
import { CONTROLS, mainOf, placesOf, wordsOf } from './dom';
import { outlineNow } from './outline';
import { postBoxes, readPost } from './posts';
import type { Post } from './types';
import { linkedinUrl, postUrlFrom } from './urls';
import { POST_MENU } from './vocabulary';

/** The item of a post's menu that copies its link. */
export const COPY_LINK = /^copy link( to (this )?post)?$/i;
/** How long a press on Copy link to post has to copy. */
const COPY_MS = 3_000;
/** Posts in a row whose menu gave no link before it stops trying. */
const TRIES = 2;

/** A post as the page and the job both know it: its writer's profile and the start of its words. */
export const postKey = (post: Pick<Post, 'author' | 'text'>): string =>
  `${post.author?.profile?.url ?? post.author?.name ?? ''}|${post.text.slice(0, 80)}`;

/** The post's own menu: the control that names it ("Open control menu for post by Dana Reyes"). */
const menuOf = (box: Element): HTMLElement | null =>
  [...box.querySelectorAll<HTMLElement>(CONTROLS)].find(
    (control) => shown(control) && wordsOf(control).some((w) => POST_MENU.test(w)),
  ) ?? null;

/** The link a press copies, caught on the page's root (LinkedIn's /posts/… or /feed/update/…), as a post's own. */
async function copiedBy(doc: Document, item: HTMLElement): Promise<string | null> {
  const root = doc.documentElement;
  root.removeAttribute(COPIED);
  root.setAttribute(CATCH, '');
  try {
    item.click();
    const copied = await waitFor(() => root.getAttribute(COPIED), COPY_MS);
    const link = copied ? linkedinUrl(copied.trim(), doc.location.href) : null;
    return link ? postUrlFrom(link) : null;
  } finally {
    root.removeAttribute(CATCH);
    root.removeAttribute(COPIED);
  }
}

/**
 * The links of up to `most` people's posts on the page with none, but those whose key is in `skip` (tried already):
 * each from its menu's Copy link to post.
 */
export async function postLinksOn(
  doc: Document,
  href: string,
  most: number,
  skip: readonly string[] = [],
): Promise<PostLinksAnswer> {
  if (!doc.documentElement.hasAttribute(CATCHING))
    return { ok: false, error: 'The page can’t catch a copied link, so nothing was pressed.' };
  const skipped = new Set(skip);
  const links: { key: string; url: string }[] = [];
  const tried: string[] = [];
  const found = { posts: 0, menus: 0, items: 0, copied: 0 };
  let outline: string | undefined;
  let missed = 0;
  for (const box of postBoxes(mainOf(doc))) {
    if (found.posts >= most || missed >= TRIES) break;
    const post = readPost(box, href);
    if (!post || post.url || post.company || !post.author?.profile) continue;
    const key = postKey(post);
    if (skipped.has(key)) continue;
    found.posts++;
    tried.push(key);
    const menu = menuOf(box);
    if (!menu) continue;
    const items = await openMenu(doc, menu, placesOf(doc));
    if (items.length) found.menus++;
    const copy = items.find((item) => COPY_LINK.test(nameOf(item)));
    if (!copy) {
      outline ??= outlineNow(doc);
      if (items.length) closeMenu(doc);
      missed++;
      continue;
    }
    found.items++;
    const url = await copiedBy(doc, copy);
    // LinkedIn closes its menu once an item's pressed; one still open is closed.
    if (items.some((item) => item.isConnected && shown(item))) closeMenu(doc);
    if (!url) {
      outline ??= outlineNow(doc);
      missed++;
      continue;
    }
    missed = 0;
    found.copied++;
    links.push({ key, url });
    await pause(600 + Math.random() * 600);
  }
  return { ok: true, links, tried, found, ...(outline && !links.length ? { outline } : {}) };
}
