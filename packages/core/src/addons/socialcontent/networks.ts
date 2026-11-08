/**
 * The networks AI Social Media Content Creator studies (HANDSFREEOS_CONTENT_CREATOR_IMPLEMENTATION_PLAN.md, decision
 * 2): Instagram, Facebook and LinkedIn first, then TikTok and YouTube. Each has its name, whether a business can pick
 * it yet, the words its search uses, and how a link to someone's page there reads. Its own copy, never Social
 * Outreach's: add-ons never share code or data.
 *
 * Browser-safe and pure: the web, the phone, the extension and the worker read it.
 */

export const CONTENT_NETWORKS = ['instagram', 'facebook', 'linkedin', 'tiktok', 'youtube'] as const;
export type ContentNetwork = (typeof CONTENT_NETWORKS)[number];

export interface ContentNetworkInfo {
  readonly name: string;
  /**
   * Whether a business can pick it yet. Only these are searched and read; the rest show as coming. The extension also
   * says which it reads (`socialcontent.work.next`), so an older build is never handed one it can't.
   */
  readonly ready: boolean;
  /** What its search is made of, as the AI writes it ("hashtags and account names"). */
  readonly searchWords: string;
}

export const CONTENT_NETWORK_INFO: Readonly<Record<ContentNetwork, ContentNetworkInfo>> = {
  instagram: { name: 'Instagram', ready: true, searchWords: 'hashtags and account names' },
  facebook: { name: 'Facebook', ready: false, searchWords: 'search words for pages and creators' },
  linkedin: { name: 'LinkedIn', ready: false, searchWords: 'search words for people and posts' },
  tiktok: { name: 'TikTok', ready: false, searchWords: 'hashtags and search words' },
  youtube: { name: 'YouTube', ready: false, searchWords: 'search words for channels' },
};

export const READY_NETWORKS: readonly ContentNetwork[] = CONTENT_NETWORKS.filter(
  (n) => CONTENT_NETWORK_INFO[n].ready,
);

export const isContentNetwork = (v: unknown): v is ContentNetwork =>
  typeof v === 'string' && (CONTENT_NETWORKS as readonly string[]).includes(v);

export const networkName = (n: ContentNetwork): string => CONTENT_NETWORK_INFO[n].name;

/** A creator's page, from a link to it: the network, their name there, and the link written the one way. */
export interface CreatorLink {
  readonly network: ContentNetwork;
  readonly handle: string;
  readonly link: string;
}

/** Instagram's own pages, never someone's: a post, a reel, its search. */
const INSTAGRAM_NOT_PEOPLE = new Set([
  'p',
  'reel',
  'reels',
  'explore',
  'stories',
  'accounts',
  'direct',
  'tv',
  'about',
  'legal',
  'developer',
]);
const FACEBOOK_NOT_PEOPLE = new Set([
  'groups',
  'events',
  'watch',
  'marketplace',
  'gaming',
  'share',
  'sharer',
  'sharer.php',
  'login',
  'login.php',
  'help',
  'policies',
  'hashtag',
  'search',
  'stories',
  'reel',
  'photo',
  'photo.php',
  'permalink.php',
  'story.php',
  'messages',
  'notifications',
  'friends',
  'bookmarks',
  'settings',
  'pages',
]);

const USERNAME = /^[A-Za-z0-9._]{1,30}$/;
const FACEBOOK_NAME = /^[A-Za-z0-9.-]{1,80}$/;
const SLUG = /^[A-Za-z0-9_%-]{1,100}$/;

/**
 * Reads a link to someone's page on one of the networks: instagram.com/name, facebook.com/name or
 * profile.php?id=…, linkedin.com/in/name or /company/name, tiktok.com/@name, youtube.com/@name or /channel/….
 * A bare "@name" counts when the network is given. Null when it isn't a page of a person or a business.
 */
export function creatorFromLink(raw: string, network?: ContentNetwork): CreatorLink | null {
  const text = raw.trim();
  if (!text) return null;
  if (text.startsWith('@') && network) {
    const name = text.slice(1);
    if (network === 'instagram' && USERNAME.test(name))
      return creatorOn('instagram', name.toLowerCase());
    if (network === 'tiktok' && USERNAME.test(name)) return creatorOn('tiktok', name.toLowerCase());
    if (network === 'youtube' && /^[A-Za-z0-9._-]{3,30}$/.test(name))
      return creatorOn('youtube', `@${name.toLowerCase()}`);
    return null;
  }
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.|mobile\.|web\.)/, '');
  const parts = url.pathname.split('/').filter(Boolean);
  const first = parts[0] ?? '';
  if (host === 'instagram.com') {
    if (!first || INSTAGRAM_NOT_PEOPLE.has(first.toLowerCase()) || !USERNAME.test(first))
      return null;
    return creatorOn('instagram', first.toLowerCase());
  }
  if (host === 'facebook.com' || host === 'fb.com') {
    if (first.toLowerCase() === 'profile.php') {
      const id = url.searchParams.get('id') ?? '';
      return /^\d{5,20}$/.test(id) ? creatorOn('facebook', `id:${id}`) : null;
    }
    if (!first || FACEBOOK_NOT_PEOPLE.has(first.toLowerCase()) || !FACEBOOK_NAME.test(first))
      return null;
    return creatorOn('facebook', first.toLowerCase());
  }
  if (host === 'linkedin.com') {
    const where = first.toLowerCase();
    const slug = parts[1] ?? '';
    if ((where === 'in' || where === 'company') && SLUG.test(slug))
      return creatorOn('linkedin', `${where}/${decodeURIComponent(slug).toLowerCase()}`);
    return null;
  }
  if (host === 'tiktok.com') {
    if (!first.startsWith('@')) return null;
    const name = first.slice(1);
    return USERNAME.test(name) ? creatorOn('tiktok', name.toLowerCase()) : null;
  }
  if (host === 'youtube.com') {
    if (first.startsWith('@') && /^@[A-Za-z0-9._-]{3,30}$/.test(first))
      return creatorOn('youtube', first.toLowerCase());
    if (first === 'channel' && /^UC[A-Za-z0-9_-]{10,40}$/.test(parts[1] ?? ''))
      return creatorOn('youtube', `channel/${parts[1]}`);
    if ((first === 'c' || first === 'user') && SLUG.test(parts[1] ?? ''))
      return creatorOn('youtube', `${first}/${(parts[1] ?? '').toLowerCase()}`);
    return null;
  }
  return null;
}

/** A creator's page on a network, from their name there. */
export function creatorOn(network: ContentNetwork, handle: string): CreatorLink {
  return { network, handle, link: creatorLink(network, handle) };
}

/** The link to a creator's page, from their name on the network. */
export function creatorLink(network: ContentNetwork, handle: string): string {
  switch (network) {
    case 'instagram':
      return `https://www.instagram.com/${handle}/`;
    case 'facebook':
      return handle.startsWith('id:')
        ? `https://www.facebook.com/profile.php?id=${handle.slice(3)}`
        : `https://www.facebook.com/${handle}`;
    case 'linkedin':
      return `https://www.linkedin.com/${handle}/`;
    case 'tiktok':
      return `https://www.tiktok.com/@${handle}`;
    case 'youtube':
      return `https://www.youtube.com/${handle}`;
  }
}

/** How a creator is shown: "@name" where the network has usernames, else their name there. */
export function handleShown(network: ContentNetwork, handle: string): string {
  if (network === 'instagram' || network === 'tiktok') return `@${handle}`;
  if (network === 'youtube')
    return handle.startsWith('@') ? handle : (handle.split('/')[1] ?? handle);
  if (network === 'linkedin') return handle.split('/')[1] ?? handle;
  return handle.startsWith('id:') ? 'Facebook profile' : handle;
}
