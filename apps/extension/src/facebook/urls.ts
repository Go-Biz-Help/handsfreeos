/**
 * Facebook's addresses: which kind of page a URL is, and which person, group, chat or post a link points to.
 * Facebook changes its page code often and its addresses hardly ever, so everything that can be decided from a link
 * is decided here, and the readers only look for links.
 */
import type { GroupRef, PageAddress, PageKind, ProfileRef, ThreadRef } from './types';

export const FACEBOOK = 'https://www.facebook.com';

const HOSTS = new Set(['facebook.com', 'www.facebook.com', 'web.facebook.com', 'm.facebook.com']);

/** First path parts that are Facebook's own places, never somebody's username. */
const NOT_USERNAMES = new Set([
  'about',
  'ads',
  'adsmanager',
  'ajax',
  'api',
  'appcenter',
  'apps',
  'bookmarks',
  'business',
  'careers',
  'checkpoint',
  'comment',
  'commerce',
  'composer',
  'creatorstudio',
  'dialog',
  'directory',
  'donate',
  'events',
  'facebook',
  'feeds',
  'find-friends',
  'friends',
  'friendship',
  'fundraisers',
  'games',
  'gaming',
  'groups',
  'hashtag',
  'help',
  'home.php',
  'index.php',
  'instantgames',
  'jobs',
  'l.php',
  'latest',
  'legal',
  'lists',
  'live',
  'login',
  'login.php',
  'logout.php',
  'marketplace',
  'me',
  'media',
  'memories',
  'messages',
  'notes',
  'notifications',
  'offers',
  'onthisday',
  'pages',
  'payments',
  'people',
  'permalink.php',
  'photo',
  'photo.php',
  'photos',
  'places',
  'plugins',
  'pokes',
  'policies',
  'privacy',
  'profile.php',
  'recover',
  'reel',
  'reels',
  'reg',
  'rsrc.php',
  'saved',
  'search',
  'settings',
  'share',
  'share.php',
  'sharer',
  'sharer.php',
  'shops',
  'stories',
  'story.php',
  'subscriptions',
  'terms',
  'video',
  'videos',
  'watch',
  'weather',
]);

/** The parts of /groups/… that are Facebook's own pages about groups, not a group. */
const NOT_GROUPS = new Set([
  'categories',
  'create',
  'discover',
  'explore',
  'feed',
  'joins',
  'notifications',
  'search',
  'your_groups',
]);

/** The words in Facebook's addresses after the first part: /groups/<g>/members, /<user>/friends_mutual. */
const SUBPAGES = new Set([
  'about',
  'buy_sell_discussion',
  'discussion',
  'e2ee',
  'events',
  'featured',
  'files',
  'followers',
  'following',
  'friends',
  'friends_all',
  'friends_mutual',
  'friends_recent',
  'list',
  'media',
  'members',
  'new',
  'people',
  'permalink',
  'photos',
  'posts',
  'reels',
  'requests',
  'suggestions',
  't',
  'top',
  'user',
  'videos',
]);

/** Whether a part of an address is one of Facebook's own words rather than a name or a number. */
export function isFacebookPathWord(part: string): boolean {
  const lower = part.toLowerCase();
  return NOT_USERNAMES.has(lower) || NOT_GROUPS.has(lower) || SUBPAGES.has(lower);
}

/** Letters, numbers and dots: what a Facebook username may hold. */
const USERNAME = /^[a-z0-9.]{2,50}$/i;
const NUMBER = /^\d{1,20}$/;

/** A link on a Facebook page as a URL, or null when it leads anywhere else. Relative links read against `base`. */
export function facebookUrl(href: string, base: string = FACEBOOK): URL | null {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return HOSTS.has(url.hostname.toLowerCase()) ? url : null;
}

/** The path's parts, decoded. */
export function pathParts(url: URL): string[] {
  return url.pathname
    .split('/')
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
}

const byId = (id: string): ProfileRef => ({
  id,
  username: null,
  url: `${FACEBOOK}/profile.php?id=${id}`,
});
const byUsername = (username: string): ProfileRef => ({
  id: null,
  username,
  url: `${FACEBOOK}/${username}`,
});

/** One key per profile, whichever way its link was written. */
export function profileKey(profile: ProfileRef): string {
  return profile.id ? `id:${profile.id}` : `user:${(profile.username ?? '').toLowerCase()}`;
}

/**
 * The person a link points to: /profile.php?id=…, /people/<name>/<id>/, a group's /groups/<g>/user/<id>/, the
 * friends pages' /friends/…?profile_id=…, or /<username>. A part of a profile (/<username>/photos) isn't the person,
 * and neither is one of Facebook's own pages.
 */
export function profileFromUrl(url: URL): ProfileRef | null {
  const [first, second, third, fourth] = pathParts(url);
  if (!first) return null;
  const lower = first.toLowerCase();
  if (lower === 'profile.php') {
    const id = url.searchParams.get('id');
    return id && NUMBER.test(id) ? byId(id) : null;
  }
  if (lower === 'friends') {
    const id = url.searchParams.get('profile_id');
    return id && NUMBER.test(id) ? byId(id) : null;
  }
  if (lower === 'people' && third && NUMBER.test(third)) return byId(third);
  if (lower === 'groups' && third === 'user' && fourth && NUMBER.test(fourth)) return byId(fourth);
  if (NOT_USERNAMES.has(lower) || second !== undefined) return null;
  if (NUMBER.test(first)) return byId(first);
  return USERNAME.test(first) ? byUsername(first) : null;
}

/** The group a link points to: /groups/<number or name>/…, but not Facebook's own group pages. */
export function groupFromUrl(url: URL): GroupRef | null {
  const [first, second] = pathParts(url);
  if (first?.toLowerCase() !== 'groups' || !second || NOT_GROUPS.has(second.toLowerCase()))
    return null;
  return { id: second, url: `${FACEBOOK}/groups/${encodeURIComponent(second)}/` };
}

/** The chat a link points to: /messages/t/<id>/, or /messages/e2ee/t/<id>/ for an end-to-end encrypted one. */
export function threadFromUrl(url: URL): ThreadRef | null {
  const [first, second, third, fourth] = pathParts(url);
  if (first !== 'messages') return null;
  if (second === 't' && third)
    return { id: third, encrypted: false, url: `${FACEBOOK}/messages/t/${third}/` };
  if (second === 'e2ee' && third === 't' && fourth)
    return { id: fourth, encrypted: true, url: `${FACEBOOK}/messages/e2ee/t/${fourth}/` };
  return null;
}

/** A post's own link, without the tracking Facebook adds, or null when the link isn't to a post. */
export function postUrlFrom(url: URL): string | null {
  const [first, second, third, fourth] = pathParts(url);
  if (!first) return null;
  const lower = first.toLowerCase();
  if (lower === 'groups' && second && (third === 'posts' || third === 'permalink') && fourth)
    return `${FACEBOOK}/groups/${second}/posts/${fourth}/`;
  if (lower === 'permalink.php' || lower === 'story.php') {
    const story = url.searchParams.get('story_fbid');
    if (!story) return null;
    const owner = url.searchParams.get('id');
    return `${FACEBOOK}/${lower}?story_fbid=${encodeURIComponent(story)}${owner ? `&id=${encodeURIComponent(owner)}` : ''}`;
  }
  if (second === 'posts' && third && !NOT_USERNAMES.has(lower))
    return `${FACEBOOK}/${first}/posts/${third}`;
  return null;
}

/** A profile's tab, from /<username>/friends or …?sk=followers. Any other tab (about, photos) is still the profile. */
function tabKind(tab: string): PageKind {
  const t = tab.toLowerCase();
  if (t.startsWith('friends')) return 'friends';
  if (t === 'followers') return 'followers';
  if (t === 'following') return 'following';
  return 'profile';
}

/** Which kind of page an address is, and whose. Never throws: anything it doesn't know is `other`. */
export function classifyUrl(href: string): PageAddress {
  const none = { profile: null, group: null, thread: null };
  const url = facebookUrl(href);
  if (!url) return { kind: 'other', ...none };
  const [first = '', second, third, fourth] = pathParts(url);
  const lower = first.toLowerCase();

  if (lower === '' || lower === 'home.php') return { kind: 'feed', ...none };
  if (lower === 'messages') {
    const thread = threadFromUrl(url);
    return { kind: thread ? 'chat' : 'chats', ...none, thread };
  }
  if (lower === 'groups') {
    if (!second || NOT_GROUPS.has(second.toLowerCase()))
      return { kind: second?.toLowerCase() === 'search' ? 'search' : 'groups', ...none };
    const group = groupFromUrl(url);
    if (third === 'members' || third === 'people') return { kind: 'group-members', ...none, group };
    if (third === 'user' && fourth)
      return { kind: 'profile', ...none, group, profile: profileFromUrl(url) };
    if ((third === 'posts' || third === 'permalink') && fourth)
      return { kind: 'post', ...none, group };
    return { kind: 'group', ...none, group };
  }
  if (lower === 'search') return { kind: 'search', ...none };
  if (lower === 'friends') return { kind: 'friends', ...none };
  if (lower === 'notifications') return { kind: 'notifications', ...none };
  if (lower === 'permalink.php' || lower === 'story.php') return { kind: 'post', ...none };
  if (lower === 'profile.php')
    return {
      kind: tabKind(url.searchParams.get('sk') ?? ''),
      ...none,
      profile: profileFromUrl(url),
    };
  // Your own: /me, /me/friends.
  if (lower === 'me') return { kind: tabKind(second ?? ''), ...none };
  if (lower === 'people' && third)
    return { kind: 'profile', ...none, profile: profileFromUrl(url) };
  if (NOT_USERNAMES.has(lower)) return { kind: 'other', ...none };

  const profile = profileFromUrl(new URL(`${FACEBOOK}/${encodeURIComponent(first)}`));
  if (!profile) return { kind: 'other', ...none };
  if (second === 'posts' && third) return { kind: 'post', ...none, profile };
  return { kind: tabKind(second ?? ''), ...none, profile };
}
