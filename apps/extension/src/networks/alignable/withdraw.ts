/**
 * Withdrawing a connection request the person sent on Alignable (docs/outreach.md, decisions 12 and 98; Facebook's
 * Cancel request), once they tick it in HandsFreeOS or, from 0.97.0, on its own once a day (src/jobs/alignable/
 * withdraw.ts). Only on their business's own page, by Alignable's id for it, and only among their own buttons
 * (`amongTheirOwn`): never a business it suggests, a post or an answer.
 *
 * Alignable's markup for a request that waits isn't known yet: no Check has shown one. So it goes by Alignable's words,
 * as a person reads them: a way to take it back named as such (Cancel request, Withdraw), pressed; or failing that, what
 * the page shows while it waits (Request Sent, Pending) pressed as a button to open that way, never as a link, which
 * could ask again. Then, where Alignable opens a box to be sure, its own Withdraw, Cancel request or Yes, never a bare
 * Cancel, which closes the box. It went once their own Connect shows again. Nothing else is pressed. When something
 * isn't as expected it stops and says so, and the job notes the page's outline (decision 74), so the next Check shows
 * the real controls.
 */
import { shown } from '../facebook/fetch';
import type { ProfileRef } from '../facebook/types';
import type { WithdrawResult } from '../linkedin/withdraw';
import { nameOf, pause, waitFor } from '../looking/looks';
import {
  amongTheirOwn,
  businessPage,
  CONNECT_AT,
  idIn,
  REQUEST_TAKE_BACK as TAKE_BACK,
  REQUEST_WAITS,
  urlOf,
} from './read';

/** The box asking to be sure: its own button. */
const SURE =
  /^(withdraw|withdraw request|cancel request|cancel connection request|yes|yes,? (cancel|withdraw)\b.*|confirm|remove request)$/i;
/** What Alignable draws over the page: a menu the waiting control opens, and the box asking to be sure. */
const OVER_THE_PAGE = '[role="dialog"], [role="alertdialog"], dialog, [role="menu"]';
const CONTROLS = 'button, [role="button"], [role="menuitem"], a[href]';
/** How long what a press opens, and the request gone, are waited on. */
const WAIT_MS = 6_000;
const SETTLE_MS = 800;

/** How withdrawing went on Alignable: LinkedIn's, or nothing to do (`already` gone, or `connected` now). */
export type AlignableWithdrawResult = WithdrawResult | 'already' | 'connected';

const mainOf = (doc: Document): Element => doc.querySelector('main, [role="main"]') ?? doc.body;

/** A link that goes somewhere, which may open another page. */
const goesSomewhere = (control: Element): boolean => {
  const href = control.getAttribute('href');
  return href !== null && href !== '#' && !href.startsWith('javascript:');
};

/**
 * Their own controls on the page saying `words`: turned on, in sight, and among their own buttons. A link to a
 * connection request must carry their id.
 */
function theirControls(
  doc: Document,
  href: string,
  page: ProfileRef,
  words: RegExp,
): HTMLElement[] {
  const main = mainOf(doc);
  return [...main.querySelectorAll<HTMLElement>(CONTROLS)].filter((control) => {
    if (!shown(control) || !words.test(nameOf(control))) return false;
    const url = control.matches('a[href]') ? urlOf(control.getAttribute('href'), href) : null;
    if (url && CONNECT_AT.test(url.pathname)) return idIn(url) === page.id;
    return amongTheirOwn(control, main, href, page);
  });
}

/** A control in a menu or a box over the page, by its words: what a press opened. */
function overThePage(doc: Document, words: RegExp): HTMLElement | null {
  for (const over of doc.querySelectorAll(OVER_THE_PAGE)) {
    const press = [...over.querySelectorAll<HTMLElement>(CONTROLS)].find(
      (control) => shown(control) && words.test(nameOf(control)),
    );
    if (press) return press;
  }
  return null;
}

/** Whether the request to them is gone from their page: nothing of theirs says it waits. */
const gone = (doc: Document, href: string, id: string): boolean => {
  const page = businessPage(doc, href);
  return page?.profile?.id === id && !page.asked;
};

/**
 * Withdraws the request to them, on their business page the tab shows. `not_found` when it isn't their page, or
 * nothing of theirs to press says it waits; `not_sure` when what it pressed opened no way to take it back; `not_gone`
 * when it was pressed but still waits. A link pressed may open another page, so it answers `done` as it presses, and
 * the job opens their page again to see it went.
 */
export async function withdrawOnPage(
  doc: Document,
  href: string,
  profile: ProfileRef,
): Promise<AlignableWithdrawResult> {
  const id = profile.id;
  const page = businessPage(doc, href);
  if (!id || !page?.profile || page.profile.id !== id) return 'not_found';
  if (page.connected) return 'connected';
  if (!page.asked) return page.connect ? 'already' : 'not_found';
  const them = page.profile;
  let press = theirControls(doc, href, them, TAKE_BACK)[0] ?? null;
  if (!press) {
    // What says it waits, as a button that opens a way to take it back: never a link, which could ask again.
    const waiting = theirControls(doc, href, them, REQUEST_WAITS).find((c) => !goesSomewhere(c));
    if (!waiting) return 'not_found';
    waiting.click();
    press = await waitFor(() => overThePage(doc, TAKE_BACK), WAIT_MS);
    if (!press) return 'not_sure';
  }
  press.click();
  if (goesSomewhere(press)) return 'done';
  await pause(SETTLE_MS);
  // Where Alignable asks to be sure, its own button; else the request went without asking.
  const sure = await waitFor(
    () => overThePage(doc, SURE) ?? (gone(doc, href, id) ? 'gone' : null),
    WAIT_MS,
  );
  if (sure && sure !== 'gone') {
    sure.click();
    if (goesSomewhere(sure)) return 'done';
  }
  return (await waitFor(() => gone(doc, href, id), WAIT_MS)) ? 'done' : 'not_gone';
}
