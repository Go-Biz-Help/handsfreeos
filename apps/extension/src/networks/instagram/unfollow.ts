/**
 * Unfollowing one account on Instagram, once the person ticked them on the Friends tab (the Instagram and Alignable
 * plan's question 5: people who didn't follow back within 3 weeks, 20 a day at most; ../../jobs/instagram/unfollow.ts).
 * On their own page: its header's Following (or Requested, a private account they asked to follow), then Unfollow in
 * the box Instagram opens, each found by Instagram's own words; then the header says Follow again. A box that opens
 * without Unfollow in it is closed by its own Cancel or Close. Nothing else is pressed.
 */
import { controlsSaying, mainOf, waitFor } from '../looking/looks';

const FOLLOWING = /^(following|requested)$/i;
const FOLLOW = /^(follow|follow back)$/i;
const UNFOLLOW = /^unfollow$/i;
const CLOSE = /^(cancel|close|not now)$/i;
/** Where Instagram asks: a box over the page, or a menu. */
const BOXES = '[role="dialog"], [role="alertdialog"], [role="menu"]';

const headerOf = (doc: Document): Element | null => mainOf(doc).querySelector('header');

/** Unfollow in a box over the page, by its own word. */
function unfollowIn(doc: Document): HTMLElement | null {
  for (const box of doc.querySelectorAll(BOXES)) {
    const found = controlsSaying(box, UNFOLLOW)[0];
    if (found) return found;
  }
  return null;
}

/** Closes a box that opened without Unfollow in it, by its own Cancel or Close. */
function closeBoxes(doc: Document): void {
  for (const box of doc.querySelectorAll(BOXES)) controlsSaying(box, CLOSE)[0]?.click();
}

/**
 * Unfollows the account whose page the tab shows: `done` once its header says Follow again; `not_found` when it says
 * Follow already (they aren't followed); `none` when it couldn't, with anything it opened closed again.
 */
export async function unfollow(doc: Document): Promise<'done' | 'not_found' | 'none'> {
  const header = headerOf(doc);
  if (!header) return 'none';
  const following = controlsSaying(header, FOLLOWING)[0];
  if (!following) return controlsSaying(header, FOLLOW, true).length ? 'not_found' : 'none';
  following.click();
  const confirm = await waitFor(() => unfollowIn(doc), 5_000);
  if (!confirm) {
    closeBoxes(doc);
    return 'none';
  }
  confirm.click();
  const done = await waitFor(() => {
    const now = headerOf(doc);
    return now && controlsSaying(now, FOLLOW, true).length ? true : null;
  }, 8_000);
  return done ? 'done' : 'none';
}
