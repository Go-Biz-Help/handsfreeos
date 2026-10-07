/**
 * Lists of people: friends, followers, a group's members, search results. Each person is found by the link to their
 * profile, the one thing every one of those pages has, and then read from the box around that link.
 */
import {
  clean,
  collectLinked,
  elementsIn,
  inTopBar,
  isBefore,
  isHeading,
  namesOn,
  textLines,
} from './dom';
import type { Person, ProfileRef } from './types';
import { facebookUrl, profileFromUrl, profileKey } from './urls';
import {
  BADGE,
  isFacebookText,
  RUNS_GROUP,
  sectionTitleOf,
  UI_WORDS,
  withoutCount,
} from './vocabulary';

/** Whether text could be someone's name, rather than a count, a time or one of Facebook's buttons. */
export function isNameLike(text: string): boolean {
  return (
    text.length > 0 &&
    text.length <= 80 &&
    !isFacebookText(text) &&
    !/^\d/.test(text) &&
    !/mutual friends?|^see all|^facebook$/i.test(text)
  );
}

export function bestName(names: readonly string[]): string | null {
  return names.find(isNameLike) ?? null;
}

/** Whether two names are the same, however they're spaced or capitalized. */
export const sameName = (a: string, b: string) => clean(a).toLowerCase() === clean(b).toLowerCase();

/** Someone a part of the page links to: their profile, their name, and whether a link to them shows it in words. */
export interface LinkedPerson {
  readonly profile: ProfileRef;
  readonly name: string | null;
  /** A link to them shows their name in words, not only a picture, as the faces of mutual friends are. */
  readonly inWords: boolean;
}

/** The people some links lead to, each once with every link to them, in page order. The top bar's are never. */
export function peopleLinked(anchors: Iterable<Element>, base: string): LinkedPerson[] {
  const found = new Map<string, { profile: ProfileRef; anchors: Element[] }>();
  for (const anchor of anchors) {
    if (inTopBar(anchor)) continue;
    const url = facebookUrl(anchor.getAttribute('href') ?? '', base);
    const profile = url ? profileFromUrl(url) : null;
    if (!profile) continue;
    const entry = found.get(profileKey(profile));
    if (entry) entry.anchors.push(anchor);
    else found.set(profileKey(profile), { profile, anchors: [anchor] });
  }
  return [...found.values()].map(({ profile, anchors }) => ({
    profile,
    name: bestName(namesOn(anchors)),
    inWords: anchors.some((anchor) => textLines(anchor, 1).some(isNameLike)),
  }));
}

/**
 * The one person a card is about, of the people it links to: the only one; the same person linked twice, by number
 * and by name; or the one it names in words, where the rest are only pictures: the faces of mutual friends that
 * Facebook puts on a friend request, or on someone you may know.
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
 * The title an element starts, when it's the title of a part of the list: a heading, or a lone piece of text, saying
 * "Admins and moderators", "Members", "New to the group"… Tabs and buttons with the same words are not titles, and
 * neither is a badge on someone ("Admin", "Top contributor") unless it's a heading. Any other heading starts a part
 * too, titled as Facebook titles it ("Members near you · 4" is "Members near you"), so the people under it never
 * count as the part before: the page's own title and a heading with a link in it, as a name has, don't.
 */
export function sectionStart(element: Element): string | null {
  const heading = isHeading(element);
  if (!heading && element.childElementCount > 0) return null;
  if (element.closest('a, [role="tab"], [role="button"], button')) return null;
  const text = clean(element.textContent);
  if (!text || text.length > 60 || (!heading && BADGE.test(text))) return null;
  const known = sectionTitleOf(text);
  if (known || !heading || element.tagName === 'H1' || element.querySelector('a[href]'))
    return known;
  return withoutCount(text) || null;
}

/** The labels a box puts on someone: every piece of text in it that is exactly a badge ("Admin"). */
export function badgesIn(card: Element): string[] {
  const badges = new Set<string>();
  for (const element of elementsIn(card)) {
    const text = clean(element.textContent);
    if (text.length <= 40 && BADGE.test(text)) badges.add(text);
  }
  return [...badges];
}

export interface PeopleOptions {
  /** Each person carries the title of the part of the list they're in. */
  readonly sections?: boolean;
  /** Only people linked after this element: a group's list starts below its tabs, not in the row of faces above. */
  readonly after?: Element | null;
}

/**
 * The people a part of the page lists, in page order, each once. With `sections`, each person carries the title of
 * the part of the list they're in, which is how a group's admins and moderators are told apart from its members.
 */
export function readPeople(root: Element, base: string, options: PeopleOptions = {}): Person[] {
  const { after } = options;
  const linked = collectLinked(
    root,
    base,
    (url) => {
      const profile = profileFromUrl(url);
      return profile ? { key: profileKey(profile), value: profile } : null;
    },
    {
      skip: (anchor) => inTopBar(anchor) || (after != null && isBefore(anchor, after)),
      sectionOf: options.sections ? sectionStart : undefined,
    },
  );
  const people: Person[] = [];
  for (const entry of linked) {
    const name = bestName(namesOn(entry.anchors));
    if (!name) continue;
    people.push({
      name,
      profile: entry.value,
      details: detailsIn(entry.card, name),
      badges: badgesIn(entry.card),
      section: entry.section,
      request: null,
    });
  }
  return people;
}

/**
 * The lines in a box that say something about the person, as Facebook shows them under the name: "Entrepreneur ·
 * 2,761 people follow this", "Joined 7 minutes ago". Not their name, a badge or a button; three at most. What comes
 * before the name is about the list, not them: the only person in a part of the list has its title in their box.
 * With `buttons`, what's written on buttons counts too, all but Facebook's own words ("Confirm"): the mutual friends
 * on a friend request ("16 mutual friends") are a button.
 */
export function detailsIn(card: Element, name: string, buttons = false): string[] {
  const lines = textLines(card, 12, buttons ? undefined : '[role="button"], button');
  return lines
    .slice(lines.findIndex((line) => line.startsWith(name)) + 1)
    .filter(
      (line) =>
        !line.startsWith(name) &&
        !BADGE.test(line) &&
        !UI_WORDS.has(line.toLowerCase()) &&
        line.length <= 120,
    )
    .slice(0, 3);
}

/** Whether someone runs the group they were listed in: an admin or a moderator, by a badge or by their part of the list. */
export function runsGroup(person: Person): boolean {
  return (
    person.badges.some((badge) => RUNS_GROUP.test(badge)) ||
    (person.section !== null && RUNS_GROUP.test(person.section))
  );
}

/**
 * People in the main column, or in the list Facebook puts beside it, whichever has more: the friends list on
 * /friends/list is beside it. Parts of the list ("Friend requests", "People you may know") are kept.
 */
export function readPeopleAnywhere(doc: Document, main: Element, base: string): Person[] {
  const places = [main, ...doc.querySelectorAll('[role="navigation"]')].filter(
    (place) => !inTopBar(place),
  );
  let best: Person[] = [];
  for (const place of places) {
    const people = readPeople(place, base, { sections: true });
    if (people.length > best.length) best = people;
  }
  return best;
}
