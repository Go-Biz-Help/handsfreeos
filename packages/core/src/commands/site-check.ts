/**
 * The texting registration's checks reading a business's pages some other way than by our server (owner,
 * 2026-11-20; `websites/site-pages.ts` says why). All three are the worker's: it checks the person may manage the
 * business's channels (the start, a screenshot) or holds the site check's code (the pages), then writes through
 * these. Nothing here sends anything anywhere, so none emits an event.
 */
import { and, eq, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { siteChecks, sitePages } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { SITE_CHECK_LIMITS } from '../websites/site-pages';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

const address = z.string().trim().min(1).max(2048);
const key = z.string().min(1).max(2048);
const html = z.string().max(SITE_CHECK_LIMITS.pageChars);

/** A site check's code running out, or used up: the person starts another from the last step. */
export const SITE_CHECK_OVER =
  'This check of your site has run out. Go back to HandsFreeOS and press “Finish the check on my site” again.';

export const RegistrationSiteCheckStartInput = z.strictObject({
  workspaceId: z.uuid(),
  /** The sha-256 of the code; the code itself is the worker's to give the person, and never kept. */
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** The site's host without www (core's siteHost). */
  site: z.string().min(1).max(253),
  startUrl: address,
  urls: z.array(address).max(40),
  /** The person who pressed it. */
  requestedBy: z.uuid().nullable(),
});
export const RegistrationSiteCheckStartOutput = z.object({ checkId: z.uuid() });

export const registrationSiteCheckStart = defineCommand({
  name: 'registration.site_check_start',
  description:
    'Worker: a one-time code for "Finish the check on my site", so the business’s own browser can read its site’s pages for the texting registration’s checks. Replaces the business’s earlier ones, and what they read.',
  risk: 1,
  input: RegistrationSiteCheckStartInput,
  output: RegistrationSiteCheckStartOutput,
  permission: null,
  scope: inWorkspace,
  emits: [],
  actors: ['system'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    // One check at a time: an earlier one's pages go with it (site_pages.check_id cascades), and so do screenshots
    // past their month.
    await ctx.tx.delete(siteChecks).where(eq(siteChecks.workspaceId, workspaceId));
    await ctx.tx
      .delete(sitePages)
      .where(
        and(
          eq(sitePages.workspaceId, workspaceId),
          eq(sitePages.source, 'screenshot'),
          lt(
            sitePages.readAt,
            sql`now() - make_interval(days => ${SITE_CHECK_LIMITS.screenshotDays})`,
          ),
        ),
      );
    const [row] = await ctx.tx
      .insert(siteChecks)
      .values({
        workspaceId,
        tokenHash: input.tokenHash,
        site: input.site,
        startUrl: input.startUrl,
        urls: input.urls,
        requestedBy: input.requestedBy,
        expiresAt: sql`now() + make_interval(mins => ${SITE_CHECK_LIMITS.minutes})`,
      })
      .returning({ id: siteChecks.id });
    return { checkId: row!.id };
  },
});

export const RegistrationSiteCheckSavePagesInput = z.strictObject({
  workspaceId: z.uuid(),
  checkId: z.uuid(),
  /** Each page under each key it's known by (the address asked for, and where it ended up). */
  pages: z
    .array(
      z.strictObject({
        key,
        url: address,
        finalUrl: address.nullable(),
        status: z.int().min(0).max(999),
        html,
      }),
    )
    .max(SITE_CHECK_LIMITS.batch * 2),
  done: z.boolean(),
});
export const RegistrationSiteCheckSavePagesOutput = z.object({ pages: z.int() });

export const registrationSiteCheckSavePages = defineCommand({
  name: 'registration.site_check_save_pages',
  description:
    'Worker: pages the business’s own browser read on its site during "Finish the check on my site", kept for the texting registration’s checks for half an hour.',
  risk: 1,
  input: RegistrationSiteCheckSavePagesInput,
  output: RegistrationSiteCheckSavePagesOutput,
  permission: null,
  scope: inWorkspace,
  emits: [],
  actors: ['system'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const [check] = await ctx.tx
      .select({
        pages: siteChecks.pages,
        finished: siteChecks.finishedAt,
        live: sql<boolean>`${siteChecks.expiresAt} > now()`,
      })
      .from(siteChecks)
      .where(and(eq(siteChecks.id, input.checkId), eq(siteChecks.workspaceId, workspaceId)))
      .for('update');
    // Its pages are kept while it's live and still reading; afterwards nothing more is let in.
    if (!check || !check.live || check.finished)
      throw HfosError.rule('site_check_over', 410, SITE_CHECK_OVER);
    const read = new Set(input.pages.map((p) => p.url)).size;
    if (check.pages + read > SITE_CHECK_LIMITS.pages + SITE_CHECK_LIMITS.batch)
      throw HfosError.rule('site_check_over', 410, SITE_CHECK_OVER);
    for (const page of input.pages) {
      const row = {
        url: page.url,
        finalUrl: page.finalUrl,
        status: page.status,
        html: page.html,
        checkId: input.checkId,
        readAt: new Date(),
      };
      await ctx.tx
        .insert(sitePages)
        .values({ workspaceId, key: page.key, source: 'browser', ...row })
        .onConflictDoUpdate({
          target: [sitePages.workspaceId, sitePages.key, sitePages.source],
          set: row,
        });
    }
    const pages = check.pages + read;
    await ctx.tx
      .update(siteChecks)
      .set({ pages, ...(input.done ? { finishedAt: new Date() } : {}) })
      .where(eq(siteChecks.id, input.checkId));
    return { pages };
  },
});

export const RegistrationSaveSiteScreenshotInput = z.strictObject({
  workspaceId: z.uuid(),
  key,
  url: address,
  /** The AI's write-up of the screenshot, as a plain page. */
  html,
  readBy: z.uuid().nullable(),
});
export const RegistrationSaveSiteScreenshotOutput = z.object({ saved: z.literal(true) });

export const registrationSaveSiteScreenshot = defineCommand({
  name: 'registration.save_site_screenshot',
  description:
    'Worker: a page the texting registration’s checks couldn’t open, written down from the business’s screenshot of it, read in its place for a month. A new screenshot of the page replaces it.',
  risk: 1,
  input: RegistrationSaveSiteScreenshotInput,
  output: RegistrationSaveSiteScreenshotOutput,
  permission: null,
  scope: inWorkspace,
  emits: [],
  actors: ['system'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const row = {
      url: input.url,
      finalUrl: input.url,
      status: 200,
      html: input.html,
      checkId: null,
      readBy: input.readBy,
      readAt: new Date(),
    };
    await ctx.tx
      .insert(sitePages)
      .values({ workspaceId, key: input.key, source: 'screenshot', ...row })
      .onConflictDoUpdate({
        target: [sitePages.workspaceId, sitePages.key, sitePages.source],
        set: row,
      });
    return { saved: true as const };
  },
});
