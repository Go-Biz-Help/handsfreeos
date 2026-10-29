/**
 * The rest of the person's own Alignable profile (docs/outreach.md, decision 99), for a **Put these in** they pressed
 * in HandsFreeOS, beside About Us (./own-profile.ts):
 *
 * - **The Elevator Pitch**: its button on their profile, the box it opens, the pitch the AI wrote and they picked, and
 *   Save. Where the box offers a video or words, it takes words.
 * - **My Ideal Customer and the ideal partner**: each one's own button for its few words (Add, or Edit once it has
 *   some), the words, and Save.
 * - **A service**: **Add a service** on their profile (or the page it leads to), its name and few words, and Save; it
 *   shows among their services after.
 *
 * Like About Us, Alignable may ask for the code it emails before any of these changes (decision 82): `code`, and the
 * job gets it from HandsFreeOS and puts it in, then asks again. Built from Alignable's test ids where its own profile
 * has them (the owner's Checks, 0.62.0 to 0.68.0) and its usual words for the rest, not yet from a page outline of these
 * editors: one that doesn't go in sends the outline of where it stopped, so they can be tuned.
 */
import { clean } from '../facebook/dom';
import { visible } from '../facebook/fetch';
import { controlSaying, fillForm, NO_FILL, type PartWrite, type PartWrote } from '../fill';
import { mainOf, waitFor } from '../looking/looks';
import { codeBoxIn, idealOf, PART, PITCH, servicesOf } from './own-profile';

const squash = (text: string | null | undefined): string =>
  clean(text).toLowerCase().replace(/\s+/g, '');

/** How much of what was written is looked for: its start, as Alignable may cut it short with See more. */
const START = 60;
const startOf = (words: string) => squash(words).slice(0, START);

const SAVE = /^(save|save changes|update|submit|done|publish)$/i;
/** What picks words over a video in the Elevator Pitch's box. */
const WORDS_TAB = /^(write( it| your pitch)?|text|type( it)?|words)$/i;
const PITCH_BOX = /\b(pitch|elevator|describe|tell|about|words|text)\b/i;
const IDEAL_BOX = /\b(ideal|customer|partner|describe|who|words|description)\b/i;
const ADD_SERVICE = /^(\+\s*)?add (a |new )?service$/i;
const SERVICE_NAME = /^(service )?(name|title)\b/i;
const SERVICE_WORDS = /^(service )?(description|details|about|describe)\b/i;

/** Whether the page asks for the code Alignable emailed, now or once a press has opened it. */
const askedCode = (doc: Document) => codeBoxIn(doc) !== null;

/**
 * Fills one of the profile's own editors: its button, then the box. `code` where Alignable asks for its emailed code
 * first, before the box opens or once Save is pressed.
 */
async function fillHere(
  doc: Document,
  opener: () => HTMLElement | null,
  value: string,
  label: RegExp,
  name: string,
  shows: () => boolean,
  mask: (text: string) => string,
): Promise<PartWrote> {
  if (askedCode(doc)) return { result: 'code', steps: NO_FILL };
  const wrote = await fillForm(doc, {
    opener,
    // Once it's open, its words over a video, where it asks.
    afterOpen: async () => {
      const box = await waitFor(
        () => [...doc.querySelectorAll('[role="dialog"], dialog[open]')].find((d) => visible(d)),
        2_000,
      );
      if (box) controlSaying(box, WORDS_TAB)?.click();
    },
    fields: [{ name, label, value, alone: true }],
    save: SAVE,
    shows,
    mask,
  });
  if (wrote.result !== 'done' && askedCode(doc)) return { ...wrote, result: 'code' };
  return wrote;
}

/** The Elevator Pitch: its button, its box, the words, Save. In already when the profile says them. */
function writePitch(doc: Document, words: string, mask: (text: string) => string) {
  const said = () => squash(mainOf(doc).textContent).includes(startOf(words));
  if (said()) return Promise.resolve<PartWrote>({ result: 'already', steps: NO_FILL });
  return fillHere(
    doc,
    () => mainOf(doc).querySelector<HTMLElement>(PITCH),
    words,
    PITCH_BOX,
    'Elevator Pitch',
    said,
    mask,
  );
}

/** My Ideal Customer's or the ideal partner's few words: its own Add (or Edit), the words, Save. */
function writeIdeal(
  doc: Document,
  who: 'customer' | 'partner',
  words: string,
  mask: (text: string) => string,
) {
  const said = () => squash(idealOf(mainOf(doc), who)?.words).startsWith(startOf(words));
  if (said()) return Promise.resolve<PartWrote>({ result: 'already', steps: NO_FILL });
  const opener = () => {
    const part = mainOf(doc).querySelector(PART(`ideal-${who}-information`));
    return (
      part?.querySelector<HTMLElement>(`${PART(`ideal-${who}-add-description`)} button`) ??
      (part ? controlSaying(part, /^(add|edit|write)\b/i) : null)
    );
  };
  return fillHere(doc, opener, words, IDEAL_BOX, `ideal ${who}`, said, mask);
}

/** Whether their services show one with this name. */
const serviceShown = (doc: Document, name: string): boolean =>
  servicesOf(mainOf(doc)).some((s) => squash(s).startsWith(squash(name)));

/**
 * A service: Add a service on their profile (a link to its own page is `elsewhere`, for the job to open), its name and
 * few words, Save. In already when their services show one with that name.
 */
async function addService(
  doc: Document,
  href: string,
  name: string,
  words: string | null,
  mask: (text: string) => string,
): Promise<PartWrote> {
  if (serviceShown(doc, name)) return { result: 'already', steps: NO_FILL };
  if (askedCode(doc)) return { result: 'code', steps: NO_FILL };
  const add = controlSaying(mainOf(doc), ADD_SERVICE);
  const link = add?.closest('a[href]')?.getAttribute('href') ?? null;
  // Its form is a page of its own: the job opens it, and asks again there.
  if (add && link && !/^#|^javascript:/i.test(link)) {
    const next = new URL(link, href).href;
    if (next !== href) return { result: 'elsewhere', steps: { ...NO_FILL, opener: true }, next };
  }
  const onPage = /\/biz\/services\/(new|create)/i.test(href);
  const wrote = await fillForm(doc, {
    opener: () => add,
    fields: [
      { name: 'Service name', label: SERVICE_NAME, value: name },
      ...(words
        ? [{ name: 'Service words', label: SERVICE_WORDS, value: words, optional: true }]
        : []),
    ],
    save: /^(save|save changes|create|add service|submit|publish|add)$/i,
    // Its own page goes back to the profile after Save: the job reads it there.
    shows: () => onPage || serviceShown(doc, name),
    stays: onPage,
    mask,
  });
  if (wrote.result !== 'done' && askedCode(doc)) return { ...wrote, result: 'code' };
  // Saved on its own page, which goes elsewhere: a moment for Alignable to take it.
  if (wrote.result === 'done' && onPage) await waitFor(() => null, 1_500);
  return wrote;
}

/** Puts one of decision 99's parts in on the page the tab shows. */
export function writeAlignablePart(
  doc: Document,
  href: string,
  part: PartWrite,
  mask: (text: string) => string,
): Promise<PartWrote> {
  switch (part.kind) {
    case 'pitch':
      return writePitch(doc, part.words, mask);
    case 'ideal':
      return writeIdeal(doc, part.who, part.words, mask);
    case 'service':
      return addService(doc, href, part.name, part.words, mask);
    default:
      return Promise.resolve({ result: 'none', steps: NO_FILL });
  }
}
