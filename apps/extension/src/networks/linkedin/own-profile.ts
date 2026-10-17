/**
 * The person's own LinkedIn profile (docs/outreach.md, decision 64; HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md,
 * "What maps to what": Get ready's profile is the headline, the About and Featured, with the photo and the banner as
 * tips), read for the AI's check, and the headline put in once they've picked one.
 *
 * - **What it reads**, as core's `ProfileRead` for LinkedIn: the headline as the bio, the About, each role under
 *   Experience as an intro line ("Founder at Gee Consulting · 2019 - Present"), what's featured, and the latest posts
 *   under Activity. LinkedIn doesn't describe the photo and the banner as Facebook does, so it says only whether the
 *   top shows them: a picture there labelled with their name or as a profile photo (its own label, or the label of
 *   the box around it, as LinkedIn's newer layout draws it), and one labelled as a background or banner. It reads it
 *   all from the page as it is, pressing nothing: an About's or a role's "…more" only shows words already there.
 * - **Putting the headline in:** it presses the pencil on the top card (**Edit intro**, or **Edit profile** as its
 *   newer layout labels it, by its link to the intro's box), waits for the box it opens, writes the headline in the
 *   one field there named **Headline** (by a label, or by the line just above it, where the newer box names its writing
 *   box), in place of what was there, presses that box's **Save**, and waits for the box to close and the line under the name to say it. It types in no other field and
 *   presses nothing else. Anything it doesn't expect (no Edit intro, no box, no Headline field or more than one, no
 *   Save, the words not in the field, the box still open after Save) and it stops and says so; the job hands the step
 *   to the person, and never guesses.
 *
 * Like the rest of the readers it goes by what a person sees (words, labels, page order), never LinkedIn's class
 * names. It's tuned from the owner's outline of his own profile of 16 Oct 2026 (LinkedIn's newer layout:
 * test/fixtures/linkedin-own-profile-2026-10.html), and still reads the older one.
 */
import { PROFILE_READ_LIMITS, type ProfileRead } from '@hfos/core/addons/outreach/profile-check';
import { clean } from '../facebook/dom';
import { shown } from '../facebook/fetch';
import { typeInto } from '../facebook/join';
import { sameName } from '../facebook/people';
import { controlsIn, CONTROLS, mainOf, shownLines, wordsOf } from './dom';
import { readPosts } from './posts';
import { inTopCard, readProfile, rolesOf, sectionLines, sectionOf } from './profile';
import type { Role } from './types';
import { classifyUrl } from './urls';
import { nameFrom } from './vocabulary';

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
const PHOTO = /\bprofile (photo|picture|image|pic)\b|^photo of\b|\bavatar\b/i;
const BANNER = /\b(background|banner|cover)\b/i;
/** LinkedIn's stand-in for someone with no photo: its address says so. */
const GHOST = /ghost|static\.licdn\.com\/aero/i;
/** The box LinkedIn's newer layout keeps a post's words in. */
const TEXT_BOX = '[data-testid="expandable-text-box"]';
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

/** How long each step down waits for LinkedIn to draw what came into view, and how many steps it takes at most. */
const LOAD_PAUSE_MS = 700;
const LOAD_STEPS = 30;
/**
 * How long a part LinkedIn holds a place for is kept in view for it to be drawn, and how long the whole wait may take:
 * LinkedIn's newer layout fetches those parts once their places come into view, which can take seconds.
 */
const PLACE_WAIT_MS = 6_000;
const LOAD_WAIT_MS = 24_000;

/** The box the profile scrolls in: one around the main column that scrolls by itself, else the page. */
function scrollBoxOf(doc: Document): Element {
  for (let box = mainOf(doc).parentElement; box; box = box.parentElement) {
    if (box === doc.documentElement || box === doc.body) break;
    const style = doc.defaultView?.getComputedStyle(box);
    if (
      style &&
      box.scrollHeight > box.clientHeight + 4 &&
      (style.overflowY === 'auto' || style.overflowY === 'scroll')
    )
      return box;
  }
  return doc.scrollingElement ?? doc.documentElement;
}

/**
 * A part of the profile LinkedIn holds a place for until it draws it: a section in the main column with nothing in it
 * yet but empty boxes (no words, no pictures, no links or buttons). The owner's report of 17 Oct 2026 had two of them
 * below Activity, where About, Experience and the rest go.
 */
const placeholder = (section: Element) =>
  !clean(section.textContent) &&
  !section.querySelector('img, svg, a[href], button, input, h1, h2, h3, h4, [role="img"]');

const placesIn = (doc: Document) =>
  [...mainOf(doc).querySelectorAll('section')].filter(
    (section) => !section.closest('aside') && placeholder(section),
  );

/** How loading the whole profile went, for the job's note of the page (decision 74). */
export interface ProfileLoad {
  /** Steps down the page it took. */
  readonly steps: number;
  /** Parts LinkedIn held a place for when it started, and those still empty when it read. */
  readonly places: number;
  readonly left: number;
  /** Whether the page itself scrolled, rather than a box around the main column. */
  readonly page: boolean;
}

export interface LoadWaits {
  readonly pauseMs?: number;
  /** How often a part it's waiting on is looked at. */
  readonly lookMs?: number;
  readonly placeMs?: number;
  readonly totalMs?: number;
}

/**
 * Keeps each part LinkedIn still holds a place for in view till it's drawn: the first first, then the next, each for
 * `placeMs` at most and all of them for `totalMs`. Drawing one may add places below it, which are waited on too.
 */
async function drawPlaces(doc: Document, lookMs: number, placeMs: number, totalMs: number) {
  const end = Date.now() + totalMs;
  const gaveUp = new Set<Element>();
  for (;;) {
    const place = placesIn(doc).find((p) => !gaveUp.has(p));
    if (!place || Date.now() >= end) return;
    place.scrollIntoView?.({ block: 'center' });
    const until = Math.min(end, Date.now() + placeMs);
    while (Date.now() < until && place.isConnected && placeholder(place)) await pause(lookMs);
    if (place.isConnected && placeholder(place)) gaveUp.add(place);
  }
}

/**
 * Scrolls the profile down to its foot, most of a screen at a time; keeps each part LinkedIn still holds a place for
 * in view till it's drawn; then goes back to the top. LinkedIn draws Experience, Featured, Activity and the rest only
 * as they come into view, so a read straight after the page opens misses them (the owner's test, 16 Oct 2026: no
 * Experience, Featured or posts were read), and its newer layout fetches them once their places are in view, which a
 * quick trip to the foot and back missed (the owner's Check LinkedIn, 17 Oct 2026: About and Experience still empty
 * places). The trip down stops once the foot is reached and the page has stopped growing, or after `LOAD_STEPS`.
 */
export async function loadWholeProfile(doc: Document, waits: LoadWaits = {}): Promise<ProfileLoad> {
  const pauseMs = waits.pauseMs ?? LOAD_PAUSE_MS;
  const box = scrollBoxOf(doc);
  const places = placesIn(doc).length;
  let still = 0;
  let steps = 0;
  for (; steps < LOAD_STEPS && still < 2; steps++) {
    const height = box.scrollHeight;
    box.scrollTop += Math.max(300, box.clientHeight * 0.8);
    await pause(pauseMs);
    const atFoot = box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
    still = atFoot && box.scrollHeight === height ? still + 1 : 0;
  }
  await drawPlaces(
    doc,
    waits.lookMs ?? LOOK_MS,
    waits.placeMs ?? PLACE_WAIT_MS,
    waits.totalMs ?? LOAD_WAIT_MS,
  );
  const left = placesIn(doc).length;
  box.scrollTop = 0;
  await pause(pauseMs);
  return {
    steps,
    places,
    left,
    page: box === doc.scrollingElement || box === doc.documentElement,
  };
}

/** Whether a picture is LinkedIn's stand-in for no photo, by its address. */
const ghost = (picture: Element) => {
  const image = picture.matches('img') ? picture : picture.querySelector('img');
  return GHOST.test(image?.getAttribute('src') ?? '');
};

/**
 * Whether the top shows their photo and a banner: LinkedIn doesn't say what's in them. Each picture in the top card
 * by its label: an image's own, or (LinkedIn's newer layout) the label of the box around a picture hidden from screen
 * readers. Labelled as a background, banner or cover, it's the banner; with their name or as a profile photo, the
 * photo, unless its address is LinkedIn's stand-in for someone with none.
 */
function picturesOf(
  main: Element,
  name: string | null,
): { picture: string | null; cover: string | null } {
  let picture: string | null = null;
  let cover: string | null = null;
  const pictures = [
    ...main.querySelectorAll('img[alt], [role="img"][aria-label], [aria-label]'),
  ].filter(
    (element) =>
      element.matches('img, [role="img"]') ||
      (!element.matches(`${CONTROLS}, a[href]`) && element.querySelector('figure, img') !== null),
  );
  for (const image of pictures) {
    if (!inTopCard(image, main)) continue;
    const label = clean(image.getAttribute('alt') ?? image.getAttribute('aria-label'));
    if (!label) continue;
    if (BANNER.test(label)) cover ??= 'A banner image LinkedIn didn’t describe';
    else if (
      (PHOTO.test(label) || (name !== null && sameName(nameFrom(label), name))) &&
      !ghost(image)
    )
      picture ??= 'A profile photo LinkedIn didn’t describe';
  }
  return { picture, cover };
}

/**
 * The latest posts under Activity, newest first: the posts in the part of the page between it and the next heading,
 * or where LinkedIn's newer layout draws them as cards, each card's words. None where it says you haven't posted.
 */
function activityOf(main: Element, base: string): string[] {
  const section = sectionOf(main, /^activity$/i);
  if (!section) return [];
  // The largest box around the heading that reaches neither the next section nor the one above: with the sections
  // below not drawn yet, the one above is all that stops it before About's words.
  let box: Element = section.heading;
  for (let up = box.parentElement; up && up !== main.parentElement; up = up.parentElement) {
    if ([section.end, section.above].some((other) => other && up.contains(other))) break;
    box = up;
  }
  const posts = readPosts(box, base).map((post) => post.text);
  const texts = posts.length
    ? posts
    : [...box.querySelectorAll(TEXT_BOX)].map((words) =>
        shownLines(words, { max: 40, exclude: CONTROLS }).join('\n'),
      );
  return [...new Set(texts)]
    .map((text) => text.slice(0, PROFILE_READ_LIMITS.post))
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
    intro: rolesOf(main, PROFILE_READ_LIMITS.intro, href).map((role) =>
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

/** LinkedIn's address for the intro's box, which the pencil leads to: /in/<you>/edit/intro/. */
const INTRO_ADDRESS = /\/in\/[^/]+\/edit\/intro\/?(?:[?#]|$)/i;

/** Whether a control leads to the intro's box by LinkedIn's address for it. */
const toIntro = (control: Element) => {
  const href = control.getAttribute('href');
  if (!href) return false;
  try {
    return INTRO_ADDRESS.test(new URL(href, control.ownerDocument.baseURI).pathname);
  } catch {
    return false;
  }
};

/**
 * The pencil on the top card that edits the intro, where it shows: labelled Edit intro, or (LinkedIn's newer layout,
 * the owner's Check LinkedIn of 17 Oct 2026, where its label was something else) the link to the intro's box.
 */
function editIntroOf(doc: Document): HTMLElement | null {
  const main = mainOf(doc);
  const pencils = controlsIn(main).filter(
    (control): control is HTMLElement => inTopCard(control, main) && shown(control),
  );
  return (
    pencils.find((control) => wordsOf(control).some((words) => EDIT_INTRO.test(words))) ??
    pencils.find(toIntro) ??
    null
  );
}

/**
 * The words just above a field, where LinkedIn's newer boxes name it: a line before the field, or before a box around
 * it (Headline above its writing box, the owner's Put this one in of 17 Oct 2026). A long line isn't a name.
 */
function nameAbove(field: Element): string {
  let at: Element | null = field;
  for (let up = 0; at && up < 3; up++, at = at.parentElement) {
    const before = at.previousElementSibling;
    if (!before) continue;
    const words = clean(before.textContent);
    return words.length <= 40 ? words : '';
  }
  return '';
}

/**
 * What labels a field: its label for screen readers, the label that names it, the one around it, or the words just
 * above it.
 */
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
  return clean((named ?? field.closest('label'))?.textContent) || nameAbove(field);
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
