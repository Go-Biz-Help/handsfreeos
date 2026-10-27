/**
 * A person's profile: their name, what they say about themselves (bio, work, school, town), where the two of you
 * stand, and their latest posts. Facebook draws profiles two ways, and both are read:
 *
 * - the older one has the name as the page's `h1` and the bio and details in an "Intro" card beside the posts;
 * - the 2026 one has no `h1`: the name, counts, buttons, bio and details all sit at the top, above the tabs. On your
 *   own, from October 2026, Edit profile is a link rather than a button.
 *
 * The top is what comes before the tabs (All, About, Friends…). Where you stand comes from its buttons, and the intro
 * from its lines and any Intro card, or the 2026 cards after the tabs (Personal details, Work, Education). A place in
 * the details under the name ("Florida City, FL") is where they live (decision 86): it's kept as "Lives in …".
 */
import { countryOfPlace } from '@hfos/core/addons/outreach/countries';
import {
  buttonLabels,
  clean,
  elementsIn,
  inTopBar,
  isHeading,
  namesOn,
  tabsIn,
  textLines,
} from './dom';
import { bestName, isNameLike, nameForms, sameName } from './people';
import { readPosts } from './posts';
import type { Named, PageAddress, Post, ProfilePage } from './types';
import { facebookUrl, profileFromUrl, profileKey } from './urls';
import { isFacebookLine, isFacebookText, parseCount, UI_WORDS } from './vocabulary';

/**
 * The buttons that say where you stand, strongest first. From October 2026 Add friend's label has the person's name
 * after it for screen readers ("Add Friend Jane Doe", the owner's problem reports of 26 Oct 2026); Cancel request's
 * may too. The name, when there is one, is caught.
 */
const FRIENDSHIP: readonly (readonly [RegExp, ProfilePage['friendship']])[] = [
  [/^edit profile$/i, 'self'],
  [/^friends$/i, 'friends'],
  [/^cancel request(?:\s+(.+))?$/i, 'request_sent'],
  [/^(?:respond|confirm|confirm request)$/i, 'request_received'],
  [/^add friend(?:\s+(.+))?$/i, 'not_friends'],
];

/** The cards on a profile that come after Intro: reading stops at the first of them. */
const AFTER_INTRO =
  /^(photos|friends|featured|life events|posts|links|hobbies|interests|about|see all.*)$/i;

/** Lines at the top that are about friends in common or followers, not about the person. */
const NOT_INTRO = /\bmutual\b|^followed by\b/i;

/** What the top's lines leave out: buttons (the name is one on 2026 profiles), headings and the tabs. */
const NOT_TOP_TEXT = 'h1, h2, h3, [role="heading"], [role="button"], button, [role="tablist"]';

/**
 * Whether a name after a button's words is this person's: their name whole, or without its nickname ("Jane Doe" on
 * "Jane Doe (Janie)"'s profile), the same names the press looks for (./auto.ts's `withTheirName`). Never a name that
 * only holds theirs or is held in it ("Dana Reyes Jr.", "Ana"). Any name will do while the profile's own isn't known.
 */
const theirs = (named: string, name: string | null): boolean =>
  name === null || nameForms(name).some((form) => sameName(form, named));

function friendshipIn(
  labels: readonly string[],
  name: string | null = null,
): ProfilePage['friendship'] {
  for (const [pattern, friendship] of FRIENDSHIP)
    if (
      labels.some((label) => {
        const found = pattern.exec(label);
        // "Add Friend Sam Lee" under People you may know says nothing about this person.
        return found !== null && (!found[1] || theirs(found[1], name));
      })
    )
      return friendship;
  return 'unknown';
}

/**
 * Your own profile's Edit profile as a link: from October 2026 it's no button but a link to the About tab's editor,
 * labelled Edit profile with just "Edit" for its words, beside the cards' own edit links (an owner's page outline of
 * 23 Oct 2026). Only your own profile has either.
 */
export function editProfileLinkIn(root: Element): boolean {
  return [...root.querySelectorAll('a[href]')].some(
    (a) =>
      !inTopBar(a) &&
      (/^edit profile$/i.test(clean(a.getAttribute('aria-label'))) ||
        /[?&]fb_profile_edit_entry_point=/.test(a.getAttribute('href') ?? '')),
  );
}

/** "(3) Jane Doe | Facebook" → "Jane Doe": the name in the page's title, when it has one. */
export function nameFromTitle(title: string): string | null {
  const name = clean(title)
    .replace(/^\(\d+\+?\)\s*/, '')
    .replace(/\s*\|\s*facebook$/i, '');
  return isNameLike(name) ? name : null;
}

/** The name on the page's links to this profile, outside the top bar: the one by the tabs, a post's author. */
function nameFromLinks(root: Element, address: PageAddress, base: string): string | null {
  if (!address.profile) return null;
  const key = profileKey(address.profile);
  const anchors = [...root.querySelectorAll('a[href]')].filter((anchor) => {
    if (inTopBar(anchor)) return false;
    const url = facebookUrl(anchor.getAttribute('href') ?? '', base);
    const profile = url ? profileFromUrl(url) : null;
    return profile !== null && profileKey(profile) === key;
  });
  return bestName(namesOn(anchors));
}

/** The first piece of text on the page that is exactly the name. */
function nameElementIn(root: Element, name: string): Element | null {
  for (const element of elementsIn(root))
    if (
      element.childElementCount === 0 &&
      clean(element.textContent) === name &&
      !inTopBar(element)
    )
      return element;
  return null;
}

/**
 * The top of the profile, above its tabs: the boxes before the tabs, at the first level up from them where one of
 * those boxes has the name or a button that says where you stand.
 */
function topOf(root: Element, name: string | null): Element[] {
  for (let box = tabsIn(root); box && box !== root; box = box.parentElement) {
    const before: Element[] = [];
    for (let e = box.previousElementSibling; e; e = e.previousElementSibling) before.unshift(e);
    const isTop = (e: Element) =>
      friendshipIn(buttonLabels(e), name) !== 'unknown' ||
      (name !== null && textLines(e, 30).some((line) => line.startsWith(name)));
    if (before.some(isTop)) return before;
  }
  return [];
}

/**
 * The box around the name that has one of the buttons above, for a profile without tabs. Buttons further down ("Add
 * friend" under People you may know) say nothing about this person.
 */
function headerAround(around: Element, root: Element, name: string | null): Element | null {
  let box: Element | null = around;
  for (let steps = 0; box && steps < 12; steps++) {
    if (friendshipIn(buttonLabels(box), name) !== 'unknown') return box;
    if (box === root) break;
    box = box.parentElement;
  }
  return null;
}

/** Lines that already say how a place is theirs, or what it is. */
const SAYS_HOW =
  /^(lives in|lived in|currently lives in|from|is from|grew up in|works at|worked at|studied|studies|went to)\b/i;

/**
 * A detail under the name that is a place, a town and its state or country ("Florida City, FL", "Lagos, Nigeria"), as
 * where they live: Facebook puts the town they live in there beside a pin (decision 86). Anything else as it is.
 */
export function placeLine(line: string): string {
  if (line.length > 60 || SAYS_HOW.test(line) || !/^[^,]{2,40}(,[^,]{2,40}){1,2}$/.test(line))
    return line;
  return countryOfPlace(line) ? `Lives in ${line}` : line;
}

/** What the top says about them besides their name and counts: the bio, then the details beside little icons. */
function topLines(top: readonly Element[], name: string | null): string[] {
  return (
    top
      .flatMap((box) => textLines(box, 40, NOT_TOP_TEXT))
      // The dot between the details in a row is no part of them.
      .map((line) => line.replace(/^[·•]\s*/, ''))
      .filter(
        (line) =>
          !(name && line.startsWith(name)) &&
          !isFacebookLine(line) &&
          !NOT_INTRO.test(line) &&
          line.length <= 300,
      )
      .map(placeLine)
  );
}

/** The Intro card's lines: what follows the "Intro" title, up to the next card. */
function introLines(root: Element): string[] {
  const title = [...elementsIn(root)].find(
    (element) =>
      (isHeading(element) || element.childElementCount === 0) &&
      clean(element.textContent).toLowerCase() === 'intro',
  );
  if (!title) return [];
  // The column the card is in: Intro is the first thing in it, so climb while Intro stays first.
  let column: Element = title;
  for (let steps = 0; steps < 10 && column.parentElement && column !== root; steps++) {
    const up: Element = column.parentElement;
    if (textLines(up, 1)[0]?.toLowerCase() !== 'intro') break;
    column = up;
  }
  const lines: string[] = [];
  for (const line of textLines(column, 40).slice(1)) {
    if (AFTER_INTRO.test(line)) break;
    if (UI_WORDS.has(line.toLowerCase()) || isFacebookText(line)) continue;
    lines.push(line);
    if (lines.length >= 12) break;
  }
  return lines;
}

/** October 2026's cards after the tabs that stand for the Intro, and the one with their links. */
const INTRO_CARDS = /^(personal details|work|education)$/i;

export function cardTitles(main: Element, title: RegExp): Element[] {
  return [...main.querySelectorAll('h2, h3, [role="heading"]')].filter((h) =>
    title.test(clean(h.textContent)),
  );
}

/** The list a card's title heads: the first one in the nearest box around the title that has one. */
export function cardList(title: Element): Element | null {
  let card: Element | null = title;
  for (let steps = 0; card && steps < 12; steps++) {
    card = card.parentElement;
    const list = card?.querySelector('[role="list"]');
    if (list) return list;
  }
  return null;
}

/**
 * What the Personal details, Work and Education cards say, an item a line: "Lives in Austin", "Owner at Summit Roof
 * Leads …". Anyone's 2026 profile has them after the tabs, in place of an Intro card.
 */
export function cardsIntro(main: Element): string[] {
  const lines: string[] = [];
  for (const title of cardTitles(main, INTRO_CARDS))
    for (const item of cardList(title)?.querySelectorAll('[role="listitem"]') ?? []) {
      const line = textLines(item, 6, '[aria-hidden="true"]').join(' ');
      if (line && !UI_WORDS.has(line.toLowerCase()) && !isFacebookText(line)) lines.push(line);
    }
  return lines;
}

/** The most pages a profile's lines link to that are kept: a business or two. */
const PAGES_MOST = 3;

/**
 * The pages their lines link to besides their own: "Owner at Smith Plumbing", where the name is a link to the
 * business's page (decision 21's look-up). Only links whose words are in one of the lines the profile shows about
 * them, so a friend's name or a suggested page elsewhere on it is never taken for theirs.
 */
function pagesIn(
  root: Element,
  address: PageAddress,
  base: string,
  name: string | null,
  intro: readonly string[],
): Named[] {
  const self = address.profile ? profileKey(address.profile) : null;
  const found: Named[] = [];
  const seen = new Set<string>();
  for (const anchor of root.querySelectorAll('a[href]')) {
    if (inTopBar(anchor)) continue;
    const words = clean(anchor.textContent);
    if (words.length < 2 || words.length > 100 || words === name) continue;
    if (!intro.some((line) => line.includes(words))) continue;
    const url = facebookUrl(anchor.getAttribute('href') ?? '', base);
    const profile = url ? profileFromUrl(url) : null;
    if (!profile) continue;
    const key = profileKey(profile);
    if (key === self || seen.has(key)) continue;
    seen.add(key);
    found.push({ name: words, profile });
    if (found.length >= PAGES_MOST) break;
  }
  return found;
}

export function readProfile(
  root: Element,
  address: PageAddress,
  base: string,
  title = '',
): {
  readonly profile: ProfilePage;
  readonly posts: readonly Post[];
  readonly pages: readonly Named[];
} {
  const heading = root.querySelector('h1');
  const headingName = heading ? clean(heading.textContent) : '';
  const name =
    (isNameLike(headingName) ? headingName : null) ??
    nameFromTitle(title) ??
    nameFromLinks(root, address, base);

  let top = topOf(root, name);
  if (top.length === 0) {
    const around = heading ?? (name ? nameElementIn(root, name) : null);
    const header = around ? headerAround(around, root, name) : null;
    top = header ? [header] : [];
  }
  const fromButtons = friendshipIn(top.flatMap(buttonLabels), name);
  const friendship = fromButtons === 'unknown' && editProfileLinkIn(root) ? 'self' : fromButtons;
  let mutualFriends: number | null = null;
  let followers: number | null = null;
  let friends: number | null = null;
  for (const line of top.flatMap((box) => textLines(box, 40))) {
    // "349 friends • 21 mutual", "4.9K friends · 59 mutual": not "21 mutual friends".
    const counted = /([\d.,]+\s*[km]?)\s+friends\b/i.exec(line);
    if (counted?.[1] && friends === null) friends = parseCount(counted[1]);
    // "45 mutual friends", or "1.2K friends · 45 mutual" under the name.
    const mutual = /([\d.,]+\s*[km]?)\s+mutual\b/i.exec(line);
    if (mutual?.[1] && mutualFriends === null) mutualFriends = parseCount(mutual[1]);
    // "12K followers", or "1.2K friends · 3.4K followers".
    const following = /([\d.,]+\s*[km]?)\s+followers\b/i.exec(line);
    if (following?.[1] && followers === null) followers = parseCount(following[1]);
  }
  const intro = [
    ...new Set([...topLines(top, name), ...introLines(root), ...cardsIntro(root)]),
  ].slice(0, 12);
  return {
    profile: {
      name,
      profile: address.profile,
      intro,
      friendship,
      mutualFriends,
      ...(followers !== null ? { followers } : {}),
      ...(friends !== null ? { friends } : {}),
    },
    posts: readPosts(root, base),
    pages: pagesIn(root, address, base, name, intro),
  };
}
