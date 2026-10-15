/**
 * LinkedIn's warnings: the weekly invitation limit, a restricted account, a security check, the search limit for free
 * accounts (./vocabulary.ts). Any of them stops LinkedIn for the rest of the day, and only LinkedIn (the plan's "Each
 * network on its own"). Only dialogs, alerts, headings and LinkedIn's checkpoint pages count, never a post or a
 * comment: a post about being restricted is not a warning.
 */
import { clean } from '../facebook/dom';
import { shownLines } from './dom';
import { linkedinUrl, pathParts } from './urls';
import { WARNINGS } from './vocabulary';

/** Where LinkedIn puts its warnings. */
const PLACES = '[role="dialog"], [role="alertdialog"], [role="alert"], h1, h2, [role="heading"]';
/** What somebody wrote: posts and their comments. */
const WRITTEN = 'article, [role="article"], [role="feed"]';

/** LinkedIn's warnings on the page, each once, as LinkedIn worded them. */
export function readWarnings(doc: Document, href: string): string[] {
  const found = new Set<string>();
  const url = linkedinUrl(href);
  if (url && pathParts(url)[0]?.toLowerCase() === 'checkpoint')
    found.add('LinkedIn is asking you to check your account before you go on.');
  for (const place of doc.querySelectorAll(PLACES)) {
    // A heading in a post or a comment is somebody's writing, not LinkedIn's.
    if (!place.matches('[role="dialog"], [role="alertdialog"], [role="alert"]')) {
      if (place.closest(WRITTEN)) continue;
    }
    for (const line of shownLines(place, { max: 40, exclude: WRITTEN })) {
      if (line.length <= 300 && WARNINGS.some((pattern) => pattern.test(line)))
        found.add(clean(line));
      if (found.size >= 5) return [...found];
    }
  }
  return [...found];
}
