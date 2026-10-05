/**
 * Lists of people: friends, followers, a group's members, search results. Each person is found by the link to their
 * profile, the one thing every one of those pages has, and then read from the box around that link.
 */
import { clean, collectLinked, elementsIn, inTopBar, isHeading, namesOn, textLines } from './dom';
import type { Person } from './types';
import { profileFromUrl, profileKey } from './urls';
import { BADGE, isFacebookText, RUNS_GROUP, sectionTitleOf, UI_WORDS } from './vocabulary';

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

/**
 * The title an element starts, when it's the title of a part of the list: a heading, or a lone piece of text, saying
 * "Admins and moderators", "Members", "New to the group"… Tabs and buttons with the same words are not titles, and
 * neither is a badge on someone ("Admin", "Top contributor") unless it's a heading.
 */
export function sectionStart(element: Element): string | null {
  const heading = isHeading(element);
  if (!heading && element.childElementCount > 0) return null;
  if (element.closest('a, [role="tab"], [role="button"], button')) return null;
  const text = clean(element.textContent);
  if (text.length > 60 || (!heading && BADGE.test(text))) return null;
  return sectionTitleOf(text);
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

/**
 * The people a part of the page lists, in page order, each once. With `sections`, each person carries the title of
 * the part of the list they're in, which is how a group's admins and moderators are told apart from its members.
 */
export function readPeople(
  root: Element,
  base: string,
  options: { sections?: boolean } = {},
): Person[] {
  const linked = collectLinked(
    root,
    base,
    (url) => {
      const profile = profileFromUrl(url);
      return profile ? { key: profileKey(profile), value: profile } : null;
    },
    { skip: inTopBar, sectionOf: options.sections ? sectionStart : undefined },
  );
  const people: Person[] = [];
  for (const entry of linked) {
    const name = bestName(namesOn(entry.anchors));
    if (!name) continue;
    people.push({
      name,
      profile: entry.value,
      detail: detailIn(entry.card, name),
      badges: badgesIn(entry.card),
      section: entry.section,
    });
  }
  return people;
}

/** The first line in a box that says something about the person: not their name, a badge or a button. */
export function detailIn(card: Element, name: string): string | null {
  return (
    textLines(card, 12).find(
      (line) =>
        !line.startsWith(name) &&
        !BADGE.test(line) &&
        !UI_WORDS.has(line.toLowerCase()) &&
        line.length <= 120,
    ) ?? null
  );
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
