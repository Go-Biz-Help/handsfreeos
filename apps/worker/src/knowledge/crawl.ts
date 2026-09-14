import { createHash } from 'node:crypto';
import { compile } from 'html-to-text';

/**
 * The website scan's page handling, all pure: addresses (normalized, one site, no tracking parameters),
 * links and sitemaps, titles, and readable text.
 */

const TRACKING =
  /^(utm_[a-z0-9_]+|gclid|gbraid|wbraid|dclid|fbclid|msclkid|yclid|igshid|mc_cid|mc_eid|_ga|_gl|_hsenc|_hsmi|mkt_tok|hsa_[a-z]+)$/i;
/** Files that aren't web pages: not worth a request. */
const NOT_A_PAGE =
  /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|heic|mp[34]|m4a|mov|avi|webm|wav|ogg|zip|gz|tgz|rar|7z|dmg|exe|msi|css|js|mjs|json|xml|rss|atom|txt|csv|woff2?|ttf|otf|eot|docx?|xlsx?|pptx?)$/i;

/** A page address as the crawler keeps it: no fragment, no tracking parameters, the rest sorted. Null for anything but http(s). */
export function normalizePageUrl(raw: string, base?: string): string | null {
  let u: URL;
  try {
    u = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  u.hash = '';
  for (const key of [...u.searchParams.keys()]) if (TRACKING.test(key)) u.searchParams.delete(key);
  u.searchParams.sort();
  return u.toString();
}

/** The site an address belongs to: host and port, a leading "www." dropped (www and non-www are one site). */
export const siteKey = (url: string): string =>
  new URL(url).host.toLowerCase().replace(/^www\./, '');

/** Whether an address could be a web page (not an image, a PDF, a script and so on). */
export const looksLikePage = (url: string): boolean => !NOT_A_PAGE.test(new URL(url).pathname);

const NAMED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e.startsWith('#')) {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
    }
    return NAMED[e.toLowerCase()] ?? all;
  });
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const stripTags = (s: string) => s.replace(/<[^>]*>/g, ' ');

/** A page's name: its first heading, else its <title>. */
export function pageTitle(html: string): string {
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  for (const raw of [h1, title]) {
    const text = squash(decodeEntities(stripTags(raw ?? '')));
    if (text) return text.slice(0, 200);
  }
  return '';
}

/** A name for a page without one: its last path segment, or the site's host for the home page. */
export function titleFromUrl(url: string): string {
  const u = new URL(url);
  const last = u.pathname.split('/').filter(Boolean).pop();
  if (!last) return u.hostname.replace(/^www\./, '');
  let name = last;
  try {
    name = decodeURIComponent(last);
  } catch {
    // Keep it as written.
  }
  name = name
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  return (name.charAt(0).toUpperCase() + name.slice(1)).slice(0, 200) || u.hostname;
}

/** Every link on a page that could lead to another page, resolved against the page (or its <base>) and normalized. */
export function pageLinks(html: string, pageUrl: string): string[] {
  const baseHref = /<base\b[^>]*?\shref\s*=\s*["']([^"']+)["']/i.exec(html)?.[1];
  const base = (baseHref && normalizePageUrl(decodeEntities(baseHref), pageUrl)) || pageUrl;
  const out: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
    const href = decodeEntities((m[1] ?? m[2] ?? m[3] ?? '').trim());
    if (!href || href.startsWith('#')) continue;
    // mailto:, tel:, javascript: and other schemes lead nowhere to read.
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^https?:/i.test(href)) continue;
    const url = normalizePageUrl(href, base);
    if (url) out.push(url);
  }
  return out;
}

/** The addresses a sitemap lists; a sitemap index lists more sitemaps instead. */
export function sitemapLocations(xml: string): { pages: string[]; sitemaps: string[] } {
  const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([\s\S]*?)\s*(?:\]\]>)?\s*<\/loc>/gi)]
    .map((m) => decodeEntities(m[1]!.trim()))
    .filter(Boolean);
  return /<sitemapindex\b/i.test(xml)
    ? { pages: [], sitemaps: locs }
    : { pages: locs, sitemaps: [] };
}

const SKIPPED = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'button',
  'select',
  'img',
  'picture',
  'video',
  'audio',
  'object',
  'embed',
];

const toText = compile({
  wordwrap: false,
  selectors: [
    ...SKIPPED.map((selector) => ({ selector, format: 'skip' })),
    { selector: 'a', options: { ignoreHref: true } },
    ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((selector) => ({
      selector,
      options: { uppercase: false },
    })),
  ],
});

/**
 * A page's readable text: headings (marked "#" to "######", as in Markdown) and lists ("* ") kept; scripts,
 * styles, navigation, headers, footers, asides and forms dropped.
 */
export function pageText(html: string): string {
  const marked = html.replace(
    /<h([1-6])\b[^>]*>/gi,
    (tag, level: string) => `${tag}${'#'.repeat(Number(level))} `,
  );
  return toText(marked)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** What a rescan compares: the page's text, hashed. */
export const textHash = (text: string): string => createHash('sha256').update(text).digest('hex');
