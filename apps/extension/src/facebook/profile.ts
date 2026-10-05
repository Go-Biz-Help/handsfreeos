/**
 * A person's profile: their name, the Intro card (work, business, town), where the two of you stand, and their
 * latest posts. The name is the page's `h1`; where you stand comes from the buttons beside it.
 */
import { buttonLabels, clean, elementsIn, isHeading, textLines } from './dom';
import { readPosts } from './posts';
import type { PageAddress, Post, ProfilePage } from './types';
import { isFacebookText, parseCount, UI_WORDS } from './vocabulary';

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

function friendshipIn(labels: readonly string[]): ProfilePage['friendship'] {
  for (const [pattern, friendship] of FRIENDSHIP)
    if (labels.some((label) => pattern.test(label))) return friendship;
  return 'unknown';
}

/**
 * The box at the top of the profile: the nearest one around the name that has one of the buttons above. Buttons
 * further down ("Add friend" under People you may know) say nothing about this person.
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
): { readonly profile: ProfilePage; readonly posts: readonly Post[] } {
  const heading = root.querySelector('h1');
  const name = heading ? clean(heading.textContent) || null : null;
  const header = heading ? headerAround(heading, root) : null;
  const friendship = header ? friendshipIn(buttonLabels(header)) : 'unknown';
  let mutualFriends: number | null = null;
  for (const line of header ? textLines(header, 40) : []) {
    // "45 mutual friends", or "1.2K friends · 45 mutual" under the name.
    const match = /([\d.,]+\s*[km]?)\s+mutual\b/i.exec(line);
    if (match?.[1]) {
      mutualFriends = parseCount(match[1]);
      break;
    }
  }
  return {
    profile: {
      name,
      profile: address.profile,
      intro: introLines(root),
      friendship,
      mutualFriends,
    },
    posts: readPosts(root, base),
  };
}
