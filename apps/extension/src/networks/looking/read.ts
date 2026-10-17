/**
 * Reading a page on a network still looked at (./site.ts): what kind it is, the profiles and posts it links to, the
 * places its menus lead to, and its warnings. Like the other readers, it goes by links, labels and the network's own
 * words, never class names; and it's tuned from what Check <network> sends back, not from guesses.
 */
import { clean, textLines } from '../facebook/dom';
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

/** Where a page's menus are: its navigation and its banner. */
const MENUS = 'nav, [role="navigation"], header, [role="banner"]';
/** How many of each a read keeps: enough to go on with, never a whole page's worth. */
const MOST = 40;

/** Reads a whole page on a network still looked at. */
export function readLooking(
  doc: Document,
  href: string,
  site: LookingSite,
  now: Date = new Date(),
): LookingRead {
  const page = site.url(href);
  const own = site.ownLink(doc, href);
  const ownKey = own ? site.url(own)?.pathname.toLowerCase() : null;
  const people = new Map<string, { url: string }>();
  const posts = new Map<string, { url: string }>();
  const places = new Map<string, { name: string; url: string }>();
  const mask = maskOn(site);
  for (const anchor of doc.querySelectorAll('a[href]')) {
    const url = site.url(anchor.getAttribute('href') ?? '', href);
    if (!url) continue;
    const post = site.postOf(url);
    if (post) {
      if (posts.size < MOST) posts.set(post, { url: post });
      continue;
    }
    const profile = site.profileOf(url);
    const inMenu = anchor.closest(MENUS) !== null;
    if (profile && !inMenu) {
      if (people.size < MOST && new URL(profile.url).pathname.toLowerCase() !== ownKey)
        people.set(profile.url.toLowerCase(), { url: profile.url });
      continue;
    }
    if (inMenu && url.pathname !== page?.pathname) {
      const key = `${url.pathname}${url.search}`;
      const name = mask(clean(anchor.getAttribute('aria-label')) || clean(anchor.textContent));
      if (name && !places.has(key) && places.size < MOST)
        places.set(key, { name, url: url.toString() });
    }
  }
  const kind = page ? site.kindOf(page) : 'other';
  return {
    platform: site.platform,
    kind,
    url: href,
    readAt: now.toISOString(),
    people: [...people.values()],
    posts: [...posts.values()],
    places: [...places.values()],
    own,
    warnings: readWarnings(doc, href, site),
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
    queryKept: new Set(['tab', 'type', 'filter', 'sort']),
    queryDropped: /^(utm_|igsh|igshid$|ref$|fbclid$|__)/,
    // The menus are kept: they're what tells a network's places apart. Nothing of theirs names anyone but the person,
    // and a name is hidden like any other.
    isTopBar: () => false,
  };
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
