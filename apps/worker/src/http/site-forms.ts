import {
  formCounts,
  formsOn,
  framedAddresses,
  robotCheck,
  robotCheckWho,
  type FetchedPage,
  type SiteForm,
  type SiteScan,
} from '@hfos/core';
import { looksLikePage, normalizePageUrl, pageLinks, sitemapLocations } from '../knowledge/crawl';
import { parseRobots } from '../knowledge/robots';
import type { HttpDeps } from './common';
import { SafeFetchError } from './safe-fetch';

/**
 * Going through a business's whole website for forms, before its texting registration goes (owner, 2026-11-18): a
 * reviewer clicks around, and Shop Your Solar was turned down over a form on a page the registration never named.
 * Core judges what's found (`checkSiteForms`); this only fetches.
 *
 * **Like a reviewer.** It starts at the website, reads the sitemap (robots.txt's Sitemap lines and /sitemap.xml) and
 * follows links breadth first on the same site, subdomains included (instantquote.shopyoursolar.com is Shop Your
 * Solar's too). On every page it also opens the forms framed there, from any site (core's `framedAddresses`), since a
 * reviewer's browser shows them. It reads robots.txt for its sitemaps only: this is the business looking at its own
 * site, page by page as a reviewer would, not a scan that keeps what it reads.
 *
 * **Gentle and bounded.** A few pages at a time, at most `pages` of them and `frames` framed forms, and it stops at
 * `ms` and says it was cut short. It runs after the review's other reads, so a host that shows robot checks to busy
 * visitors (SiteGround does) has already answered those. Pages it was handed already (`have`) aren't fetched again.
 */
export const SITE_SCAN_LIMITS = { pages: 40, frames: 15, sitemaps: 4, concurrency: 3, ms: 20_000 };

type Fetcher = Pick<HttpDeps, 'fetchUrl'>;

/** Whether a host is the website's own: the same name without www, or a subdomain of it. */
const onSite = (host: string, site: string): boolean => {
  const h = host.toLowerCase().replace(/^www\./, '');
  return h === site || h.endsWith(`.${site}`);
};

export async function scanSiteForms(
  deps: Fetcher,
  website: string,
  have: readonly (FetchedPage | null)[] = [],
  limits: typeof SITE_SCAN_LIMITS = SITE_SCAN_LIMITS,
): Promise<SiteScan> {
  const start = normalizePageUrl(/^https?:\/\//i.test(website) ? website : `https://${website}`);
  if (!start) return { opened: 0, cut: false, forms: [], blocked: [] };
  const site = new URL(start).host.toLowerCase().replace(/^www\./, '');
  const deadline = Date.now() + limits.ms;
  const late = () => Date.now() > deadline;

  const known = new Map<string, FetchedPage>();
  // A page whose form was read from its frame (`openWithFrames`) carries the frame's HTML: read that page afresh.
  for (const page of have)
    if (page && !page.framedUrl && page.status !== null && page.status < 400) {
      const key = normalizePageUrl(page.url);
      if (key) known.set(key, { ...page, framedUrl: null });
    }

  const open = async (url: string, timeoutMs = 8000): Promise<FetchedPage> => {
    const held = known.get(url);
    if (held) return held;
    try {
      const res = await deps.fetchUrl(url, { timeoutMs, maxBytes: 512_000 });
      // Words of any kind (robots.txt is plain text, a sitemap XML); never a picture or a file.
      const type = (res.headers['content-type'] ?? '').toLowerCase();
      const html = /^(image|video|audio|font)\/|application\/(pdf|octet-stream|zip)/.test(type)
        ? ''
        : res.body;
      const source = (res as { source?: 'browser' | 'screenshot' }).source ?? null;
      return {
        url,
        status: res.status,
        html,
        finalUrl: res.finalUrl,
        headers: res.headers,
        source,
      };
    } catch (err) {
      return {
        url,
        status: null,
        html: '',
        error: err instanceof SafeFetchError ? err.code : 'network',
      };
    }
  };

  const seen = new Set<string>([start]);
  const queue: string[] = [start];
  const enqueue = (links: readonly string[]) => {
    for (const raw of links) {
      const url = normalizePageUrl(raw);
      if (!url || seen.has(url) || !looksLikePage(url) || !onSite(new URL(url).host, site))
        continue;
      seen.add(url);
      queue.push(url);
    }
  };
  enqueue(await sitemapPages(open, start, site, limits.sitemaps, late));

  const forms: SiteForm[] = [];
  const blocked: { url: string; who: string; by: string | null }[] = [];
  const framesSeen = new Set<string>();
  /** Each framed form's forms that count, and where it ended up, by the address it was framed with. */
  const framed = new Map<string, ReturnType<typeof formsOn>>();
  const finals = new Map<string, string>();
  let opened = 0;
  let cut = false;
  const via = new Set<'browser' | 'screenshot'>();

  const read = async (url: string) => {
    const page = await open(url);
    const shown = page.finalUrl ?? page.url;
    const check = robotCheck(page);
    if (check) {
      blocked.push({ url: shown, who: robotCheckWho(check), by: check.by });
      return;
    }
    if (page.status === null || page.status >= 400 || !page.html) return;
    // Redirected off the site (a link to a booking service, say): that page isn't the business's to fix.
    if (!onSite(new URL(shown).host, site)) return;
    opened++;
    if (page.source) via.add(page.source);
    for (const form of formsOn(page.html))
      if (formCounts(form)) forms.push({ ...form, page: shown, framedUrl: null });
    enqueue(pageLinks(page.html, shown));
    for (const address of framedAddresses(page.html, shown)) {
      const key = normalizePageUrl(address);
      if (!key || late()) continue;
      // The same framed form on every page is opened once and counted on each.
      if (!framesSeen.has(key)) {
        if (framesSeen.size >= limits.frames) continue;
        framesSeen.add(key);
        const frame = await open(key);
        if (frame.status === null || frame.status >= 400 || !frame.html || robotCheck(frame)) {
          framed.set(key, []);
          continue;
        }
        framed.set(key, formsOn(frame.html).filter(formCounts));
        finals.set(key, frame.finalUrl ?? frame.url);
      }
      for (const form of framed.get(key) ?? [])
        forms.push({ ...form, page: shown, framedUrl: finals.get(key) ?? key });
    }
  };
  let pages = 0;
  const worker = async () => {
    while (queue.length) {
      if (late() || pages >= limits.pages) {
        cut = true;
        return;
      }
      const url = queue.shift()!;
      pages++;
      await read(url);
    }
  };
  // The first page alone, so its links are queued before the others start.
  pages++;
  await read(queue.shift()!);
  await Promise.all(Array.from({ length: limits.concurrency }, worker));
  return { opened, cut, forms, blocked, via: [...via] };
}

/** The pages the site's sitemaps list, on the site, through a sitemap index one level down. */
async function sitemapPages(
  open: (url: string, timeoutMs?: number) => Promise<FetchedPage>,
  start: string,
  site: string,
  most: number,
  late: () => boolean,
): Promise<string[]> {
  const origin = new URL(start).origin;
  const robots = await open(`${origin}/robots.txt`, 5000);
  const listed =
    robots.status && robots.status < 300 && !/<html[\s>]/i.test(robots.html)
      ? parseRobots(robots.html).sitemaps
      : [];
  const pending = [...new Set([...listed, `${origin}/sitemap.xml`])];
  const pages: string[] = [];
  let fetched = 0;
  while (pending.length && fetched < most && !late()) {
    const url = pending.shift()!;
    try {
      if (!onSite(new URL(url).host, site)) continue;
    } catch {
      continue;
    }
    fetched++;
    const res = await open(url, 5000);
    if (!res.status || res.status >= 400 || !/<(urlset|sitemapindex)\b/i.test(res.html)) continue;
    const found = sitemapLocations(res.html);
    pending.push(...found.sitemaps);
    pages.push(...found.pages);
  }
  return pages;
}
