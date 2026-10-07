import { createHash } from 'node:crypto';
import {
  executeCommandIn,
  LOOK_BUCKET,
  LOOK_PROBLEMS,
  LOOK_UPLOAD_BUCKET,
  LOOK_UPLOAD_MAX_BYTES,
  LOOK_UPLOAD_PATH,
  lookNoteUpload,
  lookNoteWebsite,
  lookOf,
  scheduleJob,
  type BusinessLook,
} from '@hfos/core/server';
import { asWorker } from '@hfos/db/client';
import { workspaces } from '@hfos/db/schema';
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { robotsOf } from '../ai-setup/read-site';
import type { HandlerContext } from '../handlers/types';
import { SafeFetchError } from '../http/safe-fetch';
import type { JobContext, JobHandler } from '../jobs';
import { siteKey } from '../knowledge/crawl';
import { robotsAllows, type Robots } from '../knowledge/robots';
import { isHtml } from '../knowledge/scan';
import { errorMessage, MAX_ATTEMPTS } from '../outbox';
import { systemActor, tenantOf, type TenantScope } from '../services';
import { LogoError, makeLogo, type MadeLogo } from './logo';
import { dataPicture, LOGO_TRIES, logoCandidates, themeColorOf } from './website';

/**
 * A business's logo and colour, the worker's part (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4).
 *
 * - `look.upload_ready` (someone uploaded a logo) queues `look.make_logo`: the picture waiting in `brand-uploads`
 *   is made into the PNG everyone sees, in the public `brand` bucket, and `look.note_upload` keeps it with its
 *   colour, or says why it couldn't be used. The upload is removed either way.
 * - `look.find_requested` (the website was saved, or someone asked to look again) queues `look.find_logo`: the
 *   website's start page is read, as robots.txt lets HandsFreeOS, its likeliest logos are tried in turn
 *   (look/website.ts), and `look.note_website` keeps the first that makes a logo, with its colour or else the
 *   website's own. Every request goes through ctx.fetchUrl: https only, never a private address.
 *
 * A made logo is kept at a place named for its upload or its job, so a retry writes the same file again; one the
 * look didn't keep (another logo got there first) is removed.
 */

export const MAKE_LOGO_JOB = 'look.make_logo';
export const FIND_LOGO_JOB = 'look.find_logo';

export const FIND_LOGO_LIMITS = {
  requestMs: 10_000,
  pageBytes: 2 * 1024 * 1024,
} as const;

interface MakeLogoJob {
  readonly objectPath: string;
  readonly requestedBy: string | null;
  readonly correlationId: string;
  readonly causationId: string | null;
}

interface FindLogoJob {
  /** The website as the business keeps it: what's found is kept for this address only. */
  readonly website: string;
  /** Where to look: the website itself (tests point it at a stand-in site). */
  readonly url: string;
  readonly requestedBy: string | null;
  readonly correlationId: string;
  readonly causationId: string | null;
}

const byPerson = (ctx: HandlerContext) =>
  ctx.event.actorType === 'human' ? (ctx.event.actorId ?? null) : null;

/** `look.upload_ready`: make the logo, once for each upload. */
export async function onLookUploadReady(ctx: HandlerContext): Promise<void> {
  const p = ctx.event.payload as { objectPath?: string };
  if (!p.objectPath) throw new Error('look.upload_ready is missing its picture');
  await scheduleJob(ctx.tx, {
    kind: MAKE_LOGO_JOB,
    dedupeKey: `${MAKE_LOGO_JOB}:${p.objectPath}`,
    runAt: new Date(),
    payload: {
      objectPath: p.objectPath,
      requestedBy: byPerson(ctx),
      correlationId: ctx.event.correlationId,
      causationId: ctx.event.id,
    } satisfies MakeLogoJob,
    workspaceId: ctx.event.workspaceId,
    organizationId: ctx.event.organizationId,
  });
}

/** `look.find_requested`: look on the website, one job for each address while it waits. */
export async function onLookFindRequested(ctx: HandlerContext): Promise<void> {
  const p = ctx.event.payload as { url?: string };
  if (!p.url) throw new Error('look.find_requested is missing its website');
  const address = createHash('sha256').update(p.url).digest('hex').slice(0, 16);
  await scheduleJob(ctx.tx, {
    kind: FIND_LOGO_JOB,
    dedupeKey: `${FIND_LOGO_JOB}:${ctx.event.workspaceId}:${address}`,
    runAt: new Date(),
    payload: {
      website: p.url,
      url: p.url,
      requestedBy: byPerson(ctx),
      correlationId: ctx.event.correlationId,
      causationId: ctx.event.id,
    } satisfies FindLogoJob,
    workspaceId: ctx.event.workspaceId,
    organizationId: ctx.event.organizationId,
  });
}

/** The business's look and website as they are now. */
async function lookNow(
  ctx: JobContext,
  scope: TenantScope,
): Promise<{ look: BusinessLook; website: string | null }> {
  const [w] = await asWorker(ctx.db, scope, (tx) =>
    tx
      .select({ settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, scope.workspaceId)),
  );
  const website = (w?.settings as Record<string, unknown> | null)?.['website'];
  return { look: lookOf(w?.settings), website: typeof website === 'string' ? website : null };
}

/** Where a made logo is kept: named for the upload it came from, or the job that found it. */
const logoPath = (scope: TenantScope, id: string) => `${scope.workspaceId}/logo/${id}.png`;

export const makeLogoJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const job = ctx.job.payload as unknown as MakeLogoJob;
  try {
    await makeUploadedLogo(ctx, scope, job);
  } catch (e) {
    if (ctx.attempt < MAX_ATTEMPTS) throw e;
    // Out of tries: the person is told, and can upload it again.
    ctx.log.warn(
      { objectPath: job.objectPath, err: errorMessage(e) },
      'the logo someone uploaded couldn’t be made ready',
    );
    await noteUpload(ctx, scope, job, null, LOOK_PROBLEMS.failed);
  }
};

async function makeUploadedLogo(
  ctx: JobContext,
  scope: TenantScope,
  job: MakeLogoJob,
): Promise<void> {
  // Only ever a picture of this business, at a place look.begin_upload names.
  if (!LOOK_UPLOAD_PATH.test(job.objectPath) || !job.objectPath.startsWith(`${scope.workspaceId}/`))
    throw new Error('look.make_logo was given a picture outside its business');
  const log = ctx.log.child({ objectPath: job.objectPath });
  const { look } = await lookNow(ctx, scope);
  if (look.upload?.path !== job.objectPath || !look.upload.sent) {
    // Another upload since, or this one was dealt with already: what's left of it goes.
    await ctx.store.remove(LOOK_UPLOAD_BUCKET, job.objectPath);
    return;
  }
  const info = await ctx.store.info(LOOK_UPLOAD_BUCKET, job.objectPath);
  if (!info) {
    await noteUpload(ctx, scope, job, null, LOOK_PROBLEMS.missing);
    return;
  }
  let made: MadeLogo;
  try {
    if (info.size > LOOK_UPLOAD_MAX_BYTES) throw new LogoError('tooBig');
    made = await makeLogo(await ctx.store.download(LOOK_UPLOAD_BUCKET, job.objectPath));
  } catch (e) {
    if (!(e instanceof LogoError)) throw e;
    log.info({ problem: e.problem }, 'an uploaded logo couldn’t be used');
    await noteUpload(ctx, scope, job, null, e.message);
    await ctx.store.remove(LOOK_UPLOAD_BUCKET, job.objectPath);
    return;
  }
  const id = job.objectPath.slice(job.objectPath.indexOf('/') + 1).replace(/\.[a-z]+$/, '');
  const path = logoPath(scope, id);
  await ctx.store.upload(LOOK_BUCKET, path, made.png, 'image/png', { upsert: true });
  const kept = await noteUpload(ctx, scope, job, { path, made }, null);
  if (!kept) await ctx.store.remove(LOOK_BUCKET, path);
  await ctx.store.remove(LOOK_UPLOAD_BUCKET, job.objectPath);
  log.info({ kept, width: made.width, height: made.height }, 'made an uploaded logo');
}

async function noteUpload(
  ctx: JobContext,
  scope: TenantScope,
  job: MakeLogoJob,
  logo: { readonly path: string; readonly made: MadeLogo } | null,
  problem: string | null,
): Promise<boolean> {
  const { output } = await asWorker(ctx.db, scope, (tx) =>
    executeCommandIn(
      tx,
      lookNoteUpload,
      {
        workspaceId: scope.workspaceId,
        objectPath: job.objectPath,
        logo: logo ? { path: logo.path, width: logo.made.width, height: logo.made.height } : null,
        color: logo?.made.color ?? null,
        problem,
      },
      systemActor(scope, job.requestedBy),
      { correlationId: job.correlationId, causationId: job.causationId, channel: 'worker' },
    ),
  );
  return output.kept;
}

export const findLogoJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const job = ctx.job.payload as unknown as FindLogoJob;
  try {
    await findLogo(ctx, scope, job);
  } catch (e) {
    if (ctx.attempt < MAX_ATTEMPTS) throw e;
    // Out of tries: noted as nothing found, so the screens stop waiting and offer the upload.
    ctx.log.warn(
      { url: job.url, err: errorMessage(e) },
      'couldn’t look for the logo on the website',
    );
    await noteWebsite(ctx, scope, job, null, null);
  }
};

async function findLogo(ctx: JobContext, scope: TenantScope, job: FindLogoJob): Promise<void> {
  const log = ctx.log.child({ url: job.url });
  const now = await lookNow(ctx, scope);
  // The website changed since, or there's a logo already: nothing to look for.
  if (now.website !== job.website || now.look.logo) return;
  const page = await startPage(ctx, job.url, log);
  if (!page) {
    await noteWebsite(ctx, scope, job, null, null);
    return;
  }
  const theme = themeColorOf(page.html);
  const candidates = logoCandidates(page.html, page.url).slice(0, LOGO_TRIES);
  for (const candidate of candidates) {
    const data = await pictureAt(ctx, candidate, page, log);
    if (!data) continue;
    let made: MadeLogo;
    try {
      made = await makeLogo(data);
    } catch (e) {
      if (!(e instanceof LogoError)) throw e;
      log.info({ candidate: shortUrl(candidate), problem: e.problem }, 'not a logo');
      continue;
    }
    const path = logoPath(scope, ctx.job.id);
    await ctx.store.upload(LOOK_BUCKET, path, made.png, 'image/png', { upsert: true });
    const color = made.color
      ? { hex: made.color, from: 'logo' as const }
      : theme
        ? { hex: theme, from: 'website' as const }
        : null;
    const kept = await noteWebsite(ctx, scope, job, { path, made }, color);
    if (!kept) await ctx.store.remove(LOOK_BUCKET, path);
    log.info(
      { kept, candidate: shortUrl(candidate), tried: candidates.indexOf(candidate) + 1 },
      'found the logo on the website',
    );
    return;
  }
  await noteWebsite(ctx, scope, job, null, theme ? { hex: theme, from: 'website' } : null);
  log.info({ tried: candidates.length, theme: !!theme }, 'found no logo on the website');
}

async function noteWebsite(
  ctx: JobContext,
  scope: TenantScope,
  job: FindLogoJob,
  logo: { readonly path: string; readonly made: MadeLogo } | null,
  color: { readonly hex: string; readonly from: 'logo' | 'website' } | null,
): Promise<boolean> {
  const { output } = await asWorker(ctx.db, scope, (tx) =>
    executeCommandIn(
      tx,
      lookNoteWebsite,
      {
        workspaceId: scope.workspaceId,
        url: job.website,
        logo: logo ? { path: logo.path, width: logo.made.width, height: logo.made.height } : null,
        color,
      },
      systemActor(scope, job.requestedBy),
      { correlationId: job.correlationId, causationId: job.causationId, channel: 'worker' },
    ),
  );
  return output.kept;
}

interface StartPage {
  readonly url: string;
  readonly html: string;
  readonly robots: Robots;
}

/** The website's start page, as far as robots.txt lets HandsFreeOS; null when it can't be read. */
async function startPage(ctx: JobContext, url: string, log: Logger): Promise<StartPage | null> {
  let start: URL;
  try {
    start = new URL(url);
  } catch {
    return null;
  }
  const robots = await robotsOf(ctx, start.origin, log);
  if (!robots) return null;
  if (!robotsAllows(robots, start.pathname + start.search)) {
    log.info('the website’s robots.txt keeps HandsFreeOS off its start page');
    return null;
  }
  try {
    const res = await ctx.fetchUrl(start.toString(), {
      sameHost: true,
      timeoutMs: FIND_LOGO_LIMITS.requestMs,
      maxBytes: FIND_LOGO_LIMITS.pageBytes,
      headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1' },
    });
    if (res.status < 200 || res.status >= 300 || !isHtml(res)) {
      log.info({ status: res.status }, 'the website’s start page couldn’t be read');
      return null;
    }
    return { url: res.finalUrl, html: res.body, robots };
  } catch (e) {
    log.info({ code: fetchCode(e) }, 'couldn’t reach the website');
    return null;
  }
}

/** A picture's bytes, from the page itself (data:) or its address; null when it can't be had. */
async function pictureAt(
  ctx: JobContext,
  url: string,
  page: StartPage,
  log: Logger,
): Promise<Buffer | null> {
  if (url.startsWith('data:')) return dataPicture(url);
  const u = new URL(url);
  // robots.txt speaks for its own site: pictures served from elsewhere (an image service) are theirs to serve.
  if (siteKey(url) === siteKey(page.url) && !robotsAllows(page.robots, u.pathname + u.search))
    return null;
  for (const address of u.protocol === 'http:' ? [url, httpsOf(u)] : [url]) {
    try {
      const res = await ctx.fetchUrl(address, {
        timeoutMs: FIND_LOGO_LIMITS.requestMs,
        maxBytes: LOOK_UPLOAD_MAX_BYTES,
        binary: true,
        headers: { accept: 'image/png,image/svg+xml,image/webp,image/jpeg,image/gif,*/*;q=0.1' },
      });
      if (res.status < 200 || res.status >= 300 || res.truncated) return null;
      return res.bytes;
    } catch (e) {
      // A picture on plain http is tried again over https.
      if (e instanceof SafeFetchError && e.code === 'not_https') continue;
      log.info({ candidate: shortUrl(url), code: fetchCode(e) }, 'couldn’t fetch a picture');
      return null;
    }
  }
  return null;
}

const httpsOf = (u: URL) => {
  const s = new URL(u.toString());
  s.protocol = 'https:';
  return s.toString();
};

/** A picture's address for the logs: never a whole data: picture. */
const shortUrl = (url: string) => (url.startsWith('data:') ? url.slice(0, 30) : url);

const fetchCode = (e: unknown) => (e instanceof SafeFetchError ? e.code : 'network');
