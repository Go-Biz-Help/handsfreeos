/**
 * The person's own Instagram account (docs/outreach.md, decisions 64 and 80; Chris works from his personal account,
 * optimized as his LinkedIn is, decision 79), read for the AI's check, and the bio put in once they've picked one.
 *
 * - **What it reads**, as core's `ProfileRead` for Instagram: on their account's own page, the name shown above the
 *   bio, the bio, the links in it (as intro lines, "Link: example.com"), the highlights' names and the latest posts'
 *   words (each picture's own description, which carries its caption); on its form (/accounts/edit/), the bio as it's
 *   kept, which the page may cut. It presses nothing.
 * - **Putting the bio in:** on the form, the bio's box (named Bio, or Instagram's own `pepBio`), written in as typing
 *   does once the form has drawn itself around the focus (the owner's Check Instagram, 0.60.0: a value set by hand
 *   showed Post but didn't stay), then the form's **Submit**, and the box saying it after. Anything it doesn't expect
 *   and it stops and says so; the job hands the step to the person.
 *
 * Drawn from the owner's outline of his own account (17 Oct 2026): the name, the counts, a link and Threads in the
 * header, Edit profile and View archive under it, a "New" highlight, and Posts, Saved and Tagged. His Check of 21 Oct
 * 2026 showed Instagram's newer layout: the name under the username, beside the counts, and the bio's section starting
 * with what he does (a line of its own, as on someone else's account), with no bio under it and no posts.
 */
import { PROFILE_READ_LIMITS, type ProfileRead } from '@hfos/core/addons/outreach/profile-check';
import { clean } from '../facebook/dom';
import { shown } from '../facebook/fetch';
import { typeInto } from '../facebook/join';
import type { BioResult } from '../facebook/own-profile';
import { boxesSaying, controlsSaying, mainOf, pause, waitFor, writingIn } from '../looking/looks';

/** The bio's box on the form, as its label says it, its Submit, and what Instagram says once it's kept. */
const BIO = /^bio$|^biography$|^pepbio$/i;
const SUBMIT = /^(submit|save)$/i;
const SAVED = /\bprofile saved\b/i;
/** Instagram's own words around the header's lines: never a name or a bio. */
const OWN_WORDS =
  /^(posts?|followers?|following|edit profile|view archive|more|options|new|threads|follow|message|meta verified)$/i;
/** A count, as the header prints it: "3,872", "28.2K"; and with its word, "0 posts". */
const COUNT = /^\d[\d,.]*\s*[km]?$/i;
const COUNTED = /^\d[\d,.]*\s*[km]?\s*(posts?|followers?|following)$/i;

const cut = (text: string | null | undefined, most: number): string | null => {
  const t = clean(text);
  return t ? t.slice(0, most) : null;
};

/** The header's sections: the picture's, the name's and counts', the bio's, the buttons', the highlights'. */
const sectionsOf = (doc: Document): Element[] => [
  ...(mainOf(doc).querySelector('header')?.querySelectorAll('section') ?? []),
];

/** The section with the username in its heading, and the counts: in Instagram's newer layout, the name too. */
const nameSection = (doc: Document): Element | null =>
  sectionsOf(doc).find((section) => section.querySelector('h1, h2')) ?? null;

/** The section with the bio in it: after the one with the name and counts, never the buttons' or the highlights'. */
function bioSection(doc: Document): Element | null {
  return (
    sectionsOf(doc).find(
      (section) =>
        !section.querySelector('h1, h2, [role="menu"], a[href="/accounts/edit/"], button') &&
        section.querySelector('[dir="auto"]') !== null,
    ) ?? null
  );
}

/**
 * Whether a link is one of the bio's own: the links in a bio go off Instagram, through its own, to the site they name.
 * Instagram's badge for their Threads account is never one.
 */
const offInstagram = (anchor: Element): boolean => {
  const href = anchor.getAttribute('href') ?? '';
  if (!/^https?:/i.test(href)) return false;
  try {
    const host = new URL(href).hostname.toLowerCase();
    // l.instagram.com is the way out it sends a bio's links through.
    return host === 'l.instagram.com' || !/(^|\.)(instagram\.com|threads\.(com|net))$/.test(host);
  } catch {
    return false;
  }
};

/** The bio's own lines: what the bio's section says that isn't the name, a link or Instagram's own words. */
function bioOf(section: Element, name: string | null): string | null {
  const lines = [...section.querySelectorAll('span[dir="auto"], h1[dir="auto"]')]
    .filter((span) => !span.closest('a') && !span.querySelector('span[dir="auto"]'))
    .map((span) => clean(span.textContent))
    .filter((line) => line && line !== name && !OWN_WORDS.test(line));
  return lines.length ? cut(lines.join('\n'), PROFILE_READ_LIMITS.bio) : null;
}

/** Their account's own page as the AI's check reads it, or its form's bio when the tab shows the form. */
export function readOwnProfile(doc: Document, href: string): ProfileRead {
  const onForm = /\/accounts\/edit\/?$/i.test(new URL(href).pathname);
  if (onForm)
    return {
      platform: 'instagram',
      url: href,
      bio: cut(bioBoxOf(doc)?.value, PROFILE_READ_LIMITS.bio),
    };
  const header = mainOf(doc).querySelector('header');
  const section = bioSection(doc);
  // The name: under the username, beside the counts, in Instagram's newer layout (the owner's Check, 21 Oct 2026, as
  // someone else's account had it on 18 Oct), where the bio's section starts with what they do instead; else the bio's
  // section's first line, as his own account had it on 17 Oct.
  const named = (line: string) =>
    line !== '' && !OWN_WORDS.test(line) && !COUNT.test(line) && !COUNTED.test(line);
  const underUsername = [...(nameSection(doc)?.querySelectorAll('span[dir="auto"]') ?? [])]
    .filter((span) => !span.closest('a, button, h1, h2') && !span.querySelector('span[dir="auto"]'))
    .map((span) => clean(span.textContent))
    .find(named);
  const name =
    cut(
      underUsername ??
        [...(section?.querySelectorAll('[dir="auto"]') ?? [])]
          .map((line) => clean(line.textContent))
          .find(named),
      PROFILE_READ_LIMITS.line,
    ) ?? null;
  const links = [...(section?.querySelectorAll('a[href]') ?? [])]
    .filter(offInstagram)
    .map((anchor) => clean(anchor.textContent))
    .filter((words) => words && !OWN_WORDS.test(words))
    .map((words) => `Link: ${words}`.slice(0, PROFILE_READ_LIMITS.line));
  // Each highlight's name, never its picture's: the "New" one to add a highlight has an icon whose own title the page
  // holds as words (his Check of 21 Oct 2026 read it as a highlight).
  const highlights = [...(header?.querySelectorAll('[role="menu"] li') ?? [])]
    .map((item) => {
      const copy = item.cloneNode(true) as Element;
      for (const icon of copy.querySelectorAll('svg')) icon.remove();
      return clean(copy.textContent);
    })
    .filter((words) => words && !OWN_WORDS.test(words));
  const posts = [
    ...mainOf(doc).querySelectorAll('a[href*="/p/"] img[alt], a[href*="/reel/"] img[alt]'),
  ]
    .map((image) => clean(image.getAttribute('alt')))
    .filter(Boolean);
  const picture = header?.querySelector('img[alt]')
    ? 'A profile photo Instagram didn’t describe'
    : null;
  return {
    platform: 'instagram',
    url: href,
    name,
    picture,
    bio: section ? bioOf(section, name) : null,
    intro: [...new Set(links)].slice(0, PROFILE_READ_LIMITS.intro),
    featured: [...new Set(highlights)].slice(0, PROFILE_READ_LIMITS.featured),
    posts: [...new Set(posts)]
      .map((post) => post.slice(0, PROFILE_READ_LIMITS.post))
      .slice(0, PROFILE_READ_LIMITS.posts),
  };
}

/** The bio's box on the form: named Bio, or Instagram's own. */
function bioBoxOf(doc: Document): HTMLTextAreaElement | null {
  const main = mainOf(doc);
  const named = boxesSaying(main, BIO).find(
    (box): box is HTMLTextAreaElement => box.tagName === 'TEXTAREA',
  );
  return (
    named ?? main.querySelector<HTMLTextAreaElement>('textarea#pepBio, textarea[name="biography"]')
  );
}

/**
 * Writes in a box as typing does, in place of what's there; a value set by hand only where that can't be done. Typing
 * goes where the focus is, so it's never done unless the box has it.
 */
function writeIn(doc: Document, box: HTMLTextAreaElement, text: string): void {
  box.focus();
  const focused = doc.activeElement === box;
  if (focused) box.select();
  const typed =
    focused &&
    typeof doc.execCommand === 'function' &&
    (text ? doc.execCommand('insertText', false, text) : doc.execCommand('delete'));
  if (!typed) typeInto(doc, box, text, true);
}

/**
 * Puts the bio in on the form: the bio's box written in place of what was there, its Submit pressed, and the box
 * saying the bio after. `none` when the box or Submit isn't there, or the words didn't take; `not_saved` when Submit
 * didn't keep them.
 */
export async function writeBio(doc: Document, bio: string): Promise<BioResult> {
  const wanted = clean(bio);
  let box = bioBoxOf(doc);
  if (!box) return 'none';
  // In already: Instagram keeps Submit off with nothing changed.
  if (clean(box.value) === wanted) return 'done';
  // Instagram redraws the form once its box has the focus, and may again as it's written in, so the box is found
  // again after each (Check Instagram's comment box, 0.62.0).
  box.focus();
  await pause(400);
  box = bioBoxOf(doc) ?? box;
  writeIn(doc, box, bio);
  const typed = await waitFor(() => (clean(bioBoxOf(doc)?.value) === wanted ? true : null), 2_000);
  if (!typed) return 'none';
  const submit = controlsSaying(mainOf(doc), SUBMIT, true).find((control) => shown(control));
  if (!submit) return 'none';
  submit.click();
  // Kept once Instagram says so, or Submit is off again (nothing left to keep), with the bio still in the box.
  const kept = await waitFor(() => {
    const now = bioBoxOf(doc);
    const off =
      !submit.isConnected ||
      submit.getAttribute('aria-disabled') === 'true' ||
      submit.hasAttribute('disabled');
    const said = SAVED.test(clean(doc.body.textContent));
    return now && clean(now.value) === wanted && (said || off) ? true : null;
  }, 8_000);
  const last = bioBoxOf(doc);
  return kept ? 'done' : last && writingIn(last) ? 'not_saved' : 'none';
}
