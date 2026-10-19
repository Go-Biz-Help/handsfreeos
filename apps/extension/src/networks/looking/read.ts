/**
 * Reading a page on a network still looked at (./site.ts): what kind it is, the profiles and posts it links to, the
 * places its menus lead to, and its warnings. Like the other readers, it goes by links, labels and the network's own
 * words, never class names; and it's tuned from what Check <network> sends back, not from guesses.
 */
import { clean, textLines } from '../facebook/dom';
import { visible } from '../facebook/fetch';
import { maskWith, outlineWith, type OutlineOptions, type OutlineSite } from '../outline';
import type { LookingRead, LookingSite } from './site';

/** Where a network puts its warnings: never a post or a comment, whose writing a warning's words may be in. */
const PLACES = '[role="dialog"], [role="alertdialog"], [role="alert"], h1, h2, [role="heading"]';
const WRITING = 'article, [role="article"], [role="feed"]';

/** The network's warnings on the page, each once, as it worded them. */
export function readWarnings(doc: Document, href: string, site: LookingSite): string[] {
  const found = new Set<string>();
  const url = site.url(href);
  const at = url ? site.warnedAt?.(url) : null;
  if (at) found.add(at);
  for (const place of doc.querySelectorAll(PLACES)) {
    if (
      !place.matches('[role="dialog"], [role="alertdialog"], [role="alert"]') &&
      place.closest(WRITING)
    )
      continue;
    for (const line of textLines(place, 40, WRITING)) {
      if (line.length <= 300 && site.warnings.some((pattern) => pattern.test(line)))
        found.add(clean(line));
      if (found.size >= 5) return [...found];
    }
  }
  return [...found];
}

/** Text with whatever a person wrote hidden, and the network's own words kept. */
export const maskOn = (site: LookingSite) => (text: string) =>
  maskWith(text, {
    kept: (t) =>
      site.words.has(t.toLowerCase()) ||
      // Counts and times as the network prints them: "1,234", "12K", "3h", "2w".
      /^(\d{1,3}(,\d{3})*|\d+(\.\d+)?\s*[km]|\d{1,3}\s?[smhdwy])$/i.test(t),
    shapes: [],
  });

/** Where a person writes, never a search: a form's boxes. */
const BOXES =
  'textarea, input[type="text"], input:not([type]), [role="textbox"], [contenteditable="true"]';

/** Where a page's menus are: its navigation and its banner. */
const MENUS = 'nav, [role="navigation"], header, [role="banner"]';
/** Where a page's menus aren't the site's: its foot (About, Privacy, Terms…). */
const FOOT = 'footer, [role="contentinfo"]';
/** How many of each a read keeps: enough to go on with, never a whole page's worth. */
const MOST = 40;

/** An element's own words, without those inside its pictures: an icon's title says what its label already does. */
function wordsOf(element: Element): string {
  let words = '';
  const walker = element.ownerDocument.createTreeWalker(element, 4 /* NodeFilter.SHOW_TEXT */);
  for (let text = walker.nextNode(); text; text = walker.nextNode())
    if (!text.parentElement?.closest('svg')) words += text.textContent ?? '';
  return clean(words);
}

/**
 * What a control is called, as a person hears it: its label, its own words (Instagram's Following, beside an arrow
 * labelled "Down chevron icon"), or the label of the picture inside it (Instagram's Like is an icon labelled "Like").
 */
export function nameOf(element: Element): string {
  return (
    clean(element.getAttribute('aria-label')) ||
    wordsOf(element) ||
    clean(element.querySelector('svg[aria-label]')?.getAttribute('aria-label')) ||
    clean(element.querySelector('img[alt]')?.getAttribute('alt'))
  );
}

/**
 * The menu a link is in, when it's the site's: never a profile's own header on the page (Instagram draws an account's
 * name, counts and buttons in one), and never the page's foot.
 */
function inMenu(anchor: Element): boolean {
  const menu = anchor.closest(MENUS);
  if (!menu || anchor.closest(FOOT)) return false;
  return !(menu.matches('header, [role="banner"]') && menu.closest('main, [role="main"]'));
}

/** Reads a whole page on a network still looked at. */
export function readLooking(
  doc: Document,
  href: string,
  site: LookingSite,
  now: Date = new Date(),
): LookingRead {
  const page = site.url(href);
  const own = site.ownLink(doc, href);
  // Never among the people: the person, nor the account whose page this is (its own tabs link to it).
  const notThem = new Set(
    [own, page ? site.profileOf(page)?.url : null].flatMap((link) => {
      const url = link ? site.url(link) : null;
      return url ? [url.pathname.toLowerCase()] : [];
    }),
  );
  const people = new Map<string, { url: string }>();
  const posts = new Map<string, { url: string }>();
  const places = new Map<string, { name: string; url: string; worth: boolean }>();
  const links = new Map<string, { name: string; url: string }>();
  const never = new Set<string>();
  const edits = new Set<string>();
  const mask = maskOn(site);
  for (const anchor of doc.querySelectorAll('a[href]')) {
    const url = site.url(anchor.getAttribute('href') ?? '', href);
    if (!url) continue;
    if (site.editLink?.(url)) {
      if (edits.size < 5) edits.add(`${url.origin}${url.pathname}`);
      continue;
    }
    const post = site.postOf(url);
    if (post) {
      if (posts.size < MOST) posts.set(post, { url: post });
      continue;
    }
    const profile = site.profileOf(url);
    const menu = inMenu(anchor);
    if (profile && !menu) {
      if (people.size < MOST && !notThem.has(new URL(profile.url).pathname.toLowerCase()))
        people.set(profile.url.toLowerCase(), { url: profile.url });
      continue;
    }
    if (menu && url.pathname !== page?.pathname) {
      const key = `${url.pathname}${url.search}`;
      const words = nameOf(anchor);
      if (!words) continue;
      // Whether it's worth opening is decided here, on its real words: the read carries them hidden.
      const opening = site.placeOpening?.(words, url) ?? 'maybe';
      if (opening === 'never') never.add(key);
      else if (!places.has(key) && !never.has(key) && places.size < MOST)
        places.set(key, { name: mask(words), url: url.toString(), worth: opening === 'worth' });
      continue;
    }
    // The page's own links, whose words are all the site's: a tab, a connection's Message. Never one it never opens.
    if (!menu && !profile && links.size < MOST) {
      const key = `${url.pathname}${url.search}`;
      const words = nameOf(anchor);
      if (!words || mask(words) !== words || links.has(key)) continue;
      if ((site.placeOpening?.(words, url) ?? 'maybe') === 'never') continue;
      links.set(key, { name: words, url: url.toString() });
    }
  }
  for (const key of never) places.delete(key);
  const kind = page ? site.kindOf(page) : 'other';
  return {
    platform: site.platform,
    kind,
    url: href,
    readAt: now.toISOString(),
    people: [...people.values()],
    posts: [...posts.values()],
    places: [...places.values()],
    links: [...links.values()],
    own,
    edits: [...edits],
    warnings: readWarnings(doc, href, site),
    signedOut: doc.querySelector('input[type="password"]') !== null,
    boxes: [...doc.querySelectorAll(BOXES)].filter(
      (box) =>
        visible(box) &&
        box.getAttribute('role') !== 'combobox' &&
        !/search/i.test(box.getAttribute('placeholder') ?? ''),
    ).length,
    notes: [
      `The extension only reads ${site.name} for now: its steps are built from what Check ${site.name} reads.`,
    ],
  };
}

/** What a network still looked at keeps, hides and leaves out of its outline (../outline.ts). */
export function outlineSiteOf(site: LookingSite): OutlineSite {
  const mask = maskOn(site);
  return {
    name: site.name,
    url: (href, base) => site.url(href, base),
    isPathWord: (part) => site.pathWords.has(part.toLowerCase()),
    host: site.host,
    mask,
    // "Name (@name) • Instagram photos and videos": each part between the dots hidden, or kept when it's the network's.
    maskTitle: (title) =>
      clean(title)
        .split(/\s+[•|·]\s+/)
        .map(mask)
        .join(' • '),
    queryKept: new Set(['tab', 'type', 'filter', 'sort', ...(site.queryKept ?? [])]),
    queryDropped: /^(utm_|igsh|igshid$|ref$|fbclid$|__)/,
    // The menus are kept: they're what tells a network's places apart. Nothing of theirs names anyone but the person,
    // and a name is hidden like any other.
    isTopBar: () => false,
  };
}

/**
 * The page's outline the moment a look didn't work, while what it opened is still open: with what a read finds, the
 * extension's version and the window's size, as Check Facebook's tries take it.
 */
export function outlineNow(doc: Document, site: LookingSite): string {
  const view = doc.defaultView;
  const runtime = (
    globalThis as { chrome?: { runtime?: { getManifest?: () => { version: string } } } }
  ).chrome?.runtime;
  const version = runtime?.getManifest?.().version;
  const href = doc.location.href;
  return outlineLooking(doc, href, site, {
    found: readLooking(doc, href, site),
    ...(version ? { version } : {}),
    ...(view ? { window: { width: view.innerWidth, height: view.innerHeight } } : {}),
  });
}

/** The whole outline of a page on a network still looked at. */
export function outlineLooking(
  doc: Document,
  href: string,
  site: LookingSite,
  options: OutlineOptions = {},
): string {
  return outlineWith(outlineSiteOf(site), doc, href, options);
}
