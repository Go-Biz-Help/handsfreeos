/**
 * The person's own LinkedIn profile (docs/outreach.md, decision 64; HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md,
 * "What maps to what": Get ready's profile is the headline, the About and Featured, with the photo and the banner as
 * tips), read for the AI's check, and the headline put in once they've picked one.
 *
 * - **What it reads**, as core's `ProfileRead` for LinkedIn: the headline as the bio, the About, each role under
 *   Experience as an intro line ("Founder at Gee Consulting · 2019 - Present"), what's featured, and the latest posts
 *   under Activity. LinkedIn doesn't describe the photo and the banner as Facebook does, so it says only whether the
 *   top shows them.
 * - **Putting the headline in:** it presses the pencil on the top card (**Edit intro**), waits for the box it opens,
 *   writes the headline in the one field there labelled **Headline**, in place of what was there, presses that box's
 *   **Save**, and waits for the box to close and the line under the name to say it. It types in no other field and
 *   presses nothing else. Anything it doesn't expect (no Edit intro, no box, no Headline field or more than one, no
 *   Save, the words not in the field, the box still open after Save) and it stops and says so; the job hands the step
 *   to the person, and never guesses.
 *
 * Like the rest of the readers it goes by what a person sees (words, labels, page order), never LinkedIn's class
 * names, and was written from what LinkedIn is known to show, not yet tried on a real account.
 */
import { PROFILE_READ_LIMITS, type ProfileRead } from '@hfos/core/addons/outreach/profile-check';
import { clean } from '../facebook/dom';
import { shown } from '../facebook/fetch';
import { typeInto } from '../facebook/join';
import { controlsIn, CONTROLS, mainOf, wordsOf } from './dom';
import { readPosts } from './posts';
import { inTopCard, readProfile, rolesOf, sectionLines, sectionOf } from './profile';
import type { Role } from './types';
import { classifyUrl } from './urls';

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** The pencil on the top card that opens the intro's box. */
const EDIT_INTRO = /^edit intro$/i;
/** The box's field for the headline, as its label says it: "Headline*". */
const HEADLINE = /^headline\s*\*?$/i;
const SAVE = /^save$/i;
/** What LinkedIn draws over the page: the intro's box. */
const OVER_THE_PAGE = '[role="dialog"], [role="alertdialog"], dialog';
/** Where a person writes. */
const FIELDS = 'input, textarea, [role="textbox"], [contenteditable="true"]';
/** What a featured item says it is, above its own words. */
const FEATURED_KIND = /^(post|link|article|document|newsletter|image|video|media)$/i;
const FEATURED_KIND_BEFORE = /^(post|link|article|document|newsletter|image|video|media)\s+/i;
/** The top's pictures: the photo by their name or as LinkedIn labels it, and the banner. */
const PHOTO = /\bprofile (photo|picture)\b|^photo of\b/i;
const BANNER = /\b(background|banner|cover)\b/i;
/** How long the intro's box, and the headline saved, are waited on, and how often they're looked at. */
const WAIT_MS = 8_000;
const LOOK_MS = 400;

const cut = (text: string | null | undefined, most: number): string | null => {
  const t = clean(text);
  return t ? t.slice(0, most) : null;
};

/** A role as one line: "Founder at Gee Consulting · 2019 - Present · 6 yrs". */
const roleLine = (role: Role) =>
  [role.company ? `${role.title} at ${role.company}` : role.title, role.dates]
    .filter(Boolean)
    .join(' · ');

/** Whether the top shows their photo and a banner: LinkedIn doesn't say what's in them. */
function picturesOf(
  main: Element,
  name: string | null,
): { picture: string | null; cover: string | null } {
  let picture: string | null = null;
  let cover: string | null = null;
  for (const image of main.querySelectorAll('img[alt], [role="img"][aria-label]')) {
    if (!inTopCard(image, main)) continue;
    const label = clean(image.getAttribute('alt') ?? image.getAttribute('aria-label'));
    if (!label) continue;
    if (BANNER.test(label)) cover ??= 'A banner image LinkedIn didn’t describe';
    else if (PHOTO.test(label) || (name !== null && label === name))
      picture ??= 'A profile photo LinkedIn didn’t describe';
  }
  return { picture, cover };
}

/** The latest posts under Activity, newest first: the posts in the part of the page between it and the next heading. */
function activityOf(main: Element, base: string): string[] {
  const section = sectionOf(main, /^activity$/i);
  if (!section) return [];
  // The largest box around the heading that doesn't reach the next section.
  let box: Element = section.heading;
  for (let up = box.parentElement; up && up !== main.parentElement; up = up.parentElement) {
    if (section.end && up.contains(section.end)) break;
    box = up;
  }
  return readPosts(box, base)
    .map((post) => post.text.slice(0, PROFILE_READ_LIMITS.post))
    .filter(Boolean)
    .slice(0, PROFILE_READ_LIMITS.posts);
}

/** The person's own profile as the AI's check reads it (`ProfileRead`), from the page the tab shows. */
export function readOwnProfile(doc: Document, href: string): ProfileRead {
  const main = mainOf(doc);
  const address = classifyUrl(href);
  const read = readProfile(main, address, href, doc.title);
  // Each item's kind ("Post", "Link") is LinkedIn's word above its own: on a line of its own, or before its words.
  const featured = sectionLines(main, /^featured$/i, 30)
    .map((line) => line.replace(FEATURED_KIND_BEFORE, ''))
    .filter((line) => line && !FEATURED_KIND.test(line))
    .map((line) => line.slice(0, PROFILE_READ_LIMITS.line));
  return {
    platform: 'linkedin',
    url: address.profile?.url ?? read.profile?.url ?? href,
    name: read.name,
    ...picturesOf(main, read.name),
    bio: cut(read.headline, PROFILE_READ_LIMITS.bio),
    about: read.about ? read.about.slice(0, PROFILE_READ_LIMITS.about) : null,
    intro: rolesOf(main, PROFILE_READ_LIMITS.intro).map((role) =>
      roleLine(role).slice(0, PROFILE_READ_LIMITS.line),
    ),
    featured: [...new Set(featured)].slice(0, PROFILE_READ_LIMITS.featured),
    posts: activityOf(main, href),
  };
}

/** The headline under the name, as the page shows it now. */
export function headlineOf(doc: Document, href: string): string | null {
  return readProfile(mainOf(doc), classifyUrl(href), href, doc.title).headline;
}

/** The pencil on the top card that edits the intro, where it shows. */
function editIntroOf(doc: Document): HTMLElement | null {
  const main = mainOf(doc);
  return (
    controlsIn(main).find(
      (control): control is HTMLElement =>
        inTopCard(control, main) &&
        shown(control) &&
        wordsOf(control).some((words) => EDIT_INTRO.test(words)),
    ) ?? null
  );
}

/** What labels a field: its label for screen readers, the label that names it, or the one around it. */
function fieldLabel(field: Element): string {
  const doc = field.ownerDocument;
  const own = clean(field.getAttribute('aria-label'));
  if (own) return own;
  const by = field.getAttribute('aria-labelledby');
  if (by)
    return clean(
      by
        .split(/\s+/)
        .map((id) => doc.getElementById(id)?.textContent ?? '')
        .join(' '),
    );
  const id = field.getAttribute('id');
  const named = id
    ? [...doc.querySelectorAll('label[for]')].find((label) => label.getAttribute('for') === id)
    : null;
  return clean((named ?? field.closest('label'))?.textContent);
}

/** The fields labelled Headline in a box. */
const headlineFields = (box: Element) =>
  [...box.querySelectorAll<HTMLElement>(FIELDS)].filter(
    (field) => shown(field) && HEADLINE.test(fieldLabel(field)),
  );

/** The intro's box, once it's open: over the page, shown, with a Headline field in it. */
function introBox(doc: Document): Element | null {
  return (
    [...doc.querySelectorAll(OVER_THE_PAGE)].find(
      (box) => shown(box) && headlineFields(box).length > 0,
    ) ?? null
  );
}

/** What's written in a field now. */
const valueOf = (field: HTMLElement) =>
  clean(
    field.tagName === 'TEXTAREA' || field.tagName === 'INPUT'
      ? (field as HTMLInputElement).value
      : field.textContent,
  );

/** How putting the headline in went: the same as Facebook's bio (../facebook/own-profile.ts). */
export type HeadlineResult =
  /** In, and showing under their name. */
  | 'done'
  /** Nothing pressed but Edit intro, or nothing at all: something wasn't as expected. The person does it. */
  | 'none'
  /** Saved, but the box stayed open, or the headline didn't show after. */
  | 'not_saved';

/**
 * Presses Edit intro, writes the headline in the Headline field in place of what was there, presses Save, and waits
 * for the box to close and the headline to show.
 */
export async function writeHeadline(
  doc: Document,
  href: string,
  headline: string,
): Promise<HeadlineResult> {
  const edit = editIntroOf(doc);
  if (!edit) return 'none';
  edit.click();
  let box: Element | null = null;
  for (let waited = 0; waited < WAIT_MS && !box; waited += LOOK_MS) {
    await pause(LOOK_MS);
    box = introBox(doc);
  }
  if (!box) return 'none';
  const fields = headlineFields(box);
  const saves = [...box.querySelectorAll<HTMLElement>(`${CONTROLS}, [type="submit"]`)].filter(
    (control) => shown(control) && wordsOf(control).some((words) => SAVE.test(words)),
  );
  if (fields.length !== 1 || saves.length !== 1) return 'none';
  const field = fields[0]!;
  const wanted = clean(headline);
  typeInto(doc, field, headline, true);
  await pause(300);
  if (valueOf(field) !== wanted) return 'none';
  saves[0]!.click();
  for (let waited = 0; waited < WAIT_MS; waited += LOOK_MS) {
    await pause(LOOK_MS);
    const open = box.isConnected && shown(box);
    if (!open && clean(headlineOf(doc, href)) === wanted) return 'done';
  }
  return 'not_saved';
}
