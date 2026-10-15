/**
 * A member's profile (/in/<name>/, and your own at /in/me/): their name, what they say about themselves (headline,
 * place, About), their first role under Experience and the company page it links to, how far they are, mutual
 * connections, and where the two of you stand by the buttons at the top.
 *
 * LinkedIn draws a profile as a top card, with the name as its `h1`, and then sections, each under a heading of its
 * own (About, Activity, Experience…). The top is what comes between the name and the first of those headings. Where
 * you stand comes from its buttons, those under More among them: when Follow is the main button, Connect is in that
 * menu. Its place is what comes just before its Contact info link, and its id, where LinkedIn shows it, is in the
 * links of its mutual connections and its Message.
 */
import { clean, elementsAfter, isAfter, outermost } from '../facebook/dom';
import {
  controlsIn,
  CONTROLS,
  hiddenFromReaders,
  inTopBar,
  namesOn,
  shownLines,
  shownText,
  wordsOf,
} from './dom';
import { bestName, connectionOf, isNameLike } from './people';
import type { CompanyLink, PageAddress, ProfilePage, ProfileRef, Role } from './types';
import {
  companyFromUrl,
  linkedinUrl,
  memberIdFrom,
  pathParts,
  profileFromUrl,
  profileKey,
  profilePageOf,
} from './urls';
import {
  degreeOnly,
  FOLLOW,
  FOLLOWING,
  isAction,
  isLinkedInText,
  MORE,
  mutualCount,
  PRONOUNS,
  UI_WORDS,
} from './vocabulary';

/** The headings of a profile's sections, below its top. */
const SECTIONS =
  /^(about|activity|experience|education|featured|highlights|skills|services|analytics|resources|suggested for you|licenses (&|and) certifications|volunteering|recommendations|interests|languages|projects|honors (&|and) awards|courses|publications|organizations|causes|people also viewed|people you may know|more profiles for you)$/i;
/** "Current company: Acme Plumbing. Click to skip to experience card": the top's button for their company. */
const CURRENT_COMPANY = /^current company:\s*(.+?)(?:\.\s*click to skip\b.*)?$/i;
/** A line that says when a role was: "Jan 2015 - Present · 10 yrs 10 mos". */
const DATES =
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4}\b|\b\d{4}\s*[-–]\s*(?:\d{4}|present)\b|^\d+\s+(?:yrs?|mos?)\b/i;
/** How someone works at a company, after its name: "Acme Plumbing · Self-employed". */
const HOW =
  /\s*·\s*(full-time|part-time|self-employed|freelance|contract|internship|apprenticeship|seasonal)$/i;
/** The longest About LinkedIn takes. */
const ABOUT_LONGEST = 2_600;

/** "(3) Dana Reyes | LinkedIn" → "Dana Reyes": the name in the page's title, when it has one. */
export function nameFromTitle(title: string): string | null {
  const name = clean(title)
    .replace(/^\(\d+\+?\)\s*/, '')
    .replace(/\s*\|\s*linkedin$/i, '');
  return name && isNameLike(name) && !/\|/.test(name) ? name : null;
}

/** The page's headings, outside the top bar, in page order. */
const headingsIn = (root: Element) =>
  [...root.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')].filter(
    (heading) => !inTopBar(heading),
  );

/** The heading of the section with this title, below the top. */
function sectionAt(headings: readonly Element[], title: RegExp): Element | null {
  return headings.find((heading) => title.test(shownText(heading))) ?? null;
}

/** The next heading after `heading`: where its section's words end. */
const nextAfter = (headings: readonly Element[], heading: Element) =>
  headings.find((other) => isAfter(other, heading)) ?? null;

/** The name on the page's links to this profile, outside the top bar. */
function nameFromLinks(root: Element, profile: ProfileRef | null, base: string): string | null {
  if (!profile) return null;
  const key = profileKey(profile);
  const anchors = [...root.querySelectorAll('a[href]')].filter((anchor) => {
    if (inTopBar(anchor)) return false;
    const url = linkedinUrl(anchor.getAttribute('href') ?? '', base);
    const linked = url ? profileFromUrl(url) : null;
    return linked !== null && profileKey(linked) === key;
  });
  return bestName(namesOn(anchors));
}

/** Whether a line at the top says something about them, not only pronouns, how far they are or LinkedIn's words. */
const aboutThem = (line: string) =>
  line
    .split(/\s*[·•]\s*/)
    .filter(Boolean)
    .some(
      (part) =>
        !PRONOUNS.test(part) &&
        degreeOnly(part) === null &&
        !isLinkedInText(part) &&
        !/^contact info$/i.test(part),
    );

/** The words of their first role under Experience: one company and role, or a company with its roles under it. */
function roleIn(entry: Element): Role | null {
  const lines = shownLines(entry, { max: 12, exclude: CONTROLS });
  const inner = entry.querySelector('li, [role="listitem"]');
  if (inner) {
    // A company with its roles under it: the company first, then each role and its dates.
    const role = shownLines(inner, { max: 8, exclude: CONTROLS });
    const title = role[0];
    if (!title) return null;
    return {
      title,
      company: lines[0] ?? null,
      dates: role.find((line) => DATES.test(line)) ?? null,
    };
  }
  const [title, second] = lines;
  if (!title) return null;
  const company = second && !DATES.test(second) ? second.replace(HOW, '').trim() : null;
  return { title, company: company || null, dates: lines.find((line) => DATES.test(line)) ?? null };
}

/** The section with this title, below the top: its heading, and the next heading, where its words end. */
export function sectionOf(
  root: Element,
  title: RegExp,
): { readonly heading: Element; readonly end: Element | null } | null {
  const headings = headingsIn(root);
  const heading = sectionAt(headings, title);
  return heading ? { heading, end: nextAfter(headings, heading) } : null;
}

/** The lines a section shows under its heading, less its buttons and LinkedIn's own words: none without one. */
export function sectionLines(root: Element, title: RegExp, max = 40): string[] {
  const section = sectionOf(root, title);
  if (!section) return [];
  return shownLines(root, {
    max,
    after: section.heading,
    before: section.end,
    exclude: CONTROLS,
  }).filter((line) => !UI_WORDS.has(line.toLowerCase()));
}

/** Each entry under Experience, as its role (a company's first role, when it lists several), `max` at most. */
export function rolesOf(root: Element, max = 6): Role[] {
  const section = sectionOf(root, /^experience$/i);
  if (!section) return [];
  const { heading, end } = section;
  return outermost(root, 'li, [role="listitem"]')
    .filter((entry) => isAfter(entry, heading) && (!end || isAfter(end, entry)))
    .map(roleIn)
    .filter((role): role is Role => role !== null)
    .slice(0, max);
}

/** The first entry under a heading, before the next one: a list item. */
function firstEntry(root: Element, heading: Element, end: Element | null): Element | null {
  for (const element of elementsAfter(heading, root)) {
    if (end && (element === end || isAfter(element, end))) return null;
    if (element.matches('li, [role="listitem"]')) return element;
  }
  return null;
}

/** The company page an entry links to, with the name it gives it. */
function companyLinkIn(entry: Element, base: string): CompanyLink | null {
  for (const anchor of entry.querySelectorAll('a[href]')) {
    const url = linkedinUrl(anchor.getAttribute('href') ?? '', base);
    const company = url ? companyFromUrl(url) : null;
    if (!company) continue;
    const name = namesOn([anchor])
      .map((words) => words.replace(/\s+logo$/i, ''))
      .find((words) => isNameLike(words));
    return { name: name ?? '', company };
  }
  return null;
}

/**
 * Their profile, with the id the top's links give when the address has only the name, and the name from the Contact
 * info link when the address is your own /in/me/.
 */
function whoseProfile(
  address: PageAddress,
  anchors: readonly Element[],
  base: string,
): ProfileRef | null {
  let profile = address.profile;
  let id: string | null = null;
  for (const anchor of anchors) {
    const url = linkedinUrl(anchor.getAttribute('href') ?? '', base);
    if (!url) continue;
    const parts = pathParts(url).map((part) => part.toLowerCase());
    if (!profile && parts[0] === 'in' && parts[2] === 'overlay') profile = profilePageOf(url);
    if (!profileFromUrl(url)) id ??= memberIdFrom(url);
  }
  return profile && id && !profile.id ? { ...profile, id } : profile;
}

/** The profile's name, its top card's heading, and where the top card ends: the first section's heading below it. */
function topOf(headings: readonly Element[]): {
  readonly heading: Element | null;
  readonly end: Element | null;
} {
  const heading =
    headings.find((h) => h.tagName === 'H1' && isNameLike(shownText(h, CONTROLS))) ?? null;
  const end =
    headings.find((h) => (!heading || isAfter(h, heading)) && SECTIONS.test(shownText(h))) ?? null;
  return { heading, end };
}

/**
 * Whether something is in a profile's top card, above its sections (About, Activity, Experience…): its buttons there
 * (Connect, Accept, and those under More) are about whoever the profile is.
 */
export function inTopCard(element: Element, root: Element): boolean {
  if (!root.contains(element)) return false;
  const { end } = topOf(headingsIn(root));
  return !end || isAfter(end, element);
}

export function readProfile(
  root: Element,
  address: PageAddress,
  base: string,
  title = '',
): ProfilePage {
  const headings = headingsIn(root);
  const { heading, end } = topOf(headings);
  const controls = controlsIn(root, end);
  const profile = whoseProfile(
    address,
    controls.filter((c) => c.matches('a[href]')),
    base,
  );
  const name =
    (heading ? shownText(heading, CONTROLS) : null) ||
    nameFromTitle(title) ||
    nameFromLinks(root, profile, base);

  const lines = shownLines(root, { max: 40, after: heading, before: end, exclude: CONTROLS });
  // "· 2nd" beside the name, or "She/Her · 2nd": a part of a line that says only that.
  const degree =
    lines
      .flatMap((line) => line.split(/\s*[·•]\s*/))
      .map(degreeOnly)
      .find(Boolean) ?? null;
  const headline = lines.find((line) => line !== name && aboutThem(line)) ?? null;

  // Their place is the line just before Contact info, on the same line or the one above.
  const contact = controls.find((control) => {
    const url = linkedinUrl(control.getAttribute('href') ?? '', base);
    return (
      url !== null && pathParts(url).slice(2).join('/').toLowerCase() === 'overlay/contact-info'
    );
  });
  const beforeContact = contact
    ? shownLines(root, { max: 40, after: heading, before: contact, exclude: CONTROLS })
    : [];
  const place = beforeContact[beforeContact.length - 1]?.replace(/\s*[·•]\s*$/, '') ?? null;
  const location = place && place !== headline && aboutThem(place) ? place : null;

  const labels = controls.flatMap(wordsOf);
  const connection = connectionOf(labels, degree);
  // The main buttons: shown, not in a menu, and LinkedIn's actions (not a link to their company or connections).
  const main = controls.filter(
    (control) =>
      !hiddenFromReaders(control) &&
      !control.closest('[role="menu"]') &&
      wordsOf(control).some((word) => isAction(word) && !MORE.test(word)),
  );
  const firstWords = main[0] ? wordsOf(main[0]) : [];
  const followFirst =
    connection !== 'self' && firstWords.some((word) => FOLLOW.test(word) || FOLLOWING.test(word));

  const about = sectionAt(headings, /^about$/i);
  const aboutText = about
    ? shownLines(root, {
        max: 80,
        after: about,
        before: nextAfter(headings, about),
        exclude: CONTROLS,
      })
        .filter((line) => !UI_WORDS.has(line.toLowerCase()))
        .join('\n')
        .slice(0, ABOUT_LONGEST)
    : '';

  const experience = sectionAt(headings, /^experience$/i);
  const entry = experience ? firstEntry(root, experience, nextAfter(headings, experience)) : null;
  const role = entry ? roleIn(entry) : null;
  const linked = entry ? companyLinkIn(entry, base) : null;
  const atTop = labels.map((label) => CURRENT_COMPANY.exec(label)?.[1]).find(Boolean) ?? null;
  const companyName = atTop ?? role?.company ?? (linked?.name || null);

  const mutualConnections = lines.map(mutualCount).find((count) => count !== null) ?? null;
  return {
    name: name || null,
    profile,
    headline,
    location,
    about: aboutText || null,
    role,
    company: companyName ? { name: companyName, company: linked?.company ?? null } : null,
    degree,
    connection,
    followFirst,
    mutualConnections,
  };
}
