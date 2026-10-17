/**
 * Looking for a step's button on a network still looked at (./site.ts): what each network's looks share. A look finds
 * the controls a person would press by their words, as the network's own pages label them, and says what it found;
 * it never presses anything, writes anything or opens anything. Where what's wanted isn't there, it names what was, as
 * the outline would (the network's own words kept, anything else hidden), so the step can be built from it.
 */
import { clean } from '../facebook/dom';
import { shown, visible } from '../facebook/fetch';
import { went, untried, type StepTry, type TryStep } from '../tries';
import { maskOn } from './read';
import type { LookingSite } from './site';

/** What a person presses: buttons, links drawn as buttons, and menu rows. */
const CONTROLS = 'button, [role="button"], a[href], [role="link"], [role="menuitem"], [role="tab"]';
/** Where a person writes: a plain box, or one drawn to write in. */
const BOXES = 'textarea, input[type="text"], [role="textbox"], [contenteditable="true"]';

/**
 * What a control is called, as a person hears it: its label, the label of the picture inside it (Instagram's Like is
 * an icon labelled "Like"), or its words.
 */
export function nameOf(element: Element): string {
  return (
    clean(element.getAttribute('aria-label')) ||
    clean(element.querySelector('svg[aria-label], img[alt]')?.getAttribute('aria-label')) ||
    clean(element.querySelector('img[alt]')?.getAttribute('alt')) ||
    clean(element.textContent)
  );
}

/** What a box to write in is for: its label, its placeholder, or the label tied to it. */
export function boxName(box: Element): string {
  const id = box.getAttribute('id');
  const label = id
    ? [...box.ownerDocument.querySelectorAll('label[for]')].find(
        (l) => l.getAttribute('for') === id,
      )
    : null;
  return (
    clean(box.getAttribute('aria-label')) ||
    clean(box.getAttribute('placeholder')) ||
    clean(box.getAttribute('aria-placeholder')) ||
    clean(label?.textContent) ||
    clean(box.getAttribute('name'))
  );
}

/** The controls in a part of the page a person can see, whose name says one of these words. */
export function controlsSaying(root: ParentNode, words: RegExp, offToo = false): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(CONTROLS)].filter(
    (c) => (offToo ? visible : shown)(c) && words.test(nameOf(c)),
  );
}

/** The boxes to write in that a person can see, whose name says one of these words. */
export function boxesSaying(root: ParentNode, words: RegExp): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(BOXES)].filter(
    (b) => visible(b) && words.test(boxName(b)),
  );
}

/** The names of the shown controls in a part of the page, as the outline would show them. */
export function namesIn(root: ParentNode, site: LookingSite, most = 16): string[] {
  const mask = maskOn(site);
  const names = [...root.querySelectorAll(CONTROLS)]
    .filter((c) => shown(c))
    .map((c) => mask(nameOf(c)).slice(0, 60))
    .filter(Boolean);
  return [...new Set(names)].slice(0, most);
}

/** The page's main part: its main landmark, else the whole page. */
export const mainOf = (doc: Document): Element =>
  doc.querySelector('main, [role="main"]') ?? doc.body;

/**
 * A look for one button, as most steps are: found, or where things already stand (Following, Connected), or missing,
 * with what was there instead.
 */
export function lookFor(
  step: TryStep,
  root: ParentNode,
  site: LookingSite,
  want: { readonly words: RegExp; readonly name: string },
  already?: { readonly words: RegExp; readonly why: string },
): StepTry {
  const done = already ? controlsSaying(root, already.words, true) : [];
  const found = controlsSaying(root, want.words, true);
  if (!found.length && done.length) return untried(step, already!.why, { already: true });
  return went(
    step,
    { found: found.length, on: found.filter((c) => shown(c)).length },
    found.length ? [] : [`no ${want.name} on the page`],
    found.length ? [] : namesIn(root, site),
  );
}
