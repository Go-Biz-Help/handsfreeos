/**
 * Threads (decision 163; ../follows/types.ts): its addresses and where things are on its pages. threads.com/@<name>
 * for an account, /@<name>/post/<code> for a post (the writer's name in it), /search?q=…&filter=recent for its post
 * search newest first, /activity for the person's notifications (replies among them), and /login when it asks them to
 * sign in. threads.net, its old address, still opens it.
 *
 * Its pages give few test ids, so the readers go by its words, labels and roles: a post's part is the one it marks as
 * pressable around its own link and time, its Like and Reply are icons labelled Like (Unlike once liked) and Reply in a
 * button, a profile's Follow is a button that says Follow (Follow back when they follow the person, Following once
 * followed), its followers a count that says "followers", which opens them in a box over the profile, and the box to
 * reply in opens over the post when its Reply is pressed, sent with its own Post. Never class names.
 */
import { clean } from '../facebook/dom';
import { visible } from '../facebook/fetch';
import { boxesSaying, controlsSaying, mainOf, nameOf } from '../looking/looks';
import { countOf } from '../follows/read';
import type { FollowAccount, FollowSpec, Standing } from '../follows/types';

export const HOST = 'www.threads.com';
const HOSTS = new Set(['www.threads.com', 'threads.com', 'www.threads.net', 'threads.net']);
const ORIGIN = `https://${HOST}`;

/** An account's name, after the @ in its address: letters, numbers, dots and underscores, 30 at most. */
const NAME = /^@([A-Za-z0-9._]{1,30})$/;
/** A post's code in its address. */
const CODE = /^[A-Za-z0-9_-]{5,64}$/;
/** The tabs under an account: its own page still. */
const PROFILE_TABS = new Set(['', 'replies', 'media', 'reposts']);

export const partsOf = (url: URL) => url.pathname.split('/').filter(Boolean);

/** A link on its pages as a whole address on threads.com, or null when it leads anywhere else. */
export function threadsUrl(href: string, base?: string): URL | null {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname.toLowerCase())) return null;
  url.hostname = HOST;
  url.hash = '';
  return url;
}

/** The account an address's first part names: @<name>. */
const accountName = (url: URL): string | null => NAME.exec(partsOf(url)[0] ?? '')?.[1] ?? null;

export function kindOf(url: URL): string {
  const [first = '', second = '', third = ''] = partsOf(url);
  const lower = first.toLowerCase();
  if (!first) return 'feed';
  if (lower === 'search') return 'search';
  if (lower === 'activity') return 'notifications';
  if (lower === 'login' || lower === 'logout') return 'login';
  if (lower === 'settings') return 'settings';
  if (lower === 'saved' || lower === 'liked') return 'other';
  if (!accountName(url)) return 'other';
  if (second.toLowerCase() === 'post' && CODE.test(third)) return 'post';
  return PROFILE_TABS.has(second.toLowerCase()) ? 'profile' : 'other';
}

export function profileOf(url: URL): FollowAccount | null {
  const name = accountName(url);
  if (!name || !PROFILE_TABS.has((partsOf(url)[1] ?? '').toLowerCase())) return null;
  return { username: name, url: `${ORIGIN}/@${name}` };
}

export function postOf(url: URL): string | null {
  const [, second = '', third = ''] = partsOf(url);
  const name = accountName(url);
  if (!name || second.toLowerCase() !== 'post' || !CODE.test(third)) return null;
  return `${ORIGIN}/@${name}/post/${third}`;
}

export function postAuthorOf(url: URL): FollowAccount | null {
  const name = postOf(url) ? accountName(url) : null;
  return name ? { username: name, url: `${ORIGIN}/@${name}` } : null;
}

/** Threads' own words on its pages, as the outline keeps them. */
const WORDS = new Set(
  [
    'Threads',
    'Home',
    'Search',
    'Create',
    'New thread',
    'Activity',
    'Profile',
    'More',
    'Menu',
    'Back',
    'For you',
    'Following',
    'Follow',
    'Follow back',
    'Requested',
    'Unfollow',
    'Mention',
    'Like',
    'Unlike',
    'Reply',
    'Replies',
    'Repost',
    'Reposts',
    'Quote',
    'Share',
    'Post',
    'Posts',
    'Media',
    'Top',
    'Recent',
    'Profiles',
    'followers',
    'Followers',
    'Edit profile',
    'Translate',
    'See translation',
    'Author',
    'Pinned',
    'View activity',
    'Activity',
    'All',
    'Follows',
    'Requests',
    'Mentions',
    'Quotes',
    'Verified',
    'Cancel',
    'Close',
    'Done',
    'Discard',
    'Not now',
    'Log in',
    'Log in with Instagram',
    'Continue with Instagram',
    'Sign up',
    'Log out',
    'Settings',
    'Saved',
    'Liked',
    'Report a problem',
    'Appearance',
    'Insights',
    'Feeds',
    'Add to thread',
    'Add a topic',
    'Anyone can reply & quote',
    'Reply options',
    'Suggested for you',
    'See all',
    'Load more',
    'Show more',
    'Hidden replies',
    'Instagram',
    'Meta',
    'Terms',
    'Privacy Policy',
    'Cookies Policy',
  ].map((w) => w.toLowerCase()),
);

/** Threads' own words in its addresses. */
const PATH_WORDS = new Set([
  'search',
  'activity',
  'login',
  'settings',
  'post',
  'replies',
  'media',
  'reposts',
  'saved',
  'liked',
  'followers',
  'following',
  'insights',
]);

/** Threads' warnings, as its pages word them: Instagram's, as the same account's. */
const WARNINGS: readonly RegExp[] = [
  /\baction blocked\b/i,
  /\btry again later\b/i,
  /\bwe limit how often\b/i,
  /\bwe restrict certain activity\b/i,
  /\byour account (has been|was|is) (temporarily )?(locked|restricted|suspended|disabled)\b/i,
  /\bwe suspect automated behaviou?r\b/i,
  /\b(confirm|verify) (it['’]s you|your identity|your account)\b/i,
];

const LIKE = /^like$/i;
const UNLIKE = /^unlike$/i;
const REPLY = /^reply$/i;
const FOLLOW = /^(follow|follow back)$/i;
const FOLLOWING = /^(following|requested)$/i;
const EDIT = /^edit profile$/i;
const FOLLOWERS = /^[\d.,]+\s*[km]?\s+followers?$/i;

/** A button whose icon is labelled with these words, in a part of the page. */
function iconButton(root: Element, words: RegExp): HTMLElement | null {
  for (const icon of root.querySelectorAll('svg[aria-label]')) {
    if (!words.test(clean(icon.getAttribute('aria-label')))) continue;
    const button = icon.closest<HTMLElement>('[role="button"], button');
    if (button && root.contains(button) && visible(button)) return button;
  }
  return null;
}

/** The count shown in a post's button beside its icon: "12". */
const countIn = (button: HTMLElement | null): number | null =>
  button ? countOf(clean(button.textContent)) : null;

/** The page's part a profile's header is in: the part around its Follow (or Edit profile) that shows its followers. */
function headerOf(doc: Document): Element | null {
  const main = mainOf(doc);
  const button = controlsSaying(
    main,
    /^(follow|follow back|following|requested|edit profile)$/i,
    true,
  )[0];
  if (!button) return null;
  for (let up = button.parentElement, n = 0; up && n < 12; up = up.parentElement, n++)
    if (
      [...up.querySelectorAll('span, div, a')].some((part) =>
        FOLLOWERS.test(clean(part.textContent)),
      )
    )
      return up;
  return null;
}

/** A profile's count of its followers, as it says: "1,234 followers". */
function followersIn(header: Element): HTMLElement | null {
  const parts = [...header.querySelectorAll<HTMLElement>('span, div, a, [role="button"]')].filter(
    (part) => FOLLOWERS.test(clean(part.textContent)),
  );
  // The smallest that says it: the count itself, or the button around it.
  return (
    parts.sort((a, b) => (a.textContent ?? '').length - (b.textContent ?? '').length)[0] ?? null
  );
}

/**
 * Every piece of writing in a part, each apart from the next: its pages put a name, a time and "replied" side by side
 * with nothing between them, which reads as one word ("2hreplied") in its text as a whole.
 */
function wordsOf(root: Element): string {
  const doc = root.ownerDocument;
  const walk = doc.createTreeWalker(root, 4 /* text */);
  const words: string[] = [];
  for (let node = walk.nextNode(); node; node = walk.nextNode()) {
    const text = clean(node.textContent);
    if (text) words.push(text);
  }
  return words.join(' ');
}

/** What a post says: its own lines, never its writer's name, its buttons' counts or its time. */
function textIn(root: Element): string {
  const lines: string[] = [];
  for (const span of root.querySelectorAll('span[dir="auto"], div[dir="auto"]')) {
    if (span.querySelector('span[dir="auto"], div[dir="auto"]')) continue;
    if (span.closest('a[href], [role="button"], button, time, h1, h2')) continue;
    const words = clean(span.textContent);
    if (!words || /^[\d.,]+[km]?$/i.test(words) || WORDS.has(words.toLowerCase()) || words === '·')
      continue;
    lines.push(words);
  }
  return lines.join('\n').trim();
}

export const THREADS_SPEC: FollowSpec = {
  platform: 'threads',
  name: 'Threads',
  hosts: [
    'https://www.threads.com/*',
    'https://www.threads.net/*',
    'https://threads.com/*',
    'https://threads.net/*',
  ],
  host: HOST,
  url: threadsUrl,
  kindOf,
  profileOf,
  postOf,
  postAuthorOf,
  pathWords: PATH_WORDS,
  words: WORDS,
  warnings: WARNINGS,
  warnedAt: (url) =>
    /^\/(challenge|checkpoint)\b/i.test(url.pathname)
      ? 'Threads is asking you to confirm it’s you before you go on.'
      : null,
  pages: {
    home: `${ORIGIN}/`,
    search: (words) =>
      `${ORIGIN}/search?q=${encodeURIComponent(words)}&serp_type=default&filter=recent`,
    notifications: `${ORIGIN}/activity`,
    followers: () => null,
  },
  ownLink: (doc, href) => {
    for (const anchor of doc.querySelectorAll('a[href]')) {
      if (!/^profile$/i.test(nameOf(anchor))) continue;
      const url = threadsUrl(anchor.getAttribute('href') ?? '', href);
      const own = url ? profileOf(url) : null;
      if (own) return own.url;
    }
    return null;
  },
  rootOf: (timeLink) => {
    const marked = timeLink.closest('[data-pressable-container="true"]');
    if (marked) return marked;
    // Else the largest part around the link that holds no other post's time.
    let root: Element = timeLink;
    for (let up = timeLink.parentElement, n = 0; up && n < 12; up = up.parentElement, n++) {
      const times = [...up.querySelectorAll('a[href] time[datetime]')].filter((t) => {
        const link = t.closest('a[href]');
        const url = link ? threadsUrl(link.getAttribute('href') ?? '', ORIGIN) : null;
        return url ? postOf(url) !== null : false;
      });
      if (times.length > 1) break;
      root = up;
    }
    return root === timeLink ? null : root;
  },
  // Threads names a post's writer by their username alone.
  nameIn: () => null,
  textIn,
  likeIn: (root) => {
    const liked = iconButton(root, UNLIKE);
    if (liked) return { control: liked, liked: true };
    const like = iconButton(root, LIKE);
    return like ? { control: like, liked: false } : null;
  },
  replyIn: (root) => iconButton(root, REPLY),
  repliesIn: (root) => countIn(iconButton(root, REPLY)),
  replyingToIn: () => [],
  headerOf,
  profileIn: (header, account) => {
    const heading = header.querySelector('h1, h2');
    const name = clean(heading?.textContent) || null;
    const lines = [...header.querySelectorAll('span[dir="auto"], div[dir="auto"]')]
      .filter((part) => !part.querySelector('span[dir="auto"], div[dir="auto"]'))
      .filter((part) => !part.closest('a[href], [role="button"], button, h1, h2'))
      .map((part) => clean(part.textContent))
      .filter(
        (words) =>
          words &&
          words.toLowerCase() !== account.username.toLowerCase() &&
          !FOLLOWERS.test(words) &&
          !WORDS.has(words.toLowerCase()),
      );
    const links = [...header.querySelectorAll('a[href]')]
      .filter((a) => !threadsUrl(a.getAttribute('href') ?? '', ORIGIN))
      .map((a) => `Link: ${clean(a.textContent)}`)
      .filter((line) => line !== 'Link: ');
    const follow = controlsSaying(header, FOLLOW, true)[0] ?? null;
    return {
      name: name && name.toLowerCase() !== account.username.toLowerCase() ? name : null,
      bio: lines.join('\n') || null,
      links,
      followers: countOf(followersIn(header)?.textContent),
      followsYou:
        /\bfollows you\b/i.test(clean(header.textContent)) ||
        (follow !== null && /^follow back$/i.test(nameOf(follow)))
          ? true
          : follow || controlsSaying(header, FOLLOWING, true).length
            ? false
            : null,
    };
  },
  followIn: (header) => {
    const following = controlsSaying(header, FOLLOWING, true)[0] ?? null;
    const follow = following ? null : (controlsSaying(header, FOLLOW, true)[0] ?? null);
    return {
      follow,
      following,
      requested: following !== null && /^requested$/i.test(nameOf(following)),
    };
  },
  unfollowIn: (doc) => {
    for (const box of doc.querySelectorAll(
      '[role="dialog"], [role="alertdialog"], [role="menu"]',
    )) {
      const found = controlsSaying(box, /^unfollow$/i)[0];
      if (found) return found;
    }
    return null;
  },
  listIn: (doc) => {
    // The box of their followers over the profile: one that lists accounts.
    for (const box of doc.querySelectorAll('[role="dialog"]'))
      if (box.querySelector('a[href^="/@"], a[href*="threads.com/@"], a[href*="threads.net/@"]'))
        return box;
    return null;
  },
  rowStanding: (row): Standing | null => {
    if (controlsSaying(row, /^requested$/i, true).length) return 'requested';
    if (controlsSaying(row, /^following$/i, true).length) return 'following';
    return controlsSaying(row, FOLLOW, true).length ? 'no' : null;
  },
  openFollowers: (doc) => {
    if (THREADS_SPEC.listIn(doc)) return true;
    const header = headerOf(doc);
    if (!header || !controlsSaying(header, EDIT, true).length) return false;
    const count = followersIn(header);
    const button = count?.closest<HTMLElement>('[role="button"], a[href], button') ?? count;
    if (!button) return false;
    button.click();
    return true;
  },
  replyBoxes: (doc) => {
    const over = [
      ...doc.querySelectorAll<HTMLElement>(
        '[role="dialog"] [contenteditable="true"], [role="dialog"] [role="textbox"]',
      ),
    ].filter((b) => visible(b));
    return over.length ? over : boxesSaying(mainOf(doc), /^reply to\b/i);
  },
  sendFor: (box) => {
    for (let up = box.parentElement, n = 0; up && n < 14; up = up.parentElement, n++) {
      const post = controlsSaying(up, /^post$/i, true);
      if (post.length) return post.length === 1 ? post[0]! : null;
    }
    return null;
  },
  // Only on their activity, where a reply to them says so: never a post elsewhere that happens to say "replied".
  answersMe: (root) =>
    /^\/activity\b/i.test(root.ownerDocument.defaultView?.location.pathname ?? '') &&
    /\b(replied|replying to you)\b/i.test(wordsOf(root)),
};
