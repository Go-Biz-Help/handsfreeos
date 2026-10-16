/**
 * Withdrawing an invitation the person sent (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "What maps to what":
 * Facebook's Cancel request is LinkedIn's Withdraw), once they've ticked it in HandsFreeOS (src/jobs/linkedin/
 * withdraw.ts): on My Network's Sent invitations, the row about that member, found by the link to their profile and
 * never by a name alone, has its Withdraw pressed; then the box LinkedIn opens to be sure has its own Withdraw
 * pressed; and the row is looked for again until it's gone. Nothing else on the page is pressed. When something isn't
 * as expected (no box, no Withdraw in it, the row still there) it stops and says so, and the job hands the step to the
 * person.
 */
import { shown } from '../facebook/fetch';
import { CONTROLS, mainOf, wordsOf } from './dom';
import { withdrawFor } from './invitations';
import type { ProfileRef } from './types';
import { classifyUrl } from './urls';
import { WITHDRAW } from './vocabulary';

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** What LinkedIn draws over the page: the box asking to be sure. */
const OVER_THE_PAGE = '[role="dialog"], [role="alertdialog"], dialog';
/** The box's own button: "Withdraw". */
const SURE = /^withdraw$/i;
/** How long the box, and the row gone, are waited on, and how often they're looked at. */
const WAIT_MS = 8_000;
const LOOK_MS = 400;

/** How withdrawing went. */
export type WithdrawResult =
  /** Withdrawn: the row is gone. */
  | 'done'
  /** No row of theirs on the page: nothing pressed. */
  | 'not_found'
  /** Withdraw pressed on the row, but no box asking to be sure, with its own Withdraw, showed. */
  | 'not_sure'
  /** Both pressed, but their row is still there. */
  | 'not_gone';

/** The box's Withdraw, once the box is open. */
function sureIn(doc: Document): HTMLElement | null {
  for (const box of doc.querySelectorAll(OVER_THE_PAGE)) {
    if (!shown(box)) continue;
    const press = [...box.querySelectorAll<HTMLElement>(CONTROLS)].find(
      (control) => shown(control) && wordsOf(control).some((words) => SURE.test(words)),
    );
    if (press) return press;
  }
  return null;
}

/** Whether an address is the person's Sent invitations, the only page this presses on. */
export const sentPage = (href: string) => {
  const address = classifyUrl(href);
  return address.kind === 'invitations' && address.invitations === 'sent';
};

/** Withdraws the invitation to this member, on the Sent invitations page the tab shows. */
export async function withdraw(
  doc: Document,
  href: string,
  who: ProfileRef,
): Promise<WithdrawResult> {
  if (!sentPage(href)) return 'not_found';
  const row = withdrawFor(mainOf(doc), href, who);
  if (!(row instanceof doc.defaultView!.HTMLElement) || !shown(row)) return 'not_found';
  if (!wordsOf(row).some((words) => WITHDRAW.test(words))) return 'not_found';
  row.click();
  const gone = () => withdrawFor(mainOf(doc), href, who) === null;
  let sure: HTMLElement | null = null;
  for (let waited = 0; waited < WAIT_MS && !sure; waited += LOOK_MS) {
    await pause(LOOK_MS);
    sure = sureIn(doc);
    // Withdrawn without asking: done.
    if (!sure && gone()) return 'done';
  }
  if (!sure) return 'not_sure';
  sure.click();
  for (let waited = 0; waited < WAIT_MS; waited += LOOK_MS) {
    await pause(LOOK_MS);
    if (gone()) return 'done';
  }
  return 'not_gone';
}
