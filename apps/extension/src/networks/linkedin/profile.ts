/**
 * A member's profile (/in/<name>/, and your own at /in/me/): their name, what they say about themselves (headline,
 * place, About), their first role under Experience and the company page it links to, how far they are, mutual
 * connections, and where the two of you stand by the buttons at the top.
 *
 * LinkedIn draws a profile as a top card, with the name as its `h1` (an `h2` in its newer layout: the owner's outlines of
 * 16 Oct 2026), and then sections, each under a heading of its own (About, Activity, Experience…). The top is what
 * comes between the name and the first of those headings. Its headline is the first line there about them that isn't
 * a link (the newer layout links "Add a verification badge" beside the name). Where you stand comes from its buttons,
 * those under More among them: when Follow is the main button, Connect is in that menu. Its place is what comes just
 * before its Contact info link, and its id, where LinkedIn shows it, is in the links of its mutual connections and its
 * Message.
 *
 * Its About is the section's text box (`data-testid="expandable-text-box"`, the whole of it: "…more" only shows the
 * rest) where it has one, else the section's lines; the newer layout's "Top skills" under it isn't the About. Each role
 * under Experience is a link holding its lines (title, company · how, dates, place); a company with several roles has
 * its own link (its name, how long) above a list of them. The older layout's roles are list items.
 */
import { clean, isAfter, isBefore, outermost } from '../facebook/dom';
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
import type { CompanyLink, Degree, PageAddress, ProfilePage, ProfileRef, Role } from './types';
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
  CONNECT,
  degreeOnly,
  FOLLOW,
  FOLLOWING,
  isAction,
  isLinkedInText,
  MORE,
  followerCount,
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
/** The box LinkedIn's newer layout keeps an About's or a role's words in, all of them. */
const TEXT_BOX = '[data-testid="expandable-text-box"]';
/** What's between a line's parts on its own: "·" between the place and Contact info. */
const ONLY_DOT = /^[·•|]$/;

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

/**
 * The section with this title, below the top: its heading, the next heading, where its words end, and the one before
 * it, where the section above ends.
 */
export function sectionOf(
  root: Element,
  title: RegExp,
): {
  readonly heading: Element;
  readonly end: Element | null;
  readonly above: Element | null;
} | null {
  const headings = headingsIn(root);
  const heading = sectionAt(headings, title);
  return heading
    ? {
        heading,
        end: nextAfter(headings, heading),
        above: headings.filter((other) => isBefore(other, heading)).at(-1) ?? null,
      }
    : null;
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

/** A role under Experience, with the company page its entry links to. */
interface Entry {
  readonly role: Role;
  readonly company: CompanyLink | null;
}

const itemOf = (element: Element) => element.closest('li, [role="listitem"]');
/** The lines a link or an entry shows, less its buttons and its words' box (a role's description). */
const linesOf = (element: Element, max = 8) =>
  shownLines(element, { max, exclude: `${CONTROLS}, ${TEXT_BOX}` });

/** A role from its lines: its title, then the company (unless its group says it) and how, its dates and place. */
function roleFrom(lines: readonly string[], company: string | null): Role | null {
  const [title, second] = lines;
  if (!title) return null;
  const named = company ?? (second && !DATES.test(second) ? second.replace(HOW, '').trim() : null);
  return { title, company: named || null, dates: lines.find((line) => DATES.test(line)) ?? null };
}

/**
 * The company page an entry links to, with the name it gives it: the first link to one in the nearest box around
 * the role (its own link left out: an older role's link is to its company, with the role's words) that holds no other
 * role but its group's, before the role's words.
 */
function companyNear(
  role: Element,
  base: string,
  others: readonly Element[],
  group: Element | null,
): CompanyLink | null {
  let box = role.parentElement;
  for (let steps = 0; box && steps < 6; steps++, box = box.parentElement) {
    if (others.some((other) => other !== role && box!.contains(other) && !group?.contains(other)))
      return null;
    for (const anchor of box.querySelectorAll('a[href]')) {
      if (anchor === role || isAfter(anchor, role)) continue;
      const company = companyIn(anchor, base);
      if (company) return company;
    }
  }
  return null;
}

/** The company a link is to, with the name it gives it ("Acme Plumbing logo" gives "Acme Plumbing"). */
function companyIn(anchor: Element, base: string): CompanyLink | null {
  const url = linkedinUrl(anchor.getAttribute('href') ?? '', base);
  const company = url ? companyFromUrl(url) : null;
  if (!company) return null;
  const name = namesOn([anchor])
    .map((words) => words.replace(/\s+logo$/i, ''))
    .find((words) => isNameLike(words));
  return { name: name ?? '', company };
}

/**
 * Each role under Experience, in page order. In LinkedIn's newer layout each is a link holding its lines, outside a
 * list, but for a company with several roles: its own link (its name, how long) comes first and its roles are list
 * items after it, each named with it. Where every role is a list item (the older layout), each item is one: a company
 * and its role, or a company with its roles under it, whose first role is read.
 */
function experienceOf(root: Element, base: string): Entry[] {
  const section = sectionOf(root, /^experience$/i);
  if (!section) return [];
  const { heading, end } = section;
  const within = (element: Element) => isAfter(element, heading) && (!end || isAfter(end, element));
  const links = [...root.querySelectorAll('a[href]')].filter(
    (link) => within(link) && !link.closest(TEXT_BOX) && linesOf(link, 3).length >= 2,
  );
  if (!links.some((link) => !itemOf(link)))
    return outermost(root, 'li, [role="listitem"]')
      .filter(within)
      .flatMap((entry) => {
        const role = roleIn(entry);
        return role
          ? [
              {
                role,
                company: companyIn(entry.querySelector('a[href*="/company/"]') ?? entry, base),
              },
            ]
          : [];
      });
  const entries: Entry[] = [];
  let group: { readonly box: Element; readonly name: string | null } | null = null;
  links.forEach((link, i) => {
    const next = links[i + 1];
    const item = itemOf(link);
    const nextItem = next ? itemOf(next) : null;
    // A company's own link, its roles listed after it: the smallest box holding both is the company's.
    if (next && nextItem && !nextItem.contains(link) && (!item || item.contains(next))) {
      let box = link.parentElement;
      while (box && !box.contains(next)) box = box.parentElement;
      if (box && links.find((other) => box!.contains(other)) === link) {
        group = { box, name: linesOf(link)[0] ?? null };
        return;
      }
    }
    const mine: { readonly box: Element; readonly name: string | null } | null =
      group && group.box.contains(link) ? group : null;
    const role = roleFrom(linesOf(link), mine?.name ?? null);
    if (role) entries.push({ role, company: companyNear(link, base, links, mine?.box ?? null) });
  });
  return entries;
}

/** Each role under Experience, `max` at most: every role in the newer layout, a company's first in the older. */
export function rolesOf(root: Element, max = 6, base = 'https://www.linkedin.com/'): Role[] {
  return experienceOf(root, base)
    .map((entry) => entry.role)
    .slice(0, max);
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
  const firstSection = headings.find((h) => SECTIONS.test(shownText(h))) ?? null;
  // The name: the top card's h1; in the newer layout its h2, the first heading above the sections that's a name.
  const heading =
    headings.find((h) => h.tagName === 'H1' && isNameLike(shownText(h, CONTROLS))) ??
    headings.find(
      (h) =>
        (!firstSection || isBefore(h, firstSection)) &&
        !SECTIONS.test(shownText(h)) &&
        isNameLike(shownText(h, CONTROLS)),
    ) ??
    null;
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
  const labels = controls.flatMap(wordsOf);
  // "· 2nd" beside the name, or "She/Her · 2nd": a part of a line that says only that. LinkedIn's newer top card can
  // say "· 1st" beside the real one (the owner's Check LinkedIn of 17 Oct 2026, on someone it offered Connect to):
  // with Connect there, they aren't a connection.
  const degrees = lines
    .flatMap((line) => line.split(/\s*[·•]\s*/))
    .map(degreeOnly)
    .filter((found): found is Degree => found !== null);
  const canConnect = labels.some((label) => CONNECT.test(label));
  const degree = (canConnect ? degrees.find((found) => found !== '1st') : degrees[0]) ?? null;
  // Their headline: the first line about them that isn't a link ("Add a verification badge" beside the name).
  const headline =
    shownLines(root, {
      max: 40,
      after: heading,
      before: end,
      exclude: `${CONTROLS}, a[href]`,
    }).find((line) => line !== name && aboutThem(line)) ?? null;

  // Their place is the line just before Contact info, on the same line or the one above.
  const contact = controls.find((control) => {
    const url = linkedinUrl(control.getAttribute('href') ?? '', base);
    return (
      url !== null && pathParts(url).slice(2).join('/').toLowerCase() === 'overlay/contact-info'
    );
  });
  const beforeContact = contact
    ? shownLines(root, { max: 40, after: heading, before: contact, exclude: CONTROLS }).filter(
        (line) => !ONLY_DOT.test(line),
      )
    : [];
  const place = beforeContact[beforeContact.length - 1]?.replace(/\s*[·•]\s*$/, '') ?? null;
  const location = place && place !== headline && aboutThem(place) ? place : null;

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
  const aboutEnd = about ? nextAfter(headings, about) : null;
  // The newer layout's About is its text box, all of it; "Top skills" under it isn't the About.
  const aboutBox = about
    ? ([...root.querySelectorAll(TEXT_BOX)].find(
        (box) => isAfter(box, about) && (!aboutEnd || isAfter(aboutEnd, box)),
      ) ?? null)
    : null;
  const aboutText = about
    ? shownLines(aboutBox ?? root, {
        max: 80,
        ...(aboutBox ? {} : { after: about, before: aboutEnd }),
        exclude: CONTROLS,
      })
        .filter((line) => !UI_WORDS.has(line.toLowerCase()))
        .join('\n')
        .slice(0, ABOUT_LONGEST)
    : '';

  const entry = experienceOf(root, base)[0];
  const role = entry?.role ?? null;
  const linked = entry?.company ?? null;
  const atTop = labels.map((label) => CURRENT_COMPANY.exec(label)?.[1]).find(Boolean) ?? null;
  const companyName = atTop ?? role?.company ?? (linked?.name || null);

  const mutualConnections = lines.map(mutualCount).find((count) => count !== null) ?? null;
  const followers = lines.map(followerCount).find((count) => count !== null) ?? null;
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
    ...(followers !== null ? { followers } : {}),
  };
}
