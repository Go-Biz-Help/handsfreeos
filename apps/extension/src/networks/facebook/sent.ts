/**
 * Cancelling a friend request the person sent, from the list View sent requests opens over their friend requests
 * (docs/outreach.md, decisions 12, 17 and 121). From 0.110.1 this is how requests are cancelled, Cancel all's among
 * them: the owner's report of 29 Oct 2026 found a profile's Cancel request couldn't always be found, while the list has
 * one beside everyone. Their row is found by the link to their profile, never by a name alone; its own Cancel request
 * is pressed, then Facebook's box asking to be sure when one opens; and the row is checked after.
 */
import { labelOf } from './dom';
import { CANCEL, requestRows, shown, shownControls, type Row } from './friends';
import type { ProfileRef } from './types';
import { profileKey } from './urls';

/**
 * How it went: `done` once their row no longer says Cancel request; `pressed` when it still did after the wait;
 * `not_found` when the list isn't open or has no request of theirs to cancel, so nothing was pressed.
 */
export type CancelSentResult = 'done' | 'pressed' | 'not_found';

/** How long it waits for the row to change once Cancel request is pressed, and how often it looks. */
const WAIT_MS = 8_000;
const LOOK_AGAIN_MS = 300;
/** The box asking to be sure: its Confirm, Yes, or Cancel request. */
const SURE = /^(?:confirm|yes|cancel request)$/i;

/** The boxes over the page. */
const boxesIn = (doc: Document) => [
  ...doc.querySelectorAll('[role="dialog"], [role="alertdialog"]'),
];

/** The list View sent requests opened: the box over the page whose rows are requests you've sent. */
export function sentList(doc: Document, base: string): Element | null {
  for (const box of boxesIn(doc).reverse()) {
    if (!shown(box)) continue;
    for (const row of requestRows(box, base).values()) if (row.row === 'sent') return box;
  }
  return null;
}

/** The keys a profile goes by: its number's and its username's, whichever it has, as a row's link may use either. */
const keysOf = (profile: ProfileRef): string[] => [
  ...(profile.id ? [profileKey({ ...profile, username: null })] : []),
  ...(profile.username ? [profileKey({ ...profile, id: null })] : []),
];

/** Their row in the list, about them by the link to their profile. */
export function rowFor(list: Element, base: string, profile: ProfileRef): Row | null {
  const rows = requestRows(list, base);
  for (const key of keysOf(profile)) {
    const row = rows.get(key);
    if (row) return row;
  }
  return null;
}

/** A row's own Cancel request, when it shows one. */
export function cancelIn(row: Row): HTMLElement | null {
  if (row.row !== 'sent') return null;
  return (shownControls(row.box).find((c) => CANCEL.test(labelOf(c))) as HTMLElement) ?? null;
}

/** Facebook's box asking to be sure, opened by the press: one that wasn't there before it, and isn't the list. */
function sureIn(doc: Document, list: Element, before: ReadonlySet<Element>): HTMLElement | null {
  for (const box of boxesIn(doc)) {
    if (before.has(box) || box === list || box.contains(list) || list.contains(box) || !shown(box))
      continue;
    const yes = [...box.querySelectorAll('[role="button"], button')].find(
      (b) => shown(b) && SURE.test(labelOf(b)),
    );
    if (yes) return yes as HTMLElement;
  }
  return null;
}

/**
 * Presses Cancel request beside them in Sent requests, and the box asking to be sure when one opens, then waits for
 * their row to stop saying Cancel request: gone from the list, or saying it's cancelled, or offering Add friend again.
 */
export async function cancelSent(
  doc: Document,
  base: string,
  profile: ProfileRef,
  waitMs = WAIT_MS,
): Promise<CancelSentResult> {
  const list = sentList(doc, base);
  const row = list && rowFor(list, base, profile);
  const button = row && cancelIn(row);
  if (!list || !button) return 'not_found';
  const before = new Set(boxesIn(doc));
  button.click();
  let sure = false;
  const until = Date.now() + waitMs;
  for (;;) {
    await new Promise((done) => setTimeout(done, LOOK_AGAIN_MS));
    const yes = sure ? null : sureIn(doc, list, before);
    if (yes) {
      yes.click();
      sure = true;
      continue;
    }
    // A list Facebook drew again is looked for afresh; one that went altogether says nothing either way.
    const now = list.isConnected ? list : sentList(doc, base);
    if (now) {
      const after = rowFor(now, base, profile);
      if (!after || !cancelIn(after)) return 'done';
    }
    if (Date.now() >= until) return 'pressed';
  }
}
