/**
 * The rest of the person's own Facebook profile (docs/outreach.md, decision 99), for a **Put these in** they pressed in
 * HandsFreeOS, beside the bio (./own-profile.ts) and the links added (./links.ts):
 *
 * - **Their work**, on the About tab's Work and education, where **Add a workplace** opens its form: the company, the
 *   position and the few words the AI wrote, with **I currently work here** ticked (../fill.ts). Its start is left to
 *   Facebook: it's optional there, in lists drawn of their own.
 * - **Their best post, pinned**: found on their profile by its first words, its **Actions for this post** menu, then
 *   **Pin post** (or Feature, where Facebook calls it that). Facebook's Featured takes no posts.
 * - **A link taken off** that doesn't fit them (answer 16a): on Contact and basic info, by the link's own pencil or menu,
 *   then **Delete** and its confirm, and the link gone from the page. Changing one is taking it off, then adding the new
 *   one (./links.ts). Only the links the person ticked: never another.
 *
 * Built from Facebook's usual words for these, not yet from a page outline of them: one that doesn't go in sends the
 * outline of where it stopped, so they can be tuned from the person's own pages.
 */
import { clean } from './dom';
import { EDITOR_BUTTONS, pause } from './editors';
import { nameOf, shown, visible } from './fetch';
import { linkShown, sameLink } from './links';
import { maskText } from './outline';
import {
  closeMenu,
  controlSaying,
  dialogButtons,
  fillForm,
  NO_FILL,
  openMenu,
  type FillSteps,
  type PartWrite,
  type PartWrote,
} from '../fill';
import { waitFor } from '../looking/looks';

const mainOf = (doc: Document): Element => doc.querySelector('[role="main"]') ?? doc.body;

/** Words with no spaces and in lower case, to find one written by the AI however the page draws it. */
const squash = (text: string | null | undefined): string =>
  clean(text).toLowerCase().replace(/\s+/g, '');

/** Whether the page says these words, anywhere in its main part. */
const pageSays = (doc: Document, words: string): boolean =>
  squash(mainOf(doc).textContent).includes(squash(words));

/** Facebook's Add a workplace, and its form's fields and tick. */
const ADD_WORK = /^add (a )?workplace$/i;
const COMPANY = /^company\b/i;
const POSITION = /^(position|job title|title)\b/i;
const DESCRIPTION = /^description\b/i;
const NOW = /^i currently work here$/i;

/** Their work: by Add a workplace on Work and education. In already when the page says the company and the position. */
async function writeWork(
  doc: Document,
  part: Extract<PartWrite, { kind: 'work' }>,
): Promise<PartWrote> {
  if (pageSays(doc, part.company) && pageSays(doc, part.title))
    return { result: 'already', steps: NO_FILL };
  return fillForm(doc, {
    opener: () => controlSaying(mainOf(doc), ADD_WORK),
    fields: [
      { name: 'Company', label: COMPANY, value: part.company },
      { name: 'Position', label: POSITION, value: part.title },
      ...(part.words
        ? [{ name: 'Description', label: DESCRIPTION, value: part.words, optional: true }]
        : []),
    ],
    ticks: [{ label: NOW, on: true }],
    shows: () => pageSays(doc, part.company),
    mask: maskText,
  });
}

/** A post's menu, as Facebook labels it, and what pins it to the top of the profile. */
const POST_MENU = /^actions for this post$/i;
const PIN =
  /^(pin post|pin to (the )?top of (your )?profile|feature( on (your )?profile)?|add to featured)$/i;
const UNPIN = /^(unpin post|unpin from (your )?profile|remove from featured)$/i;
/** How much of the post's words are looked for: its start, as the profile may cut it short with See more. */
const POST_START = 80;

/** The post on the page that starts with these words: in its own box (an article), the nearest one. */
function postOf(doc: Document, post: string): Element | null {
  const start = squash(post).slice(0, POST_START);
  const articles = [...mainOf(doc).querySelectorAll('[role="article"]')].filter(
    (a) => visible(a) && squash(a.textContent).includes(start),
  );
  // A comment is an article inside the post's: the outermost is the post.
  return articles.find((a) => !articles.some((other) => other !== a && other.contains(a))) ?? null;
}

/** Their best post, pinned to the top of their profile: by its menu's Pin post. */
async function pinPost(doc: Document, post: string): Promise<PartWrote> {
  const found = postOf(doc, post);
  if (!found) return { result: 'none', steps: NO_FILL };
  const menu = [...found.querySelectorAll<HTMLElement>(EDITOR_BUTTONS)].find(
    (b) => shown(b) && POST_MENU.test(nameOf(b)),
  );
  const steps: FillSteps = { ...NO_FILL, opener: menu !== undefined };
  if (!menu) return { result: 'none', steps };
  const items = await openMenu(doc, menu);
  // Pinned already: its menu offers to unpin it, which is never pressed.
  if (items.some((item) => UNPIN.test(nameOf(item)))) {
    closeMenu(doc);
    return { result: 'already', steps };
  }
  const pin = items.find((item) => PIN.test(nameOf(item)));
  if (!pin) {
    closeMenu(doc);
    return { result: 'none', steps: { ...steps, form: items.length > 0 } };
  }
  pin.click();
  // A box to be sure, where Facebook shows one: its one Pin, Save or Confirm.
  const sure = await waitFor(
    () => dialogButtons(doc, /^(pin|save|confirm|feature|done)$/i)[0],
    2_000,
  );
  sure?.click();
  await pause(800);
  return { result: 'done', steps: { ...steps, form: true, typed: true, saves: 1, saved: true } };
}

/** What opens a link's own row to change it, and what takes it off. */
const LINK_CONTROL =
  /^(edit|options|more options|more|edit (website|link|social link)|options for (website|link|social link))\b/i;
const DELETE = /^(delete|remove)( (this )?(website|link|social link))?$/i;
const SURE = /^(delete|remove|confirm|yes)$/i;

/** The link's row on Contact and basic info: the nearest box around its link that has a control to change it. */
function linkControl(doc: Document, link: string): HTMLElement | null {
  const anchor = [...mainOf(doc).querySelectorAll('a[href]')].find(
    (a) => visible(a) && sameLink(a.getAttribute('href') ?? '', link),
  );
  const text =
    anchor ??
    [...mainOf(doc).querySelectorAll('span, div')].find(
      (e) => e.childElementCount === 0 && visible(e) && sameLink(clean(e.textContent), link),
    );
  if (!text) return null;
  for (let at = text.parentElement, up = 0; at && up < 8; at = at.parentElement, up++) {
    const controls = [...at.querySelectorAll<HTMLElement>(EDITOR_BUTTONS)].filter(
      (b) => shown(b) && !b.contains(text) && LINK_CONTROL.test(nameOf(b)),
    );
    // Two rows' controls: past the link's own row.
    if (controls.length > 1) return null;
    if (controls.length === 1) return controls[0]!;
    if (at.matches('[role="main"]')) break;
  }
  return null;
}

/** A link there taken off: its row's control, Delete (in its menu or its editor), the confirm, and the link gone. */
async function takeLinkOff(doc: Document, link: string): Promise<PartWrote> {
  if (!linkShown(doc, link)) return { result: 'already', steps: NO_FILL };
  const control = linkControl(doc, link);
  let steps: FillSteps = { ...NO_FILL, opener: control !== null };
  if (!control) return { result: 'none', steps };
  control.click();
  // A menu's Delete, or an editor's.
  const del = await waitFor(
    () =>
      [...doc.querySelectorAll<HTMLElement>(`${EDITOR_BUTTONS}, [role="menuitem"]`)].find(
        (b) => shown(b) && b !== control && DELETE.test(nameOf(b)),
      ) ?? null,
    5_000,
  );
  steps = { ...steps, form: del !== null };
  if (!del) return { result: 'none', steps };
  del.click();
  const sure = await waitFor(() => dialogButtons(doc, SURE).find((b) => b !== del), 3_000);
  sure?.click();
  steps = { ...steps, typed: true, saves: sure ? 1 : 0 };
  const gone = await waitFor(() => (linkShown(doc, link) ? null : true), 8_000);
  return gone
    ? { result: 'done', steps: { ...steps, saved: true } }
    : { result: 'not_saved', steps };
}

/** Puts one of decision 99's parts in on the page the tab shows. */
export async function writeFacebookPart(doc: Document, part: PartWrite): Promise<PartWrote> {
  switch (part.kind) {
    case 'work':
      return writeWork(doc, part);
    case 'feature_post':
      return pinPost(doc, part.post);
    case 'link_off':
      return takeLinkOff(doc, part.link);
    default:
      return { result: 'none', steps: NO_FILL };
  }
}
