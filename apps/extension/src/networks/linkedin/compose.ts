/**
 * The helpful post on LinkedIn (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "LinkedIn, part by part", 6: a post
 * on the person's own feed, as Facebook's goes in a group), in the window the extension works in (./work.ts):
 *
 * - **Putting it up:** on the person's feed it presses **Start a post**, types the post into the box LinkedIn opens
 *   over the page (only there, and only while it's empty), and presses that box's own **Post**; then waits for the box
 *   to close, and takes the post's link from LinkedIn's **View post**, else from the top of the feed by its words.
 * - **Who engaged:** on one of the person's posts, each comment's writer and words, and who reacted, from the box its
 *   reactions count opens, which it closes after. Never the person themselves. Nothing else is pressed.
 *
 * Like the readers, it goes by what a person sees (words, labels, links, page order), never LinkedIn's class names.
 */
import type { Engaged, PostResult } from '../facebook/compose';
import { clean } from '../facebook/dom';
import { shown } from '../facebook/fetch';
import { sameName } from '../facebook/people';
import { hasWriting } from './actions';
import { inNested, says, waitFor } from './auto';
import { CONTROLS, mainOf, yourName } from './dom';
import { peopleLinked } from './people';
import { postBoxes, postIn, readPost } from './posts';
import { postOf } from './urls';

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** What LinkedIn draws over the page: the box to write a post in, and the reactions' list. */
const OVER_THE_PAGE = '[role="dialog"], [role="alertdialog"], dialog';
/** Where a person writes. */
const WRITING = '[role="textbox"], [contenteditable="true"], textarea';
/** The box at the top of the feed that starts a post. */
const START = /^start a post\b/i;
/** The composer's own button that puts the post up. */
const POST = /^post$/i;
/** The link LinkedIn shows once a post is up. */
const VIEW_POST = /^view post$/i;
/** A post's reactions count, which opens who reacted: "42 reactions", or "Sam Lee and 41 others". */
const REACTIONS = /^([\d.,]+\s*[km]?\s+reactions?|.+\s+and\s+[\d.,]+\s+others?)$/i;
/** A comment's own controls: "React Like to Sam Lee’s comment", "Reply to Sam Lee’s comment". */
const OF_A_COMMENT = /\bcomment$/i;
const CLOSE = /^(dismiss|close)$/i;
/** How long the box closing is waited on once Post is pressed. */
const POSTING_MS = 16_000;

/** Words compared as a page shows them: one space between words, in lower case, the first 60 characters. */
const opening = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60);

/** Whether a post on a page is this one: it starts the same way (LinkedIn cuts a long one short with …more). */
export function startsLike(theirs: string, mine: string): boolean {
  const a = opening(theirs);
  const b = opening(mine);
  return b !== '' && a.length >= Math.min(20, b.length) && (a.startsWith(b) || b.startsWith(a));
}

/** The box over the page LinkedIn opens to write a post in, while it's open: one to write in, with its own Post. */
function composer(doc: Document): Element | null {
  return (
    [...doc.querySelectorAll(OVER_THE_PAGE)]
      .filter(shown)
      .reverse()
      .find(
        (box) =>
          [...box.querySelectorAll(WRITING)].some(shown) &&
          [...box.querySelectorAll(CONTROLS)].some((c) => says(c, POST)),
      ) ?? null
  );
}

/** The composer's Post, once LinkedIn turns it on: after the box to write in. */
function postButton(box: Element): HTMLElement | null {
  return (
    [...box.querySelectorAll<HTMLElement>(CONTROLS)].find(
      (c) => shown(c) && c.getAttribute('aria-disabled') !== 'true' && says(c, POST),
    ) ?? null
  );
}

/** The link to the post just put up: LinkedIn's View post, else the post at the top of the feed with these words. */
function linkToIt(doc: Document, href: string, text: string): string | null {
  for (const anchor of doc.querySelectorAll('a[href]')) {
    if (!says(anchor, VIEW_POST)) continue;
    const url = postOf(anchor.getAttribute('href') ?? '', href);
    if (url) return url;
  }
  for (const box of postBoxes(mainOf(doc)).slice(0, 3)) {
    const read = readPost(box, href);
    if (read?.url && startsLike(read.text, text)) return read.url;
  }
  return null;
}

/**
 * Puts a post up on the person's feed: opens the box to write it, types it, and presses Post; then its link, when
 * LinkedIn shows it.
 */
export async function writeFeedPost(
  doc: Document,
  href: string,
  text: string,
): Promise<{ readonly result: PostResult; readonly url: string | null }> {
  const none = { result: 'none', url: null } as const;
  const notSent = { result: 'not_sent', url: null } as const;
  let box = composer(doc);
  if (!box) {
    const start = [...mainOf(doc).querySelectorAll<HTMLElement>(`${CONTROLS}, ${WRITING}`)].find(
      (c) => shown(c) && !c.closest(OVER_THE_PAGE) && says(c, START),
    );
    if (!start) return none;
    start.click();
    box = await waitFor(() => composer(doc));
  }
  if (!box) return none;
  const writing = [...box.querySelectorAll<HTMLElement>(WRITING)].find(shown);
  if (!writing) return none;
  // Something written there already is the person's: left alone.
  if (hasWriting(writing)) return notSent;
  writing.focus();
  writing.click();
  await pause(300);
  doc.execCommand('insertText', false, text);
  await pause(800);
  if (!hasWriting(writing)) return notSent;
  const post = await waitFor(() => postButton(box), 3_000);
  if (!post) return notSent;
  post.click();
  const closed = await waitFor(() => (!box.isConnected || !shown(box) ? true : null), POSTING_MS);
  if (!closed) return notSent;
  return { result: 'done', url: await waitFor(() => linkToIt(doc, href, text), 4_000) };
}

/** The person's own post the page shows. */
const postOnPage = (doc: Document) => postBoxes(mainOf(doc))[0] ?? null;

/** Whether a box in a post is one of its comments (or replies): LinkedIn names it so, or its controls say so. */
function isComment(article: Element): boolean {
  const urn = article.getAttribute('data-id') ?? article.getAttribute('data-urn') ?? '';
  return (
    urn.includes('urn:li:comment') ||
    [...article.querySelectorAll(CONTROLS)].some((c) => says(c, OF_A_COMMENT))
  );
}

/** What a comment says: its own words, never a name, a control, a box to write in or a reply's. */
function commentText(article: Element): string | null {
  const parts = [...article.querySelectorAll('[dir="ltr"], [dir="auto"]')]
    .filter(
      (e) =>
        !e.closest(`a, ${CONTROLS}, ${WRITING}, form`) &&
        e.closest('article, [role="article"]') === article &&
        !e.querySelector('[dir="ltr"], [dir="auto"]'),
    )
    .map((e) => clean(e.textContent))
    .filter(Boolean);
  return parts.join('\n') || null;
}

/** The comments and replies on the person's post, each person once, never the person themselves. */
export function readComments(doc: Document, href: string): Engaged[] {
  const post = postOnPage(doc);
  if (!post) return [];
  const own = postIn(post);
  const you = yourName(doc);
  const seen = new Set<string>();
  const found: Engaged[] = [];
  for (const article of post.querySelectorAll('article, [role="article"]')) {
    if (article === own || article === post || !isComment(article)) continue;
    // The comment's own writer: the first person it links to, outside any reply in it.
    const links = [...article.querySelectorAll('a[href]')].filter(
      (a) => a.closest('article, [role="article"]') === article && !a.closest(WRITING),
    );
    const who = peopleLinked(links, href).find((p) => p.name);
    if (!who?.name || (you && sameName(who.name, you)) || seen.has(who.profile.url)) continue;
    seen.add(who.profile.url);
    found.push({ name: who.name, profile: who.profile, comment: commentText(article) });
  }
  return found;
}

/** The box over the page that lists who reacted, while it's open: no box to write in, and people in it. */
function reactionsBox(doc: Document, href: string): Element | null {
  return (
    [...doc.querySelectorAll(OVER_THE_PAGE)]
      .filter(shown)
      .reverse()
      .find(
        (box) =>
          !box.querySelector(WRITING) && peopleLinked(box.querySelectorAll('a[href]'), href).length,
      ) ?? null
  );
}

/**
 * Who reacted to the person's post: presses its reactions count, reads the people in the box it opens, and closes it.
 * Never the person themselves. Empty when nobody has.
 */
export async function readReactions(doc: Document, href: string): Promise<Engaged[]> {
  const post = postOnPage(doc);
  if (!post) return [];
  const count = [...post.querySelectorAll<HTMLElement>(CONTROLS)].find(
    (c) => !inNested(c, post) && shown(c) && says(c, REACTIONS),
  );
  if (!count) return [];
  count.click();
  const box = await waitFor(() => reactionsBox(doc, href));
  if (!box) return [];
  const you = yourName(doc);
  const found = peopleLinked(box.querySelectorAll('a[href]'), href).flatMap((p) =>
    p.name && !(you && sameName(p.name, you))
      ? [{ name: p.name, profile: p.profile, comment: null }]
      : [],
  );
  [...box.querySelectorAll<HTMLElement>(CONTROLS)].find((c) => says(c, CLOSE))?.click();
  return found;
}
