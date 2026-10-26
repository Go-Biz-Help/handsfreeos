/**
 * Facebook's editors on the person's own profile and in Accounts Center (docs/outreach.md, decision 89): what putting
 * their bio, a link and their username in share, for a **Put these in** they pressed in HandsFreeOS (./own-profile.ts,
 * ./links.ts, ./username.ts), and Check Facebook's tries of each (./tries.ts).
 *
 * - **By Facebook's words, never guessed.** A control is pressed only when it says what it does (Edit bio, Add a
 *   website); a box is written in only when it's the one box that press opened; Save only when it's the one by that
 *   box. Anything else is said, and the job hands that step to the person.
 * - **What it found, step by step** (`EditorSteps`), for the note of the page that goes with a hand-over (decision
 *   74): counts and yes or no, and the names of the buttons there as the outline shows them; never a word anyone wrote.
 *
 * Built from Facebook's usual words for these editors, not yet from a page outline of them: the first Check Facebook
 * sends each one's outline, so they can be tuned from the person's own pages.
 */
import { clean, isAfter, isHeading, labelOf } from './dom';
import { placesOf, shown, visible } from './fetch';

export const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** How long a box, or a change saved, is waited for, and how often it's looked for. */
export const EDITOR_WAIT_MS = 8_000;
export const EDITOR_LOOK_MS = 400;

/** What's pressed: buttons only, never a link that would take the tab elsewhere mid-step. */
export const EDITOR_BUTTONS = 'button, [role="button"], input[type="submit"]';
/** What can be written in: never a password, a code or anything hidden. */
const BOXES = [
  'textarea',
  '[role="textbox"]',
  '[contenteditable="true"]',
  'input:not([type])',
  'input[type="text"]',
  'input[type="url"]',
  'input[type="search"]',
].join(', ');
const CODE_BOX = '[autocomplete="one-time-code"], [inputmode="numeric"]';
const SAVE = /^save$/i;
const CANCEL = /^cancel$/i;

/** The boxes to write in on the page, shown, outside the top bar: the outermost of one inside another. */
export function boxesOn(doc: Document): HTMLElement[] {
  const all = [...doc.querySelectorAll<HTMLElement>(BOXES)].filter(
    (box) => shown(box) && !box.matches(CODE_BOX) && !box.closest('[role="banner"]'),
  );
  return all.filter((box) => !all.some((other) => other !== box && other.contains(box)));
}

/**
 * Presses a control and waits for the box it opens: the one new box to write in, or null with how many opened (none,
 * or more than one, so it couldn't tell which).
 */
export async function newBoxAfter(
  doc: Document,
  press: () => void,
  waitMs = EDITOR_WAIT_MS,
): Promise<{ readonly box: HTMLElement | null; readonly boxes: number }> {
  const before = new Set(boxesOn(doc));
  const fresh = () => boxesOn(doc).filter((box) => !before.has(box));
  press();
  let found: HTMLElement[] = [];
  for (let waited = 0; waited < waitMs && !found.length; waited += EDITOR_LOOK_MS) {
    await pause(EDITOR_LOOK_MS);
    found = fresh();
  }
  // A moment more, for a second box drawn just after the first.
  if (found.length) {
    await pause(EDITOR_LOOK_MS);
    found = fresh();
  }
  return { box: found.length === 1 ? found[0]! : null, boxes: found.length };
}

/** The shown buttons in a place that say one of these words, outside the top bar. */
export function buttonsIn(place: ParentNode, words: RegExp): HTMLElement[] {
  return [...place.querySelectorAll<HTMLElement>(EDITOR_BUTTONS)].filter(
    (b) => words.test(labelOf(b)) && shown(b) && !b.closest('[role="banner"]'),
  );
}

/** The first shown button that says one of these words, in the box on top first (./fetch.ts `placesOf`). */
export function controlIn(doc: Document, words: RegExp): HTMLElement | null {
  for (const place of placesOf(doc)) {
    const found = buttonsIn(place, words)[0];
    if (found) return found;
  }
  return null;
}

/** Where looking up from a box stops: the box over the page it's in, the page's main part, or the page. */
const TOP = '[role="dialog"], [role="main"], body';

/**
 * The button by a box that says one of these words: in the nearest box around it that has any (its form, its row,
 * the box over the page it's in). `on` when the only one is pressable; `count` how many there were, in sight.
 */
export function buttonBy(
  box: Element,
  words: RegExp,
): { readonly found: HTMLElement | null; readonly count: number; readonly on: boolean } {
  for (let at = box.parentElement, up = 0; at && up < 24; at = at.parentElement, up++) {
    const there = [...at.querySelectorAll<HTMLElement>(EDITOR_BUTTONS)].filter(
      (b) => words.test(labelOf(b)) && visible(b),
    );
    if (there.length) {
      const on = there.length === 1 && shown(there[0]!);
      return { found: on ? there[0]! : null, count: there.length, on };
    }
    if (at.matches(TOP)) break;
  }
  return { found: null, count: 0, on: false };
}

/** The box's Save, and its Cancel. */
export const saveBy = (box: Element) => buttonBy(box, SAVE);
export const cancelBy = (box: Element) => buttonBy(box, CANCEL);

/** A box that's closed: taken off the page, or hidden. */
export const gone = (box: Element): boolean => !box.isConnected || !visible(box);

/** What's written in a box: a plain box's value, or a rich box's words. */
export const textOf = (box: HTMLElement): string =>
  'value' in box && typeof box.value === 'string' ? box.value : clean(box.textContent);

/**
 * A part's title on an editor ("Bio"), shown: a heading, or words on their own with nothing inside them, that are
 * exactly these. Never a button's or a link's words.
 */
export function titlesIn(place: ParentNode, words: RegExp): Element[] {
  return [...place.querySelectorAll('*')].filter(
    (e) =>
      (isHeading(e) || e.childElementCount === 0) &&
      words.test(clean(e.textContent)) &&
      !e.closest(`${EDITOR_BUTTONS}, a[href]`) &&
      visible(e),
  );
}

/**
 * The button after a title that says one of these words, before the next heading: the Edit by Bio. It looks in the
 * nearest box around the title that has one, up to the box over the page it's in.
 */
export function buttonAfter(title: Element, words: RegExp): HTMLElement | null {
  for (let at = title.parentElement, up = 0; at && up < 16; at = at.parentElement, up++) {
    const next = [...at.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')].find(
      (h) => isAfter(h, title) && !h.contains(title),
    );
    const found = buttonsIn(at, words).find(
      (b) => isAfter(b, title) && (!next || !isAfter(b, next)),
    );
    if (found) return found;
    if (at.matches(TOP)) break;
  }
  return null;
}

/**
 * What labels a box to write in: its label for screen readers, what it says labels it, the label that names it, the
 * one around it, its placeholder, or the words just above it in the box over the page it's in.
 */
export function fieldName(field: Element): string {
  const doc = field.ownerDocument;
  const own = clean(field.getAttribute('aria-label'));
  if (own) return own;
  const by = clean(
    (field.getAttribute('aria-labelledby') ?? '')
      .split(/\s+/)
      .map((id) => (id ? (doc.getElementById(id)?.textContent ?? '') : ''))
      .join(' '),
  );
  if (by) return by;
  const id = field.getAttribute('id');
  const named = id
    ? [...doc.querySelectorAll('label[for]')].find((label) => label.getAttribute('for') === id)
    : null;
  const label = clean((named ?? field.closest('label'))?.textContent);
  if (label) return label;
  const placeholder = clean(field.getAttribute('placeholder'));
  if (placeholder) return placeholder;
  for (let at: Element | null = field; at && !at.matches(TOP); at = at.parentElement)
    for (let before = at.previousElementSibling; before; before = before.previousElementSibling) {
      if (!visible(before)) continue;
      if (before.matches(BOXES) || before.querySelector(BOXES)) return '';
      const words = clean(before.textContent);
      if (words) return words.length <= 40 ? words : '';
    }
  return '';
}

/**
 * What putting the bio or a link in found, step by step, for the job's note of the page (decision 74): never a word
 * anyone wrote, only counts, yes or no, and the names of the buttons there as the outline shows them.
 */
export interface EditorSteps {
  /** The control that opens the part's box: Edit bio, the Edit by Bio, Add a website. */
  readonly control: boolean;
  /** How many boxes to write in it opened: one is wanted. */
  readonly boxes: number;
  /** What was written reads back from the box. */
  readonly typed: boolean;
  /** How many Saves by the box, and whether the one there was on. */
  readonly saves: number;
  readonly saveOn: boolean;
  /** Save pressed, the box closed, and the change on the page. */
  readonly saved: boolean;
  /** The buttons on the page, or in the box on top, as the outline names them: when something wasn't there. */
  readonly names: readonly string[];
}

export const NO_STEPS: EditorSteps = {
  control: false,
  boxes: 0,
  typed: false,
  saves: 0,
  saveOn: false,
  saved: false,
  names: [],
};

/** What opens each part's box, as a missing step says it. */
const CONTROL_NAMES: Readonly<Record<'bio' | 'links', string>> = {
  bio: 'no Edit bio, Add bio or Edit by Bio on the page',
  links: 'no Add a website on the page',
};

/** What's missing, in the extension's own words, for a note: empty when it all went. */
export function editorMissing(part: 'bio' | 'links', steps: EditorSteps): string[] {
  if (!steps.control) return [CONTROL_NAMES[part]];
  if (steps.boxes !== 1)
    return [
      steps.boxes === 0
        ? 'no box to write in opened'
        : `${steps.boxes} boxes to write in opened, so it couldn’t tell which`,
    ];
  if (!steps.typed) return ['writing in the box didn’t take'];
  if (steps.saves !== 1)
    return [steps.saves === 0 ? 'no Save by the box' : `${steps.saves} Saves by the box`];
  if (!steps.saveOn) return ['Save by the box stayed off'];
  return steps.saved ? [] : ['Save didn’t put it on the page'];
}

/**
 * Facebook's words on its profile's editors and Accounts Center's username page, which the page outline (./outline.ts)
 * shows rather than hides, so an outline of a step it couldn't find says what the buttons there are called. Lower-case.
 */
export const PROFILE_EDIT_WORDS: ReadonlySet<string> = new Set([
  'edit profile',
  'edit bio',
  'add bio',
  'bio',
  'edit',
  'add',
  'save',
  'cancel',
  'close',
  'back',
  'edit links',
  'links',
  'about',
  'overview',
  'contact and basic info',
  'contact info',
  'websites and social links',
  'websites',
  'website',
  'social links',
  'add a website',
  'add website',
  'add a link',
  'add link',
  'add a social link',
  'add social link',
  'accounts center',
  'profiles',
  'personal details',
  'password and security',
  'username',
  'done',
  'continue',
  'confirm',
  'change username',
  'password',
  're-enter your password',
  'enter your password',
  'username available',
  'this username isn’t available',
  "this username isn't available",
  'this username isn’t available. try another.',
  "this username isn't available. try another.",
  'username updated',
  'changes saved',
  'try again later',
]);
