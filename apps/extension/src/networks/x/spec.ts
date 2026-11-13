/**
 * X (decision 163; ../follows/types.ts): its addresses and where things are on its pages. x.com/<handle> for an
 * account (/followers under it), /<handle>/status/<id> for a post (the writer's handle in it), /search?q=…&f=live for
 * its post search newest first, /notifications/mentions for the posts that mention or answer the person, /messages
 * for their messages (never opened), and /i/flow/login when it asks them to sign in. twitter.com sends to x.com.
 *
 * Its pages mark their parts with test ids (`data-testid`), which the readers go by beside its words and roles: a post
 * is `tweet`, its words `tweetText`, its Like `like` (`unlike` once liked), its Reply `reply`; a profile's name is
 * `UserName`, its bio `UserDescription`, its Follow `<id>-follow` (`<id>-unfollow` once followed), "Follows you"
 * `userFollowIndicator`; the box to reply in is `tweetTextarea_0`, sent with `tweetButtonInline` (or `tweetButton` in
 * the box over the page); the Unfollow it asks to be sure with is `confirmationSheetConfirm`; a list's row is
 * `UserCell`; the menu's Profile is `AppTabBar_Profile_Link`. Never class names.
 */
import { clean } from '../facebook/dom';
import { visible } from '../facebook/fetch';
import { boxesSaying, controlsSaying, mainOf } from '../looking/looks';
import { countOf } from '../follows/read';
import type { FollowAccount, FollowSpec, Standing } from '../follows/types';

export const HOST = 'x.com';
const HOSTS = new Set([
  'x.com',
  'www.x.com',
  'mobile.x.com',
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
]);
const ORIGIN = `https://${HOST}`;

/** First parts of its addresses that are X's own places, never an account's handle. */
const NOT_NAMES = new Set([
  'home',
  'explore',
  'search',
  'notifications',
  'messages',
  'i',
  'settings',
  'compose',
  'login',
  'logout',
  'signup',
  'tos',
  'privacy',
  'jobs',
  'premium',
  'premium_sign_up',
  'communities',
  'lists',
  'bookmarks',
  'account',
  'intent',
  'share',
  'hashtag',
  'who_to_follow',
  'topics',
  'verified-choose',
  'jobs',
  'grok',
  'about',
  'help',
  'download',
]);
/** A handle: letters, numbers and underscores, 15 at most. */
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
/** The tabs under an account: its own page still. */
const PROFILE_TABS = new Set([
  '',
  'with_replies',
  'media',
  'likes',
  'highlights',
  'articles',
  'superfollows',
]);
const LIST_TABS = new Set(['followers', 'verified_followers', 'following', 'followers_you_follow']);

export const partsOf = (url: URL) => url.pathname.split('/').filter(Boolean);

/** A link on its pages as a whole address on x.com, or null when it leads anywhere else. */
export function xUrl(href: string, base?: string): URL | null {
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

/** The account an address's first part names, when it's a handle. */
function handleOf(url: URL): string | null {
  const first = partsOf(url)[0] ?? '';
  return HANDLE.test(first) && !NOT_NAMES.has(first.toLowerCase()) ? first : null;
}

export function kindOf(url: URL): string {
  const [first = '', second = '', third = ''] = partsOf(url).map((p) => p.toLowerCase());
  if (!first || first === 'home') return 'feed';
  if (first === 'search') return 'search';
  if (first === 'explore') return 'explore';
  if (first === 'notifications') return 'notifications';
  if (first === 'messages') return second ? 'chat' : 'inbox';
  if (first === 'settings') return 'settings';
  if (first === 'i') return second === 'flow' && /login|signup/.test(third) ? 'login' : 'other';
  if (first === 'login' || first === 'logout' || first === 'signup') return 'login';
  if (!handleOf(url)) return 'other';
  if (second === 'status' && /^\d+$/.test(third)) return 'post';
  if (LIST_TABS.has(second)) return second === 'following' ? 'following' : 'followers';
  return PROFILE_TABS.has(second) ? 'profile' : 'other';
}

export function profileOf(url: URL): FollowAccount | null {
  const handle = handleOf(url);
  if (!handle) return null;
  const second = (partsOf(url)[1] ?? '').toLowerCase();
  if (!PROFILE_TABS.has(second) && !LIST_TABS.has(second)) return null;
  return { username: handle, url: `${ORIGIN}/${handle}` };
}

export function postOf(url: URL): string | null {
  const [first = '', second = '', third = ''] = partsOf(url);
  if (!handleOf(url) || second.toLowerCase() !== 'status' || !/^\d{1,30}$/.test(third)) return null;
  return `${ORIGIN}/${first}/status/${third}`;
}

export function postAuthorOf(url: URL): FollowAccount | null {
  return postOf(url) ? { username: handleOf(url)!, url: `${ORIGIN}/${handleOf(url)}` } : null;
}

/** X's own words on its pages, as the outline keeps them. */
const WORDS = new Set(
  [
    'X',
    'Home',
    'Explore',
    'Notifications',
    'Messages',
    'Grok',
    'Lists',
    'Bookmarks',
    'Communities',
    'Premium',
    'Verified Orgs',
    'Profile',
    'More',
    'Post',
    'Posts',
    'Reply',
    'Replies',
    'Repost',
    'Reposts',
    'Quote',
    'Like',
    'Liked',
    'Likes',
    'Bookmark',
    'Share',
    'Share post',
    'View',
    'Views',
    'Follow',
    'Following',
    'Followers',
    'Follows you',
    'Follow back',
    'Unfollow',
    'Pending',
    'Edit profile',
    'Search',
    'Top',
    'Latest',
    'People',
    'Media',
    'Highlights',
    'Articles',
    'All',
    'Verified',
    'Mentions',
    'Who to follow',
    'Show more',
    'Show replies',
    'Show more replies',
    'Show probable spam',
    'Show',
    'Replying to',
    'Post your reply',
    'Post text',
    'Cancel',
    'Close',
    'Back',
    'Done',
    'Discard',
    'Save',
    'Log in',
    'Sign in',
    'Sign up',
    'Log out',
    'Settings',
    'Settings and privacy',
    'Help Center',
    'Terms of Service',
    'Privacy Policy',
    'Cookie Policy',
    'Accessibility',
    'Ads info',
    'Trending',
    'What’s happening',
    "What's happening",
    'For you',
    'Subscribe',
    'Translate post',
    'Promoted',
    'Ad',
    'reposted',
    'Pinned',
    'Joined',
    'Something went wrong. Try reloading.',
    'Retry',
    'Everyone can reply',
    'Add photos or video',
    'Add a GIF',
    'Add poll',
    'Emoji',
    'Schedule post',
    'Tag location',
  ].map((w) => w.toLowerCase()),
);

/** X's own words in its addresses. */
const PATH_WORDS = new Set([
  'home',
  'explore',
  'search',
  'notifications',
  'mentions',
  'verified',
  'messages',
  'i',
  'flow',
  'login',
  'settings',
  'status',
  'photo',
  'video',
  'analytics',
  'quotes',
  'retweets',
  'likes',
  'with_replies',
  'media',
  'highlights',
  'articles',
  'followers',
  'verified_followers',
  'following',
  'followers_you_follow',
  'compose',
  'post',
  'lists',
  'bookmarks',
  'communities',
]);

/** X's warnings, as its pages word them: a limit, a lock, a check that it's them. */
const WARNINGS: readonly RegExp[] = [
  /\byou are over the daily limit\b/i,
  /\brate limit exceeded\b/i,
  /\byou can['’]t follow more (people|accounts) (at this time|right now)\b/i,
  /\byour account (is|has been) (temporarily )?(locked|restricted|suspended|limited)\b/i,
  /\bthis request looks like it might be automated\b/i,
  /\bunusual activity\b/i,
  /\bwe['’]ve temporarily limited some of your account features\b/i,
  /\bverify (it['’]s you|your identity|your phone)\b/i,
  /\bprove you['’]re (not a robot|human)\b/i,
];

const byTestId = (root: ParentNode, id: string): HTMLElement | null =>
  root.querySelector<HTMLElement>(`[data-testid="${id}"]`);

/** The page's main column, where posts and a profile are: never its side's suggestions. */
const columnOf = (doc: Document): Element => byTestId(doc, 'primaryColumn') ?? mainOf(doc);

/** A row's button, as it says whether the person follows them (`<id>-follow`, `<id>-unfollow`). */
function standingIn(part: Element): Standing | null {
  const unfollow = part.querySelector('[data-testid$="-unfollow"]');
  if (unfollow) return /pending/i.test(clean(unfollow.textContent)) ? 'requested' : 'following';
  return part.querySelector('[data-testid$="-follow"]') ? 'no' : null;
}

export const X_SPEC: FollowSpec = {
  platform: 'x',
  name: 'X',
  hosts: [
    'https://x.com/*',
    'https://twitter.com/*',
    'https://mobile.x.com/*',
    'https://mobile.twitter.com/*',
  ],
  host: HOST,
  url: xUrl,
  kindOf,
  profileOf,
  postOf,
  postAuthorOf,
  pathWords: PATH_WORDS,
  words: WORDS,
  warnings: WARNINGS,
  warnedAt: (url) =>
    /^\/account\/access/i.test(url.pathname)
      ? 'X is asking you to confirm it’s you before you go on.'
      : null,
  pages: {
    home: `${ORIGIN}/home`,
    search: (words) => `${ORIGIN}/search?q=${encodeURIComponent(words)}&src=typed_query&f=live`,
    notifications: `${ORIGIN}/notifications/mentions`,
    followers: (own) => `${ORIGIN}/${own.username}/followers`,
  },
  ownLink: (doc, href) => {
    const link = byTestId(doc, 'AppTabBar_Profile_Link');
    const url = link ? xUrl(link.getAttribute('href') ?? '', href) : null;
    const own = url ? profileOf(url) : null;
    return own?.url ?? null;
  },
  rootOf: (timeLink) => timeLink.closest('article[data-testid="tweet"], article'),
  nameIn: (root, author) => {
    const block = byTestId(root, 'User-Name');
    const name = clean(block?.querySelector('a[href] span')?.textContent);
    return name && !name.startsWith('@') && name.toLowerCase() !== author.username.toLowerCase()
      ? name
      : null;
  },
  textIn: (root) => {
    const words = byTestId(root, 'tweetText');
    if (!words) return '';
    // Its emoji are pictures with their own words.
    const copy = words.cloneNode(true) as Element;
    for (const img of copy.querySelectorAll('img[alt]'))
      img.replaceWith(copy.ownerDocument.createTextNode(img.getAttribute('alt') ?? ''));
    return (copy.textContent ?? '').replace(/[ \t]+/g, ' ').trim();
  },
  likeIn: (root) => {
    const unlike = byTestId(root, 'unlike');
    if (unlike && visible(unlike)) return { control: unlike, liked: true };
    const like = byTestId(root, 'like');
    return like && visible(like) ? { control: like, liked: false } : null;
  },
  replyIn: (root) => byTestId(root, 'reply'),
  repliesIn: (root) => {
    const reply = byTestId(root, 'reply');
    return reply ? countOf(reply.getAttribute('aria-label') ?? reply.textContent) : null;
  },
  replyingToIn: (root) => {
    // "Replying to @them and @you": the handles it links to beside the words, in the smallest part that says so.
    const parts = [...root.querySelectorAll('div')].filter(
      (part) => /^replying to\b/i.test(clean(part.textContent)) && part.querySelector('a[href]'),
    );
    const part = parts.sort(
      (a, b) => (a.textContent ?? '').length - (b.textContent ?? '').length,
    )[0];
    if (!part) return [];
    return [...part.querySelectorAll('a[href]')].flatMap((a) => {
      const url = xUrl(a.getAttribute('href') ?? '', ORIGIN);
      const handle = url ? profileOf(url)?.username : null;
      return handle ? [handle] : [];
    });
  },
  headerOf: (doc) => {
    const name = byTestId(columnOf(doc), 'UserName');
    if (!name) return null;
    // The header holds the name, the bio, the counts and Follow: the part around the name that holds the counts too.
    for (let up = name.parentElement, n = 0; up && n < 8; up = up.parentElement, n++)
      if (
        up.querySelector(
          'a[href$="/followers"], a[href$="/verified_followers"], a[href$="/following"]',
        )
      )
        return up.querySelector(
          '[data-testid$="-follow"], [data-testid$="-unfollow"], [data-testid="editProfileButton"]',
        )
          ? up
          : (up.parentElement ?? up);
    return name.parentElement;
  },
  profileIn: (header, account) => {
    const nameBlock = byTestId(header, 'UserName');
    const name = clean(nameBlock?.querySelector('span')?.textContent) || null;
    const followers = header.querySelector('a[href$="/verified_followers"], a[href$="/followers"]');
    const website = byTestId(header, 'UserUrl');
    return {
      name:
        name && name.toLowerCase() !== account.username.toLowerCase() && !name.startsWith('@')
          ? name
          : null,
      bio: clean(byTestId(header, 'UserDescription')?.textContent) || null,
      links: website ? [`Link: ${clean(website.textContent)}`] : [],
      followers: followers ? countOf(followers.textContent) : null,
      followsYou: byTestId(header, 'userFollowIndicator')
        ? true
        : header.querySelector('[data-testid$="-follow"], [data-testid$="-unfollow"]')
          ? false
          : null,
    };
  },
  followIn: (header) => {
    const unfollow = header.querySelector<HTMLElement>('[data-testid$="-unfollow"]');
    const follow = unfollow ? null : header.querySelector<HTMLElement>('[data-testid$="-follow"]');
    return {
      follow: follow && visible(follow) ? follow : null,
      following: unfollow && visible(unfollow) ? unfollow : null,
      requested: !!unfollow && /pending/i.test(clean(unfollow.textContent)),
    };
  },
  unfollowIn: (doc) => {
    const sure = byTestId(doc, 'confirmationSheetConfirm');
    if (sure && visible(sure)) return sure;
    const box = doc.querySelector('[role="alertdialog"], [role="dialog"]');
    return box ? (controlsSaying(box, /^unfollow\b/i)[0] ?? null) : null;
  },
  listIn: (doc) => (columnOf(doc).querySelector('[data-testid="UserCell"]') ? columnOf(doc) : null),
  rowStanding: (row) => standingIn(row.closest('[data-testid="UserCell"]') ?? row),
  replyBoxes: (doc) => {
    const boxes = [...doc.querySelectorAll<HTMLElement>('[data-testid="tweetTextarea_0"]')].filter(
      (b) => visible(b),
    );
    // Its box is drawn to write in inside the part with its test id: the one that takes the typing.
    const typed = boxes.map(
      (b) => b.querySelector<HTMLElement>('[contenteditable="true"], [role="textbox"]') ?? b,
    );
    return typed.length ? typed : boxesSaying(columnOf(doc), /^(post your reply|post text)$/i);
  },
  sendFor: (box) => {
    for (let up = box.parentElement, n = 0; up && n < 14; up = up.parentElement, n++) {
      const send =
        up.querySelector<HTMLElement>('[data-testid="tweetButtonInline"]') ??
        up.querySelector<HTMLElement>('[data-testid="tweetButton"]');
      if (send) return send;
    }
    return null;
  },
  answersMe: (root, me) =>
    X_SPEC.replyingToIn(root).some((handle) => handle.toLowerCase() === me.toLowerCase()),
};
