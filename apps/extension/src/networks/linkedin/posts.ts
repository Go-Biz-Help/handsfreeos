/**
 * Posts: in the feed (/feed/), in post search (/search/results/content/), on a post's own page, on a member's
 * activity and in a group. A post is found any of four ways, whichever LinkedIn draws: an article (`role="article"`)
 * that isn't inside another; a box LinkedIn names with the post's own id (`data-urn="urn:li:activity:…"`, not a
 * class); a list item (`role="listitem"`) holding one post's menu ("Open control menu for post by …"), as LinkedIn's
 * newer feed draws each post (the owner's outlines of 16 Oct 2026); or, where posts are none of these, the box from
 * that menu to the end of the bar at its foot (Like, Comment, Repost, Send). An article inside a post is a comment or
 * a link's preview: a comment is never read as a post, and nothing in one (its words, links, time or counts) is the
 * post's. In the newer layout comments aren't articles: they come after the post's bar, which is where the post's own
 * words and links end.
 *
 * Inside a post, page order says what's what. Its header is what comes before its time ("3h •"), or before its words
 * where it shows no time. When someone else is named at its top ("Sam Lee likes this", "LoneStar reposted this"),
 * LinkedIn's newer layout draws a line (`hr`) under them, and the author is under it. The author is the member or page
 * the post's menu names ("Open control menu for post by Dana Reyes"), linked in the header; where the menu names
 * nobody, the last one linked before the time. A post by someone the header names but doesn't link (a group post in
 * the newer feed) has their name and no profile. What it says is its text box (`data-testid="expandable-text-box"`,
 * whole in the page: its "…more" only shows the rest) or, in the older layout, the writing after the time and before
 * its counts and its bar.
 *
 * The bar (`barOf`): the post's own Comment, and before it the reaction button and, in the newer layout, the
 * reactions menu beside it (a button that opens a menu). The reaction button is found by where it is, never by its
 * words, and whether a press on it gave a reaction or took one back by what changed (`reactionChange`).
 */
import { clean, elementsIn, isAfter, isBefore, outermost } from '../facebook/dom';
import { sameName } from '../facebook/people';
import { CONTROLS, inTopBar, namesOn, shownLines, wordsOf } from './dom';
import { bestName, peopleLinked, type LinkedPerson } from './people';
import type { CompanyRef, Named, Post, ProfileRef } from './types';
import {
  highlightedPostFrom,
  linkedinUrl,
  pageFromUrl,
  postFromUrn,
  postUrlFrom,
  profileFromUrl,
  profileKey,
} from './urls';
import {
  COMMENT,
  isLinkedInText,
  LIKE,
  NOT_REACTED,
  parseCount,
  POST_MENU,
  POST_MENU_BY,
  postTimeOf,
  PROMOTED,
  REACTED,
  REPLY,
  REPOST,
  SEND,
} from './vocabulary';

/** What's inside a post and isn't it: its comments, and the preview of a link it shares (the older layout's). */
const NESTED = 'article, [role="article"]';
/** The attributes LinkedIn names a post's box with: urn:li:activity:<number>. */
const POST_ATTRIBUTES = ['data-urn', 'data-id', 'data-activity-urn'];
/** What a post's words leave out: buttons, headings ("Feed post number 1") and what's inside it. */
const NOT_SAID = `${CONTROLS}, ${NESTED}, h1, h2, h3, h4, h5, h6, [role="heading"]`;
/** The box LinkedIn's newer layout keeps a post's (or a comment's, an About's) words in, all of them. */
export const TEXT_BOX = '[data-testid="expandable-text-box"]';
/** Where a person writes: a comment's box. */
const WRITING = '[role="textbox"], [contenteditable="true"], textarea';
/** The counts at a post's foot: "42 reactions", "8 comments on Dana Reyes’s post", "3 reposts". */
const REACTIONS = /^([\d.,]+\s*[km]?)\s+reactions?\b/i;
const COMMENTS = /^([\d.,]+\s*[km]?)\s+comments?\b/i;
const REPOSTS = /^([\d.,]+\s*[km]?)\s+reposts?\b/i;
/** Who reacted, as LinkedIn writes it beside the faces: "Dana Reyes and 41 others" is 42. */
const AND_OTHERS = /^.+\s+and\s+([\d.,]+)\s+others?$/i;
/** A count alone, as the newer bar shows it in its buttons: "55", "1.2K". */
const COUNT = /^([\d.,]+\s*[km]?)$/i;
/** How far up from the post's Comment its bar can be. */
const BAR_STEPS = 10;

const hasWords = (element: Element) => clean(element.textContent) !== '';
const says = (control: Element, pattern: RegExp) => wordsOf(control).some((w) => pattern.test(w));

/** The post one of LinkedIn's attributes on a box names, if any. */
function urnOf(element: Element): string | null {
  for (const name of POST_ATTRIBUTES) {
    const post = postFromUrn(element.getAttribute(name));
    if (post) return post;
  }
  return null;
}

/** Whether something is part of a post's bar or its counts: what ends what the post says. */
function isBar(words: readonly string[]): boolean {
  return words.some(
    (word) =>
      LIKE.test(word) ||
      COMMENT.test(word) ||
      REPOST.test(word) ||
      SEND.test(word) ||
      REACTIONS.test(word) ||
      COMMENTS.test(word) ||
      REPOSTS.test(word) ||
      AND_OTHERS.test(word),
  );
}

const isMenu = (control: Element) => wordsOf(control).some((w) => POST_MENU.test(w));

/** The boxes that are posts, in page order, each the outermost of the ways it's found. */
export function postBoxes(root: Element): Element[] {
  const outside = (element: Element) => !element.parentElement?.closest(NESTED);
  const articles = [...root.querySelectorAll('[role="article"]')].filter(
    (article) => outside(article) && hasWords(article),
  );
  const named = [...root.querySelectorAll(POST_ATTRIBUTES.map((name) => `[${name}]`).join(', '))]
    .filter((element) => urnOf(element) !== null && outside(element) && hasWords(element))
    .filter((element) => !inTopBar(element));
  const menus = [...root.querySelectorAll(CONTROLS)].filter(
    (control) => !inTopBar(control) && !control.closest(NESTED) && isMenu(control),
  );
  // The newer feed's: a list item with one post's menu in it.
  const items = [...root.querySelectorAll('[role="listitem"]')].filter(
    (item) => outside(item) && menus.filter((menu) => item.contains(menu)).length === 1,
  );
  const boxes = [...articles, ...named, ...items, ...byMenus(root, menus)];
  return [...new Set(boxes)]
    .filter((box) => !boxes.some((other) => other !== box && other.contains(box)))
    .sort((a, b) => (isBefore(a, b) ? -1 : isBefore(b, a) ? 1 : 0));
}

/**
 * Posts that are none of the above: the smallest box around each post's menu and the end of its bar after it (Send,
 * or Repost, or Comment where the post has neither, as a poll), before the next post's menu.
 */
function byMenus(root: Element, menus: readonly Element[]): Element[] {
  const controls = [...root.querySelectorAll(CONTROLS)].filter(
    (control) => !inTopBar(control) && !control.closest(NESTED),
  );
  const sends = controls.filter((control) => says(control, SEND));
  const reposts = controls.filter((control) => says(control, REPOST));
  const comments = controls.filter((control) => says(control, COMMENT));
  const boxes: Element[] = [];
  menus.forEach((menu, i) => {
    const next = menus[i + 1];
    const between = (e: Element) => isAfter(e, menu) && (!next || isAfter(next, e));
    const end = sends.find(between) ?? reposts.find(between) ?? comments.find(between);
    if (!end) return;
    let box: Element = menu;
    while (!box.contains(end) && box.parentElement && box !== root) box = box.parentElement;
    if (box.contains(end) && !boxes.some((b) => b.contains(box) || box.contains(b)))
      boxes.push(box);
  });
  return boxes;
}

/**
 * The post in a box: the box when it's an article; else the article in it that has its first link (a box LinkedIn
 * names may hold the post's article); else the box.
 */
export function postIn(box: Element): Element {
  if (box.matches(NESTED)) return box;
  const first = box.querySelector('a[href]');
  const article = outermost(box, NESTED)[0];
  return article && first && article.contains(first) ? article : box;
}

/** Whether something in a post is inside one of its nested articles: an older layout's comment, a link's preview. */
function nestedIn(element: Element, post: Element): boolean {
  const nested = element.closest(NESTED);
  return nested !== null && nested !== post && post.contains(nested);
}

// ------------------------------------------------------------------------------------------------- the bar

/** A post's own bar: its reaction button, the reactions menu beside it (the newer layout's), and its Comment. */
export interface PostBar {
  /** The box around the bar's buttons. */
  readonly box: Element;
  /** The reaction button: Like ("React Like"), or in the newer layout the button its state labels. */
  readonly reaction: Element | null;
  /** The button beside it that opens the reactions to pick from. */
  readonly menu: Element | null;
  /** The post's own Comment, which opens its box. */
  readonly comment: Element | null;
}

/** Whether a control opens a menu or a box: LinkedIn marks it so. */
export const opensMenu = (control: Element) =>
  control.hasAttribute('aria-expanded') || control.hasAttribute('aria-haspopup');

/**
 * The post's own bar: the first box around its own Comment (or Repost, where it has no Comment) that holds a button
 * before it. The last of those is the reactions menu when it opens one, and the reaction button is the one before;
 * else the last is the reaction button. Never a comment's: their bars end with Reply.
 */
export function barOf(box: Element): PostBar | null {
  const post = postIn(box);
  const own = (control: Element) => !nestedIn(control, post);
  const controls = [...post.querySelectorAll(CONTROLS)].filter(own);
  const comment =
    controls.find((c) => says(c, COMMENT) && !c.closest(`form, ${WRITING}`) && !opensMenu(c)) ??
    null;
  const end = comment ?? controls.find((c) => says(c, REPOST)) ?? null;
  if (!end) return null;
  for (let bar = end.parentElement, steps = 0; bar && steps < BAR_STEPS; steps++) {
    const mine = [...bar.querySelectorAll(CONTROLS)].filter(own);
    // A box that holds the post's menu holds its header: past the bar.
    if (mine.some(isMenu)) break;
    const before = mine.filter((c) => isBefore(c, end));
    const last = before[before.length - 1];
    if (last) {
      const menu = opensMenu(last) && before.length > 1 ? last : null;
      return { box: bar, reaction: menu ? before[before.length - 2]! : last, menu, comment };
    }
    if (bar === post) break;
    bar = bar.parentElement;
  }
  return { box: end.parentElement ?? end, reaction: null, menu: null, comment };
}

/** What a reaction button shows: its label, the count beside it, and whether it says it's pressed. */
export interface ReactionState {
  readonly label: string;
  readonly count: number | null;
  readonly pressed: string | null;
}

/** The number a button shows: "55" in the newer reaction button, "9" in its Comment. */
export function countIn(control: Element): number | null {
  for (const line of shownLines(control, { max: 4 })) {
    const match = COUNT.exec(line);
    if (match) return parseCount(match[1]!);
  }
  return null;
}

export function reactionState(button: Element): ReactionState {
  const picture = button.querySelector('[role="img"][aria-label], img[alt]');
  const label =
    clean(button.getAttribute('aria-label')) ||
    clean(picture?.getAttribute('aria-label') ?? picture?.getAttribute('alt')) ||
    shownLines(button, { max: 3 }).join(' ');
  return { label, count: countIn(button), pressed: button.getAttribute('aria-pressed') };
}

/**
 * Whether a reaction button shows one of yours: by LinkedIn's words when it uses them ("Unreact Like", "Reaction
 * button state: like"), or whether it's pressed; else by whether its label differs from the one most other posts'
 * buttons on the page have, which have none of yours. Null when nothing tells.
 */
export function hasYours(
  state: ReactionState,
  others: readonly ReactionState[] = [],
): boolean | null {
  if (REACTED.test(state.label) || state.pressed === 'true') return true;
  if (NOT_REACTED.test(state.label) || state.pressed === 'false') return false;
  const counts = new Map<string, number>();
  for (const { label } of others) if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
  const [most, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
  return total >= 2 && n * 2 > total && state.label ? state.label !== most : null;
}

/** What a press on a reaction button did. */
export type ReactionChange = 'added' | 'removed' | 'changed' | null;

/**
 * What a press on a reaction button did, from how it showed before and after: the count beside it went up (a
 * reaction given) or down (one taken back); else its label changed, from none of yours to one (`hasYours`) or back, or
 * from one reaction to another. Null when nothing changed, or nothing tells which way.
 */
export function reactionChange(
  before: ReactionState,
  after: ReactionState,
  others: readonly ReactionState[] = [],
): ReactionChange {
  if (before.count !== null || after.count !== null) {
    const was = before.count ?? 0;
    const now = after.count ?? 0;
    if (now > was) return 'added';
    if (now < was) return 'removed';
  }
  if (before.label === after.label && before.pressed === after.pressed) return null;
  const had = hasYours(before, others);
  const has = hasYours(after, others);
  if (had === true && has === true) return 'changed';
  if (had === true || has === false) return 'removed';
  if (had === false || has === true) return 'added';
  return null;
}

// ------------------------------------------------------------------------------------------------ comments

/**
 * In LinkedIn's newer layout, the comment something is in: comments aren't articles there, and come after the post's
 * bar. The nearest box around it, after the bar, that links to a member (outside a box to write in): its writer is
 * the first of them.
 */
export function newerCommentOf(
  element: Element,
  box: Element,
  bar: PostBar | null = barOf(box),
): Element | null {
  const post = postIn(box);
  if (!bar) return null;
  for (
    let up = element.parentElement;
    up && up !== post && post.contains(up);
    up = up.parentElement
  ) {
    if (up.contains(bar.box) || !isAfter(up, bar.box)) return null;
    if (commentWriter(up, 'https://www.linkedin.com/')) return up;
  }
  return null;
}

/** Who wrote a comment: the first member its box links to, outside a box to write in. */
export function commentWriter(comment: Element, base: string): LinkedPerson | null {
  const links = [...comment.querySelectorAll('a[href]')].filter((a) => !a.closest(WRITING));
  return peopleLinked(links, base)[0] ?? null;
}

/**
 * The comments (and replies) on a post in LinkedIn's newer layout, in page order: the box of each Reply after the
 * post's bar, as `newerCommentOf` finds it.
 */
export function newerComments(box: Element): Element[] {
  const post = postIn(box);
  const bar = barOf(post);
  if (!bar) return [];
  const replies = [...post.querySelectorAll(CONTROLS)].filter(
    (control) => !nestedIn(control, post) && isAfter(control, bar.box) && says(control, REPLY),
  );
  const comments = replies
    .map((reply) => newerCommentOf(reply, post, bar))
    .filter((comment): comment is Element => comment !== null);
  return [...new Set(comments)];
}

/** How the reaction buttons of the other posts on the page show: what most of them say with none of yours. */
export function otherReactions(root: Element, post: Element): ReactionState[] {
  return postBoxes(root).flatMap((box) => {
    if (box === post || box.contains(post) || post.contains(box)) return [];
    const reaction = barOf(box)?.reaction;
    return reaction ? [reactionState(reaction)] : [];
  });
}

// ------------------------------------------------------------------------------------------------ reading

/** The posts in a part of the page, in page order, `max` at most. */
export function readPosts(root: Element, base: string, max = 30): Post[] {
  const posts: Post[] = [];
  for (const box of postBoxes(root)) {
    const post = readPost(box, base);
    if (post) posts.push(post);
    if (posts.length >= max) break;
  }
  return posts;
}

/** The post's time at its top, and the element it's in: the first piece of its own writing that is one. */
function timeIn(
  post: Element,
  inside: (element: Element) => boolean,
  end: Element | null,
): {
  readonly element: Element;
  readonly when: string | null;
  readonly promoted: boolean;
} | null {
  for (const element of elementsIn(post)) {
    if (end && (end === element || isAfter(element, end))) break;
    if (inside(element) || element.closest(CONTROLS)) continue;
    for (const node of element.childNodes) {
      if (node.nodeType !== 3) continue;
      const text = clean(node.nodeValue);
      if (/^promoted$/i.test(text)) return { element, when: null, promoted: true };
      const when = text ? postTimeOf(text) : null;
      if (when) return { element, when, promoted: false };
    }
  }
  return null;
}

/** Whether `element` starts before `other`: it comes before it, or holds it. */
const startsBefore = (element: Element, other: Element) =>
  element.contains(other) || isBefore(element, other);

/** Someone (or a page) linked in a post's header, with every link to them there. */
interface Linked {
  readonly key: string;
  readonly profile: ProfileRef | null;
  readonly company: CompanyRef | null;
  readonly anchors: Element[];
}

/** The members and pages linked from some links, each once, in page order. */
function linkedIn(anchors: readonly Element[], base: string): Linked[] {
  const found = new Map<string, Linked>();
  for (const anchor of anchors) {
    const url = linkedinUrl(anchor.getAttribute('href') ?? '', base);
    const profile = url ? profileFromUrl(url) : null;
    const company = url && !profile ? pageFromUrl(url) : null;
    if (!profile && !company) continue;
    const key = profile ? profileKey(profile) : `page:${company!.url}`;
    const entry = found.get(key);
    if (entry) entry.anchors.push(anchor);
    else found.set(key, { key, profile, company, anchors: [anchor] });
  }
  return [...found.values()];
}

/** A linked member's or page's name, from all its links in the header: their words first. */
const nameOf = (linked: Linked) =>
  bestName(namesOn(linked.anchors).map((n) => n.replace(/\s+logo$/i, '')));

const wordsOfName = (name: string) =>
  clean(name)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

/** Whether two ways of writing a name are one: the same, or one the other with more after ("Dana Reyes, MBA"). */
function sameAuthor(a: string, b: string): boolean {
  if (sameName(a, b)) return true;
  const [x, y] = [wordsOfName(a), wordsOfName(b)];
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 2 && short.every((word, i) => long[i] === word);
}

/** What a post's header says about who wrote it and when. */
export interface PostHeader {
  readonly author: Named | null;
  readonly company: CompanyRef | null;
  /** The links to the author in the header. */
  readonly anchors: readonly Element[];
  readonly time: Element | null;
  readonly when: string | null;
  /** LinkedIn was paid to show it: "Promoted" at its top, or "Promoted by …". */
  readonly promoted: boolean;
  /** Where the header ends: the time, else the post's words, else its bar. */
  readonly end: Element | null;
}

/** The first text box of the post's own, before its bar. */
function textBoxOf(post: Element, bar: PostBar | null): Element | null {
  return (
    [...post.querySelectorAll(TEXT_BOX)].find(
      (box) => !nestedIn(box, post) && (!bar || isBefore(box, bar.box)),
    ) ?? null
  );
}

/**
 * Who wrote a post and when, from its header. The header's start is the last line (`hr`) before its end, when there is
 * one: what's above it is about someone else ("Sam Lee likes this"). The author is the one linked there whom the
 * post's menu names; with no menu to go by, the last linked before the time, else the first. Where the menu names
 * someone nobody there is linked as, they're the author, with no profile.
 */
export function postHeader(box: Element, base: string): PostHeader {
  const post = postIn(box);
  const inside = (element: Element) => nestedIn(element, post);
  const bar = barOf(post);
  const words = textBoxOf(post, bar);
  const found = timeIn(post, inside, words ?? bar?.box ?? null);
  const end = found?.element ?? words ?? bar?.box ?? null;
  const lines = [...post.querySelectorAll('hr')].filter(
    (hr) => !inside(hr) && (!end || isBefore(hr, end)),
  );
  const start = lines[lines.length - 1] ?? null;
  const inHeader = (element: Element) =>
    !inside(element) &&
    (!start || isAfter(element, start)) &&
    (!end || startsBefore(element, end)) &&
    !(words && words.contains(element));
  const linked = linkedIn([...post.querySelectorAll('a[href]')].filter(inHeader), base);
  const menuName = [...post.querySelectorAll(CONTROLS)]
    .filter((control) => !inside(control))
    .flatMap(wordsOf)
    .map((words) => POST_MENU_BY.exec(words)?.[1]?.trim())
    .find(Boolean);
  const named = linked.map((entry) => ({ entry, name: nameOf(entry) }));
  const byMenu = menuName
    ? named.find(({ name }) => name && sameAuthor(name, menuName))
    : undefined;
  const beforeTime = found
    ? named.filter(({ entry }) => entry.anchors.some((a) => startsBefore(a, found.element)))
    : [];
  const chosen = menuName
    ? byMenu
    : (beforeTime.filter(({ name }) => name).pop() ?? named.find(({ name }) => name));
  const promoted =
    !!found?.promoted ||
    [...post.querySelectorAll('*')].some(
      (element) =>
        inHeader(element) &&
        [...element.childNodes].some(
          (node) => node.nodeType === 3 && PROMOTED.test(clean(node.nodeValue)),
        ),
    );
  const author: Named | null = chosen?.name
    ? { name: chosen.name, profile: chosen.entry.profile }
    : menuName
      ? { name: menuName, profile: null }
      : null;
  return {
    author,
    company: chosen?.entry.company ?? null,
    anchors: chosen?.entry.anchors ?? [],
    time: found?.element ?? null,
    when: found?.when ?? null,
    promoted,
    end,
  };
}

function firstCount(words: readonly string[], pattern: RegExp, plus = 0): number | null {
  for (const word of words) {
    const match = pattern.exec(word);
    const count = match?.[1] ? parseCount(match[1]) : null;
    if (count !== null) return count + plus;
  }
  return null;
}

/** "Thinking about #plumbing" from the "hashtag#plumbing" LinkedIn writes for screen readers. */
const withHashtags = (text: string) => text.replace(/\bhashtag\s*#\s*/gi, '#');

/** The line under the author's name in the header: their headline, never a count, a time or LinkedIn's words. */
function headlineIn(post: Element, header: PostHeader): string | null {
  const after = header.anchors[0];
  if (!after) return null;
  const name = header.author?.name ?? '';
  const lines = shownLines(post, {
    max: 12,
    after,
    before: header.end,
    exclude: `${NOT_SAID}, a[href]`,
  });
  return (
    lines.find(
      (line) =>
        !isLinkedInText(line) &&
        !postTimeOf(line) &&
        !PROMOTED.test(line) &&
        !(name && sameName(line, name)) &&
        /\p{L}/u.test(line),
    ) ?? null
  );
}

export function readPost(box: Element, base: string): Post | null {
  const post = postIn(box);
  // A comment or a preview is an article inside the post; nothing in one belongs to the post.
  const inside = (element: Element) => nestedIn(element, post);
  const bar = barOf(post);
  // In the newer layout the comments come after the bar: nothing there is the post's either.
  const own = (element: Element) =>
    !inside(element) && !(bar && bar.comment && isAfter(element, bar.box));
  const anchors = [...post.querySelectorAll('a[href]')].filter(own);
  const controls = [...post.querySelectorAll(`${CONTROLS}, a[href]`)].filter(own);
  const header = postHeader(box, base);
  const time = header.time;

  // Its own link: one at its top, by the time; else the id LinkedIn names its box with; else the one a group's link
  // highlights; else any link to a post in it, which may be another post it talks about.
  const links = anchors.flatMap((anchor) => {
    const link = linkedinUrl(anchor.getAttribute('href') ?? '', base);
    const target = link ? postUrlFrom(link) : null;
    return target ? [{ anchor, post: target }] : [];
  });
  const highlighted = anchors
    .map((anchor) => linkedinUrl(anchor.getAttribute('href') ?? '', base))
    .map((link) => (link ? highlightedPostFrom(link) : null))
    .find(Boolean);
  const named = [post, ...post.querySelectorAll(POST_ATTRIBUTES.map((n) => `[${n}]`).join(', '))]
    .filter((element) => !inside(element))
    .map(urnOf);
  const url =
    links.find(({ anchor }) => time && startsBefore(anchor, time))?.post ??
    urnOf(box) ??
    named.find(Boolean) ??
    highlighted ??
    links[0]?.post ??
    null;

  // What it says: its text box; else the lines after the time's line (with its copy for screen readers) and before
  // its counts and bar.
  const words = textBoxOf(post, bar);
  let text = '';
  if (words) text = shownLines(words, { max: 200, exclude: NOT_SAID }).join('\n');
  else {
    const end = controls.find(
      (control) => (!time || isAfter(control, time)) && isBar(wordsOf(control)),
    );
    const lines = shownLines(post, { max: 200, exclude: NOT_SAID, before: end ?? null });
    const at = time
      ? lines.findIndex((line) =>
          header.when ? postTimeOf(line) === header.when : /^promoted\b/i.test(line),
        )
      : -1;
    text = at >= 0 ? lines.slice(at + 1).join('\n') : '';
    if (at < 0) {
      // No time to go by: the longest line that isn't the author's.
      const author = header.author?.name;
      for (const line of lines)
        if (line.length > text.length && !(author && line.startsWith(author))) text = line;
    }
  }
  text = withHashtags(text);

  // Its counts: the numbers in the newer bar's reaction button and Comment; else the older bar's words.
  const words_ = controls.flatMap(wordsOf);
  const reactions =
    (bar?.reaction ? countIn(bar.reaction) : null) ??
    firstCount(words_, REACTIONS) ??
    firstCount(words_, AND_OTHERS, 1);
  const comments = (bar?.comment ? countIn(bar.comment) : null) ?? firstCount(words_, COMMENTS);
  if (!header.author && !text) return null;
  return {
    author: header.author,
    url,
    when: header.when,
    text,
    comments,
    reactions,
    company: header.company,
    headline: headlineIn(post, header),
  };
}
