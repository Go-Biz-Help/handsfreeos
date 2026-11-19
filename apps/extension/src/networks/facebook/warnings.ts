/**
 * Facebook's warnings: that you're blocked from something for a while, that you went too fast, that your account
 * needs checking. The extension stops for the day on any of them: read in any Facebook tab (../../content.ts, and
 * ./page.ts for its own work tabs), kept for the day (../../hfos/warned.ts) and noted in HandsFreeOS (../../hfos/looked.ts).
 * Only dialogs, alerts, headings and Facebook's checkpoint pages count, never a post or a comment in them: a post
 * about being blocked is not a warning.
 *
 * A post is left out wherever it is: an article or a feed's, a 2026 post that's neither (./posts.ts finds those by
 * their own controls), or a post opened in a dialog over the page, which holds its Like and its box to comment in.
 * On 18 Nov 2026 (0.147.11) a post opened that way had the song "Good Times Go By Too Fast" on it, read as Facebook
 * saying "too fast", and halved the owner's limits for a week. So a phrase needs Facebook's own wording ("going too
 * fast", not "too fast"), and a line Facebook scrambles letter by letter (a post's date, "Sponsored") is never one.
 */
import { clean, textLinesWhere } from './dom';
import { holdsPost, postBoxes } from './posts';
import { facebookUrl, pathParts } from './urls';

const WARNINGS: readonly RegExp[] = [
  /\btemporarily (blocked|restricted|limited)\b/i,
  /\byou can(['’]t|not) (use this feature|send|comment|post|join|react|add|message|reply)\b/i,
  /\b(misusing (this|a) feature|going too fast|suspicious activity|unusual activity)\b/i,
  /\b(doing|done|using) (this|that|it) too (fast|often|much)\b/i,
  /\bwe limit how often\b/i,
  /\byour account (has been|was|is|got) (locked|restricted|suspended|disabled|limited)\b/i,
  /\b(confirm|verify) (your identity|it['’]s you|that this is your account)\b/i,
  /\bsecurity check\b/i,
  /\breached (the|your) limit\b/i,
  /\b(looks like spam|marked as spam|against our community standards)\b/i,
];

/**
 * Facebook's scrambled words: a post's date or "Sponsored" drawn as letters out of order with an invisible joiner
 * (U+034F) between them, so a script can't read them. Facebook never scrambles a warning.
 */
const SCRAMBLED = /͏/;

/** Where Facebook puts its warnings. */
const PLACES = '[role="dialog"], [role="alertdialog"], [role="alert"], h1, h2, [role="heading"]';
const BOXES = '[role="dialog"], [role="alertdialog"], [role="alert"]';
/** Somebody's writing, as the page marks it. */
const WRITING = '[role="article"], [role="feed"]';

/** Facebook's warnings on the page, each once, as Facebook worded them. */
export function readWarnings(doc: Document, href: string): string[] {
  const found = new Set<string>();
  const url = facebookUrl(href);
  if (url && pathParts(url)[0]?.toLowerCase() === 'checkpoint')
    found.add('Facebook is asking you to check your account before you go on.');
  const posts = doc.body ? postBoxes(doc.body) : [];
  // A post's own words, wherever it is: an article, a feed's, or a 2026 post that's neither.
  const inPost = (element: Element) =>
    element.closest(WRITING) !== null || posts.some((post) => post.contains(element));
  // A post inside a dialog or an alert: one around it is where Facebook put it (an alert under a comment box).
  const postWithin = (element: Element, place: Element) => {
    const writing = element.closest(WRITING);
    if (writing && writing !== place && place.contains(writing)) return true;
    return posts.some((post) => post !== place && place.contains(post) && post.contains(element));
  };
  for (const place of doc.querySelectorAll(PLACES)) {
    if (place.matches(BOXES)) {
      // A post opened over the page: its Like, its menu and its box to comment in are there. Facebook's warnings are
      // dialogs of their own, read on their own.
      if (holdsPost(place)) continue;
    } else if (inPost(place) || postDialogAround(place)) {
      // A heading in a post or a comment is somebody's writing, not Facebook's.
      continue;
    }
    const lines = textLinesWhere(
      place,
      (text) => !(text.parentElement && postWithin(text.parentElement, place)),
      40,
    );
    for (const line of lines) {
      if (line.length <= 300 && !SCRAMBLED.test(line) && WARNINGS.some((p) => p.test(line)))
        found.add(clean(line));
      if (found.size >= 5) return [...found];
    }
  }
  return [...found];
}

/** The dialog with a post in it that something is in, when it's in one. */
function postDialogAround(element: Element): Element | null {
  for (let box = element.closest(BOXES); box; box = box.parentElement?.closest(BOXES) ?? null)
    if (holdsPost(box)) return box;
  return null;
}
