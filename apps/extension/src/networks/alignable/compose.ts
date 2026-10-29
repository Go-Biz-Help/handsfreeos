/**
 * The week's helpful post on Alignable (docs/outreach.md, decision 109), put up on the person's own Alignable once
 * they OK'd it, in the runner's tab (../looking/kit.ts):
 *
 * - On their signed-in home page it finds the box to write a post in: one already open (over the page, or in the
 *   page with its own Post), else the control that starts one (Start a post, Share an update, Write a post…), pressed
 *   to open it. Never a box to comment, reply, answer or message in.
 * - It types the post in only while that box is empty, and presses the box's own Post (or Share, or Publish). It went
 *   once the box empties or closes; then its link, when a post at the top of the page starts with its words.
 *
 * Alignable's composer wasn't in the owner's outlines, so its words are guessed from what Alignable's pages show:
 * Check Alignable looks for it on the home page (`post`), never writing in it, so it can be tuned from the outline.
 * Nothing else is pressed, and nothing is written anywhere else.
 */
import type { PostResult } from '../facebook/compose';
import { clean } from '../facebook/dom';
import { visible } from '../facebook/fetch';
import {
  boxName,
  controlsSaying,
  mainOf,
  nameOf,
  namesIn,
  pause,
  waitFor,
  writeIn,
  writingIn,
} from '../looking/looks';
import type { LookingSite } from '../looking/site';
import { went, type StepTry } from '../tries';
import { postParts } from './read';

/** What Alignable draws over the page. */
const OVER_THE_PAGE = '[role="dialog"], [aria-modal="true"], dialog[open]';
/** Where a person writes. */
const WRITING = '[contenteditable="true"], textarea, [role="textbox"]';
/** The control that opens a box to write a post in. */
export const START =
  /^(start a post|write a post|create (a )?post|new post|share (an update|a post|something|an idea)|post an update|write something|what[’']s on your mind)\b/i;
/** What a box to write a post in is called, when it says. */
const POST_BOX = /\b(post|update|share|mind|write something)\b/i;
/** What a box for something else is called: never written in. */
const NOT_A_POST = /\b(comment|reply|answer|message|search|recommend)\b/i;
/** The box's own button that puts it up. */
const POST = /^(post|share|publish|post it|share post)$/i;
/** How long the box is waited on to empty or close once Post is pressed. */
const POSTING_MS = 12_000;

/** Its own button to put the post up: in the box's part, turned on. */
function postButtonIn(part: Element): HTMLElement | null {
  return (
    [...part.querySelectorAll<HTMLElement>('button, [role="button"], input[type="submit"]')].find(
      (b) =>
        visible(b) &&
        b.getAttribute('aria-disabled') !== 'true' &&
        !(b as HTMLButtonElement).disabled &&
        POST.test(nameOf(b)),
    ) ?? null
  );
}

/** A box to write in that's for a post: not one for a comment, a reply, an answer, a message or a search. */
const forAPost = (box: Element, inOpened: boolean) => {
  const name = boxName(box);
  if (NOT_A_POST.test(name)) return false;
  return inOpened || POST_BOX.test(name);
};

/** The part of the page a box to write a post in belongs to, with its own Post: its form, else its nearest part. */
function partOf(box: Element): Element | null {
  for (let part: Element | null = box.parentElement; part; part = part.parentElement) {
    if (postButtonIn(part)) return part;
    if (part.matches('form, main, [role="main"], body')) return null;
  }
  return null;
}

/**
 * The box to write a post in, while one is open: over the page (a box Alignable opened, any box in it that isn't
 * for something else), else in the page with its own Post nearby, named for a post.
 */
export function postComposer(doc: Document): { box: HTMLElement; part: Element } | null {
  for (const over of [...doc.querySelectorAll(OVER_THE_PAGE)].filter(visible).reverse()) {
    const box = [...over.querySelectorAll<HTMLElement>(WRITING)].find(
      (b) => visible(b) && forAPost(b, true),
    );
    if (box && postButtonIn(over)) return { box, part: over };
  }
  for (const box of mainOf(doc).querySelectorAll<HTMLElement>(WRITING)) {
    if (!visible(box) || box.closest(OVER_THE_PAGE) || !forAPost(box, false)) continue;
    const part = partOf(box);
    if (part) return { box, part };
  }
  return null;
}

/** The control that starts a post on the page, not inside a box over it. */
export function startPost(doc: Document): HTMLElement | null {
  return (
    controlsSaying(mainOf(doc), START).find((c) => !c.closest(OVER_THE_PAGE) && visible(c)) ??
    [...mainOf(doc).querySelectorAll<HTMLElement>(WRITING)].find(
      (b) => visible(b) && START.test(boxName(b)),
    ) ??
    null
  );
}

/** Words compared as a page shows them: one space between words, in lower case, the first 60 characters. */
const opening = (text: string) => clean(text).toLowerCase().slice(0, 60);

/** The link to the post just put up: a post at the top of the page that starts with its words. */
function linkToIt(doc: Document, href: string, text: string): string | null {
  const mine = opening(text);
  if (!mine) return null;
  for (const post of postParts(doc, href).slice(0, 3)) {
    const theirs = opening(post.thread.text);
    if (
      post.thread.url &&
      theirs.length >= Math.min(20, mine.length) &&
      (theirs.startsWith(mine) || mine.startsWith(theirs))
    )
      return post.thread.url;
  }
  return null;
}

/**
 * Puts the post up on the person's Alignable: opens the box to write it when it isn't open, types it in only while
 * it's empty, and presses its own Post. `none` with no box or Post; `not_sent` when something's written there already
 * (the person's), or Alignable didn't take it.
 */
export async function writeAlignablePost(
  doc: Document,
  href: string,
  text: string,
): Promise<{ readonly result: PostResult; readonly url: string | null }> {
  const none = { result: 'none', url: null } as const;
  const notSent = { result: 'not_sent', url: null } as const;
  let open = postComposer(doc);
  if (!open) {
    const start = startPost(doc);
    if (!start) return none;
    start.click();
    open = await waitFor(() => postComposer(doc));
  }
  if (!open) return none;
  const { box, part } = open;
  // Something written there already is the person's: left alone.
  if (writingIn(box)) return notSent;
  writeIn(doc, box, text);
  await pause(800);
  if (!writingIn(box)) return notSent;
  const post = await waitFor(() => postButtonIn(part), 3_000);
  if (!post) return notSent;
  post.click();
  const gone = await waitFor(
    () => (!box.isConnected || !visible(box) || !writingIn(box) ? true : null),
    POSTING_MS,
  );
  if (!gone) return notSent;
  return { result: 'done', url: await waitFor(() => linkToIt(doc, href, text), 4_000) };
}

/** Check Alignable's look for the box to start a post (decision 109): found, never written in. */
export function postLook(doc: Document, site: LookingSite): StepTry {
  const open = postComposer(doc) !== null;
  const start = startPost(doc) !== null;
  return went(
    'post',
    { box: open, start },
    open || start ? [] : ['no box to start a post, and nothing that opens one, on the page'],
    open || start ? [] : namesIn(mainOf(doc), site),
  );
}
