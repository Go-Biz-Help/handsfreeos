/**
 * LinkedIn's addresses: which kind of page a URL is, and which member, chat, post, group or company a link points
 * to. LinkedIn, like Facebook, changes its page code often and its addresses hardly ever, so everything that can be
 * decided from a link is decided here, and the readers only look for links. What comes out fits core's LinkedIn kit
 * (`NETWORKS.linkedin`): a member's id, the name in their address and a chat's id each have its shape, and every link
 * is https://www.linkedin.com/… without LinkedIn's tracking.
 */
import type { CompanyRef, Direction, GroupRef, PageAddress, ProfileRef, ThreadRef } from './types';

export const LINKEDIN = 'https://www.linkedin.com';

const HOSTS = new Set(['linkedin.com', 'www.linkedin.com']);

/** The name in a member's address, as the kit takes it: letters, numbers, hyphens, and percent-escapes for the rest. */
const USERNAME = /^[A-Za-z0-9%_-]{1,100}$/;
/** LinkedIn's id for a member, as its links carry it: "ACoAA…" (and "ACwAA…" from Sales Navigator). */
const MEMBER_ID = /^AC[ow]AA[A-Za-z0-9_-]{6,59}$/;
/** A conversation's id in /messaging/thread/<this>/. */
const THREAD_KEY = /^[A-Za-z0-9._=+-]{1,128}$/;
/** A post's id in LinkedIn's names for it: urn:li:activity:<number>, and the share and ugcPost it was made as. */
const POST_URN = /^urn:li:(activity|share|ugcPost):(\d{6,25})$/;
/** A post's own address on its public page: /posts/<name>_<words>-activity-<number>-<letters>/. */
const POST_SLUG = /-(activity|share|ugcPost)-(\d{6,25})(?:-|$)/;
const NUMBER = /^\d{1,20}$/;

/** A link on a LinkedIn page as a URL, or null when it leads anywhere else. Relative links read against `base`. */
export function linkedinUrl(href: string, base: string = LINKEDIN): URL | null {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return HOSTS.has(url.hostname.toLowerCase()) ? url : null;
}

/**
 * An address the extension's own tab may open on LinkedIn, made whole, or null: https on www.linkedin.com, with
 * nothing else in the host (no name, password or port), so a bad link kept or read never takes the tab elsewhere.
 */
export function workUrl(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  return url.hostname.toLowerCase() === 'www.linkedin.com' ? url.href : null;
}

/** The path's parts as the address writes them: a member's name keeps its percent-escapes, as the kit takes it. */
export function pathParts(url: URL): string[] {
  return url.pathname.split('/').filter(Boolean);
}

function decoded(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** A name from an address, its percent-escapes in capitals so one name is written one way. */
function usernameOf(part: string): string | null {
  const name = part.replace(/%[0-9a-f]{2}/gi, (escape) => escape.toUpperCase());
  return USERNAME.test(name) && name.toLowerCase() !== 'me' ? name : null;
}

/** A member's id inside one of LinkedIn's names for them: urn:li:fsd_profile:ACoAA…, urn:li:fs_miniProfile:ACoAA…. */
function memberIdIn(value: string | null): string | null {
  const id = value ? decoded(value).trim().split(':').pop() : null;
  return id && MEMBER_ID.test(id) ? id : null;
}

/**
 * The member a link names by id in its query, as LinkedIn's links carry them: a search result's miniProfileUrn, a
 * message's profileUrn or recipient, the mutual connections' connectionOf=["ACoAA…"].
 */
export function memberIdFrom(url: URL): string | null {
  for (const key of ['miniProfileUrn', 'profileUrn', 'recipient']) {
    const id = memberIdIn(url.searchParams.get(key));
    if (id) return id;
  }
  for (const key of ['connectionOf', 'facetConnectionOf']) {
    const ids = /["']?([A-Za-z0-9_-]+)["']?/.exec(decoded(url.searchParams.get(key) ?? ''));
    const id = memberIdIn(ids?.[1] ?? null);
    if (id) return id;
  }
  return null;
}

function profileRef(username: string | null, id: string | null): ProfileRef | null {
  if (username) return { id, username, url: `${LINKEDIN}/in/${username}/` };
  return id ? { id, username: null, url: `${LINKEDIN}/in/${id}/` } : null;
}

/** One key per member, whichever way its link was written: by the name in its address, else by id. */
export function profileKey(profile: ProfileRef): string {
  return profile.username ? `user:${profile.username.toLowerCase()}` : `id:${profile.id ?? ''}`;
}

/** Whether two links can be told apart at all: both have the name in their address, or both LinkedIn's id. */
export const comparable = (a: ProfileRef, b: ProfileRef): boolean =>
  (!!a.username && !!b.username) || (!!a.id && !!b.id);

/**
 * Whether two links are to the same member: by the name in their addresses when both have one, else by LinkedIn's
 * id when both have it. A name alone, as people write it, is never enough.
 */
export function sameMember(a: ProfileRef, b: ProfileRef): boolean {
  if (!comparable(a, b)) return false;
  if (a.username && b.username) return a.username.toLowerCase() === b.username.toLowerCase();
  return !!a.id && !!b.id && a.id === b.id;
}

/**
 * The member whose profile an address is, or a part of: /in/<name>/, /in/<name>/details/experience/,
 * /in/<name>/overlay/contact-info/, or /in/ACoAA…/ where a link has only the id. Your own /in/me/ names nobody.
 */
export function profilePageOf(url: URL): ProfileRef | null {
  const [first, second] = pathParts(url);
  if (first?.toLowerCase() !== 'in' || !second) return null;
  const part = decoded(second);
  if (MEMBER_ID.test(part)) return profileRef(null, part);
  return profileRef(usernameOf(second), memberIdFrom(url));
}

/**
 * The member a link points to: their whole profile, /in/<name>/ or /in/ACoAA…/, with their id when the link carries
 * it. A part of a profile (/in/<name>/overlay/…) isn't the person, as on Facebook: the name on a profile links to one.
 */
export function profileFromUrl(url: URL): ProfileRef | null {
  return pathParts(url).length === 2 ? profilePageOf(url) : null;
}

/** The chat a link points to: /messaging/thread/<id>/. */
export function threadFromUrl(url: URL): ThreadRef | null {
  const [first, second, third] = pathParts(url);
  if (first !== 'messaging' || second !== 'thread' || !third) return null;
  const id = decoded(third);
  if (id === 'new' || !THREAD_KEY.test(id)) return null;
  return { id, encrypted: false, url: `${LINKEDIN}/messaging/thread/${id}/` };
}

/** A post's own link from one of LinkedIn's names for it ("urn:li:activity:7251…"), or null for anything else. */
export function postFromUrn(urn: string | null): string | null {
  const match = urn ? POST_URN.exec(decoded(urn).trim()) : null;
  return match ? `${LINKEDIN}/feed/update/urn:li:${match[1]}:${match[2]}/` : null;
}

/**
 * A post's own link, without LinkedIn's tracking, or null when the link isn't to a post: /feed/update/urn:li:activity:
 * <number>/, and the public /posts/<name>_<words>-activity-<number>-…/, written as the first. A link to a comment
 * (…?commentUrn=…) is to its post.
 */
export function postUrlFrom(url: URL): string | null {
  const [first, second, third] = pathParts(url);
  if (first === 'feed' && second === 'update' && third) return postFromUrn(third);
  if (first === 'posts' && second) {
    const match = POST_SLUG.exec(decoded(second));
    return match ? `${LINKEDIN}/feed/update/urn:li:${match[1]}:${match[2]}/` : null;
  }
  return null;
}

/** The group a link points to: /groups/<number>/. */
export function groupFromUrl(url: URL): GroupRef | null {
  const [first, second] = pathParts(url);
  if (first !== 'groups' || !second || !NUMBER.test(second)) return null;
  return { id: second, url: `${LINKEDIN}/groups/${second}/` };
}

/** The company a link points to: /company/<name or number>/, and any of its tabs. */
export function companyFromUrl(url: URL): CompanyRef | null {
  const [first, second] = pathParts(url);
  if (first !== 'company' || !second) return null;
  const id = usernameOf(second);
  return id ? { id, url: `${LINKEDIN}/company/${id}/` } : null;
}

/** A link read from a page, for the readers and the tests: what each of the above makes of it, or null. */
const fromLink =
  <T>(read: (url: URL) => T | null) =>
  (href: string, base: string = LINKEDIN): T | null => {
    const url = linkedinUrl(href, base);
    return url ? read(url) : null;
  };

export const profileRefOf = fromLink(profileFromUrl);
export const threadOf = fromLink(threadFromUrl);
export const postOf = fromLink(postUrlFrom);

/** Which kind of page an address is, and whose. Never throws: anything it doesn't know is `other`. */
export function classifyUrl(href: string): PageAddress {
  const none = { profile: null, thread: null, group: null, post: null, invitations: null };
  const url = linkedinUrl(href);
  if (!url) return { kind: 'other', ...none };
  const [first = '', second = '', third = ''] = pathParts(url).map((part) => part.toLowerCase());

  if (first === '' || (first === 'feed' && second === '')) return { kind: 'feed', ...none };
  if ((first === 'feed' && second === 'update') || first === 'posts') {
    const post = postUrlFrom(url);
    return post ? { kind: 'post', ...none, post } : { kind: 'other', ...none };
  }
  if (first === 'in' && second) {
    if (second === 'me') return { kind: 'own-profile', ...none };
    const profile = profilePageOf(url);
    if (!profile) return { kind: 'other', ...none };
    return { kind: third === 'recent-activity' ? 'activity' : 'profile', ...none, profile };
  }
  if (first === 'mynetwork') {
    if (second === 'invite-connect' && third === 'connections')
      return { kind: 'connections', ...none };
    if (second === 'invitation-manager') {
      const invitations: Direction = third === 'sent' ? 'sent' : 'received';
      return { kind: 'invitations', ...none, invitations };
    }
    return { kind: 'other', ...none };
  }
  if (first === 'search' && second === 'results') {
    if (third === 'people') return { kind: 'search-people', ...none };
    if (third === 'content') return { kind: 'search-posts', ...none };
    if (third === 'all') return { kind: 'search', ...none };
    return { kind: 'other', ...none };
  }
  if (first === 'messaging') {
    const thread = threadFromUrl(url);
    return { kind: thread ? 'chat' : 'messaging', ...none, thread };
  }
  if (first === 'notifications') return { kind: 'notifications', ...none };
  // A company's page and its tabs: its About is where it says the most about itself.
  if (first === 'company' && companyFromUrl(url)) return { kind: 'company', ...none };
  if (first === 'groups') {
    // A group's own page shows its posts; its members and settings are other pages.
    const group = groupFromUrl(url);
    return group && !third ? { kind: 'group', ...none, group } : { kind: 'other', ...none };
  }
  return { kind: 'other', ...none };
}
