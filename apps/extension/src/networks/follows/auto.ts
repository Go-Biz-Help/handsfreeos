/**
 * The presses Threads' and X's runner makes on its own (src/auto/follows.ts, decision 163), once the person lets it,
 * each only on the page it's for, in the runner's tab (../looking/kit.ts):
 *
 * - **Their latest posts**, read off their profile: only posts its address says they wrote, never a repost.
 * - **Like** on one of their posts, on that post's own page: only a post whose own address names them, only its own
 *   Like, and only while it isn't liked. It's liked once it says so.
 * - **Follow** (or Follow back) on their profile, only while it says so; followed once it says Following, or Requested
 *   for a private account.
 * - **A reply under their post** (the comment, decision 92), once the person OK'd it or the comment hold is past: only
 *   on that post's own page, whose own address names them; only in the box to reply to it (X's under it, Threads' in
 *   the box its own Reply opens), only while that box is empty; typed as a person types, and sent with that box's own
 *   button. It went once the box empties or closes.
 * - **Unfollow**, on their profile: Following, then the Unfollow the site asks to be sure with.
 *
 * No message is ever written (decision 163): nothing is pressed in anyone's messages. Nothing else is pressed, and
 * nothing is written anywhere else.
 */
import type { AutoResult, TheirPost } from '../facebook/auto';
import { clean } from '../facebook/dom';
import { visible } from '../facebook/fetch';
import type { ProfileRef } from '../facebook/types';
import { pause, waitFor, writeIn, writingIn } from '../looking/looks';
import type { CommentOn } from '../looking/site';
import { postRootFor, postsOn, sameName } from './read';
import type { FollowSpec } from './types';

/** How long a like, a follow and a reply are waited on to show they went. */
const WENT_MS = 6_000;
const SENT_MS = 10_000;

/** The post its own page shows, by its address, with the part it is: null on any other page. */
function postHere(doc: Document, href: string, spec: FollowSpec) {
  const page = spec.url(href);
  const url = page && spec.kindOf(page) === 'post' ? spec.postOf(page) : null;
  if (!url) return null;
  const root = postRootFor(doc, href, spec, url);
  const author = spec.postAuthorOf(new URL(url));
  return root && author ? { url, root, author } : null;
}

/** Whether a link the runner kept is the post the page shows, however each was written. */
function samePost(spec: FollowSpec, kept: string | null, url: string): boolean {
  if (!kept) return true;
  const asked = spec.url(kept);
  return !!asked && spec.postOf(asked) === url;
}

/** Their profile's own page in the tab, by its address, with its header. */
function theirProfile(doc: Document, href: string, spec: FollowSpec, them: ProfileRef) {
  const page = spec.url(href);
  const account = page && spec.kindOf(page) === 'profile' ? spec.profileOf(page) : null;
  if (!account || !sameName(account.username, them.username)) return null;
  const header = spec.headerOf(doc);
  return header ? { account, header } : null;
}

/** Their latest posts, off their profile: each by its link, with what it says. */
export const theirPosts =
  (spec: FollowSpec) =>
  (doc: Document, href: string, them: ProfileRef): TheirPost[] => {
    if (!theirProfile(doc, href, spec, them)) return [];
    return postsOn(doc, href, spec)
      .filter((p) => sameName(p.author.username, them.username))
      .map((p) => ({
        url: p.url,
        when: p.when,
        text: p.text,
        pictures: [],
        liked: p.liked === true,
      }));
  };

/**
 * Likes the post the tab shows, when it's theirs (its own address names them) and the one picked: `done` once it says
 * it's liked, `already` when it did, `none` when it isn't theirs or has no Like, `not_sent` when the site didn't take
 * it.
 */
export const likeTheirPost =
  (spec: FollowSpec) =>
  async (
    doc: Document,
    href: string,
    them: ProfileRef,
    pick: { readonly index: number; readonly url: string | null },
  ): Promise<{ readonly result: AutoResult; readonly postUrl: string | null }> => {
    const here = postHere(doc, href, spec);
    if (!here || !samePost(spec, pick.url, here.url)) return { result: 'none', postUrl: pick.url };
    if (!sameName(here.author.username, them.username))
      return { result: 'none', postUrl: here.url };
    const like = spec.likeIn(here.root);
    if (!like) return { result: 'none', postUrl: here.url };
    if (like.liked) return { result: 'already', postUrl: here.url };
    like.control.click();
    // The site may draw the post again: its Like is found again each look.
    const went = await waitFor(() => {
      const root = postRootFor(doc, href, spec, here.url);
      return root && spec.likeIn(root)?.liked ? true : null;
    }, WENT_MS);
    return { result: went ? 'done' : 'not_sent', postUrl: here.url };
  };

/**
 * Follows them on their own profile, with its own Follow (or Follow back): `done` once it says Following (or
 * Requested), `already` when it did, `none` with no Follow, `not_sent` when the site didn't take it.
 */
export const followThem =
  (spec: FollowSpec) =>
  async (doc: Document, href: string, them: ProfileRef): Promise<AutoResult> => {
    const profile = theirProfile(doc, href, spec, them);
    if (!profile) return 'none';
    const now = spec.followIn(profile.header);
    if (now.following) return 'already';
    if (!now.follow) return 'none';
    now.follow.click();
    const went = await waitFor(() => {
      const header = spec.headerOf(doc);
      return header && spec.followIn(header).following ? true : null;
    }, WENT_MS);
    return went ? 'done' : 'not_sent';
  };

/**
 * Unfollows the account whose page the tab shows: `done` once it says Follow again; `not_found` when it does already;
 * `none` when it couldn't, with the box it opened closed again.
 */
export const unfollowThem =
  (spec: FollowSpec) =>
  async (doc: Document): Promise<'done' | 'not_found' | 'none'> => {
    const header = spec.headerOf(doc);
    if (!header) return 'none';
    const now = spec.followIn(header);
    if (!now.following) return now.follow ? 'not_found' : 'none';
    now.following.click();
    const confirm = await waitFor(() => spec.unfollowIn(doc), 5_000);
    if (!confirm) {
      doc.dispatchEvent(
        new (doc.defaultView ?? globalThis).KeyboardEvent('keydown', {
          key: 'Escape',
          code: 'Escape',
          bubbles: true,
        }),
      );
      return 'none';
    }
    confirm.click();
    const done = await waitFor(() => {
      const after = spec.headerOf(doc);
      const standing = after ? spec.followIn(after) : null;
      return standing && !standing.following && standing.follow ? true : null;
    }, 8_000);
    return done ? 'done' : 'none';
  };

/** What's written in a box, as one line. */
const writtenIn = (box: Element): string =>
  clean('value' in box && typeof box.value === 'string' ? box.value : box.textContent);

/** The one box to reply in that shows, else null: the last one drawn, where a box over the page shows another too. */
function boxNow(doc: Document, spec: FollowSpec): HTMLElement | null {
  const boxes = spec.replyBoxes(doc).filter((b) => b.isConnected && visible(b));
  const over = boxes.filter((b) => b.closest('[role="dialog"]'));
  return over.at(-1) ?? (boxes.length === 1 ? boxes[0]! : null);
}

/**
 * Replies under their post (decision 92), once the person OK'd it or the comment hold is past: only on the post asked
 * for, on its own page, when its own address names them (`on`); only in the box to reply to it (under it on X; on
 * Threads, the box its own Reply opens), only while that box is empty; typed as a person types (`writeIn`), then sent
 * with that box's own button. `done` once the box empties or closes; `none` with no such page or box, or no button by
 * it (what was typed is taken out again); `not_sent` when the box had writing in it already, what was typed didn't
 * take, or the site didn't take it.
 */
export const writeTheirComment =
  (spec: FollowSpec) =>
  async (doc: Document, href: string, text: string, on: CommentOn): Promise<AutoResult> => {
    const here = postHere(doc, href, spec);
    if (!here || !samePost(spec, on.postUrl, here.url) || !text.trim()) return 'none';
    if (!sameName(here.author.username, on.profile.username)) return 'none';
    let box = await waitFor(() => boxNow(doc, spec), 2_000);
    if (!box) {
      // Threads draws no box under a post: its own Reply opens one over it.
      const reply = spec.replyIn(here.root);
      if (!reply) return 'none';
      reply.click();
      box = await waitFor(() => boxNow(doc, spec), WENT_MS);
      if (!box) return 'none';
    }
    // Something written there already is the person's: left alone.
    if (writingIn(box)) return 'not_sent';
    box.focus();
    box.click();
    await pause(400);
    const live = boxNow(doc, spec);
    if (!live) return 'none';
    if (writingIn(live)) return 'not_sent';
    writeIn(doc, live, text);
    const typed = await waitFor(() => {
      const b = boxNow(doc, spec);
      return b && writtenIn(b) === clean(text) ? b : null;
    }, 2_000);
    const takeOut = () => {
      const b = boxNow(doc, spec);
      if (b && writingIn(b)) writeIn(doc, b, '');
    };
    if (!typed) {
      takeOut();
      return 'not_sent';
    }
    const send = await waitFor(() => {
      const b = boxNow(doc, spec);
      const button = b ? spec.sendFor(b) : null;
      return button &&
        button.getAttribute('aria-disabled') !== 'true' &&
        !button.hasAttribute('disabled')
        ? button
        : null;
    }, 3_000);
    if (!send) {
      takeOut();
      return 'none';
    }
    send.click();
    const went = await waitFor(() => {
      if (!typed.isConnected || !visible(typed)) return true;
      const b = boxNow(doc, spec);
      return !b || !writingIn(b) ? true : null;
    }, SENT_MS);
    return went ? 'done' : 'not_sent';
  };
