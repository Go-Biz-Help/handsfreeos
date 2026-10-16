/**
 * What needs the person, in one line under Next up (docs/outreach.md, decision 72): "3 things need you in HandsFreeOS",
 * a link to Needs you on HandsFreeOS's Today, where they OK, change, skip and carry on. The panel shows progress and
 * activity only, so nothing waiting is listed or answered here.
 *
 * The count is the icon's: the background keeps HandsFreeOS's last answer (../hfos/waiting.ts), and this draws it,
 * and again whenever it changes. Nothing shows when none wait, or while the answer kept isn't for who's signed in and
 * the business they save to.
 */
import {
  BUSINESS_KEY,
  PLACE_KEY,
  WAITING_FOR_KEY,
  type Account,
  type Waiting,
} from '../hfos/messages';
import { needsYouUrl, needsYouWords } from '../hfos/needs-you';
import { ask } from './ask';
import { hfosLink } from './dom';

interface Whose {
  readonly userId: string;
  readonly businessId: string;
}

/** What the background kept, as the panel reads it: whose it is, and the list. */
interface Kept extends Whose {
  readonly list: Pick<Waiting, 'count'>;
}

let box: HTMLElement | null = null;
let stored: Kept | null = null;
let place: Whose | null = null;
let picked: string | null = null;
/** Where the link goes: HandsFreeOS on the web, and the business the person works for. */
let where: { readonly webUrl: string; readonly businessId: string } | null = null;

const isWhose = (value: unknown): value is Whose =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Whose).userId === 'string' &&
  typeof (value as Whose).businessId === 'string';

const isKept = (value: unknown): value is Kept =>
  isWhose(value) && typeof (value as Kept).list?.count === 'number';

/** The count kept, when it's for the person signed in and the business they save to now. */
function count(): number {
  const kept = stored;
  if (!kept || !place || !where) return 0;
  const theirs =
    kept.userId === place.userId &&
    kept.businessId === place.businessId &&
    kept.businessId === where.businessId &&
    (picked === null || picked === kept.businessId);
  return theirs ? kept.list.count : 0;
}

function draw(): void {
  if (!box) return;
  const words = needsYouWords(count());
  box.hidden = !words || !where;
  if (!words || !where) return box.replaceChildren();
  box.replaceChildren(hfosLink(words, needsYouUrl(where.webUrl, where.businessId)));
}

/** Who's signed in, and the business they work for: the link goes to its Needs you. */
export function needsFor(account: Account | null): void {
  where =
    account?.signedIn && account.businessId
      ? { webUrl: account.webUrl, businessId: account.businessId }
      : null;
  draw();
}

/** Asks the background to look again: when the panel opens, and when the person signs in or picks a business. */
export async function refreshNeeds(): Promise<void> {
  const answer = await ask({ type: 'hfos-waiting' });
  // Signed out, or Social Outreach turned off there: nothing waits.
  if (answer.ok && answer.value === null) {
    stored = null;
    draw();
  }
}

/** Draws the line into `into`, and again whenever the background keeps a new count or the place changes. */
export function startNeeds(into: HTMLElement): void {
  box = into;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!(WAITING_FOR_KEY in changes) && !(PLACE_KEY in changes) && !(BUSINESS_KEY in changes))
      return;
    if (WAITING_FOR_KEY in changes) {
      const next: unknown = changes[WAITING_FOR_KEY]!.newValue;
      stored = isKept(next) ? next : null;
    }
    if (PLACE_KEY in changes) {
      const next: unknown = changes[PLACE_KEY]!.newValue;
      place = isWhose(next) ? next : null;
    }
    if (BUSINESS_KEY in changes) {
      const next: unknown = changes[BUSINESS_KEY]!.newValue;
      picked = typeof next === 'string' ? next : null;
    }
    draw();
  });
  void chrome.storage.local
    .get([WAITING_FOR_KEY, PLACE_KEY, BUSINESS_KEY])
    .then((found) => {
      const list: unknown = found[WAITING_FOR_KEY];
      const whose: unknown = found[PLACE_KEY];
      const business: unknown = found[BUSINESS_KEY];
      stored = isKept(list) ? list : null;
      place = isWhose(whose) ? whose : null;
      picked = typeof business === 'string' ? business : null;
      draw();
    })
    .catch(() => undefined);
  void refreshNeeds();
}
