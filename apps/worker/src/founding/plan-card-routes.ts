/**
 * `POST /v1/plan/card` (bearer token, `money.manage`): adding a card to the business's one list of cards, which pays
 * its HandsFreeOS plan and refills its usage balance, from Settings → Billing & Usage or the failed-payment page
 * (20261027023600).
 *
 * The wallet's card route, for the plan (`money/wallet-card-routes.ts`), and for the same reason: a card belongs on
 * Stripe's page and nowhere else, and every call here is made as **HandsFreeOS**, so the card is ours to charge for
 * the plan.
 *
 * - **No `sessionRef`**: a card page is started on the Stripe customer the default card is on (or the plan's customer,
 *   or the balance's, or a new one), and its address comes back for the browser to go to.
 * - **With a `sessionRef`**: the session is read **back from Stripe**, never trusted from the address bar, the card is
 *   attached and written down (`billing.record_card`). One opened by another business is refused. Asked to, the new
 *   card becomes the default, and a failed payment is tried again on it at once (`billing.pay_now`).
 *
 * Where they come back to is built here, from the two pages that add cards, never taken from the request: a return
 * address a caller could set is an open redirect with a card attached to it.
 */
import { billingPayNow, billingRecordCard, executeCommand, HfosError } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, parseBody, requirePermission, type HttpDeps } from '../http/common';
import { refused } from '../money/wallet-card-routes';
import { PlatformUnsupportedError } from '../payments/provider';
import { systemActor } from '../services';

export const PlanCardInput = z.object({
  workspaceId: z.uuid(),
  /** The card page they came back from; `cancelled` is Stripe saying nobody typed anything. */
  sessionRef: z.string().trim().min(1).max(200).optional(),
  /** Make the new card the default. */
  makeDefault: z.boolean().optional(),
  /** Try a failed payment again on it straight away. */
  payNow: z.boolean().optional(),
  /** Which page they come back to: Settings → Billing & Usage, or the failed-payment page. */
  from: z.enum(['usage', 'payment']).optional(),
});

const meta = () => ({ correlationId: randomUUID(), causationId: null, channel: 'web' as const });

/** The page a card is added from, and where Stripe sends them back to, with what they asked for kept on it. */
export function planCardReturnUrl(
  webUrl: string,
  workspaceId: string,
  input: { from?: 'usage' | 'payment'; makeDefault?: boolean; payNow?: boolean },
): string {
  const base =
    input.from === 'payment'
      ? `${webUrl}/payment/${workspaceId}`
      : `${webUrl}/app/w/${workspaceId}/settings/usage`;
  const q = new URLSearchParams();
  if (input.makeDefault) q.set('makeDefault', '1');
  if (input.payNow) q.set('payNow', '1');
  const query = q.toString();
  return query ? `${base}?${query}` : base;
}

export function registerPlanCardRoutes(app: FastifyInstance, deps: HttpDeps): void {
  app.post('/v1/plan/card', async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    const actor = await authenticate(deps, req);
    const input = parseBody(PlanCardInput, req.body);
    const { workspaceId } = input;
    await requirePermission(deps, actor.userId, workspaceId, 'money.manage');

    try {
      const platform = deps.payments.providers.stripe.platform;
      if (!platform.supported) throw new PlatformUnsupportedError('stripe');

      const [row] = await asWorker(deps.httpDb, { workspaceId }, (tx) =>
        rows<{
          workspace_name: string;
          organization_id: string;
          default_customer: string | null;
          plan_customer: string | null;
          wallet_customer: string | null;
        }>(
          tx,
          sql`select ws.name as workspace_name, ws.organization_id,
                (select c.customer_ref from app.plan_cards c where c.workspace_id = ws.id and c.is_default) as default_customer,
                (select p.stripe_customer_id from app.workspace_plans p where p.workspace_id = ws.id) as plan_customer,
                (select w.customer_ref from app.usage_wallets w
                  where w.workspace_id = ws.id and w.provider = 'stripe') as wallet_customer
              from app.workspaces ws where ws.id = ${workspaceId}::uuid`,
        ),
      );
      if (!row)
        throw HfosError.notFound(
          'That business isn’t there anymore. Refresh the page and try again.',
        );

      // The customer the cards are on, so a new card lands beside the others: made once, if there's none yet.
      const customer = await platform.ensureCustomer({
        customerRef: row.default_customer ?? row.plan_customer ?? row.wallet_customer,
        name: row.workspace_name,
        email: actor.email,
        phone: null,
        idempotencyKey: `plan-customer:${workspaceId}`,
      });

      // ---- asking for a page ----
      if (!input.sessionRef) {
        const session = await platform.startCardSession({
          customerRef: customer.customerRef,
          reference: workspaceId,
          returnUrl: planCardReturnUrl(deps.webUrl, workspaceId, input),
          // One press, one session: a second press within the same second is the same page, not two.
          idempotencyKey: `plan-card:${workspaceId}:${Math.floor(Date.now() / 1000)}`,
        });
        return { stage: 'started' as const, hostedUrl: session.hostedUrl };
      }

      // ---- coming back from one ----
      if (input.sessionRef === 'cancelled') return { stage: 'cancelled' as const };
      const ended = await platform.readCardSession(input.sessionRef);
      if (ended.reference !== workspaceId)
        throw HfosError.rule(
          'plan_card_other_business',
          409,
          'That card page wasn’t opened from this business, so no card was added. Press Add a card in Settings → Billing & Usage to start again.',
        );
      if (!ended.sourceToken) return { stage: 'cancelled' as const };

      const customerRef = ended.customerRef ?? customer.customerRef;
      const saved = await platform.saveMethod({
        customerRef,
        sourceToken: ended.sourceToken,
        idempotencyKey: `plan-card-save:${workspaceId}:${input.sessionRef}`.slice(0, 64),
      });
      const scope = { workspaceId, organizationId: row.organization_id };
      const card = await executeCommand(
        deps.httpDb,
        billingRecordCard,
        {
          workspaceId,
          customerRef,
          cardRef: saved.token,
          brand: saved.brand ? saved.brand.charAt(0).toUpperCase() + saved.brand.slice(1) : null,
          last4: saved.last4 && /^[0-9]{4}$/.test(saved.last4) ? saved.last4 : null,
          expiryMonth: saved.expiryMonth,
          expiryYear: saved.expiryYear,
          makeDefault: !!input.makeDefault,
          addedBy: actor.userId,
        },
        systemActor(scope),
        meta(),
      );
      let paying = false;
      if (input.payNow) {
        const tried = await executeCommand(
          deps.httpDb,
          billingPayNow,
          { workspaceId },
          actor,
          meta(),
        );
        paying = tried.output.outcome === 'trying';
      }
      return {
        stage: 'saved' as const,
        card: {
          id: card.output.cardId,
          isDefault: card.output.isDefault,
          brand: saved.brand,
          last4: saved.last4,
        },
        paying,
      };
    } catch (e) {
      throw refused(deps, e, workspaceId);
    }
  });
}
