/**
 * Lists of members: your connections (/mynetwork/invite-connect/connections/) and people search
 * (/search/results/people/). Each person is found by the link to their profile, the one thing every row has, and read
 * from the box around that link (`collectLinked`): their headline and place, how far they are, mutual connections,
 * and where you stand by the row's buttons. A search result LinkedIn hides ("LinkedIn Member") links to no profile,
 * so it isn't read.
 */
import { sameName } from '../facebook/people';
import { collectLinked, CONTROLS, inTopBar, namesOn, shownLines, wordsOf } from './dom';
import type { Connection, Degree, Person, ProfileRef } from './types';
import { linkedinUrl, profileFromUrl, profileKey } from './urls';
import {
  ACCEPT,
  CONNECT,
  CONNECTED,
  degreeIn,
  degreeOnly,
  isLinkedInText,
  isSentWhen,
  isWhen,
  mutualCount,
  OWN_PROFILE,
  PENDING,
  PRONOUNS,
  REMOVE_CONNECTION,
  SUMMARY,
  UI_WORDS,
  WITHDRAW,
} from './vocabulary';

/** Whether text could be someone's name, rather than a count, a time, one of LinkedIn's words or a hidden member. */
export function isNameLike(text: string): boolean {
  return (
    text.length > 0 &&
    text.length <= 80 &&
    !isLinkedInText(text) &&
    !/^\d/.test(text) &&
    !/^linkedin member$/i.test(text) &&
    !/mutual connections?|^see all|^view /i.test(text)
  );
}

export function bestName(names: readonly string[]): string | null {
  return names.find(isNameLike) ?? null;
}

/** Someone a part of the page links to: their profile, their name, and whether a link to them shows it in words. */
export interface LinkedPerson {
  readonly profile: ProfileRef;
  readonly name: string | null;
  /** A link to them shows their name in words, not only a picture. */
  readonly inWords: boolean;
}

/**
 * The people some links lead to, each once with every link to them, in page order. The top bar's are never: `inBar`
 * tells which those are (a window over the page asks for the narrower `inPageBar`, as its own header may be a header).
 */
export function peopleLinked(
  anchors: Iterable<Element>,
  base: string,
  inBar: (element: Element) => boolean = inTopBar,
): LinkedPerson[] {
  const found = new Map<string, { profile: ProfileRef; anchors: Element[] }>();
  for (const anchor of anchors) {
    if (inBar(anchor)) continue;
    const url = linkedinUrl(anchor.getAttribute('href') ?? '', base);
    const profile = url ? profileFromUrl(url) : null;
    if (!profile) continue;
    const entry = found.get(profileKey(profile));
    if (entry) entry.anchors.push(anchor);
    else found.set(profileKey(profile), { profile, anchors: [anchor] });
  }
  return [...found.values()].map(({ profile, anchors: links }) => ({
    profile,
    name: bestName(namesOn(links)),
    inWords: links.some((anchor) => shownLines(anchor, { max: 1 }).some(isNameLike)),
  }));
}

/**
 * The one person a box is about, of the people it links to: the only one, or the one it names in words where the
 * rest are only pictures (the faces of mutual connections).
 */
export function aboutWhom(people: readonly LinkedPerson[]): LinkedPerson | null {
  const first = people[0];
  if (!first) return null;
  const one = people.every(
    (person) =>
      person === first || (person.name && first.name && sameName(person.name, first.name)),
  );
  if (one) return first;
  const inWords = people.filter((person) => person.inWords);
  return inWords.length === 1 ? inWords[0]! : null;
}

/**
 * Where you stand with someone, by the buttons on their profile or row and how far they are, strongest first: your
 * own profile's buttons; their invitation (Accept); yours, waiting (Pending, Withdraw); connected (1st, or Remove
 * connection under More); not connected (Connect, or 2nd and 3rd with neither).
 */
export function connectionOf(labels: readonly string[], degree: Degree | null): Connection {
  const has = (pattern: RegExp) => labels.some((label) => pattern.test(label));
  if (has(OWN_PROFILE)) return 'self';
  if (has(ACCEPT)) return 'received';
  if (has(PENDING) || has(WITHDRAW)) return 'pending';
  if (degree === '1st' || has(REMOVE_CONNECTION)) return 'connected';
  if (has(CONNECT) || degree === '2nd' || degree === '3rd') return 'not_connected';
  return 'unknown';
}

/** What a row says about someone, besides their name and buttons. */
export interface RowLines {
  readonly headline: string | null;
  readonly location: string | null;
  readonly degree: Degree | null;
  readonly mutualConnections: number | null;
  readonly details: readonly string[];
  /** A time on the row: "Sent 3 weeks ago" on an invitation you sent, "Yesterday" on one you got. */
  readonly when: string | null;
}

/** The most lines kept under a name, and the longest: LinkedIn's headlines run to 220 characters. */
const DETAILS_MOST = 5;
const LINE_LONGEST = 240;

/**
 * The lines in a row under someone's name, as LinkedIn shows them, sorted out: how far they are ("• 2nd"), mutual
 * connections, a time, LinkedIn's own lines ("Current: …", "Connected on …"), and the rest in order: their headline,
 * then where they are. What comes before the name is about the list, not them.
 */
export function rowLines(card: Element, name: string): RowLines {
  const lines = shownLines(card, { max: 20, exclude: CONTROLS });
  const at = lines.findIndex((line) => line.startsWith(name));
  let degree: Degree | null = at >= 0 ? degreeIn(lines[at]!.slice(name.length)) : null;
  let mutualConnections: number | null = null;
  let when: string | null = null;
  const plain: string[] = [];
  const details: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.startsWith(name) || line.length > LINE_LONGEST || PRONOUNS.test(line)) continue;
    const far = degreeOnly(line);
    if (far) {
      degree ??= far;
      continue;
    }
    if (UI_WORDS.has(line.toLowerCase())) continue;
    const mutual = mutualCount(line);
    if (mutual !== null) mutualConnections ??= mutual;
    else if (isSentWhen(line) || isWhen(line)) when ??= line;
    else if (!SUMMARY.test(line) && !CONNECTED.test(line) && !isLinkedInText(line))
      plain.push(line);
    details.push(line);
  }
  return {
    headline: plain[0] ?? null,
    location: plain[1] ?? null,
    degree,
    mutualConnections,
    details: details.slice(0, DETAILS_MOST),
    when,
  };
}

/** The words of every button in a box, and the labels LinkedIn gives them for screen readers. */
export function controlWords(card: Element): string[] {
  return [...card.querySelectorAll(CONTROLS)].flatMap(wordsOf);
}

export interface PeopleOptions {
  /** Links to leave out besides the top bar's: the authors of posts on a page of search results. */
  readonly skip?: (anchor: Element) => boolean;
}

/** The people a part of the page lists, in page order, each once. */
export function readPeople(root: Element, base: string, options: PeopleOptions = {}): Person[] {
  const linked = collectLinked(
    root,
    base,
    (url) => {
      const profile = profileFromUrl(url);
      return profile ? { key: profileKey(profile), value: profile } : null;
    },
    (anchor) => inTopBar(anchor) || (options.skip?.(anchor) ?? false),
  );
  const people: Person[] = [];
  for (const entry of linked) {
    const name = bestName(namesOn(entry.anchors));
    if (!name) continue;
    const { when: _when, ...lines } = rowLines(entry.card, name);
    people.push({
      name,
      profile: entry.value,
      ...lines,
      connection: connectionOf(controlWords(entry.card), lines.degree),
    });
  }
  return people;
}
