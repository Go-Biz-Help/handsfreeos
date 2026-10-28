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
 *
 * `POST /webhooks/stripe/platform` (0093) is Stripe telling us a founding seat — or, since 0104, an RCS request,
 * and since 0105 a texting fee — was paid for. It is our own
 * account's destination — "Your account" in Stripe, not the Connect one at `/webhooks/stripe` — signed with its
 * own secret, and it does what every provider webhook here does: checks the signature over the exact bytes,
 * stores the event once under its own id, and answers. The worker's processor does the rest
 * (founding/checkout.ts). A refund of a plan payment (20261027014200) comes through the same door, routed to the
 * business by the payment it gives back; a refund of anything else here is taken, and dropped.
 */
import rateLimit from '@fastify/rate-limit';
import { FoundingApplyInput } from '@hfos/core';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import { checkoutOutcome, FOUNDING_CHECKOUT_KIND, PLAN_REFUND_KIND } from '../founding/checkout';
import { RCS_CHECKOUT_KIND, rcsCheckoutOutcome } from '../telephony/rcs-billing';
import { TEXTING_FEE_CHECKOUT_KIND, textingFeeCheckoutOutcome } from '../telephony/texting-fees';
import { WEBHOOK_MAX_BYTES } from '../money/webhook-events';
import { header, parseBody, recordDelivery, type HttpDeps } from './common';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
        const { company_website_url: honeypot, ...body } = (req.body ?? {}) as Record<
          string,
          unknown
        >;
        // The honeypot: a field no person sees and a crawler cannot resist. Answered 200, and dropped.
        if (typeof honeypot === 'string' && honeypot !== '')
          return reply.code(200).send({ ok: true });

        // Left empty it is still sent (the website's form posts every field), so it comes off before the strict
        // schema reads the rest — otherwise every real application was refused as an unknown field.
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
         * has not done anything wrong and should not be told they have — and nobody typing someone else's
         * email in is told that they applied, or how their application stands.
         */
        return { received: true, offerId: input.offerId };
      },
    );
  });

  // ---------- Stripe, about our own account ----------
  await app.register(async (hooks) => {
    // The raw body is what is signed: JSON stays the exact string that arrived.
    hooks.removeContentTypeParser(['application/json']);
    hooks.addContentTypeParser(
      'application/json',
      { parseAs: 'string', bodyLimit: WEBHOOK_MAX_BYTES },
      (_req, body, done) => done(null, body),
    );

    hooks.post(
      '/webhooks/stripe/platform',
      { bodyLimit: WEBHOOK_MAX_BYTES },
      async (req, reply) => {
        const platform = deps.payments.providers.stripe.platform;
        const rawBody = typeof req.body === 'string' ? req.body : '';
        const url = `${deps.publicUrl}${req.url}`;
        const headers = { 'stripe-signature': header(req, 'stripe-signature') };
        if (!platform.webhooks.configured || !platform.webhooks.verify({ rawBody, headers, url })) {
          deps.log.warn('rejected an unsigned or mis-signed Stripe webhook for our own account');
          return reply.code(403).type('text/plain').send('Invalid signature');
        }
        // A plan payment's refund: routed to the business that paid it. Any other refund isn't ours to keep.
        const refund = platform.webhooks.refund(rawBody);
        if (refund) {
          const [paid] = await asWorker(deps.httpDb, {}, (tx) =>
            rows<{ workspace_id: string; organization_id: string }>(
              tx,
              sql`select workspace_id, organization_id from platform.plan_payments
                where payment_ref = ${refund.paymentRef}
                  and workspace_id is not null and organization_id is not null`,
            ),
          );
          if (!paid) return reply.code(200).send({ received: true, ignored: true });
          await recordDelivery(deps, {
            provider: 'stripe',
            kind: PLAN_REFUND_KIND,
            dedupeKey: refund.id,
            accountRef: null,
            url,
            params: {
              id: refund.id,
              type: refund.type,
              accountRef: '',
              createdAt: '',
              body: rawBody,
            },
            workspaceId: paid.workspace_id,
            organizationId: paid.organization_id,
          });
          return reply.code(200).send({ received: true });
        }
        const event = platform.webhooks.checkout(rawBody);
        // A texting fee's page (0105): the same door, routed to the business the fee is for.
        if (event?.textingFeeId) {
          if (!UUID.test(event.textingFeeId) || !textingFeeCheckoutOutcome(event))
            return reply.code(200).send({ received: true, ignored: true });
          const [to] = await asWorker(deps.httpDb, {}, (tx) =>
            rows<{ workspace_id: string; organization_id: string }>(
              tx,
              sql`select workspace_id, organization_id
                from private.texting_fee_route(${event.textingFeeId}::uuid)`,
            ),
          );
          if (!to) {
            deps.log.info(
              { type: event.type, textingFeeId: event.textingFeeId },
              'a Stripe checkout event for a texting fee nobody here has',
            );
            return reply.code(200).send({ received: true, ignored: true });
          }
          await recordDelivery(deps, {
            provider: 'stripe',
            kind: TEXTING_FEE_CHECKOUT_KIND,
            dedupeKey: event.id,
            accountRef: null,
            url,
            params: {
              id: event.id,
              type: event.type,
              accountRef: '',
              createdAt: '',
              body: rawBody,
            },
            workspaceId: to.workspace_id,
            organizationId: to.organization_id,
          });
          return reply.code(200).send({ received: true });
        }
        // An RCS request's page (0104): the same door, routed to the business the request is for.
        if (event?.rcsRequestId) {
          if (!UUID.test(event.rcsRequestId) || !rcsCheckoutOutcome(event))
            return reply.code(200).send({ received: true, ignored: true });
          const [to] = await asWorker(deps.httpDb, {}, (tx) =>
            rows<{ workspace_id: string; organization_id: string }>(
              tx,
              sql`select workspace_id, organization_id
                from private.rcs_request_route(${event.rcsRequestId}::uuid)`,
            ),
          );
          if (!to) {
            deps.log.info(
              { type: event.type, rcsRequestId: event.rcsRequestId },
              'a Stripe checkout event for an RCS request nobody here has',
            );
            return reply.code(200).send({ received: true, ignored: true });
          }
          await recordDelivery(deps, {
            provider: 'stripe',
            kind: RCS_CHECKOUT_KIND,
            dedupeKey: event.id,
            accountRef: null,
            url,
            params: {
              id: event.id,
              type: event.type,
              accountRef: '',
              createdAt: '',
              body: rawBody,
            },
            workspaceId: to.workspace_id,
            organizationId: to.organization_id,
          });
          return reply.code(200).send({ received: true });
        }
        // Anything else in our account — or a page some other part of it made — is taken, and dropped.
        if (!event?.checkoutId || !UUID.test(event.checkoutId) || !checkoutOutcome(event))
          return reply.code(200).send({ received: true, ignored: true });

        const [route] = await asWorker(deps.httpDb, {}, (tx) =>
          rows<{ workspace_id: string; organization_id: string }>(
            tx,
            sql`select workspace_id, organization_id
              from private.founding_checkout_route(${event.checkoutId}::uuid)`,
          ),
        );
        if (!route) {
          deps.log.info(
            { type: event.type, checkoutId: event.checkoutId },
            'a Stripe checkout event for a checkout nobody here has',
          );
          return reply.code(200).send({ received: true, ignored: true });
        }
        await recordDelivery(deps, {
          provider: 'stripe',
          kind: FOUNDING_CHECKOUT_KIND,
          // Stripe's own event id: a replay is stored once and handled once.
          dedupeKey: event.id,
          accountRef: null,
          url,
          params: { id: event.id, type: event.type, accountRef: '', createdAt: '', body: rawBody },
          workspaceId: route.workspace_id,
          organizationId: route.organization_id,
        });
        return reply.code(200).send({ received: true });
      },
    );
  });
}
