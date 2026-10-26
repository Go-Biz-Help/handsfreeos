/**
 * Links on the person's own Facebook profile (docs/outreach.md, decision 89), added for a **Put these in** they pressed
 * in HandsFreeOS: on Contact and basic info, where the Links card's **Edit links** leads (./own-profile.ts
 * `ownEditorsOf`).
 *
 * - **Only added.** A link that shows there already, however Facebook wrote it (its l.php wrapper, `www.`, a slash at
 *   the end, its tracking), is left as it is; nothing there is ever removed or changed. HandsFreeOS only asks for links
 *   the profile doesn't have (`linksToAdd`).
 * - **By Facebook's words.** It presses **Add a website** (or Add a link), writes the address in the one box that opens,
 *   presses that box's own **Save**, and waits for the link to show (./editors.ts). **Add a social link** is never
 *   pressed: it wants a network picked and a username rather than an address. Anything else is said, and the job hands
 *   the step to the person.
 *
 * Built from Facebook's usual words for this page, not yet from a page outline of it: Check Facebook sends its outline
 * (./tries.ts), so it can be tuned from the person's own.
 */
import { clean, textLines } from './dom';
import {
  controlIn,
  EDITOR_LOOK_MS,
  EDITOR_WAIT_MS,
  gone,
  newBoxAfter,
  NO_STEPS,
  pause,
  saveBy,
  textOf,
  type EditorSteps,
} from './editors';
import { placesOf } from './fetch';
import { typeInto } from './join';
import { buttonNamesOn, outsideLink } from './own-profile';
import { classifyUrl, facebookUrl, pathParts } from './urls';
import { readWarnings } from './warnings';

/** Facebook's add for a website: never its add for a social link, which wants a network and a username. */
export const ADD_LINK = /^add (a )?(website|link)$/i;

/** Tracking added to an address, which doesn't make it another one. */
const TRACKING = /^(fbclid|mibextid|utm_[a-z]+)$/i;

/**
 * An address as one link: off Facebook's l.php wrapper, without tracking, its host in lower case with no `www.`, the
 * same with http or https and with or without a slash at the end. Null for one of Facebook's own pages, or not a link.
 */
export function linkKey(href: string): string | null {
  const trimmed = clean(href);
  if (!trimmed || /\s/.test(trimmed)) return null;
  const outside = outsideLink(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
  if (!outside) return null;
  let url: URL;
  try {
    url = new URL(outside);
  } catch {
    return null;
  }
  if (!url.hostname.includes('.')) return null;
  for (const name of [...url.searchParams.keys()])
    if (TRACKING.test(name)) url.searchParams.delete(name);
  const query = url.searchParams.toString();
  return `${url.hostname.toLowerCase().replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '')}${query ? `?${query}` : ''}`;
}

/** Whether two addresses are the same link, however each was written. */
export function sameLink(a: string, b: string): boolean {
  const key = linkKey(a);
  return key !== null && key === linkKey(b);
}

/** Whether a page is where the person's own links are changed: their profile's About tab, at Contact and basic info. */
export function linksPage(href: string): boolean {
  if (classifyUrl(href).kind !== 'profile') return false;
  const url = facebookUrl(href);
  if (!url) return false;
  const [first, second] = pathParts(url);
  const tab = (first?.toLowerCase() === 'profile.php' ? url.searchParams.get('sk') : second) ?? '';
  return /^about/i.test(tab);
}

/** Whether a link shows on the page, or in the box on top: as a link, or as words. */
export function linkShown(doc: Document, link: string): boolean {
  const places = [...placesOf(doc).filter((p) => p !== doc.body), doc.querySelector('[role="main"]') ?? doc.body];
  return places.some(
    (place) =>
      [...place.querySelectorAll('a[href]')].some((a) =>
        sameLink(a.getAttribute('href') ?? '', link),
      ) || textLines(place, 400).some((line) => line.length <= 300 && sameLink(line, link)),
  );
}

/** How adding a link went. */
export type LinkResult =
  /** Added, and showing. */
  | 'done'
  /** On the page already: left as it is. */
  | 'already'
  /** No Add a website, or something else wasn't as expected: the person does it. */
  | 'none'
  /** Written and saved, but it didn't show after. */
  | 'not_saved';

/**
 * Adds one link on Contact and basic info: Add a website, the address in the one box it opens, that box's Save, and
 * the link waited for on the page. Nothing is pressed while Facebook shows a warning: the job reads it.
 */
export async function writeLink(
  doc: Document,
  link: string,
): Promise<{ readonly result: LinkResult; readonly steps: EditorSteps }> {
  if (linkShown(doc, link)) return { result: 'already', steps: NO_STEPS };
  const none = (steps: EditorSteps) => ({
    result: 'none' as const,
    steps: { ...steps, names: buttonNamesOn(doc) },
  });
  const control = controlIn(doc, ADD_LINK);
  if (!control) return none(NO_STEPS);
  if (readWarnings(doc, doc.location.href).length) return none({ ...NO_STEPS, control: true });
  const { box, boxes } = await newBoxAfter(doc, () => control.click());
  let steps: EditorSteps = { ...NO_STEPS, control: true, boxes };
  if (!box) return none(steps);
  typeInto(doc, box, link, true);
  await pause(300);
  steps = { ...steps, typed: clean(textOf(box)) === clean(link) };
  if (!steps.typed) return none(steps);
  const save = saveBy(box);
  steps = { ...steps, saves: save.count, saveOn: save.on };
  if (!save.found) return none(steps);
  save.found.click();
  for (let waited = 0; waited < EDITOR_WAIT_MS; waited += EDITOR_LOOK_MS) {
    await pause(EDITOR_LOOK_MS);
    if (gone(box) && linkShown(doc, link))
      return { result: 'done', steps: { ...steps, saved: true } };
  }
  return { result: 'not_saved', steps: { ...steps, names: buttonNamesOn(doc) } };
}
