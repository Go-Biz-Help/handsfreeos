/**
 * Answering a connection request the person got on Alignable (docs/outreach.md, decision 136), from 0.118.0: once they
 * pressed Confirm or Delete in HandsFreeOS, or the AI said to as they chose. Only on My Network's Requests
 * (`requests-360-table`), only on the row about that business, found by Alignable's id for it in the row's links, or
 * its address in its town where the row carries no id (never by a name alone), and only that row's own buttons: Accept
 * for Confirm; for Delete, its Decline (or Ignore, Delete, Remove: whichever words Alignable puts there). Where Alignable
 * opens a box to be sure, that box's own button with the same words, never a bare Cancel. It went once the row has
 * neither button left, or is gone. A link pressed may open another page, so it answers `done` as it presses, and the
 * job opens Requests again to see it went.
 *
 * Alignable's markup for a request's Decline isn't known yet (the owner's Check of 0.67.0 found the table empty), so it
 * goes by the words a person reads, and the job notes a page it can't work with its outline (decision 74).
 */
import type { AutoResult } from '../facebook/auto';
import { visible } from '../facebook/fetch';
import type { ProfileRef } from '../facebook/types';
import { nameOf, pause, waitFor } from '../looking/looks';
import { businessRef, idIn, linksIn, PART, urlOf } from './read';

/** A request's buttons, by their words. */
const ACCEPT = /^(accept|confirm)$/i;
const DECLINE = /^(decline|ignore|delete|remove|reject)$/i;
/** What Alignable draws over the page: the box asking to be sure. */
const OVER_THE_PAGE = '[role="dialog"], [role="alertdialog"], dialog';
const CONTROLS = 'button, [role="button"], a[href]';
/** How long the box, and the row answered, are waited on. */
const WAIT_MS = 6_000;
const SETTLE_MS = 800;

/** Whether an address is My Network's Requests, the only page this presses on. */
export const requestsPage = (href: string): boolean => {
  const url = urlOf(href, href);
  const [first, second, third] = (url?.pathname ?? '').split('/').filter(Boolean);
  return first === 'biz' && second === 'my_network' && third === 'connection_requests';
};

/** Whether a business a row links to is this one: by Alignable's id when both carry it, else its address in its town. */
const same = (row: ProfileRef, them: ProfileRef): boolean =>
  row.id && them.id ? row.id === them.id : !!row.username && row.username === them.username;

/** The row on Requests about this business: null when no row on the page is theirs. */
export function requestRowFor(doc: Document, href: string, them: ProfileRef): Element | null {
  const table = doc.querySelector(PART('requests-360-table'));
  if (!table) return null;
  for (const row of table.querySelectorAll('tbody tr')) {
    const links = linksIn(row, href);
    const id = links.map(({ url }) => idIn(url)).find((found) => found !== null) ?? null;
    const theirs = links.some(({ url }) => {
      const ref = businessRef(url, idIn(url) ?? id);
      return ref !== null && same(ref, them);
    });
    if (theirs) return row;
  }
  return null;
}

/** A row's own button saying `words`, in sight. */
const buttonIn = (row: Element, words: RegExp): HTMLElement | null =>
  [...row.querySelectorAll<HTMLElement>(CONTROLS)].find(
    (control) => visible(control) && words.test(nameOf(control)),
  ) ?? null;

/** A link that goes somewhere, which may open another page. */
const goesSomewhere = (control: Element): boolean => {
  const href = control.getAttribute('href');
  return href !== null && href !== '#' && !href.startsWith('javascript:');
};

/**
 * Answers the request from this business on the Requests page the tab shows. `none` when it isn't that page, no row is
 * theirs, or their row has no such button; `not_sent` when it was pressed but their row still has it.
 */
export async function answerOnRequests(
  doc: Document,
  href: string,
  them: ProfileRef,
  answer: 'confirm' | 'delete',
): Promise<AutoResult> {
  if (!requestsPage(href)) return 'none';
  const row = requestRowFor(doc, href, them);
  if (!row) return 'none';
  const words = answer === 'confirm' ? ACCEPT : DECLINE;
  const press = buttonIn(row, words);
  if (!press) return 'none';
  press.click();
  if (goesSomewhere(press)) return 'done';
  await pause(SETTLE_MS);
  const answered = () => {
    const now = requestRowFor(doc, href, them);
    return !now || (!buttonIn(now, ACCEPT) && !buttonIn(now, DECLINE));
  };
  // Where Alignable asks to be sure, its own button with the same words; else it went without asking.
  const next = await waitFor<HTMLElement | 'answered'>(() => {
    if (answered()) return 'answered';
    for (const box of doc.querySelectorAll(OVER_THE_PAGE)) {
      const sure = [...box.querySelectorAll<HTMLElement>(CONTROLS)].find(
        (control) => visible(control) && words.test(nameOf(control)),
      );
      if (sure) return sure;
    }
    return null;
  }, WAIT_MS);
  if (next === 'answered') return 'done';
  if (!next) return 'not_sent';
  next.click();
  if (goesSomewhere(next)) return 'done';
  return (await waitFor(() => (answered() ? true : null), WAIT_MS)) ? 'done' : 'not_sent';
}
