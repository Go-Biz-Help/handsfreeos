/**
 * Your invitations to connect, on My Network's Manage invitations: the ones you've got
 * (/mynetwork/invitation-manager/received/), each with Accept and Ignore, and the ones you've sent (…/sent/), each
 * with Withdraw and when you sent it ("Sent 3 weeks ago"). A row is found by its buttons, as Facebook's friend
 * requests are (../facebook/friends.ts), and is about the one member it names in words: the faces of mutual
 * connections beside them don't count. Invitations to follow a page, go to an event or read a newsletter sit in the
 * same list with the same buttons; they link to the page, event or newsletter, and are left out.
 */
import { elementsIn } from '../facebook/dom';
import { CONTROLS, inTopBar, wordsOf } from './dom';
import { aboutWhom, controlWords, peopleLinked, rowLines, type LinkedPerson } from './people';
import type { Direction, Invitation } from './types';
import { linkedinUrl, pathParts, profileKey } from './urls';
import { ACCEPT, IGNORE, WITHDRAW } from './vocabulary';

/** How far up from an invitation's button the row it's on can be. */
const ROW_STEPS = 16;

/** The places an invitation that isn't to connect links to: a page, a school, an event, a newsletter, a group. */
const NOT_A_MEMBER = new Set(['company', 'showcase', 'school', 'events', 'newsletters', 'groups']);
/** And what such a row says: "Avery Lane invited you to follow Lane Landscaping". */
const NOT_TO_CONNECT = /\b(invited|inviting) you to (follow|attend|join|subscribe)\b/i;

/** What says which way a row's invitation went: its Accept, or its Withdraw. */
interface Mark {
  readonly element: Element;
  readonly direction: Direction;
}

function marksIn(root: Element): Mark[] {
  const marks: Mark[] = [];
  for (const element of elementsIn(root)) {
    if (!element.matches(CONTROLS) || inTopBar(element)) continue;
    const words = wordsOf(element);
    if (words.some((word) => ACCEPT.test(word))) marks.push({ element, direction: 'received' });
    else if (words.some((word) => WITHDRAW.test(word))) marks.push({ element, direction: 'sent' });
  }
  return marks;
}

/**
 * The row a mark is on: the nearest box around it that links to anyone, about the one member it names in words. A
 * box with another invitation's button in it is the list, not a row.
 */
function rowOf(
  mark: Mark,
  marks: readonly Mark[],
  root: Element,
  base: string,
): { readonly box: Element; readonly person: LinkedPerson } | null {
  let box = mark.element.parentElement;
  for (let steps = 0; box && steps < ROW_STEPS; steps++) {
    const here = box;
    if (marks.some((other) => other !== mark && here.contains(other.element))) return null;
    const people = peopleLinked(here.querySelectorAll('a[href]'), base);
    if (people.length) {
      const person = aboutWhom(people);
      return person?.inWords && person.name ? { box: here, person } : null;
    }
    if (here === root) break;
    box = here.parentElement;
  }
  return null;
}

/** Whether a row is an invitation to something other than connecting: it links to a page, an event, a newsletter. */
function notToConnect(box: Element, base: string): boolean {
  if (NOT_TO_CONNECT.test(box.textContent ?? '')) return true;
  return [...box.querySelectorAll('a[href]')].some((anchor) => {
    const url = linkedinUrl(anchor.getAttribute('href') ?? '', base);
    return url !== null && NOT_A_MEMBER.has(pathParts(url)[0]?.toLowerCase() ?? '');
  });
}

/** The invitations to connect a part of the page lists, in page order, each member once. */
export function readInvitations(root: Element, base: string): Invitation[] {
  const marks = marksIn(root);
  const invitations: Invitation[] = [];
  const seen = new Set<string>();
  for (const mark of marks) {
    const row = rowOf(mark, marks, root, base);
    if (!row || notToConnect(row.box, base)) continue;
    const words = controlWords(row.box);
    // One you got has both its buttons.
    if (mark.direction === 'received' && !words.some((word) => IGNORE.test(word))) continue;
    const key = profileKey(row.person.profile);
    if (seen.has(key)) continue;
    seen.add(key);
    const name = row.person.name!;
    const lines = rowLines(row.box, name);
    invitations.push({
      name,
      profile: row.person.profile,
      headline: lines.headline,
      location: lines.location,
      degree: lines.degree,
      mutualConnections: lines.mutualConnections,
      details: lines.details,
      connection: mark.direction === 'received' ? 'received' : 'pending',
      direction: mark.direction,
      when: lines.when,
    });
  }
  return invitations;
}
