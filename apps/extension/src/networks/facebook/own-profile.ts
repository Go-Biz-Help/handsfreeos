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
 *
 * Like the rest of the readers, it goes by what a person sees (words, labels, page order), never Facebook's class
 * names, and was tuned from page outlines, not yet tried on a real account.
 */
import { PROFILE_READ_LIMITS, type ProfileRead } from '@hfos/core/addons/outreach/profile-check';
import { clean, elementsIn, isBefore, isHeading, labelOf, tabsIn, textLines } from './dom';
import { shown } from './fetch';
import { typeInto } from './join';
import { readProfile } from './profile';
import type { PageAddress } from './types';
import { isFacebookText, UI_WORDS } from './vocabulary';

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const mainOf = (doc: Document): Element => doc.querySelector('[role="main"]') ?? doc.body;

const EDIT_BIO = /^(edit|add) bio$/i;
const SAVE = /^save$/i;
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

/** October 2026's cards after the tabs that stand for the Intro, and the one with their links. */
const INTRO_CARDS = /^(personal details|work|education)$/i;
const LINKS_CARD = /^links$/i;

function cardTitles(main: Element, title: RegExp): Element[] {
  return [...main.querySelectorAll('h2, h3, [role="heading"]')].filter((h) =>
    title.test(clean(h.textContent)),
  );
}

/** The list a card's title heads: the first one in the nearest box around the title that has one. */
function cardList(title: Element): Element | null {
  let card: Element | null = title;
  for (let steps = 0; card && steps < 12; steps++) {
    card = card.parentElement;
    const list = card?.querySelector('[role="list"]');
    if (list) return list;
  }
  return null;
}

/** What the Personal details, Work and Education cards say, an item a line: "Owner at Summit Roof Leads …". */
function cardsIntro(main: Element): string[] {
  const lines: string[] = [];
  for (const title of cardTitles(main, INTRO_CARDS))
    for (const item of cardList(title)?.querySelectorAll('[role="listitem"]') ?? []) {
      const line = textLines(item, 6, '[aria-hidden="true"]').join(' ');
      if (line && !UI_WORDS.has(line.toLowerCase()) && !isFacebookText(line)) lines.push(line);
    }
  return lines;
}

/** An address off Facebook: as it is, or the one inside Facebook's l.php link. Null for Facebook's own pages. */
function outsideLink(href: string): string | null {
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
  /** No Edit bio or Add bio here: the person does it. */
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

/** Presses Edit bio, writes the bio in place of what was there, presses Save, and waits for it to show. */
export async function writeBio(doc: Document, bio: string): Promise<BioResult> {
  const button = bioButton(doc);
  if (!button) return 'none';
  button.click();
  let box: HTMLElement | null = null;
  for (let waited = 0; waited < WAIT_MS && !box; waited += LOOK_MS) {
    await pause(LOOK_MS);
    box = bioBox(doc);
  }
  if (!box) return 'none';
  typeInto(doc, box, bio, true);
  await pause(300);
  const save = [...mainOf(doc).querySelectorAll<HTMLElement>('[role="button"], button')].find(
    (b) => SAVE.test(labelOf(b)) && shown(b),
  );
  if (!save) return 'none';
  save.click();
  for (let waited = 0; waited < WAIT_MS; waited += LOOK_MS) {
    await pause(LOOK_MS);
    if (!bioBox(doc) && bioOf(doc) === clean(bio)) return 'done';
  }
  return 'not_saved';
}
