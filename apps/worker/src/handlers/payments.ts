/**
 * What the worker does when a payment account is connected or disconnected.
 * - Connected: its token refresh starts (Square's lasts 30 days; Stripe's row asks for none).
 * - Disconnected by a person: the provider is told too, so our access really is gone rather than forgotten.
 *   **Not** when the reason is `replaced` — that is the same account signing in again, and revoking there would
 *   kill the token that was just issued — and not when the provider ended it itself.
 */
import { eq } from 'drizzle-orm';
import { paymentConnections } from '@hfos/db/schema';
import { schedulePaymentRefresh, tellProviderDisconnected } from '../payments/refresh';
import type { EventHandler } from './types';

export const onPaymentConnectionConnected: EventHandler = async (ctx) => {
  const { workspaceId, organizationId } = ctx.scope;
  if (!workspaceId || !organizationId) return;
  const [c] = await ctx.tx
    .select({
      id: paymentConnections.id,
      nextRefreshAt: paymentConnections.nextRefreshAt,
      status: paymentConnections.status,
    })
    .from(paymentConnections)
    .where(eq(paymentConnections.id, ctx.event.entityId ?? ''));
  // Stripe leaves nextRefreshAt null: there is nothing to renew, so nothing is scheduled.
  if (!c || c.status !== 'active' || !c.nextRefreshAt) return;
  await schedulePaymentRefresh(ctx.tx, { workspaceId, organizationId }, c.id, c.nextRefreshAt);
};

export const onPaymentConnectionDisconnected: EventHandler = async (ctx) => {
  const payload = ctx.event.payload as Record<string, unknown>;
  if (payload['reason'] === 'replaced') return;
  const [c] = await ctx.tx
    .select({
      id: paymentConnections.id,
      provider: paymentConnections.provider,
      externalAccountId: paymentConnections.externalAccountId,
    })
    .from(paymentConnections)
    .where(eq(paymentConnections.id, ctx.event.entityId ?? ''));
  if (!c?.externalAccountId) return;
  // A provider that refuses is logged inside; the account is disconnected here either way.
  await tellProviderDisconnected(ctx, c);
};
