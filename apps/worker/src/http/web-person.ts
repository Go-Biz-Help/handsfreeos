/**
 * "Email your web person": the files as they'd go, for the dialog to show before anything is sent (owners and admins;
 * channels.manage). The worker writes them, from the same code that writes the ones it sends, because only it knows
 * the address the business's pages are on. A refusal comes back as one, with its `rule`, so the dialog can show it
 * beside the fix it's about and offer to put it right.
 */
import {
  refuseUnwritable,
  WEBSITE_FIX_IDS,
  websiteFixFactsFrom,
  websiteFixFiles,
  websiteFixSourcesOf,
} from '@hfos/core/server';
import { asWorker } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { publicOrigin } from '../hosting/origin';
import { authenticate, parseBody, requirePermission, type HttpDeps } from './common';

const PreviewInput = z.strictObject({
  workspaceId: z.uuid(),
  fixes: z.array(z.enum(WEBSITE_FIX_IDS)).min(1).max(WEBSITE_FIX_IDS.length),
  /** One of the business's published forms, or null for a form of their own; left out, the newest published one. */
  formId: z.uuid().nullable().optional(),
});

export function registerWebPersonRoutes(app: FastifyInstance, deps: HttpDeps): void {
  app.post('/v1/telephony/web-person-preview', async (req) => {
    const actor = await authenticate(deps, req);
    const input = parseBody(PreviewInput, req.body);
    await requirePermission(deps, actor.userId, input.workspaceId, 'channels.manage');
    return asWorker(deps.httpDb, { workspaceId: input.workspaceId }, async (tx) => {
      const sources = await websiteFixSourcesOf(tx, input.workspaceId, input.fixes, input.formId);
      const facts = websiteFixFactsFrom(sources, {
        app: deps.webUrl,
        pages: await publicOrigin(tx, input.workspaceId, deps.webUrl),
      });
      refuseUnwritable(facts, input.fixes);
      return {
        business: facts.business,
        website: facts.website,
        files: websiteFixFiles(facts, input.fixes),
      };
    });
  });
}
