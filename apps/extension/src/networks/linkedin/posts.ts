/**
 * Posts: in the feed (/feed/), in post search (/search/results/content/), on a post's own page, on a member's
 * activity and in a group. A post is found any of three ways, whichever LinkedIn draws: an article (`role="article"`)
 * that isn't inside another; a box LinkedIn names with the post's own id (`data-urn="urn:li:activity:…"`, not a
 * class); or, where posts are neither, the box from the menu at its top ("Open control menu for post by …") to the
 * bar at its foot (Like, Comment, Repost, Send). An article inside a post is a comment or a link's preview: a comment
 * is never read as a post, and nothing in one (its words, links, time or counts) is the post's.
 *
 * Inside a post, page order says what's what. The author is the last member or company linked before the post's time
 * ("3h •"), so whoever is above them ("Sam Lee likes this") isn't. What it says is the writing after the time and
 * before its counts and its bar.
 */
import { clean, elementsIn, isAfter, isBefore, outermost } from '../facebook/dom';
import { CONTROLS, inTopBar, namesOn, shownLines, wordsOf } from './dom';
import { bestName } from './people';
import type { CompanyRef, Named, Post } from './types';
import { companyFromUrl, linkedinUrl, postFromUrn, postUrlFrom, profileFromUrl } from './urls';
import { COMMENT, LIKE, parseCount, POST_MENU, postTimeOf, REPOST, SEND } from './vocabulary';

/** What's inside a post and isn't it: its comments, and the preview of a link it shares. */
const NESTED = 'article, [role="article"]';
/** The attributes LinkedIn names a post's box with: urn:li:activity:<number>. */
const POST_ATTRIBUTES = ['data-urn', 'data-id', 'data-activity-urn'];
/** What a post's words leave out: buttons, headings ("Feed post number 1") and what's inside it. */
const NOT_SAID = `${CONTROLS}, ${NESTED}, h1, h2, h3, h4, h5, h6, [role="heading"]`;
/** The counts at a post's foot: "42 reactions", "8 comments on Dana Reyes’s post", "3 reposts". */
const REACTIONS = /^([\d.,]+\s*[km]?)\s+reactions?\b/i;
const COMMENTS = /^([\d.,]+\s*[km]?)\s+comments?\b/i;
const REPOSTS = /^([\d.,]+\s*[km]?)\s+reposts?\b/i;
/** Who reacted, as LinkedIn writes it beside the faces: "Dana Reyes and 41 others" is 42. */
const AND_OTHERS = /^.+\s+and\s+([\d.,]+)\s+others?$/i;

const hasWords = (element: Element) => clean(element.textContent) !== '';

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

/** The boxes that are posts, in page order, each the outermost of the ways it's found. */
export function postBoxes(root: Element): Element[] {
  const outside = (element: Element) => !element.parentElement?.closest(NESTED);
  const articles = [...root.querySelectorAll('[role="article"]')].filter(
    (article) => outside(article) && hasWords(article),
  );
  const named = [...root.querySelectorAll(POST_ATTRIBUTES.map((name) => `[${name}]`).join(', '))]
    .filter((element) => urnOf(element) !== null && outside(element) && hasWords(element))
    .filter((element) => !inTopBar(element));
  const boxes = [...articles, ...named, ...byMenus(root)];
  return [...new Set(boxes)]
    .filter((box) => !boxes.some((other) => other !== box && other.contains(box)))
    .sort((a, b) => (isBefore(a, b) ? -1 : isBefore(b, a) ? 1 : 0));
}

/**
 * Posts that are neither articles nor named: the smallest box around each post's menu and the end of its bar after
 * it (Send, or Repost), before the next post's menu.
 */
function byMenus(root: Element): Element[] {
  const controls = [...root.querySelectorAll(CONTROLS)].filter(
    (control) => !inTopBar(control) && !control.closest(NESTED),
  );
  const menus = controls.filter((control) => wordsOf(control).some((w) => POST_MENU.test(w)));
  const sends = controls.filter((control) => wordsOf(control).some((w) => SEND.test(w)));
  const reposts = controls.filter((control) => wordsOf(control).some((w) => REPOST.test(w)));
  const boxes: Element[] = [];
  menus.forEach((menu, i) => {
    const next = menus[i + 1];
    const between = (e: Element) => isAfter(e, menu) && (!next || isAfter(next, e));
    const end = sends.find(between) ?? reposts.find(between);
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
): { readonly element: Element; readonly when: string | null } | null {
  for (const element of elementsIn(post)) {
    if (inside(element) || element.closest(CONTROLS)) continue;
    for (const node of element.childNodes) {
      if (node.nodeType !== 3) continue;
      const text = clean(node.nodeValue);
      if (/^promoted$/i.test(text)) return { element, when: null };
      const when = text ? postTimeOf(text) : null;
      if (when) return { element, when };
    }
  }
  return null;
}

/** Whether `element` starts before `other`: it comes before it, or holds it. */
const startsBefore = (element: Element, other: Element) =>
  element.contains(other) || isBefore(element, other);

/** Who wrote it: the last member or company with a name linked before its time; else the first. */
function authorOf(
  anchors: readonly Element[],
  time: Element | null,
  base: string,
): { readonly author: Named; readonly company: CompanyRef | null } | null {
  const linked = anchors.flatMap((anchor) => {
    const url = linkedinUrl(anchor.getAttribute('href') ?? '', base);
    const profile = url ? profileFromUrl(url) : null;
    const company = url && !profile ? companyFromUrl(url) : null;
    if (!profile && !company) return [];
    const name = bestName(namesOn([anchor]).map((n) => n.replace(/\s+logo$/i, '')));
    return name ? [{ anchor, author: { name, profile }, company }] : [];
  });
  const before = time ? linked.filter(({ anchor }) => startsBefore(anchor, time)) : [];
  const found = before.length ? before[before.length - 1] : linked[0];
  return found ? { author: found.author, company: found.company } : null;
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

export function readPost(box: Element, base: string): Post | null {
  const post = postIn(box);
  // A comment or a preview is an article inside the post; nothing in one belongs to the post.
  const inside = (element: Element) => {
    const nested = element.closest(NESTED);
    return nested !== null && nested !== post && post.contains(nested);
  };
  const anchors = [...post.querySelectorAll('a[href]')].filter((a) => !inside(a));
  const controls = [...post.querySelectorAll(`${CONTROLS}, a[href]`)].filter((c) => !inside(c));

  const time = timeIn(post, inside);
  const found = authorOf(anchors, time?.element ?? null, base);

  // Its own link: one at its top, by the time; else the id LinkedIn names its box with; else any link to a post in
  // it, which may be another post it talks about.
  const links = anchors.flatMap((anchor) => {
    const link = linkedinUrl(anchor.getAttribute('href') ?? '', base);
    const target = link ? postUrlFrom(link) : null;
    return target ? [{ anchor, post: target }] : [];
  });
  const named = [post, ...post.querySelectorAll(POST_ATTRIBUTES.map((n) => `[${n}]`).join(', '))]
    .filter((element) => !inside(element))
    .map(urnOf);
  const url =
    links.find(({ anchor }) => time && startsBefore(anchor, time.element))?.post ??
    urnOf(box) ??
    named.find(Boolean) ??
    links[0]?.post ??
    null;

  // What it says: the lines after the time's line (with its copy for screen readers) and before its counts and bar.
  const bar = controls.find(
    (control) => (!time || isAfter(control, time.element)) && isBar(wordsOf(control)),
  );
  const lines = shownLines(post, { max: 200, exclude: NOT_SAID, before: bar ?? null });
  const at = time
    ? lines.findIndex((line) =>
        time.when ? postTimeOf(line) === time.when : /^promoted\b/i.test(line),
      )
    : -1;
  let text = at >= 0 ? lines.slice(at + 1).join('\n') : '';
  if (at < 0) {
    // No time to go by: the longest line that isn't the author's.
    const author = found?.author.name;
    for (const line of lines)
      if (line.length > text.length && !(author && line.startsWith(author))) text = line;
  }
  text = withHashtags(text);

  const words = controls.flatMap(wordsOf);
  const reactions = firstCount(words, REACTIONS) ?? firstCount(words, AND_OTHERS, 1);
  const comments = firstCount(words, COMMENTS);
  if (!found && !text) return null;
  return {
    author: found?.author ?? null,
    url,
    when: time?.when ?? null,
    text,
    comments,
    reactions,
    company: found?.company ?? null,
  };
}
