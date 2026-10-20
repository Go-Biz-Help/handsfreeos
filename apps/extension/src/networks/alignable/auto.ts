/**
 * The presses Alignable's runner makes on its own (src/auto/alignable.ts; partners stage 6c, part 5), once the person
 * lets it, each only on the page it's for, in the runner's tab (../looking/kit.ts):
 *
 * - **Like** a recent post of theirs on their business page: only a post they wrote, only its own Like (a link drawn
 *   as a button: never its count, which opens who liked it, and never an answer's), and only while it isn't liked yet.
 *   It's liked once the Like says so (Liked, Unlike, or pressed) or its count goes up.
 * - **Connect** on their business page: only its own, a link to /biz/connection_requests/… carrying Alignable's id for
 *   their business, and only while it says Connect. It makes the request at once and may open another page, so the tab
 *   answers as it presses, and the runner opens their page again to see the request went.
 * - **A message** in their conversation (/biz/conversations?with_business_id=<id>): typed only into that conversation's
 *   own box (`full-view-write-message`) while it's empty, and sent with its Send (`messaging-send-external`). It went
 *   once the box empties.
 *
 * Nothing else is pressed, and nothing is written anywhere else: never a comment, a forum answer or a recommendation,
 * which stay the person's. Like the readers, it goes by Alignable's own test ids, its links' addresses and its words,
 * never class names.
 */
import type { AutoResult, TheirPost } from '../facebook/auto';
import { visible } from '../facebook/fetch';
import type { ProfileRef } from '../facebook/types';
import { nameOf, pause, waitFor, writingIn } from '../looking/looks';
import {
  businessPage,
  chatOpen,
  CONNECT_AT,
  idIn,
  likesIn,
  linksIn,
  PART,
  postParts,
  urlOf,
} from './read';

/** A post's Like, not liked yet; and once it is. */
const LIKE = /^like$/i;
const LIKED = /^(liked|unlike)$/i;
/** Its Connect, and what it says once they're asked or connected. */
const CONNECT = /^(connect|connect with\b.*)$/i;
const ASKED = /^(connected|request sent|requested|pending|invitation sent)$/i;
/** Where a person writes. */
const WRITING = '[contenteditable="true"], textarea, [role="textbox"]';
/** How long a like and a message are waited on to show they went. */
const WENT_MS = 5_000;
const SENT_MS = 6_000;

/** Whether two links are to the same business: by Alignable's id when both carry it, else its address in its town. */
export function sameBusiness(a: ProfileRef, b: ProfileRef): boolean {
  if (a.id && b.id) return a.id === b.id;
  if (a.username && b.username) return a.username.toLowerCase() === b.username.toLowerCase();
  return a.url.toLowerCase() === b.url.toLowerCase();
}

/** Whether a Like shows it's given: it says Liked or Unlike, or it's pressed. */
const likedNow = (like: Element) =>
  LIKED.test(nameOf(like)) || like.getAttribute('aria-pressed') === 'true';

/** A post's own Like: one saying Like (or Liked), in the post and not in one of its answers; never its count. */
export function likeOf(post: Element, base: string): HTMLElement | null {
  return (
    [...post.querySelectorAll<HTMLElement>('a[href], button, [role="button"]')].find((control) => {
      if (control.closest(PART('discussion-comment')) || !visible(control)) return false;
      const words = nameOf(control);
      if (!LIKE.test(words) && !LIKED.test(words)) return false;
      if (!control.matches('a[href]')) return true;
      // Its count ("3 Likes") is a link of its own, to who liked it.
      const url = urlOf(control.getAttribute('href'), base);
      return url !== null && !url.searchParams.has('resource');
    }) ?? null
  );
}

// ------------------------------------------------------------------------------------------------ likes

/** The posts on the page that they wrote, as far as the page has drawn, in page order (the latest first). */
export function theirPosts(
  doc: Document,
  href: string,
  profile: ProfileRef,
): { readonly box: Element; readonly post: TheirPost }[] {
  return postParts(doc, href).flatMap(({ root, thread }) => {
    const author = thread.author?.profile;
    if (!author || !sameBusiness(author, profile)) return [];
    const like = likeOf(root, href);
    return [
      {
        box: root,
        post: {
          url: thread.url,
          when: thread.when,
          text: thread.text,
          pictures: [],
          liked: like !== null && likedNow(like),
        },
      },
    ];
  });
}

/** Likes the post of theirs picked (by its link, else its place among theirs), and waits for the like to show. */
export async function likeTheirPost(
  doc: Document,
  href: string,
  profile: ProfileRef,
  pick: { readonly index: number; readonly url: string | null },
): Promise<{ readonly result: AutoResult; readonly postUrl: string | null }> {
  const find = () => {
    const found = theirPosts(doc, href, profile);
    return pick.url ? found.find((f) => f.post.url === pick.url) : found[pick.index];
  };
  const one = find();
  if (!one) return { result: 'none', postUrl: pick.url };
  const like = likeOf(one.box, href);
  if (!like) return { result: 'none', postUrl: one.post.url };
  if (likedNow(like)) return { result: 'already', postUrl: one.post.url };
  const before = likesIn(one.box) ?? 0;
  like.click();
  // Liked: its Like says so, or its count went up. Alignable may draw the post again, so it's found again each look.
  const given = () => {
    const now = find() ?? one;
    const shown = likeOf(now.box, href);
    return (shown !== null && likedNow(shown)) || (likesIn(now.box) ?? 0) > before;
  };
  const went = await waitFor(() => (given() ? true : null), WENT_MS);
  return { result: went ? 'done' : 'not_sent', postUrl: one.post.url };
}

// ------------------------------------------------------------------------------------------------ connect

/** Their own Connect on their business page: a link to /biz/connection_requests/… carrying their business's id. */
export function connectFor(doc: Document, href: string, id: string): HTMLElement | null {
  const main = doc.querySelector('main, [role="main"]') ?? doc.body;
  return (
    linksIn(main, href).find(
      ({ a, url }) =>
        CONNECT_AT.test(url.pathname) &&
        idIn(url) === id &&
        !a.closest(PART('discussion-comment')) &&
        visible(a),
    )?.a ?? null
  );
}

/**
 * Presses their own Connect, on their business page alone (by Alignable's id for it), while it says Connect. It makes
 * the request at once and may open another page, so it answers as it presses, before that page loads: the runner opens
 * their page again to see it went. `already` when it says they're asked or connected; `none` when there's nothing to
 * press, which is the person's.
 */
export function connectOnPage(doc: Document, href: string, profile: ProfileRef): AutoResult {
  const id = profile.id;
  const page = businessPage(doc, href);
  if (!id || !page?.profile || page.profile.id !== id) return 'none';
  const link = connectFor(doc, href, id);
  if (!link) return 'none';
  const words = nameOf(link);
  if (ASKED.test(words)) return 'already';
  if (!CONNECT.test(words)) return 'none';
  link.click();
  return 'done';
}

// ------------------------------------------------------------------------------------------------ messages

/**
 * The box to write to them in: only on their conversation's own page (its address names their business by Alignable's
 * id, and its header, when it links to a business, links to theirs), and only that conversation's own box.
 */
export function messageBoxFor(doc: Document, href: string, them: ProfileRef): HTMLElement | null {
  const url = urlOf(href, href);
  if (!them.id || url?.searchParams.get('with_business_id') !== them.id) return null;
  const chat = chatOpen(doc, href);
  if (chat?.profile?.id && chat.profile.id !== them.id) return null;
  const writes = [...doc.querySelectorAll(PART('full-view-write-message'))];
  if (writes.length !== 1) return null;
  return [...writes[0]!.querySelectorAll<HTMLElement>(WRITING)].find(visible) ?? null;
}

/** The conversation's own Send: in its box's part, else the page's one Send. */
function sendFor(box: Element, doc: Document): HTMLElement | null {
  const own = box
    .closest(PART('full-view-write-message'))
    ?.querySelector<HTMLElement>(PART('messaging-send-external'));
  if (own) return own;
  const all = [...doc.querySelectorAll<HTMLElement>(PART('messaging-send-external'))];
  return all.length === 1 ? all[0]! : null;
}

/** Writes a message to them in their conversation and sends it, waiting a little for its box to show. */
export async function writeMessage(
  doc: Document,
  href: string,
  text: string,
  them: ProfileRef,
): Promise<AutoResult> {
  const box = await waitFor(() => messageBoxFor(doc, href, them), WENT_MS);
  if (!box) return 'none';
  // Something written there already is the person's: left alone.
  if (writingIn(box)) return 'not_sent';
  box.focus();
  box.click();
  await pause(300);
  box.ownerDocument.execCommand('insertText', false, text);
  await pause(800);
  if (!writingIn(box)) return 'not_sent';
  const send = sendFor(box, doc);
  if (!send) return 'none';
  send.click();
  return (await waitFor(() => (writingIn(box) ? null : true), SENT_MS)) ? 'done' : 'not_sent';
}
