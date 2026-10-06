/**
 * Your own friends pages (docs/outreach.md, decisions 10 to 13): which of your lists a page shows, your friends or
 * the friend requests you've got, and how many mutual friends a line says. Facebook shows them at /friends/list and
 * /friends/requests, on your own profile's Friends tab, and as a "Friend requests" part of /friends. Someone else's
 * Friends tab is their list, not yours.
 */
import { clean, inTopBar, labelOf } from './dom';
import { readPeople } from './people';
import type { Person, ProfileRef } from './types';
import { classifyUrl, facebookUrl, pathParts, profileFromUrl, profileKey } from './urls';
import { parseCount } from './vocabulary';

/** Your lists the extension can save: your friends, and the friend requests you've got. */
export type FriendList = 'friends' | 'requests';

const YOUR_PROFILE = /^your profile$/i;
/** "12 mutual friends", "1.2K friends · 45 mutual". */
const MUTUAL = /([\d.,]+\s*[km]?)\s+mutual\b/i;
/** The part of /friends that lists the requests you've got. */
const REQUESTS_PART = /^friend requests$/i;

/** Your own profile: the one the top bar's "Your profile" links to. */
export function yourProfile(doc: Document, base: string): ProfileRef | null {
  for (const anchor of doc.querySelectorAll('[role="banner"] a[href]')) {
    if (!YOUR_PROFILE.test(labelOf(anchor))) continue;
    const url = facebookUrl(anchor.getAttribute('href') ?? '', base);
    const profile = url ? profileFromUrl(url) : null;
    if (profile) return profile;
  }
  return null;
}

/** Which of your lists a page shows, or null for any other page: someone else's friends, or /friends with its parts. */
export function friendListOf(doc: Document, href: string): FriendList | null {
  const url = facebookUrl(href);
  if (!url) return null;
  const [first = '', second = ''] = pathParts(url).map((part) => part.toLowerCase());
  if (first === 'friends')
    return second === 'requests' ? 'requests' : second === 'list' ? 'friends' : null;
  const address = classifyUrl(href);
  if (address.kind !== 'friends') return null;
  if (first === 'me') return 'friends';
  const you = yourProfile(doc, href);
  return address.profile && you && profileKey(address.profile) === profileKey(you)
    ? 'friends'
    : null;
}

/** Whether your list is beside the page, as on /friends/requests and /friends/list, rather than on it. */
export function listBeside(href: string): boolean {
  const url = facebookUrl(href);
  const [first = '', second = ''] = url ? pathParts(url).map((part) => part.toLowerCase()) : [];
  return first === 'friends' && (second === 'requests' || second === 'list');
}

/**
 * Your list on /friends/requests and /friends/list: the one beside the page, the longest of them. The page itself
 * shows the profile of whoever's picked, whose links aren't yours.
 */
export function readListBeside(doc: Document, base: string): Person[] {
  let best: Person[] = [];
  for (const place of doc.querySelectorAll('[role="navigation"]')) {
    if (inTopBar(place)) continue;
    const people = readPeople(place, base, { sections: true });
    if (people.length > best.length) best = people;
  }
  return best;
}

/** Whether someone in a list asked to be friends: everyone on the requests page, and the "Friend requests" part. */
export function asked(person: Person, list: FriendList | null): boolean {
  return list === 'requests' || (person.section !== null && REQUESTS_PART.test(person.section));
}

/** How many mutual friends some lines say there are: "12 mutual friends". Null when none says. */
export function mutualFriendsIn(lines: readonly string[]): number | null {
  for (const line of lines) {
    const match = MUTUAL.exec(clean(line));
    if (match?.[1]) return parseCount(match[1]);
  }
  return null;
}
