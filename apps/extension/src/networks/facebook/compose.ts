/**
 * Helpful posts (docs/outreach.md, decision 50), in the window the extension works in:
 *
 * - **Putting one up:** on the group's page it presses the box that starts a post ("Write something…"), types the
 *   post into the box Facebook opens over the page (pasted, so its paragraphs stay: decision 158), and presses
 *   **Post**; then waits for the box to close. A group
 *   whose admins approve posts first says so: the post is noted as up, waiting for them.
 * - **Who engaged:** on the person's own post it reads each comment and reply (who, and what they wrote) and, from
 *   the box **See who reacted to this** opens, who reacted. The person themselves is left out. Nothing is pressed but
 *   that, and the box's Close.
 *
 * Both read the post the page shows (./posts.ts `pagePost`): the one in the box over the page when Facebook opened it
 * there, never the feed it keeps hidden behind that box.
 */
import { clean, labelOf, mainOf, textWithEmoji } from './dom';
import { shown } from './fetch';
import { yourProfile } from './friends';
import { COMMENT, commentsIn, pagePost, readPost } from './posts';
import type { ProfileRef } from './types';
import { facebookUrl, profileFromUrl, profileKey } from './urls';
import { hasWriting, WRITING } from './actions';
import { putPostIn } from '../post-text';

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** The box at the top of a group that starts a post, and the button that puts it up. */
const START =
  /^(write something|create a public post|start a discussion|what's on your mind|what’s on your mind)/i;
export const POST = /^post$/i;
/** What a group whose admins approve posts first says once one is sent. */
const PENDING = /\b(pending|waiting for (admin )?approval|admins? (will )?review)\b/i;
const REACTED = /^see who reacted to this$/i;
const CLOSE = /^close$/i;
/** How long the box over the page is waited on, and how often it's looked at. */
const WAIT_MS = 8_000;
const LOOK_MS = 400;

/** How putting a post up went. */
export type PostResult =
  /** Up, or sent and waiting for the admins. */
  | 'done'
  | 'pending'
  /** No box to start a post: the person isn't in the group, or posting is off there. */
  | 'none'
  /** Written, but Facebook didn't take it. */
  | 'not_sent';

/** The box over the page Facebook opens to write a post in, while it's open. */
export function composer(doc: Document): Element | null {
  return (
    [...doc.querySelectorAll('[role="dialog"]')]
      .filter(shown)
      .reverse()
      .find(
        (d) =>
          d.querySelector(WRITING) &&
          [...d.querySelectorAll('[role="button"], button')].some((b) => POST.test(labelOf(b))),
      ) ?? null
  );
}

/** The box at the top of a group that starts a post: "Write something…". */
export function startButton(doc: Document): HTMLElement | null {
  return (
    [...mainOf(doc).querySelectorAll<HTMLElement>('[role="button"], button')].find(
      (b) => START.test(labelOf(b)) && shown(b),
    ) ?? null
  );
}

/** Puts a post up in the group the page shows: opens the box to write it, types it, and presses Post. */
export async function writeGroupPost(doc: Document, text: string): Promise<PostResult> {
  let box = composer(doc);
  if (!box) {
    const start = startButton(doc);
    if (!start) return 'none';
    start.click();
    for (let waited = 0; !box && waited < WAIT_MS; waited += LOOK_MS) {
      await pause(LOOK_MS);
      box = composer(doc);
    }
  }
  if (!box) return 'none';
  const writing = [...box.querySelectorAll<HTMLElement>(WRITING)].find(shown);
  if (!writing) return 'none';
  // Something written there already is the person's: left alone.
  if (hasWriting(writing)) return 'not_sent';
  writing.focus();
  writing.click();
  await pause(300);
  // Pasted, so its paragraphs stay (decision 158).
  await putPostIn(doc, writing, text, hasWriting);
  await pause(800);
  if (!hasWriting(writing)) return 'not_sent';
  const post = [...box.querySelectorAll('[role="button"], button')].find(
    (b) => POST.test(labelOf(b)) && shown(b) && b.getAttribute('aria-disabled') !== 'true',
  );
  if (!post) return 'not_sent';
  (post as HTMLElement).click();
  for (let waited = 0; waited < WAIT_MS * 2; waited += LOOK_MS) {
    await pause(LOOK_MS);
    if (!box.isConnected || !shown(box))
      return PENDING.test(clean(mainOf(doc).textContent) + ' ' + clean(doc.body.textContent))
        ? 'pending'
        : 'done';
  }
  return 'not_sent';
}

/** Someone who engaged with a post: who, and what they wrote for a comment. */
export interface Engaged {
  readonly name: string;
  readonly profile: ProfileRef;
  readonly comment: string | null;
}

/** Who a comment or a row in the reactions box is: the first link to a person with words on it. */
function personIn(element: Element, base: string): { name: string; profile: ProfileRef } | null {
  for (const anchor of element.querySelectorAll('a[href]')) {
    const name = clean(anchor.textContent);
    if (!name || anchor.getAttribute('aria-hidden') === 'true') continue;
    const url = facebookUrl(anchor.getAttribute('href') ?? '', base);
    const profile = url ? profileFromUrl(url) : null;
    if (profile) return { name, profile };
  }
  return null;
}

/**
 * Facebook's own mark on a comment, said for screen readers before its words: "by author" on one the post's writer
 * left (the comment research kept it as the comment's first words, 17 to 20 Nov 2026). Never what somebody wrote.
 */
const MARK = /^(by )?author$/i;

const marked = (element: Element) => MARK.test(clean(element.textContent));

/**
 * A piece of a comment's writing as words: an emoji Facebook draws as a picture is put back (`textWithEmoji`), so a
 * comment that is only one isn't empty; and Facebook's mark is left out, whether it's the whole piece or sits in it.
 */
function wordsOf(piece: Element): string {
  if (marked(piece)) return '';
  if (![...piece.querySelectorAll('*')].some(marked)) return textWithEmoji(piece);
  const copy = piece.cloneNode(true) as Element;
  for (const part of [...copy.querySelectorAll('*')]) if (marked(part)) part.remove();
  return textWithEmoji(copy);
}

/** What a comment says: its words, never the name, the time, Facebook's mark on it or the buttons under it. */
function commentText(article: Element): string | null {
  const parts = [...article.querySelectorAll('div[dir="auto"], span[dir="auto"]')]
    .filter(
      (e) =>
        !e.closest('a, [role="button"], button') &&
        !e.querySelector('div[dir="auto"], span[dir="auto"]') &&
        e.closest('[role="article"]') === article,
    )
    .map(wordsOf)
    .filter(Boolean);
  return parts.join('\n') || null;
}

/** Who wrote the post the page shows, when its heading says. */
export function postWriter(doc: Document, base: string): ProfileRef | null {
  const post = pagePost(doc);
  return (post ? readPost(post, base)?.author?.profile : null) ?? null;
}

/**
 * The comments and replies on the post the page shows, each person once, never the person themselves: the post in the
 * box over the page when Facebook opened it there, and never a comment under another post in the feed behind it.
 */
export function readComments(doc: Document, base: string): Engaged[] {
  const post = pagePost(doc) ?? mainOf(doc);
  const you = yourProfile(doc, base);
  const seen = new Set<string>(you ? [profileKey(you)] : []);
  const found: Engaged[] = [];
  for (const article of commentsIn(post)) {
    if (!COMMENT.test(clean(article.getAttribute('aria-label')))) continue;
    const who = personIn(article, base);
    if (!who || seen.has(profileKey(who.profile))) continue;
    seen.add(profileKey(who.profile));
    found.push({ ...who, comment: commentText(article) });
  }
  return found;
}

/** How long a post that says it has comments gets to draw them. */
const COMMENTS_WAIT_MS = 4_000;

/**
 * The comments on the post the page shows, once Facebook has drawn them: it draws a post first and its comments a
 * moment later, so a post read at once had none. Waits a few seconds, only while the page shows no comment and the
 * post doesn't say it has none. Nothing is pressed.
 */
export async function commentsOnceDrawn(
  doc: Document,
  base: string,
  ms = COMMENTS_WAIT_MS,
): Promise<Engaged[]> {
  for (let waited = 0; ; waited += LOOK_MS) {
    const now = readComments(doc, base);
    if (now.length || waited >= ms) return now;
    const post = pagePost(doc);
    if (post && readPost(post, base)?.comments === 0) return now;
    await pause(LOOK_MS);
  }
}

/** The box over the page that lists who reacted, while it's open: never the box the post itself is in. */
function reactionsBox(doc: Document, post: Element): Element | null {
  return (
    [...doc.querySelectorAll('[role="dialog"]')]
      .filter(shown)
      .reverse()
      .find((d) => !d.contains(post) && !d.querySelector(WRITING) && d.querySelector('a[href]')) ??
    null
  );
}

/**
 * Who reacted to the person's post: presses See who reacted to this, reads the people in the box it opens, and closes
 * it. Never the person themselves. Empty when nobody has.
 */
export async function readReactions(doc: Document, base: string): Promise<Engaged[]> {
  const post = pagePost(doc) ?? mainOf(doc);
  const toolbar = [...post.querySelectorAll('[aria-label]')].find((e) => REACTED.test(labelOf(e)));
  const press = toolbar?.querySelector('[role="button"]') ?? toolbar;
  if (!press) return [];
  (press as HTMLElement).click();
  let box: Element | null = null;
  for (let waited = 0; !box && waited < WAIT_MS; waited += LOOK_MS) {
    await pause(LOOK_MS);
    box = reactionsBox(doc, post);
  }
  if (!box) return [];
  const you = yourProfile(doc, base);
  const seen = new Set<string>(you ? [profileKey(you)] : []);
  const found: Engaged[] = [];
  for (const anchor of box.querySelectorAll('a[href]')) {
    const name = clean(anchor.textContent);
    const url = facebookUrl(anchor.getAttribute('href') ?? '', base);
    const profile = url ? profileFromUrl(url) : null;
    if (!name || !profile || seen.has(profileKey(profile))) continue;
    seen.add(profileKey(profile));
    found.push({ name, profile, comment: null });
  }
  const close = [...box.querySelectorAll('[role="button"], button')].find((b) =>
    CLOSE.test(labelOf(b)),
  );
  (close as HTMLElement | undefined)?.click();
  return found;
}
