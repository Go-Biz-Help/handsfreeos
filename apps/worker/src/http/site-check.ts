/**
 * The texting registration's checks reading a business's pages some other way than by our own read, when its
 * website's security shows us a robot check instead (owner, 2026-11-20; core's `websites/site-pages.ts` says why and
 * how). Never a way round the check: the person's own browser on their own site, or their screenshot.
 *
 * POST /v1/telephony/site-check/start {workspaceId, website, start?, urls} → {checkId, open, expiresAt}
 *   "Finish the check on my site": a one-time code, and the address to open with it (`#hfos-check=<code>`). Our chat
 *   or form code on the site sees it and loads /embed/v1/site-check.js. 403 without channels.manage; 400
 *   `site_check_address` when an address isn't on the website.
 * POST /v1/telephony/site-check/status {workspaceId, checkId} → {pages, finished, expired}: the last step waits on it.
 * GET /public/site-check/:code → SiteCheckPlan: what site-check.js reads. 404 `site_check_over` once it's run out.
 * POST /public/site-check/:code/pages {pages, done} → {pages}: what it read, a few at a time. Only from the site
 *   itself (its Origin), only pages on the site, and at most SITE_CHECK_LIMITS.pages.
 * POST /v1/telephony/site-check/screenshot {workspaceId, url, images} → {saved}: a screenshot of a page that still
 *   won't open, written down by the AI as a plain page (`site_screenshot` usage). 400 `screenshot_unreadable`,
 *   `screenshot_not_a_page`; the AI's own refusals as read-card's.
 *
 * `storedSitePages` and `withSitePages` are how the checks read them: a page the browser read in the last half hour
 * first, then our own read, then a screenshot when our read showed a robot check or failed.
 */
import { createHash, randomBytes } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import {
  executeCommand,
  HfosError,
  onSiteHost,
  registrationSaveSiteScreenshot,
  registrationSiteCheckSavePages,
  registrationSiteCheckStart,
  robotCheck,
  screenshotRefusal,
  SITE_CHECK_HASH,
  SITE_CHECK_LIMITS,
  SITE_SCREENSHOT_ASK,
  SITE_SCREENSHOT_MAX_BASE64,
  SITE_SCREENSHOT_SCHEMA,
  SITE_SCREENSHOT_SYSTEM,
  SiteCheckPagesInput,
  siteHost,
  sitePageKey,
  SiteScreenshotAnswer,
  SiteScreenshotInput,
  trimPageHtml,
  type HumanActor,
  type SiteCheckPlan,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AI_BUDGET_MESSAGE,
  AI_BUSY_MESSAGE,
  AI_UNAVAILABLE_MESSAGE,
  AiAskError,
  askStructured,
} from '../ai/ask';
import { uprightJpeg } from '../contacts/card-picture';
import { systemActor, workerMeta } from '../services';
import { authenticate, parseBody, requirePermission, type HttpDeps } from './common';
import type { SafeFetch, SafeResponse } from './safe-fetch';

/** Screenshots one person may send a minute. The daily AI limit applies on top. */
export const SCREENSHOTS_PER_MINUTE = 10;
/** The longest side the AI sees a screenshot at: a screen's width, which is what it reads well at. */
const AI_EDGE = 1568;

const address = z.string().trim().min(1).max(2048);

const StartInput = z.strictObject({
  workspaceId: z.uuid(),
  website: address,
  /** The page to open: one with our chat or form code on it. The website when not given. */
  start: address.optional(),
  /** The pages the registration names, read first. */
  urls: z.array(address).max(40).default([]),
});

const StatusInput = z.strictObject({ workspaceId: z.uuid(), checkId: z.uuid() });

const withScheme = (raw: string) =>
  /^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`;
const hashOf = (code: string) => createHash('sha256').update(code).digest('hex');
const CODE = /^[A-Za-z0-9_-]{32}$/;

const notOnSite = (url: string, site: string) =>
  HfosError.rule(
    'site_check_address',
    400,
    `${url} isn’t on ${site}. The check reads your own website’s pages only.`,
  );

const over = () =>
  HfosError.rule(
    'site_check_over',
    404,
    'This check of your site has run out. Go back to HandsFreeOS and press “Finish the check on my site” again.',
  );

async function organizationOf(deps: HttpDeps, workspaceId: string): Promise<string> {
  const [ws] = await asWorker(deps.httpDb, { workspaceId }, (tx) =>
    rows<{ organization_id: string }>(
      tx,
      sql`select organization_id from app.workspaces where id = ${workspaceId}`,
    ),
  );
  if (!ws) throw HfosError.notFound('That business isn’t there anymore.');
  return ws.organization_id;
}

/** A code's check, while it works: whose, and which site. */
async function checkOf(deps: HttpDeps, code: string) {
  if (!CODE.test(code)) throw over();
  const [found] = await asWorker(deps.httpDb, {}, (tx) =>
    rows<{ check_id: string; workspace_id: string; organization_id: string }>(
      tx,
      sql`select check_id, workspace_id, organization_id from private.site_check_lookup(${hashOf(code)})`,
    ),
  );
  if (!found) throw over();
  const [row] = await asWorker(deps.httpDb, { workspaceId: found.workspace_id }, (tx) =>
    rows<{ site: string; urls: string[]; finished: boolean; business: string }>(
      tx,
      sql`select c.site, c.urls, c.finished_at is not null as finished, w.name::text as business
          from app.site_checks c join app.workspaces w on w.id = c.workspace_id
          where c.id = ${found.check_id}`,
    ),
  );
  if (!row) throw over();
  return { ...found, ...row };
}

/** The site's own pages only: a request from anywhere else (another site using a leaked code) is refused. */
function fromSite(req: FastifyRequest, site: string): void {
  const origin = req.headers.origin;
  if (!origin) return;
  const host = siteHost(origin);
  if (!host || !onSiteHost(host, site))
    throw HfosError.rule(
      'site_check_origin',
      403,
      'This check only takes pages from the business’s own website.',
    );
}

function aiError(e: unknown): unknown {
  if (!(e instanceof AiAskError)) return e;
  const failed = 'The AI couldn’t read the screenshot just now. Try again in a minute.';
  switch (e.code) {
    case 'ai_unavailable':
      return HfosError.rule('ai_not_configured', 503, AI_UNAVAILABLE_MESSAGE);
    case 'budget_reached':
      return HfosError.rule('budget_reached', 429, e.message || AI_BUDGET_MESSAGE);
    case 'wallet_empty':
      return HfosError.rule('wallet_empty', 402, e.message);
    case 'provider_error':
      return e.retryable
        ? HfosError.rule('ai_busy', 503, AI_BUSY_MESSAGE)
        : HfosError.rule('ai_failed', 502, failed);
    case 'bad_output':
      return HfosError.rule('ai_failed', 502, failed);
  }
}

/** A screenshot written down as a plain page, for the checks to read in the page's place. */
export async function readSiteScreenshot(
  deps: Pick<HttpDeps, 'httpDb' | 'ai' | 'log' | 'wallet'>,
  actor: HumanActor,
  input: SiteScreenshotInput,
): Promise<{ saved: true }> {
  await requirePermission(deps, actor.userId, input.workspaceId, 'channels.manage');
  const url = withScheme(input.url);
  const key = sitePageKey(url);
  if (!key) throw HfosError.rule('site_check_address', 400, `${input.url} isn’t a web address.`);
  const pictures: { type: 'image'; mediaType: 'image/jpeg'; data: string }[] = [];
  for (const image of input.images) {
    try {
      const upright = await uprightJpeg(Buffer.from(image, 'base64'), AI_EDGE);
      pictures.push({
        type: 'image',
        mediaType: 'image/jpeg',
        data: upright.jpeg.toString('base64'),
      });
    } catch {
      throw HfosError.rule(
        'screenshot_unreadable',
        400,
        'That picture couldn’t be opened. Take the screenshot again, as a PNG or JPEG.',
      );
    }
  }
  if (!deps.ai.provider) throw HfosError.rule('ai_not_configured', 503, AI_UNAVAILABLE_MESSAGE);
  const organizationId = await organizationOf(deps as HttpDeps, input.workspaceId);
  let answer: SiteScreenshotAnswer;
  try {
    ({ value: answer } = await askStructured(
      { db: deps.httpDb, ai: deps.ai, log: deps.log, wallet: deps.wallet },
      { workspaceId: input.workspaceId, organizationId },
      {
        system: SITE_SCREENSHOT_SYSTEM,
        messages: [
          {
            role: 'user',
            content: [
              ...pictures,
              { type: 'text', text: SITE_SCREENSHOT_ASK(url, pictures.length) },
            ],
          },
        ],
        schema: SITE_SCREENSHOT_SCHEMA,
        zod: SiteScreenshotAnswer,
        maxTokens: 16_000,
        usage: { source: 'site_screenshot', userId: actor.userId },
      },
    ));
  } catch (e) {
    throw aiError(e);
  }
  const refused = screenshotRefusal(url, answer);
  if (refused) throw HfosError.rule('screenshot_not_a_page', 400, refused);
  await executeCommand(
    deps.httpDb,
    registrationSaveSiteScreenshot,
    {
      workspaceId: input.workspaceId,
      key,
      url,
      html: trimPageHtml(answer.html),
      readBy: actor.userId,
    },
    systemActor({ workspaceId: input.workspaceId, organizationId }, actor.userId),
    workerMeta(),
  );
  return { saved: true };
}

export async function registerSiteCheckRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  app.post('/v1/telephony/site-check/start', async (req) => {
    const actor = await authenticate(deps, req);
    const input = parseBody(StartInput, req.body);
    await requirePermission(deps, actor.userId, input.workspaceId, 'channels.manage');
    const website = withScheme(input.website);
    const site = siteHost(website);
    if (!site)
      throw HfosError.rule('site_check_address', 400, `${input.website} isn’t a web address.`);
    const start = withScheme(input.start ?? website);
    const startHost = siteHost(start);
    if (!startHost || !onSiteHost(startHost, site)) throw notOnSite(start, site);
    // Pages elsewhere (a booking service, a framed form on HighLevel) stay ours to read: the browser can't.
    const urls = [...new Set(input.urls.map(withScheme))].filter((u) => {
      const host = siteHost(u);
      return !!host && onSiteHost(host, site);
    });
    const code = randomBytes(24).toString('base64url');
    const organizationId = await organizationOf(deps, input.workspaceId);
    const { output } = await executeCommand(
      deps.httpDb,
      registrationSiteCheckStart,
      {
        workspaceId: input.workspaceId,
        tokenHash: hashOf(code),
        site,
        startUrl: start,
        urls,
        requestedBy: actor.userId,
      },
      systemActor({ workspaceId: input.workspaceId, organizationId }, actor.userId),
      workerMeta(),
    );
    const open = new URL(start);
    open.hash = `${SITE_CHECK_HASH}=${code}`;
    return {
      checkId: output.checkId,
      open: open.toString(),
      expiresAt: new Date(Date.now() + SITE_CHECK_LIMITS.minutes * 60_000).toISOString(),
    };
  });

  app.post('/v1/telephony/site-check/status', async (req) => {
    const actor = await authenticate(deps, req);
    const input = parseBody(StatusInput, req.body);
    await requirePermission(deps, actor.userId, input.workspaceId, 'channels.manage');
    const [row] = await asWorker(deps.httpDb, { workspaceId: input.workspaceId }, (tx) =>
      rows<{ pages: number; finished: boolean; expired: boolean }>(
        tx,
        sql`select pages, finished_at is not null as finished, expires_at <= now() as expired
            from app.site_checks where id = ${input.checkId} and workspace_id = ${input.workspaceId}`,
      ),
    );
    return row ?? { pages: 0, finished: false, expired: true };
  });

  await app.register(async (pub) => {
    await pub.register(rateLimit, {
      global: false,
      errorResponseBuilder: () =>
        new HfosError(
          'rule_violation',
          429,
          'Too many pages at once. Wait a minute.',
          undefined,
          'rate_limited',
        ),
    });
    pub.addHook('onRequest', async (_req, reply) => {
      void reply.header('cache-control', 'no-store');
    });

    pub.get<{ Params: { code: string } }>(
      '/public/site-check/:code',
      { config: { rateLimit: { max: 30, timeWindow: 60_000 } } },
      async (req) => {
        const check = await checkOf(deps, req.params.code);
        fromSite(req, check.site);
        if (check.finished) throw over();
        return {
          site: check.site,
          business: check.business,
          urls: check.urls,
          most: SITE_CHECK_LIMITS.pages,
        } satisfies SiteCheckPlan;
      },
    );

    pub.post<{ Params: { code: string } }>(
      '/public/site-check/:code/pages',
      {
        bodyLimit: SITE_CHECK_LIMITS.pageChars * 2 * SITE_CHECK_LIMITS.batch * 2,
        config: { rateLimit: { max: 120, timeWindow: 60_000 } },
      },
      async (req) => {
        const check = await checkOf(deps, req.params.code);
        fromSite(req, check.site);
        const input = parseBody(SiteCheckPagesInput, req.body);
        const pages = input.pages.flatMap((p) => {
          const host = siteHost(p.url);
          if (!host || !onSiteHost(host, check.site)) return [];
          const finalHost = p.finalUrl ? siteHost(p.finalUrl) : null;
          const finalUrl = finalHost && onSiteHost(finalHost, check.site) ? p.finalUrl : null;
          const html = trimPageHtml(p.html);
          const keys = [...new Set([sitePageKey(p.url), finalUrl ? sitePageKey(finalUrl) : null])];
          return keys
            .filter((k): k is string => !!k)
            .map((key) => ({ key, url: p.url, finalUrl, status: p.status, html }));
        });
        const { output } = await executeCommand(
          deps.httpDb,
          registrationSiteCheckSavePages,
          { workspaceId: check.workspace_id, checkId: check.check_id, pages, done: input.done },
          systemActor({ workspaceId: check.workspace_id, organizationId: check.organization_id }),
          workerMeta(),
        );
        return output;
      },
    );
  });

  await app.register(async (scoped) => {
    await scoped.register(rateLimit, {
      global: false,
      errorResponseBuilder: () =>
        new HfosError(
          'rule_violation',
          429,
          'That’s a lot of screenshots in a row. Wait a minute and try again.',
          undefined,
          'rate_limited',
        ),
    });
    scoped.post(
      '/v1/telephony/site-check/screenshot',
      {
        bodyLimit: SITE_SCREENSHOT_MAX_BASE64 * SITE_CHECK_LIMITS.screenshots + 64 * 1024,
        config: { rateLimit: { max: SCREENSHOTS_PER_MINUTE, timeWindow: 60_000 } },
      },
      async (req) => {
        const actor = await authenticate(deps, req);
        return readSiteScreenshot(deps, actor, parseBody(SiteScreenshotInput, req.body));
      },
    );
  });
}

// ---------- the checks reading them ----------

interface StoredPage {
  readonly url: string;
  readonly finalUrl: string | null;
  readonly status: number;
  readonly html: string;
}

/** What the business's browser read in the last half hour, and its screenshots of the last month, by page key. */
export type StoredSitePages = ReadonlyMap<
  string,
  { readonly browser?: StoredPage; readonly screenshot?: StoredPage }
>;

export async function storedSitePages(
  deps: Pick<HttpDeps, 'httpDb'>,
  workspaceId: string,
): Promise<StoredSitePages> {
  const found = await asWorker(deps.httpDb, { workspaceId }, (tx) =>
    rows<{
      key: string;
      source: 'browser' | 'screenshot';
      url: string;
      final_url: string | null;
      status: number | null;
      html: string;
    }>(
      tx,
      sql`select key, source, url, final_url, status, html from app.site_pages
          where workspace_id = ${workspaceId}
            and read_at > now() - case source
              when 'browser' then make_interval(mins => ${SITE_CHECK_LIMITS.minutes})
              else make_interval(days => ${SITE_CHECK_LIMITS.screenshotDays}) end`,
    ),
  );
  const map = new Map<string, { browser?: StoredPage; screenshot?: StoredPage }>();
  for (const r of found) {
    const entry = map.get(r.key) ?? {};
    entry[r.source] = { url: r.url, finalUrl: r.final_url, status: r.status ?? 200, html: r.html };
    map.set(r.key, entry);
  }
  return map;
}

/** A read that says where its page came from, when it wasn't our own read. */
export type SourcedResponse = SafeResponse & { readonly source?: 'browser' | 'screenshot' };

const answerOf = (page: StoredPage, source: 'browser' | 'screenshot'): SourcedResponse => ({
  status: page.status,
  headers: { 'content-type': 'text/html' },
  body: page.html,
  bytes: Buffer.from(page.html),
  finalUrl: page.finalUrl ?? page.url,
  truncated: false,
  source,
});

/**
 * Our reader, with the pages the business gave us first: the browser's (when it got the page, not a check), then our
 * own read, then the screenshot when our read showed a robot check or failed.
 */
export function withSitePages(
  fetchUrl: SafeFetch,
  stored: StoredSitePages,
): (url: string, init?: Parameters<SafeFetch>[1]) => Promise<SourcedResponse> {
  if (!stored.size) return fetchUrl;
  return async (url, init) => {
    const key = sitePageKey(url);
    const held = key ? stored.get(key) : undefined;
    if (!held) return fetchUrl(url, init);
    const { browser, screenshot } = held;
    if (browser && !robotCheck({ status: browser.status, html: browser.html }))
      return answerOf(browser, 'browser');
    let live: SafeResponse;
    try {
      live = await fetchUrl(url, init);
    } catch (err) {
      if (screenshot) return answerOf(screenshot, 'screenshot');
      throw err;
    }
    if (screenshot && robotCheck({ status: live.status, html: live.body, headers: live.headers }))
      return answerOf(screenshot, 'screenshot');
    return live;
  };
}
