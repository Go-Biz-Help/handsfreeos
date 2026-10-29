/**
 * The person's own profile (docs/outreach.md, decision 64; packages/core/src/addons/outreach/profile-check.ts): what a
 * stranger sees first, read for the AI's check, and the short bio put in once they've picked one.
 *
 * - **What it reads:** the profile picture's and the cover's descriptions (Facebook writes one for each, "May be an
 *   image of 1 person, smiling"), the short bio, the intro's lines, what's featured, and the latest posts. The picture
 *   and the cover are told apart by what labels them ("Cover photo", "Profile picture"), else by order: the cover
 *   comes first at the top. The bio is the line above **Edit bio**; with **Add bio** there's none.
 * - **October 2026's layout** (from an owner's page outline of 23 Oct 2026): no Edit bio and no Intro card. The bio is
 *   the line above the details row at the top; the Personal details, Work and Education cards after the tabs are its
 *   intro, and the Links card its links (Facebook's l.php wrapper taken off).
 * - **Putting a bio in:** it presses **Edit bio** (or **Add bio**), writes the bio in the box that opens in place of
 *   what was there, presses **Save**, and waits for the bio to show. With no such button, or no box, it says so, and
 *   the job hands the step to the person.
 * - **From October 2026, by the About tab's editor** (decision 89): with no Edit bio on the profile, the job opens
 *   Edit profile's link (`ownEditorsOf`), and there the bio's own control is pressed (`bioRow`: Edit bio or Add bio,
 *   or the Bio row's own Edit, never one past another row's words), the bio written in the one box it opens once that
 *   box is known to be the bio's (`bioBoxFits`), and that box's own Save pressed (./editors.ts); it's in once the line
 *   under the title "Bio" says it. The Links card's Edit links, and the profile's number Accounts Center goes by, are
 *   found here too, only as links to the profile itself.
 *
 * Like the rest of the readers, it goes by what a person sees (words, labels, page order), never Facebook's class
 * names, and was tuned from page outlines, not yet tried on a real account.
 */
import { PROFILE_READ_LIMITS, type ProfileRead } from '@hfos/core/addons/outreach/profile-check';
import {
  clean,
  elementsIn,
  inTopBar,
  isBefore,
  isHeading,
  labelOf,
  tabsIn,
  textLines,
} from './dom';
import {
  buttonsIn,
  cancelBy,
  EDITOR_BUTTONS,
  fieldName,
  gone,
  lineAfter,
  newBoxAfter,
  NO_STEPS,
  rowControl,
  saveBy,
  textOf,
  titlesIn,
  type EditorSteps,
} from './editors';
import { placesOf, shown } from './fetch';
import { typeInto } from './join';
import { maskText } from './outline';
import { cardList, cardsIntro, cardTitles, readProfile } from './profile';
import type { PageAddress } from './types';
import { classifyUrl, FACEBOOK, facebookUrl, pathParts, workUrl } from './urls';
import { isFacebookText, UI_WORDS } from './vocabulary';
import { readWarnings } from './warnings';

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const mainOf = (doc: Document): Element => doc.querySelector('[role="main"]') ?? doc.body;

const EDIT_BIO = /^(edit|add) bio$/i;
const COVER = /\bcover (photo|picture|image)\b/i;
const PICTURE = /\bprofile (picture|photo)\b/i;
/** The cards after Featured: reading it stops at the first of them. */
const AFTER_FEATURED =
  /^(photos|friends|life events|posts|links|hobbies|interests|about|intro|see all.*)$/i;
/** How long the box to write the bio in, and the bio saved, are waited on, and how often they're looked at. */
const WAIT_MS = 8_000;
const LOOK_MS = 400;

const cut = (text: string | null | undefined, most: number): string | null => {
  const t = clean(text);
  return t ? t.slice(0, most) : null;
};

/** What labels an image: its alt, the labelled picture it's drawn in, or the link or button around it. */
function imageLabel(image: Element): { readonly own: string; readonly around: string } {
  const own =
    clean(image.getAttribute('alt')) ||
    clean(image.getAttribute('aria-label')) ||
    clean(image.closest('svg[aria-label]')?.getAttribute('aria-label'));
  const holder = image.closest('a, [role="button"], button, [role="link"]');
  return { own, around: holder ? labelOf(holder) : '' };
}

/** The pictures at the top of the profile, labelled, in page order: the cover and the profile picture among them. */
function topImages(main: Element): { readonly own: string; readonly around: string }[] {
  const found: { own: string; around: string }[] = [];
  for (const image of main.querySelectorAll(
    'img, svg[aria-label] image, [role="img"][aria-label]',
  )) {
    const label = imageLabel(image);
    if (!label.own && !label.around) continue;
    found.push(label);
    if (found.length >= 6) break;
  }
  return found;
}

/** The cover's and the profile picture's descriptions, as Facebook wrote them; null for one it didn't show. */
function picturesOf(
  main: Element,
  name: string | null,
): { cover: string | null; picture: string | null } {
  const images = topImages(main);
  const says = (i: { own: string; around: string }) => `${i.own} ${i.around}`;
  let cover = images.find((i) => COVER.test(says(i))) ?? null;
  let picture =
    images.find((i) => i !== cover && PICTURE.test(says(i))) ??
    images.find((i) => i !== cover && name !== null && i.own === name) ??
    null;
  // Unlabelled: the cover comes first at the top, the picture after it.
  if (!cover && images.length >= 2 && images[0] !== picture) cover = images[0]!;
  if (!picture) picture = images.find((i) => i !== cover) ?? null;
  const described = (i: { own: string } | null) =>
    i
      ? cut(
          i.own && !(name && i.own === name) ? i.own : 'A picture Facebook didn’t describe',
          PROFILE_READ_LIMITS.line,
        )
      : null;
  return { cover: described(cover), picture: described(picture) };
}

/** The Edit bio (or Add bio) button, where it shows. */
export function bioButton(doc: Document): HTMLElement | null {
  return (
    [...mainOf(doc).querySelectorAll<HTMLElement>('[role="button"], button')].find(
      (b) => EDIT_BIO.test(labelOf(b)) && shown(b),
    ) ?? null
  );
}

/**
 * The bio in October 2026's layout, which has no Edit bio: the line just above the details row (a list of little icons
 * and words), at the top before the tabs. Null when there's no such line.
 */
function bioAboveDetails(main: Element): string | null {
  const tabs = tabsIn(main);
  for (const list of main.querySelectorAll('[role="list"]')) {
    if (tabs && !isBefore(list, tabs)) break;
    let holder: Element = list;
    while (!holder.previousElementSibling && holder.parentElement && holder.parentElement !== main)
      holder = holder.parentElement;
    const above = holder.previousElementSibling;
    if (!above || above.querySelector('[role="button"], button, a, h1, h2, h3, img, [role="list"]'))
      continue;
    const line = clean(above.textContent);
    if (line && !UI_WORDS.has(line.toLowerCase()) && !isFacebookText(line))
      return cut(line, PROFILE_READ_LIMITS.bio);
  }
  return null;
}

/**
 * The short bio: the line just above Edit bio, in the box they share; with no Edit bio, the line above the details row
 * (October 2026). Null with Add bio.
 */
export function bioOf(doc: Document): string | null {
  const button = bioButton(doc);
  if (!button) return bioAboveDetails(mainOf(doc));
  if (/^add/i.test(labelOf(button))) return null;
  let box: Element | null = button.parentElement;
  for (let steps = 0; box && steps < 5; steps++, box = box.parentElement) {
    const lines = textLines(box, 20).filter(
      (l) => !EDIT_BIO.test(l) && !UI_WORDS.has(l.toLowerCase()) && !isFacebookText(l),
    );
    if (lines.length) return cut(lines[lines.length - 1], PROFILE_READ_LIMITS.bio);
  }
  return null;
}

/** What's featured: each item's words, and its pictures' descriptions, after the Featured title up to the next card. */
function featuredOf(main: Element): string[] {
  const title = [...elementsIn(main)].find(
    (e) =>
      (isHeading(e) || e.childElementCount === 0) &&
      clean(e.textContent).toLowerCase() === 'featured',
  );
  if (!title) return [];
  let column: Element = title;
  for (let steps = 0; steps < 8 && column.parentElement && column !== main; steps++) {
    const up: Element = column.parentElement;
    if (textLines(up, 1)[0]?.toLowerCase() !== 'featured') break;
    column = up;
  }
  const lines: string[] = [];
  for (const line of textLines(column, 30).slice(1)) {
    if (AFTER_FEATURED.test(line)) break;
    if (UI_WORDS.has(line.toLowerCase()) || isFacebookText(line)) continue;
    lines.push(line);
  }
  for (const image of column.querySelectorAll('img[alt]')) {
    const alt = clean(image.getAttribute('alt'));
    if (alt) lines.push(alt);
  }
  return [...new Set(lines)]
    .map((l) => l.slice(0, PROFILE_READ_LIMITS.line))
    .slice(0, PROFILE_READ_LIMITS.featured);
}

/** October 2026's card with their links. */
const LINKS_CARD = /^links$/i;

/** An address off Facebook: as it is, or the one inside Facebook's l.php link. Null for Facebook's own pages. */
export function outsideLink(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href, 'https://www.facebook.com');
  } catch {
    return null;
  }
  if (/(^|\.)facebook\.com$/i.test(url.hostname)) {
    const inner = url.pathname === '/l.php' ? url.searchParams.get('u') : null;
    return inner ? outsideLink(inner) : null;
  }
  return /^https?:$/.test(url.protocol) ? url.href.slice(0, 500) : null;
}

/** The Links card's addresses: their own sites and other accounts. */
function linksOf(main: Element): string[] {
  const found: string[] = [];
  for (const title of cardTitles(main, LINKS_CARD))
    for (const a of cardList(title)?.querySelectorAll('a[href]') ?? []) {
      const url = outsideLink(a.getAttribute('href') ?? '');
      if (url && !found.includes(url)) found.push(url);
    }
  return found.slice(0, PROFILE_READ_LIMITS.links);
}

/** The person's own profile as the AI's check reads it (`ProfileRead`), from the page the tab shows. */
export function readOwnProfile(doc: Document, url: string, address: PageAddress): ProfileRead {
  const main = mainOf(doc);
  const read = readProfile(main, address, url, doc.title);
  const name = read.profile.name;
  const bio = bioOf(doc);
  return {
    url: address.profile?.url ?? url,
    name,
    ...picturesOf(main, name),
    bio,
    links: linksOf(main),
    intro: [...new Set([...read.profile.intro, ...cardsIntro(main)])]
      .filter((l) => l !== bio && !EDIT_BIO.test(l))
      .map((l) => l.slice(0, PROFILE_READ_LIMITS.line))
      .slice(0, PROFILE_READ_LIMITS.intro),
    featured: featuredOf(main),
    posts: read.posts
      .map((p) => p.text.slice(0, PROFILE_READ_LIMITS.post))
      .filter(Boolean)
      .slice(0, PROFILE_READ_LIMITS.posts),
  };
}

/** How putting a bio in went. */
export type BioResult =
  /** In, and showing on the profile. */
  | 'done'
  /** No Edit bio or Add bio here, or something else wasn't as expected: the person does it. */
  | 'none'
  /** Written, but it didn't show after Save. */
  | 'not_saved';

/** The box Facebook opens to write the bio in: a plain box, or one to write in, where Edit bio was. */
export function bioBox(doc: Document): HTMLElement | null {
  return (
    [
      ...mainOf(doc).querySelectorAll<HTMLElement>(
        'textarea, [role="textbox"], [contenteditable="true"]',
      ),
    ].find(shown) ?? null
  );
}

/** The bio's title on the About tab's editor, and the control after it that opens its box. */
const BIO_TITLE = /^bio$/i;
const BIO_CONTROL = /^(edit|add)( bio)?$/i;
/** What labels the bio's own box: its name, or Facebook's hint in it. */
const BIO_FIELD = /\bbio\b|\bdescribe who you are\b/i;

/**
 * The bio's own control where Edit bio isn't on the profile (the About tab's editor, October 2026): a button labelled
 * Edit bio or Add bio, in the box on top first (`labelled`); else the Edit (or Add) of the Bio row itself, found by its
 * title (./editors.ts `rowControl`): never another row's, so with no Edit of its own, none. `between` is the bio as
 * the row shows it, when it does. Null when neither is there.
 */
export function bioRow(doc: Document): {
  readonly control: HTMLElement;
  readonly labelled: boolean;
  readonly between: readonly string[];
} | null {
  const places = placesOf(doc);
  for (const place of places) {
    const labelled = buttonsIn(place, EDIT_BIO)[0];
    if (labelled) return { control: labelled, labelled: true, between: [] };
  }
  for (const place of places)
    for (const title of titlesIn(place, BIO_TITLE)) {
      const row = rowControl(title, BIO_CONTROL);
      if (row) return { ...row, labelled: false };
    }
  return null;
}

/** The bio's own control (`bioRow`), or null. */
export const bioControl = (doc: Document): HTMLElement | null => bioRow(doc)?.control ?? null;

/**
 * Whether the box the Bio row's Edit opened is the bio's: named for it (Bio, "Describe who you are"), or holding the
 * bio the row showed, or the row showing nothing between its title and its Edit. A labelled Edit bio's box always is.
 */
export function bioBoxFits(
  box: HTMLElement,
  row: { readonly labelled: boolean; readonly between: readonly string[] },
): boolean {
  if (row.labelled) return true;
  const named = [fieldName(box), box.getAttribute('aria-label'), box.getAttribute('placeholder')];
  if (named.some((n) => BIO_FIELD.test(clean(n)))) return true;
  const shownBio = row.between[0];
  return shownBio === undefined || clean(textOf(box)) === clean(shownBio);
}

/** The names of the buttons on the page (or in the box on top) as the outline shows them: what was there instead. */
export function buttonNamesOn(doc: Document, most = 12): string[] {
  const place = placesOf(doc)[0] === doc.body ? mainOf(doc) : placesOf(doc)[0]!;
  return [...place.querySelectorAll(EDITOR_BUTTONS)]
    .filter((b) => shown(b) && !inTopBar(b))
    .slice(0, most)
    .map((b) => maskText(labelOf(b)).slice(0, 60) || `(${b.tagName.toLowerCase()})`);
}

/**
 * Whether the bio shows: as the profile reads it (by Edit bio, or above the details row), or on the About tab's editor
 * as the line right after the title "Bio", never anywhere else on the page.
 */
function bioShows(doc: Document, bio: string): boolean {
  const wanted = clean(bio);
  if (bioOf(doc) === wanted) return true;
  return placesOf(doc).some((place) =>
    titlesIn(place, BIO_TITLE).some((title) => clean(lineAfter(title)) === wanted),
  );
}

/**
 * Puts the bio in: presses Edit bio, or else the bio's own control on the About tab's editor (`bioRow`); writes the
 * bio in the one box that opens, in place of what was there, once it's known to be the bio's (`bioBoxFits`, else it's
 * closed again with its Cancel); presses that box's own Save; and waits for the box to close and the bio to show
 * under its title. Nothing is pressed while Facebook shows a warning: the job reads it. How each step went comes with
 * it, for the note of the page when it hands the step to the person.
 */
export async function writeBioSteps(
  doc: Document,
  bio: string,
): Promise<{ readonly result: BioResult; readonly steps: EditorSteps }> {
  const button = bioButton(doc);
  const row = button ? null : bioRow(doc);
  const control = button ?? row?.control ?? null;
  const none = (steps: EditorSteps) => ({
    result: 'none' as const,
    steps: { ...steps, names: buttonNamesOn(doc) },
  });
  if (!control) return none(NO_STEPS);
  if (readWarnings(doc, doc.location.href).length) return none({ ...NO_STEPS, control: true });
  const opened = await newBoxAfter(doc, () => control.click());
  // Edit bio's box, as it was always found: the first on the profile to write in.
  const box = opened.box ?? (button ? bioBox(doc) : null);
  let steps: EditorSteps = { ...NO_STEPS, control: true, boxes: box ? 1 : opened.boxes };
  if (!box) return none(steps);
  if (row && !bioBoxFits(box, row)) {
    // Another part's box: closed again as it was, nothing written in it.
    cancelBy(box).found?.click();
    return none({ ...steps, fits: false });
  }
  typeInto(doc, box, bio, true);
  await pause(300);
  steps = { ...steps, typed: clean(textOf(box)) === clean(bio) };
  if (!steps.typed) return none(steps);
  const save = saveBy(box);
  steps = { ...steps, saves: save.count, saveOn: save.on };
  if (!save.found) return none(steps);
  save.found.click();
  for (let waited = 0; waited < WAIT_MS; waited += LOOK_MS) {
    await pause(LOOK_MS);
    if (gone(box) && bioShows(doc, bio))
      return { result: 'done', steps: { ...steps, saved: true } };
  }
  return { result: 'not_saved', steps: { ...steps, names: buttonNamesOn(doc) } };
}

/** Puts the bio in (`writeBioSteps`): how it went. */
export async function writeBio(doc: Document, bio: string): Promise<BioResult> {
  return (await writeBioSteps(doc, bio)).result;
}

/**
 * Where the person's own profile is changed, from the profile the page shows (decision 89): for the job alone, never
 * sent to HandsFreeOS.
 */
export interface OwnEditors {
  /** Edit profile's link: the About tab's editor, where the bio is changed in October 2026's layout. */
  readonly about: string | null;
  /** The Links card's Edit links (Contact and basic info), where links are added; else that page by the address. */
  readonly links: string | null;
  /** Work and education on the About tab, by the address, where their work is added (decision 99). */
  readonly work?: string | null;
  /** The profile's number, which Accounts Center's username page goes by: Edit profile's `id=`, or the address's. */
  readonly id: string | null;
  /** The username in the profile's address. */
  readonly username: string | null;
}

const EDIT_PROFILE = /^edit profile$/i;
const EDIT_LINKS = /^edit links$/i;
const NUMBER = /^\d{1,20}$/;

/**
 * Where the person's own profile is changed: Edit profile's and Edit links's addresses, and its number. Without their
 * labels, only a link to this same profile counts (`ownLink`), never one to someone else's.
 */
export function ownEditorsOf(doc: Document, href: string): OwnEditors {
  const links = [...mainOf(doc).querySelectorAll('a[href]')].filter((a) => !inTopBar(a));
  const urlOf = (a: Element) => facebookUrl(a.getAttribute('href') ?? '', href);
  const label = (a: Element) => clean(a.getAttribute('aria-label'));
  const tabOf = (url: URL) =>
    (pathParts(url)[0]?.toLowerCase() === 'profile.php'
      ? url.searchParams.get('sk')
      : pathParts(url)[1]) ?? '';
  const profile = classifyUrl(href).profile;
  /**
   * A link to this profile: by its username or its number, as the address the page shows has it; with the other one,
   * by Facebook's mark on a link to edit your own profile.
   */
  const ownLink = (url: URL): boolean => {
    const to = classifyUrl(url.href).profile;
    if (!to || !profile) return false;
    if (to.username && profile.username)
      return to.username.toLowerCase() === profile.username.toLowerCase();
    if (to.id && profile.id) return to.id === profile.id;
    return url.searchParams.has('fb_profile_edit_entry_point');
  };
  const aboutLink =
    links.find((a) => EDIT_PROFILE.test(label(a))) ??
    links.find((a) => {
      const url = urlOf(a);
      return (
        url !== null &&
        url.searchParams.has('fb_profile_edit_entry_point') &&
        tabOf(url) === 'about' &&
        ownLink(url)
      );
    });
  const linksLink =
    links.find((a) => EDIT_LINKS.test(label(a))) ??
    links.find((a) => {
      const url = urlOf(a);
      return url !== null && tabOf(url).toLowerCase() === 'about_contact' && ownLink(url);
    });
  const whole = (a: Element | undefined) => {
    const url = a ? urlOf(a) : null;
    return url ? workUrl(url.href) : null;
  };
  const aboutId = aboutLink ? (urlOf(aboutLink)?.searchParams.get('id') ?? null) : null;
  const id = aboutId && NUMBER.test(aboutId) ? aboutId : (profile?.id ?? null);
  const tab = (sk: string) =>
    profile?.username
      ? `${FACEBOOK}/${encodeURIComponent(profile.username)}/${sk}`
      : id
        ? `${FACEBOOK}/profile.php?id=${id}&sk=${sk}`
        : null;
  return {
    about: whole(aboutLink),
    links: whole(linksLink) ?? tab('about_contact'),
    work: tab('about_work_and_education'),
    id,
    username: profile?.username ?? null,
  };
}
