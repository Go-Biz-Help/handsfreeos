/**
 * The affiliate program's doors on the worker (20261027014000, 20261027014400, 20261027014500).
 *
 * - **`POST /public/affiliates/click`**, signed out. The website calls it, from its own server, when somebody arrives
 *   on an affiliate's link (`handsfreeos.com/?ref=`) for the first time on that browser: today's count for that
 *   affiliate goes up by one. It answers the same whatever the code, so it says nothing about who is or isn't an
 *   affiliate; `private.affiliate_click` counts only an approved one's. A count is all it can change, and nobody is
 *   paid on clicks, so it carries no token. Rate-limited by address like every public route here, generously: the
 *   website calls it for all its visitors from a few addresses of its own.
 * - **`GET /public/affiliates/program`**, signed out: the share everyone earns and the most a code takes off, for the
 *   website's Affiliates page (20261027014500). The two numbers staff set, and nothing about any affiliate.
 * - **`POST /v1/affiliate/payouts`** (bearer token): an affiliate setting up their bank at Stripe from their page, on
 *   the worker because HandsFreeOS's own Stripe key is. `start` makes their Express account the first time and opens
 *   Stripe's form for it; `check`, on their way back, reads it from Stripe and keeps what it says; `stripe` opens
 *   their Stripe page. Only their own row, found by who's signed in; `start` waits for the terms that count now. Where Stripe sends them back is built here,
 *   never taken from the request: a return address a caller could set is an open redirect.
 */
import rateLimit from '@fastify/rate-limit';
import { affiliateTermsCurrent, affiliateTermsNeeded, HfosError } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { recordAffiliateAccount } from '../affiliates/payouts';
import { PaymentAuthError, PaymentError, PlatformUnsupportedError } from '../payments/provider';
import { authenticate, parseBody, type HttpDeps } from './common';

const ClickInput = z.strictObject({ code: z.string().trim().toLowerCase().min(1).max(64) });

export const AffiliatePayoutsBody = z.strictObject({
  action: z.enum(['start', 'check', 'stripe']),
});

/**
 * What they're told when Stripe won't do it, and what is written down for us: our own request or key refused is ours
 * to fix and logged as an error; a Stripe that didn't answer is worth another try.
 */
function refused(deps: Pick<HttpDeps, 'log'>, e: unknown, affiliateId: string): unknown {
  if (
    e instanceof PlatformUnsupportedError ||
    e instanceof PaymentAuthError ||
    (e instanceof PaymentError && e.permanent)
  ) {
    deps.log.error(
      { affiliateId, err: e instanceof Error ? e.message : String(e) },
      'an affiliate’s Stripe page could not be opened: Stripe refused our own request',
    );
    return HfosError.rule(
      'affiliate_payouts_unavailable',
      502,
      'Stripe isn’t working for payouts on our side right now, so nothing was changed. Try again later, or email support@handsfreeos.com.',
    );
  }
  if (e instanceof PaymentError) {
    deps.log.warn(
      { affiliateId, err: e.message },
      'an affiliate’s Stripe page: Stripe did not answer',
    );
    return HfosError.rule(
      'affiliate_payouts_retry',
      502,
      'Stripe didn’t answer just now. Nothing was changed. Try again in a minute.',
    );
  }
  return e;
}

export async function registerAffiliateRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  await app.register(async (pub) => {
    await pub.register(rateLimit, { global: false });

    pub.post<{ Body: unknown }>(
      '/public/affiliates/click',
      { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
      async (req) => {
        const { code } = parseBody(ClickInput, req.body ?? {});
        await asWorker(deps.httpDb, {}, (tx) =>
          rows(tx, sql`select private.affiliate_click(${code})`),
        );
        return { ok: true };
      },
    );

    pub.get(
      '/public/affiliates/program',
      { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
      async (_req, reply) => {
        const [s] = await asWorker(deps.httpDb, {}, (tx) =>
          rows<{ rate_bp: number; max_discount_bp: number }>(
            tx,
            sql`select rate_bp, max_discount_bp from platform.affiliate_settings where id`,
          ),
        );
        // The website caches it too: a share staff just changed shows within a few minutes.
        void reply.header('cache-control', 'public, max-age=60, s-maxage=60');
        return { rateBp: s?.rate_bp ?? null, maxDiscountBp: s?.max_discount_bp ?? null };
      },
    );
  });

  app.post('/v1/affiliate/payouts', async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    const actor = await authenticate(deps, req);
    const { action } = parseBody(AffiliatePayoutsBody, req.body ?? {});
    const [me] = await asWorker(deps.httpDb, {}, (tx) =>
      rows<{
        id: string;
        status: string;
        account_ref: string | null;
        livemode: boolean | null;
        details_submitted: boolean | null;
        terms_version: string | null;
        email: string | null;
      }>(
        tx,
        sql`select a.id, a.status, p.account_ref, p.livemode, p.details_submitted, a.terms_version,
              (select t.email from private.affiliate_to_tell(a.id) t) as email
            from platform.affiliates a
            left join platform.affiliate_payout_accounts p on p.affiliate_id = a.id
            where a.user_id = ${actor.userId}::uuid`,
      ),
    );
    // Only somebody approved, now or before, has anything to be paid.
    if (!me || me.status === 'applied' || me.status === 'turned_down')
      throw HfosError.rule(
        'affiliate_not_approved',
        409,
        'Payouts are for approved affiliates. Your affiliate page says where your application stands.',
      );

    try {
      const platform = deps.payments.providers.stripe?.platform;
      if (!platform?.supported) throw new PlatformUnsupportedError('stripe');

      // An account made with a key of the other mode is no account to this one: going live makes them a new one.
      const kept = me.account_ref && me.livemode === platform.livemode ? me.account_ref : null;
      if (action === 'stripe') {
        if (!kept || !me.details_submitted)
          throw HfosError.rule(
            'affiliate_payouts_not_set_up',
            409,
            'Set up payouts first. Your Stripe page opens once you have.',
          );
        return { url: (await platform.payouts.loginLink(kept)).url };
      }
      if (action === 'check' && !kept) return { ready: false };
      // Setting up payouts waits for the terms that count now (20261027014500).
      if (
        action === 'start' &&
        me.status === 'approved' &&
        !affiliateTermsCurrent(me.terms_version)
      )
        throw affiliateTermsNeeded();

      let accountRef = kept;
      if (!accountRef) {
        const made = await platform.payouts.create({
          email: me.email ?? actor.email,
          metadata: { affiliate_id: me.id },
          // Two presses at once make one account.
          idempotencyKey: `affiliate-payout-account:${me.id}`,
        });
        await recordAffiliateAccount(deps.httpDb, me.id, made);
        accountRef = made.accountRef;
      }

      if (action === 'check')
        return {
          ready: await recordAffiliateAccount(
            deps.httpDb,
            me.id,
            await platform.payouts.read(accountRef),
          ),
        };

      const page = `${deps.webUrl.replace(/\/+$/, '')}/affiliate`;
      return await platform.payouts.onboardingLink({
        accountRef,
        refreshUrl: `${page}?payouts=again`,
        returnUrl: `${page}?payouts=back`,
      });
    } catch (e) {
      throw refused(deps, e, me.id);
    }
  });
}
