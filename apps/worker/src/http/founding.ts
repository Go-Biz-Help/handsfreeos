/**
 * The founding offers' two signed-out doors (0091).
 *
 * `GET /public/founding/counts` is what the marketing site prints. It reads `platform.founding_counts` — the
 * same view the app's own upgrade screens read through `founding.counts` — so the number a prospect is shown
 * and the number the database will enforce are the same number, always. It carries the figures for each offer
 * and which stage the sequence is in (0092) — nothing else: no applicant, no business, no email. There is no
 * token on it because there is nothing on it worth a token.
 *
 * `POST /public/founding/apply` is the form. It goes to `private.founding_apply` rather than to a core
 * command, because the person filling it in has no workspace, no organization and usually no account, and
 * the kernel's machine actor is defined by the tenant it may address. There is nothing honest to hand it.
 * The function also decides queue-or-waitlist in the same statement as the insert, which closes the gap
 * where the last seat goes between a count and a write.
 *
 * Both are rate-limited per address, like every other public route here. The apply route carries a honeypot,
 * the same one the intake form uses: a field a person never sees and a crawler fills in.
 *
 * Both read as `service_actor`, through `asWorker`, like every other route here. The worker's own login has no
 * rights of its own on purpose, and these first shipped using it directly: both answered 500 from the moment
 * they were deployed, until test/founding-routes.test.ts drove them as the worker really connects.
 */
import rateLimit from '@fastify/rate-limit';
import { FoundingApplyInput } from '@hfos/core';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import { parseBody, type HttpDeps } from './common';

type CountRow = {
  id: string;
  name: string;
  blurb: string;
  status: string;
  price_cents: number;
  seat_cap: number;
  claimed: number | string;
  remaining: number | string;
  billing: string;
  show_counter: boolean;
  superseded: boolean;
};

type ApplyRow = { application_id: string; status: string; created: boolean };

export async function registerFoundingRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  await app.register(async (pub) => {
    await pub.register(rateLimit, { global: false });

    pub.get(
      '/public/founding/counts',
      { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
      async (_req, reply) => {
        const offers = await asWorker(deps.httpDb, {}, (tx) =>
          rows<CountRow>(
            tx,
            sql`select id, name, blurb, status::text as status, price_cents, seat_cap, claimed,
                  remaining, billing, show_counter, superseded
                from platform.founding_counts order by sort, id`,
          ),
        );
        /**
         * Thirty seconds at the edge. The site caches it too; between them a launch-day rush costs a couple
         * of queries a minute. A number that is half a minute stale is not a problem — the seat is taken
         * under a lock whatever the page said, so the worst case is somebody being told there was room and
         * finding out at approval that there was not, which is the admin's problem and not the applicant's.
         */
        void reply.header('cache-control', 'public, max-age=30, s-maxage=30');
        return {
          offers: offers.map((o) => ({
            offerId: o.id,
            name: o.name,
            blurb: o.blurb,
            status: o.status,
            priceCents: o.price_cents,
            seatCap: o.seat_cap,
            claimed: Number(o.claimed),
            remaining: Number(o.remaining),
            // Which stage the site is in is read from these three, so it never has to know the chain's rules.
            billing: o.billing,
            showCounter: o.show_counter,
            superseded: o.superseded,
          })),
          generatedAt: new Date().toISOString(),
        };
      },
    );

    pub.post<{ Body: unknown }>(
      '/public/founding/apply',
      { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
      async (req, reply) => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        // The honeypot: a field no person sees and a crawler cannot resist. Answered 200, and dropped.
        if (typeof body['company_website_url'] === 'string' && body['company_website_url'] !== '')
          return reply.code(200).send({ ok: true });

        const input = parseBody(FoundingApplyInput, body);
        const [row] = await asWorker(deps.httpDb, {}, (tx) =>
          rows<ApplyRow>(
            tx,
            sql`select * from private.founding_apply(
                  ${input.offerId}, ${input.businessName}, ${input.contactName}, ${input.email},
                  ${input.phone ?? null}, ${input.website ?? null}, ${input.industry ?? null},
                  ${input.teamSize ?? null}, ${input.note}, ${input.source})`,
          ),
        );
        if (!row) return reply.code(404).send({ error: 'no_such_offer' });

        if (row.created)
          deps.log.info(
            { offer: input.offerId, status: row.status },
            'a founding application arrived',
          );
        /**
         * The same answer whether this was the first time or the fifth. Somebody who pressed the button twice
         * has not done anything wrong and should not be told they have.
         */
        return { applicationId: row.application_id, status: row.status, offerId: input.offerId };
      },
    );
  });
}
