/**
 * Posts: in a group, on a profile, in the News Feed, or one on its own page. A feed's posts are the children of its
 * `role="feed"`; elsewhere a post is a top-level `role="article"`; and where posts are neither, as on 2026 profiles
 * and the 2026 News Feed, each is found by its "Actions for this post" button. Comments are articles inside a post,
 * labelled "Comment by …" or "Reply by …", and are left out of what the post says.
 */
import { clean, inTopBar, isAfter, isBefore, outermost, textLines } from './dom';
import { bestName } from './people';
import type { Named, Post } from './types';
import { facebookUrl, postUrlFrom, profileFromUrl } from './urls';
import { parseCount } from './vocabulary';

/** The menu button at the top of every post. */
const ACTIONS = /^actions for\b/i;
/** What closes a post: its comment button, the bar of who reacted, or the box to write a comment in. */
const POST_END =
  /^(leave a comment|comment|see who reacted to\b.*|write a (public )?comment…?|comment as\b.*)$/i;
/** A comment or a reply to one: "Comment by Jane Doe 2 hours ago", "Reply by Jane Doe to Sam Carter's comment". */
export const COMMENT = /^(comment|reply) by\b/i;
/** A count on its own, as 2026 posts show them on their buttons: "6", "1.2K". */
const COUNT = /^[\d.,]+\s*[km]?$/i;
/**
 * The Like button: "Like", or since 30 Oct 2026 "React with Like to Dana Reyes's post" (decision 138); "Remove Like"
 * (or Love, Haha…), since then "Remove Like from Dana Reyes's post", once you've reacted. Never the "Change Like
 * reaction" beside it, or the count of reactions ("Like: 8 people").
 */
export const LIKE = /^(like|react with like\b.*|remove (like|love|care|haha|wow|sad|angry)\b.*)$/i;
/** A Like button not pressed yet. */
export const NOT_LIKED = /^(like|react with like\b.*)$/i;
/** One pressed: "Remove Like", "Change Love reaction". */
const LIKED = /^(remove|change) (like|love|care|haha|wow|sad|angry)\b/i;
/** Facebook's own mark on a post's Like button since 2026 (decision 138): it holds when the words change. */
export const LIKE_HOOK = '[data-ad-rendering-role="like_button"]';
/** Whether a post's Like button is pressed already, or not, or says something it doesn't know. */
export function likeStateOf(button: Element): 'like' | 'liked' | 'unknown' {
  const label = clean(button.getAttribute('aria-label')) || clean(button.textContent);
  if (button.getAttribute('aria-pressed') === 'true' || LIKED.test(label)) return 'liked';
  return NOT_LIKED.test(label) ? 'like' : 'unknown';
}

const hasWords = (element: Element) => clean(element.textContent) !== '';

/**
 * The boxes that are posts, in page order: a feed's children, or else the top-level articles that aren't comments
 * and the boxes around the "Actions for this post" buttons outside them. Empty articles are Facebook's grey
 * placeholders while posts load.
 */
export function postBoxes(root: Element): Element[] {
  const fromFeeds = [...root.querySelectorAll('[role="feed"]')].flatMap((feed) =>
    [...feed.children].filter(hasWords),
  );
  if (fromFeeds.length > 0) return fromFeeds;
  const articles = [...root.querySelectorAll('[role="article"]')].filter(
    (article) =>
      !article.parentElement?.closest('[role="article"]') &&
      !COMMENT.test(clean(article.getAttribute('aria-label'))) &&
      hasWords(article),
  );
  // Since 30 Oct 2026 a profile's posts are plain boxes Facebook marks as drawn or not, its Like marked within
  // (decision 138); one scrolled past is an empty stand-in.
  const drawn = [...root.querySelectorAll('[data-virtualized="false"]')].filter(
    (box) => box.querySelector(LIKE_HOOK) !== null && hasWords(box),
  );
  const boxes = [...articles, ...byActions(root), ...drawn];
  return boxes
    .filter((box) => !boxes.some((other) => other !== box && other.contains(box)))
    .sort((a, b) => (isBefore(a, b) ? -1 : isBefore(b, a) ? 1 : 0));
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

/** The box of the post something on the page is in, when it's in one: a button, a comment, the box to comment in. */
export function postAround(element: Element, root: Element): Element | null {
  return postBoxes(root).find((box) => box !== element && box.contains(element)) ?? null;
}

/**
 * The last post that ends before something on the page, with no other post starting in between: the one a box to
 * comment in belongs to when Facebook draws the box below the post rather than in it.
 */
export function postBefore(element: Element, root: Element): Element | null {
  const before = postBoxes(root).filter((box) => isBefore(box, element) && !box.contains(element));
  const last = before[before.length - 1];
  if (!last) return null;
  const menus = [...root.querySelectorAll('[aria-label]')].filter(
    (e) => ACTIONS.test(clean(e.getAttribute('aria-label'))) && !inTopBar(e),
  );
  return menus.some((menu) => isAfter(menu, last) && isBefore(menu, element)) ? null : last;
}

/** A post's comments and replies, in page order: the articles inside it. */
export function commentsIn(box: Element): Element[] {
  const post = postIn(box);
  return [...post.querySelectorAll('[role="article"]')].filter((article) => article !== post);
}

/** The comment or reply something in a post is in, when it's in one. */
export function commentAround(element: Element, box: Element): Element | null {
  const post = postIn(box);
  const article = element.closest('[role="article"]');
  return article && article !== post && post.contains(article) ? article : null;
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
 * The counts on a post's own buttons, as Facebook shows them since 2026 ("👍 2  💬 6"): the number on "Leave a
 * comment" is how many comments it has, and the number on the Like button before it how many reacted. A comment's
 * buttons don't count.
 */
function buttonCounts(
  post: Element,
  inComment: (element: Element) => boolean,
): { readonly comments: number | null; readonly reactions: number | null } {
  const buttons = [...post.querySelectorAll('[role="button"]')].filter((e) => !inComment(e));
  const label = (e: Element) => clean(e.getAttribute('aria-label'));
  const number = (e: Element | undefined) => {
    const text = clean(e?.textContent);
    return COUNT.test(text) ? parseCount(text) : null;
  };
  const comment = buttons.find((e) => /^leave a comment$/i.test(label(e)));
  const like = buttons
    .filter((e) => LIKE.test(label(e)) && (!comment || isBefore(e, comment)))
    .pop();
  return { comments: number(comment), reactions: number(like) };
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
  // Since 2026 a post's own time link stays empty until you point at it, but each comment's time links to the post,
  // with the comment marked: that gives the post's address, though not when it went up.
  for (const anchor of url ? [] : post.querySelectorAll('a[href]')) {
    if (!inComment(anchor)) continue;
    const link = facebookUrl(anchor.getAttribute('href') ?? '', base);
    url = link ? postUrlFrom(link) : null;
    if (url) break;
  }

  const author = authorOf(anchors, base);

  const message = [
    ...post.querySelectorAll('[data-ad-comet-preview="message"], [data-ad-preview="message"]'),
  ].find((element) => !inComment(element));
  // Line by line, without its "See more" button.
  let text = message ? textLines(message, 200, '[role="button"]').join('\n') : '';
  if (!text) {
    // No marked message: the longest piece of writing that isn't a heading, a button, a comment, hidden, or the
    // author's name.
    for (const element of post.querySelectorAll('[dir="auto"]')) {
      if (
        inComment(element) ||
        element.closest(
          'h1, h2, h3, h4, h5, h6, [role="heading"], [role="button"], [aria-hidden="true"]',
        )
      )
        continue;
      const candidate = clean(element.textContent);
      if (candidate.length > text.length && candidate !== author?.name) text = candidate;
    }
  }

  const lines = textLines(post, 120, '[role="article"]');
  const counted = buttonCounts(post, inComment);
  const comments = firstCount(lines, /^([\d.,]+\s*[km]?)\s+comments?$/i) ?? counted.comments;
  const reactions =
    firstCount(lines, /^all reactions:?\s*([\d.,]+\s*[km]?)$/i) ?? counted.reactions;
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
