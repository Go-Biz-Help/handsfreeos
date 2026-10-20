/**
 * The person's own Alignable profile (docs/outreach.md, decision 80), from the owner's Check Alignable (0.62.0, 18 Oct
 * 2026): /biz/businesses/my_profile, which Alignable shows at the business's own address with ?user=. Read for the AI's
 * check, and its editors opened and closed by Check with nothing written or saved, so what the AI writes can be put in
 * once Check has read each one.
 *
 * - **Its parts:** the owner's card (photo, name and title), About Us (the business's description, edited on a page of
 *   its own from its Edit link), the Elevator Pitch's button, My Ideal Customer and the ideal partner (each a few
 *   words, who and where, and tags), and the services (each a name and a few words, edited on a page of its own).
 * - It reads by Alignable's own words and its test ids, never class names. Its names and words are what the person
 *   wrote, so only the AI's check sees them: Check's notes say only what was found.
 */
import { PROFILE_READ_LIMITS, type ProfileRead } from '@hfos/core/addons/outreach/profile-check';
import { clean } from '../facebook/dom';
import { visible } from '../facebook/fetch';
import { boxName, controlsSaying, mainOf, namesIn, nameOf, waitFor } from '../looking/looks';
import { outlineNow } from '../looking/read';
import type { LookingSite } from '../looking/site';
import { went, type StepTry } from '../tries';

/** Its parts, by the test ids its own profile carries. */
const PART = (id: string) => `[data-testid="${id}"]`;
const PITCH = PART('elevator-pitch-cta-button');
/** Where a person writes: a plain box, or one drawn to write in. */
const BOXES =
  'textarea, input[type="text"], input:not([type]), [role="textbox"], [contenteditable="true"]';
/** What closes an editor with nothing saved: never Save, Done or Delete. */
const CLOSE = /^(cancel|close|close modal|close dialog|dismiss|×|✕|x)$/i;
/** What keeps what's written: found, never pressed. */
const SAVE = /^(save|save changes|update|submit|publish|post)$/i;
/** A part's own button that adds its words, rather than changing those there. */
const ADD = /^(add|write|create|record)\b/i;

const cut = (text: string | null | undefined, most: number): string | null => {
  const t = clean(text);
  return t ? t.slice(0, most) : null;
};

/** About Us: the words under its heading, never a button's. */
export function aboutUsOf(root: ParentNode): string | null {
  const heading = [...root.querySelectorAll('div, span, h2, h3, h4')].find(
    (el) => el.children.length === 0 && /^about us$/i.test(clean(el.textContent)),
  );
  for (
    let up = heading?.parentElement ?? null, steps = 0;
    up && steps < 4;
    up = up.parentElement, steps++
  ) {
    const words = [...up.querySelectorAll('p')]
      .filter((p) => !p.closest('button, a'))
      .map((p) => clean(p.textContent))
      .find(Boolean);
    if (words) return cut(words, PROFILE_READ_LIMITS.about);
  }
  return null;
}

/** My Ideal Customer, or the ideal partner: its few words (unless it only says to add some), who, where and tags. */
export function idealOf(root: ParentNode, who: 'customer' | 'partner') {
  const part = root.querySelector(PART(`ideal-${who}-information`));
  if (!part) return null;
  const words = part.querySelector(PART(`ideal-${who}-add-description`));
  const add = ADD.test(clean(words?.querySelector('button')?.textContent));
  // On anyone else's page their words are a part of their own (the owner's Check, 0.66.0).
  const theirs = clean(part.querySelector(PART(`ideal-${who}-description`))?.textContent);
  return {
    words: theirs || (add ? null : clean(words?.querySelector('span')?.textContent) || null),
    type: clean(part.querySelector(PART(`ideal-${who}-type`))?.textContent) || null,
    place: clean(part.querySelector(PART(`ideal-${who}-location`))?.textContent) || null,
    tags: [...part.querySelectorAll(`${PART(`ideal-${who}-tags`)} a`)]
      .map((a) => clean(a.textContent))
      .filter(Boolean),
  };
}

/** The services: each one's name and words, from the card around its Edit link. */
function servicesOf(root: ParentNode): string[] {
  const services: string[] = [];
  for (const edit of root.querySelectorAll('a[href*="/biz/services/"][href$="/edit"]')) {
    for (let up = edit.parentElement, steps = 0; up && steps < 4; up = up.parentElement, steps++) {
      const name = [...up.querySelectorAll('a[href]')].find(
        (a) => a !== edit && !/\/biz\/|forward_referral_card/.test(a.getAttribute('href') ?? ''),
      );
      if (!name) continue;
      const words = clean(name.nextElementSibling?.textContent);
      const service = [clean(name.textContent), words].filter(Boolean).join(': ');
      if (service) services.push(service.slice(0, PROFILE_READ_LIMITS.line));
      break;
    }
  }
  return [...new Set(services)];
}

/** Their own profile as the AI's check reads it: Alignable's parts in core's shape. */
export function readOwnProfile(doc: Document, href: string): ProfileRead {
  const main = mainOf(doc);
  const name = cut(main.querySelector('h1[title]')?.textContent, 200);
  const title = cut(main.querySelector('h2[title]')?.textContent, PROFILE_READ_LIMITS.line);
  const customer = idealOf(main, 'customer');
  const partner = idealOf(main, 'partner');
  const line = (label: string, ...parts: (string | null | undefined)[]) => {
    const words = parts.filter(Boolean).join(', ');
    return words ? `${label}: ${words}`.slice(0, PROFILE_READ_LIMITS.line) : null;
  };
  const intro = [
    line('Title', title),
    line('Ideal customer', customer?.type, customer?.place),
    line('Ideal customer, in their words', customer?.words),
    line('Ideal customer tags', ...(customer?.tags ?? [])),
    line('Ideal partner', partner?.type, partner?.place),
    line('Ideal partner, in their words', partner?.words),
    line('Ideal partner tags', ...(partner?.tags ?? [])),
  ].filter((l): l is string => l !== null);
  const photo = main.querySelector('a[href*="/biz/users/"][href$="/edit"] img[alt]');
  return {
    platform: 'alignable',
    url: href,
    name,
    picture: photo ? 'A profile photo Alignable didn’t describe' : null,
    // The Elevator Pitch isn't read yet: Check opens it to see what it is (a few words, or a video).
    bio: null,
    about: aboutUsOf(main),
    intro: intro.slice(0, PROFILE_READ_LIMITS.intro),
    featured: servicesOf(main).slice(0, PROFILE_READ_LIMITS.featured),
    posts: [],
  };
}

/** About Us's Edit on their own profile, by the address its link says it came from. */
const ABOUT_EDIT = 'a[href*="source=about_us_section"]';

/** A box in the gallery's form, for a picture's title and its few words: never About Us (the owner's Check, 0.67.0). */
const inGallery = (box: Element): boolean =>
  box.closest('form')?.querySelector('[data-testid^="gallery-uploader"]') != null;

/** The boxes in sight. */
const boxesIn = (doc: Document): HTMLElement[] =>
  [...doc.querySelectorAll<HTMLElement>(BOXES)].filter(
    (box) =>
      visible(box) &&
      box.getAttribute('role') !== 'combobox' &&
      box.getAttribute('type') !== 'search',
  );
const dialogsIn = (doc: Document): Element[] =>
  [...doc.querySelectorAll('[role="dialog"], dialog[open]')].filter(visible);

/** What closes an editor, nearest it first: its own Cancel or Close, even one drawn as a link with no address. */
function closerOf(opened: Element): HTMLElement | null {
  for (let up = opened.parentElement, steps = 0; up && steps < 12; up = up.parentElement, steps++) {
    const close = [...up.querySelectorAll<HTMLElement>('button, [role="button"], a')].find(
      (control) => visible(control) && CLOSE.test(nameOf(control)),
    );
    if (close) return close;
  }
  return null;
}

/**
 * Opens one of their profile's editors by its own button, sees what it opens (a box to write in, its Save), with the
 * page's outline while it's open, and closes it again by its Cancel or Close, or Escape: nothing is written or saved.
 */
async function openAndClose(
  doc: Document,
  site: LookingSite,
  step: 'pitch' | 'ideal' | 'about',
  opener: HTMLElement | null,
  name: string,
  /** It's a link Alignable opens its editor from in its own page: About Us's Edit. */
  inPage = false,
): Promise<StepTry> {
  const main = mainOf(doc);
  if (!opener) return went(step, { button: false }, [`no ${name} button`], namesIn(main, site));
  // A link leads off the page, and the script with it: it's said, for Check to open as a page.
  if (!inPage && opener.closest('a[href]'))
    return went(step, { button: true, link: true }, [`${name} is a link, not an editor`], []);
  const boxes = new Set(boxesIn(doc));
  const dialogs = new Set(dialogsIn(doc));
  opener.click();
  const opened = await waitFor(
    () =>
      boxesIn(doc).find((box) => !boxes.has(box) && !inGallery(box)) ??
      dialogsIn(doc).find((dialog) => !dialogs.has(dialog)) ??
      null,
    inPage ? 8_000 : 5_000,
  );
  if (!opened)
    return {
      ...went(
        step,
        { button: true, opened: false },
        [`${name} opened nothing`],
        namesIn(main, site),
      ),
      outline: outlineNow(doc, site),
    };
  // A box over the page is drawn before what's in it: the Elevator Pitch's was still empty when the owner's Check
  // looked (0.66.0), so its box is waited for.
  const box = opened.matches(BOXES)
    ? opened
    : await waitFor(
        () => [...opened.querySelectorAll<HTMLElement>(BOXES)].find((b) => visible(b)) ?? null,
        5_000,
      );
  const around = opened.closest('[role="dialog"], dialog, form') ?? opened.parentElement ?? main;
  const save = controlsSaying(around, SAVE, true).length;
  const outline = outlineNow(doc, site);
  const close = closerOf(opened);
  const view = doc.defaultView;
  if (close) close.click();
  else if (view)
    (box ?? opened).dispatchEvent(
      new view.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }),
    );
  const closed =
    (await waitFor(() => (!opened.isConnected || !visible(opened) ? true : null), 3_000)) === true;
  return {
    ...went(
      step,
      { button: true, opened: true, box: box !== null, save, cancel: close !== null, closed },
      [
        box === null && `${name} opened no box to write in`,
        !closed && `${name} didn’t close again`,
      ].filter((m): m is string => typeof m === 'string'),
      [],
    ),
    // Kept even when it works: it's how what the AI writes will be put in.
    outline,
  };
}

/** The Elevator Pitch's button, opened and closed: a few words to write, or a video. */
export const pitchLook = (doc: Document, site: LookingSite): Promise<StepTry> =>
  openAndClose(
    doc,
    site,
    'pitch',
    mainOf(doc).querySelector<HTMLElement>(PITCH),
    'the Elevator Pitch',
  );

/** My Ideal Customer's own button for its few words, opened and closed. */
export const idealLook = (doc: Document, site: LookingSite): Promise<StepTry> =>
  openAndClose(
    doc,
    site,
    'ideal',
    mainOf(doc).querySelector<HTMLElement>(`${PART('ideal-customer-add-description')} button`),
    'My Ideal Customer’s words',
  );

/**
 * About Us on its own page (its Edit link's): its box, and its Save, found and never pressed. Nothing is written: a
 * page left with something changed asks the person before it goes.
 */
export function aboutLook(doc: Document, site: LookingSite): StepTry | Promise<StepTry> {
  const main = mainOf(doc);
  const boxes = boxesIn(doc).filter((box) => main.contains(box) && !inGallery(box));
  // On their own profile About Us's box isn't there till its Edit opens it in the page: opening its address leads
  // back to the profile, with only the gallery's form there (the owner's Check, 0.67.0). Its Edit first asks for a
  // code Alignable emails them (the owner's Check, 0.68.0, and Chris: "Alignable sends email verification codes to
  // verify profile updates"), so Check never presses it again: every press is an email. Its editor is opened when
  // what the AI wrote goes in, with the code they give HandsFreeOS.
  const edit = main.querySelector<HTMLElement>(ABOUT_EDIT);
  if (!boxes.length && edit) return went('about', { button: true, emailsCode: true }, [], []);
  const about =
    boxes.find((box) => /\b(about|description|describe|tell)\b/i.test(boxName(box))) ??
    boxes.find((box) => box.tagName === 'TEXTAREA') ??
    null;
  const save = controlsSaying(main, SAVE, true).length;
  return went(
    'about',
    { boxes: boxes.length, box: about !== null, save },
    [
      about === null && 'no box for About Us on its page',
      about !== null && save === 0 && 'no Save by About Us’s box',
    ].filter((m): m is string => typeof m === 'string'),
    about === null || save === 0 ? namesIn(main, site) : [],
  );
}
