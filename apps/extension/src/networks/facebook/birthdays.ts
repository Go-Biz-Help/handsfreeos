/**
 * Facebook's Birthdays page (facebook.com/events/birthdays/, docs/outreach.md decision 108): whose birthday it is
 * today, under its "Today's birthdays", and the recent and upcoming ones under parts of their own. Each person is read
 * as a friends list reads them, with the title of the part they're in; only today's are someone to wish (`isToday`).
 * Where the page shows no titles, a person whose box says "today" is today's.
 */
import { clean, collectLinked, inTopBar, isHeading, namesOn } from './dom';
import { bestName, detailsIn } from './people';
import type { Person } from './types';
import { profileFromUrl, profileKey } from './urls';

/** The part of the page with today's birthdays, as Facebook titles it. */
const TODAY_PART = /^(today['’]s birthdays?|birthdays today|today)$/i;
/** The page's other parts: birthdays gone by, or to come. */
const OTHER_PART =
  /^(recent birthdays?|upcoming birthdays?|belated birthdays?|birthdays this week|later this (week|month)|this week|tomorrow|yesterday|(january|february|march|april|may|june|july|august|september|october|november|december)( birthdays?)?)$/i;
/** A box that says the birthday is today, where the page shows no titles: "Turns 40 today", "Today". */
const SAYS_TODAY = /\btoday\b/i;

export const TODAY_SECTION = 'Today’s birthdays';

/** A lone piece of text that names birthdays: only then a part's title, as "Today" alone may be in a person's box. */
const NAMES_BIRTHDAYS = /\bbirthdays?\b/i;

/** The title an element starts, when it's one of the page's parts: a heading, or a lone piece of text. */
function partOf(element: Element): string | null {
  const heading = isHeading(element);
  if (!heading && element.childElementCount > 0) return null;
  if (element.closest('a, [role="tab"], [role="button"], button')) return null;
  const text = clean(element.textContent).replace(/\s*[·•]\s*\d+$/, '');
  if (!text || text.length > 40) return null;
  if (!heading && !NAMES_BIRTHDAYS.test(text)) return null;
  if (TODAY_PART.test(text)) return TODAY_SECTION;
  return OTHER_PART.test(text) ? text : null;
}

/** The people the page lists, each once, with the part they're in. */
export function readBirthdays(root: Element, base: string): Person[] {
  const linked = collectLinked(
    root,
    base,
    (url) => {
      const profile = profileFromUrl(url);
      return profile ? { key: profileKey(profile), value: profile } : null;
    },
    { skip: inTopBar, sectionOf: partOf },
  );
  const titled = linked.some((entry) => entry.section !== null);
  const people: Person[] = [];
  for (const entry of linked) {
    const name = bestName(namesOn(entry.anchors));
    if (!name) continue;
    const details = detailsIn(entry.card, name);
    // Their box's words, but for their name: "Today" may share its line.
    const says = clean(entry.card.textContent).replace(name, ' ');
    const section = entry.section ?? (!titled && SAYS_TODAY.test(says) ? TODAY_SECTION : null);
    people.push({
      name,
      profile: entry.value,
      details,
      badges: [],
      section,
      request: null,
    });
  }
  return people;
}

/** Whether someone the page lists has their birthday today. */
export const isToday = (person: Pick<Person, 'section'>): boolean =>
  person.section === TODAY_SECTION;
