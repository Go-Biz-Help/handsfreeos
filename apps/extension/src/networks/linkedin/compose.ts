/**
 * The helpful post on LinkedIn (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "LinkedIn, part by part", 6: a post
 * on the person's own feed, as Facebook's goes in a group), in the window the extension works in (./work.ts):
 *
 * - **Putting it up:** on the person's feed it presses **Start a post**, types the post into the box LinkedIn opens
 *   over the page (only there, and only while it's empty), and presses that box's own **Post**; then waits for the box
 *   to close, and takes the post's link from LinkedIn's **View post**, else from the top of the feed by its words.
 * - **Who engaged:** on one of the person's posts, each comment's writer and words, and who reacted, from the box its
 *   reactions count opens, which it closes after. Never the person themselves. Nothing else is pressed. In LinkedIn's
 *   newer layout (the owner's outlines of 16 Oct 2026) comments aren't articles: each is the box of a Reply after the
 *   post's bar (./posts.ts, `newerComments`), its words in its text box; and the count is a link ("55 reactions").
 * - **A comment's Like** (decision 116, from 0.108.0): on a good post's own page, the warm-up for someone found by
 *   their comment there: the first comment or reply they wrote, and only its own Like (the older layout's "React Like
 *   to …’s comment", the newer's reaction button in the comment's own box), never the post's or a reply's under it,
 *   and only while none of the person's reactions is on it.
 * - **A good post's people** (docs/outreach.md, decision 92): on someone else's post its search found, who commented
 *   and who reacted, each with the line under their name and how far they are, for the AI's check of their own
 *   profile. Never the person, the post's writer (`skip`) or a 1st-degree connection. The reactions box is read up to
 *   3 screens (decision 116: scrolled twice, else its own Show more results pressed, about 45 rows), and closed with
 *   its Dismiss, as is one that drew nobody (in a window hidden behind another, LinkedIn draws no row); "Load more
 *   comments" is never pressed.
 *
 * Like the readers, it goes by what a person sees (words, labels, links, page order), never LinkedIn's class names.
 */
import type { CommentLiked, TheirComment } from '../../messages';
import type { Engaged, PostResult } from '../facebook/compose';
import { clean } from '../facebook/dom';
import { shown } from '../facebook/fetch';
import { sameName } from '../facebook/people';
import { hasWriting } from './actions';
import { inNested, postOnPage, says, waitFor } from './auto';
import { scrolls, SHOW_MORE } from './browse';
import { CONTROLS, mainOf, shownLines, wordsOf, yourName } from './dom';
import { outlineNow } from './outline';
import { peopleLinked, readPeople, rowLines, type LinkedPerson } from './people';
import {
  commentWriter,
  hasYours,
  newerComments,
  postBoxes,
  postIn,
  reactionChange,
  reactionState,
  readPost,
  TEXT_BOX,
} from './posts';
import type { Degree, ProfileRef } from './types';
import { postOf, profileRefOf, sameMember } from './urls';

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
export function composer(doc: Document): Element | null {
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

/** The feed's Start a post, which opens the composer. */
export function startOf(doc: Document): HTMLElement | null {
  return (
    [...mainOf(doc).querySelectorAll<HTMLElement>(`${CONTROLS}, ${WRITING}`)].find(
      (c) => shown(c) && !c.closest(OVER_THE_PAGE) && says(c, START),
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
    const start = startOf(doc);
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

/** Who a post's people leave out besides the person themselves: on someone else's post, its writer. */
export interface LeaveOut {
  readonly skip?: readonly ProfileRef[];
}

/**
 * Someone among a good post's people (decision 92): who commented or who reacted, with the line under their name and
 * how far they are, as the comment's header or the row in the reactions box shows them.
 */
export interface PostPerson {
  readonly name: string;
  readonly profile: ProfileRef;
  /** The line under their name: their headline. */
  readonly headline: string | null;
  /** How far they are from the person: 2nd or 3rd, never 1st (left out); null when the page didn't say. */
  readonly degree: Degree | null;
  /** What a commenter said; null for who reacted. */
  readonly said: string | null;
}

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

/** A comment as read: its writer, the links to them in it, and what it says. */
interface CommentRead {
  readonly name: string;
  readonly profile: ProfileRef;
  readonly links: readonly Element[];
  readonly comment: string | null;
}

/** Of some links, those to this member. */
const linksTo = (links: readonly Element[], profile: ProfileRef, href: string) =>
  links.filter((link) => {
    const to = profileRefOf(link.getAttribute('href') ?? '', href);
    return to !== null && sameMember(to, profile);
  });

/** A comment's (or reply's) own box on a post, with its writer and the links in it outside its words. */
interface CommentBox {
  readonly box: Element;
  readonly who: LinkedPerson & { readonly name: string };
  readonly links: readonly Element[];
  /** LinkedIn's newer layout's, whose words are in its text box. */
  readonly newer: boolean;
}

/**
 * The comments and replies on a post, in page order, each with its own box and writer: the older layout's articles,
 * then the newer layout's, the box of each Reply.
 */
function commentBoxesOn(post: Element, href: string): CommentBox[] {
  const own = postIn(post);
  const found: CommentBox[] = [];
  for (const article of post.querySelectorAll('article, [role="article"]')) {
    if (article === own || article === post || !isComment(article)) continue;
    // The comment's own writer: the first person it links to, outside any reply in it.
    const links = [...article.querySelectorAll('a[href]')].filter(
      (a) => a.closest('article, [role="article"]') === article && !a.closest(WRITING),
    );
    const who = peopleLinked(links, href).find((p) => p.name);
    if (who?.name)
      found.push({ box: article, who: { ...who, name: who.name }, links, newer: false });
  }
  // The newer layout's: the box of each Reply, its words in its text box.
  for (const comment of newerComments(post)) {
    const who = commentWriter(comment, href);
    if (!who?.name) continue;
    const words = comment.querySelector(TEXT_BOX);
    const links = [...comment.querySelectorAll('a[href]')].filter(
      (a) => !a.closest(WRITING) && !words?.contains(a),
    );
    found.push({ box: comment, who: { ...who, name: who.name }, links, newer: true });
  }
  return found;
}

/** What a comment's box says: the older layout's own words, or the newer's in its text box. */
function commentWords({ box, newer }: CommentBox): string | null {
  if (!newer) return commentText(box);
  const words = box.querySelector(TEXT_BOX);
  return (words ? shownLines(words, { max: 40, exclude: CONTROLS }).join('\n') : '') || null;
}

/**
 * The comments and replies on the post the page shows, each writer once, in page order: never the person themselves,
 * nor anyone `skip` names.
 */
function commentsOn(doc: Document, href: string, skip: readonly ProfileRef[]): CommentRead[] {
  const post = postOnPage(doc);
  if (!post) return [];
  const you = yourName(doc);
  const seen = new Set<string>();
  const found: CommentRead[] = [];
  for (const comment of commentBoxesOn(post, href)) {
    const { who } = comment;
    if (
      (you && sameName(who.name, you)) ||
      seen.has(who.profile.url) ||
      skip.some((one) => sameMember(one, who.profile))
    )
      continue;
    seen.add(who.profile.url);
    found.push({
      name: who.name,
      profile: who.profile,
      links: linksTo(comment.links, who.profile, href),
      comment: commentWords(comment),
    });
  }
  return found;
}

// ------------------------------------------------------------------------------------------------ a comment's like

/** A comment's own Like in the older layout: "React Like to Sam Lee’s comment" (or "Like"). */
const COMMENT_LIKE = /^(react like\b.*|unreact like\b.*|like)$/i;
/** The newer layout's reaction button says its state: "Reaction button state: no reaction". */
const REACTION_STATE = /\bbutton state:/i;
/** A comment's own link, in the older layout: the post's, naming the comment. */
const COMMENT_LINK = /[?&]commentUrn=/;

/**
 * A comment's own Like: the older layout's says so; the newer's is its reaction button, which says its state. Never a
 * reply's under it, in a box of its own.
 */
function commentLikeOf(comment: CommentBox, all: readonly CommentBox[]): HTMLElement | null {
  const { box } = comment;
  return (
    [...box.querySelectorAll<HTMLElement>(CONTROLS)].find((control) => {
      const nested = control.closest('article, [role="article"]');
      if (nested && nested !== box && box.contains(nested)) return false;
      if (
        all.some(
          (other) => other.box !== box && box.contains(other.box) && other.box.contains(control),
        )
      )
        return false;
      return (
        shown(control) &&
        (says(control, COMMENT_LIKE) || REACTION_STATE.test(reactionState(control).label))
      );
    }) ?? null
  );
}

/**
 * Their comment on the post the page shows (decision 116): the first comment or reply whose writer is them, with what
 * it says, its own link when the older layout gives one, and its own Like. Null when the page shows none of theirs.
 */
export function theirCommentOn(
  doc: Document,
  href: string,
  them: ProfileRef,
): {
  readonly text: string | null;
  readonly url: string | null;
  readonly like: HTMLElement | null;
} | null {
  const post = postOnPage(doc);
  if (!post) return null;
  const all = commentBoxesOn(post, href);
  const theirs = all.find((c) => sameMember(c.who.profile, them));
  if (!theirs) return null;
  const link = theirs.links.find((a) => COMMENT_LINK.test(a.getAttribute('href') ?? ''));
  const url = link ? new URL(link.getAttribute('href')!, href).href : null;
  return { text: commentWords(theirs), url, like: commentLikeOf(theirs, all) };
}

/** Whether the page is the post asked for, by its activity. */
function onPost(href: string, postUrl: string): boolean {
  const asked = postOf(postUrl);
  return asked !== null && postOf(href) === asked;
}

/**
 * Their comment on the post asked for, as the page shows it (decision 116): what it says, its own link (the older
 * layout's), and whether one of the person's reactions is on it (null with no Like to press). Null when the page isn't
 * that post or shows no comment of theirs.
 */
export function theirComment(
  doc: Document,
  href: string,
  them: ProfileRef,
  postUrl: string,
): TheirComment | null {
  const theirs = onPost(href, postUrl) ? theirCommentOn(doc, href, them) : null;
  if (!theirs) return null;
  return {
    text: theirs.text,
    commentUrl: theirs.url,
    liked: theirs.like ? hasYours(reactionState(theirs.like)) === true : null,
  };
}

/**
 * Likes their comment on a good post's own page (decision 116: the warm-up for someone found by their comment), when
 * the page is the post asked for: its own Like, while none of the person's reactions is on it. `done` once it shows
 * one given, `already` when it did, `none` when the page isn't that post, shows no comment of theirs or no Like on it,
 * `not_sent` when LinkedIn didn't take it; with its own link (the older layout's) and what it says.
 */
export async function likeTheirComment(
  doc: Document,
  href: string,
  them: ProfileRef,
  postUrl: string,
): Promise<CommentLiked> {
  if (!onPost(href, postUrl)) return { result: 'none', commentUrl: null, text: null };
  const theirs = theirCommentOn(doc, href, them);
  const said = { commentUrl: theirs?.url ?? null, text: theirs?.text ?? null };
  if (!theirs?.like) return { result: 'none', ...said };
  const before = reactionState(theirs.like);
  if (hasYours(before) === true) return { result: 'already', ...said };
  theirs.like.click();
  // LinkedIn may draw the comments again: its Like is found again each look.
  const went = await waitFor(() => {
    const now = theirCommentOn(doc, href, them)?.like;
    return now && reactionChange(before, reactionState(now)) === 'added' ? true : null;
  }, 5_000);
  return { result: went ? 'done' : 'not_sent', ...said };
}

/**
 * The comments and replies on the post the page shows (the person's own, or someone else's on its own page), each
 * person once, never the person themselves nor anyone `skip` names (on someone else's, its writer).
 */
export function readComments(doc: Document, href: string, options: LeaveOut = {}): Engaged[] {
  return commentsOn(doc, href, options.skip ?? []).map(({ name, profile, comment }) => ({
    name,
    profile,
    comment,
  }));
}

/**
 * The line under someone's name in the links to them, and how far they are: the newer layout writes both in the link
 * around their name ("Owen Park • 3rd+", then their headline).
 */
function linesIn(links: readonly Element[], name: string): Pick<PostPerson, 'headline' | 'degree'> {
  let headline: string | null = null;
  let degree: Degree | null = null;
  for (const link of links) {
    const lines = rowLines(link, name);
    headline ??= lines.headline;
    degree ??= lines.degree;
  }
  return { headline, degree };
}

/**
 * Who commented on a good post its search found, on the post's own page (decision 92): each writer once with what they
 * said, the line under their name and how far they are; never the person, the post's writer (`skip`) or a 1st-degree
 * connection, as who reacted aren't. Only the comments the page shows: "Load more comments" isn't pressed.
 */
export function readCommenters(doc: Document, href: string, options: LeaveOut = {}): PostPerson[] {
  return commentsOn(doc, href, options.skip ?? []).flatMap((comment) => {
    const lines = linesIn(comment.links, comment.name);
    if (lines.degree === '1st') return [];
    return [{ name: comment.name, profile: comment.profile, ...lines, said: comment.comment }];
  });
}

/** The box over the page that lists who reacted, while it's open: no box to write in, and people in it. */
export function reactionsBox(doc: Document, href: string): Element | null {
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

/** A reactions box's tab for each kind, or the column its rows go in (LinkedIn's newer box). */
const REACTION_TABS = '[role="tablist"], [role="tab"], nav button, [data-testid="lazy-column"]';

/**
 * The box over the page its reactions count opened, whether or not it drew anyone yet: no box to write in, a tab for
 * each kind of reaction (or the column its rows go in) and its own Dismiss, so a warning over the page is never taken
 * for it. LinkedIn's newer box (the owner's Check, 28 Oct 2026) draws its rows only once Chrome shows the window.
 */
export function reactionsOpened(doc: Document): Element | null {
  return (
    [...doc.querySelectorAll(OVER_THE_PAGE)]
      .filter(shown)
      .reverse()
      .find(
        (box) =>
          !box.querySelector(WRITING) &&
          Boolean(box.querySelector(REACTION_TABS)) &&
          [...box.querySelectorAll(CONTROLS)].some((c) => says(c, CLOSE)),
      ) ?? null
  );
}

/** Whether Chrome is drawing the page: in a window hidden behind another, it draws nothing new. */
export const hiddenNow = (doc: Document) => doc.visibilityState === 'hidden';

/** A post's reactions count, which opens who reacted: a button that says it, or in the newer layout a link. */
export function reactionsCount(post: Element): HTMLElement | null {
  return (
    [...post.querySelectorAll<HTMLElement>(`${CONTROLS}, a[href]`)].find(
      (c) => !inNested(c, post) && shown(c) && says(c, REACTIONS),
    ) ?? null
  );
}

/** Closes a box over the page with its own Dismiss (or Close), and waits a moment for it to go: whether it went. */
export async function closeBox(box: Element): Promise<boolean> {
  const close = [...box.querySelectorAll<HTMLElement>(CONTROLS)].find((c) => says(c, CLOSE));
  if (!close) return false;
  close.click();
  return (await waitFor(() => (!box.isConnected || !shown(box) ? true : null), 3_000)) === true;
}

/**
 * Who reacted to the person's post: presses its reactions count, reads the people in the box it opens, and closes it.
 * Never the person themselves. Empty when nobody has.
 */
export async function readReactions(doc: Document, href: string): Promise<Engaged[]> {
  const post = postOnPage(doc);
  if (!post) return [];
  const count = reactionsCount(post);
  if (!count) return [];
  count.click();
  const box = await waitFor(() => reactionsBox(doc, href));
  if (!box) {
    // It opened and drew nobody: closed again, not left over the page.
    const opened = reactionsOpened(doc);
    if (opened) await closeBox(opened);
    return [];
  }
  const you = yourName(doc);
  const found = peopleLinked(box.querySelectorAll('a[href]'), href).flatMap((p) =>
    p.name && !(you && sameName(p.name, you))
      ? [{ name: p.name, profile: p.profile, comment: null }]
      : [],
  );
  [...box.querySelectorAll<HTMLElement>(CONTROLS)].find((c) => says(c, CLOSE))?.click();
  return found;
}

/** The most rows of the reactions box read: up to 3 screens of it (decision 116), about 45. */
export const REACTORS_MOST = 45;
/** Screens of the reactions box past its first: 3 in all (decision 116). Never further. */
const REACTORS_SCROLLS = 2;
/** How long LinkedIn has to draw more rows once the box moved. */
const MORE_ROWS_MS = 4_000;
/** Between one screen of the box and the next: a person reading down it. */
const SCREEN_PACE_MS = [1_500, 3_000] as const;

/** The rows of the box of who reacted, as far as they're read: each with their headline and how far they are. */
export const reactorRows = (box: Element, href: string) =>
  readPeople(box, href).slice(0, REACTORS_MOST);

/** The list in the box of who reacted that scrolls, and its own Show more results at its foot, as it shows them. */
function moversIn(box: Element): { list: Element | null; more: HTMLElement | null } {
  return {
    list: [box, ...box.querySelectorAll('*')].find(scrolls) ?? null,
    more:
      [...box.querySelectorAll<HTMLElement>(CONTROLS)].find(
        (control) => shown(control) && wordsOf(control).some((w) => SHOW_MORE.test(w)),
      ) ?? null,
  };
}

/**
 * The box of who reacted, a screen further down: its list scrolled most of a screen, else at its foot its own Show
 * more results pressed. Whether LinkedIn drew more rows.
 */
async function moreReactors(box: Element, href: string): Promise<boolean> {
  const before = readPeople(box, href).length;
  const { list, more } = moversIn(box);
  const moved = list ? list.scrollTop : null;
  if (list) list.scrollTop += Math.max(200, list.clientHeight * 0.8);
  if (!list || list.scrollTop === moved) {
    if (!more) return false;
    more.click();
  }
  return (
    (await waitFor(() => (readPeople(box, href).length > before ? true : null), MORE_ROWS_MS)) ===
    true
  );
}

/** Up to 3 screens of the box of who reacted (decision 116), each row once, as far as `REACTORS_MOST`. */
async function readReactorRows(box: Element, href: string) {
  const rows = new Map(readPeople(box, href).map((row) => [row.profile.url, row]));
  for (let screen = 0; screen < REACTORS_SCROLLS && rows.size < REACTORS_MOST; screen++) {
    const movers = moversIn(box);
    if (!movers.list && !movers.more) break;
    const [least, most] = SCREEN_PACE_MS;
    await pause(least + Math.random() * (most - least));
    if (!(await moreReactors(box, href))) break;
    for (const row of readPeople(box, href))
      if (!rows.has(row.profile.url)) rows.set(row.profile.url, row);
  }
  return [...rows.values()].slice(0, REACTORS_MOST);
}

/** How reading who reacted went. */
export interface ReactorsRead {
  /** Whether the post showed a reactions count to open. */
  readonly count: boolean;
  /** Whether that opened the box of who reacted. */
  readonly opened: boolean;
  /** How many people the box showed, as far as it's read. */
  readonly rows: number;
  /** Who reacted, less the person, the post's writer and 1st-degree connections. */
  readonly people: PostPerson[];
  /** Whether its Dismiss closed the box again. */
  readonly closed: boolean;
  /** The page's outline while a box that read nobody was still open, for the job's note of it (decision 74). */
  readonly outline?: string;
  /** A box that read nobody while Chrome drew nothing, its window hidden behind another. */
  readonly hidden?: true;
}

/**
 * Who reacted to a good post its search found, on the post's own page (decision 92): presses its reactions count,
 * reads up to 3 screens of the box it opens (decision 116) with each one's headline and how far they are, and closes
 * it with its Dismiss. Never the person, the post's writer (`skip`) or a 1st-degree connection.
 */
export async function readReactors(
  doc: Document,
  href: string,
  options: LeaveOut = {},
): Promise<ReactorsRead> {
  const post = postOnPage(doc);
  const count = post ? reactionsCount(post) : null;
  if (!count) return { count: false, opened: false, rows: 0, people: [], closed: true };
  count.click();
  const box = await waitFor(() => reactionsBox(doc, href));
  if (!box) {
    // Opened and drew nobody (in a hidden window, LinkedIn draws no row): its outline, then closed again.
    const opened = reactionsOpened(doc);
    if (!opened) return { count: true, opened: false, rows: 0, people: [], closed: true };
    const outline = outlineNow(doc);
    return {
      count: true,
      opened: true,
      rows: 0,
      people: [],
      closed: await closeBox(opened),
      outline,
      ...(hiddenNow(doc) ? { hidden: true as const } : {}),
    };
  }
  const rows = await readReactorRows(box, href);
  const you = yourName(doc);
  const skip = options.skip ?? [];
  const people = rows.flatMap((row): PostPerson[] =>
    (you && sameName(row.name, you)) ||
    skip.some((one) => sameMember(one, row.profile)) ||
    row.degree === '1st' ||
    row.connection === 'connected' ||
    row.connection === 'self'
      ? []
      : [
          {
            name: row.name,
            profile: row.profile,
            headline: row.headline,
            degree: row.degree,
            said: null,
          },
        ],
  );
  // A box that read nobody: its outline taken while it's open, before its Dismiss closes it.
  const outline = rows.length ? null : outlineNow(doc);
  return {
    count: true,
    opened: true,
    rows: rows.length,
    people,
    closed: await closeBox(box),
    ...(outline === null ? {} : { outline }),
    ...(outline !== null && hiddenNow(doc) ? { hidden: true as const } : {}),
  };
}

/**
 * A good post's people (decision 92), on its own page: who commented, then who reacted; never its writer, the one the
 * job named (`writer`) nor the one the page does.
 */
export async function postPeopleOn(
  doc: Document,
  href: string,
  writer: ProfileRef | null,
): Promise<{ commenters: PostPerson[]; reactors: ReactorsRead }> {
  const post = postOnPage(doc);
  const author = post ? readPost(post, href)?.author?.profile : null;
  const skip = [writer, author].filter((p) => p != null);
  return {
    commenters: readCommenters(doc, href, { skip }),
    reactors: await readReactors(doc, href, { skip }),
  };
}
