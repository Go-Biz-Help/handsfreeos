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
 * **Everything on the page comes from what went to the carrier.** The legal name, the address and the
 * contact email are read from the latest registration submission rather than from anywhere more
 * convenient, because a policy that disagrees with the registration beside it is worse than no policy.
 */
import rateLimit from '@fastify/rate-limit';
import {
  formatPhone,
  privacyPolicy,
  sendsOffers,
  termsOfService,
  type PolicyBusiness,
} from '@hfos/core';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import type { HttpDeps } from './common';

const SLUG_RE = /^[A-Za-z0-9-]{1,80}$/;

type RouteRow = { workspace_id: string; organization_id: string; site_name: string | null };

/** What the latest registration told the carriers about this business. */
type Submission = {
  legalName?: string;
  /** Set when the business pointed us at a policy of its own instead of the one we generate. */
  policyUrl?: string | null;
  /** The same for its terms. */
  termsUrl?: string | null;
  useCase?: string;
  /** The number the registration is for: the one customers text, and call for help. */
  forNumber?: string;
  website?: string;
  contact?: { email?: string };
  address?: { line1?: string; city?: string; state?: string; postalCode?: string };
};

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

        const [route] = await rows<RouteRow>(
          deps.db,
          sql`select * from private.booking_route(${site}::text, null::text)`,
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
            // The most recent thing we told a carrier, whatever step it was for.
            const [latest] = await rows<{ submission: Submission }>(
              tx,
              sql`select submission from app.telephony_registrations
                  where workspace_id = ${route.workspace_id} and submission is not null
                  order by submitted_at desc nulls last, created_at desc
                  limit 1`,
            );
            const s = latest?.submission ?? {};
            // A business using its own policy still links here, so this is where the two are reconciled:
            // the agreement box has one address, and it lands on whichever document is really theirs. Each
            // page goes to its own kind: their privacy policy never stands in for terms, or the other way.
            const own = kind === 'privacy' ? s.policyUrl?.trim() : s.termsUrl?.trim();
            if (own) return { redirectTo: own };
            const business: PolicyBusiness = {
              name: route.site_name ?? workspace?.name ?? 'This business',
              legalName: s.legalName,
              website: s.website,
              email: s.contact?.email,
              address: s.address,
              phone: s.forNumber ? formatPhone(s.forNumber) : undefined,
              offers: sendsOffers(s.useCase),
            };
            return {
              policy: kind === 'privacy' ? privacyPolicy(business) : termsOfService(business),
            };
          },
        );

        // A reviewer may load this more than once, and it changes only when a registration is sent again.
        void reply.header('cache-control', 'public, max-age=300, s-maxage=300');
        return reply.send(page);
      },
    );
  });
}
