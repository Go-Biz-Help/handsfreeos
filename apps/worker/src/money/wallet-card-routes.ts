/**
 * `POST /v1/wallet/card` (bearer token, `money.manage`): putting a card on the business's **own** balance.
 *
 * It is the plan card's two phases (`http/money.ts`), for the same reason — a card belongs on the provider's
 * page and nowhere else — with one difference that is the whole point of this file: every provider call here
 * is made as **HandsFreeOS**, not as the business. `provider.platform.*` passes no seller account, which is
 * what makes the card ours to charge for usage rather than theirs to charge their customers with.
 *
 * - **No `sessionRef`**: the provider's customer for this business is made or found, a card page is started on
 *   it, and the page's address comes back for the browser to go to. The wallet is marked as waiting for a card
 *   in the same breath, so both Settings → Usage & balance and the phone's Balance say so while they are away.
 * - **With a `sessionRef`**: the session is read **back from the provider** — never trusted from the address
 *   bar — and what it ended with is attached to the customer and written down by `wallet.record_card`.
 *
 * Where they come back to is built here, from the workspace's own settings page, rather than taken from the
 * request: a return address a caller could set is an open redirect with a card attached to it. The phone
 * claims that same address (`links/route-map.ts`), so one return serves the web and the app.
 *
 * This lives on the worker because the platform's own provider key does: the API is refused it by its env
 * guard, which is what keeps a browser-facing service from ever being able to charge our customers.
 */
import { executeCommand, HfosError, walletRecordCard, walletRequestCard } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, parseBody, requirePermission, type HttpDeps } from '../http/common';
import {
  PaymentAuthError,
  PaymentError,
  PlatformUnsupportedError,
  type PaymentProviderName,
} from '../payments/provider';
import { systemActor } from '../services';

export const WalletCardInput = z.object({
  workspaceId: z.uuid(),
  /**
   * The card page they came back from. Absent, this asks for one; `cancelled` is the provider saying nobody
   * typed anything, which is an answer rather than a failure.
   */
  sessionRef: z.string().trim().min(1).max(200).optional(),
});

/** What a wallet needs before a card can go on it, read in the business's own scope. */
type WalletCardRow = {
  customer_ref: string | null;
  workspace_name: string;
  organization_id: string;
};

const meta = () => ({ correlationId: randomUUID(), causationId: null, channel: 'web' as const });

/**
 * The provider HandsFreeOS bills through. Only one can: Square's API acts as a seller with that seller's own
 * token, so there is no way to charge a business through it on our behalf (`PlatformPayments`).
 */
const PLATFORM_PROVIDER: PaymentProviderName = 'stripe';

/**
 * What a person is told when the provider will not do it, and what is written down for us.
 *
 * None of these errors is an `HfosError`, so left alone every one of them reached the worker's last-resort
 * handler and came back as "Something went wrong on our side" — for a refusal Stripe had explained in words.
 * That is how `setup_intent_data[usage]` stayed hidden: Stripe said `parameter_unknown` on every press, and
 * the page said nothing anybody could act on. Now the page says what is true, and the log says what Stripe said.
 *
 * A refusal of our own request, or of our own key, is ours to fix and nobody's to retry, so it is logged as an
 * error. A provider that did not answer is worth another try, and is only a warning.
 */
export function refused(deps: Pick<HttpDeps, 'log'>, e: unknown, workspaceId: string): unknown {
  if (e instanceof PlatformUnsupportedError)
    // Already written for the person reading it.
    return HfosError.rule('wallet_card_unsupported', 409, e.message);
  if (e instanceof PaymentAuthError || (e instanceof PaymentError && e.permanent)) {
    deps.log.error(
      {
        workspaceId,
        provider: PLATFORM_PROVIDER,
        code: e.code,
        status: e instanceof PaymentError ? e.status : null,
        err: e.message,
      },
      'a card could not be put on a balance: the provider refused our own request',
    );
    return HfosError.rule(
      'wallet_card_unavailable',
      502,
      'Adding a card isn’t working on our side right now, so no card was added and nothing was charged. Try again later.',
    );
  }
  if (e instanceof PaymentError) {
    deps.log.warn(
      { workspaceId, provider: PLATFORM_PROVIDER, code: e.code, status: e.status, err: e.message },
      'a card could not be put on a balance: the provider did not answer',
    );
    return HfosError.rule(
      'wallet_card_retry',
      502,
      'The card company didn’t answer just now. Nothing was charged — try again in a minute.',
    );
  }
  return e;
}

export function registerWalletCardRoutes(app: FastifyInstance, deps: HttpDeps): void {
  app.post('/v1/wallet/card', async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    const actor = await authenticate(deps, req);
    const input = parseBody(WalletCardInput, req.body);
    const { workspaceId } = input;
    await requirePermission(deps, actor.userId, workspaceId, 'money.manage');

    try {
      const provider = deps.payments.providers[PLATFORM_PROVIDER];
      if (!provider?.platform.supported) throw new PlatformUnsupportedError(PLATFORM_PROVIDER);

      // A business that has never spent anything has no wallet row yet, and a card is usually the first thing
      // anybody does to one. `wallet.request_card` opens it below, through `private.open_usage_wallet`, so
      // this read is a left join: no wallet here means no customer at the provider either.
      const [row] = await asWorker(deps.httpDb, { workspaceId }, (tx) =>
        rows<WalletCardRow>(
          tx,
          sql`select w.customer_ref, ws.name as workspace_name, ws.organization_id
              from app.workspaces ws
              left join app.usage_wallets w on w.workspace_id = ws.id
              where ws.id = ${workspaceId}::uuid`,
        ),
      );
      if (!row)
        throw HfosError.notFound(
          'That business isn’t there anymore. Refresh the page and try again.',
        );

      // The provider's customer for this business: made once, found every time after, so a second card lands
      // beside the first rather than on a stranger.
      const customer = await provider.platform.ensureCustomer({
        customerRef: row.customer_ref,
        name: row.workspace_name,
        email: actor.email,
        phone: null,
        idempotencyKey: `wallet-customer:${workspaceId}`,
      });

      // ---- asking for a page ----
      if (!input.sessionRef) {
        const session = await provider.platform.startCardSession({
          customerRef: customer.customerRef,
          returnUrl: `${deps.webUrl}/app/w/${workspaceId}/settings/usage`,
          // One press, one session: a second press within the same second is the same page, not two.
          idempotencyKey: `wallet-card:${workspaceId}:${Math.floor(Date.now() / 1000)}`,
        });
        // They are away typing it. Both pages say so until it lands or they give up.
        await executeCommand(deps.httpDb, walletRequestCard, { workspaceId }, actor, meta());
        return { stage: 'started' as const, hostedUrl: session.hostedUrl };
      }

      // ---- coming back from one ----
      if (input.sessionRef === 'cancelled') return { stage: 'cancelled' as const };

      const ended = await provider.platform.readCardSession(input.sessionRef);
      if (!ended.sourceToken) return { stage: 'cancelled' as const };

      const saved = await provider.platform.saveMethod({
        customerRef: ended.customerRef ?? customer.customerRef,
        sourceToken: ended.sourceToken,
        idempotencyKey: `wallet-card-save:${workspaceId}:${input.sessionRef}`.slice(0, 64),
      });
      const card = await executeCommand(
        deps.httpDb,
        walletRecordCard,
        {
          workspaceId,
          provider: PLATFORM_PROVIDER,
          customerRef: ended.customerRef ?? customer.customerRef,
          methodToken: saved.token,
          cardBrand: saved.brand,
          cardLast4: saved.last4,
          cardExpiryMonth: saved.expiryMonth,
          cardExpiryYear: saved.expiryYear,
        },
        systemActor({ workspaceId, organizationId: row.organization_id }),
        meta(),
      );
      return { stage: 'saved' as const, card: card.output };
    } catch (e) {
      throw refused(deps, e, workspaceId);
    }
  });
}
