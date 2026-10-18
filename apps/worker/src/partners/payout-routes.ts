/**
 * Paying partners (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 3): the two places Stripe's own pages are
 * opened from. Both live on the worker, because the platform's own Stripe key does.
 *
 * - **`POST /v1/partners/payout-card`** (bearer token, `money.manage`): the card a business pays its partners with,
 *   on HandsFreeOS's own Stripe account. It's the usage wallet's card flow (`money/wallet-card-routes.ts`): no
 *   `sessionRef` starts Stripe's page; coming back with one reads the session back from Stripe, never from the
 *   address bar, and keeps the card (`partner.payout_record_card`). A card of its own, beside the wallet's, on the
 *   same Stripe customer: what it agreed to be charged for is partner payouts.
 * - **`partnerPayoutsAction`**, behind `POST /public/portal/:token/partner/payouts` (http/portal.ts): a partner
 *   setting up their bank. `start` makes their Express account the first time and opens Stripe's form for it;
 *   `check`, on their way back, reads it from Stripe and keeps what it says; `stripe` opens their Stripe page.
 *
 * Where Stripe sends them back is built here, from the business's own settings page or the partner's own portal
 * link, never taken from the request: a return address a caller could set is an open redirect.
 */
import { executeCommand, HfosError, partnerPayoutRecordCard } from '@hfos/core/server';
import { asCustomer, asWorker, rows, sql } from '@hfos/db/client';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, parseBody, requirePermission, type HttpDeps } from '../http/common';
import { publicOrigin } from '../hosting/origin';
import { PaymentAuthError, PaymentError, PlatformUnsupportedError } from '../payments/provider';
import { systemActor, type TenantScope } from '../services';
import { recordPayoutAccount } from './payouts';

export const PayoutCardInput = z.object({
  workspaceId: z.uuid(),
  /** The card page they came back from. Absent, this asks for one; `cancelled` is nobody typing anything. */
  sessionRef: z.string().trim().min(1).max(200).optional(),
});

export const PartnerPayoutsBody = z.object({ action: z.enum(['start', 'check', 'stripe']) });

const meta = () => ({ correlationId: randomUUID(), causationId: null, channel: 'web' as const });

/**
 * What a person is told when Stripe won't do it, and what is written down for us: our own request or key refused
 * is ours to fix and logged as an error; a Stripe that didn't answer is worth another try.
 */
function refused(deps: Pick<HttpDeps, 'log'>, e: unknown, where: Record<string, unknown>): unknown {
  if (e instanceof PlatformUnsupportedError)
    return HfosError.rule('partner_payouts_unavailable', 409, e.message);
  if (e instanceof PaymentAuthError || (e instanceof PaymentError && e.permanent)) {
    deps.log.error(
      { ...where, code: e.code, err: e.message },
      'a partner payout page could not be opened: Stripe refused our own request',
    );
    return HfosError.rule(
      'partner_payouts_unavailable',
      502,
      'Stripe isn’t working for partner payouts on our side right now, so nothing was changed and nothing was charged. Try again later.',
    );
  }
  if (e instanceof PaymentError) {
    deps.log.warn(
      { ...where, code: e.code, status: e.status, err: e.message },
      'a partner payout page could not be opened: Stripe did not answer',
    );
    return HfosError.rule(
      'partner_payouts_retry',
      502,
      'Stripe didn’t answer just now. Nothing was changed. Try again in a minute.',
    );
  }
  return e;
}

export function registerPartnerPayoutRoutes(app: FastifyInstance, deps: HttpDeps): void {
  app.post('/v1/partners/payout-card', async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    const actor = await authenticate(deps, req);
    const input = parseBody(PayoutCardInput, req.body);
    const { workspaceId } = input;
    await requirePermission(deps, actor.userId, workspaceId, 'money.manage');

    try {
      const platform = deps.payments.providers.stripe?.platform;
      if (!platform?.supported) throw new PlatformUnsupportedError('stripe');
      const [row] = await asWorker(deps.httpDb, { workspaceId }, (tx) =>
        rows<{
          opened: boolean;
          customer_ref: string | null;
          wallet_customer: string | null;
          workspace_name: string;
          organization_id: string;
        }>(
          tx,
          sql`select coalesce(b.opened_at is not null, false) as opened, b.customer_ref,
                w.customer_ref as wallet_customer, ws.name as workspace_name, ws.organization_id
              from app.workspaces ws
              left join app.partner_payout_billing b on b.workspace_id = ws.id
              left join app.usage_wallets w on w.workspace_id = ws.id
              where ws.id = ${workspaceId}::uuid`,
        ),
      );
      if (!row)
        throw HfosError.notFound(
          'That business isn’t there anymore. Refresh the page and try again.',
        );
      if (!row.opened)
        throw HfosError.rule(
          'partner_payouts_not_open',
          409,
          'HandsFreeOS doesn’t pay your partners for you yet, so there’s no card to add. Until it does, pay them yourself from what Settings → Partners shows they’re owed.',
        );

      // The business's customer at Stripe, the usage wallet's when it has one: a second card lands beside the
      // first rather than on a stranger.
      const customer = await platform.ensureCustomer({
        customerRef: row.customer_ref ?? row.wallet_customer,
        name: row.workspace_name,
        email: actor.email,
        phone: null,
        idempotencyKey: `wallet-customer:${workspaceId}`,
      });

      if (!input.sessionRef) {
        const session = await platform.startCardSession({
          customerRef: customer.customerRef,
          returnUrl: `${deps.webUrl}/app/w/${workspaceId}/settings/partners`,
          // One press, one session: a second press within the same second is the same page.
          idempotencyKey: `partner-payout-card:${workspaceId}:${Math.floor(Date.now() / 1000)}`,
        });
        return { stage: 'started' as const, hostedUrl: session.hostedUrl };
      }
      if (input.sessionRef === 'cancelled') return { stage: 'cancelled' as const };

      const ended = await platform.readCardSession(input.sessionRef);
      if (!ended.sourceToken) return { stage: 'cancelled' as const };
      const customerRef = ended.customerRef ?? customer.customerRef;
      const saved = await platform.saveMethod({
        customerRef,
        sourceToken: ended.sourceToken,
        idempotencyKey: `partner-card-save:${workspaceId}:${input.sessionRef}`.slice(0, 64),
      });
      const card = await executeCommand(
        deps.httpDb,
        partnerPayoutRecordCard,
        {
          workspaceId,
          provider: 'stripe',
          customerRef,
          methodToken: saved.token,
          cardBrand: saved.brand,
          cardLast4: saved.last4,
          cardExpiryMonth: saved.expiryMonth,
          cardExpiryYear: saved.expiryYear,
        },
        systemActor({ workspaceId, organizationId: row.organization_id }),
        meta(),
      );
      return { stage: 'saved' as const, card: card.output.card };
    } catch (e) {
      throw refused(deps, e, { workspaceId });
    }
  });
}

/** A signed-in partner's own device, on their own portal link. */
export interface PartnerSession {
  readonly sessionId: string;
  readonly scope: TenantScope;
}

/** A partner setting up their bank at Stripe from their page, or opening their Stripe page once they have. */
export async function partnerPayoutsAction(
  deps: HttpDeps,
  session: PartnerSession,
  token: string,
  action: z.output<typeof PartnerPayoutsBody>['action'],
): Promise<{ url: string } | { ready: boolean }> {
  const { scope } = session;
  // Their own partner record, and whether the business pays partners here yet, as their portal reads them.
  const [me] = await asCustomer(deps.httpDb, session.sessionId, (tx) =>
    rows<{ id: string; open: boolean }>(
      tx,
      sql`select p.id, portal.partner_payouts_open() as open from portal.partner() p`,
    ),
  );
  if (!me)
    throw HfosError.notFound(
      'This is for partners of the business. Ask them if you think it should be for you.',
    );
  const [row] = await asWorker(deps.httpDb, scope, (tx) =>
    rows<{
      account_ref: string | null;
      details_submitted: boolean | null;
      email: string | null;
      business: string;
    }>(
      tx,
      sql`select a.account_ref, a.details_submitted, pp.email::text as email, w.name as business
          from app.partners pa
          join app.people pp on pp.id = pa.person_id
          join app.workspaces w on w.id = pa.workspace_id
          left join app.partner_payout_accounts a on a.partner_id = pa.id
          where pa.workspace_id = ${scope.workspaceId} and pa.id = ${me.id}::uuid`,
    ),
  );
  if (!row) throw HfosError.notFound('Your partner page isn’t there anymore. Refresh the page.');
  if (!me.open)
    throw HfosError.rule(
      'partner_payouts_not_open',
      409,
      `${row.business} doesn’t pay its partners through HandsFreeOS yet. Ask them how they’ll pay you.`,
    );

  try {
    const platform = deps.payments.providers.stripe?.platform;
    if (!platform?.supported) throw new PlatformUnsupportedError('stripe');

    if (action === 'stripe') {
      if (!row.account_ref || !row.details_submitted)
        throw HfosError.rule(
          'partner_payouts_not_set_up',
          409,
          'Set up payouts first. Your Stripe page opens once you have.',
        );
      return { url: (await platform.payouts.loginLink(row.account_ref)).url };
    }

    let accountRef = row.account_ref;
    if (!accountRef) {
      const made = await platform.payouts.create({
        email: row.email,
        metadata: { workspace_id: scope.workspaceId, partner_id: me.id },
        // Two presses at once make one account.
        idempotencyKey: `partner-payout-account:${me.id}`,
      });
      await recordPayoutAccount(deps.httpDb, scope, me.id, made);
      accountRef = made.accountRef;
    }

    if (action === 'check') {
      const state = await platform.payouts.read(accountRef);
      return { ready: (await recordPayoutAccount(deps.httpDb, scope, me.id, state)).ready };
    }

    // Back to their own page, on the business's own address when one is serving.
    const origin = await asWorker(deps.httpDb, scope, (tx) =>
      publicOrigin(tx, scope.workspaceId, deps.portalLinks.webUrl),
    );
    const page = `${origin.replace(/\/+$/, '')}/c/${encodeURIComponent(token)}/partner`;
    return await platform.payouts.onboardingLink({
      accountRef,
      refreshUrl: `${page}?payouts=again`,
      returnUrl: `${page}?payouts=back`,
    });
  } catch (e) {
    throw refused(deps, e, { workspaceId: scope.workspaceId, partnerId: me.id });
  }
}
