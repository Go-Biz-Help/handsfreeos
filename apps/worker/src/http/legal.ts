/**
 * The privacy policy and terms HandsFreeOS hosts for a business (M17).
 *
 * **These pages exist because a carrier opens them.** A 10DLC reviewer follows the website link on a
 * registration and looks for a privacy policy that mentions texting and says phone numbers are not shared.
 * The businesses here mostly have a one-page site with nothing of the sort, so the registration wizard
 * offers to host one, and this is what serves it.
 *
 * Signed out, like the booking page and public forms, and resolved by the same booking-site slug — a
 * business's public identity is its site, and giving policies a second kind of address would mean a second
 * thing to explain. A business that already has its own policy sets `policyUrl` on the registration
 * instead, and never links here.
 *
 * **Everything on the page comes from the registration.** The legal name, the address and how customers reach
 * the business are read from it (core's `legalSourceOf`: the answers being got ready in the wizard, or else what
 * went to the carriers) rather than from anywhere more convenient, because a policy that disagrees with the
 * registration beside it is worse than no policy.
 */
import rateLimit from '@fastify/rate-limit';
import { privacyPolicy, termsOfService, type PolicyBusiness } from '@hfos/core';
import { legalSourceOf } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import type { HttpDeps } from './common';

const SLUG_RE = /^[A-Za-z0-9-]{1,80}$/;

type RouteRow = { workspace_id: string; organization_id: string; site_name: string | null };

export async function registerLegalRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  await app.register(async (pub) => {
    await pub.register(rateLimit, { global: false });
    pub.get<{ Params: { site: string; kind: string } }>(
      '/public/legal/:site/:kind',
      { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
      async (req, reply) => {
        const { site, kind } = req.params;
        if (!SLUG_RE.test(site) || (kind !== 'privacy' && kind !== 'terms'))
          return reply.code(404).send({ error: 'not_found' });

        // As the system actor, like the booking page: the worker's own sign-in can't see schema private.
        const [route] = await asWorker(deps.httpDb, {}, (tx) =>
          rows<RouteRow>(tx, sql`select * from private.booking_route(${site}::text, null::text)`),
        );
        if (!route) return reply.code(404).send({ error: 'not_found' });

        const page = await asWorker(
          deps.httpDb,
          { workspaceId: route.workspace_id, organizationId: route.organization_id },
          async (tx) => {
            const [workspace] = await rows<{ name: string }>(
              tx,
              sql`select name from app.workspaces where id = ${route.workspace_id}`,
            );
            const source = await legalSourceOf(tx, route.workspace_id);
            // A business using its own policy still links here, so this is where the two are reconciled:
            // the agreement box has one address, and it lands on whichever document is really theirs. Each
            // page goes to its own kind: their privacy policy never stands in for terms, or the other way.
            const own = kind === 'privacy' ? source.policyUrl : source.termsUrl;
            if (own) return { redirectTo: own };
            const business: PolicyBusiness = {
              name: route.site_name ?? workspace?.name ?? 'This business',
              ...source.business,
            };
            return {
              policy: kind === 'privacy' ? privacyPolicy(business) : termsOfService(business),
            };
          },
        );

        // A reviewer may load this more than once. It changes as the registration's answers are got ready, so
        // only briefly: a business checking its page just after filling them in sees them.
        void reply.header('cache-control', 'public, max-age=60, s-maxage=60');
        return reply.send(page);
      },
    );
  });
}
