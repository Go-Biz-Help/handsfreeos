/**
 * Instagram's own readers (the Instagram and Alignable plan's part 9, "new Check Instagram reads"), run on each page
 * read beside the links (`LookingRead.found`). For now what Check Instagram follows from page to page: the places a
 * page links to (/explore/locations/<id>/), the hashtags (/explore/tags/<tag>/) and the chats in Messages
 * (/direct/t/<id>/), each once, in page order. The readers of followers, hashtags, places, notifications and a chat
 * are built from what those pages' outlines show.
 */
const HOST = 'https://www.instagram.com';
/** At most, of each. */
const MOST = 20;

const LOCATION = /^\/explore\/locations\/[^/]+(\/[^/]+)?\/?$/i;
const TAG = /^\/explore\/tags\/[^/]+\/?$/i;
const THREAD = /^\/direct\/t\/[^/]+\/?$/i;

/** What Instagram's readers found on a page. Plain data: it crosses from the tab as JSON. */
export type InstagramFound = {
  readonly locations: readonly string[];
  readonly tags: readonly string[];
  readonly threads: readonly string[];
};

/** A link's address on Instagram, made whole, without what it says it came from. */
function pathOf(href: string | null, base: string): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, base);
    return url.host === 'www.instagram.com' || url.host === 'instagram.com' ? url.pathname : null;
  } catch {
    return null;
  }
}

export function readInstagram(doc: Document, href: string): InstagramFound {
  const found = {
    locations: new Set<string>(),
    tags: new Set<string>(),
    threads: new Set<string>(),
  };
  for (const a of doc.querySelectorAll('a[href]')) {
    const path = pathOf(a.getAttribute('href'), href);
    if (!path) continue;
    const whole = `${HOST}${path.endsWith('/') ? path : `${path}/`}`;
    if (LOCATION.test(path)) found.locations.add(whole);
    else if (TAG.test(path)) found.tags.add(whole);
    else if (THREAD.test(path)) found.threads.add(whole);
  }
  return {
    locations: [...found.locations].slice(0, MOST),
    tags: [...found.tags].slice(0, MOST),
    threads: [...found.threads].slice(0, MOST),
  };
}
