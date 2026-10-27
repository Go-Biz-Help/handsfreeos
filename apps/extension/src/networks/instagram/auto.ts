/**
 * The presses Instagram's runner makes on its own (src/auto/instagram.ts; the Instagram and Alignable plan's part 14),
 * once the person lets it, each only on the page it's for, in the runner's tab (../looking/kit.ts):
 *
 * - **Their latest posts**, read off their account's grid, each by its link with what Instagram says it shows.
 * - **Like** on one of their posts, on that post's own page: only a post whose own link names them, only its own Like
 *   (in the bar with its Comment, never a comment's, which sits by its Reply), and only while it says Like. It's liked
 *   once it says Unlike.
 * - **Follow** (or Follow Back) on their account's own page, under their name, only while it says so; followed once it
 *   says Following, or Requested for a private account.
 * - **Message** under their name, which opens a chat with them: over the page, or on its own page.
 * - **A message** in their chat: typed only into its own box (Message), on its page with them or over their account,
 *   while the box is empty, and sent with the box's own Send. It went once the box empties.
 * - **A comment** on a good post of theirs (decision 92, from 0.95.0), once the person OK'd it or the comment hold is
 *   past: only on that post's own page, whose own link names them; only in the post's own box (never one drawn to
 *   reply under someone's comment), only while it's empty, typed as a person types, and sent with that box's own
 *   form's Post. It went once the box empties.
 *
 * Nothing else is pressed, and nothing is written anywhere else. Like the readers, it goes by Instagram's own words,
 * labels, roles and link addresses, never class names.
 */
import type { AutoResult, TheirPost } from '../facebook/auto';
import { clean } from '../facebook/dom';
import { visible } from '../facebook/fetch';
import type { ProfileRef } from '../facebook/types';
import {
  boxesSaying,
  controlsSaying,
  mainOf,
  nameOf,
  pause,
  waitFor,
  writeIn,
  writingIn,
} from '../looking/looks';
import type { CommentOn } from '../looking/site';
import { authorOf, chatOn, linksIn, ownOf, postRootOf, profileOn, says } from './read';
import {
  instagramUrl,
  isCommentLink,
  kindOf,
  partsOf,
  postAuthorOf,
  postOf,
  profileOf,
} from './urls';

const FOLLOW = /^(follow|follow back)$/i;
const FOLLOWED = /^(following|requested)$/i;
const LIKE = /^like$/i;
const LIKED = /^unlike$/i;
const COMMENT = /^comment$/i;
const REPLY = /^reply$/i;
const MESSAGE = /^message$/i;
const SEND = /^send$/i;
/** A post's own box to comment in, as its label says, and its form's Post. */
const COMMENT_BOX = /^add a comment/i;
const POST = /^post$/i;
/** A chat's box to write in, as its label says. */
const CHAT_BOX = /^(message|write a message)/i;
/** How long a like, a follow and a message are waited on to show they went. */
const WENT_MS = 6_000;
const SENT_MS = 8_000;

/** Whether an account is the one asked for: the same name in its address, whatever its case. */
const isThem = (username: string | null | undefined, them: ProfileRef): boolean =>
  !!username && !!them.username && username.toLowerCase() === them.username.toLowerCase();

/** Their account's own page in the tab: its address and its header both theirs. */
function theirAccount(doc: Document, href: string, them: ProfileRef) {
  const page = instagramUrl(href);
  if (!page || kindOf(page) !== 'profile' || !isThem(profileOf(page)?.username, them)) return null;
  const profile = profileOn(doc, href);
  const header = mainOf(doc).querySelector('header');
  return profile && header && isThem(profile.username, them) ? { profile, header } : null;
}

// ------------------------------------------------------------------------------------------------ likes

/** Their latest posts, off their account's grid: each by its link, with what Instagram says it shows. */
export function theirPosts(doc: Document, href: string, them: ProfileRef): TheirPost[] {
  const account = theirAccount(doc, href, them);
  if (!account) return [];
  return account.profile.posts.map((url, i) => ({
    url,
    when: null,
    text: account.profile.pictures[i] ?? '',
    pictures: [],
    liked: false,
  }));
}

/** The post's own Like (or Unlike): in the bar with its Comment, never a comment's, which has its Reply beside it. */
export function postLikeOf(root: Element): HTMLElement | null {
  return (
    controlsSaying(root, /^(like|unlike)$/i, true).find((control) => {
      let bar: Element | null = control.parentElement;
      for (let n = 0; bar && n < 3 && !says(bar, COMMENT); n++) bar = bar.parentElement;
      return !!bar && says(bar, COMMENT) && !says(bar, REPLY);
    }) ?? null
  );
}

/**
 * Likes the post the tab shows, when it's theirs (its own link names them) and the one picked: `done` once it says
 * Unlike, `already` when it did, `none` when it isn't theirs or has no Like, `not_sent` when Instagram didn't take it.
 */
export async function likeTheirPost(
  doc: Document,
  href: string,
  them: ProfileRef,
  pick: { readonly index: number; readonly url: string | null },
): Promise<{ readonly result: AutoResult; readonly postUrl: string | null }> {
  const page = instagramUrl(href);
  const url = page && kindOf(page) === 'post' ? postOf(page) : null;
  if (!url || (pick.url && postOf(new URL(pick.url)) !== url))
    return { result: 'none', postUrl: pick.url };
  const root = postRootOf(doc);
  if (!isThem(authorOf(root, href, partsOf(new URL(url))[1]!)?.username, them))
    return { result: 'none', postUrl: url };
  const like = postLikeOf(root);
  if (!like) return { result: 'none', postUrl: url };
  if (LIKED.test(nameOf(like))) return { result: 'already', postUrl: url };
  if (!LIKE.test(nameOf(like))) return { result: 'none', postUrl: url };
  like.click();
  // Instagram may draw the bar again: its Like is found again each look.
  const went = await waitFor(() => {
    const now = postLikeOf(postRootOf(doc));
    return now && LIKED.test(nameOf(now)) ? true : null;
  }, WENT_MS);
  return { result: went ? 'done' : 'not_sent', postUrl: url };
}

// ------------------------------------------------------------------------------------------------ follow

/**
 * Presses Follow (or Follow Back) under their name on their account's own page, while it says so: `done` once it says
 * Following or Requested, `already` when it did, `none` when it isn't their page or has no Follow, `not_sent` when
 * Instagram didn't take it.
 */
export async function followThem(
  doc: Document,
  href: string,
  them: ProfileRef,
): Promise<AutoResult> {
  const account = theirAccount(doc, href, them);
  if (!account) return 'none';
  if (controlsSaying(account.header, FOLLOWED, true).length) return 'already';
  const follow = controlsSaying(account.header, FOLLOW)[0];
  if (!follow) return 'none';
  follow.click();
  const went = await waitFor(() => {
    const header = mainOf(doc).querySelector('header');
    return header && controlsSaying(header, FOLLOWED, true).length ? true : null;
  }, WENT_MS);
  return went ? 'done' : 'not_sent';
}

// ------------------------------------------------------------------------------------------------ messages

/** Presses Message under their name on their account's own page, which opens a chat with them. Whether it could. */
export function openTheirChat(doc: Document, href: string, them: ProfileRef): boolean {
  const account = theirAccount(doc, href, them);
  const message = account ? controlsSaying(account.header, MESSAGE)[0] : null;
  if (!message) return false;
  message.click();
  return true;
}

/**
 * The account a chat opened over a page is with: the nearest part around its box that links to an account, when it
 * links to exactly one other than the person's own.
 */
function withAround(box: Element, doc: Document, href: string): string | null {
  const own = ownOf(doc, href)?.toLowerCase();
  for (let up = box.parentElement, n = 0; up && n < 20; up = up.parentElement, n++) {
    const accounts = new Set(
      linksIn(up, href)
        .map(({ url }) => profileOf(url)?.username.toLowerCase())
        .filter((u): u is string => !!u && u !== own),
    );
    if (accounts.size > 1) return null;
    if (accounts.size === 1) return [...accounts][0]!;
  }
  return null;
}

/**
 * The box to write to them in: on their chat's own page (/direct/t/<id>/), when it's with them, its own box; else, in
 * a chat opened over their account, the one box whose chat is with them.
 */
export function chatBoxFor(doc: Document, href: string, them: ProfileRef): HTMLElement | null {
  const page = instagramUrl(href);
  if (page && kindOf(page) === 'chat') {
    const chat = chatOn(doc, href, ownOf(doc, href));
    if (!isThem(chat?.with?.username, them)) return null;
    const boxes = boxesSaying(mainOf(doc), CHAT_BOX);
    return boxes.length === 1 ? boxes[0]! : null;
  }
  const theirs = boxesSaying(doc, CHAT_BOX).filter((box) =>
    isThem(withAround(box, doc, href), them),
  );
  return theirs.length === 1 ? theirs[0]! : null;
}

/** The box's own Send: the nearest part around it that holds one. */
function sendFor(box: Element): HTMLElement | null {
  for (let up = box.parentElement, n = 0; up && n < 6; up = up.parentElement, n++) {
    const send = controlsSaying(up, SEND).find((c) => visible(c));
    if (send) return send;
  }
  return null;
}

/** Writes a message to them in their chat and sends it, waiting a little for its box to show. */
export async function writeMessage(
  doc: Document,
  href: string,
  text: string,
  them: ProfileRef,
): Promise<AutoResult> {
  // A chat opened over the page moves the tab nowhere; one on its own page has its own address.
  const box = await waitFor(() => chatBoxFor(doc, doc.location?.href ?? href, them), WENT_MS);
  if (!box) return 'none';
  // Something written there already is the person's: left alone.
  if (writingIn(box)) return 'not_sent';
  box.focus();
  box.click();
  await pause(300);
  doc.execCommand('insertText', false, text);
  await pause(800);
  if (!writingIn(box)) return 'not_sent';
  const send = await waitFor(() => sendFor(box), 2_000);
  if (!send) return 'none';
  send.click();
  return (await waitFor(() => (writingIn(box) ? null : true), SENT_MS)) ? 'done' : 'not_sent';
}

// ------------------------------------------------------------------------------------------------ comments

/** Who a post's own link names (/<name>/p/<code>/): never the account beside it, which may be someone it tags. */
function namedByItsLink(root: Element, href: string, code: string): string | null {
  for (const { url } of linksIn(root, href)) {
    const name = postAuthorOf(url);
    if (name && partsOf(url)[2] === code) return name;
  }
  return null;
}

/**
 * Whether a box sits among the post's comments, drawn to reply under one: the nearest part around it that holds a
 * comment (its own link, or its Reply) doesn't hold the post's own Like too, as the part around the post's own box
 * does.
 */
function amongComments(box: Element, root: Element, href: string): boolean {
  for (let up = box.parentElement; up; up = up.parentElement) {
    const comment = linksIn(up, href).some(({ url }) => isCommentLink(url)) || says(up, REPLY);
    if (comment) return postLikeOf(up) === null;
    if (up === root) break;
  }
  return false;
}

/**
 * The post's own box to comment in, on its page: the one box saying "Add a comment…" in the post's part of the page,
 * never one among its comments. Null with none, or with more than one, as which is the post's can't be told.
 */
export function postCommentBoxOf(doc: Document, href: string): HTMLElement | null {
  const root = postRootOf(doc);
  const boxes = boxesSaying(root, COMMENT_BOX).filter((box) => !amongComments(box, root, href));
  return boxes.length === 1 ? boxes[0]! : null;
}

/** The box's own form's Post, while it's on: in its form, else the nearest part around it that holds one. */
function postFor(box: Element): HTMLElement | null {
  const form = box.closest('form');
  if (form) return controlsSaying(form, POST)[0] ?? null;
  for (let up = box.parentElement, n = 0; up && n < 3; up = up.parentElement, n++) {
    const post = controlsSaying(up, POST);
    if (post.length) return post.length === 1 ? post[0]! : null;
  }
  return null;
}

/** What's written in a box, as one line: a plain box's value, or the words in one drawn to write in. */
const writtenIn = (box: Element): string =>
  clean('value' in box && typeof box.value === 'string' ? box.value : box.textContent);

/**
 * Comments on their post and posts it (decision 92), once the person OK'd it or the comment hold is past: only on the
 * post asked for, on its own page, when its own link names them (`on`); only in the post's own box, never one among its
 * comments, and only while that box is empty; typed as a person types (`writeIn`), then sent with that box's own Post.
 * `done` once the box empties; `none` with no such page or box, or no Post by it (what was typed is taken out again);
 * `not_sent` when the box had writing in it already, what was typed didn't take, or Instagram didn't take it.
 */
export async function writeTheirComment(
  doc: Document,
  href: string,
  on: CommentOn,
  text: string,
): Promise<AutoResult> {
  const page = instagramUrl(href);
  const url = page && kindOf(page) === 'post' ? postOf(page) : null;
  const asked = instagramUrl(on.postUrl);
  if (!url || !asked || postOf(asked) !== url || !text.trim()) return 'none';
  const code = partsOf(new URL(url))[1]!;
  if (!isThem(namedByItsLink(postRootOf(doc), href, code), on.profile)) return 'none';
  // Instagram draws the form again once its box has the focus (Post shows), so the box is found again each look.
  const now = () => postCommentBoxOf(doc, href);
  const box = await waitFor(now, WENT_MS);
  if (!box) return 'none';
  // Something written there already is the person's: left alone.
  if (writingIn(box)) return 'not_sent';
  box.focus();
  box.click();
  await pause(400);
  const live = now();
  if (!live) return 'none';
  if (writingIn(live)) return 'not_sent';
  writeIn(doc, live, text);
  const typed = await waitFor(() => {
    const b = now();
    return b && writtenIn(b) === clean(text) ? b : null;
  }, 1_500);
  const takeOut = () => {
    const b = now();
    if (b && writingIn(b)) writeIn(doc, b, '');
  };
  if (!typed) {
    takeOut();
    return 'not_sent';
  }
  const post = await waitFor(() => {
    const b = now();
    return b ? postFor(b) : null;
  }, 3_000);
  if (!post) {
    takeOut();
    return 'none';
  }
  post.click();
  const went = await waitFor(() => {
    const b = now();
    return b && !writingIn(b) ? true : null;
  }, SENT_MS);
  return went ? 'done' : 'not_sent';
}
