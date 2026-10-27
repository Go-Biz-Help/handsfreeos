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
 * - **A good post's people** (docs/outreach.md, decision 92): on someone else's post its search found, who commented
 *   and who reacted, each with the line under their name and how far they are, for the AI's check of their own
 *   profile. Never the person, the post's writer (`skip`) or a 1st-degree connection. The reactions box is read as far
 *   as it first shows (about 25 rows), never scrolled, and closed with its Dismiss; "Load more comments" is never
 *   pressed.
 *
 * Like the readers, it goes by what a person sees (words, labels, links, page order), never LinkedIn's class names.
 */
import type { Engaged, PostResult } from '../facebook/compose';
import { clean } from '../facebook/dom';
import { shown } from '../facebook/fetch';
import { sameName } from '../facebook/people';
import { hasWriting } from './actions';
import { inNested, postOnPage, says, waitFor } from './auto';
import { CONTROLS, mainOf, shownLines, yourName } from './dom';
import { peopleLinked, readPeople, rowLines, type LinkedPerson } from './people';
import { commentWriter, newerComments, postBoxes, postIn, readPost, TEXT_BOX } from './posts';
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

/**
 * The comments and replies on the post the page shows, each writer once, in page order: never the person themselves,
 * nor anyone `skip` names.
 */
function commentsOn(doc: Document, href: string, skip: readonly ProfileRef[]): CommentRead[] {
  const post = postOnPage(doc);
  if (!post) return [];
  const own = postIn(post);
  const you = yourName(doc);
  const seen = new Set<string>();
  const kept = (who: LinkedPerson | null | undefined): who is LinkedPerson & { name: string } =>
    !!who?.name &&
    !(you && sameName(who.name, you)) &&
    !seen.has(who.profile.url) &&
    !skip.some((one) => sameMember(one, who.profile));
  const found: CommentRead[] = [];
  for (const article of post.querySelectorAll('article, [role="article"]')) {
    if (article === own || article === post || !isComment(article)) continue;
    // The comment's own writer: the first person it links to, outside any reply in it.
    const links = [...article.querySelectorAll('a[href]')].filter(
      (a) => a.closest('article, [role="article"]') === article && !a.closest(WRITING),
    );
    const who = peopleLinked(links, href).find((p) => p.name);
    if (!kept(who)) continue;
    seen.add(who.profile.url);
    found.push({
      name: who.name,
      profile: who.profile,
      links: linksTo(links, who.profile, href),
      comment: commentText(article),
    });
  }
  // The newer layout's: the box of each Reply, its words in its text box.
  for (const comment of newerComments(post)) {
    const who = commentWriter(comment, href);
    if (!kept(who)) continue;
    seen.add(who.profile.url);
    const words = comment.querySelector(TEXT_BOX);
    const text = words ? shownLines(words, { max: 40, exclude: CONTROLS }).join('\n') : '';
    const links = [...comment.querySelectorAll('a[href]')].filter(
      (a) => !a.closest(WRITING) && !words?.contains(a),
    );
    found.push({
      name: who.name,
      profile: who.profile,
      links: linksTo(links, who.profile, href),
      comment: text || null,
    });
  }
  return found;
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

/** The most rows of the reactions box read: what it shows when it opens (about 25), never scrolled for more. */
export const REACTORS_MOST = 25;

/** The rows of the box of who reacted, as far as they're read: each with their headline and how far they are. */
export const reactorRows = (box: Element, href: string) =>
  readPeople(box, href).slice(0, REACTORS_MOST);

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
}

/**
 * Who reacted to a good post its search found, on the post's own page (decision 92): presses its reactions count,
 * reads the first rows of the box it opens with each one's headline and how far they are, without scrolling it, and
 * closes it with its Dismiss. Never the person, the post's writer (`skip`) or a 1st-degree connection.
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
  if (!box) return { count: true, opened: false, rows: 0, people: [], closed: true };
  const rows = reactorRows(box, href);
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
  return { count: true, opened: true, rows: rows.length, people, closed: await closeBox(box) };
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
