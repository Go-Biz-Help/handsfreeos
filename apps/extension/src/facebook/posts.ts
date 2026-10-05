/**
 * Posts: in a group, on a profile, in the News Feed, or one on its own page. A feed's posts are the children of its
 * `role="feed"`; elsewhere a post is a top-level `role="article"`; and where posts are neither, as on 2026 profiles,
 * each is found by its "Actions for this post" button. Comments are articles inside a post, and are left out of what
 * the post says.
 */
import { clean, inTopBar, isAfter, outermost, textLines } from './dom';
import { bestName } from './people';
import type { Named, Post } from './types';
import { facebookUrl, postUrlFrom, profileFromUrl } from './urls';
import { parseCount } from './vocabulary';

/** The menu button at the top of every post. */
const ACTIONS = /^actions for\b/i;
/** What closes a post: its comment button, the bar of who reacted, or the box to write a comment in. */
const POST_END =
  /^(leave a comment|comment|see who reacted to\b.*|write a (public )?comment…?|comment as\b.*)$/i;

const hasWords = (element: Element) => clean(element.textContent) !== '';

/** The boxes that are posts. Empty articles are Facebook's grey placeholders while posts load. */
function postBoxes(root: Element): Element[] {
  const fromFeeds = [...root.querySelectorAll('[role="feed"]')].flatMap((feed) =>
    [...feed.children].filter(hasWords),
  );
  if (fromFeeds.length > 0) return fromFeeds;
  const articles = [...root.querySelectorAll('[role="article"]')].filter(
    (article) => !article.parentElement?.closest('[role="article"]') && hasWords(article),
  );
  if (articles.length > 0) return articles;
  return byActions(root);
}

/**
 * Posts that are neither a feed's children nor articles: the smallest box around each post's "Actions for this
 * post" button and the comment button or reactions bar after it, before the next post's button.
 */
function byActions(root: Element): Element[] {
  const labelled = [...root.querySelectorAll('[aria-label]')].filter((e) => !inTopBar(e));
  const label = (e: Element) => clean(e.getAttribute('aria-label'));
  // A menu inside an article is a comment's: here the posts themselves aren't articles.
  const menus = labelled.filter((e) => ACTIONS.test(label(e)) && !e.closest('[role="article"]'));
  const ends = labelled.filter((e) => POST_END.test(label(e)));
  const boxes: Element[] = [];
  menus.forEach((menu, i) => {
    const next = menus[i + 1];
    const end = ends.find((e) => isAfter(e, menu) && (!next || isAfter(next, e)));
    if (!end) return;
    let box: Element = menu;
    while (!box.contains(end) && box.parentElement && box !== root) box = box.parentElement;
    if (box.contains(end) && !boxes.some((b) => b.contains(box) || box.contains(b)))
      boxes.push(box);
  });
  return boxes;
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

function firstCount(lines: readonly string[], pattern: RegExp): number | null {
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match?.[1]) return parseCount(match[1]);
  }
  return null;
}

/**
 * The post in a box from a feed. Sometimes the post is an article with its comments inside it, and sometimes the box
 * holds the post itself with its comments as articles: the first link in the box (its author) says which.
 */
function postIn(box: Element): Element {
  if (box.matches('[role="article"]')) return box;
  const first = box.querySelector('a[href]');
  const article = outermost(box, '[role="article"]')[0];
  return article && first && article.contains(first) ? article : box;
}

export function readPost(box: Element, base: string): Post | null {
  const post = postIn(box);
  // A comment is an article inside the post; nothing in one belongs to the post.
  const inComment = (element: Element) => {
    const article = element.closest('[role="article"]');
    return article !== null && article !== post && post.contains(article);
  };
  const anchors = [...post.querySelectorAll('a[href]')].filter((a) => !inComment(a));

  let url: string | null = null;
  let when: string | null = null;
  for (const anchor of anchors) {
    const link = facebookUrl(anchor.getAttribute('href') ?? '', base);
    const permalink = link ? postUrlFrom(link) : null;
    if (!permalink) continue;
    url = permalink;
    when = clean(anchor.textContent) || clean(anchor.getAttribute('aria-label')) || null;
    break;
  }

  const author = authorOf(anchors, base);

  const message = [
    ...post.querySelectorAll('[data-ad-comet-preview="message"], [data-ad-preview="message"]'),
  ].find((element) => !inComment(element));
  // Line by line, without its "See more" button.
  let text = message ? textLines(message, 200, '[role="button"]').join('\n') : '';
  if (!text) {
    // No marked message: the longest piece of writing that isn't a heading, a comment, hidden, or the author's name.
    for (const element of post.querySelectorAll('[dir="auto"]')) {
      if (
        inComment(element) ||
        element.closest('h1, h2, h3, h4, h5, h6, [role="heading"], [aria-hidden="true"]')
      )
        continue;
      const candidate = clean(element.textContent);
      if (candidate.length > text.length && candidate !== author?.name) text = candidate;
    }
  }

  const lines = textLines(post, 120, '[role="article"]');
  const comments = firstCount(lines, /^([\d.,]+\s*[km]?)\s+comments?$/i);
  const reactions = firstCount(lines, /^all reactions:?\s*([\d.,]+\s*[km]?)$/i);
  if (!author && !text) return null;
  return { author, url, when, text, comments, reactions };
}

/** Who wrote it: the profile linked from the post's heading, or else its first profile link with a name. */
function authorOf(anchors: readonly Element[], base: string): Named | null {
  const profiles = anchors.flatMap((anchor) => {
    const link = facebookUrl(anchor.getAttribute('href') ?? '', base);
    const profile = link ? profileFromUrl(link) : null;
    if (!profile) return [];
    const name = bestName(textLines(anchor, 1));
    return name ? [{ anchor, named: { name, profile } }] : [];
  });
  const fromHeading = profiles.find(({ anchor }) =>
    Boolean(anchor.closest('h1, h2, h3, h4, h5, h6, [role="heading"], strong')),
  );
  return (fromHeading ?? profiles[0])?.named ?? null;
}
