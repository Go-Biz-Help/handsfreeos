/**
 * The rest of the person's own LinkedIn profile (docs/outreach.md, decision 99), for a **Put these in** they pressed in
 * HandsFreeOS, beside the headline, the About and the name (./own-profile.ts). From 0.98.0 nothing of it is handed over
 * unless a step isn't as expected:
 *
 * - **Their address**, on Public profile & URL: the pencil by **Edit your custom URL**, the one field it opens, Save,
 *   and the page saying linkedin.com/in/ and the new one.
 * - **A website**, in Contact info: its pencil, **Add website**, the new URL in the one field that adds, Save.
 * - **Their work**, under Experience: **Add position** (from the + by Experience, or its menu), with the title, the
 *   company, the few words the AI wrote and when they started; **I am currently working in this role** ticked, and
 *   **Notify network** (or Share with network) turned off, so nothing's posted (../fill.ts). Where the profile has
 *   no + to press, the job opens Add position's own address.
 * - **The booking link featured**: the + by Featured (**Add featured**), then **Add a link**, the link, Add, then Save.
 * - **Their best post featured**: on their posts, found by its first words, its menu, then **Feature on top of
 *   profile**.
 *
 * Built from LinkedIn's usual words for these, not yet from a page outline of them: one that doesn't go in sends the
 * outline of where it stopped, so they can be tuned from the person's own pages.
 */
import { clean } from '../facebook/dom';
import { EDITOR_BUTTONS, newBoxAfter, pause } from '../facebook/editors';
import { nameOf, shown, visible } from '../facebook/fetch';
import { sameLink } from '../facebook/links';
import {
  closeMenu,
  controlSaying,
  dialogButtons,
  fieldsIn,
  fillForm,
  NO_FILL,
  openMenu,
  sinceParts,
  type FillSteps,
  type PartWrite,
  type PartWrote,
} from '../fill';
import { waitFor, writeIn } from '../looking/looks';
import { mainOf, placesOf } from './dom';
import { maskText } from './outline';

const squash = (text: string | null | undefined): string =>
  clean(text).toLowerCase().replace(/\s+/g, '');

/** Everywhere on the page LinkedIn draws: its interop box too. */
const places = (doc: Document): readonly ParentNode[] => placesOf(doc);

/** Whether the page, or a box over it, says these words. */
const says = (doc: Document, words: string): boolean =>
  places(doc).some((place) =>
    squash(
      'body' in place ? (place as Document).body?.textContent : (place as ShadowRoot).textContent,
    ).includes(squash(words)),
  );

/** Whether a link shows on the page, or a box over it: as a link, or as its words. */
function linkHere(doc: Document, link: string): boolean {
  return places(doc).some(
    (place) =>
      [...place.querySelectorAll('a[href]')].some((a) =>
        sameLink(a.getAttribute('href') ?? '', link),
      ) ||
      [...place.querySelectorAll('span, div, p')].some(
        (e) => e.childElementCount === 0 && sameLink(clean(e.textContent), link),
      ),
  );
}

/** The first control in sight anywhere LinkedIn draws that says one of these words. */
const controlHere = (doc: Document, words: RegExp): HTMLElement | null => {
  for (const place of places(doc)) {
    const found = controlSaying(place, words);
    if (found) return found;
  }
  return null;
};

// ------------------------------------------------------------------------------------------------ the address

const EDIT_URL = /^edit\b.*\bcustom url\b|^edit your (public profile )?url$/i;
const URL_FIELD = /custom url|linkedin\.com\/in\/?|public profile url|^url$/i;

/** Their address, on Public profile & URL. In already when the page says it. */
async function writeUsername(doc: Document, username: string): Promise<PartWrote> {
  const at = `linkedin.com/in/${username}`;
  if (says(doc, at)) return { result: 'already', steps: NO_FILL };
  return fillForm(doc, {
    opener: () => controlHere(doc, EDIT_URL),
    fields: [{ name: 'Custom URL', label: URL_FIELD, value: username }],
    shows: () => says(doc, at),
    mask: maskText,
    places,
    // Its box closes back into the page's words.
    stays: true,
  });
}

// ------------------------------------------------------------------------------------------------ a website

const EDIT_CONTACT = /^edit contact info$/i;
const ADD_WEBSITE = /^\+?\s*add (a )?website$/i;
const WEBSITE_TYPE = /^(website )?type$/i;
const SAVE = /^save$/i;

/** The box over the page with Add website in it: Contact info's form. */
const contactForm = (doc: Document): Element | null =>
  places(doc)
    .flatMap((place) => [...place.querySelectorAll('[role="dialog"], dialog[open]')])
    .find((box) => visible(box) && controlSaying(box, ADD_WEBSITE) !== null) ?? null;

/**
 * A website in Contact info: its pencil (when its form isn't open), Add website, the address in the one field that
 * adds, its type where it asks (Company, else Other), Save, and the box closed.
 */
async function addWebsite(doc: Document, link: string): Promise<PartWrote> {
  if (linkHere(doc, link) && !contactForm(doc)) return { result: 'already', steps: NO_FILL };
  let steps: FillSteps = NO_FILL;
  let form = contactForm(doc);
  if (!form) {
    const pencil = controlHere(doc, EDIT_CONTACT);
    if (!pencil) return { result: 'none', steps };
    pencil.click();
    form = await waitFor(() => contactForm(doc), 8_000);
  }
  steps = { ...steps, opener: true, form: form !== null };
  if (!form) return { result: 'none', steps };
  const add = controlSaying(form, ADD_WEBSITE)!;
  const selects = new Set(form.querySelectorAll('select'));
  const { box, boxes } = await newBoxAfter(doc, () => add.click());
  steps = {
    ...steps,
    fields: fieldsIn(form).length,
    names: fieldsIn(form)
      .slice(0, 12)
      .map((f) => maskText(clean(f.getAttribute('aria-label'))) || '(no name)'),
  };
  if (!box) return { result: 'none', steps: { ...steps, missing: [`Website (${boxes} opened)`] } };
  writeIn(doc, box, link);
  await pause(300);
  const typed =
    clean('value' in box ? (box as HTMLInputElement).value : box.textContent) === clean(link);
  steps = { ...steps, typed };
  if (!typed) return { result: 'none', steps };
  // Its type, where the new row asks: Company, else Other.
  const type = [...form.querySelectorAll('select')].find(
    (s) =>
      !selects.has(s) &&
      visible(s) &&
      WEBSITE_TYPE.test(nameOf(s) || clean(s.options[0]?.textContent)),
  );
  if (type) {
    const option =
      [...type.options].find((o) => /^company$/i.test(clean(o.textContent))) ??
      [...type.options].find((o) => /^other$/i.test(clean(o.textContent)));
    if (option) {
      type.value = option.value;
      type.dispatchEvent(new doc.defaultView!.Event('change', { bubbles: true }));
    }
  }
  const saves = [...form.querySelectorAll<HTMLElement>(EDITOR_BUTTONS)].filter(
    (b) => visible(b) && SAVE.test(nameOf(b)),
  );
  steps = { ...steps, saves: saves.length };
  if (saves.length !== 1 || !shown(saves[0]!)) return { result: 'none', steps };
  saves[0]!.click();
  const closed = await waitFor(() => (!form!.isConnected || !visible(form!) ? true : null), 10_000);
  return closed
    ? { result: 'done', steps: { ...steps, saved: true } }
    : { result: 'not_saved', steps };
}

// ------------------------------------------------------------------------------------------------ their work

const ADD_POSITION = /^add (new )?position$/i;
const ADD_EXPERIENCE = /^add (new )?(experience|position|career break)s?$|^add experience$/i;
const TITLE = /^title\b/i;
const COMPANY = /^company( or organi[sz]ation| name)?\b/i;
const DESCRIPTION = /^description\b/i;
const MONTH = /^(start date[\s,:-]*)?month\b/i;
const YEAR = /^(start date[\s,:-]*)?year\b/i;
const CURRENT = /\bcurrently working in this role\b|^i currently work here$/i;
const NOTIFY = /^(notify network|share with (your )?network|share (this )?update)\b/i;

/** Add position's own address, from the profile's: the job opens it where the profile has no + to press. */
export function positionFormUrl(href: string): string | null {
  const m = /^(https:\/\/www\.linkedin\.com\/in\/[^/?#]+)/i.exec(href);
  return m ? `${m[1]}/edit/forms/position/new/` : null;
}

/** What opens Add position: its own control, or the + by Experience and its menu's Add position. */
async function positionOpener(doc: Document): Promise<HTMLElement | null> {
  const own = controlHere(doc, ADD_POSITION);
  if (own) return own;
  const plus = controlHere(doc, ADD_EXPERIENCE);
  if (!plus) return null;
  const items = await openMenu(doc, plus, places(doc));
  // No menu: the + opened the form itself.
  if (!items.length) return null;
  const add = items.find((item) => ADD_POSITION.test(nameOf(item)));
  if (!add) closeMenu(doc);
  return add ?? null;
}

/** Their work, by Add position. In already when the page says the title and the company. */
async function writeWork(
  doc: Document,
  href: string,
  part: Extract<PartWrite, { kind: 'work' }>,
): Promise<PartWrote> {
  const onForm = /\/edit\/forms\/position\/new\/?/i.test(href);
  if (!onForm && says(doc, part.title) && says(doc, part.company))
    return { result: 'already', steps: NO_FILL };
  const since = sinceParts(part.since);
  const opener = onForm ? null : await positionOpener(doc);
  const wrote = await fillForm(doc, {
    opener: () => opener,
    fields: [
      { name: 'Title', label: TITLE, value: part.title },
      { name: 'Company', label: COMPANY, value: part.company },
      ...(since
        ? [
            { name: 'Month', label: MONTH, value: since.month, first: true },
            { name: 'Year', label: YEAR, value: since.year, first: true },
          ]
        : []),
      ...(part.words
        ? [{ name: 'Description', label: DESCRIPTION, value: part.words, optional: true }]
        : []),
    ],
    ticks: [
      { label: CURRENT, on: true },
      { label: NOTIFY, on: false },
    ],
    // Its own page goes back to the profile after Save: the job reads it there.
    shows: () => onForm || says(doc, part.company),
    stays: onForm,
    mask: maskText,
    places,
  });
  // Nothing to press on the profile: Add position's own page.
  if (wrote.result === 'none' && !wrote.steps.opener && !onForm) {
    const next = positionFormUrl(href);
    if (next) return { ...wrote, result: 'elsewhere', next };
  }
  return wrote;
}

// ------------------------------------------------------------------------------------------------ featured

const ADD_FEATURED = /^add (a |new )?featured( item| section)?$|^add to featured$/i;
const ADD_LINK = /^add (a )?link$/i;
const LINK_FIELD = /\b(url|link)\b/i;
const ADD = /^add$/i;
const FEATURE_POST = /^feature on top of profile$|^add to featured$/i;
const UNFEATURE = /^remove from featured$/i;
const POST_MENU = /^(open control menu|control menu|more actions|open options)\b/i;

/** The booking link featured: Add featured, Add a link, the link, Add, then Save on what LinkedIn drew of it. */
async function featureLink(doc: Document, link: string): Promise<PartWrote> {
  const featured = [...mainOf(doc).querySelectorAll('section')].find((s) =>
    /^featured\b/i.test(clean(s.querySelector('h2, [role="heading"]')?.textContent)),
  );
  if (
    featured &&
    [...featured.querySelectorAll('a[href]')].some((a) =>
      sameLink(a.getAttribute('href') ?? '', link),
    )
  )
    return { result: 'already', steps: NO_FILL };
  const plus = controlHere(doc, ADD_FEATURED);
  let steps: FillSteps = { ...NO_FILL, opener: plus !== null };
  if (!plus) return { result: 'none', steps };
  const items = await openMenu(doc, plus, places(doc));
  const add = items.find((item) => ADD_LINK.test(nameOf(item)));
  if (!add) {
    closeMenu(doc);
    return { result: 'none', steps };
  }
  // The link, and Add: LinkedIn fetches it, then shows a form of what it found, with its own Save.
  const first = await fillForm(doc, {
    opener: () => add,
    fields: [{ name: 'Link', label: LINK_FIELD, value: link }],
    save: ADD,
    shows: () => dialogButtons(doc, SAVE, places(doc)).length === 1,
    mask: maskText,
    places,
    stays: true,
  });
  steps = first.steps;
  if (first.result !== 'done') return first;
  const save = dialogButtons(doc, SAVE, places(doc))[0]!;
  const box = save.closest('[role="dialog"], dialog');
  save.click();
  const kept = await waitFor(
    () => (box && (!box.isConnected || !visible(box)) ? true : null),
    10_000,
  );
  return kept
    ? { result: 'done', steps: { ...steps, saves: 1, saved: true } }
    : { result: 'not_saved', steps: { ...steps, saves: 1, saved: false } };
}

/** How much of the post's words are looked for: its start, as LinkedIn cuts it short with …more. */
const POST_START = 80;

/** The post on their posts page that starts with these words: the outermost box that says them with a menu in it. */
function postBoxOf(doc: Document, post: string): Element | null {
  const start = squash(post).slice(0, POST_START);
  const boxes = places(doc)
    .flatMap((place) => [
      ...place.querySelectorAll(
        '[data-urn*="activity"], [data-id*="activity"], [role="article"], article',
      ),
    ])
    .filter((box) => visible(box) && squash(box.textContent).includes(start));
  return boxes.find((box) => !boxes.some((other) => other !== box && box.contains(other))) ?? null;
}

/** Their best post featured: its menu, then Feature on top of profile. */
async function featurePost(doc: Document, post: string): Promise<PartWrote> {
  const box = postBoxOf(doc, post);
  if (!box) return { result: 'none', steps: NO_FILL };
  const menu = [...box.querySelectorAll<HTMLElement>(EDITOR_BUTTONS)].find(
    (b) => shown(b) && POST_MENU.test(nameOf(b)),
  );
  const steps: FillSteps = { ...NO_FILL, opener: menu !== undefined };
  if (!menu) return { result: 'none', steps };
  const items = await openMenu(doc, menu, places(doc));
  if (items.some((item) => UNFEATURE.test(nameOf(item)))) {
    closeMenu(doc);
    return { result: 'already', steps };
  }
  const feature = items.find((item) => FEATURE_POST.test(nameOf(item)));
  if (!feature) {
    closeMenu(doc);
    return { result: 'none', steps: { ...steps, form: items.length > 0 } };
  }
  feature.click();
  await pause(1_000);
  return { result: 'done', steps: { ...steps, form: true, typed: true, saves: 1, saved: true } };
}

/** Puts one of decision 99's parts in on the page the tab shows. */
export async function writeLinkedInPart(
  doc: Document,
  href: string,
  part: PartWrite,
): Promise<PartWrote> {
  switch (part.kind) {
    case 'username':
      return writeUsername(doc, part.username);
    case 'link_add':
      return addWebsite(doc, part.link);
    case 'work':
      return writeWork(doc, href, part);
    case 'feature_link':
      return featureLink(doc, part.link);
    case 'feature_post':
      return featurePost(doc, part.post);
    default:
      return { result: 'none', steps: NO_FILL };
  }
}
