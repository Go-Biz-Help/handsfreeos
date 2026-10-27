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
 *
 * Nothing else is pressed, and nothing is written anywhere else: never a comment, which stays the person's to post
 * (the plan's "Anything public … waits for an OK"). Like the readers, it goes by Instagram's own words, labels, roles
 * and link addresses, never class names.
 */
import type { AutoResult, TheirPost } from '../facebook/auto';
import { visible } from '../facebook/fetch';
import type { ProfileRef } from '../facebook/types';
import {
  boxesSaying,
  controlsSaying,
  mainOf,
  nameOf,
  pause,
  waitFor,
  writingIn,
} from '../looking/looks';
import { authorOf, chatOn, linksIn, ownOf, postRootOf, profileOn, says } from './read';
import { instagramUrl, kindOf, partsOf, postOf, profileOf } from './urls';

const FOLLOW = /^(follow|follow back)$/i;
const FOLLOWED = /^(following|requested)$/i;
const LIKE = /^like$/i;
const LIKED = /^unlike$/i;
const COMMENT = /^comment$/i;
const REPLY = /^reply$/i;
const MESSAGE = /^message$/i;
const SEND = /^send$/i;
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

/** Where a chat's messages are: who they link to (a shared post's author, an account sent) isn't who it's with. */
const MESSAGES = '[role="row"], [role="article"], [role="grid"], [role="log"]';
/** The label Instagram puts on a chat's messages: "Messages in conversation with Dana Reyes". */
const CONVERSATION = /^(messages in )?conversation (with|titled)\b/i;
/** Where a person writes. */
const WRITING = 'textarea, input[type="text"], [role="textbox"], [contenteditable="true"]';

const isConversation = (element: Element) =>
  CONVERSATION.test(element.getAttribute('aria-label')?.trim() ?? '');

/** Whether a link sits in a chat's messages, within a part of the page. */
function inMessages(link: Element, part: Element): boolean {
  for (let up: Element | null = link; up && up !== part; up = up.parentElement)
    if (up.matches(MESSAGES) || isConversation(up)) return true;
  return false;
}

/**
 * The account a chat opened over a page is with: the one other than the person's own that the nearest part around its
 * box links to outside the chat's messages, as its header does. Never the main column or past it, a part with a
 * second box to write in or a second chat's messages, or past the chat's own dialog: past those, the links are the
 * page's or another chat's. Null when it links to nobody there, or to more than one.
 */
function withAround(box: Element, doc: Document, href: string): string | null {
  const own = ownOf(doc, href)?.toLowerCase();
  const main = mainOf(doc);
  for (let up = box.parentElement; up && !up.contains(main); up = up.parentElement) {
    if (
      up.querySelectorAll(WRITING).length > 1 ||
      [...up.querySelectorAll('[aria-label]')].filter(isConversation).length > 1
    )
      return null;
    const part = up;
    const accounts = new Set(
      linksIn(part, href)
        .filter(({ a }) => !inMessages(a, part))
        .map(({ url }) => profileOf(url)?.username.toLowerCase())
        .filter((u): u is string => !!u && u !== own),
    );
    if (accounts.size > 1) return null;
    if (accounts.size === 1) return [...accounts][0]!;
    if (part.matches('[role="dialog"], dialog')) return null;
  }
  return null;
}

/**
 * The box to write to them in: on their chat's own page (/direct/t/<id>/), when it's with them, its own box; else, in
 * a chat opened over their account, outside the page's main column, the one box whose chat is with them. A chat left
 * open from someone else is never theirs.
 */
export function chatBoxFor(doc: Document, href: string, them: ProfileRef): HTMLElement | null {
  const page = instagramUrl(href);
  if (page && kindOf(page) === 'chat') {
    const chat = chatOn(doc, href, ownOf(doc, href));
    if (!isThem(chat?.with?.username, them)) return null;
    const boxes = boxesSaying(mainOf(doc), CHAT_BOX);
    return boxes.length === 1 ? boxes[0]! : null;
  }
  const main = mainOf(doc);
  const theirs = boxesSaying(doc, CHAT_BOX).filter(
    (box) => !main.contains(box) && isThem(withAround(box, doc, href), them),
  );
  return theirs.length === 1 ? theirs[0]! : null;
}

/** The box's own Send: the nearest part around it that holds one, never past one with another box to write in. */
function sendFor(box: Element): HTMLElement | null {
  for (let up = box.parentElement, n = 0; up && n < 6; up = up.parentElement, n++) {
    if (up.querySelectorAll(WRITING).length > 1) return null;
    const send = controlsSaying(up, SEND).find((c) => visible(c));
    if (send) return send;
  }
  return null;
}

/** Whether the focus is in a box: on it, or on something inside it. */
const focusIn = (box: Element) => {
  const focused = box.ownerDocument.activeElement;
  return focused !== null && box.contains(focused);
};

/** Takes what was typed out of a box that was empty before, only with the focus in it. */
function takeOut(box: HTMLElement): void {
  box.focus();
  if (!focusIn(box)) return;
  if (box instanceof box.ownerDocument.defaultView!.HTMLTextAreaElement) box.select();
  else box.ownerDocument.getSelection()?.selectAllChildren(box);
  box.ownerDocument.execCommand('delete', false);
}

/**
 * Writes a message to them in their chat and sends it, waiting a little for its box to show. Nothing is typed unless
 * the focus is in their box, and nothing is sent unless, once typed, it's still their chat's box; else what was typed
 * is taken out again (`not_theirs`).
 */
export async function writeMessage(
  doc: Document,
  href: string,
  text: string,
  them: ProfileRef,
): Promise<AutoResult> {
  // A chat opened over the page moves the tab nowhere; one on its own page has its own address.
  const theirs = () => chatBoxFor(doc, doc.location?.href ?? href, them);
  const box = await waitFor(theirs, WENT_MS);
  if (!box) return 'none';
  // Something written there already is the person's: left alone.
  if (writingIn(box)) return 'not_sent';
  box.focus();
  box.click();
  await pause(300);
  if (!focusIn(box)) return 'not_theirs';
  doc.execCommand('insertText', false, text);
  await pause(800);
  if (writingIn(box) && theirs() !== box) {
    takeOut(box);
    return 'not_theirs';
  }
  if (!writingIn(box)) return 'not_sent';
  const send = await waitFor(() => sendFor(box), 2_000);
  if (!send) return 'none';
  send.click();
  return (await waitFor(() => (writingIn(box) ? null : true), SENT_MS)) ? 'done' : 'not_sent';
}
