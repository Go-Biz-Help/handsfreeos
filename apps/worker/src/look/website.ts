import { isColorful } from '@hfos/core/server';
import { decodeEntities, siteKey } from '../knowledge/crawl';

/**
 * Where a business's logo is on its website's start page, best first (HANDSFREEOS_ONBOARDING_QUICK_SETUP_
 * IMPLEMENTATION_PLAN.md §4, call 3: "The logo comes from the website when it has one"), and the website's own
 * colour. All pure: the page's HTML in, addresses out.
 *
 * 1. The logo its structured data names (schema.org `logo`).
 * 2. In its header: a picture it calls a logo, the picture inside something it calls a logo or brand, and the
 *    picture its home link shows.
 * 3. The same anywhere else on the page except its footer.
 * 4. The icon phones keep for it (apple-touch-icon), then its PNG and SVG icons, larger first. Never a .ico.
 * 5. Pictures called a logo in its footer.
 *
 * Logos of other companies (review sites, social networks, payments, the site's builder) are never its logo.
 */

/** How many places are tried before giving up. */
export const LOGO_TRIES = 5;

const OTHER_COMPANIES =
  /\b(?:google|facebook|instagram|twitter|linkedin|youtube|tiktok|pinterest|yelp|bbb|homeadvisor|houzz|nextdoor|thumbtack|trustpilot|mastercard|paypal|venmo|wix|squarespace|godaddy|wordpress|weebly|shopify)\b/i;

interface Tag {
  readonly at: number;
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
}

/** Every tag of these names, with its attributes (names lower-case, values decoded); a tag is read up to 4,000 characters. */
function tagsOf(html: string, names: readonly string[]): Tag[] {
  const out: Tag[] = [];
  for (const m of html.matchAll(new RegExp(`<(${names.join('|')})(?=[\\s>/])`, 'gi'))) {
    const rest = html.slice(m.index + m[0].length, m.index + m[0].length + 4_000);
    const end = rest.indexOf('>');
    if (end < 0) continue;
    out.push({ at: m.index, name: m[1]!.toLowerCase(), attrs: attrsOf(rest.slice(0, end)) });
  }
  return out;
}

function attrsOf(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of raw.matchAll(
    /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g,
  )) {
    const name = m[1]!.toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

type Span = readonly [number, number];

/** Where the page's headers or footers are. */
function spansOf(html: string, name: 'header' | 'footer'): Span[] {
  const spans: Span[] = [];
  for (const m of html.matchAll(new RegExp(`<${name}\\b[\\s\\S]*?</${name}\\s*>`, 'gi')))
    spans.push([m.index, m.index + m[0].length]);
  return spans;
}
const inside = (spans: readonly Span[], at: number) =>
  spans.some(([start, end]) => at >= start && at < end);

/** A picture's address: its src, unless that's a stand-in while the page loads; else the largest in its srcset. */
function pictureOf(img: Tag): string | null {
  const a = img.attrs;
  const lazy = a['data-src'] || a['data-lazy-src'] || a['data-original'] || '';
  const src = a['src'] ?? '';
  if (src && !/^data:/i.test(src)) return src;
  if (lazy) return lazy;
  const fromSet = largestInSrcset(a['srcset'] || a['data-srcset'] || '');
  // A data: picture of its own is kept (inline SVG logos); a 1-pixel GIF waiting for the real one isn't worth trying.
  return fromSet ?? (src && !/^data:image\/gif/i.test(src) ? src : null);
}

function largestInSrcset(srcset: string): string | null {
  let best: { url: string; size: number } | null = null;
  for (const part of srcset.split(/,\s+/)) {
    const [url, descriptor] = part.trim().split(/\s+/);
    if (!url) continue;
    const size = Number.parseFloat(descriptor ?? '1') || 1;
    if (!best || size > best.size) best = { url, size };
  }
  return best?.url ?? null;
}

const callsItLogo = (img: Tag) => Object.values(img.attrs).some((v) => /logo/i.test(v));
const otherCompany = (img: Tag) =>
  OTHER_COMPANIES.test(
    `${img.attrs['alt'] ?? ''} ${img.attrs['title'] ?? ''} ${(img.attrs['src'] ?? '').split(/[?#]/)[0]!.split('/').pop()}`,
  );

/** The `logo`s the page's structured data names, in order. */
export function structuredLogos(html: string): string[] {
  const out: string[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > 8 || out.length >= 3 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const n of node.slice(0, 50)) visit(n, depth + 1);
      return;
    }
    const o = node as Record<string, unknown>;
    const logo = Array.isArray(o['logo']) ? (o['logo'] as unknown[])[0] : o['logo'];
    const url =
      typeof logo === 'string'
        ? logo
        : logo && typeof logo === 'object'
          ? ((logo as Record<string, unknown>)['url'] ??
            (logo as Record<string, unknown>)['contentUrl'])
          : null;
    if (typeof url === 'string' && url.trim()) out.push(url.trim());
    for (const [key, value] of Object.entries(o)) if (key !== 'logo') visit(value, depth + 1);
  };
  for (const m of html.matchAll(
    /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      visit(JSON.parse(m[1] ?? ''), 0);
    } catch {
      // Not JSON: nothing to read.
    }
  }
  return out;
}

/** The website's places for its logo, best first, as absolute addresses (or data: pictures), each once. */
export function logoCandidates(html: string, pageUrl: string): string[] {
  const baseHref = /<base\b[^>]*?\shref\s*=\s*["']([^"']+)["']/i.exec(html)?.[1];
  let base = pageUrl;
  try {
    if (baseHref) base = new URL(decodeEntities(baseHref), pageUrl).toString();
  } catch {
    // A <base> that isn't an address: the page's own.
  }
  const headers = spansOf(html, 'header');
  const footers = spansOf(html, 'footer');
  const imgs = tagsOf(html, ['img']).filter((img) => !otherCompany(img));

  // The picture inside something called a logo or a brand (the first one soon after it), or inside the home link.
  const held = new Set<number>();
  const site = siteKey(pageUrl);
  for (const t of tagsOf(html, ['a', 'div', 'span', 'figure', 'p', 'h1', 'h2', 'li'])) {
    const named = /logo|navbar-brand|site-brand|\bbrand\b/i.test(
      `${t.attrs['class'] ?? ''} ${t.attrs['id'] ?? ''}`,
    );
    const home = t.name === 'a' && isHome(t.attrs['href'], base, site);
    if (!named && !home) continue;
    const close = home ? html.indexOf('</a', t.at) : -1;
    const limit = home && close > 0 ? Math.min(close, t.at + 600) : t.at + 600;
    const img = imgs.find((i) => i.at > t.at && i.at < limit);
    if (img) held.add(img.at);
  }

  const called = imgs.filter((i) => callsItLogo(i) || held.has(i.at));
  const inHeader = called.filter((i) => inside(headers, i.at));
  const elsewhere = called.filter((i) => !inside(headers, i.at) && !inside(footers, i.at));
  const inFooter = called.filter((i) => !inside(headers, i.at) && inside(footers, i.at));

  const out: string[] = [];
  for (const raw of [
    ...structuredLogos(html),
    ...[...inHeader, ...elsewhere].map(pictureOf),
    ...iconsOf(html),
    ...inFooter.map(pictureOf),
  ]) {
    const url = raw && resolve(raw, base);
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

/** Touch icons, then PNG and SVG icons, larger first: the icons a site keeps that could stand for its logo. */
function iconsOf(html: string): string[] {
  const touch: Array<{ href: string; size: number }> = [];
  const icons: Array<{ href: string; size: number }> = [];
  for (const link of tagsOf(html, ['link'])) {
    const rel = (link.attrs['rel'] ?? '').toLowerCase().split(/\s+/);
    const href = link.attrs['href'];
    if (!href || /\.ico(?:$|[?#])/i.test(href)) continue;
    const size = Math.max(
      0,
      ...(link.attrs['sizes'] ?? '')
        .split(/\s+/)
        .map((s) => (s.toLowerCase() === 'any' ? 512 : Number.parseInt(s, 10) || 0)),
    );
    if (rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed'))
      touch.push({ href, size: size || 180 });
    else if (rel.includes('icon')) {
      const type = (link.attrs['type'] ?? '').toLowerCase();
      if (type === 'image/svg+xml' || /\.svg(?:$|[?#])/i.test(href))
        icons.push({ href, size: 512 });
      else if ((type === 'image/png' || /\.png(?:$|[?#])/i.test(href)) && (!size || size >= 64))
        icons.push({ href, size: size || 64 });
    }
  }
  const bySize = (a: { size: number }, b: { size: number }) => b.size - a.size;
  return [...touch.sort(bySize), ...icons.sort(bySize)].map((i) => i.href);
}

/** A picture's address against the page: http(s), or a data: picture of a kind that can be a logo. */
function resolve(raw: string, base: string): string | null {
  const src = raw.trim();
  if (/^data:/i.test(src))
    return /^data:image\/(?:png|jpeg|webp|gif|svg\+xml)[;,]/i.test(src) ? src : null;
  try {
    const u = new URL(src, base);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password)
      return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

/** Whether a link goes to the site's start page. */
function isHome(href: string | undefined, base: string, site: string): boolean {
  if (!href) return false;
  try {
    const u = new URL(href.trim(), base);
    return (
      (u.protocol === 'https:' || u.protocol === 'http:') &&
      siteKey(u.toString()) === site &&
      u.pathname === '/' &&
      !u.search
    );
  } catch {
    return false;
  }
}

/** The bytes of a data: picture, or null when it's not one. */
export function dataPicture(url: string): Buffer | null {
  const m = /^data:image\/(?:png|jpeg|webp|gif|svg\+xml)((?:;[^,]*)?),(.*)$/is.exec(url);
  if (!m) return null;
  try {
    return /;base64/i.test(m[1] ?? '')
      ? Buffer.from(m[2] ?? '', 'base64')
      : Buffer.from(decodeURIComponent(m[2] ?? ''), 'utf8');
  } catch {
    return null;
  }
}

/**
 * The website's own colour, from the theme colour it gives browsers: as #rrggbb, and only when it has colour in
 * it (a white or black bar says nothing about the business).
 */
export function themeColorOf(html: string): string | null {
  for (const meta of tagsOf(html, ['meta'])) {
    const name = (meta.attrs['name'] ?? '').toLowerCase();
    if (name !== 'theme-color' && name !== 'msapplication-tilecolor') continue;
    // A theme colour for dark mode only isn't the business's colour.
    if (/dark/i.test(meta.attrs['media'] ?? '')) continue;
    const hex = hexOf(meta.attrs['content'] ?? '');
    if (hex && isColorful(hex)) return hex;
  }
  return null;
}

function hexOf(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${[...v.slice(1)].map((c) => c + c).join('')}`;
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(v);
  if (!rgb) return null;
  return `#${rgb
    .slice(1, 4)
    .map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0'))
    .join('')}`;
}
