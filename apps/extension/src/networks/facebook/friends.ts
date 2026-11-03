/**
 * Your own friends pages (docs/outreach.md, decisions 10 to 13): which of your lists a page shows, your friends or
 * your friend requests; where each request on it stands; and how many mutual friends a line says. Facebook shows them
 * at /friends/list and /friends/requests (where View sent requests shows the ones you've sent), on your own profile's
 * Friends tab, and as a "Friend requests" part of /friends. Someone else's Friends tab is their list, not yours.
 */
import { clean, elementsIn, inTopBar, labelOf } from './dom';
import { aboutWhom, detailsIn, peopleLinked, readPeople } from './people';
import type { Person, ProfileRef, RequestRow } from './types';
import { classifyUrl, facebookUrl, pathParts, profileFromUrl, profileKey } from './urls';
import { parseCount } from './vocabulary';

/** Your lists the extension can save: your friends, the friend requests you've got, and the ones you've sent. */
export type FriendList = 'friends' | 'requests' | 'sent';

/** Which of your lists a page is, by its address: your friends, or your friend requests, either way. */
export type ListPage = Exclude<FriendList, 'sent'>;

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
export function friendListOf(doc: Document, href: string): ListPage | null {
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

/** Whether the page is your own friend requests, where View sent requests opens the ones you've sent. */
export function requestsPage(href: string): boolean {
  const url = facebookUrl(href);
  const [first = '', second = ''] = url ? pathParts(url).map((part) => part.toLowerCase()) : [];
  return first === 'friends' && second === 'requests';
}

/** Whether your list is beside the page, as on /friends/requests and /friends/list, rather than on it. */
export function listBeside(href: string): boolean {
  const url = facebookUrl(href);
  const [first = '', second = ''] = url ? pathParts(url).map((part) => part.toLowerCase()) : [];
  return first === 'friends' && (second === 'requests' || second === 'list');
}

/**
 * Your list on /friends/requests and /friends/list: the one beside the page, the longest of them, or null when there
 * is none. The page itself shows the profile of whoever's picked, whose links aren't yours. A list of requests is the
 * people its rows are about: the faces of mutual friends on a row are links to them too, but they aren't in it.
 * While a list is open over the page, as View sent requests opens yours, that one: Facebook hides the page behind it.
 */
export function readListBeside(
  doc: Document,
  base: string,
  list: ListPage | null,
): Person[] | null {
  for (const dialog of doc.querySelectorAll('[role="dialog"]')) {
    if (!shown(dialog)) continue;
    const people = readPeople(dialog, base, { sections: true });
    if (people.length) return withRequests(people, dialog, base, list === 'requests');
  }
  let best: { readonly place: Element; readonly people: Person[] } | null = null;
  for (const place of doc.querySelectorAll('[role="navigation"]')) {
    if (inTopBar(place)) continue;
    const people = readPeople(place, base, { sections: true });
    if (people.length > (best?.people.length ?? 0)) best = { place, people };
  }
  return best && withRequests(best.people, best.place, base, list === 'requests');
}

/**
 * Whether someone in a list asked to be friends and hasn't had an answer: their row has Confirm and Delete, on the
 * requests page or in the "Friend requests" part of /friends.
 */
export function asked(person: Person, list: ListPage | null): boolean {
  return (
    person.request === 'received' &&
    (list === 'requests' || (person.section !== null && REQUESTS_PART.test(person.section)))
  );
}

/** Whether someone in a list is a request you've sent: their row on the requests page has Cancel request. */
export function askedByYou(person: Person, list: ListPage | null): boolean {
  return person.request === 'sent' && list === 'requests';
}

// ------------------------------------------------------------------------------------------- request rows

/** The buttons of a request someone sent you: "Confirm" ("Confirm Jane Doe", "Confirm request"), and "Delete". */
export const CONFIRM = /^(?:confirm(?: friend)?(?: request)?|accept(?: request)?)(?:\s+(.+))?$/i;
export const DELETE =
  /^(?:delete(?: friend)?(?: request)?|remove request|decline(?: request)?)(?:\s+(.+))?$/i;
/** The button of a request you've sent: "Cancel request", or "Cancel request Jane Doe" where a list has many. */
export const CANCEL = /^cancel(?: friend)? request(?:\s+(.+))?$/i;
/** What a request's row says in place of its buttons once it's answered: "Request accepted", "Request removed". */
const ANSWERED = /^request (?:accepted|removed|deleted|declined|canceled|cancelled)$/i;

/** How far up from a request's button, or the words of its answer, the row it's on can be. */
const ROW_STEPS = 16;

/** Whether the person can see something: Facebook keeps a hidden copy of each request's buttons beside the ones shown. */
export const shown = (element: Element) => element.closest('[aria-hidden="true"]') === null;

/** The buttons in a box the person can see. */
export const shownControls = (box: Element) =>
  [...box.querySelectorAll('[role="button"], button')].filter(shown);

/** What says where a row's request stands: its Confirm, its Cancel request, or the words of its answer. */
interface Mark {
  readonly element: Element;
  readonly row: RequestRow;
}

function marksIn(root: Element): Mark[] {
  const marks: Mark[] = [];
  for (const element of elementsIn(root)) {
    let row: RequestRow | null = null;
    if (element.matches('[role="button"], button')) {
      const label = labelOf(element);
      row = CONFIRM.test(label) ? 'received' : CANCEL.test(label) ? 'sent' : null;
    } else if (element.childElementCount === 0 && ANSWERED.test(clean(element.textContent)))
      row = 'answered';
    if (row && shown(element) && !inTopBar(element)) marks.push({ element, row });
  }
  return marks;
}

/** One request's row: where it stands, the box it is, and who it's about. */
export interface Row {
  readonly row: RequestRow;
  readonly box: Element;
  readonly profile: ProfileRef;
}

/**
 * The row a mark is on: the nearest box around it that links to anyone, about the one person it names in words (the
 * faces of mutual friends beside them don't count). A box with another request's mark in it is the list, not a row.
 */
function rowOf(mark: Mark, marks: readonly Mark[], root: Element, base: string): Row | null {
  let box = mark.element.parentElement;
  for (let steps = 0; box && steps < ROW_STEPS; steps++) {
    const here = box;
    if (marks.some((other) => other !== mark && here.contains(other.element))) return null;
    const people = peopleLinked(here.querySelectorAll('a[href]'), base);
    if (people.length) {
      const person = aboutWhom(people);
      return person?.inWords ? { row: mark.row, box: here, profile: person.profile } : null;
    }
    if (here === root) break;
    box = here.parentElement;
  }
  return null;
}

/**
 * The friend requests a part of the page shows, by who each is with: a row with Confirm and Delete is one they sent
 * you, a row with Cancel request one you've sent them, and a row that says "Request accepted" (or removed) one
 * answered already, which Facebook keeps on the page until it's loaded again.
 */
export function requestRows(root: Element, base: string): Map<string, Row> {
  const marks = marksIn(root);
  const rows = new Map<string, Row>();
  for (const mark of marks) {
    const row = rowOf(mark, marks, root, base);
    if (!row) continue;
    if (row.row === 'received' && !shownControls(row.box).some((c) => DELETE.test(labelOf(c))))
      continue;
    const key = profileKey(row.profile);
    const had = rows.get(key);
    // An answer is the latest news about them.
    if (!had || (row.row === 'answered' && had.row !== 'answered')) rows.set(key, row);
  }
  return rows;
}

/**
 * The people in a list, each with where their friend request stands when a row there is about one, and what that row
 * says about them, the words on its buttons among them ("2w", "16 mutual friends"). In a list of requests, only the
 * people its rows are about.
 */
export function withRequests(
  people: readonly Person[],
  root: Element,
  base: string,
  onlyRows: boolean,
): Person[] {
  const rows = requestRows(root, base);
  return people.flatMap((person) => {
    const row = person.profile ? rows.get(profileKey(person.profile)) : undefined;
    if (!row) return onlyRows ? [] : [person];
    return [{ ...person, request: row.row, details: detailsIn(row.box, person.name, true) }];
  });
}

/** How many mutual friends some lines say there are: "12 mutual friends". Null when none says. */
export function mutualFriendsIn(lines: readonly string[]): number | null {
  for (const line of lines) {
    const match = MUTUAL.exec(clean(line));
    if (match?.[1]) return parseCount(match[1]);
  }
  return null;
}
