/**
 * Whether anyone's at the address the tab shows (docs/outreach.md, decision 84): how a username's checked before the
 * person picks it. Each network says plainly when a page isn't there ("Sorry, this page isn't available.", "This
 * content isn't available right now", "This page doesn't exist"), and shows someone's name at the top of a profile
 * that is. It reads the page's words and nothing else, and presses nothing.
 *
 * False is a username that's free (nobody there), true one that's taken, null when the page says neither: the
 * network itself has the last word as the username goes in.
 */
import type { Platform } from '@hfos/core/addons/outreach/networks';

/** What each network says of a page that isn't there. */
const NOT_THERE: Readonly<Record<Platform, RegExp>> = {
  facebook:
    /this (content|page) isn[’']t available|the link you followed may be broken|page isn[’']t available/i,
  instagram: /sorry, this page isn[’']t available|the link you followed may be broken/i,
  linkedin: /this page doesn[’']t exist|page not found|profile (is )?not available/i,
  alignable: /page not found|doesn[’']t exist/i,
};

const words = (doc: Document) => (doc.body?.textContent ?? '').replace(/\s+/g, ' ');

/** Whether the page has someone's name at its top: a profile's heading, in its main part or its header. */
function hasProfile(doc: Document): boolean {
  const main = doc.querySelector('[role="main"], main') ?? doc.body;
  const heading = main?.querySelector('header h1, header h2, h1, h2');
  return !!heading && (heading.textContent ?? '').trim().length > 0;
}

export function pageThere(doc: Document, platform: Platform): boolean | null {
  if (NOT_THERE[platform].test(words(doc))) return false;
  return hasProfile(doc) ? true : null;
}
