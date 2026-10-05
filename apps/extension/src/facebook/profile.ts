/**
 * A person's profile: their name, what they say about themselves (bio, work, school, town), where the two of you
 * stand, and their latest posts. Facebook draws profiles two ways, and both are read:
 *
 * - the older one has the name as the page's `h1` and the bio and details in an "Intro" card beside the posts;
 * - the 2026 one has no `h1`: the name, counts, buttons, bio and details all sit at the top, above the tabs.
 *
 * The top is what comes before the tabs (All, About, Friends…). Where you stand comes from its buttons, and the intro
 * from its lines and any Intro card.
 */
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
import { bestName, isNameLike } from './people';
import { readPosts } from './posts';
import type { PageAddress, Post, ProfilePage } from './types';
import { facebookUrl, profileFromUrl, profileKey } from './urls';
import { isFacebookLine, isFacebookText, parseCount, UI_WORDS } from './vocabulary';

/** The buttons that say where you stand, strongest first. */
const FRIENDSHIP: readonly (readonly [RegExp, ProfilePage['friendship']])[] = [
  [/^edit profile$/i, 'self'],
  [/^friends$/i, 'friends'],
  [/^cancel request$/i, 'request_sent'],
  [/^(respond|confirm|confirm request)$/i, 'request_received'],
  [/^add friend$/i, 'not_friends'],
];

/** The cards on a profile that come after Intro: reading stops at the first of them. */
const AFTER_INTRO =
  /^(photos|friends|featured|life events|posts|links|hobbies|interests|about|see all.*)$/i;

/** Lines at the top that are about friends in common or followers, not about the person. */
const NOT_INTRO = /\bmutual\b|^followed by\b/i;

/** What the top's lines leave out: buttons (the name is one on 2026 profiles), headings and the tabs. */
const NOT_TOP_TEXT = 'h1, h2, h3, [role="heading"], [role="button"], button, [role="tablist"]';

function friendshipIn(labels: readonly string[]): ProfilePage['friendship'] {
  for (const [pattern, friendship] of FRIENDSHIP)
    if (labels.some((label) => pattern.test(label))) return friendship;
  return 'unknown';
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
      friendshipIn(buttonLabels(e)) !== 'unknown' ||
      (name !== null && textLines(e, 30).some((line) => line.startsWith(name)));
    if (before.some(isTop)) return before;
  }
  return [];
}

/**
 * The box around the name that has one of the buttons above, for a profile without tabs. Buttons further down ("Add
 * friend" under People you may know) say nothing about this person.
 */
function headerAround(name: Element, root: Element): Element | null {
  let box: Element | null = name;
  for (let steps = 0; box && steps < 12; steps++) {
    if (friendshipIn(buttonLabels(box)) !== 'unknown') return box;
    if (box === root) break;
    box = box.parentElement;
  }
  return null;
}

/** What the top says about them besides their name and counts: the bio, then the details beside little icons. */
function topLines(top: readonly Element[], name: string | null): string[] {
  return top
    .flatMap((box) => textLines(box, 40, NOT_TOP_TEXT))
    .filter(
      (line) =>
        !(name && line.startsWith(name)) &&
        !isFacebookLine(line) &&
        !NOT_INTRO.test(line) &&
        line.length <= 300,
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

export function readProfile(
  root: Element,
  address: PageAddress,
  base: string,
  title = '',
): { readonly profile: ProfilePage; readonly posts: readonly Post[] } {
  const heading = root.querySelector('h1');
  const headingName = heading ? clean(heading.textContent) : '';
  const name =
    (isNameLike(headingName) ? headingName : null) ??
    nameFromTitle(title) ??
    nameFromLinks(root, address, base);

  let top = topOf(root, name);
  if (top.length === 0) {
    const around = heading ?? (name ? nameElementIn(root, name) : null);
    const header = around ? headerAround(around, root) : null;
    top = header ? [header] : [];
  }
  const friendship = friendshipIn(top.flatMap(buttonLabels));
  let mutualFriends: number | null = null;
  for (const line of top.flatMap((box) => textLines(box, 40))) {
    // "45 mutual friends", or "1.2K friends · 45 mutual" under the name.
    const match = /([\d.,]+\s*[km]?)\s+mutual\b/i.exec(line);
    if (match?.[1]) {
      mutualFriends = parseCount(match[1]);
      break;
    }
  }
  const intro = [...new Set([...topLines(top, name), ...introLines(root)])].slice(0, 12);
  return {
    profile: { name, profile: address.profile, intro, friendship, mutualFriends },
    posts: readPosts(root, base),
  };
}
