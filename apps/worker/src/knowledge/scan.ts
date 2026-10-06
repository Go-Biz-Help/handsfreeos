import {
  briefFromProfile,
  executeCommandIn,
  knowledgeSuggestionPropose,
  quoteData,
  scheduleJob,
  type RequestMeta,
  type SystemActor,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { scheduledJobs } from '@hfos/db/schema';
import { eq } from 'drizzle-orm';
import { AiAskError, askStructured } from '../ai/ask';
import type { HandlerContext } from '../handlers/types';
import { SafeFetchError, type SafeResponse } from '../http/safe-fetch';
import type { JobContext, JobHandler, JobResult } from '../jobs';
import { errorMessage, MAX_ATTEMPTS } from '../outbox';
import { systemActor, tenantOf, type TenantScope } from '../services';
import { recordSystemEvent } from '../system-event';
import {
  looksLikePage,
  normalizePageUrl,
  pageLinks,
  pageText,
  pageTitle,
  siteKey,
  sitemapLocations,
  textHash,
  titleFromUrl,
} from './crawl';
import { loadGrounding } from './grounding';
import {
  contentFromItem,
  freshProposals,
  MAX_ITEMS_PER_PAGE,
  PAGE_ITEMS_SCHEMA,
  PageItemsOutput,
  pageMessage,
  plainArticle,
  SCAN_SYSTEM,
  type ProposedContent,
} from './page-items';
import { ALLOW_ALL, parseRobots, robotsAllows, type Robots, type RobotsRule } from './robots';

/**
 * "Scan our website": `knowledge_scan.requested` queues a `knowledge.scan` job, which reads the business's
 * own site a few pages per run and runs again right away until it is done. It starts from the sitemap
 * (sitemap.xml and robots.txt's Sitemap lines) and follows links breadth-first on the same site, honouring
 * robots.txt for HandsFreeOS. Every request goes through ctx.fetchUrl: https only, never a private address,
 * redirects checked again. The model proposes facts, FAQs and articles for each new or changed page (the page
 * is quoted data, never instructions); without a model each page becomes one article. Each suggestion waits
 * for a person. Progress lands on knowledge_scans as it goes; the crawl's own bookkeeping (what's queued,
 * seen and read) rides in the job's payload between runs.
 */

/** The scan's hard limits, whatever the site says. */
export const SCAN_LIMITS = {
  pages: 40,
  pageBytes: 2 * 1024 * 1024,
  requestMs: 10_000,
  /** Requests of any kind (errors and files that aren't pages included), so a broken site can't keep it busy. */
  requests: 100,
  queue: 500,
  seen: 2_000,
  sitemaps: 5,
  sitemapPages: 200,
} as const;

/** Each run reads about this much, then the job runs again right away. */
export const SCAN_PACE = { pagesPerRun: 5, runMs: 20_000 } as const;

type Analysis = 'ai' | 'text';
type Change = 'new' | 'changed' | 'unchanged';

/** One page in knowledge_scans.pages. A rescan compares hashes and proposes only what changed. */
export interface ScanPage {
  readonly url: string;
  readonly title: string;
  readonly hash?: string;
  readonly bytes?: number;
  /** new, changed or unchanged since the last scan; error when it couldn't be read; removed when it's gone. */
  readonly status: Change | 'error' | 'removed';
  /** How its suggestions came about: the AI, or (without a model) the page's own text as one article. */
  readonly analysis?: Analysis;
  readonly suggestions?: number;
  /** Only the first 2 MB was read. */
  readonly truncated?: true;
  readonly error?: string;
}

/** One entry in knowledge_scans.errors. */
interface ScanProblem {
  readonly url?: string;
  readonly code: string;
  readonly message: string;
}

interface ScanState {
  mode: Analysis;
  readonly protocol: string;
  readonly host: string;
  readonly site: string;
  readonly robots: readonly RobotsRule[];
  queue: string[];
  seen: string[];
  done: string[];
  requests: number;
  robotsSkipped: number;
  readonly previous: Readonly<
    Record<string, { readonly hash: string; readonly title: string; readonly analysis: Analysis }>
  >;
}

interface ScanJob {
  readonly scanId: string;
  readonly sourceId: string;
  readonly url: string;
  readonly requestedBy: string | null;
  readonly correlationId: string;
  readonly causationId: string;
  readonly state?: ScanState;
}

interface ScanRun {
  readonly ctx: JobContext;
  readonly scope: TenantScope;
  readonly job: ScanJob;
  readonly state: ScanState;
  /** The business brief the model reads with each page. */
  readonly context: string;
  readonly actor: SystemActor;
  readonly meta: RequestMeta;
}

const BUDGET_PROBLEM: ScanProblem = {
  code: 'budget_reached',
  message:
    'Today’s AI limit for this business was reached, so the scan stopped early. Run it again tomorrow to read the rest of the website.',
};

/** The other way a scan runs out of room to spend: the usage balance rather than the daily token limit. */
const WALLET_PROBLEM: ScanProblem = {
  code: 'wallet_empty',
  message:
    'The balance ran out, so the scan stopped early. Top up and run it again to read the rest of the website.',
};

/** `knowledge_scan.requested`: queue the scan's job. */
export async function onKnowledgeScanRequested(ctx: HandlerContext): Promise<void> {
  const p = ctx.event.payload as {
    scanId?: string;
    sourceId?: string;
    url?: string;
    requestedBy?: string | null;
  };
  if (!p.scanId || !p.sourceId || !p.url)
    throw new Error('knowledge_scan.requested is missing its scan');
  await scheduleJob(ctx.tx, {
    kind: 'knowledge.scan',
    dedupeKey: `knowledge.scan:${p.scanId}`,
    runAt: new Date(),
    payload: {
      scanId: p.scanId,
      sourceId: p.sourceId,
      url: p.url,
      requestedBy: p.requestedBy ?? null,
      correlationId: ctx.event.correlationId,
      causationId: ctx.event.id,
    },
    workspaceId: ctx.event.workspaceId,
    organizationId: ctx.event.organizationId,
  });
}

export const knowledgeScanJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const job = ctx.job.payload as unknown as ScanJob;
  try {
    return await scanSome(ctx, scope, job);
  } catch (e) {
    if (ctx.attempt < MAX_ATTEMPTS) throw e;
    // Out of retries: say so on the scan instead of leaving it running (which would block the next one).
    ctx.log.error({ err: e, scanId: job.scanId }, 'website scan gave up');
    await finishScan(ctx, scope, job, null, 'failed', {
      code: 'failed',
      message:
        e instanceof AiAskError
          ? 'The AI was too busy to finish the scan. Run it again later.'
          : 'Something went wrong while scanning. Run it again later.',
    });
  }
};

async function scanSome(ctx: JobContext, scope: TenantScope, job: ScanJob): Promise<JobResult> {
  const began = Date.now();
  const [live] = await asWorker(ctx.db, scope, (tx) =>
    rows<{ id: string }>(
      tx,
      sql`update app.knowledge_scans set status = 'running', started_at = coalesce(started_at, now())
          where id = ${job.scanId} and status in ('queued', 'running') returning id`,
    ),
  );
  // Finished, cancelled or gone.
  if (!live) return;
  let state = job.state;
  if (!state) {
    const started = await startState(ctx, scope, job);
    if ('problem' in started) {
      await finishScan(ctx, scope, job, null, 'failed', started.problem);
      return;
    }
    state = started;
    const first = state;
    await asWorker(ctx.db, scope, (tx) => saveState(tx, ctx.job.id, job, first));
  }
  const grounding =
    state.mode === 'ai'
      ? await asWorker(ctx.db, scope, (tx) => loadGrounding(tx, scope.workspaceId))
      : null;
  const run: ScanRun = {
    ctx,
    scope,
    job,
    state,
    context: grounding
      ? `<business_profile>\n${quoteData(briefFromProfile(grounding.profile, grounding.business))}\n</business_profile>`
      : '',
    actor: systemActor(scope, job.requestedBy),
    meta: { correlationId: job.correlationId, causationId: job.causationId, channel: 'worker' },
  };
  for (let handled = 0; ; handled++) {
    if (crawlOver(state)) {
      await finishScan(ctx, scope, job, state, 'done');
      return;
    }
    if (handled >= SCAN_PACE.pagesPerRun || Date.now() - began >= SCAN_PACE.runMs) break;
    // The scan stopped (today's AI limit, or the AI refused).
    if (await readNextPage(run)) return;
  }
  const read = state.done.length;
  await asWorker(ctx.db, scope, (tx) =>
    recordSystemEvent(tx, {
      type: 'knowledge_scan.progressed',
      action: 'knowledge_scan.progress',
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      entityType: 'knowledge_scan',
      entityId: job.scanId,
      payload: { scanId: job.scanId, pages: read, queued: state.queue.length },
      after: { url: job.url, pages: read },
      correlationId: job.correlationId,
      causationId: job.causationId,
    }),
  );
  return { rescheduleAt: new Date() };
}

const crawlOver = (s: ScanState) =>
  s.done.length >= SCAN_LIMITS.pages || s.requests >= SCAN_LIMITS.requests || !s.queue.length;

/** Reads robots.txt and the sitemaps, and queues the start page and the sitemap's pages. */
async function startState(
  ctx: JobContext,
  scope: TenantScope,
  job: ScanJob,
): Promise<ScanState | { readonly problem: ScanProblem }> {
  const start = normalizePageUrl(job.url);
  if (!start)
    return { problem: { code: 'invalid_url', message: 'The website address isn’t valid.' } };
  const u = new URL(start);
  const mode: Analysis = ctx.ai.provider ? 'ai' : 'text';
  let robots: Robots = ALLOW_ALL;
  try {
    const res = await ctx.fetchUrl(`${u.origin}/robots.txt`, {
      sameHost: true,
      timeoutMs: SCAN_LIMITS.requestMs,
      maxBytes: 512 * 1024,
    });
    if (res.status >= 500 || res.status === 429)
      return {
        problem: {
          code: 'robots_unavailable',
          message: `The website’s robots.txt answered with an error (${res.status}), so nothing was scanned. Try again later.`,
        },
      };
    // Anything else in the 400s means there is no robots.txt: everything may be read.
    if (res.status >= 200 && res.status < 300) robots = parseRobots(res.body);
  } catch (e) {
    // robots.txt served from another site counts as none; a site we can't reach isn't scanned at all.
    if (!(e instanceof SafeFetchError && e.code === 'other_host'))
      return { problem: siteProblem(u.host, e) };
  }
  const state: ScanState = {
    mode,
    protocol: u.protocol,
    host: u.host,
    site: siteKey(start),
    robots: robots.rules,
    queue: [],
    seen: [],
    done: [],
    requests: 0,
    robotsSkipped: 0,
    previous: await previousPages(ctx, scope, job, mode),
  };
  enqueue(state, [start, ...(await sitemapPages(ctx, state, robots, u.origin))]);
  return state;
}

/** Page hashes from the last few scans, newest first. Pages read without a model are read again with one. */
async function previousPages(
  ctx: JobContext,
  scope: TenantScope,
  job: ScanJob,
  mode: Analysis,
): Promise<ScanState['previous']> {
  const earlier = await asWorker(ctx.db, scope, (tx) =>
    rows<{ pages: unknown }>(
      tx,
      sql`select pages from app.knowledge_scans
          where source_id = ${job.sourceId} and id <> ${job.scanId} and status in ('done', 'failed')
          order by created_at desc limit 5`,
    ),
  );
  const previous: Record<string, { hash: string; title: string; analysis: Analysis }> = {};
  for (const scan of earlier)
    for (const raw of Array.isArray(scan.pages) ? scan.pages : []) {
      const p = raw as Partial<ScanPage>;
      if (typeof p.url !== 'string' || typeof p.hash !== 'string' || previous[p.url]) continue;
      const analysis: Analysis = p.analysis === 'text' ? 'text' : 'ai';
      if (mode === 'ai' && analysis === 'text') continue;
      previous[p.url] = {
        hash: p.hash,
        title: typeof p.title === 'string' ? p.title : '',
        analysis,
      };
    }
  return previous;
}

async function sitemapPages(
  ctx: JobContext,
  state: ScanState,
  robots: Robots,
  origin: string,
): Promise<string[]> {
  const pending = [
    ...new Set(
      [...robots.sitemaps, `${origin}/sitemap.xml`]
        .map((s) => canonical(s, state))
        .filter((s): s is string => !!s),
    ),
  ];
  const pages: string[] = [];
  for (
    let fetched = 0;
    pending.length && fetched < SCAN_LIMITS.sitemaps && pages.length < SCAN_LIMITS.sitemapPages;
    fetched++
  ) {
    const url = pending.shift()!;
    try {
      const res = await ctx.fetchUrl(url, {
        sameHost: true,
        timeoutMs: SCAN_LIMITS.requestMs,
        maxBytes: SCAN_LIMITS.pageBytes,
      });
      if (res.status !== 200) continue;
      const found = sitemapLocations(res.body);
      for (const s of found.sitemaps) {
        const c = canonical(s, state);
        if (c && !pending.includes(c)) pending.push(c);
      }
      for (const p of found.pages) {
        const c = canonical(p, state);
        if (c) pages.push(c);
      }
    } catch (e) {
      // A missing or broken sitemap: the links alone will do.
      ctx.log.info({ url, err: errorMessage(e) }, 'website scan skipped a sitemap');
    }
  }
  return pages.slice(0, SCAN_LIMITS.sitemapPages);
}

/** An address on this site, spelled the way the scan started (scheme and host), or null for another site. */
function canonical(raw: string, s: Pick<ScanState, 'protocol' | 'host' | 'site'>): string | null {
  const url = normalizePageUrl(raw);
  if (!url || siteKey(url) !== s.site) return null;
  const u = new URL(url);
  u.protocol = s.protocol;
  u.host = s.host;
  return u.toString();
}

/** Queues the links not seen before that robots.txt lets us read, in the order found (breadth first). */
function enqueue(state: ScanState, links: readonly string[]): void {
  for (const link of links) {
    const url = canonical(link, state);
    if (!url || !looksLikePage(url) || state.seen.includes(url)) continue;
    if (state.seen.length >= SCAN_LIMITS.seen) return;
    state.seen.push(url);
    const u = new URL(url);
    if (!robotsAllows({ rules: state.robots }, u.pathname + u.search)) {
      state.robotsSkipped++;
      continue;
    }
    if (state.queue.length < SCAN_LIMITS.queue) state.queue.push(url);
  }
}

/** Whether a response is a web page, by its type or, without one, its first bytes. */
export function isHtml(res: SafeResponse): boolean {
  const type = (res.headers['content-type'] ?? '').toLowerCase();
  return type
    ? /text\/html|application\/xhtml\+xml/.test(type)
    : /<!doctype html|<html[\s>]/i.test(res.body.slice(0, 2048));
}

/** Reads the next page in the queue. True when the whole scan stopped. */
async function readNextPage(run: ScanRun): Promise<boolean> {
  const { ctx, state, job } = run;
  const url = state.queue.shift()!;
  state.requests++;
  let res: SafeResponse;
  try {
    res = await ctx.fetchUrl(url, {
      sameHost: true,
      timeoutMs: SCAN_LIMITS.requestMs,
      maxBytes: SCAN_LIMITS.pageBytes,
      headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1' },
    });
  } catch (e) {
    const problem = fetchProblem(url, e);
    if (problem.code === 'blocked_address')
      ctx.log.warn(
        { scanId: job.scanId, url, reason: problem.message },
        'website scan refused a private address',
      );
    else
      ctx.log.info({ scanId: job.scanId, url, code: problem.code }, 'website scan skipped a page');
    await savePage(run, { problem });
    return false;
  }
  if (res.status < 200 || res.status >= 300) {
    const message =
      res.status === 404 || res.status === 410
        ? 'The page wasn’t found.'
        : `The page answered with an error (${res.status}).`;
    await savePage(run, { problem: { url, code: `http_${res.status}`, message } });
    return false;
  }
  const finalUrl = canonical(res.finalUrl, state) ?? url;
  // Not a web page, or one already read (a redirect to it): nothing to record.
  if (!isHtml(res) || state.done.includes(finalUrl)) {
    await savePage(run, {});
    return false;
  }
  state.queue = state.queue.filter((q) => q !== finalUrl);
  if (!state.seen.includes(finalUrl)) state.seen.push(finalUrl);
  state.done.push(finalUrl);
  const title = pageTitle(res.body) || titleFromUrl(finalUrl);
  const text = pageText(res.body);
  enqueue(state, pageLinks(res.body, finalUrl));
  const hash = textHash(text);
  const before = state.previous[finalUrl];
  const change: Change = !before ? 'new' : before.hash === hash ? 'unchanged' : 'changed';
  if (res.truncated)
    ctx.log.info(
      { scanId: job.scanId, url: finalUrl },
      'website scan kept the first 2 MB of a page',
    );
  const entry: ScanPage = {
    url: finalUrl,
    title,
    hash,
    bytes: Buffer.byteLength(res.body),
    status: change,
    analysis: before && change === 'unchanged' ? before.analysis : state.mode,
    ...(res.truncated ? { truncated: true as const } : {}),
  };
  if (change === 'unchanged' || !text) {
    await savePage(run, { entry });
    return false;
  }
  if (state.mode === 'text') {
    const article = plainArticle({ url: finalUrl, title, text });
    await savePage(run, { entry, contents: article ? [article] : [] });
    return false;
  }
  let contents: ProposedContent[];
  try {
    const { value } = await askStructured(ctx, run.scope, {
      system: SCAN_SYSTEM,
      context: run.context,
      messages: [{ role: 'user', content: pageMessage({ url: finalUrl, title, text }) }],
      schema: PAGE_ITEMS_SCHEMA,
      zod: PageItemsOutput,
      maxTokens: 12_000,
      usage: { source: 'knowledge', userId: job.requestedBy },
    });
    contents = value.items.slice(0, MAX_ITEMS_PER_PAGE).flatMap((i) => contentFromItem(i) ?? []);
  } catch (e) {
    if (!(e instanceof AiAskError)) throw e;
    if (e.code === 'bad_output') {
      await savePage(run, {
        entry: { url: finalUrl, title, status: 'error', error: 'The AI couldn’t read this page.' },
      });
      return false;
    }
    if (e.code === 'ai_unavailable') {
      // The model went away mid-scan (a restart without a key): the rest is read without it.
      state.mode = 'text';
      const article = plainArticle({ url: finalUrl, title, text });
      await savePage(run, {
        entry: { ...entry, analysis: 'text' },
        contents: article ? [article] : [],
      });
      return false;
    }
    // Not read after all: the retry, or tomorrow's rescan, reads it again.
    state.done.pop();
    if (e.code === 'provider_error' && e.retryable) {
      state.queue.unshift(finalUrl);
      state.requests--;
      await asWorker(ctx.db, run.scope, (tx) => saveState(tx, ctx.job.id, job, state));
      throw e;
    }
    await finishScan(
      ctx,
      run.scope,
      job,
      state,
      'failed',
      e.code === 'budget_reached'
        ? BUDGET_PROBLEM
        : e.code === 'wallet_empty'
          ? WALLET_PROBLEM
          : {
              code: 'ai_failed',
              message:
                'The AI couldn’t read the website’s pages, so the scan stopped. Try again later.',
            },
    );
    return true;
  }
  await savePage(run, { entry, contents });
  return false;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const stamped = (p: ScanProblem) => ({
  ...(p.url ? { url: clip(p.url, 300) } : {}),
  code: p.code,
  message: clip(p.message, 300),
  at: new Date().toISOString(),
});

/**
 * One page's outcome, in one transaction: its suggestions (after dedupe, through knowledge_suggestion.propose),
 * its entry or problem on the scan, and the crawl's bookkeeping on the job.
 */
async function savePage(
  run: ScanRun,
  page: {
    readonly entry?: ScanPage;
    readonly contents?: readonly ProposedContent[];
    readonly problem?: ScanProblem;
  },
): Promise<void> {
  const { ctx, scope, job, state } = run;
  const { entry, contents, problem } = page;
  await asWorker(ctx.db, scope, async (tx) => {
    let created = 0;
    if (entry && (entry.status === 'new' || entry.status === 'changed') && contents?.length) {
      const fresh = await freshProposals(
        tx,
        scope.workspaceId,
        { url: entry.url, change: entry.status },
        contents,
        entry.analysis === 'ai',
      );
      if (fresh.length) {
        const { output } = await executeCommandIn(
          tx,
          knowledgeSuggestionPropose,
          { workspaceId: scope.workspaceId, scanId: job.scanId, suggestions: fresh },
          run.actor,
          run.meta,
        );
        created = output.created;
      }
    }
    const pages = entry
      ? [
          {
            ...entry,
            ...(entry.status === 'new' || entry.status === 'changed'
              ? { suggestions: created }
              : {}),
          },
        ]
      : [];
    const errors = problem ? [stamped(problem)] : [];
    await tx.execute(sql`update app.knowledge_scans
        set pages = pages || ${JSON.stringify(pages)}::jsonb,
            errors = errors || ${JSON.stringify(errors)}::jsonb,
            suggestion_count = suggestion_count + ${created}
        where id = ${job.scanId}`);
    await saveState(tx, ctx.job.id, job, state);
  });
}

/** The crawl's bookkeeping rides in the job's own payload between runs (the worker may use any scope for it). */
async function saveState(tx: Tx, jobId: string, job: ScanJob, state: ScanState): Promise<void> {
  const { state: _previous, ...rest } = job;
  await tx
    .update(scheduledJobs)
    .set({ payload: { ...rest, state } as unknown as typeof scheduledJobs.$inferInsert.payload })
    .where(eq(scheduledJobs.id, jobId));
}

/** Ends the scan (done or failed), notes pages a finished rescan no longer found, and says how it went. */
async function finishScan(
  ctx: JobContext,
  scope: TenantScope,
  job: ScanJob,
  state: ScanState | null,
  status: 'done' | 'failed',
  problem?: ScanProblem,
): Promise<void> {
  const removed: ScanPage[] = [];
  const problems: ScanProblem[] = problem ? [problem] : [];
  if (state && status === 'done') {
    // Pages an earlier scan read that this one never reached, unless a limit cut the crawl short.
    if (state.done.length < SCAN_LIMITS.pages && state.requests < SCAN_LIMITS.requests)
      for (const [url, p] of Object.entries(state.previous))
        if (!state.done.includes(url)) removed.push({ url, title: p.title, status: 'removed' });
    if (!state.done.length)
      problems.push(
        state.robotsSkipped
          ? {
              code: 'robots',
              message:
                'The website’s robots.txt asks scanners not to read it, so nothing was read.',
            }
          : { code: 'no_pages', message: 'No pages could be read from this website.' },
      );
  }
  await asWorker(ctx.db, scope, async (tx) => {
    const [row] = await rows<{
      suggestion_count: number;
      read: number;
      new_pages: number;
      changed_pages: number;
      unchanged_pages: number;
      removed_pages: number;
      error_count: number;
    }>(
      tx,
      sql`update app.knowledge_scans
          set status = ${status}::app.knowledge_scan_status, finished_at = now(),
              pages = pages || ${JSON.stringify(removed)}::jsonb,
              errors = errors || ${JSON.stringify(problems.map(stamped))}::jsonb
          where id = ${job.scanId} and status in ('queued', 'running')
          returning suggestion_count,
            (select count(*)::int from jsonb_array_elements(pages) p where p ->> 'status' <> 'removed') as read,
            (select count(*)::int from jsonb_array_elements(pages) p where p ->> 'status' = 'new') as new_pages,
            (select count(*)::int from jsonb_array_elements(pages) p where p ->> 'status' = 'changed') as changed_pages,
            (select count(*)::int from jsonb_array_elements(pages) p where p ->> 'status' = 'unchanged') as unchanged_pages,
            (select count(*)::int from jsonb_array_elements(pages) p where p ->> 'status' = 'removed') as removed_pages,
            jsonb_array_length(errors) as error_count`,
    );
    if (!row) return;
    await recordSystemEvent(tx, {
      type: 'knowledge_scan.finished',
      action: 'knowledge_scan.finish',
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      entityType: 'knowledge_scan',
      entityId: job.scanId,
      payload: {
        scanId: job.scanId,
        status,
        pages: row.read,
        suggestions: row.suggestion_count,
        errors: row.error_count,
        new: row.new_pages,
        changed: row.changed_pages,
        unchanged: row.unchanged_pages,
        removed: row.removed_pages,
        robotsSkipped: state?.robotsSkipped ?? 0,
        ...(problem ? { reason: problem.code } : {}),
      },
      after: {
        url: job.url,
        status,
        pages: row.read,
        suggestions: row.suggestion_count,
        ...(problem ? { note: problem.message } : {}),
      },
      correlationId: job.correlationId,
      causationId: job.causationId,
    });
  });
  ctx.log.info({ scanId: job.scanId, status }, 'website scan finished');
}

function fetchProblem(url: string, e: unknown): ScanProblem {
  if (e instanceof SafeFetchError) return { url, code: e.code, message: e.message };
  return { url, code: 'network', message: 'The page couldn’t be read.' };
}

function siteProblem(host: string, e: unknown): ScanProblem {
  const code = e instanceof SafeFetchError ? e.code : 'network';
  const message =
    code === 'blocked_address'
      ? `${host} points to a private address, so it can’t be scanned.`
      : code === 'timeout'
        ? `${host} took too long to answer. Try again later.`
        : `We couldn’t reach ${host}. Check the website address and try again.`;
  return { code, message };
}
