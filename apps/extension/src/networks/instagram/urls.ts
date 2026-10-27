/**
 * Instagram's addresses (./site.ts), as they've long been: instagram.com/<name>/ for an account (its followers and
 * following under it), /p/<code>/ and /reel/<code>/ for a post (newer links put the account's name first),
 * /p/<code>/liked_by/ for a post's Likes box over it (decision 92), /explore/tags/<tag>/ for a hashtag,
 * /explore/locations/<id>/<name>/ for a place, /explore/search/keyword/?q= for a search, /explore/people/ for the
 * accounts it suggests, /direct/inbox/, /direct/requests/ and /direct/t/<id>/ for messages, and /accounts/edit/ for the
 * person's own profile's form. Shared by the site, its readers (./read.ts) and the noting of the person's own steps
 * (./actions.ts). From the owner's Check of 21 Oct 2026: a hashtag's page sends the tab to a search for it
 * (/explore/search/keyword/?q=%23<tag>), and /explore/locations/ alone is no list of places.
 */

export const HOST = 'www.instagram.com';
const HOSTS = new Set(['www.instagram.com', 'instagram.com']);

/** First parts of its addresses that are Instagram's own places, never an account's name. */
const NOT_NAMES = new Set([
  'about',
  'accounts',
  'api',
  'challenge',
  'developer',
  'direct',
  'emails',
  'explore',
  'graphql',
  'legal',
  'lite',
  'locations',
  'login',
  'logout',
  'meta-verified',
  'nametag',
  'notifications',
  'oauth',
  'p',
  'press',
  'privacy',
  'reel',
  'reels',
  'session',
  'static',
  'stories',
  'terms',
  'threads',
  'topics',
  'tv',
  'web',
  'your_activity',
]);
/** An account's name: letters, numbers, dots and underscores, 30 at most. */
const NAME = /^[A-Za-z0-9._]{1,30}$/;
/** The tabs under an account: its own page still. */
const ACCOUNT_TABS = new Set(['', 'reels', 'tagged', 'saved', 'guides', 'igtv', 'featured']);

export const partsOf = (url: URL) => url.pathname.split('/').filter(Boolean);

/** A link on its pages as a whole address on its host, or null when it leads anywhere else. */
export function instagramUrl(href: string, base?: string): URL | null {
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

/** What kind of page an address is. */
export function kindOf(url: URL): string {
  const [first = '', second = '', third = ''] = partsOf(url).map((p) => p.toLowerCase());
  if (!first) return 'feed';
  if (first === 'explore') {
    if (second === 'tags') return 'tag';
    if (second === 'search') return 'search';
    // A place by its id. /explore/locations/ alone is no list of places now: Instagram draws an account named
    // "explore" there (the owner's Check, 21 Oct 2026).
    if (second === 'locations' && /^\d+$/.test(third)) return 'place';
    return second === 'people' ? 'suggested' : 'explore';
  }
  // A post's Likes box (decision 92): Instagram puts /p/<code>/liked_by/ in the address while it's open over the post.
  if ((first === 'p' || first === 'reel') && third === 'liked_by') return 'likers';
  if (first === 'p' || first === 'reel' || first === 'tv') return 'post';
  // A reel opens in the reels player, at /reels/<code>/: its own page still.
  if (first === 'reels') return second ? 'post' : 'reels';
  if (first === 'direct') return second === 't' ? 'chat' : 'inbox';
  if (first === 'accounts')
    return second === 'edit'
      ? 'edit-profile'
      : second === 'activity'
        ? 'notifications'
        : 'settings';
  // Its notifications on a page of their own (Check Instagram opens it from 0.79.0).
  if (first === 'notifications') return 'notifications';
  if (first === 'stories') return 'story';
  if (first === 'challenge') return 'check';
  if (NOT_NAMES.has(first) || !NAME.test(first)) return 'other';
  if ((second === 'p' || second === 'reel') && partsOf(url)[3]?.toLowerCase() === 'liked_by')
    return 'likers';
  if (second === 'p' || second === 'reel') return 'post';
  if (second === 'followers' || second === 'following') return second;
  return 'profile';
}

/** The account a link points to: its name in the address, and its own address; null for any other link. */
export function profileOf(url: URL): { username: string; url: string } | null {
  const [first = '', second = ''] = partsOf(url);
  if (!first || NOT_NAMES.has(first.toLowerCase()) || !NAME.test(first)) return null;
  if (!ACCOUNT_TABS.has(second.toLowerCase())) return null;
  return { username: first, url: `https://${HOST}/${first}/` };
}

/** The account whose page an address is, under any of its tabs or lists (its followers too); null for any other. */
export function accountOf(url: URL): { username: string; url: string } | null {
  const [first = ''] = partsOf(url);
  if (!first || NOT_NAMES.has(first.toLowerCase()) || !NAME.test(first)) return null;
  return { username: first, url: `https://${HOST}/${first}/` };
}

/** The post a link points to, as one address however it was written; null for any other link. */
export function postOf(url: URL): string | null {
  const parts = partsOf(url);
  // /p/<code>/, /reel/<code>/, and newer links with the account's name first: /<name>/p/<code>/.
  const at =
    parts[0] === 'p' || parts[0] === 'reel' || parts[0] === 'reels' || parts[0] === 'tv'
      ? 0
      : parts[1] === 'p' || parts[1] === 'reel'
        ? 1
        : -1;
  const code = at >= 0 ? parts[at + 1] : undefined;
  if (!code || !/^[A-Za-z0-9_-]{5,64}$/.test(code)) return null;
  return `https://${HOST}/${parts[at] === 'reel' || parts[at] === 'reels' ? 'reel' : 'p'}/${code}/`;
}

/** The account a post's own link names (/<name>/p/<code>/), when it does: never a comment's (/p/<code>/c/<id>/). */
export function postAuthorOf(url: URL): string | null {
  const parts = partsOf(url);
  return (parts[1] === 'p' || parts[1] === 'reel') &&
    parts.length === 3 &&
    postOf(url) &&
    !NOT_NAMES.has((parts[0] ?? '').toLowerCase()) &&
    NAME.test(parts[0] ?? '')
    ? parts[0]!
    : null;
}

/** Whether a link is a comment's own (/p/<code>/c/<id>/): its time links to it. */
export function isCommentLink(url: URL): boolean {
  const parts = partsOf(url);
  const at = parts[0] === 'p' || parts[0] === 'reel' ? 0 : parts[1] === 'p' ? 1 : -1;
  return at >= 0 && parts[at + 2] === 'c' && /^[0-9]{1,40}$/.test(parts[at + 3] ?? '');
}

/** A chat's id in its address (/direct/t/<id>/), or null. */
export function threadOf(url: URL): string | null {
  const [first, second, id] = partsOf(url);
  return first === 'direct' && second === 't' && id && /^[0-9]{1,64}$/.test(id) ? id : null;
}
