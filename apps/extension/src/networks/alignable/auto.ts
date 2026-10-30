/**
 * The presses Alignable's runner makes on its own (src/auto/alignable.ts; partners stage 6c, part 5), once the person
 * lets it, each only on the page it's for, in the runner's tab (../looking/kit.ts):
 *
 * - **Like** a recent post of theirs on their business page: only a post they wrote, only its own Like (a link drawn
 *   as a button: never its count, which opens who liked it, and never an answer's), and only while it isn't liked yet.
 *   It's liked once the Like says so (Liked, Unlike, or pressed) or its count goes up.
 * - **Like** their answer on a good post (decision 116, from 0.108.0), the warm-up for a business found by its answer:
 *   on that post's own page, by its discussion's id, the first answer its author line says they wrote, and only its own
 *   Like (never its count, nor a reply's under it), only while it isn't liked yet. Alignable's answers' Like is read
 *   from guessed markup till the owner's next Check Alignable outlines one.
 * - **Connect** on their business page: only its own, a link to /biz/connection_requests/… carrying Alignable's id for
 *   their business, and only while it says Connect: never while their page shows you're connected (its own Remove
 *   Connection, 0.94.0). It makes the request at once and may open another page, so the tab answers as it presses, and
 *   the runner opens their page again to see the request went.
 * - **A message** in their conversation (/biz/conversations?with_business_id=<id>): typed only into that conversation's
 *   own box (`full-view-write-message`) while it's empty, and sent with its Send (`messaging-send-external`, since 30
 *   Oct 2026 `messaging-send-desktop`). It went once the box empties.
 * - **A comment** on a good post (from 0.95.0, decision 92), once it's OK'd or past the comment hold: only on the post's
 *   own page, by its discussion's id, only in its own reply form at the top (`discussion-comment-reply-form`), never
 *   one under an answer, only while its box is empty, and sent with that form's own Send. It went once the box empties.
 *   An answer to a post asking for what the business offers waits for the person's OK every time (decision 79): that's
 *   HandsFreeOS's to hold, and this only writes what it's handed.
 * - **Join** on a group's own page (from 0.95.0, decision 92): only its own, never one on another group's card, and
 *   only while it says Join. Alignable asks no questions before a join, as far as its pages showed; a box asking
 *   something instead is the person's.
 *
 * Nothing else is pressed, and nothing is written anywhere else: never a recommendation, which stays the person's.
 * Like the readers, it goes by Alignable's own test ids, its links' addresses and its words, never class names.
 */
import type { CommentLiked, TheirComment } from '../../messages';
import type { AutoResult, TheirPost } from '../facebook/auto';
import { squashed, timesShown } from '../facebook/dom';
import { visible } from '../facebook/fetch';
import type { JoinStep } from '../facebook/join';
import type { ProfileRef } from '../facebook/types';
import { nameOf, pause, waitFor, writeIn, writingIn } from '../looking/looks';
import type { CommentOn } from '../looking/site';
import {
  answerParts,
  businessPage,
  chatHeader,
  chatOpen,
  CONNECT_AT,
  differ,
  discussionIdOf,
  groupStanding,
  idIn,
  isDiscussionPage,
  likesIn,
  linksIn,
  MESSAGE_SEND,
  PART,
  postParts,
  urlOf,
} from './read';

/** Alignable's own address: an answer's link is its discussion's. */
const ALIGNABLE = 'https://www.alignable.com';
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
const SENT_MS = 8_000;

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

// ------------------------------------------------------------------------------------------------ an answer's like

/** An answer's own Like: one saying Like (or Liked) in it, not in a reply under it; never its count. */
export function answerLikeOf(answer: Element, base: string): HTMLElement | null {
  return (
    [...answer.querySelectorAll<HTMLElement>('a[href], button, [role="button"]')].find(
      (control) => {
        if (control.closest(PART('discussion-comment')) !== answer || !visible(control))
          return false;
        const words = nameOf(control);
        if (!LIKE.test(words) && !LIKED.test(words)) return false;
        if (!control.matches('a[href]')) return true;
        const url = urlOf(control.getAttribute('href'), base);
        return url !== null && !url.searchParams.has('resource');
      },
    ) ?? null
  );
}

/**
 * Their answer on the discussion the tab shows (decision 116): the first answer (or reply) its own author line says
 * their business wrote, with what it says and its own Like. Null when the page shows none of theirs.
 */
export function theirAnswerOn(
  doc: Document,
  href: string,
  profile: ProfileRef,
): { readonly answer: Element; readonly text: string; readonly like: HTMLElement | null } | null {
  const theirs = answerParts(doc, href).find(
    ({ read }) => read.author?.profile && sameBusiness(read.author.profile, profile),
  );
  return theirs
    ? { answer: theirs.answer, text: theirs.read.text, like: answerLikeOf(theirs.answer, href) }
    : null;
}

/** The discussion's id when the page's post is the one asked for, by it; else null. */
function askedPost(doc: Document, href: string, postUrl: string): string | null {
  const id = discussionIdOf(postUrl);
  const shown = postParts(doc, href)[0]?.thread.url ?? href;
  return id && discussionIdOf(shown) === id ? id : null;
}

/**
 * Their answer on the post asked for, as the page shows it (decision 116): what it says, the discussion's link (an
 * answer has none of its own), and whether the person's like is on it (null with no Like to press). Null when the
 * page's post isn't that one or shows no answer of theirs.
 */
export function theirAnswer(
  doc: Document,
  href: string,
  profile: ProfileRef,
  postUrl: string,
): TheirComment | null {
  const id = askedPost(doc, href, postUrl);
  const theirs = id ? theirAnswerOn(doc, href, profile) : null;
  if (!theirs) return null;
  return {
    text: theirs.text || null,
    commentUrl: `${ALIGNABLE}/biz/discussions/${id}`,
    liked: theirs.like ? likedNow(theirs.like) : null,
  };
}

/**
 * Likes their answer on a good post's own page (decision 116: the warm-up for a business found by its answer), when
 * the page's post is the one asked for, by its discussion's id: the answer's own Like, while it isn't liked yet. `done`
 * once it says so, `already` when it did, `none` when the page isn't that post, shows no answer of theirs or no Like
 * on it, `not_sent` when Alignable didn't take it; with the discussion's link (an answer has none of its own) and what
 * the answer says.
 */
export async function likeTheirAnswer(
  doc: Document,
  href: string,
  profile: ProfileRef,
  postUrl: string,
): Promise<CommentLiked> {
  const id = askedPost(doc, href, postUrl);
  if (!id) return { result: 'none', commentUrl: null, text: null };
  const theirs = theirAnswerOn(doc, href, profile);
  const said = {
    commentUrl: theirs ? `${ALIGNABLE}/biz/discussions/${id}` : null,
    text: theirs?.text || null,
  };
  if (!theirs?.like) return { result: 'none', ...said };
  if (likedNow(theirs.like)) return { result: 'already', ...said };
  theirs.like.click();
  // Alignable may draw the answers again: its Like is found again each look.
  const went = await waitFor(() => {
    const now = theirAnswerOn(doc, href, profile)?.like;
    return now && likedNow(now) ? true : null;
  }, WENT_MS);
  return { result: went ? 'done' : 'not_sent', ...said };
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
 * their page again to see it went. `already` when their page shows you're connected (its own Remove Connection) or its
 * Connect says they're asked or connected; `none` when there's nothing to press, which is the person's.
 */
export function connectOnPage(doc: Document, href: string, profile: ProfileRef): AutoResult {
  const id = profile.id;
  const page = businessPage(doc, href);
  if (!id || !page?.profile || page.profile.id !== id) return 'none';
  if (page.connected) return 'already';
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
 * id, and its header, once drawn, links to theirs: by that id when its link has one, else by its address in its
 * town), and only that conversation's own box.
 */
export function messageBoxFor(doc: Document, href: string, them: ProfileRef): HTMLElement | null {
  const url = urlOf(href, href);
  if (!them.id || url?.searchParams.get('with_business_id') !== them.id) return null;
  if (!chatHeader(doc)) return null;
  const linked = chatOpen(doc, href)?.profile;
  if (!linked || !(linked.id ? linked.id === them.id : sameBusiness(linked, them))) return null;
  const writes = [...doc.querySelectorAll(PART('full-view-write-message'))];
  if (writes.length !== 1) return null;
  return [...writes[0]!.querySelectorAll<HTMLElement>(WRITING)].find(visible) ?? null;
}

/** The conversation's own Send: in its box's part, else the page's one Send. */
function sendFor(box: Element, doc: Document): HTMLElement | null {
  const own = box
    .closest(PART('full-view-write-message'))
    ?.querySelector<HTMLElement>(MESSAGE_SEND);
  if (own) return own;
  const all = [...doc.querySelectorAll<HTMLElement>(MESSAGE_SEND)];
  return all.length === 1 ? all[0]! : null;
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
 * Writes a message to them in their conversation and sends it, waiting a little for its box to show. Nothing is typed
 * unless the focus is in their box, and nothing is sent unless, just before Send is pressed, it's still their
 * conversation's box; else what was typed is taken out again (`not_theirs`).
 */
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
  if (!focusIn(box)) return 'not_theirs';
  box.ownerDocument.execCommand('insertText', false, text);
  await pause(800);
  if (!writingIn(box)) return 'not_sent';
  const send = sendFor(box, doc);
  if (!send) return 'none';
  // The conversation open may have changed as it was typed: by its address, or what its header links to.
  if (messageBoxFor(doc, doc.location?.href ?? href, them) !== box) {
    takeOut(box);
    return 'not_theirs';
  }
  // It went once the box empties, or what was typed shows once more in the conversation: Alignable sometimes leaves
  // the writing in the box after it sends (the owner's sends of 30 Oct 2026, on 0.114.0, said "didn't take" of
  // messages that were in the conversation).
  const before = timesShown(doc, text, WRITING);
  send.click();
  const went = await waitFor(
    () => (!writingIn(box) || timesShown(doc, text, WRITING) > before ? true : null),
    SENT_MS,
  );
  if (!went) return 'not_sent';
  // What was typed left in the box after it went is taken out, so the next message finds it empty.
  if (
    box.isConnected &&
    writingIn(box) &&
    !(await waitFor(() => (writingIn(box) ? null : true), 2_000)) &&
    squashed('value' in box ? String(box.value) : box.textContent) === squashed(text)
  )
    takeOut(box);
  return 'done';
}

// ------------------------------------------------------------------------------------------------ comments

/** A reply form's own Send, by its words. */
const SEND = /^(send|post|reply|comment|submit)$/i;

/** The post's own reply form at the top of its page: the only one there not under an answer, else none. */
function topReplyForm(doc: Document): Element | null {
  const forms = [...doc.querySelectorAll(PART('discussion-comment-reply-form'))].filter(
    (form) => !form.closest(PART('discussion-comment')) && visible(form),
  );
  return forms.length === 1 ? forms[0]! : null;
}

/**
 * A comment on their post (decision 92), once it's OK'd or past the hold: only on a discussion's own page whose post
 * (its first) is the one asked for, by its discussion's id, and isn't plainly another business's; only in the post's
 * own reply form at the top, never one under an answer; only while its box is empty; and sent with that form's own
 * Send. It went once the box empties. `none` with no such page, post, form, box or Send; `not_sent` when something's
 * written there already (the person's), or Alignable didn't take it.
 */
export async function commentOn(
  doc: Document,
  href: string,
  text: string,
  on: CommentOn,
): Promise<AutoResult> {
  const id = discussionIdOf(on.postUrl);
  if (!id || !isDiscussionPage(href)) return 'none';
  const post = postParts(doc, href)[0];
  if (!post || discussionIdOf(post.thread.url) !== id) return 'none';
  const author = post.thread.author?.profile;
  if (author && differ(author, on.profile)) return 'none';
  const form = topReplyForm(doc);
  const box = form ? [...form.querySelectorAll<HTMLElement>(WRITING)].find(visible) : undefined;
  const send = form
    ? [...form.querySelectorAll<HTMLElement>('button, [role="button"], input[type="submit"]')].find(
        (b) => visible(b) && SEND.test(nameOf(b)),
      )
    : undefined;
  if (!box || !send) return 'none';
  // Something written there already is the person's: left alone.
  if (writingIn(box)) return 'not_sent';
  writeIn(doc, box, text);
  await pause(800);
  if (!writingIn(box)) return 'not_sent';
  send.click();
  return (await waitFor(() => (writingIn(box) ? null : true), SENT_MS)) ? 'done' : 'not_sent';
}

// ------------------------------------------------------------------------------------------------ groups

/** A box over the page that asks something before a join: anything in it to write in or pick from. */
const ASKS =
  'textarea, input[type="text"], input[type="radio"], input[type="checkbox"], select, [role="radio"], [role="checkbox"], [contenteditable="true"]';
const askedSomething = (doc: Document) =>
  [...doc.querySelectorAll('[role="dialog"], dialog[open], [aria-modal="true"]')].some(
    (box) => visible(box) && box.querySelector(ASKS) !== null,
  );

/**
 * Presses the group's own Join on its page (decision 92): only on a group's own page (or its About or members page),
 * only its own, never one on another group's card, and only while it says Join. A Join drawn as a link may open
 * another page, so the tab answers as it presses, and the runner opens the group again to see it went; a button is
 * waited on to say Joined or Requested. Never `questions`: Alignable asks none before a join, as far as its pages
 * showed, so the runner never waits on the AI's answers; a box asking something instead is the person's (`choices`).
 */
export async function joinOnPage(doc: Document, href: string): Promise<JoinStep> {
  const now = groupStanding(doc, href);
  if (!now) return { result: 'none' };
  if (now.joined || now.asked) return { result: 'already', joined: now.joined };
  const join = now.join;
  if (!join || !visible(join)) return { result: 'none' };
  join.click();
  if (join.matches('a[href]')) return { result: 'asked' };
  const went = await waitFor(() => {
    if (askedSomething(doc)) return 'choices';
    const after = groupStanding(doc, href);
    return after && (after.joined || after.asked) ? 'went' : null;
  }, WENT_MS);
  return went === 'choices' ? { result: 'choices' } : { result: 'asked' };
}
