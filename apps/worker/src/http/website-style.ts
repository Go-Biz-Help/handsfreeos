/**
 * Match my website (a form's Design tab and a calendar's Design section, core's forms/design.ts): reads a website's
 * start page and its stylesheets, as robots.txt lets HandsFreeOS, and hands back the design that matches it
 * (look/style.ts). Nothing is kept here: the editor puts it in the form's draft (or the calendar's unsaved
 * settings) as an edit, to check and change before publishing or saving.
 *
 * Signed in, with forms.manage in the business (calendars.manage for a calendar's). The site is the one asked for, else the business's own website
 * (Settings → Workspace). Every request goes through deps.fetchUrl: https only, never a private address.
 */
import rateLimit from '@fastify/rate-limit';
import { HfosError, normalizeChatOrigin } from '@hfos/core/server';
import { asWorker } from '@hfos/db/client';
import { workspaces } from '@hfos/db/schema';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ALLOW_ALL, parseRobots, robotsAllows, type Robots } from '../knowledge/robots';
import { isHtml } from '../knowledge/scan';
import { designFromStyle, websiteStyleOf } from '../look/style';
import { tagsOf } from '../look/website';
import { SafeFetchError } from './safe-fetch';
import { authenticate, parseBody, requirePermission, type HttpDeps } from './common';

export const WEBSITE_STYLE_LIMITS = {
  requestMs: 8_000,
  pageBytes: 2 * 1024 * 1024,
  sheetBytes: 1024 * 1024,
  /** Stylesheets read, in the page's order. */
  sheets: 6,
} as const;

const Body = z.object({
  workspaceId: z.uuid(),
  /** The site to match, as typed; left out, the business's own website. */
  site: z.string().trim().max(300).optional(),
});

/** A site's name for the words: shopyoursolar.com. */
const hostOf = (url: string) => {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
};

export async function registerWebsiteStyleRoutes(
  app: FastifyInstance,
  deps: HttpDeps,
): Promise<void> {
  await app.register(async (scoped) => {
    await scoped.register(rateLimit, { global: false });
    scoped.post(
      '/v1/forms/website-style',
      // Each one reads someone's website: a few a minute is plenty for a person trying sites.
      { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } },
      async (req) => {
        const actor = await authenticate(deps, req);
        const body = parseBody(Body, req.body);
        await requirePermission(deps, actor.userId, body.workspaceId, 'forms.manage');
        const url = await siteToRead(deps, body.workspaceId, body.site);
        return websiteDesign(deps, url);
      },
    );
    scoped.post(
      '/v1/calendars/website-style',
      { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } },
      async (req) => {
        const actor = await authenticate(deps, req);
        const body = parseBody(Body, req.body);
        await requirePermission(deps, actor.userId, body.workspaceId, 'calendars.manage');
        const url = await siteToRead(deps, body.workspaceId, body.site);
        return websiteDesign(deps, url, 'the calendar’s Design section');
      },
    );
    // The brand kit (Settings → Workspace): its colour, font and corners from the site, which the screen then keeps
    // with look.set, as the person's own pick.
    scoped.post(
      '/v1/look/website-style',
      { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } },
      async (req) => {
        const actor = await authenticate(deps, req);
        const body = parseBody(Body, req.body);
        await requirePermission(deps, actor.userId, body.workspaceId, 'workspace.update');
        const url = await siteToRead(deps, body.workspaceId, body.site);
        return websiteKit(deps, url);
      },
    );
  });
}

/**
 * The brand kit that matches a site: its button colour, font and corners, for Settings → Workspace's Match my website
 * and the Assistant. Nothing is kept here.
 */
export async function websiteKit(deps: SiteReader, url: string) {
  const found = await websiteDesign(deps, url, 'Settings → Workspace, under Your brand kit');
  return {
    site: found.site,
    color: found.style.button,
    font: found.design.font ?? null,
    corners: found.style.corners,
    fontNote: found.fontNote,
  };
}

/** What reading a site needs: the safe fetch and the log. */
type SiteReader = Pick<HttpDeps, 'fetchUrl' | 'log'>;

/**
 * The design that matches a site, or why there is none: what Match my website fills in, and what the Assistant's
 * build_form puts in a draft when asked to match one. Nothing is kept here.
 */
export async function websiteDesign(
  deps: SiteReader,
  url: string,
  /** Where to pick them by hand instead, for the words. */
  where = 'the form’s Design tab',
) {
  const read = await readSite(deps, url);
  if (!read)
    throw HfosError.rule(
      'website_unreadable',
      422,
      `We couldn’t read ${hostOf(url)} just now. Check the address is right and the site is up, then try again.`,
    );
  const style = websiteStyleOf(read.html, read.sheets);
  const { patch, fontNote, found } = designFromStyle(style, read.url, new Date());
  if (!found)
    throw HfosError.rule(
      'website_style_unknown',
      422,
      `We read ${hostOf(read.url)} but couldn’t tell its colours or font. Pick them on ${where} instead.`,
    );
  return { site: read.url, design: patch, fontNote, style };
}

/** A site as typed, as the exact address to read: `acme.com` is `https://acme.com/`. */
export function siteAddress(typed: string): string {
  const r = normalizeChatOrigin(typed);
  if (!r.ok) throw HfosError.validation([{ path: 'site', message: r.message }], r.message);
  return `${r.origin}/`;
}

/** The site asked for, as an exact address; else the business's own website. */
async function siteToRead(
  deps: HttpDeps,
  workspaceId: string,
  typed: string | undefined,
): Promise<string> {
  if (typed) return siteAddress(typed);
  const [w] = await asWorker(deps.httpDb, { workspaceId }, (tx) =>
    tx
      .select({ settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId)),
  );
  const website = (w?.settings as Record<string, unknown> | null)?.['website'];
  if (typeof website !== 'string' || !website)
    throw HfosError.rule(
      'website_missing',
      409,
      'Type your website’s address in the box, or add it in Settings → Workspace.',
    );
  return website;
}

async function readSite(
  deps: SiteReader,
  url: string,
): Promise<{ url: string; html: string; sheets: string[] } | null> {
  let start: URL;
  try {
    start = new URL(url);
  } catch {
    return null;
  }
  const robots = await robotsAt(deps, start.origin);
  if (!robots || !robotsAllows(robots, start.pathname + start.search)) return null;
  let page: { url: string; html: string };
  try {
    const res = await deps.fetchUrl(start.toString(), {
      sameHost: true,
      timeoutMs: WEBSITE_STYLE_LIMITS.requestMs,
      maxBytes: WEBSITE_STYLE_LIMITS.pageBytes,
      headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1' },
    });
    if (res.status < 200 || res.status >= 300 || !isHtml(res)) return null;
    page = { url: res.finalUrl, html: res.body };
  } catch (e) {
    deps.log.info(
      { url, code: e instanceof SafeFetchError ? e.code : 'network' },
      'couldn’t read a website to match',
    );
    return null;
  }
  // Its stylesheets, in order. Ones on its own site are read as robots.txt lets us; a CDN's are theirs to serve.
  const hrefs = tagsOf(page.html, ['link'])
    .filter((t) => /\bstylesheet\b/i.test(t.attrs['rel'] ?? '') && t.attrs['href'])
    .map((t) => {
      try {
        return new URL(t.attrs['href']!, page.url);
      } catch {
        return null;
      }
    })
    .filter((u): u is URL => u !== null && (u.protocol === 'https:' || u.protocol === 'http:'))
    // Google's font stylesheets only name fonts, which the page's own links already say.
    .filter((u) => !/fonts\.googleapis\.com$/i.test(u.host))
    .slice(0, WEBSITE_STYLE_LIMITS.sheets);
  const sheets = await Promise.all(
    hrefs.map(async (u) => {
      if (u.host === new URL(page.url).host && !robotsAllows(robots, u.pathname + u.search))
        return '';
      if (u.protocol === 'http:') u.protocol = 'https:';
      try {
        const res = await deps.fetchUrl(u.toString(), {
          timeoutMs: WEBSITE_STYLE_LIMITS.requestMs,
          maxBytes: WEBSITE_STYLE_LIMITS.sheetBytes,
          headers: { accept: 'text/css,*/*;q=0.1' },
        });
        return res.status >= 200 && res.status < 300 ? res.body : '';
      } catch {
        return '';
      }
    }),
  );
  return { url: page.url, html: page.html, sheets: sheets.filter(Boolean) };
}

/** robots.txt for HandsFreeOS: none counts as everything allowed; null when the site can't be reached. */
async function robotsAt(deps: SiteReader, origin: string): Promise<Robots | null> {
  try {
    const res = await deps.fetchUrl(`${origin}/robots.txt`, {
      sameHost: true,
      timeoutMs: WEBSITE_STYLE_LIMITS.requestMs,
      maxBytes: 512 * 1024,
    });
    if (res.status >= 500 || res.status === 429) return null;
    return res.status >= 200 && res.status < 300 ? parseRobots(res.body) : ALLOW_ALL;
  } catch {
    return null;
  }
}
