/**
 * Threads' and X's own readers (./types.ts, decision 163): what's on a page, by each network's spec. A post is found by
 * the link to it its time sits in (both put the time of a post in a link to it, and its address names who wrote it),
 * its part is that link's post around it (`FollowSpec.rootOf`), and a quoted post inside one is never taken for it: a
 * part is a post only where its first time is that post's. A profile is read off its header, a list of accounts off
 * its rows. They read only, press nothing, and go by the sites' own words, labels, roles, test ids and addresses,
 * never class names.
 */
import { clean } from '../facebook/dom';
import { visible } from '../facebook/fetch';
import type {
  FollowAccount,
  FollowFound,
  FollowListed,
  FollowPost,
  FollowProfile,
  FollowSpec,
} from './types';

/** "1.2K", "3,410", "2M", "12 Likes. Like" as a number; null with none in it. */
export function countOf(text: string | null | undefined): number | null {
  const m = clean(text)
    .replace(/(\d),(\d)/g, '$1$2')
    .match(/(\d+(?:\.\d+)?)\s*(k|m|thousand|million)?\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  const times =
    unit === 'k' || unit === 'thousand'
      ? 1_000
      : unit === 'm' || unit === 'million'
        ? 1_000_000
        : 1;
  return Number.isFinite(n) ? Math.round(n * times) : null;
}

/** Whether two usernames are the same account, whatever their case. */
export const sameName = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** The link a post's time sits in, when it leads to a post. */
function postLinkOf(time: Element, spec: FollowSpec, base: string): string | null {
  const link = time.closest('a[href]');
  const url = link ? spec.url(link.getAttribute('href') ?? '', base) : null;
  return url ? spec.postOf(url) : null;
}

/** The first time in a part that's a post's own: the part's own post, never one it quotes after it. */
function firstPostTime(root: Element, spec: FollowSpec, base: string): Element | null {
  for (const time of root.querySelectorAll('time[datetime]'))
    if (postLinkOf(time, spec, base)) return time;
  return null;
}

/** One post, read from its part. */
function postIn(
  root: Element,
  time: Element,
  url: string,
  spec: FollowSpec,
  me: string | null,
): FollowPost | null {
  const own = spec.url(url);
  const author = own ? spec.postAuthorOf(own) : null;
  if (!author) return null;
  const like = spec.likeIn(root);
  return {
    url,
    author,
    name: spec.nameIn(root, author),
    text: spec.textIn(root),
    at: time.getAttribute('datetime'),
    when: clean(time.textContent) || null,
    likes: like
      ? countOf(like.control.getAttribute('aria-label') ?? like.control.textContent)
      : null,
    replies: spec.repliesIn(root),
    liked: like ? like.liked : null,
    replyingTo: answersTo(root, spec, me),
  };
}

/**
 * Who a post answers, by username: as it says (X's "Replying to"), and the person too where its part says it answers
 * them in its own way (Threads' "replied" on their activity).
 */
function answersTo(root: Element, spec: FollowSpec, me: string | null): string[] {
  const named = spec.replyingToIn(root);
  return me && !named.some((u) => sameName(u, me)) && spec.answersMe(root, me)
    ? [...named, me]
    : named;
}

/** Every post on the page, in page order, each once by its own address. */
export function postsOn(
  doc: Document,
  href: string,
  spec: FollowSpec,
  me: string | null = meOn(doc, href, spec),
): FollowPost[] {
  const seen = new Set<string>();
  const posts: FollowPost[] = [];
  for (const time of doc.querySelectorAll('time[datetime]')) {
    const url = postLinkOf(time, spec, href);
    if (!url || seen.has(url)) continue;
    const root = spec.rootOf(time.closest('a[href]')!);
    // A quoted post's time is in the part of the post that quotes it: that part is the other's.
    if (!root || !visible(root) || firstPostTime(root, spec, href) !== time) continue;
    const post = postIn(root, time, url, spec, me);
    if (!post) continue;
    seen.add(url);
    posts.push(post);
  }
  return posts;
}

/** The part of the page a post is, by its own address: its own page's post, or one in a list. */
export function postRootFor(
  doc: Document,
  href: string,
  spec: FollowSpec,
  url: string,
): Element | null {
  for (const time of doc.querySelectorAll('time[datetime]')) {
    if (postLinkOf(time, spec, href) !== url) continue;
    const root = spec.rootOf(time.closest('a[href]')!);
    if (root && firstPostTime(root, spec, href) === time) return root;
  }
  return null;
}

/** The person's own username, from the menu's link to their profile. */
export function meOn(doc: Document, href: string, spec: FollowSpec): string | null {
  const link = spec.ownLink(doc, href);
  const url = link ? spec.url(link, href) : null;
  return url ? (spec.profileOf(url)?.username ?? null) : null;
}

/** Someone's profile, on their own page: null on any other page, or with no header drawn yet. */
export function profileOn(
  doc: Document,
  href: string,
  spec: FollowSpec,
  posts: readonly FollowPost[],
): FollowProfile | null {
  const page = spec.url(href);
  const account = page && spec.kindOf(page) === 'profile' ? spec.profileOf(page) : null;
  const header = account ? spec.headerOf(doc) : null;
  if (!account || !header) return null;
  const follow = spec.followIn(header);
  return {
    ...account,
    ...spec.profileIn(header, account),
    following: follow.following
      ? follow.requested
        ? 'requested'
        : 'following'
      : follow.follow
        ? 'no'
        : null,
    posts: posts.filter((p) => sameName(p.author.username, account.username)),
  };
}

/** How far up from a link its row is looked for: the part that holds its button. */
const ROW_STEPS = 8;

/** A list's row around a link to someone: the nearest part that holds a button beside the link. */
function rowOf(link: Element, list: Element): Element {
  let row: Element = link;
  for (
    let up = link.parentElement, n = 0;
    up && up !== list && n < ROW_STEPS;
    up = up.parentElement, n++
  ) {
    row = up;
    if (up.querySelector('button, [role="button"]')) break;
  }
  return row;
}

/** The accounts in a list on the page (the person's followers), each once, in page order: never the person. */
export function peopleOn(
  doc: Document,
  href: string,
  spec: FollowSpec,
  me: string | null,
): FollowListed[] {
  const list = spec.listIn(doc);
  if (!list) return [];
  const people = new Map<string, FollowListed>();
  for (const link of list.querySelectorAll('a[href]')) {
    const url = spec.url(link.getAttribute('href') ?? '', href);
    const account = url && !spec.postOf(url) ? spec.profileOf(url) : null;
    if (!account || sameName(account.username, me)) continue;
    const key = account.username.toLowerCase();
    const words = clean(link.textContent);
    const name = words && !/^@/.test(words) && !sameName(words, account.username) ? words : null;
    const had = people.get(key);
    if (had) {
      if (!had.name && name) people.set(key, { ...had, name });
      continue;
    }
    people.set(key, { ...account, name, following: spec.rowStanding(rowOf(link, list)) });
  }
  return [...people.values()];
}

/** Everything the readers find on a page. */
export function readFollow(doc: Document, href: string, spec: FollowSpec): FollowFound {
  const page = spec.url(href);
  const kind = page ? spec.kindOf(page) : 'other';
  const me = meOn(doc, href, spec);
  const posts = postsOn(doc, href, spec, me);
  const here = kind === 'post' && page ? spec.postOf(page) : null;
  const post = here ? (posts.find((p) => p.url === here) ?? null) : null;
  return {
    profile: profileOn(doc, href, spec, posts),
    posts,
    post,
    // Under a post on its own page: what comes after it, never what came before (the posts it answers).
    replies: post ? posts.slice(posts.indexOf(post) + 1) : [],
    people: peopleOn(doc, href, spec, me),
    me,
  };
}

/** A post's account, as kept: by the name in its address. */
export const accountKey = (account: FollowAccount): string => account.username.toLowerCase();
