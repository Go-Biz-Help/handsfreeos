/**
 * "What's on your site now", for texting approval's question on how customers will agree (the owner's pick 9a,
 * 2026-11-22): the forms a carrier's reviewer would find on the business's website, shown before it picks the chat or
 * our contact form, so it knows which of its forms come off or get swapped. The same walk the checks before sending
 * make (`scanSiteForms`), read the same way (`siteFormsFound`), but here nothing is judged: it's a list.
 *
 * POST /v1/telephony/site-forms {workspaceId, website} → {opened, cut, blocked, forms}
 * 403 without channels.manage; 429 `rate_limited`. A site that doesn't open comes back as no pages opened.
 */
import rateLimit from '@fastify/rate-limit';
import { siteFormsFound } from '@hfos/core';
import { HfosError } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { publicOrigin } from '../hosting/origin';
import { authenticate, parseBody, requirePermission, type HttpDeps } from './common';
import { storedSitePages, withSitePages } from './site-check';
import { scanSiteForms } from './site-forms';

/** Walks of a site one address may ask for in a minute: each opens up to forty pages of somebody's website. */
export const SITE_FORMS_PER_MINUTE = 6;
/** The most forms listed: a site with more than this has a bigger job than a list can show. */
const MOST_FORMS = 12;

const Input = z.strictObject({
  workspaceId: z.uuid(),
  website: z.string().trim().min(1).max(300),
});

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
};

export async function registerSiteFormsFoundRoutes(
  app: FastifyInstance,
  deps: HttpDeps,
): Promise<void> {
  await app.register(async (scoped) => {
    await scoped.register(rateLimit, {
      global: false,
      errorResponseBuilder: () =>
        new HfosError(
          'rule_violation',
          429,
          'That’s a lot of looks at your site in a row. Wait a minute and try again.',
          undefined,
          'rate_limited',
        ),
    });
    scoped.post(
      '/v1/telephony/site-forms',
      { config: { rateLimit: { max: SITE_FORMS_PER_MINUTE, timeWindow: 60_000 } } },
      async (req) => {
        const actor = await authenticate(deps, req);
        const input = parseBody(Input, req.body);
        await requirePermission(deps, actor.userId, input.workspaceId, 'channels.manage');
        // Pages the business's own browser read for us are used first, as the checks before sending use them.
        const fetchUrl = withSitePages(
          deps.fetchUrl,
          await storedSitePages(deps, input.workspaceId),
        );
        const scan = await scanSiteForms({ fetchUrl }, input.website);
        // One of the business's own forms here, framed on its site: `/f/<its public name>/…` on our address or its own.
        const mine = await asWorker(deps.httpDb, { workspaceId: input.workspaceId }, async (tx) => {
          const [site] = await rows<{ slug: string }>(
            tx,
            sql`select slug::text as slug from app.booking_sites where workspace_id = ${input.workspaceId}`,
          );
          return {
            slug: site?.slug ?? null,
            pages: await publicOrigin(tx, input.workspaceId, deps.webUrl),
          };
        });
        const hosts = new Set([hostOf(deps.webUrl), hostOf(mine.pages)]);
        const isOurs = (framedUrl: string): boolean => {
          try {
            const at = new URL(framedUrl);
            return (
              !!mine.slug &&
              hosts.has(at.host.toLowerCase()) &&
              at.pathname.startsWith(`/f/${mine.slug}/`)
            );
          } catch {
            return false;
          }
        };
        return {
          opened: scan.opened,
          cut: scan.cut,
          blocked: scan.blocked.length,
          forms: siteFormsFound(scan, isOurs).slice(0, MOST_FORMS),
        };
      },
    );
  });
}
