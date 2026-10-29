/**
 * Filling in a form on the person's own profile (docs/outreach.md, decision 99), for a **Put these in** they pressed in
 * HandsFreeOS: what putting their work, a featured link, LinkedIn's custom address and website, Alignable's Elevator
 * Pitch, ideal customer and partner and a service share on every network (./facebook/parts.ts, ./linkedin/parts.ts,
 * ./alignable/parts.ts).
 *
 * - **By the network's words, never guessed.** The control that opens the form is pressed only when it says what it
 *   does (Add a workplace, Add position); each field is written in only when it's the one the form labels for it
 *   (Company, Title, Description); a tick is changed only when its words say what it is (I currently work here, Share
 *   with network); Save only when it's the one in the form. A field the form doesn't have and needs, or two where one
 *   is wanted, and nothing is written: the job hands that step to the person, with the form left open.
 * - **What it found, step by step** (`FillSteps`), for the note of the page that goes with a hand-over (decision 74):
 *   counts and yes or no, the extension's own names for the fields it couldn't find, and the form's names for its
 *   fields as the outline shows them; never a word anyone wrote.
 * - **Only what shows is said to be in.** It waits for the form to close and the part to show on the page
 *   (`FormSpec.shows`); saved but not showing is `not_saved`, and the job says where to check it.
 *
 * Built from each network's usual words for these forms, not yet from a page outline of them: a part that doesn't go in
 * sends the outline of where it stopped, so they can be tuned from the person's own pages.
 */
import { clean } from './facebook/dom';
import { EDITOR_BUTTONS, fieldName, pause } from './facebook/editors';
import { nameOf, shown, visible } from './facebook/fetch';
import { typeInto } from './facebook/join';
import { waitFor, writeIn } from './looking/looks';

/** One part of the person's own profile to put in on the page the tab shows (decision 99). */
export type PartWrite =
  /** Their work: a title and a company, with a few words and when they started, where the form has them. */
  | {
      readonly kind: 'work';
      readonly title: string;
      readonly company: string;
      readonly words: string | null;
      /** "2021-03". */
      readonly since: string | null;
    }
  /** Their best post, featured: found by its first words, on their profile or their posts. */
  | { readonly kind: 'feature_post'; readonly post: string }
  /** A link featured (LinkedIn's booking link). */
  | { readonly kind: 'feature_link'; readonly link: string }
  /** A link there taken off (Facebook's, decision 99's answer 16a). */
  | { readonly kind: 'link_off'; readonly link: string }
  /** A website added (LinkedIn's Contact info). */
  | { readonly kind: 'link_add'; readonly link: string }
  /** The profile's own address (LinkedIn's custom URL). */
  | { readonly kind: 'username'; readonly username: string }
  /** Alignable's Elevator Pitch. */
  | { readonly kind: 'pitch'; readonly words: string }
  /** Alignable's My Ideal Customer, or its ideal partner: a few words. */
  | { readonly kind: 'ideal'; readonly who: 'customer' | 'partner'; readonly words: string }
  /** One of Alignable's services: its name and a few words. */
  | { readonly kind: 'service'; readonly name: string; readonly words: string | null };

export type PartKind = PartWrite['kind'];

/** How putting a part in went. */
export type PartResult =
  /** In, and showing. */
  | 'done'
  /** On the page already as it would be: left as it is. */
  | 'already'
  /** Something wasn't as expected: the person does it. */
  | 'none'
  /** Saved, but the form stayed open, or the part didn't show after. */
  | 'not_saved'
  /** The network asks for the code it emailed them first (Alignable's). */
  | 'code'
  /** Its form is on a page of its own: `next` is its address, which the job opens before asking again. */
  | 'elsewhere';

/** What filling a form found, step by step: never a word anyone wrote. */
export interface FillSteps {
  /** The control that opens it (Add a workplace, Add position), or the form open already. */
  readonly opener: boolean;
  /** A form opened, with fields in it. */
  readonly form: boolean;
  /** How many fields to write in it has. */
  readonly fields: number;
  /** The extension's names for the fields it needs and couldn't tell (none there, or more than one). */
  readonly missing: readonly string[];
  /** What was written reads back from each field. */
  readonly typed: boolean;
  /** How many Saves in the form. */
  readonly saves: number;
  /** Save pressed, the form closed, and the part showing. */
  readonly saved: boolean;
  /** The form's names for its fields, or the page's buttons when there was no form, as the outline shows them. */
  readonly names: readonly string[];
}

export const NO_FILL: FillSteps = {
  opener: false,
  form: false,
  fields: 0,
  missing: [],
  typed: false,
  saves: 0,
  saved: false,
  names: [],
};

/** The answer to a part put in: how it went, and what it found. */
export interface PartWrote {
  readonly result: PartResult;
  readonly steps: FillSteps;
  /** Where its form is, for `elsewhere`. */
  readonly next?: string | null;
}

/** What's missing, in the extension's own words, for a note: empty when it all went. */
export function fillMissing(steps: FillSteps): string[] {
  if (!steps.opener) return ['nothing on the page to open it with'];
  if (!steps.form) return ['no form to fill in opened'];
  if (steps.missing.length) return [`no field, or more than one, for ${steps.missing.join(', ')}`];
  if (!steps.typed) return ['writing in the form didn’t take'];
  if (steps.saves !== 1)
    return [steps.saves === 0 ? 'no Save in the form' : `${steps.saves} Saves in the form`];
  return steps.saved ? [] : ['Save didn’t put it on the page'];
}

/** A field to fill in. */
export interface Field {
  /** The extension's own name for it, for a note: "Title", "Company". */
  readonly name: string;
  /** What labels it on the network's form. */
  readonly label: RegExp;
  readonly value: string;
  /** Left as it is when the form has none. */
  readonly optional?: boolean;
  /** The first of several with this label (LinkedIn's start date's Month and Year, before the end date's). */
  readonly first?: boolean;
  /** With none labelled for it, the form's only field to write a few lines in (Alignable's boxes, unnamed). */
  readonly alone?: boolean;
}

/** A tick in the form, put as wanted when it's there: never one whose words don't say what it is. */
export interface Tick {
  readonly label: RegExp;
  readonly on: boolean;
}

export interface FormSpec {
  /** What opens the form; none when the page is the form. */
  readonly opener?: (() => HTMLElement | null) | null;
  readonly fields: readonly Field[];
  readonly ticks?: readonly Tick[];
  /** What saves it: Save, unless the form says otherwise. */
  readonly save?: RegExp;
  /** Whether the part shows on the page, once the form has closed. */
  readonly shows: () => boolean;
  /** The network's words kept, the rest hidden: for the names in the note. */
  readonly mask: (text: string) => string;
  /** The form stays on the page after Save (one on a page of its own): only the part showing is waited for. */
  readonly stays?: boolean;
  /** Once the opener's pressed, before the form's fields are looked for (Alignable's pitch: words over a video). */
  readonly afterOpen?: () => Promise<void>;
  /** Everywhere the network draws on the page (LinkedIn's interop box): the page alone, unless said. */
  readonly places?: (doc: Document) => readonly ParentNode[];
}

/** Where a person writes in a form: never a password, a code, a search or anything hidden. */
const FIELDS = [
  'textarea',
  'select',
  'input:not([type])',
  'input[type="text"]',
  'input[type="url"]',
  '[role="textbox"]',
  '[contenteditable="true"]',
].join(', ');
const NOT_FIELDS = '[autocomplete="one-time-code"], [type="search"], [role="searchbox"]';
const TICKS = 'input[type="checkbox"], [role="checkbox"], [role="switch"]';
/** Where a form is: a box over the page first, then a form on it. */
const FORMS = '[role="dialog"], dialog[open], form';
const SAVE = /^save$/i;

/** The fields in a place that a person can see. */
export function fieldsIn(place: ParentNode): HTMLElement[] {
  const all = [...place.querySelectorAll<HTMLElement>(FIELDS)].filter(
    (field) => visible(field) && !field.matches(NOT_FIELDS) && !field.closest('[role="banner"]'),
  );
  return all.filter((field) => !all.some((other) => other !== field && other.contains(field)));
}

/**
 * What labels a field: what the page says labels it (./facebook/editors.ts `fieldName`), or, for a list to pick from
 * with nothing else, its first choice when that's only a prompt ("Month", "Year").
 */
export function fieldLabel(field: Element): string {
  if (field.tagName === 'SELECT') {
    const select = field as HTMLSelectElement;
    const own =
      clean(select.getAttribute('aria-label')) ||
      clean(field.closest('label')?.textContent?.replace(clean(select.textContent), ''));
    if (own) return own;
    const prompt = select.options[0];
    if (prompt && !prompt.value) return clean(prompt.textContent);
  }
  return fieldName(field);
}

/** The forms open on the page, nearest the top first: boxes over the page, then forms on it. */
function formsOn(places: readonly ParentNode[]): Element[] {
  const all = places
    .flatMap((place) => [...place.querySelectorAll(FORMS)])
    .filter((form) => visible(form) && fieldsIn(form).length > 0);
  // A form inside a box over the page is that box's.
  return all
    .filter((form) => !all.some((other) => other !== form && other.contains(form)))
    .sort(
      (a, b) =>
        Number(b.matches('[role="dialog"], dialog')) - Number(a.matches('[role="dialog"], dialog')),
    );
}

/** The form that has the fields wanted: the one with a field for the first one it needs. */
function formFor(places: readonly ParentNode[], fields: readonly Field[]): Element | null {
  const needed = fields.find((field) => !field.optional) ?? fields[0];
  if (!needed) return null;
  const forms = formsOn(places);
  return (
    forms.find((form) => fieldsIn(form).some((field) => needed.label.test(fieldLabel(field)))) ??
    // A box over the page with one field to write a few lines in, for a field that may be unnamed.
    (needed.alone
      ? forms.find(
          (form) =>
            form.matches('[role="dialog"], dialog') &&
            fieldsIn(form).filter((f) => f.tagName === 'TEXTAREA' || f.isContentEditable).length ===
              1,
        )
      : undefined) ??
    null
  );
}

/** A field's words now: a plain field's value, a list's choice, or a drawn box's words. */
export const fieldValue = (field: HTMLElement): string => {
  if (field.tagName === 'SELECT') {
    const select = field as HTMLSelectElement;
    return clean(select.options[select.selectedIndex]?.textContent);
  }
  return clean(
    'value' in field && typeof field.value === 'string' ? field.value : field.textContent,
  );
};

/** Picks a list's choice by its words (or its value): whether it took. */
function pick(field: HTMLSelectElement, value: string): boolean {
  const want = clean(value).toLowerCase();
  const option = [...field.options].find(
    (o) => clean(o.textContent).toLowerCase() === want || o.value.toLowerCase() === want,
  );
  if (!option) return false;
  const view = field.ownerDocument.defaultView!;
  const setter = Object.getOwnPropertyDescriptor(view.HTMLSelectElement.prototype, 'value')?.set;
  if (setter) setter.call(field, option.value);
  else field.value = option.value;
  field.dispatchEvent(new view.Event('input', { bubbles: true }));
  field.dispatchEvent(new view.Event('change', { bubbles: true }));
  return field.value === option.value;
}

/** Choices a typed field offers to pick from (a company, a city): the one that says exactly what was typed. */
async function pickOffered(
  places: readonly ParentNode[],
  field: HTMLElement,
  value: string,
): Promise<void> {
  if (field.getAttribute('role') !== 'combobox' && !field.hasAttribute('aria-autocomplete')) return;
  await pause(800);
  const want = clean(value).toLowerCase();
  const offered = places
    .flatMap((place) => [...place.querySelectorAll<HTMLElement>('[role="option"]')])
    .find((option) => shown(option) && clean(nameOf(option)).toLowerCase().startsWith(want));
  offered?.click();
  if (offered) await pause(300);
}

/** Writes in one field in place of what's there: whether it reads back. */
async function write(
  doc: Document,
  places: readonly ParentNode[],
  field: HTMLElement,
  value: string,
): Promise<boolean> {
  if (field.tagName === 'SELECT') return pick(field as HTMLSelectElement, value);
  writeIn(doc, field, value);
  await pause(250);
  if (fieldValue(field) !== clean(value)) {
    typeInto(doc, field, value, true);
    await pause(250);
  }
  await pickOffered(places, field, value);
  // A typed field that picked a choice may show the choice's fuller words ("Gee Consulting LLC").
  return fieldValue(field).toLowerCase().startsWith(clean(value).toLowerCase());
}

/** Whether a tick is on. */
const isOn = (tick: Element): boolean =>
  tick instanceof tick.ownerDocument.defaultView!.HTMLInputElement
    ? tick.checked
    : tick.getAttribute('aria-checked') === 'true';

/** Puts each tick the form has as wanted, by its words: one that isn't there is left. */
async function putTicks(form: Element, ticks: readonly Tick[]): Promise<void> {
  for (const want of ticks) {
    const found = [...form.querySelectorAll<HTMLElement>(TICKS)].filter(
      (tick) =>
        visible(tick) &&
        want.label.test(fieldName(tick) || clean(tick.closest('label')?.textContent)),
    );
    if (found.length !== 1) continue;
    const tick = found[0]!;
    if (isOn(tick) !== want.on) {
      tick.click();
      await pause(300);
    }
  }
}

/** The form's names for its fields, as the outline shows them. */
const namesOf = (form: Element, mask: (text: string) => string): string[] =>
  fieldsIn(form)
    .slice(0, 12)
    .map((field) => mask(fieldLabel(field)).slice(0, 60) || '(no name)');

/** The buttons on the page, as the outline shows them: when there was no form. */
const buttonsOf = (doc: Document, mask: (text: string) => string): string[] =>
  [
    ...new Set(
      [...(doc.querySelector('[role="main"]') ?? doc.body).querySelectorAll(EDITOR_BUTTONS)]
        .filter((b) => shown(b))
        .map((b) => mask(nameOf(b)).slice(0, 60))
        .filter(Boolean),
    ),
  ].slice(0, 16);

/** How long a form, and the part saved, are waited for. */
export const FILL_WAIT_MS = 10_000;

/**
 * Fills in a form: opens it (or finds it open), writes each field it has a label for, puts its ticks, presses its one
 * Save, and waits for it to close and the part to show. Nothing is written unless every field it needs is there once.
 */
export async function fillForm(doc: Document, spec: FormSpec): Promise<PartWrote> {
  const places = () => spec.places?.(doc) ?? [doc];
  let form = formFor(places(), spec.fields);
  let steps: FillSteps = { ...NO_FILL, opener: form !== null };
  if (!form) {
    const opener = spec.opener?.() ?? null;
    if (!opener) return { result: 'none', steps: { ...steps, names: buttonsOf(doc, spec.mask) } };
    steps = { ...steps, opener: true };
    opener.click();
    await spec.afterOpen?.();
    form = await waitFor(() => formFor(places(), spec.fields), FILL_WAIT_MS);
    if (!form) {
      // A box over the page drawn before its fields: the names of what's there now.
      const open = formsOn(places())[0];
      return {
        result: 'none',
        steps: { ...steps, names: open ? namesOf(open, spec.mask) : buttonsOf(doc, spec.mask) },
      };
    }
    // Drawn before what's in it: a moment more, and found again.
    await pause(400);
    form = formFor(places(), spec.fields) ?? form;
  }
  const fields = fieldsIn(form);
  steps = { ...steps, form: true, fields: fields.length, names: namesOf(form, spec.mask) };
  const missing: string[] = [];
  const found: [HTMLElement, Field][] = [];
  const long = fields.filter(
    (field) =>
      field.tagName === 'TEXTAREA' ||
      field.isContentEditable ||
      field.getAttribute('role') === 'textbox',
  );
  for (const want of spec.fields) {
    const labelled = fields.filter((field) => want.label.test(fieldLabel(field)));
    const these = !labelled.length && want.alone && long.length === 1 ? long : labelled;
    if (!these.length || (these.length > 1 && !want.first)) {
      if (!want.optional || these.length > 1) missing.push(want.name);
      continue;
    }
    found.push([these[0]!, want]);
  }
  steps = { ...steps, missing };
  if (missing.length) return { result: 'none', steps };
  let typed = true;
  for (const [field, want] of found)
    typed = (await write(doc, places(), field, want.value)) && typed;
  steps = { ...steps, typed };
  if (!typed) return { result: 'none', steps };
  await putTicks(form, spec.ticks ?? []);
  const words = spec.save ?? SAVE;
  // A box over the page keeps its Save under the form in it: looked for in the box.
  const around = form.closest('[role="dialog"], dialog') ?? form;
  const saves = [...around.querySelectorAll<HTMLElement>(EDITOR_BUTTONS)].filter(
    (b) => visible(b) && words.test(nameOf(b) || clean(b.getAttribute('value'))),
  );
  steps = { ...steps, saves: saves.length };
  if (saves.length !== 1 || !shown(saves[0]!)) return { result: 'none', steps };
  saves[0]!.click();
  const kept = await waitFor(
    () => ((spec.stays || !form!.isConnected || !visible(form!)) && spec.shows() ? true : null),
    FILL_WAIT_MS,
  );
  return kept
    ? { result: 'done', steps: { ...steps, saved: true } }
    : { result: 'not_saved', steps };
}

/** "2021-03" as a form asks for it: March, and 2021. */
export function sinceParts(since: string | null): { month: string; year: string } | null {
  const m = since ? /^(\d{4})-(\d{2})$/.exec(since) : null;
  if (!m) return null;
  const month = new Date(Date.UTC(2000, Number(m[2]) - 1, 1)).toLocaleString('en-US', {
    month: 'long',
    timeZone: 'UTC',
  });
  return { month, year: m[1]! };
}

/** The first shown control on the page that says one of these words, outside the top bar. */
export function controlSaying(root: ParentNode, words: RegExp): HTMLElement | null {
  return (
    [...root.querySelectorAll<HTMLElement>(`${EDITOR_BUTTONS}, a[href], [role="menuitem"]`)].find(
      (c) => shown(c) && !c.closest('[role="banner"]') && words.test(nameOf(c)),
    ) ?? null
  );
}

/** A menu's items in sight: its rows, or its buttons. */
const MENU_ITEMS =
  '[role="menuitem"], [role="menuitemradio"], [role="option"], [role="menu"] [role="button"], [role="menu"] button';

/** Presses a control and waits for the menu it opens: its items in sight, none when nothing opened. */
export async function openMenu(
  doc: Document,
  control: HTMLElement,
  places: readonly ParentNode[] = [doc],
): Promise<HTMLElement[]> {
  const all = () => places.flatMap((place) => [...place.querySelectorAll<HTMLElement>(MENU_ITEMS)]);
  const before = new Set(all());
  control.click();
  return (
    (await waitFor(() => {
      const items = all().filter((item) => shown(item) && !before.has(item));
      return items.length ? items : null;
    }, 5_000)) ?? []
  );
}

/** Closes a menu with nothing pressed: Escape. */
export function closeMenu(doc: Document): void {
  const view = doc.defaultView;
  if (view)
    (doc.activeElement ?? doc.body).dispatchEvent(
      new view.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }),
    );
}

/** Presses a control, then the item of the menu it opens that says one of these words: whether it could. */
export async function pressFromMenu(
  doc: Document,
  control: HTMLElement,
  item: RegExp,
  places: readonly ParentNode[] = [doc],
): Promise<boolean> {
  const found = (await openMenu(doc, control, places)).find((c) => item.test(nameOf(c)));
  if (!found) {
    closeMenu(doc);
    return false;
  }
  found.click();
  return true;
}

/** The shown buttons in the boxes over the page that say one of these words. */
export function dialogButtons(
  doc: Document,
  words: RegExp,
  places: readonly ParentNode[] = [doc],
): HTMLElement[] {
  return places
    .flatMap((place) => [...place.querySelectorAll('[role="dialog"], dialog[open]')])
    .filter((d) => visible(d))
    .flatMap((d) => [...d.querySelectorAll<HTMLElement>(EDITOR_BUTTONS)])
    .filter((b) => shown(b) && words.test(nameOf(b)));
}
